import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortDeals } from "./src/deals.js";
import { createRadar } from "./src/radar.js";
import { loadShopee } from "./src/shopee.js";
import { TIKTOK_SEARCH_URL, loadTikTok } from "./src/tiktok.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT) || 8787;
const pollMs = Number(process.env.POLL_MS) || 15_000;

const radar = createRadar();
const clients = new Set();
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
  deals: [],
  alerts: [],
  tiktok,
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
    tiktok: {
      ok: tiktok.ok,
      message: tiktok.message,
      openUrl: tiktok.openUrl,
      checkedAt: tiktok.checkedAt,
      count: tiktok.deals?.length || 0,
    },
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
      try {
        const shopee = await loadShopee();
        const deals = sortDeals([...shopee.deals, ...(tiktok.deals || [])], "discount");
        const alerts = radar.take(deals);
        state = {
          ...state,
          ready: true,
          updatedAt: Date.now(),
          watched: shopee.watched,
          error: "",
          sessions: shopee.sessions,
          deals,
          alerts,
        };
        publish(alerts);
      } catch (error) {
        state.error = error.message || "Không đọc được Shopee";
        state.updatedAt = Date.now();
        publish([]);
      }
    } while (pollAgain);
  } finally {
    polling = false;
  }
}

async function pollTikTok() {
  tiktok = { ...(await loadTikTok()), checkedAt: Date.now() };
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

const server = http.createServer((req, res) => {
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
  const file = readPublic(url.pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Không thấy trang");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

export function start() {
  poll();
  pollTikTok().then(() => poll());
  const timer = setInterval(poll, pollMs);
  const tiktokTimer = setInterval(() => {
    pollTikTok().then(() => poll());
  }, 60_000);
  timer.unref?.();
  tiktokTimer.unref?.();
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
