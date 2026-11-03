import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { buildBuyTx, minOutFromReceived } from "../src/buy.js";
import { resolveChain } from "../src/chains.js";
import { decide, formatTax, taxBps } from "../src/decide.js";
import { parseSimulateResult } from "../src/simulate.js";
import { main } from "../src/index.js";
import { extractAddresses, parseTwitterTarget } from "../src/twitter.js";

test("main nhận link và từ chối link lạ", async () => {
  const previous = process.exitCode;
  await main([]);
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
  await assert.rejects(() => main(["https://example.com/foo"]), /Không phải link X/);
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
