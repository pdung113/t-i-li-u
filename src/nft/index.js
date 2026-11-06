import "dotenv/config";
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
import { resolveNftChain } from "./chains.js";
import { runBuy, runMint } from "./run.js";
import * as settings from "./settings.js";

function envBool(name, fallback, env) {
  const value = env[name];
  if (value == null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPrivateKey(env) {
  let key = (env.PRIVATE_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!key) return null;
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("PRIVATE_KEY trong .env không đúng định dạng.");
  return key;
}

function takeFlag(argv, index) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) throw new Error(`Thiếu giá trị sau ${argv[index]}.`);
  return value;
}

export function loadNftOptions(argv = [], env = process.env) {
  if (!argv.length) return null;
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!["--qty", "--gas", "--gas-limit", "--max-price", "--chain"].includes(arg)) {
      throw new Error(`Cờ không biết: ${arg}.`);
    }
    flags[arg] = takeFlag(argv, index);
    index += 1;
  }
  const command = positional[0];
  const url = positional[1];
  if (!command || !url || !["mint", "buy"].includes(command)) return null;
  const quantity = Number(flags["--qty"] ?? settings.MINT_QUANTITY);
  const gasGwei = flags["--gas"] ?? settings.GAS_GWEI;
  const gasLimit = Number(flags["--gas-limit"] ?? settings.GAS_LIMIT);
  const maxPriceText = flags["--max-price"] ?? (command === "buy" ? settings.MAX_BUY_PRICE : settings.MAX_MINT_PRICE);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("--qty phải là số nguyên từ 1.");
  if (!Number.isInteger(gasLimit) || gasLimit < 21_000) throw new Error("--gas-limit quá thấp.");
  let gas;
  try {
    gas = ethers.parseUnits(String(gasGwei), "gwei");
  } catch {
    throw new Error("--gas không hợp lệ.");
  }
  if (gas <= 0n) throw new Error("--gas phải lớn hơn 0.");
  const maxPrice = ethers.parseEther(String(maxPriceText));
  const chain = flags["--chain"] ? resolveNftChain(flags["--chain"]) : null;
  const privateKey = readPrivateKey(env);
  const dryRun = envBool("DRY_RUN", settings.DRY_RUN, env);
  return {
    command,
    url,
    quantity,
    gasGwei: String(gasGwei),
    gasLimit,
    maxPrice,
    chain,
    rpc: (env.RPC_URL || "").trim(),
    apiKey: (env.OPENSEA_API_KEY || "").trim(),
    dryRun,
    wallet: privateKey ? new ethers.Wallet(privateKey).address : null,
    signer: privateKey ? new ethers.Wallet(privateKey) : null,
  };
}

function usage() {
  return [
    "Cách dùng:",
    "  npm run nft -- mint https://opensea.io/collection/ten-drop",
    "  npm run nft -- mint https://mint.du-an.xyz --qty 2 --gas 20 --max-price 0.05",
    "  npm run nft -- buy https://opensea.io/collection/ten-drop --qty 1 --max-price 0.2",
    "Chain: eth | base | polygon | arbitrum | optimism | bsc. Bỏ trống nếu link hoặc trang đã ghi chain.",
    "Gas và số lượng mặc định nằm trong src/nft/settings.js.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = loadNftOptions(argv);
  if (!options) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  if (options.command === "mint") await runMint(options);
  else await runBuy(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
