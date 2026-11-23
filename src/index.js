import dotenv from "dotenv";
import { ethers } from "ethers";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBuyTx, gasShortfall, minOutFromReceived } from "./buy.js";
import { resolveChain } from "./chains.js";
import { REASON_TEXT, decide, formatTax } from "./decide.js";
import { log } from "./log.js";
import * as settings from "./settings.js";
import {
  SIM_EOA,
  describePool,
  isUnsupportedSimulate,
  redirectFromPair,
  simulateSwap,
  underlyingToken,
} from "./simulate.js";
import { authorHandle, extractAddresses, fetchStatus, fetchStatuses, parseTwitterTarget, tweetTimestamp } from "./twitter.js";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});

const DEAD = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readPrivateKey() {
  let key = (process.env.PRIVATE_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!key) return null;
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PRIVATE_KEY trong .env không đúng định dạng");
  }
  return key;
}

function parsePositiveEther(label, value) {
  let wei;
  try {
    wei = ethers.parseEther(String(value).trim());
  } catch {
    throw new Error(`${label} không đọc được: ${value}`);
  }
  if (wei <= 0n) throw new Error(`${label} phải lớn hơn 0`);
  return wei;
}

function assertRpcUrl(rpc) {
  let url;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error(`RPC_URL không đọc được: ${rpc}`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("RPC_URL phải bắt đầu bằng http://, https://, ws:// hoặc wss://");
  }
  return url;
}

function assertNumber(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} phải là số không âm`);
  }
}

export function loadConfig(chainName) {
  const chain = resolveChain(chainName || process.env.CHAIN || settings.CHAIN);
  const buyWei = parsePositiveEther("BUY_AMOUNT", settings.BUY_AMOUNT);
  const probeWei = parsePositiveEther("PROBE_AMOUNT", settings.PROBE_AMOUNT);
  if (settings.MAX_TAX_PERCENT < 0 || settings.MAX_TAX_PERCENT > 100) {
    throw new Error("MAX_TAX_PERCENT phải từ 0 đến 100");
  }
  if (settings.SLIPPAGE_PERCENT < 0 || settings.SLIPPAGE_PERCENT >= 100) {
    throw new Error("SLIPPAGE_PERCENT phải từ 0 đến dưới 100");
  }
  try {
    const gasWei = ethers.parseUnits(String(settings.GAS_GWEI).trim(), "gwei");
    if (gasWei <= 0n) throw new Error("GAS_GWEI phải lớn hơn 0");
  } catch (error) {
    if (error.message === "GAS_GWEI phải lớn hơn 0") throw error;
    throw new Error(`GAS_GWEI không đọc được: ${settings.GAS_GWEI}`);
  }
  if (!Number.isInteger(settings.GAS_LIMIT) || settings.GAS_LIMIT < 21_000) {
    throw new Error("GAS_LIMIT phải là số nguyên từ 21000 trở lên");
  }
  assertNumber("POLL_MS", settings.POLL_MS);
  assertNumber("LOOKBACK_SEC", settings.LOOKBACK_SEC);
  assertNumber("WAIT_FOR_PAIR_MS", settings.WAIT_FOR_PAIR_MS);
  assertNumber("RETRY_MS", settings.RETRY_MS);
  const rpc = process.env.RPC_URL || chain.rpc;
  assertRpcUrl(rpc);
  return {
    chain,
    rpc,
    dryRun: envBool("DRY_RUN", settings.DRY_RUN),
    buyWei,
    probeWei: probeWei < buyWei ? probeWei : buyWei,
    privateKey: readPrivateKey(),
  };
}

function flagValue(argv, index, flag) {
  const inline = argv[index].slice(flag.length + 1);
  if (argv[index].startsWith(`${flag}=`)) return inline;
  return argv[index + 1];
}

export function parseCli(argv) {
  const positionals = [];
  let chain = null;
  let token = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? "");
    if (arg === "--help" || arg === "-h") {
      return { help: true, chain: null, token: null, target: null };
    }
    if (arg === "--chain" || arg.startsWith("--chain=")) {
      const value = flagValue(argv, i, "--chain");
      if (arg === "--chain") i += 1;
      if (value == null || value === "" || String(value).startsWith("--")) {
        throw new Error("Thiếu tên chain sau --chain. Dùng bsc, eth, base, hoặc robinhood.");
      }
      if (/^https?:\/\//i.test(value) || String(value).startsWith("@")) {
        throw new Error("Thiếu tên chain sau --chain. Ví dụ: --chain bsc https://x.com/ten_du_an");
      }
      chain = String(value).trim();
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      const value = flagValue(argv, i, "--token");
      if (arg === "--token") i += 1;
      if (value == null || value === "" || String(value).startsWith("--")) {
        throw new Error("Dùng: npm start -- --token 0x...");
      }
      token = String(value).trim();
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Cờ không hỗ trợ: ${arg}. Dùng --chain hoặc --token.`);
    }
    if (arg.trim()) positionals.push(arg.trim());
  }
  if (positionals.length > 1) throw new Error("Chỉ nhận một link X.");
  if (token && positionals.length > 0) throw new Error("Dùng --token hoặc link X, không dùng cả hai.");
  return { help: false, chain, token, target: positionals[0] ?? null };
}

function printUsage() {
  console.log("Cách dùng: node src/index.js --chain bsc https://x.com/ten_du_an");
  console.log("           npm start -- --chain bsc https://x.com/ten_du_an");
  console.log("Chain:     bsc | eth | base | robinhood");
  console.log("Thử tax:   node src/index.js --chain bsc --token 0x...");
  console.log("Cờ:        --chain <tên>    chọn chain, đè CHAIN trong .env và src/settings.js");
  console.log("           --token <0x...>  chỉ đo tax, không theo dõi X và không gửi giao dịch");
  console.log("File:      .env (PRIVATE_KEY, RPC_URL, CHAIN, DRY_RUN) và src/settings.js");
  process.exitCode = 1;
}

function isBlacklisted(chain, address) {
  const key = address.toLowerCase();
  if (DEAD.has(key)) return true;
  return chain.blacklist.some((item) => item.toLowerCase() === key);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcMessage(error) {
  if (isUnsupportedSimulate(error)) {
    return "RPC không hỗ trợ eth_simulateV1. Điền RPC_URL khác trong .env.";
  }
  return error.shortMessage || error.message;
}

async function openProvider(config) {
  const provider = new ethers.JsonRpcProvider(config.rpc, config.chain.chainId, { staticNetwork: true });
  try {
    const hex = await provider.send("eth_chainId", []);
    const id = Number(hex);
    if (!Number.isFinite(id) || id !== config.chain.chainId) {
      throw new Error(
        `RPC trả chainId ${hex}, không khớp ${config.chain.name} (${config.chain.chainId}). Kiểm tra --chain và RPC_URL.`,
      );
    }
    return provider;
  } catch (error) {
    await provider.destroy();
    if (String(error.message || "").startsWith("RPC trả chainId")) throw error;
    throw new Error(`Không kết nối được RPC: ${error.shortMessage || error.message}`);
  }
}

async function readGasShortfall(provider, chain) {
  const [block, gasHex] = await Promise.all([provider.getBlock("latest"), provider.send("eth_gasPrice", [])]);
  const short = gasShortfall({
    eip1559: chain.eip1559,
    gasGwei: settings.GAS_GWEI,
    baseFeePerGas: block?.baseFeePerGas ?? 0n,
    networkGasPrice: BigInt(gasHex),
  });
  return { block, short };
}

async function warnGas(provider, chain) {
  try {
    const { short } = await readGasShortfall(provider, chain);
    if (!short) return;
    log(
      `Cảnh báo: GAS_GWEI=${settings.GAS_GWEI} thấp hơn mạng (${ethers.formatUnits(short.need, "gwei")} gwei). Lệnh thật có thể không vào block.`,
    );
  } catch {
    // Gas mạng chỉ là cảnh báo. Lỗi RPC ở đây không chặn việc đo tax.
  }
}

async function evaluateToken(provider, config, token, nowSec) {
  const sameSize = config.probeWei === config.buyWei;
  const base = { chain: config.chain, token, nowSec, eoa: SIM_EOA };
  let [probe, full] = await Promise.all([
    simulateSwap(provider, { ...base, valueWei: config.probeWei, withSell: true }),
    sameSize ? Promise.resolve(null) : simulateSwap(provider, { ...base, valueWei: config.buyWei, withSell: false }),
  ]);

  if (probe.buyFailed && full && !full.buyFailed) {
    probe = await simulateSwap(provider, { ...base, valueWei: config.buyWei, withSell: true });
    full = probe;
  }

  const decision = decide(probe, settings.MAX_TAX_PERCENT);
  const fill = full && !full.buyFailed ? full : probe;
  return { probe, full, fill, decision };
}

async function inspectToken(config, tokenArg) {
  if (!tokenArg || !/^0x[a-fA-F0-9]{40}$/.test(tokenArg)) {
    throw new Error("Dùng: npm start -- --token 0x...");
  }
  const provider = await openProvider(config);
  try {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("RPC không trả block mới nhất");
    await warnGas(provider, config.chain);
    const now = Number(block.timestamp);
    let token = ethers.getAddress(tokenArg);
    const underlying = await underlyingToken(provider, config.chain, token);
    const nextRaw = redirectFromPair(token, underlying);
    if (nextRaw) {
      const next = ethers.getAddress(nextRaw);
      log(`${token} là pair V2. Đo token ${next}.`);
      if (isBlacklisted(config.chain, next)) {
        log(`Watcher sẽ bỏ qua ${next} vì nằm trong danh sách địa chỉ hệ thống.`);
      }
      token = next;
    }
    const started = Date.now();
    const { probe, full, fill, decision } = await evaluateToken(provider, config, token, now);
    const symbol = config.chain.nativeSymbol;
    log(
      `${config.chain.name} ${token} buy ${formatTax(probe.buyTaxBps)} sell ${formatTax(probe.sellTaxBps)} | ${REASON_TEXT[decision.reason] || decision.reason} | ${Date.now() - started}ms`,
    );
    if (probe.buyRevert) log(`Buy revert: ${probe.buyRevert}`);
    if (probe.sellRevert) log(`Sell revert: ${probe.sellRevert}`);
    if (decision.ok && full?.buyFailed) {
      log(`Khối lượng ${settings.BUY_AMOUNT} ${symbol} không mua được trong mô phỏng.`);
    } else if (decision.ok) {
      const minOut = minOutFromReceived(fill.gotTokens, settings.SLIPPAGE_PERCENT);
      log(`Trong ngưỡng ${settings.MAX_TAX_PERCENT}%. minOut ${minOut}. Lệnh kiểm tra này không gửi giao dịch.`);
    }
  } finally {
    await provider.destroy();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help || (cli.token == null && !cli.target)) {
    printUsage();
    return;
  }

  const config = loadConfig(cli.chain);
  if (cli.token != null) {
    await inspectToken(config, cli.token);
    return;
  }
  let target = parseTwitterTarget(cli.target);
  if (!config.dryRun && !config.privateKey) {
    throw new Error("Đặt PRIVATE_KEY trong .env, hoặc giữ DRY_RUN = true trong src/settings.js");
  }
  if (!target.handle) {
    const status = await fetchStatus(target.statusId);
    const handle = authorHandle(status);
    if (!handle) throw new Error(`Không lấy được username từ tweet ${target.statusId}`);
    target = { handle, statusId: target.statusId, status };
  }

  const provider = await openProvider(config);
  const wallet = config.privateKey ? new ethers.Wallet(config.privateKey, provider) : null;

  let timeOffset = 0;
  const syncClock = async () => {
    const block = await provider.getBlock("latest");
    timeOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
  };
  try {
    await syncClock();
  } catch (error) {
    await provider.destroy();
    throw error;
  }
  await warnGas(provider, config.chain);
  const clockTimer = setInterval(() => {
    syncClock().catch(() => {});
  }, 15_000);
  clockTimer.unref?.();
  const nowSec = () => Math.floor(Date.now() / 1000) + timeOffset;

  const symbol = config.chain.nativeSymbol;
  log(
    `Chain ${config.chain.name} | mua ${settings.BUY_AMOUNT} ${symbol} | gas ${settings.GAS_GWEI} gwei | tax tối đa ${settings.MAX_TAX_PERCENT}% | ${config.dryRun ? "DRY RUN" : "MUA THẬT"}`,
  );
  log(`RPC ${config.rpc}`);
  log(`Theo dõi @${target.handle}${target.statusId ? ` tweet ${target.statusId}` : ""}`);
  if (wallet) {
    const balance = await provider.getBalance(wallet.address);
    const gasCap = ethers.parseUnits(String(settings.GAS_GWEI), "gwei") * BigInt(settings.GAS_LIMIT);
    log(`Ví ${wallet.address} | số dư ${ethers.formatEther(balance)} ${symbol}`);
    if (!config.dryRun && balance < config.buyWei + gasCap) {
      log("Cảnh báo: số dư có thể không đủ cho số mua + trần gas. Dùng ví riêng, chỉ nạp số chấp nhận mất.");
    }
  } else {
    log("Chưa có PRIVATE_KEY — chỉ mô phỏng, không gửi lệnh.");
  }

  const seenTweets = new Set();
  const handledTokens = new Set();
  let since = 0;
  let bootstrapped = false;
  let queue = Promise.resolve();
  let lastBeat = Date.now();
  let lastSoftLog = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
    clearInterval(clockTimer);
  };
  process.on("SIGINT", () => {
    log("Dừng.");
    stop();
    try {
      provider.destroy();
    } catch {
      // Đóng kết nối là phụ. Ctrl+C vẫn phải thoát.
    }
    process.exit(0);
  });

  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const considerTweet = (tweet, { buy }) => {
    if (!tweet?.id || seenTweets.has(String(tweet.id))) return;
    seenTweets.add(String(tweet.id));
    if (!buy) return;
    let addresses = [];
    try {
      addresses = extractAddresses(tweet).map((addr) => ethers.getAddress(addr));
    } catch {
      return;
    }
    if (addresses.length === 0) return;
    log(`Tweet ${tweet.id} có ${addresses.length} địa chỉ`);
    for (const address of addresses) {
      if (isBlacklisted(config.chain, address)) {
        log(`Bỏ qua địa chỉ hệ thống ${address}`);
        continue;
      }
      enqueue(() => snipe(address, tweet).catch((error) => log(`Lỗi ${address}: ${error.message}`)));
    }
  };

  const snipe = async (rawAddress, tweet) => {
    let token = ethers.getAddress(rawAddress);
    const mark = token.toLowerCase();
    if (handledTokens.has(mark)) return;
    handledTokens.add(mark);

    const detectedAt = Date.now();
    log(`Contract ${token} từ tweet ${tweet.id}. Đang đo tax...`);

    const until = detectedAt + settings.WAIT_FOR_PAIR_MS;
    let attempt = 0;
    let checkedPair = false;
    let hops = 0;
    while (!stopped && Date.now() < until) {
      attempt += 1;
      if (!checkedPair) {
        try {
          const underlying = await underlyingToken(provider, config.chain, token);
          checkedPair = true;
          const nextRaw = redirectFromPair(token, underlying);
          if (nextRaw) {
            hops += 1;
            if (hops > 2) {
              log(`Pair ${token} redirect quá sâu. Bỏ qua.`);
              return;
            }
            const next = ethers.getAddress(nextRaw);
            if (isBlacklisted(config.chain, next)) {
              log(`Pair ${token} trỏ tới địa chỉ hệ thống ${next}. Bỏ qua.`);
              return;
            }
            if (handledTokens.has(next.toLowerCase()) && next.toLowerCase() !== token.toLowerCase()) {
              log(`Token ${next} đã được xử lý.`);
              return;
            }
            log(`${token} là pair. Dùng token ${next}.`);
            token = next;
            handledTokens.add(next.toLowerCase());
            checkedPair = false;
            continue;
          }
        } catch (error) {
          log(`Chưa đọc được pair: ${error.shortMessage || error.message}`);
          await sleep(settings.RETRY_MS);
          continue;
        }
      }

      let result;
      try {
        result = await evaluateToken(provider, config, token, nowSec());
      } catch (error) {
        if (isUnsupportedSimulate(error)) {
          log(rpcMessage(error));
          return;
        }
        log(`Mô phỏng lỗi: ${rpcMessage(error)}`);
        await sleep(settings.RETRY_MS);
        continue;
      }

      const { probe, full, fill, decision } = result;
      const sizeNote =
        full && full !== probe
          ? ` | lệnh ${settings.BUY_AMOUNT} ${symbol} ${full.buyFailed ? "không mua được" : "mua được"}`
          : "";
      if (attempt === 1 || decision.terminal || decision.ok) {
        log(
          `Tax buy ${formatTax(probe.buyTaxBps)} sell ${formatTax(probe.sellTaxBps)} trong ${probe.ms}ms.${probe.buyRevert ? ` Buy: ${probe.buyRevert}.` : ""}${probe.sellRevert ? ` Sell: ${probe.sellRevert}.` : ""}${sizeNote}`,
        );
      }

      if (decision.ok && full?.buyFailed) {
        log(`Không mua ${settings.BUY_AMOUNT} ${symbol}: pool không nhận khối lượng này. Giảm BUY_AMOUNT trong src/settings.js.`);
        return;
      }

      if (!decision.ok) {
        if (!decision.terminal) {
          if (attempt === 1 || attempt % 12 === 0) {
            const pool = await describePool(provider, config.chain, token);
            log(`Chưa vào lệnh (${pool}). Thử lại...`);
          }
          await sleep(settings.RETRY_MS);
          continue;
        }
        log(`Không mua: ${REASON_TEXT[decision.reason] || decision.reason}.`);
        return;
      }

      const minOut = minOutFromReceived(fill.gotTokens, settings.SLIPPAGE_PERCENT);
      if (minOut <= 0n) {
        log("Không mua: minOut = 0. Tăng BUY_AMOUNT hoặc giảm SLIPPAGE_PERCENT trong src/settings.js.");
        return;
      }
      const deadline = BigInt(nowSec() + 180);
      if (config.dryRun || !wallet) {
        log(
          `DRY RUN khớp. Sẽ mua ${settings.BUY_AMOUNT} ${symbol}, minOut ${minOut}, gas ${settings.GAS_GWEI} gwei. Từ lúc thấy contract: ${Date.now() - detectedAt}ms.`,
        );
        return;
      }

      let short = null;
      try {
        short = (await readGasShortfall(provider, config.chain)).short;
      } catch (error) {
        log(`Chưa đọc được gas mạng: ${error.shortMessage || error.message}`);
        await sleep(settings.RETRY_MS);
        continue;
      }
      if (short) {
        log(
          `Không gửi lệnh: GAS_GWEI=${settings.GAS_GWEI} thấp hơn mạng (${ethers.formatUnits(short.need, "gwei")} gwei).`,
        );
        return;
      }

      let nonce;
      try {
        nonce = await provider.getTransactionCount(wallet.address, "pending");
      } catch (error) {
        log(`Chưa lấy được nonce: ${error.shortMessage || error.message}`);
        await sleep(settings.RETRY_MS);
        continue;
      }

      const tx = buildBuyTx({
        chain: config.chain,
        token,
        walletAddress: wallet.address,
        valueWei: config.buyWei,
        minOut,
        gasGwei: settings.GAS_GWEI,
        gasLimit: settings.GAS_LIMIT,
        nonce,
        deadline,
      });
      try {
        const raw = await wallet.signTransaction(tx);
        const sent = await provider.broadcastTransaction(raw);
        const elapsed = Date.now() - detectedAt;
        log(`Đã gửi ${sent.hash} sau ${elapsed}ms.`);
        if (elapsed > 1000) {
          log("Lệnh vượt 1s kể từ lúc đọc được contract. Dùng RPC riêng nếu cần nhanh hơn.");
        }
        return;
      } catch (error) {
        const message = error.shortMessage || error.message;
        if (/insufficient funds/i.test(message)) {
          log(`Không mua: ví không đủ số dư. ${message}`);
          return;
        }
        // Không gửi lại sau khi đã broadcast: node có thể đã nhận lệnh dù lời gọi báo lỗi.
        log(`Chưa gửi được lệnh: ${message}`);
        return;
      }
    }

    if (!stopped) log(`Hết ${Math.round(settings.WAIT_FOR_PAIR_MS / 1000)}s, không mua ${token}.`);
  };

  if (target.status) {
    considerTweet(target.status, { buy: true });
  } else if (target.statusId) {
    try {
      const status = await fetchStatus(target.statusId);
      if (status) considerTweet(status, { buy: true });
    } catch (error) {
      log(error.message);
    }
  }

  const baseline = (tweets) => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const ordered = [...tweets].sort((a, b) => tweetTimestamp(a) - tweetTimestamp(b));
    for (const tweet of ordered) {
      const fresh = tweetTimestamp(tweet) >= nowUnix - settings.LOOKBACK_SEC;
      considerTweet(tweet, { buy: fresh });
      since = Math.max(since, tweetTimestamp(tweet));
    }
    bootstrapped = true;
    log(`Đã nhớ ${seenTweets.size} tweet. Chờ contract mới của @${target.handle}.`);
  };

  try {
    baseline(await fetchStatuses(target.handle, { signal: AbortSignal.timeout(8000) }));
  } catch (error) {
    log(`Chưa đọc được timeline: ${error.message}`);
    if (error.code === 404 && error.empty) lastSoftLog = Date.now();
  }

  while (!stopped) {
    const started = Date.now();
    try {
      const tweets = await fetchStatuses(target.handle, {
        since: bootstrapped && since > 0 ? since : undefined,
        signal: AbortSignal.timeout(8000),
      });
      if (!bootstrapped) {
        baseline(tweets);
      } else {
        const ordered = [...tweets].sort((a, b) => tweetTimestamp(a) - tweetTimestamp(b));
        for (const tweet of ordered) {
          considerTweet(tweet, { buy: true });
          since = Math.max(since, tweetTimestamp(tweet));
        }
      }
    } catch (error) {
      if (error.code === 429) {
        log("Timeline bị giới hạn tốc độ, chờ rồi thử lại.");
        await sleep(error.retryAfterMs || 5000);
      } else if (error.code === 404 && error.empty) {
        if (Date.now() - lastSoftLog > 15_000) {
          log(error.message);
          lastSoftLog = Date.now();
        }
        await sleep(2000);
      } else if (error.name === "TimeoutError" || error.name === "AbortError") {
        log("Timeline quá thời gian chờ, thử lại.");
      } else {
        log(error.message);
        await sleep(1000);
      }
    }

    if (Date.now() - lastBeat > 30_000) {
      log(`Vẫn đang theo dõi @${target.handle}.`);
      lastBeat = Date.now();
    }
    const pause = settings.POLL_MS - (Date.now() - started);
    if (pause > 0) await sleep(pause);
  }
  await provider.destroy();
}

function runningAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  const toUrl = (file) => {
    try {
      return pathToFileURL(realpathSync(file)).href;
    } catch {
      return pathToFileURL(file).href;
    }
  };
  return toUrl(fileURLToPath(import.meta.url)) === toUrl(entry);
}

if (runningAsCli()) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
