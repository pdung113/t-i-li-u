import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { resolveChain } from "./chains.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const setupPath = path.join(root, "setup.txt");

export function parseSetup(text) {
  const values = {};
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readSetupFile() {
  if (!fs.existsSync(setupPath)) {
    throw new Error("Chưa có file setup.txt. Tải lại project hoặc tạo file đó ở thư mục tool.");
  }
  const buf = fs.readFileSync(setupPath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function num(value, fallback, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} không phải số: ${value}`);
  return parsed;
}

function flag(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function privateKey(value) {
  let key = (value || "").trim().replace(/^["']|["']$/g, "");
  if (!key) return null;
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PRIVATE_KEY trong setup.txt không đúng định dạng");
  }
  return key;
}

export function buildConfig(values, chainName) {
  const chain = resolveChain(chainName || values.CHAIN || "bsc");
  const buyAmount = values.BUY_AMOUNT || "0.05";
  const probeAmount = values.PROBE_AMOUNT || "0.002";
  const buyWei = ethers.parseEther(buyAmount);
  const probeParsed = ethers.parseEther(probeAmount);
  if (buyWei <= 0n) throw new Error("BUY_AMOUNT phải lớn hơn 0");
  const maxTaxPercent = num(values.MAX_TAX_PERCENT, 10, "MAX_TAX_PERCENT");
  const slippagePercent = num(values.SLIPPAGE_PERCENT, 15, "SLIPPAGE_PERCENT");
  const maxMcapUsd = num(values.MAX_MCAP_USD, 0, "MAX_MCAP_USD");
  if (maxTaxPercent < 0 || maxTaxPercent > 100) throw new Error("MAX_TAX_PERCENT phải từ 0 đến 100");
  if (slippagePercent < 0 || slippagePercent >= 100) throw new Error("SLIPPAGE_PERCENT phải từ 0 đến dưới 100");
  if (maxMcapUsd < 0) throw new Error("MAX_MCAP_USD phải từ 0 trở lên. 0 nghĩa là không giới hạn.");
  const gasGwei = values.GAS_GWEI || "3";
  ethers.parseUnits(String(gasGwei), "gwei");
  return {
    chain,
    link: (values.LINK || "").trim(),
    rpc: (values.RPC_URL || "").trim() || chain.rpc,
    dryRun: flag(values.DRY_RUN, true),
    buyAmount,
    buyWei,
    probeWei: probeParsed < buyWei ? probeParsed : buyWei,
    gasGwei,
    gasLimit: Math.round(num(values.GAS_LIMIT, 1_200_000, "GAS_LIMIT")),
    maxTaxPercent,
    slippagePercent,
    maxMcapUsd,
    lookbackSec: Math.round(num(values.LOOKBACK_SEC, 180, "LOOKBACK_SEC")),
    waitForPairMs: Math.round(num(values.WAIT_FOR_PAIR_MS, 120_000, "WAIT_FOR_PAIR_MS")),
    retryMs: Math.round(num(values.RETRY_MS, 400, "RETRY_MS")),
    pollMs: Math.round(num(values.POLL_MS, 0, "POLL_MS")),
    privateKey: privateKey(values.PRIVATE_KEY),
  };
}

export function loadConfig(chainName, setupText) {
  const text = setupText == null ? readSetupFile() : setupText;
  return buildConfig(parseSetup(text), chainName);
}
