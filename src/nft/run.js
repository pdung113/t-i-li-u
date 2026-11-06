import { ethers } from "ethers";
import { log as defaultLog } from "../log.js";
import { probeOrder, resolveNftChain } from "./chains.js";
import { collectAllowInfo, chainHintsFromText, extractCandidates, linkedResources, parseMarketUrl } from "./parse.js";
import { identifyContract, readRounds } from "./read.js";
import { formatRound, selectRound } from "./rounds.js";
import { fetchFulfillment, fetchListings, resolveCollection } from "./opensea.js";
import { pickCheapest } from "./listings.js";
import { formatReport, safeReason, shortAddress } from "./notepad.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNotStarted(message) {
  return /not active|not started|hasn.t started|has not started|cant claim yet|can.t claim|sale is not|salenotactive|notactive|too soon|minting (is )?not|not open/i.test(
    String(message || ""),
  );
}

export function applyGas(tx, chain, gasGwei, gasLimit) {
  const gas = ethers.parseUnits(String(gasGwei), "gwei");
  const out = {
    chainId: chain.chainId,
    to: ethers.getAddress(tx.to),
    data: tx.data,
    value: tx.value,
    gasLimit,
  };
  if (chain.eip1559) {
    out.type = 2;
    out.maxFeePerGas = gas;
    out.maxPriorityFeePerGas = gas;
  } else {
    out.type = 0;
    out.gasPrice = gas;
  }
  return out;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
    headers: { "user-agent": "nft-mint/1.0", accept: "text/html,application/json,text/plain" },
  });
  if (!response.ok) throw new Error(`Không tải được ${url} (${response.status}).`);
  return (await response.text()).slice(0, 1_500_000);
}

function chainNameOf(value) {
  if (!value) return null;
  try {
    return resolveNftChain(value).name;
  } catch {
    return null;
  }
}

export async function loadPage(url, fetchImpl) {
  const parsed = parseMarketUrl(url);
  let html = "";
  try {
    html = await fetchText(parsed.href, fetchImpl);
  } catch (error) {
    if (!parsed.contract && !parsed.slug) throw error;
    html = "";
  }
  const extras = [];
  if (html) {
    for (const link of linkedResources(html, parsed.href)) {
      try {
        extras.push(await fetchText(link, fetchImpl));
      } catch {
        // script phụ không bắt buộc
      }
    }
  }
  const combined = [html, ...extras].join("\n");
  const candidates = [];
  const push = (address, score, chain = null) => {
    const key = address.toLowerCase();
    if (candidates.some((item) => item.address.toLowerCase() === key)) return;
    candidates.push({ address, score, chain });
  };
  if (parsed.contract) push(parsed.contract, 200, parsed.chain);
  for (const item of extractCandidates(combined)) push(item.address, item.score, null);
  return {
    parsed,
    html: combined,
    candidates,
    hints: [parsed.chain, ...chainHintsFromText(combined)].filter(Boolean),
  };
}

async function attachCollection(page, apiKey, fetchImpl, log) {
  if (!page.parsed.slug || !apiKey) return page;
  try {
    const found = await resolveCollection(page.parsed.slug, apiKey, fetchImpl);
    for (const item of found) {
      const address = ethers.getAddress(item.address);
      const chain = chainNameOf(item.chain);
      const existing = page.candidates.find((cand) => cand.address.toLowerCase() === address.toLowerCase());
      if (existing) {
        existing.score = Math.max(existing.score, 250);
        existing.chain = existing.chain || chain;
      } else {
        page.candidates.unshift({ address, score: 250, chain });
      }
    }
  } catch (error) {
    log(error.message);
  }
  return page;
}

function providerCache(factory) {
  const items = [];
  return {
    get(chain, rpc) {
      const found = items.find((item) => item.chainId === chain.chainId);
      if (found) return found.provider;
      const provider = factory({ ...chain, rpc: rpc || chain.rpc });
      items.push({ chainId: chain.chainId, provider });
      return provider;
    },
    async destroy() {
      for (const item of items) await item.provider.destroy?.();
    },
  };
}

async function findHits(page, options, providers) {
  const hits = [];
  const ranked = page.candidates.slice().sort((a, b) => b.score - a.score).slice(0, 8);
  for (const cand of ranked) {
    const chains = options.chain
      ? [options.chain]
      : cand.chain
        ? [resolveNftChain(cand.chain)]
        : probeOrder(page.hints);
    for (const chain of chains) {
      const rpc = options.rpc && (options.chain || cand.chain || page.hints.length === 1) ? options.rpc : chain.rpc;
      const provider = providers.get(chain, rpc);
      const identity = await identifyContract(provider, cand.address);
      if (!identity) continue;
      hits.push({ ...cand, chain, provider, identity });
      break;
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

function betterRound(next, current, nowSec) {
  const nextActive = next.start <= nowSec;
  const currentActive = current.start <= nowSec;
  if (nextActive !== currentActive) return nextActive;
  if (!nextActive && next.start !== current.start) return next.start < current.start;
  if (next.price !== current.price) return next.price < current.price;
  return next.start < current.start;
}

async function chooseHit(hits, context, nowSec, log) {
  let fallback = null;
  let best = null;
  for (const hit of hits) {
    const balance = context.wallet ? await hit.provider.getBalance(context.wallet) : null;
    const rounds = await readRounds(hit.provider, hit.address, hit.identity, { ...context, balance });
    if (!fallback && rounds.length) fallback = { hit, rounds, round: null };
    const round = selectRound(rounds, nowSec);
    if (!round) continue;
    if (context.wallet && round.start <= nowSec) {
      const state = await callState(hit.provider, context.wallet, round);
      if (state !== "ok") {
        log(`${hit.address} round ${round.label} chưa gọi được: ${state}`);
        continue;
      }
    }
    if (!best || betterRound(round, best.round, nowSec)) best = { hit, rounds, round };
  }
  return best || fallback;
}

async function callState(provider, from, round) {
  try {
    await provider.call({ from, to: round.to, data: round.data, value: round.value });
    return "ok";
  } catch (error) {
    const message = error.shortMessage || error.reason || error.message || "revert";
    if (isNotStarted(message)) return "wait";
    return message;
  }
}

function printRounds(rounds, symbol, log) {
  if (!rounds.length) {
    log("Không thấy round mint trên contract này.");
    return;
  }
  for (const round of rounds) log(formatRound(round, symbol));
}

async function syncNow(provider) {
  const block = await provider.getBlock("latest");
  const offset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
  return () => Math.floor(Date.now() / 1000) + offset;
}

async function waitForStart(round, nowSec, log, shouldStop) {
  let lastLog = 0;
  while (nowSec() < round.start) {
    if (shouldStop()) throw new Error("Dừng.");
    const remain = round.start - nowSec();
    if (Date.now() - lastLog > 15_000) {
      log(`Canh round ${round.label}. Tự mint khi mở, còn ${remain}s.`);
      lastLog = Date.now();
    }
    await sleep(Math.min(Math.max(remain * 1000, 20), 1000));
  }
}

export async function runMint(options, deps = {}) {
  const log = deps.log || defaultLog;
  const fetchImpl = deps.fetch || fetch;
  const providers = providerCache(deps.providerFactory || ((chain) => new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true })));
  let stopped = false;
  if (deps.listen !== false) {
    process.once("SIGINT", () => {
      stopped = true;
    });
  }
  try {
    const page = await attachCollection(await loadPage(options.url, fetchImpl), options.apiKey, fetchImpl, log);
    if (!page.candidates.length) {
      throw new Error("Không thấy địa chỉ contract trên trang. Dán link có 0x, hoặc thêm OPENSEA_API_KEY với link collection OpenSea.");
    }
    log(
      `Mint | chain ${options.chain?.name || "tự nhận"} | số lượng ${options.quantity} | gas ${options.gasGwei} gwei | trần ${ethers.formatEther(options.maxPrice)} | ${options.dryRun ? "DRY RUN" : "MINT THẬT"}`,
    );
    const hits = await findHits(page, options, providers);
    if (!hits.length) throw new Error("Trang có địa chỉ nhưng không phải NFT mint (SeaDrop, thirdweb, hoặc mint public).");
    const contextBase = {
      wallet: options.wallet,
      allowInfo: collectAllowInfo(page.html, options.wallet),
      limits: {
        quantity: options.quantity,
        maxPrice: options.maxPrice,
        gasWei: ethers.parseUnits(String(options.gasGwei), "gwei") * BigInt(options.gasLimit),
        now: 0,
      },
    };
    let nowSec = await syncNow(hits[0].provider);
    contextBase.limits.now = nowSec();
    let chosen = await chooseHit(hits, contextBase, nowSec(), log);
    if (!chosen?.round) {
      printRounds(chosen?.rounds || [], hits[0].chain.nativeSymbol, log);
      throw new Error("Không có round nào ví đủ điều kiện.");
    }
    nowSec = await syncNow(chosen.hit.provider);
    const symbol = chosen.hit.chain.nativeSymbol;
    log(`Contract ${chosen.hit.address} trên ${chosen.hit.chain.name} (${chosen.hit.identity.type}).`);
    printRounds(chosen.rounds, symbol, log);
    log(`Chọn round ${chosen.round.label}.`);
    if (options.dryRun) {
      const tx = applyGas(chosen.round, chosen.hit.chain, options.gasGwei, options.gasLimit);
      log(`DRY RUN: sẽ mint ${chosen.round.quantity} NFT, value ${ethers.formatEther(tx.value)} ${symbol}, gas ${options.gasGwei} gwei.`);
      if (chosen.round.start > nowSec()) log(`Chưa mở. Tới ${new Date(chosen.round.start * 1000).toISOString()} thì lệnh thật sẽ tự gửi.`);
      return {
        round: chosen.round,
        tx,
        sent: false,
        chain: chosen.hit.chain.name,
        quantity: chosen.round.quantity,
        wallet: options.wallet,
      };
    }
    if (!options.signer) throw new Error("Đặt PRIVATE_KEY trong .env, hoặc giữ DRY_RUN=true.");
    if (chosen.round.start > nowSec()) await waitForStart(chosen.round, nowSec, log, () => stopped);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      contextBase.limits.now = nowSec();
      const again = await chooseHit(hits, contextBase, nowSec(), log);
      if (!again?.round) throw new Error("Tới giờ mở nhưng ví không còn đủ điều kiện.");
      if (again.round.start > nowSec()) {
        await sleep(200);
        continue;
      }
      const wallet = options.signer.connect(again.hit.provider);
      const state = await callState(again.hit.provider, wallet.address, again.round);
      if (state === "wait") {
        await sleep(250);
        continue;
      }
      if (state !== "ok") throw new Error(state);
      const tx = applyGas(again.round, again.hit.chain, options.gasGwei, options.gasLimit);
      const sent = await wallet.sendTransaction(tx);
      log(`Đã gửi ${sent.hash}`);
      const receipt = await sent.wait();
      if (receipt?.status !== 1) throw new Error("Giao dịch mint revert.");
      log(`Mint thành công ${again.round.quantity} NFT.`);
      return {
        round: again.round,
        tx,
        sent: true,
        hash: sent.hash,
        chain: again.hit.chain.name,
        quantity: again.round.quantity,
        wallet: options.wallet,
      };
    }
    throw new Error("Round chưa nhận lệnh mint.");
  } finally {
    await providers.destroy();
  }
}

export async function runMintWallets(options, wallets, deps = {}) {
  const log = deps.log || defaultLog;
  const chainLabel = options.chain?.name || "tự nhận";
  log(`Bắt đầu mint | chain ${chainLabel} | ${wallets.length} ví | gas ${options.gasGwei} gwei | số lượng ${options.quantity}`);
  const rows = await Promise.all(
    wallets.map(async (entry) => {
      const tag = shortAddress(entry.address);
      const childLog = (message) => log(`${tag} | ${message}`);
      try {
        const result = await runMint(
          { ...options, wallet: entry.address, signer: entry.signer },
          { ...deps, log: childLog, listen: false },
        );
        return {
          ok: true,
          sent: Boolean(result.sent),
          quantity: result.quantity,
          wallet: entry.address,
          chain: result.chain,
          reason: "",
        };
      } catch (error) {
        const reason = safeReason(error.message || error);
        childLog(reason);
        return {
          ok: false,
          sent: false,
          quantity: 0,
          wallet: entry.address,
          chain: options.chain?.name || "",
          reason,
        };
      }
    }),
  );
  const chainName = rows.find((row) => row.chain)?.chain || chainLabel;
  const text = formatReport(rows, chainName);
  log(text);
  return { rows, text, chain: chainName };
}

export async function runBuy(options, deps = {}) {
  const log = deps.log || defaultLog;
  const fetchImpl = deps.fetch || fetch;
  if (!options.apiKey) throw new Error("Mua listing cần OPENSEA_API_KEY trong .env.");
  const providers = providerCache(deps.providerFactory || ((chain) => new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true })));
  try {
    const page = await attachCollection(await loadPage(options.url, fetchImpl), options.apiKey, fetchImpl, log);
    const cand = page.candidates.slice().sort((a, b) => b.score - a.score)[0];
    if (!cand) throw new Error("Không thấy contract hoặc collection để mua.");
    const chain = options.chain || resolveNftChain(cand.chain || page.parsed.chain || page.hints[0] || "eth");
    log(
      `Mua giá thấp | số lượng ${options.quantity} | gas ${options.gasGwei} gwei | trần ${ethers.formatEther(options.maxPrice)} ${chain.nativeSymbol} | ${options.dryRun ? "DRY RUN" : "MUA THẬT"}`,
    );
    const listings = await fetchListings({
      chain: chain.opensea,
      slug: cand.score >= 250 ? null : page.parsed.slug,
      contract: cand.address,
      tokenId: page.parsed.tokenId,
      apiKey: options.apiKey,
      limit: Math.max(options.quantity * 5, 10),
      fetchImpl,
    });
    const picked = pickCheapest(listings, options.maxPrice, options.quantity, page.parsed.kind === "item" ? page.parsed.tokenId : null).filter(
      (item) => item.protocol,
    );
    if (!picked.length) throw new Error("Không có listing nào dưới trần giá.");
    for (const item of picked) {
      log(`Listing token ${item.tokenId} giá ${ethers.formatEther(item.price)} ${chain.nativeSymbol}.`);
    }
    if (!options.wallet) {
      log("Chưa có PRIVATE_KEY nên chỉ in giá, chưa tạo giao dịch mua.");
      return { listings: picked, sent: false };
    }
    const provider = providers.get(chain, options.rpc || chain.rpc);
    const wallet = options.signer ? options.signer.connect(provider) : null;
    const sent = [];
    for (const item of picked) {
      const body = await fetchFulfillment({
        hash: item.hash,
        chain: chain.opensea,
        protocol: item.protocol,
        fulfiller: options.wallet,
        apiKey: options.apiKey,
        fetchImpl,
      });
      const tx = applyGas(body, chain, options.gasGwei, options.gasLimit);
      if (options.dryRun || !wallet) {
        log(`DRY RUN: mua token ${item.tokenId}, value ${ethers.formatEther(tx.value)} ${chain.nativeSymbol}.`);
        continue;
      }
      const response = await wallet.sendTransaction(tx);
      log(`Đã gửi ${response.hash}`);
      const receipt = await response.wait();
      if (receipt?.status !== 1) throw new Error("Giao dịch mua revert.");
      sent.push(response.hash);
    }
    if (sent.length) log(`Mua xong ${sent.length} NFT.`);
    return { listings: picked, sent: sent.length > 0, hashes: sent };
  } finally {
    await providers.destroy();
  }
}
