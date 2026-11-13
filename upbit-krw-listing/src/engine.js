import crypto from "node:crypto";
import { decideNotice, formatKst } from "./notice.js";
import { UPBIT_KRW_FEE } from "./price.js";
import { buildOrder, correctOrder, explainError } from "./order.js";
import { armedText, resultText } from "./telegram.js";

const TICKER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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

export async function executeListing(listing, ctx) {
  const key = `${listing.noticeId}:${listing.ticker}`;
  let notBefore = listing.openAt == null ? null : listing.openAt + listing.buyBanMs;
  let fee = UPBIT_KRW_FEE;
  let prepared = false;
  let volumeDecimals = 8;
  const working = { ...listing, identifier: listing.identifier || crypto.randomUUID() };

  const prepare = async () => {
    if (prepared) return null;
    prepared = true;
    fee = await prepareFee(ctx, working, fee);
    if (!(working.refPrice > 0)) working.refPrice = await ctx.bestAsk?.(working.market);
    if (ctx.live && ctx.krwBalance) {
      try {
        const balance = await ctx.krwBalance();
        if (balance != null && balance < ctx.budgetKrw) {
          return `Không đủ KRW. Có ${balance}, cần ${ctx.budgetKrw}.`;
        }
      } catch (error) {
        ctx.log?.(`Không đọc được số dư: ${error.message}`);
      }
    }
    return null;
  };

  while (!ctx.stopped()) {
    const now = ctx.now();
    if (ctx.deadline != null && now > ctx.deadline) {
      return { ok: false, reason: "stopped" };
    }
    if (notBefore == null) {
      if (ctx.hasMarket(working.market)) {
        notBefore = now + working.buyBanMs;
        ctx.log?.(`${working.market} đã có trên sàn. Mua lúc ${formatKst(notBefore)}.`);
        continue;
      }
      if (working.listedAt && now > working.listedAt + 6 * 60 * 60 * 1000) {
        return finish(ctx, working, { ok: false, reason: "Hết thời gian chờ cặp KRW mở." });
      }
      await ctx.sleep(300);
      continue;
    }

    if (now + 3000 < notBefore) {
      if (!prepared && now + 5000 >= notBefore) {
        const blocked = await prepare();
        if (blocked) return finish(ctx, working, { ok: false, reason: blocked, when: notBefore });
      }
      await ctx.sleep(Math.min(notBefore - 3000 - now, 30_000));
      continue;
    }

    const blocked = await prepare();
    if (blocked) return finish(ctx, working, { ok: false, reason: blocked, when: notBefore });
    if (ctx.now() < notBefore) {
      await ctx.sleep(notBefore - ctx.now());
      continue;
    }

    const giveUp = notBefore + 120_000;
    let attempts = 0;
    let params = null;
    let lastReason = "Hết cửa đặt lệnh.";
    while (!ctx.stopped() && ctx.now() <= giveUp && attempts < 100) {
      if (ctx.deadline != null && ctx.now() > ctx.deadline) return { ok: false, reason: "stopped" };
      const built = buildOrder(working, {
        budgetKrw: ctx.budgetKrw,
        multiple: ctx.multiple,
        fee,
        atMs: ctx.now(),
        volumeDecimals,
      });
      if (built.error) {
        lastReason = built.error;
        await ctx.sleep(1000);
        if (!(working.refPrice > 0)) working.refPrice = await ctx.bestAsk?.(working.market);
        attempts += 1;
        continue;
      }
      params = built.params;
      if (!ctx.live) {
        return finish(ctx, working, {
          ok: false,
          dry: true,
          kind: built.kind,
          price: params.price,
          volume: params.volume,
          when: notBefore,
          reason: "Chế độ xem thử.",
        });
      }
      attempts += 1;
      const result = await ctx.place(params);
      if (result.ok) {
        return finish(ctx, working, {
          ok: true,
          kind: built.kind,
          price: params.price,
          volume: params.volume,
          orderUuid: result.order.uuid,
          when: notBefore,
        });
      }
      if (result.duplicateIdentifier && ctx.lookup) {
        const existing = await ctx.lookup(params.identifier);
        if (existing?.uuid) {
          return finish(ctx, working, {
            ok: true,
            kind: built.kind,
            price: params.price,
            volume: params.volume,
            orderUuid: existing.uuid,
            when: notBefore,
          });
        }
      }
      lastReason = explainError(result.name, result.message);
      if (result.fatal) {
        return finish(ctx, working, {
          ok: false,
          kind: built.kind,
          price: params.price,
          volume: params.volume,
          when: notBefore,
          reason: lastReason,
        });
      }
      if (result.correctable && attempts <= 3) {
        const next = correctOrder(params, result.correctable);
        if (result.correctable === "price") working.refPrice = Number(next.price) / ctx.multiple;
        if (result.correctable === "volume") volumeDecimals = 4;
        ctx.log?.(`${working.market}: chỉnh lệnh sau lỗi ${result.name}.`);
        continue;
      }
      ctx.log?.(`${working.market}: chưa mua được, thử lại. ${lastReason}`);
      await ctx.sleep(1000);
    }
    return finish(ctx, working, {
      ok: false,
      kind: params?.ord_type === "limit" ? "limit" : params ? "market" : undefined,
      price: params?.price,
      volume: params?.volume,
      when: notBefore,
      reason: lastReason,
    });
  }
  return { ok: false, reason: "stopped" };
}

async function prepareFee(ctx, listing, fee) {
  if (!ctx.chance) return fee;
  try {
    const info = await ctx.chance(listing.market);
    if (info?.fee != null && info.fee >= 0 && info.fee < 0.05) return info.fee;
  } catch {
    // Phí mặc định 0,05% vẫn đặt được lệnh.
  }
  return fee;
}

function finish(ctx, listing, info) {
  const payload = { ...info, market: listing.market, url: listing.url };
  if (info.ok) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    ctx.state.bought[key] = {
      uuid: info.orderUuid,
      identifier: listing.identifier,
      market: listing.market,
      at: ctx.now(),
    };
    ctx.state.tickerBoughtAt[listing.ticker] = ctx.now();
    ctx.state.armed = ctx.state.armed.filter((item) => `${item.noticeId}:${item.ticker}` !== key);
    ctx.save?.();
  }
  ctx.notify?.(resultText(payload));
  ctx.log?.(resultText(payload).replaceAll("\n", " | "));
  return payload;
}

export function startEngine({ client, config, log, notify, state, now, sleep }) {
  const memory = normalizeState(state);
  let stopped = false;
  let offset = 0;
  let markets = new Set();
  const running = new Set();
  const sessionDone = new Set();
  const stoppers = [];
  const clock = () => (now ? now() : Date.now() + offset);
  const wait = (ms) => {
    if (sleep) return sleep(ms);
    return new Promise((resolve) => {
      let wake;
      const timer = setTimeout(() => {
        const index = stoppers.indexOf(wake);
        if (index >= 0) stoppers.splice(index, 1);
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
      stoppers.push(wake);
    });
  };

  function stoppedNow() {
    return stopped;
  }

  function arm(listing) {
    const key = `${listing.noticeId}:${listing.ticker}`;
    if (memory.bought[key] || running.has(key) || sessionDone.has(key) || tickerOnCooldown(memory, listing.ticker, clock())) {
      return;
    }
    const notBefore = listing.openAt == null ? null : listing.openAt + listing.buyBanMs;
    if (notBefore != null && clock() > notBefore + 120_000) {
      log(`Bỏ ${listing.market}: đã qua giờ mua (${formatKst(notBefore)}).`);
      return;
    }
    running.add(key);
    memory.armed = memory.armed.filter((item) => `${item.noticeId}:${item.ticker}` !== key);
    memory.armed.push(listing);
    config.saveState?.(memory);
    const previewAt = notBefore ?? clock();
    const preview = buildOrder(
      { ...listing, identifier: listing.identifier || "preview" },
      { budgetKrw: config.budgetKrw, multiple: config.multiple, atMs: previewAt },
    );
    const when = notBefore == null ? "khi cặp mở" : formatKst(notBefore);
    log(`${listing.market}: canh mua lúc ${when}${listing.assumedRules ? " (chưa có nội dung thông báo, tạm tính cấm mua 5 phút và chỉ lệnh giới hạn 2 giờ)" : ""}.`);
    if (!memory.notified[key]) {
      memory.notified[key] = true;
      config.saveState?.(memory);
      notify(armedText(listing, preview.error ? null : preview));
    }
    executeListing(listing, {
      budgetKrw: config.budgetKrw,
      multiple: config.multiple,
      live: config.live,
      state: memory,
      now: clock,
      sleep: wait,
      stopped: stoppedNow,
      hasMarket: (market) => markets.has(market),
      place: (params) => client.place(params),
      lookup: (identifier) => client.lookup(identifier),
      chance: (market) => client.chance(market),
      bestAsk: (market) => client.bestAsk(market),
      krwBalance: () => client.krwBalance(),
      log,
      notify,
      save: () => config.saveState?.(memory),
    }).then((result) => {
      if (result?.reason !== "stopped") sessionDone.add(key);
    }).finally(() => running.delete(key));
  }

  async function consider(raw) {
    if (raw?.market && raw?.ticker && raw?.noticeId) {
      arm(raw);
      return;
    }
    const decision = decideNotice(raw);
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
    for (const listing of decision.listings) arm(listing);
  }

  async function marketLoop() {
    while (!stopped) {
      try {
        markets = new Set(await client.markets());
      } catch (error) {
        log(`Không đọc được danh sách cặp: ${error.message}`);
      }
      const urgent = memory.armed.some((listing) => {
        const at = listing.openAt == null ? 0 : listing.openAt + listing.buyBanMs;
        return listing.openAt == null || Math.abs(clock() - at) < 120_000;
      });
      await wait(urgent ? 300 : 5000);
    }
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
        for (const notice of notices) await consider(await hydrate(notice));
      } catch (error) {
        backoff = error.status === 403 ? 30_000 : 5000;
        if (!warned) {
          log("Chưa đọc được danh sách thông báo web. Vẫn nhận tin mới qua WebSocket.");
          warned = true;
        }
      }
      await wait(backoff);
    }
  }

  async function hydrate(notice) {
    if (notice.body || !notice.id || !/신규/.test(notice.title)) return notice;
    const full = await client.fetchNotice(notice.id);
    if (!full?.body) return notice;
    return { ...notice, ...full, title: full.title || notice.title, url: full.url || notice.url };
  }

  async function clockLoop() {
    while (!stopped) {
      try {
        offset = await client.clockOffset();
      } catch {
        // Giữ mốc đồng hồ cũ.
      }
      await wait(5 * 60 * 1000);
    }
  }

  const stopSocket = client.listenAnnouncements((message) => {
    consider(message).catch((error) => log(`Lỗi xử lý thông báo: ${error.message}`));
  }, {
    onStatus: (status) => {
      if (status === "connected") log("Đã nối WebSocket thông báo Upbit.");
      if (status === "closed") log("WebSocket thông báo ngắt, đang nối lại.");
      if (status.startsWith("error")) log(`WebSocket thông báo: ${status}.`);
    },
  });

  marketLoop();
  noticeLoop();
  clockLoop();
  for (const listing of memory.armed) consider(listing);

  return {
    stop() {
      stopped = true;
      stopSocket();
      for (const wake of [...stoppers]) wake();
      stoppers.length = 0;
    },
  };
}

export { emptyState };
