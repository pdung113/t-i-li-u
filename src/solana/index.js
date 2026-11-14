import "dotenv/config";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { pathToFileURL } from "node:url";
import { loadSolanaConfig } from "./config.js";
import { detectBuy, formatLamports, overImpact, priceImpactPercent } from "./detect.js";
import { log } from "../log.js";
import * as settings from "./settings.js";
import {
  assembleSwapTransaction,
  broadcastTransaction,
  fetchBuild,
  pickTipAccount,
  transactionBytes,
  waitForLanding,
} from "./swap.js";
import { watchWallet } from "./watch.js";

function short(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}

async function buildSized(config, mint) {
  let lastError;
  for (const maxBytes of [1050, 800]) {
    const build = await fetchBuild({
      apiKey: config.jupiterKey,
      taker: config.keypair.publicKey.toBase58(),
      mint,
      lamports: config.buyLamports,
      slippageBps: settings.SLIPPAGE_BPS,
      maxBytes,
    });
    if (overImpact(build, settings.MAX_PRICE_IMPACT_PERCENT)) {
      return { build, skipped: "impact" };
    }
    const unsigned = assembleSwapTransaction({
      build,
      payer: config.keypair.publicKey,
      cuLimit: settings.CU_LIMIT,
      jitoTipLamports: settings.JITO_TIP_LAMPORTS,
      tipAccount: pickTipAccount(),
    });
    const raw = transactionBytes(unsigned);
    if (raw.length <= 1232) return { build, unsigned };
    lastError = new Error(`lệnh dài ${raw.length} byte`);
  }
  throw lastError || new Error("Không dựng được lệnh vừa kích thước");
}

async function copyBuy(config, connection, buy) {
  const started = Date.now();
  if (!config.keypair) {
    log(`DRY RUN. Thấy mua ${short(buy.mint)} trong ${buy.signature}. Chưa có SOLANA_PRIVATE_KEY nên chưa dựng lệnh.`);
    return true;
  }
  const sized = await buildSized(config, buy.mint);
  const impact = priceImpactPercent(sized.build);
  const impactText = impact == null ? "" : ` impact ${impact.toFixed(2)}%.`;
  if (sized.skipped === "impact") {
    log(`Bỏ qua ${short(buy.mint)}:${impactText} Trần ${settings.MAX_PRICE_IMPACT_PERCENT}%.`);
    return true;
  }
  if (config.dryRun) {
    log(
      `DRY RUN. Sẽ mua ${settings.BUY_SOL} SOL ${short(buy.mint)}, tối thiểu nhận ${sized.build.otherAmountThreshold}.${impactText} Không gửi. ${Date.now() - started}ms.`,
    );
    return true;
  }

  const tx = sized.unsigned;
  tx.sign([config.keypair]);
  const signature = bs58.encode(tx.signatures[0]);
  const raw = tx.serialize();
  const sent = await broadcastTransaction(raw, {
    rpcUrl: config.rpc,
    useJito: settings.JITO_TIP_LAMPORTS > 0,
    jitoUuid: config.jitoUuid,
  });
  log(
    `Đã gửi ${signature} sau ${Date.now() - started}ms, sau lệnh ${buy.signature}. ${sent.accepted}/${sent.total} đường nhận.`,
  );
  const landing = await waitForLanding(connection, signature);
  if (landing.ok) {
    log(`Lệnh vào block (${landing.status}): https://solscan.io/tx/${signature}`);
    return true;
  }
  if (landing.err === "timeout") {
    log(`Đã gửi https://solscan.io/tx/${signature}. RPC chưa xác nhận kịp.`);
    return true;
  }
  log(`Lệnh ${signature} lỗi: ${JSON.stringify(landing.err)}`);
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const targetArg = argv.find((arg) => !arg.startsWith("--"));
  if (!targetArg) {
    console.log("Cách dùng: npm run copy -- <địa chỉ ví Solana>");
    console.log("Ví dụ:    npm run copy -- 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    console.log("Chỉnh số SOL, trượt giá, và tip trong src/solana/settings.js");
    console.log("Mặc định chỉ in lệnh. Muốn mua thật thì DRY_RUN=false và điền SOLANA_PRIVATE_KEY.");
    process.exitCode = 1;
    return;
  }

  const config = loadSolanaConfig(targetArg);
  const connection = new Connection(config.rpc, "processed");
  log(
    `Theo dõi ${config.target} | mua ${settings.BUY_SOL} SOL sau lệnh của họ | trượt ${settings.SLIPPAGE_BPS / 100}% | tip ${formatLamports(settings.JITO_TIP_LAMPORTS)} SOL | ${config.dryRun ? "DRY RUN" : "MUA THẬT"}`,
  );
  log(`RPC ${config.rpc}`);
  if (!config.helius) {
    log("Chưa có HELIUS_API_KEY. Tool vẫn nghe được, nhưng Helius transactionSubscribe thấy lệnh sớm hơn.");
  }
  if (config.keypair) {
    const balance = await connection.getBalance(config.keypair.publicKey);
    log(`Ví ${config.keypair.publicKey.toBase58()} | số dư ${formatLamports(balance)} SOL`);
    const reserve = config.buyLamports + BigInt(settings.JITO_TIP_LAMPORTS) + 5_000_000n;
    if (!config.dryRun && BigInt(balance) < reserve) {
      log("Cảnh báo: số dư có thể không đủ cho số mua + tip + phí. Dùng ví riêng, chỉ nạp số chấp nhận mất.");
    }
  } else {
    log("Chưa có SOLANA_PRIVATE_KEY. Tool báo khi ví kia mua, chưa dựng lệnh swap.");
  }

  const seen = new Set();
  const bought = new Set();
  const inflight = new Set();
  let buyCount = 0;
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const onTransaction = (tx) => {
    if (!tx?.signature || seen.has(tx.signature)) return;
    seen.add(tx.signature);
    const buy = detectBuy(tx, config.target, { minSolLamports: config.minSolLamports });
    if (!buy) return;
    if (settings.COPY_ONCE_PER_MINT && (bought.has(buy.mint) || inflight.has(buy.mint))) {
      log(`Bỏ qua ${short(buy.mint)}: mint này đã được mua trong phiên.`);
      return;
    }
    if (buyCount >= settings.MAX_BUYS) {
      log(`Đã đủ ${settings.MAX_BUYS} lệnh mua. Không mua thêm.`);
      return;
    }
    inflight.add(buy.mint);
    log(
      `Ví mục tiêu mua ${buy.mint}. Tiêu ${formatLamports(buy.solSpent)} SOL. https://solscan.io/tx/${buy.signature}`,
    );
    enqueue(async () => {
      try {
        const ok = await copyBuy(config, connection, buy);
        if (ok && settings.COPY_ONCE_PER_MINT) bought.add(buy.mint);
        if (ok && !config.dryRun) buyCount += 1;
      } catch (error) {
        log(`Không mua ${short(buy.mint)}: ${error.message}`);
      } finally {
        inflight.delete(buy.mint);
      }
    });
  };

  const stopWatch = watchWallet({
    wsUrl: config.ws,
    rpcUrl: config.rpc,
    target: config.target,
    onTransaction,
    log,
  });
  const beat = setInterval(() => log(`Vẫn đang theo dõi ${short(config.target)}.`), 30_000);
  beat.unref?.();
  const stop = () => {
    clearInterval(beat);
    stopWatch();
  };
  process.on("SIGINT", () => {
    log("Dừng.");
    stop();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
