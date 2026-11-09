import { ethers } from "ethers";
import {
  ALLOW_BOOL_FNS,
  ALLOW_MINT_FNS,
  ALLOW_START_FNS,
  ERC1155_ID,
  ERC721_ID,
  MAX_FNS,
  MINTED_FNS,
  PRICE_FNS,
  PUBLIC_MINT_FNS,
  PUBLIC_START_FNS,
  ZERO,
  dropIface,
  nftIface,
  phaseIface,
  seaDropIface,
  plainList,
  selectorOf,
} from "./abi.js";
import { fetchKalosEligibility } from "./kalos.js";
import { proofCovers, proofUrls } from "./schedule.js";
import { encodePlanMint } from "./pageAbi.js";
import { capQuantity, chooseFeeRecipient, genericRounds, seaDropAllowRound, seaDropPublicRound, thirdwebRound } from "./rounds.js";

export async function tryCall(provider, to, iface, name, args = []) {
  try {
    const data = iface.encodeFunctionData(name, args);
    const raw = await provider.call({ to, data });
    if (raw == null || raw === "0x") return null;
    const decoded = iface.decodeFunctionResult(name, raw);
    return decoded.length === 1 ? decoded[0] : decoded;
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return null;
  }
}

async function firstCall(provider, address, names, args = []) {
  for (const name of names) {
    const value = await tryCall(provider, address, nftIface, name, args);
    if (value != null) return { name, value };
  }
  return null;
}

function hasSelector(code, name) {
  return String(code || "").toLowerCase().includes(selectorOf(nftIface, name));
}

function isMinimalProxy(code) {
  return String(code || "").toLowerCase().includes("363d3d373d3d3d363d73");
}

export function exposes(code, name) {
  return isMinimalProxy(code) || hasSelector(code, name);
}

async function probeWrite(provider, to, name, from) {
  try {
    await provider.call({ from, to, data: nftIface.encodeFunctionData(name, [1]), value: 0n });
    return true;
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    const message = String(error.shortMessage || error.message || "");
    if (/missing revert data|function selector was not recognized|function does not exist|no data present/i.test(message)) return false;
    const data = error.data;
    if (data == null || data === "0x") return false;
    return true;
  }
}

async function findWrite(provider, nft, code, names, from, erc721) {
  const visible = names.find((name) => hasSelector(code, name));
  if (visible) return visible;
  if (!erc721 && !isMinimalProxy(code)) return null;
  for (const name of names) {
    if (await probeWrite(provider, nft, name, from)) return name;
  }
  return null;
}

export async function identifyContract(provider, address) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") return null;
  const phases = plainList(await tryCall(provider, address, phaseIface, "getPhases"));
  if (phases.length && phases.some((phase) => phase && (phase.name || phase.startTime != null))) {
    return { type: "phases", code };
  }
  const seaDrops = plainList(await tryCall(provider, address, nftIface, "getAllowedSeaDrop"));
  if (seaDrops.length > 0) return { type: "seadrop", seaDrops, code };
  const claim = await tryCall(provider, address, dropIface, "claimCondition");
  if (claim && BigInt(claim[1] ?? 0) > 0n) return { type: "thirdweb", code };
  const erc1155 = await tryCall(provider, address, nftIface, "supportsInterface", [ERC1155_ID]);
  const erc721 = await tryCall(provider, address, nftIface, "supportsInterface", [ERC721_ID]);
  if (erc1155 === true && erc721 !== true) return { type: "erc1155", code };
  const hasMint = PUBLIC_MINT_FNS.some((name) => exposes(code, name));
  if (erc721 === true || hasMint) return { type: "generic", code, erc721: erc721 === true };
  if (!isMinimalProxy(code)) return null;
  for (const name of PRICE_FNS) {
    const price = await tryCall(provider, address, nftIface, name);
    if (price != null) return { type: "generic", code, erc721: false };
  }
  return null;
}

function emptyRound(nft, reason) {
  return {
    id: "none",
    label: "public",
    kind: "public",
    standard: "unknown",
    start: 0,
    end: 0,
    price: 0n,
    quantity: 0,
    eligible: false,
    reason,
    to: nft,
    data: "0x",
    value: 0n,
  };
}

async function ownedIds(provider, token, wallet, limit) {
  if (!wallet) return { balance: 0n, ids: [], enumerable: false };
  const balance = await tryCall(provider, token, nftIface, "balanceOf", [wallet]);
  if (balance == null || BigInt(balance) === 0n) return { balance: balance ?? 0n, ids: [], enumerable: true };
  const ids = [];
  const count = Math.min(Number(balance), limit);
  for (let index = 0; index < count; index += 1) {
    const id = await tryCall(provider, token, nftIface, "tokenOfOwnerByIndex", [wallet, index]);
    if (id == null) return { balance: BigInt(balance), ids, enumerable: false };
    ids.push(BigInt(id));
  }
  return { balance: BigInt(balance), ids, enumerable: true };
}

export async function readRounds(provider, address, identity, context) {
  if (identity.type === "plan") return readPlan(provider, address, identity, context);
  if (identity.type === "phases") return readPhases(provider, address, identity, context);
  if (identity.type === "kalos") return readKalos(provider, address, identity, context);
  if (identity.type === "timed") return readTimed(identity, context);
  if (identity.type === "seadrop") return readSeaDrop(provider, address, identity, context);
  if (identity.type === "thirdweb") return readThirdweb(provider, address, context);
  if (identity.type === "erc1155") return [emptyRound(address, "ERC1155 chưa được mint tự động")];
  return readGeneric(provider, address, identity, context);
}

function namedOutputs(names, decoded) {
  const out = {};
  names.forEach((name, index) => {
    if (name) out[name] = decoded[index];
  });
  return out;
}

async function viewCount(provider, nft, plan, name, wallet) {
  const iface = plan.views?.[name];
  if (!iface || !wallet) return 0;
  try {
    const data = iface.encodeFunctionData(name, [wallet]);
    const raw = await provider.call({ to: nft, data });
    if (!raw || raw === "0x") return 0;
    return Number(iface.decodeFunctionResult(name, raw)[0] || 0);
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return 0;
  }
}

async function approvedOnPage(plan, wallet, fetchImpl) {
  if (!plan.checkPath || !wallet) return true;
  const url = new URL(`${plan.checkPath}${wallet}`, plan.pageUrl).href;
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || typeof body !== "object") return null;
    if (body.status === "approved" || body.eligible === true || body.allow === true) return true;
    if ("status" in body || body.eligible === false || body.found === false) return false;
    return null;
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return null;
  }
}

async function readPlan(provider, nft, identity, context) {
  const plan = identity.plan;
  let named;
  try {
    const raw = await provider.call({ to: nft, data: plan.infoData });
    const decoded = plan.infoIface.decodeFunctionResult(plan.infoName, raw);
    named = namedOutputs(plan.outputNames, decoded);
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return [emptyRound(nft, "không đọc được lịch mint trên contract")];
  }
  const start = Number(named.start || 0);
  const frLen = Number(named.frLen || 0);
  const rushLen = Number(named.rushLen || 0);
  const paused = named.isPaused === true;
  const supply = Number(named.supply || 0);
  const mintedTotal = Number(named.minted || 0);
  const left = Math.max(0, supply - mintedTotal);
  const approved = await approvedOnPage(plan, context.wallet, context.fetch || fetch);
  const phases = [];
  if (named.frPrice != null || named.frLen != null) {
    phases.push({
      id: "plan-front",
      label: "Front Row",
      kind: "allowlist",
      start,
      end: start && frLen ? start + frLen : 0,
      price: BigInt(named.frPrice || 0),
      cap: Number(named.frCap || 0),
      mintedFn: "frontRowMinted",
      pass: true,
    });
  }
  if (named.rPrice != null || named.rushLen) {
    phases.push({
      id: "plan-rush",
      label: "The Rush",
      kind: "public",
      start: start ? start + frLen : 0,
      end: start ? start + frLen + rushLen : 0,
      price: BigInt(named.rPrice || 0),
      cap: Number(named.pubCap || 0),
      mintedFn: "publicMinted",
      pass: false,
    });
  }
  phases.push({
    id: "plan-public",
    label: "Public",
    kind: "public",
    start: start ? start + frLen + rushLen : 0,
    end: 0,
    price: BigInt(named.pubPrice ?? 0),
    cap: Number(named.pubCap || 0),
    mintedFn: "publicMinted",
    pass: false,
  });
  const rounds = [];
  for (const phase of phases) {
    const already = await viewCount(provider, nft, plan, phase.mintedFn, context.wallet);
    const room = Math.max(0, phase.cap - already);
    const quantity = Math.min(capQuantity(context.limits.quantity, room, 0, false), left);
    const price = phase.price;
    let round = {
      id: phase.id,
      label: phase.label,
      kind: phase.kind,
      standard: "plan",
      start: phase.start,
      end: phase.end,
      price,
      quantity,
      to: nft,
      data: encodePlanMint(plan, quantity || 1),
      value: price * BigInt(quantity || 0),
    };
    if (phase.pass && plan.passPath && context.wallet) {
      const wallet = context.wallet;
      const fetchImpl = context.fetch || fetch;
      round.prepare = async () => {
        const url = new URL(`${plan.passPath}${wallet}`, plan.pageUrl).href;
        const response = await fetchImpl(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error("Trang không ký pass cho ví này.");
        const body = await response.json();
        const signature = body?.signature || body?.pass || body?.sig;
        if (!signature) throw new Error("Trang không trả chữ ký mint.");
        const nextQuantity = round.quantity || 1;
        return {
          ...round,
          data: encodePlanMint(plan, nextQuantity, { allowance: body.allowance ?? body.allow ?? nextQuantity, signature }),
          value: price * BigInt(nextQuantity),
        };
      };
    }
    if (!start) round = { ...round, quantity: 0, eligible: false, reason: "trang chưa công bố giờ mở" };
    else if (paused) round = { ...round, quantity: 0, eligible: false, reason: "đang pause" };
    else if (left <= 0) round = { ...round, quantity: 0, eligible: false, reason: "đã hết NFT" };
    else if (phase.pass && approved === false) round = { ...round, quantity: 0, eligible: false, reason: "ví không có trong danh sách của trang" };
    else if (phase.pass && approved == null) round = { ...round, quantity: 0, eligible: false, reason: "không đọc được danh sách của trang" };
    else if (phase.end && context.limits.now && context.limits.now >= phase.end) round = { ...round, quantity: 0, eligible: false, reason: "round đã kết thúc" };
    else if (quantity <= 0) round = { ...round, quantity: 0, eligible: false, reason: "đã hết suất của ví" };
    else if (price > context.limits.maxPrice) round = { ...round, quantity: 0, eligible: false, reason: "giá cao hơn trần" };
    else if (context.balance != null && context.balance < price * BigInt(quantity) + (context.limits.gasWei ?? 0n)) {
      round = { ...round, quantity: 0, eligible: false, reason: "ví không đủ số dư" };
    } else round = { ...round, eligible: true, reason: context.balance == null ? "ví đủ điều kiện (chưa kiểm số dư)" : "ví đủ điều kiện" };
    rounds.push(round);
  }
  return rounds;
}

async function phaseAllowances(identity, wallet, fetchImpl) {
  if (!identity.slug || !wallet || !fetchImpl) return null;
  const url = new URL(`/api/checker?collection=${encodeURIComponent(identity.slug)}&wallet=${wallet}`, identity.pageUrl || "https://mint.local/").href;
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json();
    const allowances = new Map();
    for (const item of body?.phases || []) {
      const id = Number(item.phaseId ?? item.id ?? item.phase);
      if (Number.isInteger(id)) allowances.set(id, Number(item.allowance ?? item.max ?? 0));
    }
    return allowances;
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return null;
  }
}

async function readPhases(provider, nft, identity, context) {
  const phases = plainList(await tryCall(provider, nft, phaseIface, "getPhases"));
  if (!phases.length) return [emptyRound(nft, "contract không có phase mint")];
  const fee = BigInt((await tryCall(provider, nft, phaseIface, "platformFeePerMint")) || 0);
  const mintedTotal = BigInt((await tryCall(provider, nft, phaseIface, "totalMinted")) || 0);
  const supply = BigInt((await tryCall(provider, nft, phaseIface, "maxSupply")) || 0);
  const left = supply > 0n ? supply - mintedTotal : null;
  const allowances = await phaseAllowances(identity, context.wallet, context.fetch);
  const rounds = [];
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const start = Number(phase.startTime || 0);
    const end = Number(phase.endTime || 0);
    const price = BigInt(phase.price || 0) + fee;
    const gated = Boolean(phase.gated);
    const cap = Number(phase.maxPerWallet || 0);
    const phaseSupply = Number(phase.maxSupply || 0);
    const phaseMinted = Number((await tryCall(provider, nft, phaseIface, "phaseMinted", [index])) || 0);
    const already = context.wallet ? Number((await tryCall(provider, nft, phaseIface, "mintedInPhase", [index, context.wallet])) || 0) : 0;
    const listed = allowances?.has(index) || false;
    const allowance = listed ? Number(allowances.get(index) || 0) : 0;
    const walletCap = gated ? (cap > 0 && allowance > 0 ? Math.min(cap, allowance) : allowance) : cap > 0 ? cap : context.limits.quantity;
    let quantity = capQuantity(context.limits.quantity, walletCap, already, false);
    if (left != null) quantity = Math.min(quantity, Number(left));
    if (phaseSupply > 0) quantity = Math.min(quantity, Math.max(0, phaseSupply - phaseMinted));
    const label = String(phase.name || `phase ${index + 1}`);
    let round = {
      id: `phase-${index}`,
      label,
      kind: gated ? "allowlist" : "public",
      standard: "phases",
      start,
      end,
      price,
      quantity,
      to: nft,
      data: phaseIface.encodeFunctionData("mint", [index, BigInt(quantity || 1), 0, "0x"]),
      value: price * BigInt(quantity || 0),
    };
    if (gated && identity.slug && context.wallet) {
      const wallet = context.wallet;
      const fetchImpl = context.fetch;
      const pageUrl = identity.pageUrl || "https://mint.local/";
      round.prepare = async () => {
        const url = new URL("/api/mint-auth", pageUrl).href;
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ collection: identity.slug, wallet, phaseId: index, contract: nft }),
        });
        if (!response.ok) throw new Error("Trang không ký cho ví này.");
        const body = await response.json();
        const signature = body?.signature || body?.sig;
        if (!signature) throw new Error("Trang không trả chữ ký mint.");
        const nextQuantity = round.quantity || 1;
        return {
          ...round,
          data: phaseIface.encodeFunctionData("mint", [index, BigInt(nextQuantity), BigInt(body.allowance ?? body.allow ?? nextQuantity), signature]),
          value: price * BigInt(nextQuantity),
        };
      };
    }
    if (supply > 0n && left <= 0n) round = { ...round, quantity: 0, eligible: false, reason: "đã hết NFT" };
    else if (end && context.limits.now && context.limits.now >= end) round = { ...round, quantity: 0, eligible: false, reason: "round đã kết thúc" };
    else if (!start) round = { ...round, quantity: 0, eligible: false, reason: "trang chưa công bố giờ mở" };
    else if (gated && allowances == null) round = { ...round, quantity: 0, eligible: false, reason: "không đọc được danh sách của trang" };
    else if (gated && !listed) round = { ...round, quantity: 0, eligible: false, reason: "ví không có trong danh sách của trang" };
    else if (quantity <= 0) round = { ...round, quantity: 0, eligible: false, reason: "đã hết suất của ví" };
    else if (price > context.limits.maxPrice) round = { ...round, quantity: 0, eligible: false, reason: "giá cao hơn trần" };
    else if (context.balance != null && context.balance < price * BigInt(quantity) + (context.limits.gasWei ?? 0n)) {
      round = { ...round, quantity: 0, eligible: false, reason: "ví không đủ số dư" };
    } else round = { ...round, eligible: true, reason: context.balance == null ? "ví đủ điều kiện (chưa kiểm số dư)" : "ví đủ điều kiện" };
    rounds.push(round);
  }
  return rounds;
}

async function readSeaDrop(provider, nft, identity, context) {
  const seaDrop = identity.seaDrops[0];
  const drop = await tryCall(provider, seaDrop, seaDropIface, "getPublicDrop", [nft]);
  const creator = await tryCall(provider, seaDrop, seaDropIface, "getCreatorPayoutAddress", [nft]);
  const allowed = plainList(await tryCall(provider, seaDrop, seaDropIface, "getAllowedFeeRecipients", [nft]));
  const root = await tryCall(provider, seaDrop, seaDropIface, "getAllowListMerkleRoot", [nft]);
  const stats = context.wallet
    ? await tryCall(provider, nft, nftIface, "getMintStats", [context.wallet])
    : null;
  const minted = stats ? BigInt(stats[0]) : 0n;
  const rounds = [];
  if (drop) {
    const feeRecipient = chooseFeeRecipient({
      restrict: Boolean(drop.restrictFeeRecipients ?? drop[5]),
      allowed,
      creator,
    });
    const round = seaDropPublicRound({
      drop: {
        mintPrice: drop.mintPrice ?? drop[0],
        startTime: drop.startTime ?? drop[1],
        endTime: drop.endTime ?? drop[2],
        maxTotalMintableByWallet: drop.maxTotalMintableByWallet ?? drop[3],
      },
      minted,
      balance: context.balance,
      limits: context.limits,
      feeRecipient,
      nft,
      seaDrop,
    });
    if (round) rounds.push(round);
  }

  if (root && root !== ethers.ZeroHash) {
    let matched = null;
    for (const entry of context.allowInfo?.entries || []) {
      if (context.wallet && entry.address !== context.wallet.toLowerCase()) continue;
      matched = seaDropAllowRound({
        root,
        entry,
        minted,
        balance: context.balance,
        limits: context.limits,
        feeRecipient: chooseFeeRecipient({ restrict: Boolean(entry.restrictFeeRecipients), allowed, creator }),
        nft,
        seaDrop,
        wallet: context.wallet,
      });
      if (matched) break;
    }
    rounds.push(
      matched || {
        ...emptyRound(seaDrop, "ví không có proof allowlist khớp merkle"),
        id: "seadrop-allowlist",
        label: "allowlist",
        kind: "allowlist",
        standard: "seadrop",
      },
    );
  }

  const gatedTokens = plainList(await tryCall(provider, seaDrop, seaDropIface, "getTokenGatedAllowedTokens", [nft]));
  for (const gated of gatedTokens) {
    const stage = await tryCall(provider, seaDrop, seaDropIface, "getTokenGatedDrop", [nft, gated]);
    if (!stage || Number(stage.startTime ?? stage[2] ?? 0) === 0) continue;
    const owned = await ownedIds(provider, gated, context.wallet, context.limits.quantity);
    if (!owned.enumerable) {
      rounds.push({
        ...emptyRound(seaDrop, "ví có token gate nhưng contract không liệt kê token id"),
        id: `seadrop-token-${gated}`,
        label: "token-gated",
        kind: "token-gated",
        standard: "seadrop",
        start: Number(stage.startTime ?? stage[2]),
        end: Number(stage.endTime ?? stage[3]),
        price: BigInt(stage.mintPrice ?? stage[0]),
      });
      continue;
    }
    const fresh = [];
    for (const tokenId of owned.ids) {
      const redeemed = await tryCall(provider, seaDrop, seaDropIface, "getAllowedNftTokenIdIsRedeemed", [nft, gated, tokenId]);
      if (redeemed !== true) fresh.push(tokenId);
    }
    const feeRecipient = chooseFeeRecipient({
      restrict: Boolean(stage.restrictFeeRecipients ?? stage[7]),
      allowed,
      creator,
    });
    const price = BigInt(stage.mintPrice ?? stage[0]);
    const start = Number(stage.startTime ?? stage[2]);
    const end = Number(stage.endTime ?? stage[3]);
    const maxWallet = stage.maxTotalMintableByWallet ?? stage[1];
    const quantity = Math.min(fresh.length, capQuantity(context.limits.quantity, maxWallet, 0, false));
    if (!feeRecipient || quantity === 0) {
      rounds.push({
        ...emptyRound(seaDrop, fresh.length === 0 ? "ví không giữ token của round này" : "thiếu fee recipient"),
        id: `seadrop-token-${gated}`,
        label: "token-gated",
        kind: "token-gated",
        standard: "seadrop",
        start,
        end,
        price,
      });
      continue;
    }
    const ids = fresh.slice(0, quantity);
    const data = seaDropIface.encodeFunctionData("mintAllowedTokenHolder", [nft, feeRecipient, ZERO, [gated, ids]]);
    const ended = context.limits.now > end;
    const cost = price * BigInt(ids.length);
    const enough = context.balance == null || context.balance >= cost + (context.limits.gasWei ?? 0n);
    rounds.push({
      id: `seadrop-token-${gated}`,
      label: "token-gated",
      kind: "token-gated",
      standard: "seadrop",
      start,
      end,
      price,
      quantity: ended || price > context.limits.maxPrice || !enough ? 0 : ids.length,
      eligible: !ended && price <= context.limits.maxPrice && enough && ids.length > 0,
      reason: ended
        ? "round đã kết thúc"
        : price > context.limits.maxPrice
          ? "giá cao hơn trần"
          : !enough
            ? "ví không đủ số dư"
            : "ví đủ điều kiện",
      to: seaDrop,
      data,
      value: cost,
    });
  }
  return rounds;
}

const timedIface = new ethers.Interface([
  "function mintPublic(uint32 quantity) payable",
  "function mintAllowlist(uint32 quantity, bytes32[] proof) payable",
]);

async function readProof(schedule, wallet, fetchImpl) {
  if (!wallet || !fetchImpl || !schedule.pageUrl) return null;
  for (const url of proofUrls(schedule, wallet)) {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
        headers: { accept: "application/json", "user-agent": "nft-mint/1.0" },
      });
      if (!response.ok) continue;
      const body = await response.json();
      const proof = Array.isArray(body?.proof) ? body.proof : Array.isArray(body?.merkleProof) ? body.merkleProof : [];
      if (!proof.length || !proof.every((item) => typeof item === "string" && /^0x[a-fA-F0-9]{64}$/.test(item))) continue;
      return { tier: body.tier ? String(body.tier) : "", proof };
    } catch (error) {
      if (error?.message === "Dừng.") throw error;
      // thử đường proof tiếp theo
    }
  }
  return null;
}

function timedRound(phase, end, schedule, context, proof) {
  const price = phase.price;
  const quantity = capQuantity(context.limits.quantity, phase.perWallet, 0, false);
  const ended = end !== 0 && context.limits.now > end;
  const allowed = phase.public || proofCovers(phase, proof);
  const cost = price * BigInt(quantity || 0);
  const enough = context.balance == null || context.balance >= cost + (context.limits.gasWei ?? 0n);
  const eligible = allowed && !ended && quantity > 0 && price <= context.limits.maxPrice && enough;
  const data = allowed
    ? timedIface.encodeFunctionData(phase.public ? "mintPublic" : "mintAllowlist", phase.public ? [quantity || 1] : [quantity || 1, proof.proof])
    : "0x";
  let reason = "ví đủ điều kiện";
  if (!allowed) reason = "ví không có trong allowlist";
  else if (ended) reason = "round đã kết thúc";
  else if (quantity <= 0) reason = "đã hết suất của ví";
  else if (price > context.limits.maxPrice) reason = "giá cao hơn trần";
  else if (!enough) reason = "ví không đủ số dư";
  return {
    id: `timed-${phase.key}`,
    label: phase.name,
    kind: phase.public ? "public" : "allowlist",
    standard: "timed",
    start: phase.start,
    end,
    price,
    quantity: eligible ? quantity : 0,
    eligible,
    reason,
    to: schedule.collection,
    data,
    value: eligible ? cost : 0n,
  };
}

async function readTimed(identity, context) {
  const schedule = identity.schedule;
  const proof = await readProof(schedule, context.wallet, context.fetch);
  return schedule.phases.map((phase, index) => {
    const next = schedule.phases[index + 1];
    return timedRound(phase, next ? next.start : 0, schedule, context, proof);
  });
}

async function readKalos(provider, nft, identity, context) {
  const rounds = await readSeaDrop(provider, nft, identity, context);
  if (!context.wallet || !context.fetch || !identity.slug) return rounds;
  const entries = await fetchKalosEligibility(identity.slug, context.wallet, context.fetch);
  if (!entries.length) return rounds;
  const seaDrop = identity.seaDrops[0];
  const creator = await tryCall(provider, seaDrop, seaDropIface, "getCreatorPayoutAddress", [nft]);
  const allowed = plainList(await tryCall(provider, seaDrop, seaDropIface, "getAllowedFeeRecipients", [nft]));
  const root = await tryCall(provider, seaDrop, seaDropIface, "getAllowListMerkleRoot", [nft]);
  const stats = await tryCall(provider, nft, nftIface, "getMintStats", [context.wallet]);
  const minted = stats ? BigInt(stats[0]) : 0n;
  const kept = rounds.filter((round) => round.id !== "seadrop-allowlist");
  for (const entry of entries) {
    const round = seaDropAllowRound({
      root,
      entry,
      minted,
      balance: context.balance,
      limits: context.limits,
      feeRecipient: chooseFeeRecipient({ restrict: entry.restrictFeeRecipients, allowed, creator }),
      nft,
      seaDrop,
      wallet: context.wallet,
    });
    if (!round) continue;
    kept.push({ ...round, id: `kalos-allow-${entry.stageIndex}`, label: entry.name || "allowlist" });
  }
  return kept.length ? kept : rounds;
}

function asCondition(raw) {
  const condition = raw?.length === 1 ? raw[0] : raw;
  return {
    startTimestamp: BigInt(condition.startTimestamp ?? condition[0] ?? 0),
    maxClaimableSupply: BigInt(condition.maxClaimableSupply ?? condition[1] ?? 0),
    supplyClaimed: BigInt(condition.supplyClaimed ?? condition[2] ?? 0),
    quantityLimitPerWallet: BigInt(condition.quantityLimitPerWallet ?? condition[3] ?? 0),
    merkleRoot: condition.merkleRoot ?? condition[4] ?? ethers.ZeroHash,
    pricePerToken: BigInt(condition.pricePerToken ?? condition[5] ?? 0),
    currency: condition.currency ?? condition[6] ?? ZERO,
  };
}

async function readThirdweb(provider, nft, context) {
  const head = await tryCall(provider, nft, dropIface, "claimCondition");
  if (!head) return [];
  const startId = Number(head[0]);
  const count = Math.min(Number(head[1]), 12);
  const rounds = [];
  for (let index = 0; index < count; index += 1) {
    const id = startId + index;
    const raw = await tryCall(provider, nft, dropIface, "getClaimConditionById", [id]);
    if (!raw) continue;
    const condition = asCondition(raw);
    if (condition.startTimestamp === 0n && condition.maxClaimableSupply === 0n) continue;
    const claimed = context.wallet
      ? await tryCall(provider, nft, dropIface, "getSupplyClaimedByWallet", [id, context.wallet])
      : 0n;
    rounds.push(
      thirdwebRound({
        condition,
        id,
        claimed: BigInt(claimed || 0),
        balance: context.balance,
        limits: context.limits,
        nft,
        wallet: context.wallet,
        allowInfo: context.allowInfo,
      }),
    );
  }
  return rounds;
}

async function readGeneric(provider, nft, identity, context) {
  const code = identity.code || "";
  const namesOf = (names) => (identity.erc721 ? names : names.filter((name) => exposes(code, name)));
  const priceHit = await firstCall(provider, nft, namesOf(PRICE_FNS));
  const startHit = await firstCall(provider, nft, namesOf(PUBLIC_START_FNS));
  const allowStartHit = await firstCall(provider, nft, namesOf(ALLOW_START_FNS));
  const maxHit = await firstCall(provider, nft, namesOf(MAX_FNS));
  const paused = namesOf(["paused"]).length ? await tryCall(provider, nft, nftIface, "paused") : null;
  let saleActive = null;
  for (const name of namesOf(["publicSaleActive", "saleActive", "mintEnabled"])) {
    saleActive = await tryCall(provider, nft, nftIface, name);
    if (saleActive != null) break;
  }
  let minted = 0n;
  let allowlisted = null;
  if (context.wallet) {
    const mintedHit = await firstCall(
      provider,
      nft,
      namesOf(MINTED_FNS),
      [context.wallet],
    );
    if (mintedHit) minted = BigInt(mintedHit.value);
    for (const name of namesOf(ALLOW_BOOL_FNS)) {
      allowlisted = await tryCall(provider, nft, nftIface, name, [context.wallet]);
      if (allowlisted != null) break;
    }
  }
  const from = context.wallet || ZERO;
  const publicFn = await findWrite(provider, nft, code, PUBLIC_MINT_FNS, from, identity.erc721);
  const allowFn = await findWrite(provider, nft, code, ALLOW_MINT_FNS, from, identity.erc721);
  return genericRounds({
    price: priceHit ? BigInt(priceHit.value) : null,
    publicStart: startHit ? Number(startHit.value) : null,
    allowStart: allowStartHit ? Number(allowStartHit.value) : null,
    maxPerWallet: maxHit ? BigInt(maxHit.value) : null,
    minted,
    allowlisted: allowlisted == null ? null : Boolean(allowlisted),
    balance: context.balance,
    limits: context.limits,
    nft,
    paused: paused === true,
    publicFn,
    allowFn,
    saleActive: saleActive == null ? null : Boolean(saleActive),
    openIfMintable: Boolean(publicFn),
  });
}
