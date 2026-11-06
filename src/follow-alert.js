import "dotenv/config";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { log } from "./log.js";
import { parseTwitterTarget } from "./twitter.js";
import { createXClient, fileStore, sendTelegram, statePath, watch, watchAll } from "./follows.js";

export const WATCH_LIST = "theo-doi.txt";

const USAGE = `Cách dùng:
  npm run follow
  node src/follow-alert.js
  node src/follow-alert.js --once
  node src/follow-alert.js --test-telegram

Danh sách người cần theo dõi nằm trong file theo-doi.txt.
Mỗi dòng một link X hoặc @username. Lưu file là tool nhận người mới.
Chỉ đọc follow công khai. Lần chạy đầu nhớ danh sách hiện tại, không gửi tin.
Sau đó mỗi follow mới được báo qua Telegram, kèm link X.
Nếu người đó đăng contract trong bio hoặc bài viết, contract được thêm vào tin.`;

/**
 * @param {string} text
 * @returns {{ handles: string[], errors: string[] }}
 */
export function parseWatchList(text) {
  const handles = [];
  const seen = new Set();
  const errors = [];
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    try {
      const { handle } = parseTwitterTarget(raw);
      const key = handle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      handles.push(handle);
    } catch (error) {
      errors.push(`${raw}: ${error.message}`);
    }
  }
  return { handles, errors };
}

export async function readWatchList(listPath = WATCH_LIST) {
  try {
    return parseWatchList(await readFile(listPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { handles: [], errors: [`Chưa có file ${listPath}`] };
    }
    throw error;
  }
}

export function loadAlertConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    throw new Error("Điền TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env");
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN không đúng định dạng (dạng 123456:ABC...)");
  }
  if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(chatId)) {
    throw new Error("TELEGRAM_CHAT_ID phải là số chat hoặc @kenh");
  }
  const raw = env.FOLLOW_POLL_MS;
  const pollMs = raw == null || String(raw).trim() === "" ? 3000 : Number(raw);
  if (!Number.isFinite(pollMs) || pollMs < 1000) {
    throw new Error("FOLLOW_POLL_MS phải từ 1000 trở lên");
  }
  return { token, chatId, pollMs };
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   client?: { profile: Function, following: Function },
 *   store?: { load: Function, save: Function },
 *   notify?: (text: string) => Promise<void>,
 *   log?: (message: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxCycles?: number,
 *   listPath?: string,
 *   loadHandles?: () => Promise<{ handles: string[], errors?: string[] } | string[]>,
 *   storeFor?: (handle: string) => { load: Function, save: Function },
 * }} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const env = deps.env || process.env;
  let config;
  try {
    config = loadAlertConfig(env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const notify =
    deps.notify ||
    ((text) => sendTelegram({ token: config.token, chatId: config.chatId, text }));

  if (argv.includes("--test-telegram")) {
    await notify("Kết nối Telegram thành công. Tool sẽ báo khi tài khoản này follow người mới.");
    (deps.log || log)("Đã gửi tin thử tới Telegram.");
    return;
  }

  const skip = new Set();
  argv.forEach((arg, index) => {
    if (arg === "--once") skip.add(index);
  });
  const targetArg = argv.find((arg, index) => !arg.startsWith("--") && !skip.has(index));
  const client = deps.client || createXClient();
  const once = argv.includes("--once") ? 1 : deps.maxCycles;
  const logFn = deps.log || log;

  if (!targetArg) {
    const listPath = deps.listPath || WATCH_LIST;
    await watchAll({
      loadHandles: deps.loadHandles || (() => readWatchList(listPath)),
      storeFor: deps.storeFor || ((handle) => fileStore(statePath(handle))),
      client,
      notify,
      pollMs: config.pollMs,
      sleep: deps.sleep,
      log: logFn,
      maxCycles: once,
      maxPages: deps.maxPages,
    });
    return;
  }

  const target = parseTwitterTarget(targetArg);
  const store = deps.store || fileStore(statePath(target.handle));
  await watch({
    handle: target.handle,
    client,
    store,
    notify,
    pollMs: config.pollMs,
    sleep: deps.sleep,
    log: logFn,
    maxCycles: once,
    maxPages: deps.maxPages,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
