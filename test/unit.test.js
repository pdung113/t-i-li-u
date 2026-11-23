import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { buildBuyTx, gasShortfall, minOutFromReceived } from "../src/buy.js";
import { resolveChain } from "../src/chains.js";
import { decide, formatTax, taxBps } from "../src/decide.js";
import { parseCli, main } from "../src/index.js";
import { parseSimulateResult, redirectFromPair } from "../src/simulate.js";
import { authorHandle, extractAddresses, fetchStatuses, parseTwitterTarget, readTimelineBody } from "../src/twitter.js";

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

test("parse link X", () => {
  assert.deepEqual(parseTwitterTarget("https://x.com/Some_Proj"), { handle: "Some_Proj", statusId: null });
  assert.deepEqual(parseTwitterTarget("https://twitter.com/Some_Proj/status/1234567890123456789?s=20"), {
    handle: "Some_Proj",
    statusId: "1234567890123456789",
  });
  assert.deepEqual(parseTwitterTarget("@abc"), { handle: "abc", statusId: null });
  assert.deepEqual(parseTwitterTarget("https://x.com/i/web/status/20"), { handle: null, statusId: "20" });
  assert.deepEqual(parseTwitterTarget("https://twitter.com/i/status/20"), { handle: null, statusId: "20" });
  assert.equal(authorHandle({ author: { screen_name: "jack" } }), "jack");
  assert.throws(() => parseTwitterTarget("https://example.com/foo"), /Không phải link X/);
  assert.throws(() => parseTwitterTarget("https://x.com/i/flow"), /không phải trang dự án/);
});

test("lấy contract trong tweet, bỏ địa chỉ trong bio", () => {
  const tweet = {
    id: "1",
    text: "CA: 0x000000000000000000000000000000000000dEaD",
    raw_text: { text: "CA: 0x000000000000000000000000000000000000dEaD" },
    author: { description: "old 0x1111111111111111111111111111111111111111" },
  };
  assert.deepEqual(extractAddresses(tweet), ["0x000000000000000000000000000000000000dEaD"]);

  const tx = `0x${"ab".repeat(32)}`;
  const ca = "0x2222222222222222222222222222222222222222";
  assert.deepEqual(extractAddresses({ text: `tx ${tx} ca ${ca}` }), [ca]);
  assert.deepEqual(extractAddresses({ text: `${ca}abcd` }), []);
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

  const unread = decide(
    { buyFailed: false, balanceRead: false, sellFailed: false, buyTaxBps: null, sellTaxBps: null, gotTokens: 0n },
    10,
  );
  assert.equal(unread.terminal, false);
  assert.equal(unread.reason, "khong_doc_duoc_so_du");
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
  assert.equal(parsed.balanceRead, true);

  const unread = parseSimulateResult(
    [
      {
        calls: [
          { status: "0x1", returnData: quote },
          { status: "0x0", returnData: "0x" },
          { status: "0x1", returnData: "0x" },
          { status: "0x0", returnData: "0x" },
        ],
      },
    ],
    { withSell: false },
  );
  assert.equal(unread.balanceRead, false);
  assert.equal(unread.buyFailed, false);
  assert.equal(unread.gotTokens, 0n);
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

test("gas thấp hơn mạng và pair không bị mua nhầm", () => {
  const low = gasShortfall({
    eip1559: true,
    gasGwei: "3",
    baseFeePerGas: ethers.parseUnits("20", "gwei"),
    networkGasPrice: 0n,
  });
  assert.ok(low);
  assert.equal(
    gasShortfall({ eip1559: false, gasGwei: "3", baseFeePerGas: 0n, networkGasPrice: ethers.parseUnits("1", "gwei") }),
    null,
  );
  const pair = "0x0eD7e52944161450477ee417DE9Cd3a859b14fD0";
  const cake = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
  assert.equal(redirectFromPair(pair, cake), cake);
  assert.equal(redirectFromPair(cake, null), null);
  assert.equal(redirectFromPair(cake, cake), null);
});

test("cờ dòng lệnh", () => {
  assert.deepEqual(parseCli(["--chain", "bsc", "https://x.com/foo"]), {
    help: false,
    chain: "bsc",
    token: null,
    target: "https://x.com/foo",
  });
  assert.equal(parseCli(["--chain=eth", "--token=0x1111111111111111111111111111111111111111"]).chain, "eth");
  assert.throws(() => parseCli(["--chain", "https://x.com/foo"]), /Thiếu tên chain/);
  assert.throws(() => parseCli(["--chain"]), /Thiếu tên chain/);
  assert.throws(() => parseCli(["--nope", "https://x.com/foo"]), /Cờ không hỗ trợ/);
  assert.equal(parseCli(["--help"]).help, true);
});

test("timeline trống và since exclusive", async () => {
  assert.throws(() => readTimelineBody("abc", 404, { results: [] }), (error) => error.empty === true);
  assert.deepEqual(readTimelineBody("abc", 200, { results: [{ id: "1", text: "hi" }] }), [{ id: "1", text: "hi" }]);
  assert.throws(() => readTimelineBody("abc", 200, { code: 200 }), /thiếu results/);

  const original = globalThis.fetch;
  let seen = "";
  let seenUa = "";
  globalThis.fetch = async (url, opts) => {
    seen = String(url);
    seenUa = opts?.headers?.["user-agent"] || "";
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const tweets = await fetchStatuses("binance", { since: 100 });
    assert.deepEqual(tweets, []);
    const query = new URL(seen);
    assert.equal(query.searchParams.get("since"), "99");
    assert.match(query.pathname, /\/binance\/statuses$/);
    assert.match(seenUa, /Mozilla\/5\.0/);
  } finally {
    globalThis.fetch = original;
  }
});
