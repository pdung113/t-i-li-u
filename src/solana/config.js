import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { solToLamports } from "./detect.js";
import * as settings from "./settings.js";

function envBool(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function parseWallet(value, label = "Địa chỉ ví") {
  try {
    return new PublicKey(String(value).trim()).toBase58();
  } catch {
    throw new Error(`${label} không phải địa chỉ Solana`);
  }
}

export function keypairFromEnv(raw) {
  const text = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return null;
  let bytes;
  if (text.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(text));
  } else {
    bytes = bs58.decode(text);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error("SOLANA_PRIVATE_KEY phải là secret key base58, mảng JSON 64 số, hoặc seed 32 byte");
}

export function defaultWs(rpcUrl) {
  if (rpcUrl.startsWith("https://")) return `wss://${rpcUrl.slice("https://".length)}`;
  if (rpcUrl.startsWith("http://")) return `ws://${rpcUrl.slice("http://".length)}`;
  return rpcUrl;
}

export function resolveEndpoints(env = process.env) {
  const helius = String(env.HELIUS_API_KEY || "").trim();
  const rpc =
    String(env.SOLANA_RPC_URL || "").trim() ||
    (helius ? `https://mainnet.helius-rpc.com/?api-key=${helius}` : "https://api.mainnet-beta.solana.com");
  const ws =
    String(env.SOLANA_WS_URL || "").trim() ||
    (helius ? `wss://mainnet.helius-rpc.com/?api-key=${helius}` : defaultWs(rpc));
  return {
    rpc,
    ws,
    helius: Boolean(helius),
    jupiterKey: String(env.JUPITER_API_KEY || "").trim(),
    jitoUuid: String(env.JITO_UUID || "").trim(),
  };
}

export function loadSolanaConfig(targetArg, env = process.env) {
  const target = parseWallet(targetArg, "Ví cần theo dõi");
  const endpoints = resolveEndpoints(env);
  const dryRun = envBool(env.DRY_RUN, settings.DRY_RUN);
  const keypair = keypairFromEnv(env.SOLANA_PRIVATE_KEY);
  if (!dryRun && !keypair) {
    throw new Error("Đặt SOLANA_PRIVATE_KEY trong .env, hoặc giữ DRY_RUN=true");
  }
  if (keypair && keypair.publicKey.toBase58() === target) {
    throw new Error("Ví theo dõi trùng ví của bạn. Chọn ví khác.");
  }
  const buyLamports = solToLamports(settings.BUY_SOL);
  const minSolLamports = solToLamports(settings.MIN_SOL_SPENT);
  if (buyLamports <= 0n) throw new Error("BUY_SOL phải lớn hơn 0");
  if (settings.SLIPPAGE_BPS < 1 || settings.SLIPPAGE_BPS > 5000) {
    throw new Error("SLIPPAGE_BPS phải từ 1 đến 5000");
  }
  return {
    target,
    ...endpoints,
    dryRun,
    keypair,
    buyLamports,
    minSolLamports,
  };
}
