import { ethers } from "ethers";
import { log as defaultLog } from "../log.js";
import { probeOrder, resolveNftChain } from "./chains.js";
import { addressesNearSlug, collectAllowInfo, chainHintsFromText, collectionSlug, contractUnpublished, extractCandidates, keepAddress, linkedResources, parseMarketUrl, scriptChunks } from "./parse.js";
import { mintPlanFromText } from "./pageAbi.js";
import { identifyContract, readRounds } from "./read.js";
import { eligibleRounds, formatRound, selectRound } from "./rounds.js";
import { fetchFulfillment, fetchListings, resolveCollection } from "./opensea.js";
import { pickCheapest } from "./listings.js";
import { loadKalosPage } from "./kalos.js";
import { scheduleFromPage } from "./schedule.js";
import { formatReport, safeReason, shortAddress } from "./notepad.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNotStarted(message) {
  return /not ?active|not ?started|hasn.t started|has not started|cant claim yet|can.t claim|sale is not|too soon|minting (is )?not|not ?open|not ?live/i.test(
    String(message || ""),
  );
}

const SPAM_WINDOW_MS = 120_000;
const sendLanes = new Map();

function sendOnLane(chainId, address, task) {
  const key = `${chainId}:${String(address).toLowerCase()}`;
  const previous = sendLanes.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  sendLanes.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

export function gasLabel(options) {
  if (options.gasX && Number(options.gasX) !== 1) {
    return `${options.gasGwei} gwei (${options.gasBase} x${options.gasX})`;
  }
  return `${options.gasGwei} gwei`;
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
  if (parsed.kind === "kalos") return loadKalosPage(parsed, fetchImpl);
  let html = "";
  try {
    html = await fetchText(parsed.href, fetchImpl);
  } catch (error) {
    if (!parsed.contract && !parsed.slug) throw error;
    html = "";
  }
  const extras = html ? await readScripts(html, parsed.href, fetchImpl) : [];
  const combined = [html, ...extras].join("\n");
  const schedule = await scheduleFromPage(parsed.href, combined, fetchImpl);
  const candidates = [];
  const push = (address, score, chain = null) => {
    const key = keepAddress(address);
    if (!key) return;
    const existing = candidates.find((item) => item.address.toLowerCase() === key.toLowerCase());
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.chain = existing.chain || chain;
      return;
    }
    candidates.push({ address: key, score, chain });
  };
  if (parsed.contract) push(parsed.contract, 200, parsed.chain);
  if (schedule) push(schedule.collection, 400, schedule.chain);
  for (const item of extractCandidates(combined)) push(item.address, item.score, null);
  for (const address of addressesNearSlug(combined, collectionSlug(parsed.href))) push(address, 500, null);
  const ranked = candidates.filter((item) => item.score >= 80);
  if (ranked.length) candidates.splice(0, candidates.length, ...ranked);
  const strong = candidates.some((item) => item.score >= 20);
  const unpublished = !strong && contractUnpublished(combined);
  if (unpublished) candidates.splice(0, candidates.length);
  return {
    parsed,
    html: combined,
    candidates,
    hints: [parsed.chain, schedule?.chain, ...chainHintsFromText(combined)].filter(Boolean),
    schedule,
    plan: mintPlanFromText(combined, parsed.href),
    unpublished,
  };
}

async function readScripts(html, pageUrl, fetchImpl) {
  const extras = [];
  const queue = [];
  const seen = new Set();
  const vendor = /\/(?:web3|motion|wagmi|viem|react-dom|vendor|polyfill|walletconnect)[-.]/i;
  const push = (link, first = false) => {
    if (!link || seen.has(link) || seen.size >= 16 || vendor.test(link)) return;
    seen.add(link);
    if (first) queue.unshift(link);
    else queue.push(link);
  };
  for (const link of linkedResources(html, pageUrl)) push(link);
  while (queue.length && extras.length < 10) {
    const link = queue.shift();
    let body = "";
    try {
      body = await fetchText(link, fetchImpl);
    } catch (error) {
      if (error?.message === "Dừng.") throw error;
      continue;
    }
    extras.push(body);
    const next = scriptChunks(body, link);
    for (const item of next) {
      if (/mint|drop|launch|nft|sale|claim|contract|config|collection/i.test(item)) push(item, true);
    }
    for (const item of next) push(item);
  }
  return extras;
}

async function attachCollection(page, apiKey, fetchImpl, log) {
  if (!page.parsed.slug || !apiKey || page.parsed.kind === "kalos") return page;
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
    if (error?.message === "Dừng.") throw error;
    log(error.message);
  }
  return page;
}

function providerCache(factory, shouldStop) {
  const items = [];
  return {
    get(chain, rpc) {
      const found = items.find((item) => item.chainId === chain.chainId);
      if (found) return found.provider;
      const provider = stoppable(factory({ ...chain, rpc: rpc || chain.rpc }), shouldStop);
      items.push({ chainId: chain.chainId, provider });
      return provider;
    },
    async destroy() {
      for (const item of items) await item.provider.destroy?.();
    },
  };
}

function raceStop(run, shouldStop) {
  if (!shouldStop) return run();
  let timer;
  const stop = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (shouldStop()) {
        clearInterval(timer);
        reject(new Error("Dừng."));
      }
    }, 40);
  });
  return Promise.race([run(), stop]).finally(() => clearInterval(timer));
}

function stoppable(provider, shouldStop) {
  if (!shouldStop || !provider || typeof provider !== "object") return provider;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args) => raceStop(() => value.apply(target, args), shouldStop);
    },
  });
}

async function findHits(page, options, providers) {
  const hits = [];
  const ranked = page.candidates.slice().sort((a, b) => b.score - a.score).slice(0, 8);
  for (const cand of ranked) {
    const kalosHit = page.kalos && cand.address.toLowerCase() === page.kalos.address.toLowerCase();
    const timedHit = page.schedule && cand.address.toLowerCase() === page.schedule.collection.toLowerCase();
    const chains = kalosHit
      ? [resolveNftChain("elysium")]
      : timedHit
        ? [resolveNftChain(page.schedule.chain || cand.chain || options.chain?.name || page.hints.find(Boolean) || "eth")]
        : chainChoices(options, cand, page);
    for (const chain of chains) {
      const pinned = kalosHit || timedHit;
      const rpc = pinned
        ? options.chain?.name === chain.name && options.rpc
          ? options.rpc
          : chain.rpc
        : options.rpc && options.chain?.name === chain.name
          ? options.rpc
          : chain.rpc;
      const provider = providers.get(chain, rpc);
      const identity = kalosHit
        ? { type: "kalos", seaDrops: [page.kalos.seaDrop], slug: page.kalos.slug, code: await provider.getCode(cand.address) }
        : timedHit
          ? { type: "timed", schedule: page.schedule, code: await provider.getCode(cand.address) }
          : (await planIdentity(provider, cand.address, page.plan)) || (await identifyContract(provider, cand.address));
      if (identity?.type === "phases") {
        identity.slug = collectionSlug(page.parsed?.href);
        identity.pageUrl = page.parsed?.href || "";
      }
      if (!identity || identity.code === "0x") continue;
      hits.push({ ...cand, chain, provider, identity });
      break;
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

function chainChoices(options, cand, page) {
  const list = [];
  const add = (chain) => {
    if (!chain || list.some((item) => item.name === chain.name)) return;
    list.push(chain);
  };
  if (options.chain) add(options.chain);
  if (cand.chain) {
    try {
      add(resolveNftChain(cand.chain));
    } catch {
      // chain ghi trên trang không hỗ trợ
    }
  }
  for (const hint of page.hints || []) {
    try {
      add(resolveNftChain(hint));
    } catch {
      // bỏ hint lạ
    }
  }
  if (!list.length) return probeOrder(page.hints);
  return list.slice(0, 3);
}

async function planIdentity(provider, address, plan) {
  if (!plan) return null;
  const code = await provider.getCode(address);
  if (!code || code === "0x") return null;
  const proxy = code.toLowerCase().includes("363d3d373d3d3d363d73");
  if (!proxy && !code.toLowerCase().includes(plan.selector.slice(2).toLowerCase())) return null;
  try {
    const raw = await provider.call({ to: address, data: plan.infoData });
    if (!raw || raw === "0x") return null;
    return { type: "plan", plan, code };
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return null;
  }
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
    if (context.wallet && round.start <= nowSec && typeof round.prepare !== "function") {
      const state = await callState(hit.provider, context.wallet, round);
      if (state !== "ok" && state !== "wait") {
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

async function syncClock(provider) {
  const sampledAt = Date.now();
  const block = await provider.getBlock("latest");
  const offset = Number(block.timestamp) * 1000 - sampledAt;
  const nowMs = () => Date.now() + offset;
  return {
    nowMs,
    nowSec: () => Math.floor(nowMs() / 1000),
  };
}

async function waitUntil(targetMs, clock, log, label, shouldStop, refresh) {
  let lastLog = 0;
  let refreshed = false;
  while (clock.nowMs() < targetMs) {
    if (shouldStop()) throw new Error("Dừng.");
    const remain = targetMs - clock.nowMs();
    if (!refreshed && refresh && remain < 15_000 && remain > 1_000) {
      refreshed = true;
      try {
        const next = await refresh();
        if (next) clock = next;
      } catch (error) {
        log(`Không đọc lại giờ chain: ${error.message || error}`);
      }
      continue;
    }
    if (Date.now() - lastLog > 15_000) {
      log(`Đang chờ tới giờ mint ${label}. Mở ${new Date(targetMs).toISOString()}. Còn ${Math.max(1, Math.ceil(remain / 1000))}s.`);
      lastLog = Date.now();
    }
    const slice = remain > 1_500 ? Math.min(remain - 1_500, 200) : Math.min(remain, 50);
    await sleep(Math.max(0, slice));
  }
  return clock;
}

function retryableSend(message) {
  return isNotStarted(message) || /timeout|timed out|econnreset|socket hang up|429|502|503|504|temporarily unavailable|missing response|failed to fetch|network error/i.test(String(message || ""));
}

async function spamMint({ wallet, provider, round, chain, gasGwei, gasLimit, nowMs, log, shouldStop }) {
  let active = round;
  if (typeof round.prepare === "function") active = await round.prepare();
  const tx = applyGas(active, chain, gasGwei, gasLimit);
  const openedAt = nowMs();
  let attempt = 0;
  let lastLog = 0;
  while (nowMs() - openedAt < SPAM_WINDOW_MS) {
    if (shouldStop()) throw new Error("Dừng.");
    attempt += 1;
    const state = await callState(provider, wallet.address, active);
    if (state === "wait") {
      if (Date.now() - lastLog > 1_000) {
        log(`Đang chờ tới giờ mint trên chain. Gửi lại liên tục, lần ${attempt}.`);
        lastLog = Date.now();
      }
      continue;
    }
    if (state !== "ok") throw new Error(state);
    let sent;
    try {
      sent = await sendOnLane(chain.chainId, wallet.address, async () => {
        const nonce = provider.getTransactionCount ? await provider.getTransactionCount(wallet.address, "pending") : undefined;
        return wallet.sendTransaction(nonce == null ? tx : { ...tx, nonce });
      });
    } catch (error) {
      const message = error.shortMessage || error.reason || error.message || "";
      if (!retryableSend(message)) throw error;
      continue;
    }
    log(`Đã gửi ${sent.hash} (lần ${attempt}).`);
    const receipt = await sent.wait();
    if (receipt?.status === 1) return { hash: sent.hash, tx, attempt };
    const after = await callState(provider, wallet.address, active);
    if (after !== "ok" && after !== "wait") throw new Error(after);
    log("Giao dịch revert, gửi lại.");
  }
  throw new Error("Hết 120s sau giờ mở mà chưa mint được.");
}

export async function runMint(options, deps = {}) {
  const log = deps.log || defaultLog;
  const fetchImpl = deps.fetch || fetch;
  let stopped = false;
  const halt = () => stopped || Boolean(deps.shouldStop?.());
  const fetchBound = (url, opts = {}) => {
    if (halt()) throw new Error("Dừng.");
    const signals = [AbortSignal.timeout(12_000)];
    if (deps.signal) signals.push(deps.signal);
    if (opts.signal) signals.push(opts.signal);
    return raceStop(() => fetchImpl(url, { ...opts, signal: AbortSignal.any(signals) }), halt);
  };
  const providers = providerCache(deps.providerFactory || ((chain) => new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true })), halt);
  if (deps.listen !== false) {
    process.once("SIGINT", () => {
      stopped = true;
    });
  }
  try {
    const page = await attachCollection(await loadPage(options.url, fetchBound), options.apiKey, fetchBound, log);
    if (page.kalos) {
      if (options.chain && options.chain.name !== "elysium") options.rpc = "";
      options.chain = resolveNftChain("elysium");
    }
    if (page.schedule?.chain) {
      if (options.chain && options.chain.name !== page.schedule.chain) options.rpc = "";
      options.chain = resolveNftChain(page.schedule.chain);
    }
    if (!page.candidates.length) {
      if (page.unpublished) {
        throw new Error("Trang mint chưa công bố contract. Web đang để địa chỉ trống. Khi họ gắn địa chỉ 0x lên trang, tool tự lấy, không cần sửa code cho từng web.");
      }
      throw new Error("Không thấy địa chỉ contract trên trang. Dán link có 0x, hoặc thêm OPENSEA_API_KEY với link collection OpenSea.");
    }
    log(
      `Mint | chain ${options.chain?.name || "tự nhận"} | số lượng ${options.quantity} | gas ${gasLabel(options)} | trần ${ethers.formatEther(options.maxPrice)} | ${options.dryRun ? "DRY RUN" : "MINT THẬT"}`,
    );
    const hits = await findHits(page, options, providers);
    if (!hits.length) throw new Error("Trang có địa chỉ nhưng không phải NFT mint (SeaDrop, thirdweb, hoặc mint public).");
    const contextBase = {
      wallet: options.wallet,
      allowInfo: collectAllowInfo(page.html, options.wallet),
      fetch: fetchBound,
      limits: {
        quantity: options.quantity,
        maxPrice: options.maxPrice,
        gasWei: ethers.parseUnits(String(options.gasGwei), "gwei") * BigInt(options.gasLimit),
        now: 0,
      },
    };
    let clock = await syncClock(hits[0].provider);
    contextBase.limits.now = clock.nowSec();
    let chosen = await chooseHit(hits, contextBase, clock.nowSec(), log);
    if (!chosen?.round) {
      if (chosen?.hit) log(`Contract ${chosen.hit.address} trên ${chosen.hit.chain.name}.`);
      printRounds(chosen?.rounds || [], hits[0].chain.nativeSymbol, log);
      for (const round of chosen?.rounds || []) log(`Bỏ ${round.label}: ${round.reason}.`);
      throw new Error("Không có round nào ví đủ điều kiện.");
    }
    clock = await syncClock(chosen.hit.provider);
    const symbol = chosen.hit.chain.nativeSymbol;
    log(`Contract ${chosen.hit.address} trên ${chosen.hit.chain.name} (${chosen.hit.identity.type}).`);
    printRounds(chosen.rounds, symbol, log);
    for (const round of chosen.rounds) {
      if (round.eligible && round.start * 1000 > clock.nowMs()) {
        log(`Ví đủ điều kiện ${round.label}. Đang chờ tới giờ mint ${round.label}. Mở ${new Date(round.start * 1000).toISOString()}.`);
      } else if (round.eligible) {
        log(`Ví đủ điều kiện ${round.label}. Mint round này khi tới lượt.`);
      } else {
        log(`Bỏ ${round.label}: ${round.reason}.`);
      }
    }
    const planned = eligibleRounds(chosen.rounds, clock.nowSec());
    const labels = planned.map((round) => round.label).join(", ");
    log(planned.length === 1 ? `Chọn round ${labels}.` : `Chọn ${planned.length} round: ${labels}.`);
    if (options.dryRun) {
      const tx = applyGas(planned[0], chosen.hit.chain, options.gasGwei, options.gasLimit);
      const quantity = planned.reduce((sum, round) => sum + round.quantity, 0);
      log(`DRY RUN: sẽ mint ${quantity} NFT trên ${planned.length} round, gas ${gasLabel(options)}.`);
      for (const round of planned) {
        const preview = applyGas(round, chosen.hit.chain, options.gasGwei, options.gasLimit);
        log(`DRY RUN round ${round.label}: ${round.quantity} NFT, value ${ethers.formatEther(preview.value)} ${symbol}.`);
        if (round.start * 1000 > clock.nowMs()) {
          log(`Đang chờ tới giờ mint ${round.label}. Mở ${new Date(round.start * 1000).toISOString()}. Tới giờ thì lệnh thật gửi liên tục đến khi mint được.`);
        }
      }
      return {
        round: planned[0],
        rounds: planned,
        tx,
        sent: false,
        chain: chosen.hit.chain.name,
        quantity,
        wallet: options.wallet,
      };
    }
    if (!options.signer) throw new Error("Đặt PRIVATE_KEY trong .env, hoặc giữ DRY_RUN=true.");
    const wallet = options.signer.connect(chosen.hit.provider);
    const minted = [];
    const problems = [];
    let pending = planned;
    while (pending.length) {
      const target = pending[0];
      pending = pending.slice(1);
      clock = await syncClock(chosen.hit.provider);
      contextBase.limits.now = clock.nowSec();
      const latest = await readRounds(chosen.hit.provider, chosen.hit.address, chosen.hit.identity, contextBase);
      const fresh = eligibleRounds(latest, clock.nowSec()).find((round) => round.id === target.id);
      if (!fresh) {
        log(`Bỏ round ${target.label}: không còn đủ điều kiện.`);
        continue;
      }
      if (fresh.start * 1000 > clock.nowMs()) {
        log(`Ví đủ điều kiện ${fresh.label}. Đang chờ tới giờ mint ${fresh.label}. Mở ${new Date(fresh.start * 1000).toISOString()}.`);
        clock = await waitUntil(fresh.start * 1000, clock, log, fresh.label, halt, () => syncClock(chosen.hit.provider));
      }
      try {
        const fired = await spamMint({
          wallet,
          provider: chosen.hit.provider,
          round: fresh,
          chain: chosen.hit.chain,
          gasGwei: options.gasGwei,
          gasLimit: options.gasLimit,
          nowMs: clock.nowMs,
          log,
          shouldStop: halt,
        });
        minted.push({ ...fired, quantity: fresh.quantity, round: fresh });
        log(`Mint thành công round ${fresh.label}: ${fresh.quantity} NFT.`);
      } catch (error) {
        const message = error.message || String(error);
        problems.push(`${fresh.label}: ${message}`);
        log(`Round ${fresh.label} thất bại: ${message}`);
      }
    }
    if (!minted.length) throw new Error(problems.join("; ") || "Không mint được round nào.");
    const quantity = minted.reduce((sum, item) => sum + item.quantity, 0);
    log(`Mint xong ${quantity} NFT trên ${minted.length} round.`);
    return {
      round: minted[0].round,
      rounds: minted.map((item) => item.round),
      tx: minted[0].tx,
      sent: true,
      hash: minted.map((item) => item.hash).join(","),
      chain: chosen.hit.chain.name,
      quantity,
      wallet: options.wallet,
      reason: problems.join("; "),
    };
  } finally {
    await providers.destroy();
  }
}

export async function runMintWallets(options, wallets, deps = {}) {
  const log = deps.log || defaultLog;
  const chainLabel = options.chain?.name || "tự nhận";
  log(`Bắt đầu mint | chain ${chainLabel} | ${wallets.length} ví | gas ${gasLabel(options)} | số lượng ${options.quantity}`);
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
          reason: result.reason || "",
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
    if (!chain.opensea) throw new Error(`OpenSea chưa có chain ${chain.name}. Mint trên chain này vẫn chạy.`);
    log(
      `Mua giá thấp | số lượng ${options.quantity} | gas ${gasLabel(options)} | trần ${ethers.formatEther(options.maxPrice)} ${chain.nativeSymbol} | ${options.dryRun ? "DRY RUN" : "MUA THẬT"}`,
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
