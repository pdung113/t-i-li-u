import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
import { buildBuyTx, minOutFromReceived } from "./buy.js";
import { REASON_TEXT, decide, formatTax } from "./decide.js";
import { log } from "./log.js";
import { formatUsd, marketCapUsd, mcapDecision } from "./mcap.js";
import { loadConfig } from "./setup.js";
import { SIM_EOA, describePool, hasBuyLiquidity, simulateSwap, underlyingToken } from "./simulate.js";
import { extractAddresses, fetchStatus, fetchStatuses, parseTwitterTarget, tweetTimestamp } from "./twitter.js";

const DEAD = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function isBlacklisted(chain, address) {
  const key = address.toLowerCase();
  if (DEAD.has(key)) return true;
  return chain.blacklist.some((item) => item.toLowerCase() === key);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluateToken(provider, config, token, nowSec) {
  const sameSize = config.probeWei === config.buyWei;
  const base = { chain: config.chain, token, nowSec, eoa: SIM_EOA };
  let [probe, full] = await Promise.all([
    simulateSwap(provider, { ...base, valueWei: config.probeWei, withSell: true }),
    sameSize
      ? Promise.resolve(null)
      : simulateSwap(provider, { ...base, valueWei: config.buyWei, withSell: false }),
  ]);

  if (probe.buyFailed && full && !full.buyFailed) {
    probe = await simulateSwap(provider, { ...base, valueWei: config.buyWei, withSell: true });
    full = probe;
  }

  const decision = decide(probe, config.maxTaxPercent);
  const fill = full && !full.buyFailed ? full : probe;
  return { probe, full, fill, decision };
}

async function inspectToken(config, tokenArg) {
  if (!tokenArg || !/^0x[a-fA-F0-9]{40}$/.test(tokenArg)) {
    throw new Error("Dùng: npm start -- --token 0x...");
  }
  const provider = new ethers.JsonRpcProvider(config.rpc, config.chain.chainId, { staticNetwork: true });
  try {
    const block = await provider.getBlock("latest");
    const now = Number(block.timestamp);
    const token = ethers.getAddress(tokenArg);
    const started = Date.now();
    const [{ probe, full, fill, decision }, cap] = await Promise.all([
      evaluateToken(provider, config, token, now),
      config.maxMcapUsd > 0 ? marketCapUsd(provider, config.chain, token).catch(() => null) : Promise.resolve(null),
    ]);
    const symbol = config.chain.nativeSymbol;
    const capNote = cap?.usd != null ? ` | mcap $${formatUsd(cap.usd)}` : "";
    log(
      `${token} buy ${formatTax(probe.buyTaxBps)} sell ${formatTax(probe.sellTaxBps)}${capNote} | ${REASON_TEXT[decision.reason] || decision.reason} | ${Date.now() - started}ms`,
    );
    if (probe.buyRevert) log(`Buy revert: ${probe.buyRevert}`);
    if (probe.sellRevert) log(`Sell revert: ${probe.sellRevert}`);
    const gate = mcapDecision(cap?.usd ?? null, config.maxMcapUsd);
    if (full?.buyFailed) {
      log(`Khối lượng ${config.buyAmount} ${symbol} không mua được trong mô phỏng.`);
    } else if (decision.ok && !gate.ok && !gate.retry) {
      log(`Vốn hóa $${formatUsd(cap.usd)} lớn hơn $${formatUsd(config.maxMcapUsd)}. Lệnh kiểm tra này không gửi giao dịch.`);
    } else if (decision.ok && gate.ok) {
      const minOut = minOutFromReceived(fill.gotTokens, config.slippagePercent);
      log(`Trong ngưỡng tax ${config.maxTaxPercent}% và mcap. minOut ${minOut}. Lệnh kiểm tra này không gửi giao dịch.`);
    }
  } finally {
    await provider.destroy();
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const tokenIdx = argv.indexOf("--token");
  const tokenArg = tokenIdx >= 0 ? argv[tokenIdx + 1] : null;
  const chainIdx = argv.indexOf("--chain");
  const chainArg = chainIdx >= 0 ? argv[chainIdx + 1] : null;
  const skip = new Set();
  if (tokenIdx >= 0) skip.add(tokenIdx + 1);
  if (chainIdx >= 0) skip.add(chainIdx + 1);
  const targetArg = argv.find((arg, index) => !arg.startsWith("--") && !skip.has(index));
  if (chainIdx >= 0 && !chainArg) {
    throw new Error("Thiếu tên chain sau --chain. Dùng bsc, eth, base, hoặc robinhood.");
  }

  const config = loadConfig(chainArg, options.setupText);
  if (tokenIdx !== -1) {
    await inspectToken(config, tokenArg);
    return;
  }
  let target = null;
  if (config.mode === "twitter") {
    const targetSource = targetArg || config.link;
    if (!targetSource) {
      console.log("MODE=twitter: mở setup.txt, điền LINK, lưu file, rồi chạy: npm start");
      process.exitCode = 1;
      return;
    }
    target = parseTwitterTarget(targetSource);
  }
  if (!config.dryRun && !config.privateKey) {
    throw new Error("Điền PRIVATE_KEY trong setup.txt, hoặc giữ DRY_RUN=true");
  }

  const provider = new ethers.JsonRpcProvider(config.rpc, config.chain.chainId, { staticNetwork: true });
  const wallet = config.privateKey ? new ethers.Wallet(config.privateKey, provider) : null;

  let timeOffset = 0;
  const syncClock = async () => {
    const block = await provider.getBlock("latest");
    timeOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
  };
  await syncClock();
  const clockTimer = setInterval(() => {
    syncClock().catch(() => {});
  }, 15_000);
  clockTimer.unref?.();
  const nowSec = () => Math.floor(Date.now() / 1000) + timeOffset;

  const symbol = config.chain.nativeSymbol;
  log(
    `Chế độ ${config.mode} | chain ${config.chain.name} | mua ${config.buyAmount} ${symbol} | gas ${config.gasGwei} gwei | tax tối đa ${config.maxTaxPercent}% | mcap tối đa ${config.maxMcapUsd > 0 ? `$${formatUsd(config.maxMcapUsd)}` : "không giới hạn"} | ${config.dryRun ? "DRY RUN" : "MUA THẬT"}`,
  );
  log(`RPC ${config.rpc}`);
  if (config.mode === "twitter") {
    log(`Theo dõi @${target.handle}${target.statusId ? ` tweet ${target.statusId}` : ""}`);
  } else {
    log(`Chờ add liquidity hoặc mở trade của ${config.contract}`);
  }
  if (wallet) {
    const balance = await provider.getBalance(wallet.address);
    const gasCap = ethers.parseUnits(String(config.gasGwei), "gwei") * BigInt(config.gasLimit);
    log(`Ví ${wallet.address} | số dư ${ethers.formatEther(balance)} ${symbol}`);
    if (!config.dryRun && balance < config.buyWei + gasCap) {
      log("Cảnh báo: số dư có thể không đủ cho số mua + trần gas. Dùng ví riêng, chỉ nạp số chấp nhận mất.");
    }
  } else {
    log("Chưa có PRIVATE_KEY trong setup.txt — chỉ mô phỏng, không gửi lệnh.");
  }

  const seenTweets = new Set();
  const handledTokens = new Set();
  let since = 0;
  let bootstrapped = false;
  let queue = Promise.resolve();
  let lastBeat = Date.now();
  let stopped = false;

  const stop = () => {
    stopped = true;
    clearInterval(clockTimer);
  };
  process.on("SIGINT", () => {
    log("Dừng.");
    stop();
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

  const snipe = async (rawAddress, tweet, options = {}) => {
    let token = ethers.getAddress(rawAddress);
    const mark = token.toLowerCase();
    if (handledTokens.has(mark)) return;
    handledTokens.add(mark);

    const waitForever = options.waitForever === true;
    const detectedAt = Date.now();
    const fromLiquid = tweet?.id === "liquid";
    if (!fromLiquid) log(`Contract ${token} từ tweet ${tweet.id}. Đang đo tax...`);

    const until = waitForever ? Number.POSITIVE_INFINITY : detectedAt + config.waitForPairMs;
    let attempt = 0;
    let sawLiquidity = false;
    let reported = false;
    let lastWaitLog = 0;
    while (!stopped && Date.now() < until) {
      attempt += 1;
      if (waitForever && !sawLiquidity) {
        const ready = await hasBuyLiquidity(provider, config.chain, token);
        if (!ready) {
          if (Date.now() - lastWaitLog > 15_000) {
            log(`Chưa có thanh khoản ${token}. Vẫn đang chờ add liquidity...`);
            lastWaitLog = Date.now();
          }
          await sleep(config.liquidPollMs);
          continue;
        }
        sawLiquidity = true;
        log(`Đã có thanh khoản ${token}. Đo tax và mua ngay.`);
      }
      const noncePromise =
        wallet && !config.dryRun ? provider.getTransactionCount(wallet.address, "pending") : Promise.resolve(null);
      let result;
      try {
        result = await evaluateToken(provider, config, token, nowSec());
      } catch (error) {
        log(`Mô phỏng lỗi: ${error.shortMessage || error.message}`);
        await sleep(config.retryMs);
        continue;
      }

      if (result.probe.buyFailed) {
        const underlying = await underlyingToken(provider, config.chain, token);
        if (underlying) {
          const next = ethers.getAddress(underlying);
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
          try {
            result = await evaluateToken(provider, config, token, nowSec());
          } catch (error) {
            log(`Mô phỏng lỗi: ${error.shortMessage || error.message}`);
            await sleep(config.retryMs);
            continue;
          }
        }
      }

      const { probe, full, fill, decision } = result;
      const sizeNote = full && full !== probe ? ` | lệnh ${config.buyAmount} ${symbol} ${full.buyFailed ? "không mua được" : "mua được"}` : "";
      if (!reported || decision.terminal || decision.ok) {
        reported = true;
        log(
          `Tax buy ${formatTax(probe.buyTaxBps)} sell ${formatTax(probe.sellTaxBps)} trong ${probe.ms}ms.${probe.buyRevert ? ` Buy: ${probe.buyRevert}.` : ""}${probe.sellRevert ? ` Sell: ${probe.sellRevert}.` : ""}${sizeNote}`,
        );
      }

      if (decision.ok && full?.buyFailed) {
        log(`Không mua ${config.buyAmount} ${symbol}: pool không nhận khối lượng này. Giảm BUY_AMOUNT trong setup.txt.`);
        return;
      }

      if (!decision.ok) {
        if (!decision.terminal) {
          const pool = await describePool(provider, config.chain, token);
          log(`Chưa vào lệnh (${pool}). Thử lại...`);
          await sleep(config.retryMs);
          continue;
        }
        log(`Không mua: ${REASON_TEXT[decision.reason] || decision.reason}.`);
        return;
      }

      if (config.maxMcapUsd > 0) {
        let cap;
        try {
          cap = await marketCapUsd(provider, config.chain, token);
        } catch (error) {
          log(`Không đo được vốn hóa: ${error.shortMessage || error.message}`);
          await sleep(config.retryMs);
          continue;
        }
        const gate = mcapDecision(cap.usd, config.maxMcapUsd);
        if (!gate.ok && gate.retry) {
          log("Chưa có giá để tính vốn hóa. Thử lại...");
          await sleep(config.retryMs);
          continue;
        }
        if (!gate.ok) {
          log(`Không mua: vốn hóa $${formatUsd(cap.usd)} lớn hơn $${formatUsd(config.maxMcapUsd)}.`);
          return;
        }
        log(`Vốn hóa $${formatUsd(cap.usd)}, trong ngưỡng $${formatUsd(config.maxMcapUsd)}.`);
      }

      const minOut = minOutFromReceived(fill.gotTokens, config.slippagePercent);
      const deadline = BigInt(nowSec() + 180);
      if (config.dryRun || !wallet) {
        log(
          `DRY RUN khớp. Sẽ mua ${config.buyAmount} ${symbol}, minOut ${minOut}, gas ${config.gasGwei} gwei. Từ lúc thấy contract: ${Date.now() - detectedAt}ms.`,
        );
        return;
      }

      const nonce = await noncePromise;
      const tx = buildBuyTx({
        chain: config.chain,
        token,
        walletAddress: wallet.address,
        valueWei: config.buyWei,
        minOut,
        gasGwei: config.gasGwei,
        gasLimit: config.gasLimit,
        nonce,
        deadline,
      });
      const raw = await wallet.signTransaction(tx);
      const sent = await provider.broadcastTransaction(raw);
      const elapsed = Date.now() - detectedAt;
      log(`Đã gửi ${sent.hash} sau ${elapsed}ms.`);
      if (elapsed > 1000) {
        log("Lệnh vượt 1s kể từ lúc đọc được contract. Dùng RPC riêng nếu cần nhanh hơn.");
      }
      return;
    }

    if (!stopped) log(`Hết ${Math.round(config.waitForPairMs / 1000)}s, không mua ${token}.`);
  };

  if (config.mode === "liquid") {
    await snipe(config.contract, { id: "liquid" }, { waitForever: true });
    stop();
    await provider.destroy();
    return;
  }

  if (target.statusId) {
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
      const fresh = tweetTimestamp(tweet) >= nowUnix - config.lookbackSec;
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
  }

  while (!stopped) {
    const started = Date.now();
    try {
      const tweets = await fetchStatuses(target.handle, {
        since: bootstrapped && since ? since : undefined,
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
        log("Timeline bị giới hạn tốc độ, chờ 5s.");
        await sleep(5000);
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
    const pause = config.pollMs - (Date.now() - started);
    if (pause > 0) await sleep(pause);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
