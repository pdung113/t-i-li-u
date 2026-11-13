import { amountFor } from "./limits.js";
import { chainById } from "./networks.js";
import { decideNotice } from "./notice.js";
import { armedText, resultText } from "./telegram.js";

const TICKER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const FRESH_MS = 3 * 60 * 1000;

export function listingIsFresh(listing, now, allowMissingTime = false) {
  if (!listing?.listedAt) return allowMissingTime;
  return now - listing.listedAt <= FRESH_MS;
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
  if (info.ok) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    ctx.state.bought[key] = { tx: info.tx, market: listing.market, at: ctx.now() };
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
  if (ctx.state.bought[key] || tickerOnCooldown(ctx.state, listing.ticker, ctx.now())) {
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
  let stopped = false;
  const running = new Set();
  const sessionDone = new Set();
  const clock = () => Date.now();

  function arm(listing, options = {}) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    if (memory.bought[key] || running.has(key) || sessionDone.has(key) || tickerOnCooldown(memory, listing.ticker, clock())) return;
    if (!listingIsFresh(listing, clock(), options.allowMissingTime)) {
      if (!sessionDone.has(`old:${key}`)) {
        sessionDone.add(`old:${key}`);
        log(`Bỏ ${listing.market}: thông báo đã quá 3 phút, không mua trên DEX.`);
      }
      return;
    }
    if (config.amounts && !(amountFor(listing.chain, config.amounts) > 0)) {
      sessionDone.add(key);
      log(`Bỏ ${listing.market}: chưa nhập số lượng cho ${listing.chain}.`);
      return;
    }
    if (!listing.contract) {
      if (!sessionDone.has(`wait:${key}`)) {
        sessionDone.add(`wait:${key}`);
        log(`${listing.market}: Upbit vừa báo listing KRW. Đang chờ contract trong thông báo rồi mua.`);
      }
      return;
    }
    running.add(key);
    const chain = chainById(listing.chain);
    const task = executeListing(listing, {
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
    log(`${listing.market}: mua ngay trên ${chain ? chain.id : "DEX"} ${listing.contract || ""}.`.trim());
    if (!memory.notified[key]) {
      memory.notified[key] = true;
      notify(armedText(listing, config));
    }
    task.then((result) => {
      if (result?.reason !== "stopped") sessionDone.add(key);
    }).finally(() => running.delete(key));
  }

  async function consider(raw, options = {}) {
    const receivedAt = raw?.receivedAt || Date.now();
    if (raw?.market && raw?.ticker && raw?.noticeId) {
      arm({ ...raw, receivedAt }, options);
      return;
    }
    let source = raw;
    const hasBody = Boolean(raw?.body || raw?.bd || raw?.announcement?.body);
    if (!hasBody && client.fetchNotice && (raw?.uuid || raw?.uid || raw?.url)) {
      const full = await client.fetchNotice(raw.uuid || raw.uid || raw.url);
      if (full?.title) source = { ...full, receivedAt, event_type: raw.event_type || raw.et || full.eventType };
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
    for (const listing of decision.listings) arm({ ...listing, receivedAt }, options);
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
    consider(message, { allowMissingTime: true }).catch((error) => log(`Lỗi xử lý thông báo: ${error.message}`));
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
