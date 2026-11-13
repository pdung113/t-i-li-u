import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./client.js";
import { normalizeState, startEngine } from "./engine.js";
import { MAX_NATIVE, parseUserNumber } from "./limits.js";
import { CHAIN_IDS, chainById } from "./networks.js";
import { CHAIN_LABELS, endpointPair, probeRpc, resolveRpcChoice, scrubRpcError } from "./rpc.js";
import { createBuyer, walletFromEvmKey, walletFromSolanaKey } from "./swap.js";
import { discoverChatId, resultText, sendTelegram } from "./telegram.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, "..");
const envPath = path.join(dir, ".env");
const statePath = path.join(dir, "data", "state.json");
const htmlPath = path.join(root, "public", "index.html");
const KEPT_ENV = ["JUPITER_API_KEY"];

const lines = [];
let engine = null;
let buyer = null;
let current = null;
let telegramWarned = false;

const AUTH_HINTS = {
  invalid_access_key: "Access Key không đúng.",
  invalid_secret_key: "Secret Key không đúng.",
  jwt_verification: "Secret Key không khớp Access Key.",
  no_authorization_ip: "IP máy này chưa được thêm vào API key.",
  out_of_scope: "API key không có quyền đọc tài khoản.",
  expired_jwt: "JWT hết hạn. Thử lại.",
};

function explainError(name, message) {
  const hint = AUTH_HINTS[name];
  const detail = [name, message].filter(Boolean).join(": ");
  return hint ? `${hint} (${detail})` : detail || "Upbit từ chối kết nối.";
}

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
  const existing = loadEnvFile();
  const text = [
    `UPBIT_ACCESS_KEY=${config.accessKey}`,
    `UPBIT_SECRET_KEY=${config.secretKey}`,
    `EVM_PRIVATE_KEY=${config.evmPrivateKey}`,
    `SOLANA_PRIVATE_KEY=${config.solanaPrivateKey}`,
    ...CHAIN_IDS.map((id) => `AMOUNT_${id.toUpperCase()}=${config.amounts[id] > 0 ? config.amounts[id] : ""}`),
    `GAS_MULTIPLE=${config.gasMultiple}`,
    `SLIPPAGE_PERCENT=${config.slippagePercent}`,
    `MAX_FDV_USD=${config.maxFdv || ""}`,
    `MIN_LIQUIDITY_USD=${config.minLiquidity || ""}`,
    `TELEGRAM_BOT_TOKEN=${config.telegramToken}`,
    `TELEGRAM_CHAT_ID=${config.telegramChatId}`,
    `LIVE=${config.live ? "true" : "false"}`,
    ...CHAIN_IDS.filter((id) => config.rpc?.[id]).map((id) => `RPC_${id.toUpperCase()}=${config.rpc[id]}`),
    ...KEPT_ENV.filter((key) => existing[key]).map((key) => `${key}=${existing[key]}`),
    "",
  ].join("\n");
  fs.writeFileSync(envPath, text, { mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // Quyền file đã đặt lúc ghi.
  }
}

function configFromEnv(env) {
  return {
    accessKey: env.UPBIT_ACCESS_KEY || "",
    secretKey: env.UPBIT_SECRET_KEY || "",
    evmPrivateKey: env.EVM_PRIVATE_KEY || "",
    solanaPrivateKey: env.SOLANA_PRIVATE_KEY || "",
    amounts: Object.fromEntries(CHAIN_IDS.map((id) => [id, Number(env[`AMOUNT_${id.toUpperCase()}`] || 0)])),
    gasMultiple: Number(env.GAS_MULTIPLE || 2),
    slippagePercent: Number(env.SLIPPAGE_PERCENT || 10),
    maxFdv: Number(env.MAX_FDV_USD || 0) || null,
    minLiquidity: Number(env.MIN_LIQUIDITY_USD || 0) || null,
    telegramToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
    live: env.LIVE === "true",
    jupiterApiKey: env.JUPITER_API_KEY || "",
    rpc: {
      ethereum: env.RPC_ETHEREUM || "",
      bsc: env.RPC_BSC || "",
      base: env.RPC_BASE || "",
      arbitrum: env.RPC_ARBITRUM || "",
      optimism: env.RPC_OPTIMISM || "",
      polygon: env.RPC_POLYGON || "",
      solana: env.RPC_SOLANA || "",
    },
  };
}

function parseDecimal(value) {
  const parsed = parseUserNumber(value);
  return parsed == null ? Number.NaN : parsed;
}

function parseAmounts(source) {
  const amounts = Object.fromEntries(CHAIN_IDS.map((id) => [id, 0]));
  for (const id of CHAIN_IDS) {
    const raw = source?.[id];
    if (raw == null || String(raw).trim() === "") continue;
    amounts[id] = parseDecimal(raw);
  }
  return amounts;
}

function validate(config) {
  if (!config.accessKey || !config.secretKey) throw new Error("Cần Access Key và Secret Key của Upbit Open API.");
  for (const id of CHAIN_IDS) {
    const amount = config.amounts[id];
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_NATIVE) {
      throw new Error(`Số lượng ${id} phải từ 0 đến ${MAX_NATIVE}. Để trống nếu không mua chain này.`);
    }
  }
  if (!CHAIN_IDS.some((id) => config.amounts[id] > 0)) throw new Error("Nhập số lượng cho ít nhất một chain.");
  if (config.maxFdv != null && (!Number.isFinite(config.maxFdv) || config.maxFdv <= 0)) {
    throw new Error("FDV tối đa phải là số USD lớn hơn 0, hoặc để trống.");
  }
  if (config.minLiquidity != null && (!Number.isFinite(config.minLiquidity) || config.minLiquidity <= 0)) {
    throw new Error("Thanh khoản tối thiểu mỗi bên phải lớn hơn 0, hoặc để trống.");
  }
  if (!Number.isFinite(config.gasMultiple) || config.gasMultiple < 1 || config.gasMultiple > 20) {
    throw new Error("Hệ số gas phải từ 1 đến 20. Nhập 2 nếu muốn gấp đôi.");
  }
  if (!Number.isFinite(config.slippagePercent) || config.slippagePercent < 1 || config.slippagePercent > 50) {
    throw new Error("Trượt giá phải từ 1% đến 50%.");
  }
  if (config.evmPrivateKey) {
    try {
      walletFromEvmKey(config.evmPrivateKey);
    } catch {
      throw new Error("Private key ví ERC không đúng.");
    }
  }
  if (config.solanaPrivateKey) {
    try {
      walletFromSolanaKey(config.solanaPrivateKey);
    } catch {
      throw new Error("Private key ví Solana không đúng.");
    }
  }
  const needsEvm = CHAIN_IDS.some((id) => id !== "solana" && config.amounts[id] > 0);
  if (config.live && needsEvm && !config.evmPrivateKey) throw new Error("Cần private key ví ERC cho chain đang nhập số lượng.");
  if (config.live && config.amounts.solana > 0 && !config.solanaPrivateKey) throw new Error("Cần private key ví Solana.");
  for (const id of CHAIN_IDS) {
    if (!config.rpc?.[id]) continue;
    try {
      endpointPair(config.rpc[id]);
    } catch {
      throw new Error(`RPC ${CHAIN_LABELS[id]} phải là link https hoặc wss.`);
    }
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
    await client.krwBalance();
  } catch (error) {
    throw new Error(error.code ? explainError(error.code, "") : error.message);
  }
  writeEnv(config);
  current = config;
  telegramWarned = false;
  log("Đã xác thực API Upbit. Tool tự nghe thông báo mới, không cần gửi link.");
  const chosen = CHAIN_IDS.filter((id) => config.amounts[id] > 0).map((id) => `${config.amounts[id]} ${id}`);
  const cap = config.maxFdv ? `${config.maxFdv} USD` : "không giới hạn";
  const floor = config.minLiquidity ? `mỗi bên ${config.minLiquidity} USD` : "không chặn";
  log(`Số lượng theo chain: ${chosen.join(", ")}. Trượt giá ${config.slippagePercent}%. FDV tối đa ${cap}. Thanh khoản pool ${floor}. Gas x${config.gasMultiple}.`);
  if (!config.maxFdv) log("Chưa đặt FDV tối đa. Tool sẽ mua đúng giá pool lúc tin ra, kể cả khi giá đã bị đẩy.");
  if (!config.minLiquidity) log("Chưa đặt thanh khoản tối thiểu. Pool mỏng vẫn có thể được mua và bị trượt giá.");
  const privateRpc = CHAIN_IDS.filter((id) => config.rpc?.[id]).map((id) => CHAIN_LABELS[id]);
  log(privateRpc.length
    ? `RPC riêng cho ${privateRpc.join(", ")}. Chain không nhập thì dùng RPC công cộng.`
    : "Đang dùng RPC công cộng. Dán API key Alchemy hoặc Infura ở ô RPC riêng nếu muốn sát hơn.");
  log("Gas, nonce và kết nối RPC được giữ sẵn. Hỏi giá trên đường riêng rồi gửi cùng lúc hai RPC. Gửi xong là báo, không chờ block xác nhận.");
  log(config.live ? "Đang gửi giao dịch thật trên DEX." : "Chế độ xem thử: không ký và không gửi giao dịch.");
  const state = readState();
  buyer = createBuyer({
    ...config,
    onReceipt(info) {
      const text = resultText(info);
      log(text.replaceAll("\n", " | "));
      notify(text);
    },
  });
  try {
    await Promise.race([
      buyer.warm(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    buyer.start();
    engine = startEngine({
      client,
      config: {
        ...config,
        saveState,
        swap: (listing) => buyer.buy(listing),
      },
      log,
      notify,
      state,
    });
  } catch (error) {
    buyer.stop();
    buyer = null;
    throw error;
  }
}

function stop() {
  engine?.stop();
  engine = null;
  buyer?.stop();
  buyer = null;
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

function formConfig(body, env) {
  return {
    ...configFromEnv(env),
    accessKey: String(body.accessKey || "").trim(),
    secretKey: String(body.secretKey || "").trim(),
    evmPrivateKey: String(body.evmPrivateKey || "").trim(),
    solanaPrivateKey: String(body.solanaPrivateKey || "").trim(),
    amounts: parseAmounts(body.amounts),
    gasMultiple: parseDecimal(body.gasMultiple),
    slippagePercent: parseDecimal(body.slippagePercent),
    maxFdv: String(body.maxFdv ?? "").trim() ? parseDecimal(body.maxFdv) : null,
    minLiquidity: String(body.minLiquidity ?? "").trim() ? parseDecimal(body.minLiquidity) : null,
    telegramToken: String(body.telegramToken || "").trim(),
    telegramChatId: String(body.telegramChatId || "").trim(),
    live: body.live === true,
    rpc: resolveRpcChoice({
      provider: body.rpcProvider,
      secret: body.rpcSecret,
      overrides: body.rpc,
      saved: configFromEnv(env).rpc,
    }),
  };
}

async function checkRpc(body) {
  const env = configFromEnv(loadEnvFile());
  const choice = String(body.rpcProvider || "saved");
  const secret = String(body.rpcSecret || "");
  const urls = choice === "public"
    ? Object.fromEntries(CHAIN_IDS.map((id) => {
      const chain = chainById(id);
      return [id, chain.ws || chain.rpc];
    }))
    : resolveRpcChoice({
      provider: choice,
      secret,
      overrides: body.rpc,
      saved: env.rpc,
    });
  const chosen = CHAIN_IDS.filter((id) => urls[id]);
  if (!chosen.length) throw new Error("Chưa có RPC riêng. Dán API key Alchemy hoặc Infura. Không gửi key vào chat.");
  return {
    rows: await Promise.all(chosen.map(async (id) => {
      try {
        const result = await probeRpc(id, urls[id]);
        return { id, label: CHAIN_LABELS[id], ...result };
      } catch (error) {
        return { id, label: CHAIN_LABELS[id], ok: false, detail: scrubRpcError(error?.message, secret) };
      }
    })),
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
          lines,
          live: current?.live === true,
          amounts: Object.fromEntries(CHAIN_IDS.map((id) => {
            const value = current?.amounts?.[id] || env.amounts[id];
            return [id, value || ""];
          })),
          gasMultiple: current?.gasMultiple || env.gasMultiple || 2,
          slippagePercent: current?.slippagePercent || env.slippagePercent || 10,
          maxFdv: current?.maxFdv || env.maxFdv || "",
          minLiquidity: current?.minLiquidity || env.minLiquidity || "",
          hasKeys: Boolean(env.accessKey && env.secretKey),
          hasEvmKey: Boolean(env.evmPrivateKey),
          hasSolanaKey: Boolean(env.solanaPrivateKey),
          telegramChatId: current?.telegramChatId || env.telegramChatId || "",
          rpcSaved: CHAIN_IDS.filter((id) => env.rpc[id]).map((id) => CHAIN_LABELS[id]),
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
      if (req.method === "POST" && url.pathname === "/api/rpc-check") {
        return send(res, 200, await checkRpc(await readBody(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        const config = formConfig(await readBody(req), loadEnvFile());
        await start(config);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        stop();
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: "Không có đường dẫn này." });
    } catch (error) {
      send(res, 400, { error: scrubRpcError(error.message, "") || "Lỗi." });
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
