import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./client.js";
import { normalizeState, startEngine } from "./engine.js";
import { decideNotice } from "./notice.js";
import { explainError } from "./order.js";
import { MIN_KRW_ORDER } from "./price.js";
import { discoverChatId, sendTelegram } from "./telegram.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, "..");
const envPath = path.join(dir, ".env");
const statePath = path.join(dir, "data", "state.json");
const htmlPath = path.join(root, "public", "index.html");

const lines = [];
let engine = null;
let krwBalance = null;
let current = null;
let telegramWarned = false;

function log(message) {
  const line = `${new Date().toISOString()}  ${message}`;
  lines.push(line);
  if (lines.length > 200) lines.shift();
  console.log(line);
}

function loadEnvFile(file = envPath) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, index).trim()] = value;
  }
  return out;
}

function readState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch {
    return normalizeState(null);
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function writeEnv(config) {
  const text = [
    `UPBIT_ACCESS_KEY=${config.accessKey}`,
    `UPBIT_SECRET_KEY=${config.secretKey}`,
    `BUY_KRW=${config.budgetKrw}`,
    `PRICE_MULTIPLE=${config.multiple}`,
    `TELEGRAM_BOT_TOKEN=${config.telegramToken}`,
    `TELEGRAM_CHAT_ID=${config.telegramChatId}`,
    `LIVE=${config.live ? "true" : "false"}`,
    `NOTICE_URL=${config.noticeUrl || ""}`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, text, { mode: 0o600 });
}

function configFromEnv(env) {
  return {
    accessKey: env.UPBIT_ACCESS_KEY || "",
    secretKey: env.UPBIT_SECRET_KEY || "",
    budgetKrw: Number(env.BUY_KRW || 0),
    multiple: Number(env.PRICE_MULTIPLE || 2),
    telegramToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
    live: env.LIVE === "true",
    noticeUrl: env.NOTICE_URL || "",
  };
}

function validate(config) {
  if (!config.accessKey || !config.secretKey) throw new Error("Cần Access Key và Secret Key của Upbit Open API.");
  if (!Number.isFinite(config.budgetKrw) || config.budgetKrw < MIN_KRW_ORDER) {
    throw new Error(`Số KRW mỗi coin phải từ ${MIN_KRW_ORDER}.`);
  }
  if (!Number.isFinite(config.multiple) || config.multiple < 1 || config.multiple > 10) {
    throw new Error("Hệ số giá phải từ 1 đến 10. Nhập 2 nếu muốn giá trần gấp đôi.");
  }
}

async function notify(text) {
  if (!current?.telegramToken || !current?.telegramChatId) {
    if (!telegramWarned) {
      telegramWarned = true;
      log("Chưa có token hoặc chat id Telegram. Kết quả chỉ hiện ở màn hình này.");
    }
    return;
  }
  try {
    const result = await sendTelegram(current.telegramToken, current.telegramChatId, text);
    if (!result.ok) log(`Telegram không gửi được: ${result.description || "lỗi không rõ"}`);
  } catch (error) {
    log(`Telegram không gửi được: ${error.message}`);
  }
}

async function start(config) {
  if (engine) throw new Error("Tool đang chạy.");
  validate(config);
  const client = createClient({ accessKey: config.accessKey, secretKey: config.secretKey });
  try {
    krwBalance = await client.krwBalance();
  } catch (error) {
    throw new Error(error.code ? explainError(error.code, "") : error.message);
  }
  writeEnv(config);
  current = config;
  telegramWarned = false;
  log(`Đã xác thực API. KRW khả dụng: ${krwBalance}. Mỗi listing dùng ${config.budgetKrw} KRW, hệ số giá x${config.multiple}.`);
  log(config.live ? "Đang gửi lệnh thật." : "Chế độ xem thử: không gửi lệnh.");
  const state = readState();
  if (config.noticeUrl) {
    const notice = await client.fetchNotice(config.noticeUrl);
    if (!notice?.title) {
      log("Không tải được link thông báo. Tin mới vẫn vào qua WebSocket.");
    } else {
      const decision = decideNotice(notice);
      if (decision.action !== "buy") log(`Link đã dán không phải listing KRW mới (${decision.reason}).`);
      else {
        for (const listing of decision.listings) {
          state.armed = state.armed.filter((item) => `${item.noticeId}:${item.ticker}` !== `${listing.noticeId}:${listing.ticker}`);
          state.armed.push(listing);
        }
        log(`Đã nạp thông báo ${decision.listings.map((item) => item.market).join(", ")}.`);
      }
    }
  }
  engine = startEngine({
    client,
    config: { ...config, saveState },
    log,
    notify,
    state,
  });
}

function stop() {
  engine?.stop();
  engine = null;
  log("Đã dừng.");
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32_000) {
        reject(new Error("Dữ liệu quá lớn."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSON không hợp lệ."));
      }
    });
    req.on("error", reject);
  });
}

function formConfig(body) {
  return {
    accessKey: String(body.accessKey || "").trim(),
    secretKey: String(body.secretKey || "").trim(),
    budgetKrw: Number(body.budgetKrw),
    multiple: Number(body.multiple),
    telegramToken: String(body.telegramToken || "").trim(),
    telegramChatId: String(body.telegramChatId || "").trim(),
    live: body.live === true,
    noticeUrl: String(body.noticeUrl || "").trim(),
  };
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, fs.readFileSync(htmlPath), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        const env = configFromEnv(loadEnvFile());
        send(res, 200, {
          running: Boolean(engine),
          krw: krwBalance,
          lines,
          live: current?.live === true,
          budgetKrw: current?.budgetKrw || env.budgetKrw || 100000,
          multiple: current?.multiple || env.multiple || 2,
          hasKeys: Boolean(env.accessKey && env.secretKey),
          telegramChatId: current?.telegramChatId || env.telegramChatId || "",
          noticeUrl: current?.noticeUrl || env.noticeUrl || "",
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/chat-id") {
        const body = await readBody(req);
        const token = String(body.token || "").trim();
        if (!token) return send(res, 400, { error: "Cần token của bot." });
        const found = await discoverChatId(token);
        if (found.error) return send(res, 400, { error: found.error });
        return send(res, 200, { chatId: found.chatId });
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        const config = formConfig(await readBody(req));
        await start(config);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        stop();
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: "Không có đường dẫn này." });
    } catch (error) {
      send(res, 400, { error: error.message || "Lỗi." });
    }
  });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, "127.0.0.1", () => {
    log(`Mở http://127.0.0.1:${port}`);
  });
  return server;
}

const auto = process.argv.includes("--run");
serve();
if (auto) {
  const config = configFromEnv(loadEnvFile());
  start(config).catch((error) => log(error.message));
}
