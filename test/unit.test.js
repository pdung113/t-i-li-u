import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { buildBuyTx, minOutFromReceived } from "../src/buy.js";
import { resolveChain } from "../src/chains.js";
import { decide, formatTax, taxBps } from "../src/decide.js";
import { parseSimulateResult } from "../src/simulate.js";
import { main } from "../src/index.js";
import { fdvUsd, formatUsd, mcapDecision } from "../src/mcap.js";
import { buildConfig, parseSetup } from "../src/setup.js";
import { extractAddresses, parseTwitterTarget } from "../src/twitter.js";

test("main nhận link và từ chối link lạ", async () => {
  const previous = process.exitCode;
  await main([]);
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
  await assert.rejects(() => main(["https://example.com/foo"]), /Không phải link X/);
});

test("chain eth, base, robinhood", async () => {
  assert.equal(resolveChain("eth").chainId, 1);
  assert.equal(resolveChain("ethereum").name, "eth");
  assert.equal(resolveChain("base").chainId, 8453);
  assert.equal(resolveChain("robinhood").chainId, 4663);
  assert.equal(resolveChain("rh").name, "robinhood");
  assert.equal(resolveChain("robinhood").weth, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  await assert.rejects(() => main(["--chain", "nope", "https://x.com/foo"]), /Chain không hỗ trợ/);
});

test("setup.txt và ngưỡng vốn hóa", () => {
  const values = parseSetup(`
# ghi chú
CHAIN=base
LINK=https://x.com/abc
BUY_AMOUNT=0.02
MAX_TAX_PERCENT=5
MAX_MCAP_USD=50000
DRY_RUN=false
`);
  const config = buildConfig(values);
  assert.equal(config.chain.name, "base");
  assert.equal(config.link, "https://x.com/abc");
  assert.equal(config.buyAmount, "0.02");
  assert.equal(config.maxTaxPercent, 5);
  assert.equal(config.maxMcapUsd, 50000);
  assert.equal(config.dryRun, false);
  assert.equal(config.mode, "twitter");
  assert.throws(() => buildConfig({ MODE: "liquid", CHAIN: "bsc" }), /CONTRACT/);
  const liquid = buildConfig({
    MODE: "liquid",
    CHAIN: "robinhood",
    CONTRACT: "0x0d6b6f604c1bf5b3533c445334bb4e1044145688",
  });
  assert.equal(liquid.mode, "liquid");
  assert.equal(liquid.contract, "0x0d6b6f604C1BF5b3533C445334bb4e1044145688");
  assert.equal(liquid.liquidPollMs, 250);
  assert.equal(buildConfig({ MODE: "tw", CHAIN: "bsc" }).mode, "twitter");
  assert.throws(() => buildConfig({ MODE: "spot", CHAIN: "bsc" }), /MODE/);
  assert.equal(mcapDecision(50000, 50000).ok, true);
  assert.equal(mcapDecision(50001, 50000).reason, "too_high");
  assert.equal(mcapDecision(null, 50000).retry, true);
  assert.equal(mcapDecision(999999, 0).ok, true);

  const supply = 1_000_000n * 10n ** 18n;
  const tokenReserve = supply;
  const nativeReserve = 10n ** 18n;
  const price = 2_000n * 10n ** 8n;
  assert.equal(fdvUsd(supply, tokenReserve, nativeReserve, price), 2000);
  assert.equal(formatUsd(100000), "100.0k");
});

test("parse link X", () => {
  assert.deepEqual(parseTwitterTarget("https://x.com/Some_Proj"), { handle: "Some_Proj", statusId: null });
  assert.deepEqual(parseTwitterTarget("https://twitter.com/Some_Proj/status/1234567890123456789?s=20"), {
    handle: "Some_Proj",
    statusId: "1234567890123456789",
  });
  assert.deepEqual(parseTwitterTarget("@abc"), { handle: "abc", statusId: null });
  assert.throws(() => parseTwitterTarget("https://example.com/foo"), /Không phải link X/);
});

test("lấy contract trong tweet, bỏ địa chỉ trong bio", () => {
  const tweet = {
    id: "1",
    text: "CA: 0x000000000000000000000000000000000000dEaD",
    raw_text: { text: "CA: 0x000000000000000000000000000000000000dEaD" },
    author: { description: "old 0x1111111111111111111111111111111111111111" },
  };
  assert.deepEqual(extractAddresses(tweet), ["0x000000000000000000000000000000000000dEaD"]);
});

test("tax và quyết định mua", () => {
  assert.equal(taxBps(1000n, 900n), 1000);
  assert.equal(taxBps(1000n, 1000n), 0);
  assert.equal(taxBps(1000n, 1100n), 0);
  assert.equal(taxBps(0n, 1n), null);
  assert.equal(formatTax(1050), "10.50%");

  const ok = decide(
    { buyFailed: false, sellFailed: false, buyTaxBps: 500, sellTaxBps: 800, gotTokens: 10n },
    10,
  );
  assert.equal(ok.ok, true);

  const high = decide(
    { buyFailed: false, sellFailed: false, buyTaxBps: 500, sellTaxBps: 2500, gotTokens: 10n },
    10,
  );
  assert.equal(high.ok, false);
  assert.equal(high.terminal, true);
  assert.equal(high.reason, "sell_tax_cao");

  const retry = decide(
    { buyFailed: true, sellFailed: true, buyTaxBps: null, sellTaxBps: null, gotTokens: 0n },
    10,
  );
  assert.equal(retry.terminal, false);

  const honeypot = decide(
    { buyFailed: false, sellFailed: true, buyTaxBps: 100, sellTaxBps: null, gotTokens: 5n },
    10,
  );
  assert.equal(honeypot.reason, "khong_ban_duoc");
  assert.equal(honeypot.terminal, true);
});

test("đọc kết quả mô phỏng", () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const quote = coder.encode(["uint256[]"], [[ethers.parseEther("1"), 1000n]]);
  const balBefore = coder.encode(["uint256"], [0n]);
  const balAfter = coder.encode(["uint256"], [900n]);
  const sell = coder.encode(["uint256", "uint256", "uint256"], [ethers.parseEther("0.001"), ethers.parseEther("0.0008"), 900n]);
  const parsed = parseSimulateResult(
    [
      {
        calls: [
          { status: "0x1", returnData: quote },
          { status: "0x1", returnData: balBefore },
          { status: "0x1", returnData: "0x" },
          { status: "0x1", returnData: balAfter },
        ],
      },
      { calls: [{ status: "0x1", returnData: sell }] },
    ],
    { withSell: true },
  );
  assert.equal(parsed.buyFailed, false);
  assert.equal(parsed.gotTokens, 900n);
  assert.equal(parsed.buyTaxBps, 1000);
  assert.equal(parsed.sellFailed, false);
  assert.equal(parsed.sellTaxBps, 2000);
});

test("minOut và tx mua BSC dùng gas legacy", async () => {
  assert.equal(minOutFromReceived(10_000n, 15), 8500n);
  const chain = resolveChain("bsc");
  const tx = buildBuyTx({
    chain,
    token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    walletAddress: "0x0000000000000000000000000000000000000001",
    valueWei: ethers.parseEther("0.05"),
    minOut: 8500n,
    gasGwei: "3",
    gasLimit: 500_000,
    nonce: 4,
    deadline: 1_700_000_000n,
  });
  assert.equal(tx.type, 0);
  assert.equal(tx.gasPrice, ethers.parseUnits("3", "gwei"));
  assert.equal(tx.value, ethers.parseEther("0.05"));
  assert.equal(tx.nonce, 4);

  const wallet = new ethers.Wallet(`0x${"11".repeat(32)}`);
  const raw = await wallet.signTransaction(tx);
  const parsed = ethers.Transaction.from(raw);
  assert.equal(parsed.to, chain.router);
  assert.equal(parsed.value, ethers.parseEther("0.05"));
  assert.equal(parsed.gasPrice, ethers.parseUnits("3", "gwei"));
});
