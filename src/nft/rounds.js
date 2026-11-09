import { ethers } from "ethers";
import { NATIVE, ZERO, dropIface, nftIface, plainList, seaDropIface } from "./abi.js";
import { proofFromLeaves, seaDropLeaf, thirdwebLeaf, verifyProof } from "./merkle.js";

export function capQuantity(requested, maxPerWallet, already, zeroMeansUnlimited = false) {
  const ask = Math.max(0, Math.floor(Number(requested)));
  if (!Number.isInteger(ask) || ask === 0) return 0;
  const cap = Number(maxPerWallet);
  if (zeroMeansUnlimited && cap === 0) return ask;
  if (!Number.isFinite(cap)) return ask;
  const room = cap - Number(already || 0);
  return Math.max(0, Math.min(ask, room));
}

export function isNativeCurrency(currency) {
  if (!currency) return true;
  const value = currency.toLowerCase();
  return value === ZERO.toLowerCase() || value === NATIVE.toLowerCase();
}

export function chooseFeeRecipient({ restrict, allowed, creator }) {
  const list = plainList(allowed).filter((item) => item && String(item).toLowerCase() !== ZERO.toLowerCase());
  if (restrict) return list[0] || null;
  if (list[0]) return list[0];
  if (creator && creator.toLowerCase() !== ZERO.toLowerCase()) return creator;
  return null;
}

function gasReserve(limits) {
  return limits.gasWei ?? 0n;
}

function afford(balance, price, quantity, limits) {
  if (balance == null) return { ok: true, unknown: true };
  return { ok: balance >= price * BigInt(quantity) + gasReserve(limits), unknown: false };
}

function finish(round, { price, quantity, balance, limits, ended, extraReason }) {
  if (ended) return { ...round, eligible: false, reason: "round đã kết thúc" };
  if (quantity <= 0) return { ...round, eligible: false, reason: extraReason || "đã hết suất của ví" };
  if (price > limits.maxPrice) return { ...round, eligible: false, reason: "giá cao hơn trần" };
  const money = afford(balance, price, quantity, limits);
  if (!money.ok) return { ...round, eligible: false, reason: "ví không đủ số dư" };
  return {
    ...round,
    eligible: true,
    reason: money.unknown ? "ví đủ điều kiện (chưa kiểm số dư)" : "ví đủ điều kiện",
  };
}

export function eligibleRounds(rounds, nowSec) {
  return (rounds || [])
    .filter((round) => round.eligible && round.quantity > 0 && (round.end === 0 || nowSec <= round.end))
    .sort((a, b) => a.start - b.start || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
}

export function selectRound(rounds, nowSec) {
  const eligible = eligibleRounds(rounds, nowSec);
  const active = eligible.filter((round) => round.start <= nowSec);
  if (active.length) {
    active.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.start - b.start));
    return active[0];
  }
  return eligible[0] || null;
}

export function seaDropPublicRound({ drop, minted, balance, limits, feeRecipient, nft, seaDrop }) {
  const start = Number(drop.startTime);
  const end = Number(drop.endTime);
  if (!start || !end) return null;
  const price = BigInt(drop.mintPrice);
  const quantity = capQuantity(limits.quantity, drop.maxTotalMintableByWallet, minted, false);
  const ended = limits.now > end;
  if (!feeRecipient) {
    return {
      id: "seadrop-public",
      label: "public",
      kind: "public",
      standard: "seadrop",
      start,
      end,
      price,
      quantity: 0,
      eligible: false,
      reason: "thiếu fee recipient",
      to: seaDrop,
      data: "0x",
      value: 0n,
    };
  }
  const data = seaDropIface.encodeFunctionData("mintPublic", [nft, feeRecipient, ZERO, quantity || 1]);
  return finish(
    {
      id: "seadrop-public",
      label: "public",
      kind: "public",
      standard: "seadrop",
      start,
      end,
      price,
      quantity,
      to: seaDrop,
      data,
      value: price * BigInt(quantity || 0),
    },
    { price, quantity, balance, limits, ended },
  );
}

export function seaDropAllowRound({ root, entry, minted, balance, limits, feeRecipient, nft, seaDrop, wallet }) {
  if (!entry || !feeRecipient || !wallet) return null;
  const params = {
    mintPrice: entry.mintPrice ?? 0n,
    maxTotalMintableByWallet: entry.maxTotalMintableByWallet ?? 0n,
    startTime: entry.startTime ?? 0n,
    endTime: entry.endTime ?? 0n,
    dropStageIndex: entry.dropStageIndex ?? 1n,
    maxTokenSupplyForStage: entry.maxTokenSupplyForStage ?? 0n,
    feeBps: entry.feeBps ?? 0n,
    restrictFeeRecipients: Boolean(entry.restrictFeeRecipients),
  };
  if (params.startTime === 0n || params.endTime === 0n || params.maxTotalMintableByWallet === 0n) return null;
  const leaf = seaDropLeaf(wallet, params);
  const proof = entry.proof || [];
  if (!verifyProof(proof, root, leaf)) return null;
  const price = params.mintPrice;
  const start = Number(params.startTime);
  const end = Number(params.endTime);
  const quantity = capQuantity(limits.quantity, params.maxTotalMintableByWallet, minted, false);
  const data = seaDropIface.encodeFunctionData("mintAllowList", [
    nft,
    feeRecipient,
    ZERO,
    quantity || 1,
    [
      params.mintPrice,
      params.maxTotalMintableByWallet,
      params.startTime,
      params.endTime,
      params.dropStageIndex,
      params.maxTokenSupplyForStage,
      params.feeBps,
      params.restrictFeeRecipients,
    ],
    proof,
  ]);
  return finish(
    {
      id: "seadrop-allowlist",
      label: "allowlist",
      kind: "allowlist",
      standard: "seadrop",
      start,
      end,
      price,
      quantity,
      to: seaDrop,
      data,
      value: price * BigInt(quantity || 0),
    },
    { price, quantity, balance, limits, ended: limits.now > end },
  );
}

export function thirdwebRound({ condition, id, claimed, balance, limits, nft, wallet, allowInfo }) {
  const price = BigInt(condition.pricePerToken);
  const currency = condition.currency;
  if (!isNativeCurrency(currency)) {
    return {
      id: `thirdweb-${id}`,
      label: condition.merkleRoot && condition.merkleRoot !== ethers.ZeroHash ? "allowlist" : "public",
      kind: "erc20",
      standard: "thirdweb",
      start: Number(condition.startTimestamp),
      end: 0,
      price,
      quantity: 0,
      eligible: false,
      reason: "round trả bằng token, không phải coin native",
      to: nft,
      data: "0x",
      value: 0n,
    };
  }
  const root = condition.merkleRoot;
  const restricted = root && root !== ethers.ZeroHash;
  let proof = [];
  let limit = condition.quantityLimitPerWallet;
  let payPrice = price;
  let payCurrency = currency;
  if (restricted) {
    const built = matchThirdwebAllow(allowInfo, wallet, root, condition);
    if (!built) {
      return {
        id: `thirdweb-${id}`,
        label: "allowlist",
        kind: "allowlist",
        standard: "thirdweb",
        start: Number(condition.startTimestamp),
        end: 0,
        price,
        quantity: 0,
        eligible: false,
        reason: "ví không có proof allowlist khớp merkle",
        to: nft,
        data: "0x",
        value: 0n,
      };
    }
    proof = built.proof;
    limit = built.limit;
    payPrice = built.price;
    payCurrency = built.currency;
  }
  const quantity = capQuantity(limits.quantity, limit, claimed, true);
  const start = Number(condition.startTimestamp);
  const supplyLeft = BigInt(condition.maxClaimableSupply) - BigInt(condition.supplyClaimed);
  const ended = supplyLeft <= 0n;
  const proofPrice = restricted ? payPrice : ethers.MaxUint256;
  const proofLimit = restricted ? limit : 0n;
  const proofCurrency = restricted ? payCurrency : ZERO;
  const data = dropIface.encodeFunctionData("claim", [
    wallet || ZERO,
    quantity || 1,
    payCurrency,
    payPrice,
    [proof, proofLimit, proofPrice, proofCurrency],
    "0x",
  ]);
  return finish(
    {
      id: `thirdweb-${id}`,
      label: restricted ? "allowlist" : "public",
      kind: restricted ? "allowlist" : "public",
      standard: "thirdweb",
      start,
      end: 0,
      price: payPrice,
      quantity,
      to: nft,
      data,
      value: payPrice * BigInt(quantity || 0),
    },
    { price: payPrice, quantity, balance, limits, ended, extraReason: ended ? "đã hết supply" : undefined },
  );
}

function matchThirdwebAllow(allowInfo, wallet, root, condition) {
  if (!wallet) return null;
  const lower = wallet.toLowerCase();
  for (const entry of allowInfo?.entries || []) {
    if (entry.address !== lower || !entry.proof?.length) continue;
    const limit = entry.maxTotalMintableByWallet ?? condition.quantityLimitPerWallet;
    const price = entry.mintPrice ?? condition.pricePerToken;
    const currency = entry.currency || condition.currency;
    const leaf = thirdwebLeaf(wallet, limit, price, currency);
    if (verifyProof(entry.proof, root, leaf)) {
      return { proof: entry.proof, limit, price, currency };
    }
  }
  const lists = allowInfo?.lists || [];
  const attempts = [];
  for (const list of lists) {
    if (!list.includes(lower)) continue;
    attempts.push(list);
    attempts.push([...list].sort());
  }
  for (const list of attempts) {
    const leaves = list.map((item) =>
      thirdwebLeaf(ethers.getAddress(item), condition.quantityLimitPerWallet, condition.pricePerToken, condition.currency),
    );
    const index = list.findIndex((item) => item === lower);
    for (const duplicateOdd of [false, true]) {
      const built = proofFromLeaves(leaves, index, { duplicateOdd });
      if (built.root && built.root.toLowerCase() === root.toLowerCase()) {
        return {
          proof: built.proof,
          limit: condition.quantityLimitPerWallet,
          price: condition.pricePerToken,
          currency: condition.currency,
        };
      }
    }
  }
  return null;
}

export function genericRounds({
  price,
  publicStart,
  allowStart,
  maxPerWallet,
  minted,
  allowlisted,
  balance,
  limits,
  nft,
  paused,
  publicFn,
  allowFn,
  saleActive,
  openIfMintable = false,
}) {
  const rounds = [];
  const unit = price ?? 0n;
  const mintData = (fn, quantity) => nftIface.encodeFunctionData(fn, [quantity || 1]);
  if (allowStart != null || allowlisted === true) {
    const start = allowStart ?? 0;
    const quantity = capQuantity(limits.quantity, maxPerWallet ?? limits.quantity, minted, !maxPerWallet);
    const fn = allowFn || publicFn;
    let round = {
      id: "generic-allowlist",
      label: "allowlist",
      kind: "allowlist",
      standard: "generic",
      start,
      end: 0,
      price: unit,
      quantity,
      to: nft,
      data: fn ? mintData(fn, quantity) : "0x",
      value: unit * BigInt(quantity || 0),
    };
    if (paused) round = { ...round, quantity: 0, eligible: false, reason: "đang pause" };
    else if (!fn) round = { ...round, quantity: 0, eligible: false, reason: "không thấy hàm mint allowlist" };
    else if (!allowlisted) round = { ...round, quantity: 0, eligible: false, reason: "ví không nằm trong allowlist" };
    else round = finish(round, { price: unit, quantity, balance, limits, ended: false });
    rounds.push(round);
  }

  const publicKnown = Boolean(publicFn) && (publicStart != null || saleActive != null || price != null || openIfMintable);
  if (publicKnown) {
    const start = publicStart ?? 0;
    const quantity = capQuantity(limits.quantity, maxPerWallet ?? limits.quantity, minted, !maxPerWallet);
    let round = {
      id: "generic-public",
      label: "public",
      kind: "public",
      standard: "generic",
      start,
      end: 0,
      price: unit,
      quantity,
      to: nft,
      data: mintData(publicFn, quantity),
      value: unit * BigInt(quantity || 0),
    };
    if (paused) round = { ...round, quantity: 0, eligible: false, reason: "đang pause" };
    else if (saleActive === false && !(publicStart > limits.now)) {
      round = { ...round, quantity: 0, eligible: false, reason: "chưa có giờ mở" };
    } else round = finish(round, { price: unit, quantity, balance, limits, ended: false });
    rounds.push(round);
  }
  return rounds;
}

export function formatWhen(unixSec) {
  if (!unixSec) return "ngay bây giờ";
  return new Date(unixSec * 1000).toISOString().replace(".000Z", "Z");
}

export function formatRound(round, symbol) {
  const price = ethers.formatEther(round.price);
  return `${round.label} | ${price} ${symbol} | mở ${formatWhen(round.start)} | số lượng ${round.quantity} | ${round.reason}`;
}
