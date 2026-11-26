import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortDeals } from "./src/deals.js";
import { createRadar } from "./src/radar.js";
import { loadShopee } from "./src/shopee.js";
import { TIKTOK_SEARCH_URL, acceptPhoneDeals, loadTikTok, preferPhoneCatalog } from "./src/tiktok.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT) || 8787;
const pollMs = Number(process.env.POLL_MS) || 15_000;

const radar = createRadar();
const clients = new Set();
const phoneKey = crypto.randomBytes(16).toString("hex");
let phoneCatalog = null;
let tiktok = {
  ok: false,
  deals: [],
  message: "Đang thử TikTok Shop…",
  openUrl: TIKTOK_SEARCH_URL,
  checkedAt: 0,
};
let state = {
  ready: false,
  updatedAt: 0,
  now: Date.now(),
  pollMs,
  watched: "Đang quét Shopee…",
  error: "",
  sessions: [],
  scanned: 0,
  deepest: 0,
  shopeeDeals: [],
  shopeeCheap: [],
  shopeeHalf: [],
  shopeeLow: [],
  shopeeShelf: [],
  deals: [],
  alerts: [],
};

function snapshot() {
  return {
    ready: state.ready,
    updatedAt: state.updatedAt,
    now: Date.now(),
    pollMs,
    watched: state.watched,
    error: state.error,
    sessions: state.sessions,
    deals: state.deals,
    alerts: state.alerts,
    shopee: {
      watched: state.watched,
      scanned: state.scanned,
      deepest: state.deepest,
      deals: state.shopeeDeals,
      cheap: state.shopeeCheap || [],
      half: state.shopeeHalf || [],
      low: state.shopeeLow || [],
      shelf: state.shopeeShelf,
    },
    tiktok: {
      ok: tiktok.ok,
      message: tiktok.message,
      openUrl: tiktok.openUrl,
      checkedAt: tiktok.checkedAt,
      scanned: tiktok.scanned || 0,
      deepest: tiktok.deepest || 0,
      region: tiktok.region || "",
      source: tiktok.source || "",
      count: tiktok.deals?.length || 0,
      deals: tiktok.deals || [],
      shelf: tiktok.shelf || [],
    },
    phoneKey,
  };
}

function publish(alerts = []) {
  state.alerts = alerts.map((deal) => ({
    id: deal.id,
    name: deal.name,
    priceText: deal.priceText,
    discount: deal.discount,
    oneDong: deal.oneDong,
    url: deal.url,
  }));
  const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

let polling = false;
let pollAgain = false;

async function poll() {
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  try {
    do {
      pollAgain = false;
      const [shopeeResult, tiktokResult] = await Promise.allSettled([loadShopee(), loadTikTok()]);
      if (tiktokResult.status === "fulfilled") {
        const next = preferPhoneCatalog({ ...tiktokResult.value, checkedAt: Date.now() }, phoneCatalog);
        if (next.region !== tiktok.region || (next.scanned || 0) !== (tiktok.scanned || 0)) {
          console.log(`TikTok: vùng ${next.region || "không rõ"} · ${next.scanned || 0} món`);
        }
        tiktok = next;
      }
      if (shopeeResult.status === "fulfilled") {
        const shopee = shopeeResult.value;
        const shopeeDeals = sortDeals(shopee.deals || [], "discount");
        const shopeeCheap = shopee.cheap || [];
        const shopeeHalf = shopee.half || [];
        const shopeeLow = shopee.low || [];
        const tiktokDeals = sortDeals(tiktok.deals || [], "discount");
        const shopeeHot = shopeeHalf.filter((deal) => deal.oneDong || deal.discount >= 70);
        const deals = [...shopeeDeals, ...shopeeLow, ...shopeeHot, ...tiktokDeals];
        const alerts = radar.take(deals);
        state = {
          ...state,
          ready: true,
          updatedAt: Date.now(),
          watched: shopee.watched,
          error: "",
          sessions: shopee.sessions,
          scanned: shopee.scanned || 0,
          deepest: shopee.deepest || 0,
          shopeeDeals,
          shopeeCheap,
          shopeeHalf,
          shopeeLow,
          shopeeShelf: shopee.shelf || [],
          deals,
          alerts,
        };
        publish(alerts);
      } else {
        state.error = shopeeResult.reason?.message || "Không đọc được Shopee";
        state.updatedAt = Date.now();
        publish([]);
      }
    } while (pollAgain);
  } finally {
    polling = false;
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readPublic(urlPath) {
  const requested = decodeURIComponent(urlPath.split("?")[0]);
  const rel = requested === "/" ? "/index.html" : requested;
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, "index.html")) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function applyPhoneDeals(raw) {
  const accepted = acceptPhoneDeals(raw);
  if (!accepted.scanned) return accepted;
  phoneCatalog = { ...accepted, checkedAt: Date.now() };
  tiktok = phoneCatalog;
  const tiktokDeals = sortDeals(tiktok.deals || [], "discount");
  const shopeeHot = (state.shopeeHalf || []).filter((deal) => deal.oneDong || deal.discount >= 70);
  const deals = [...state.shopeeDeals, ...(state.shopeeLow || []), ...shopeeHot, ...tiktokDeals];
  const alerts = radar.take(deals);
  state = { ...state, ready: true, updatedAt: Date.now(), deals, alerts };
  publish(alerts);
  return accepted;
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/state") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/api/phone-deals" && req.method === "POST") {
    if (req.headers["x-sale-key"] !== phoneKey) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end('{"ok":false}');
      return;
    }
    try {
      const accepted = applyPhoneDeals(await readBody(req));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: accepted.ok, scanned: accepted.scanned }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end('{"ok":false}');
    }
    return;
  }
  if (url.pathname === "/phone-scan.js") {
    const source = fs.readFileSync(path.join(root, "src/page-deals.js"), "utf8").replace(/^export /gm, "");
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(source);
    return;
  }
  const file = readPublic(url.pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Không thấy trang");
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

export function start() {
  poll();
  const timer = setInterval(poll, pollMs);
  timer.unref?.();
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().then(() => {
    console.log(`Săn sale: http://127.0.0.1:${port}`);
  });
}
