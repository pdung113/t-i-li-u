import { ethers } from "ethers";
import { Connection } from "@solana/web3.js";
import { CHAIN_IDS, chainById } from "./networks.js";

export const CHAIN_LABELS = {
  ethereum: "Ethereum",
  bsc: "BNB Chain",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
  solana: "Solana",
};

const ALCHEMY_HOST = {
  ethereum: "eth-mainnet",
  bsc: "bnb-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
  polygon: "polygon-mainnet",
  solana: "solana-mainnet",
};

const INFURA_HOST = {
  ethereum: "mainnet",
  bsc: "bsc-mainnet",
  base: "base-mainnet",
  arbitrum: "arbitrum-mainnet",
  optimism: "optimism-mainnet",
  polygon: "polygon-mainnet",
  solana: "solana-mainnet",
};

const WS_HOST = /(\.g\.alchemy\.com|\.infura\.io|\.publicnode\.com|\.quiknode\.pro|quicknode\.com)$/i;

function emptyRpc() {
  return Object.fromEntries(CHAIN_IDS.map((id) => [id, ""]));
}

export function scrubRpcError(text, secret = "") {
  let out = String(text || "Không nối được RPC.");
  const hidden = String(secret || "").trim();
  if (hidden.length >= 8) out = out.split(hidden).join("rpc");
  return out
    .replace(/wss?:\/\/\S+/gi, "rpc")
    .replace(/https?:\/\/\S+/gi, "rpc")
    .slice(0, 180);
}

export function endpointPair(raw) {
  const url = new URL(String(raw || "").trim());
  if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) {
    throw new Error("RPC phải là link https hoặc wss.");
  }
  if (/[\s]/.test(url.toString())) throw new Error("RPC không hợp lệ.");
  const httpUrl = new URL(url);
  const wsUrl = new URL(url);
  if (url.protocol === "wss:" || url.protocol === "ws:") {
    httpUrl.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return { ws: url.toString(), http: httpUrl.toString() };
  }
  if (WS_HOST.test(url.hostname)) {
    wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { ws: wsUrl.toString(), http: url.toString() };
  }
  return { ws: "", http: url.toString() };
}

export function buyUrl(raw) {
  const pair = endpointPair(raw);
  return pair.ws || pair.http;
}

function keyFromSecret(secret) {
  const text = String(secret || "").trim();
  if (!text || /[\r\n\s]/.test(text)) throw new Error("API key không đúng. Không gửi key vào chat.");
  if (/^wss?:\/\//i.test(text) || /^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const key = url.pathname.split("/").filter(Boolean).pop() || "";
    let provider = "";
    if (url.hostname.endsWith(".g.alchemy.com")) provider = "alchemy";
    else if (url.hostname.endsWith(".infura.io")) provider = "infura";
    else throw new Error("Link này không phải Alchemy hay Infura. Hãy dán vào ô từng chain.");
    return { provider, key };
  }
  return { provider: "", key: text };
}

export function expandRpc(provider, secret) {
  const found = keyFromSecret(secret);
  const name = found.provider || provider;
  if (name !== "alchemy" && name !== "infura") {
    throw new Error("Chọn Alchemy hoặc Infura, hoặc dán link đầy đủ.");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(found.key)) throw new Error("API key không đúng. Không gửi key vào chat.");
  const hosts = name === "alchemy" ? ALCHEMY_HOST : INFURA_HOST;
  const version = name === "alchemy" ? "v2" : "v3";
  const suffix = name === "alchemy" ? "g.alchemy.com" : "infura.io";
  return Object.fromEntries(CHAIN_IDS.map((id) => [id, `wss://${hosts[id]}.${suffix}/${version}/${found.key}`]));
}

export function resolveRpcChoice({ provider = "saved", secret = "", overrides = {}, saved = {} }) {
  const choice = String(provider || "saved");
  const kept = { ...emptyRpc(), ...saved };
  if (choice === "public") return emptyRpc();
  if (choice === "saved") return kept;
  if (choice === "custom") {
    const next = { ...kept };
    for (const id of CHAIN_IDS) {
      const value = String(overrides?.[id] || "").trim();
      if (!value) continue;
      endpointPair(value);
      next[id] = value;
    }
    return next;
  }
  if (choice === "alchemy" || choice === "infura") {
    if (!String(secret || "").trim()) return kept;
    return expandRpc(choice, secret);
  }
  throw new Error("Chọn loại RPC.");
}

function withTimeout(promise, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC không trả lời.")), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function probeRpc(chainId, raw) {
  const chain = chainById(chainId);
  if (!chain) return { ok: false, detail: "Không có chain này." };
  const started = Date.now();
  const pair = endpointPair(raw);
  if (chain.kind === "solana") {
    const connection = new Connection(pair.http, { commitment: "confirmed", disableRetryOnRateLimit: true });
    try {
      await withTimeout(connection.getSlot());
      return { ok: true, ms: Date.now() - started };
    } catch (error) {
      const text = scrubRpcError(error?.message);
      if (/401|403|authenticated|Unauthorized/i.test(text)) return { ok: false, detail: "RPC từ chối key." };
      return { ok: false, detail: text };
    }
  }
  const target = pair.ws || pair.http;
  const network = ethers.Network.from(chain.chainId);
  const provider = String(target).startsWith("ws")
    ? new ethers.WebSocketProvider(target, network, { staticNetwork: network })
    : new ethers.JsonRpcProvider(target, network, { staticNetwork: network });
  let rejectSocket = () => {};
  const socketFailed = new Promise((_, reject) => {
    rejectSocket = reject;
  });
  provider.websocket?.on?.("error", () => rejectSocket(new Error("RPC từ chối key.")));
  provider.on?.("error", () => {});
  try {
    const hex = await withTimeout(Promise.race([provider.send("eth_chainId", []), socketFailed]));
    if (Number(hex) !== chain.chainId) return { ok: false, ms: Date.now() - started, detail: "Link này không phải đúng mạng." };
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const text = scrubRpcError(error?.message);
    if (/401|403|authenticated|Unauthorized|từ chối/i.test(text)) {
      return { ok: false, ms: Date.now() - started, detail: "RPC từ chối key." };
    }
    return { ok: false, ms: Date.now() - started, detail: text };
  } finally {
    provider.destroy?.();
  }
}
