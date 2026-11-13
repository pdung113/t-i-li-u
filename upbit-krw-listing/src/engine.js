import { amountFor } from "./limits.js";
import { chainById } from "./networks.js";
import { decideNotice } from "./notice.js";
import { armedText, resultText } from "./telegram.js";

const TICKER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RETRY_WINDOW_MS = 20_000;
export const FRESH_MS = 3 * 60 * 1000;
export const CLOCK_SKEW_MS = 30_000;

export function listingIsFresh(listing, now) {
  if (!listing?.listedAt || !Number.isFinite(listing.listedAt)) return false;
  if (listing.listedAt > now + CLOCK_SKEW_MS) return false;
  return now - listing.listedAt <= FRESH_MS;
}

export function shouldBuyNow(listing, now, startedAt) {
  return listingIsFresh(listing, now) && listing.listedAt >= startedAt - CLOCK_SKEW_MS;
}

function contractKey(contract) {
  if (!contract) return "";
  return contract.startsWith("0x") || contract.startsWith("0X") ? contract.toLowerCase() : contract;
}

function sameContract(left, right) {
  return Boolean(contractKey(left)) && contractKey(left) === contractKey(right);
}

function contractSeen(state, contract) {
  return Object.values(state?.bought || {}).some((row) => sameContract(row?.contract, contract));
}

function contractFits(chain, contract) {
  if (!chain || !contract) return false;
  if (chain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contract);
  return /^0x[a-fA-F0-9]{40}$/.test(contract);
}

function retryable(result) {
  return /Không thấy pool|timeout|ETIMEDOUT|ECONN|fetch failed|socket|network|HTTP|Không đọc được thanh khoản/i.test(result?.reason || "");
}

function emptyState() {
  return { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] };
}

export function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    bought: state.bought || {},
    tickerBoughtAt: state.tickerBoughtAt || {},
    notified: state.notified || {},
    armed: Array.isArray(state.armed) ? state.armed : [],
  };
}

function tickerOnCooldown(state, ticker, now) {
  const at = state.tickerBoughtAt[ticker];
  return Number.isFinite(at) && now - at < TICKER_COOLDOWN_MS;
}

function finish(ctx, listing, info) {
  const chain = chainById(listing.chain);
  const payload = {
    ...info,
    market: listing.market,
    chain: listing.chain,
    contract: listing.contract,
    url: listing.url,
    gasMultiple: ctx.gasMultiple,
    slippagePercent: ctx.slippagePercent,
    amount: ctx.amounts ? amountFor(listing.chain, ctx.amounts) : info.amount,
    symbol: chain?.symbol || "",
  };
  if (info.ok || info.tx) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    ctx.state.bought[key] = { tx: info.tx || "", market: listing.market, contract: listing.contract, at: ctx.now() };
    ctx.state.tickerBoughtAt[listing.ticker] = ctx.now();
    ctx.save?.();
  }
  const text = resultText(payload);
  ctx.notify?.(text);
  ctx.log?.(text.replaceAll("\n", " | "));
  return payload;
}

export async function executeListing(listing, ctx) {
  if (ctx.stopped()) return { ok: false, reason: "stopped" };
  const key = `${listing.noticeId}:${listing.ticker}`;
  if (ctx.state.bought[key] || tickerOnCooldown(ctx.state, listing.ticker, ctx.now()) || contractSeen(ctx.state, listing.contract)) {
    return { ok: false, reason: "đã mua", skipped: true };
  }
  if (ctx.amounts && !(amountFor(listing.chain, ctx.amounts) > 0)) {
    return finish(ctx, listing, { ok: false, reason: `Chưa nhập số lượng cho ${listing.chain}.` });
  }
  const chain = chainById(listing.chain);
  if (!listing.contract || !chain) {
    return finish(ctx, listing, {
      ok: false,
      reason: !listing.contract ? "Thông báo không có địa chỉ contract." : `Chưa hỗ trợ DEX trên mạng ${listing.chain || "này"}.`,
    });
  }
  if (!ctx.live) {
    return finish(ctx, listing, {
      ok: false,
      dry: true,
      venue: chain.kind === "solana" ? "Jupiter" : "DEX",
      reason: "Chế độ xem thử.",
    });
  }
  try {
    const result = await ctx.swap(listing);
    return finish(ctx, listing, result);
  } catch (error) {
    return finish(ctx, listing, { ok: false, reason: error.message || "Không gửi được giao dịch." });
  }
}

export function startEngine({ client, config, log, notify, state }) {
  const memory = normalizeState(state);
  const startedAt = Date.now();
  let stopped = false;
  const running = new Set();
  const sessionDone = new Set();
  const inflightTickers = new Set();
  const inflightContracts = new Set();
  const clock = () => Date.now();

  function arm(listing) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    const token = contractKey(listing.contract);
    if (memory.bought[key] || running.has(key) || sessionDone.has(key) || tickerOnCooldown(memory, listing.ticker, clock())) return;
    if (contractSeen(memory, listing.contract) || (token && inflightContracts.has(token))) {
      sessionDone.add(key);
      log(`Bỏ ${listing.market}: contract này đã có lệnh mua.`);
      return;
    }
    if (!shouldBuyNow(listing, clock(), startedAt)) {
      if (!sessionDone.has(`old:${key}`)) {
        sessionDone.add(`old:${key}`);
        const why = !listing.listedAt
          ? "không có giờ đăng"
          : listing.listedAt < startedAt - CLOCK_SKEW_MS
            ? "tin đã có trước khi tool chạy"
            : "thông báo đã quá 3 phút";
        log(`Bỏ ${listing.market}: ${why}, không mua.`);
      }
      return;
    }
    if (!contractFits(listing.chain, listing.contract)) {
      if (!sessionDone.has(`wait:${key}`)) {
        sessionDone.add(`wait:${key}`);
        log(`${listing.market}: Upbit vừa báo listing KRW. Đang chờ đúng mạng và contract rồi mua.`);
      }
      return;
    }
    if (config.amounts && !(amountFor(listing.chain, config.amounts) > 0)) {
      sessionDone.add(key);
      log(`Bỏ ${listing.market}: chưa nhập số lượng cho ${listing.chain}.`);
      return;
    }
    if (inflightTickers.has(listing.ticker)) return;
    running.add(key);
    inflightTickers.add(listing.ticker);
    inflightContracts.add(token);
    const chain = chainById(listing.chain);
    log(`${listing.market}: mua ngay trên ${chain ? chain.id : "DEX"} ${listing.contract}.`);
    if (!memory.notified[key]) {
      memory.notified[key] = true;
      try {
        notify(armedText(listing, config));
      } catch {
        // Báo Telegram không được phép chặn lệnh mua.
      }
    }
    runBuy(listing, 1).catch((error) => {
      running.delete(key);
      inflightTickers.delete(listing.ticker);
      inflightContracts.delete(token);
      log(`Lỗi mua ${listing.market}: ${error.message}`);
    });
  }

  async function runBuy(listing, attempt) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    const token = contractKey(listing.contract);
    const result = await executeListing(listing, {
      live: config.live,
      gasMultiple: config.gasMultiple,
      slippagePercent: config.slippagePercent,
      amounts: config.amounts,
      state: memory,
      now: clock,
      stopped: () => stopped,
      swap: (item) => config.swap(item),
      log,
      notify,
      save: () => config.saveState?.(memory),
    });
    const age = clock() - listing.listedAt;
    if (!stopped && attempt < 3 && age >= 0 && age < RETRY_WINDOW_MS && retryable(result)) {
      log(`${listing.market}: ${result.reason} Thử lại ngay vì tin vẫn còn mới.`);
      await sleep(400);
      if (!stopped) return runBuy(listing, attempt + 1);
    }
    if (result?.reason !== "stopped") sessionDone.add(key);
    running.delete(key);
    inflightTickers.delete(listing.ticker);
    inflightContracts.delete(token);
  }

  async function consider(raw) {
    const receivedAt = raw?.receivedAt || Date.now();
    if (raw?.market && raw?.ticker && raw?.noticeId) {
      arm({ ...raw, receivedAt });
      return;
    }
    let source = raw;
    const hasBody = Boolean(raw?.body || raw?.bd || raw?.announcement?.body);
    if (!hasBody && client.fetchNotice && (raw?.uuid || raw?.uid || raw?.url)) {
      try {
        const full = await client.fetchNotice(raw.uuid || raw.uid || raw.url);
        if (full?.title) source = { ...full, receivedAt, event_type: raw.event_type || raw.et || full.eventType };
      } catch {
        // Tin chưa tải được thì đọc phần đang có, không chặn tin kế tiếp.
      }
    }
    const decision = decideNotice(source);
    if (decision.action !== "buy") {
      if (decision.reason === "no-krw" && decision.tickers?.length) {
        const skipKey = decision.tickers.join(",");
        if (!sessionDone.has(`skip:${skipKey}`)) {
          sessionDone.add(`skip:${skipKey}`);
          log(`Bỏ ${skipKey}: listing mới nhưng không có cặp KRW.`);
        }
      }
      return;
    }
    for (const listing of decision.listings) arm({ ...listing, receivedAt });
  }

  async function noticeLoop() {
    let backoff = 2000;
    let warned = false;
    while (!stopped) {
      try {
        const notices = await client.listNotices();
        if (warned) log("Đã đọc lại được danh sách thông báo.");
        warned = false;
        backoff = 15_000;
        for (const notice of notices) {
          const full = notice.body || !notice.id ? notice : (await client.fetchNotice(notice.id)) || notice;
          await consider(full.title ? { ...notice, ...full, title: full.title || notice.title } : notice);
        }
      } catch (error) {
        backoff = error.status === 403 ? 30_000 : 5000;
        if (!warned) {
          log("Chưa đọc được danh sách web. Tool vẫn tự nghe thông báo mới từ Upbit.");
          warned = true;
        }
      }
      await sleep(backoff);
    }
  }

  const waits = new Map();

  function sleep(ms) {
    return new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        waits.delete(timer);
        resolve();
      }, ms);
      waits.set(timer, resolve);
    });
  }

  for (const listing of memory.armed) {
    consider(listing).catch((error) => log(`Lỗi xử lý thông báo: ${error.message}`));
  }

  const stopSocket = client.listenAnnouncements((message) => {
    consider(message).catch((error) => log(`Lỗi xử lý thông báo: ${error.message}`));
  }, {
    onStatus: (status) => {
      if (status === "connected") log("Đã nối kênh thông báo Upbit. Listing KRW mới sẽ tự vào, không cần dán link.");
      if (status === "closed") log("Kênh thông báo Upbit ngắt, đang nối lại.");
      if (String(status).startsWith("error")) log(`WebSocket thông báo: ${status}.`);
    },
  });

  noticeLoop();

  return {
    stop() {
      stopped = true;
      for (const [timer, resolve] of waits) {
        clearTimeout(timer);
        resolve();
      }
      waits.clear();
      stopSocket();
    },
  };
}

export { emptyState };
