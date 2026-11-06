import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNftChain } from "./chains.js";
import { parseNotepad } from "./notepad.js";
import { runBuy, runMint, runMintWallets } from "./run.js";
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
    "  npm run nft",
    "Sửa chain, gas, link và private key trong nft.txt. Nhiều dòng key thì mint cùng lúc.",
    "Lệnh lẻ vẫn chạy được:",
    "  npm run nft -- mint https://mint.du-an.xyz --qty 2 --gas 20 --max-price 0.05",
    "  npm run nft -- buy https://opensea.io/collection/ten-drop --qty 1 --max-price 0.2",
  ].join("\n");
}

function exampleFile() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../nft.example.txt");
}

export async function runFromNotepad(deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const file = deps.file || resolve(cwd, "nft.txt");
  const exists = deps.exists || existsSync;
  const read = deps.readFile || ((target) => readFileSync(target, "utf8"));
  const write = deps.writeFile || ((target, text) => writeFileSync(target, text));
  if (!exists(file)) {
    const example = deps.example ?? read(exampleFile());
    write(file, example);
    console.log(`Đã tạo ${file}. Mở file này, điền chain, gas, link và private key, rồi chạy lại.`);
    process.exitCode = 1;
    return null;
  }
  const env = deps.env || process.env;
  const config = parseNotepad(read(file));
  const chain = resolveNftChain(config.chain);
  const dryRun = config.dryRun ?? envBool("DRY_RUN", settings.DRY_RUN, env);
  const wallets = config.keys.map((key) => {
    const signer = new ethers.Wallet(key);
    return { address: signer.address, signer };
  });
  const reports = [];
  for (const url of config.links) {
    reports.push(
      await runMintWallets(
        {
          command: "mint",
          url,
          quantity: config.qty ?? settings.MINT_QUANTITY,
          gasGwei: String(config.gas ?? settings.GAS_GWEI),
          gasLimit: config.gasLimit ?? settings.GAS_LIMIT,
          maxPrice: ethers.parseEther(config.maxPrice ?? settings.MAX_MINT_PRICE),
          chain,
          rpc: (env.RPC_URL || "").trim(),
          apiKey: (env.OPENSEA_API_KEY || "").trim(),
          dryRun,
          wallet: null,
          signer: null,
        },
        wallets,
        deps,
      ),
    );
  }
  return reports;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (!argv.length) return runFromNotepad(deps);
  const options = loadNftOptions(argv, deps.env || process.env);
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
