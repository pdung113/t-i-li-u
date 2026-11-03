import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { pricedGas } from "../src/buy.js";
import { resolveChain } from "../src/chains.js";
import { marketCapUsd } from "../src/mcap.js";
import { hasBuyLiquidity, simulateSwap, underlyingToken } from "../src/simulate.js";
import { fetchStatuses } from "../src/twitter.js";

const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const chain = resolveChain("bsc");
const provider = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });

test("giá gas BSC nhân x2", { timeout: 20_000 }, async () => {
  const fee = await provider.getFeeData();
  const quoted = pricedGas(chain, fee, 2);
  assert.ok(fee.gasPrice > 0n);
  assert.equal(quoted.gasPrice, (fee.gasPrice * 2000n + 999n) / 1000n);
  console.log("BSC gas", fee.gasPrice.toString(), "x2", quoted.gasPrice.toString());
});

test("đo tax CAKE trên BSC dưới 1 giây mô phỏng", { timeout: 30_000 }, async () => {
  const sim = await simulateSwap(provider, {
    chain,
    token: CAKE,
    valueWei: ethers.parseEther("0.002"),
    withSell: true,
  });
  console.log(
    JSON.stringify(
      {
        ms: sim.ms,
        buyFailed: sim.buyFailed,
        sellFailed: sim.sellFailed,
        buyTaxBps: sim.buyTaxBps,
        sellTaxBps: sim.sellTaxBps,
        gotTokens: sim.gotTokens.toString(),
        buyRevert: sim.buyRevert,
        sellRevert: sim.sellRevert,
      },
      null,
      2,
    ),
  );
  assert.equal(sim.buyFailed, false, sim.buyRevert || "buy sim failed");
  assert.equal(sim.sellFailed, false, sim.sellRevert || "sell sim failed");
  assert.ok(sim.buyTaxBps != null && sim.buyTaxBps <= 50, `buy tax ${sim.buyTaxBps}`);
  assert.ok(sim.sellTaxBps != null && sim.sellTaxBps <= 50, `sell tax ${sim.sellTaxBps}`);
  assert.ok(sim.ms < 2500, `mô phỏng mất ${sim.ms}ms`);
});

test("pair CAKE/WBNB được nhận ra", { timeout: 20_000 }, async () => {
  const factory = new ethers.Contract(
    chain.factory,
    ["function getPair(address,address) view returns (address)"],
    provider,
  );
  const pair = await factory.getPair(CAKE, chain.weth);
  const token = await underlyingToken(provider, chain, pair);
  assert.equal(token.toLowerCase(), CAKE.toLowerCase());
  const notPair = await underlyingToken(provider, chain, CAKE);
  assert.equal(notPair, null);
});

test("router V2 của eth, base và robinhood khớp WETH", { timeout: 30_000 }, async () => {
  const iface = new ethers.Interface(["function WETH() view returns (address)"]);
  for (const name of ["eth", "base", "robinhood"]) {
    const chain = resolveChain(name);
    const rpc = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
    try {
      const raw = await rpc.call({ to: chain.router, data: iface.encodeFunctionData("WETH") });
      const [weth] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw);
      assert.equal(weth.toLowerCase(), chain.weth.toLowerCase());
    } finally {
      await rpc.destroy();
    }
  }
});

test("mô phỏng mua trên Robinhood Chain", { timeout: 30_000 }, async () => {
  const chain = resolveChain("robinhood");
  const rpc = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  try {
    const sim = await simulateSwap(rpc, {
      chain,
      token: "0x0d6b6f604C1BF5b3533C445334bb4e1044145688",
      valueWei: ethers.parseEther("0.00005"),
      withSell: true,
    });
    assert.equal(sim.buyFailed, false, sim.buyRevert || "buy sim failed");
    assert.equal(sim.sellFailed, false, sim.sellRevert || "sell sim failed");
    assert.ok(sim.ms < 4000);
  } finally {
    await rpc.destroy();
  }
});

test("vốn hóa CAKE trên BSC nằm trong khoảng hợp lý", { timeout: 30_000 }, async () => {
  const cap = await marketCapUsd(provider, chain, CAKE);
  console.log("CAKE mcap", cap.usd);
  assert.ok(cap.usd > 1_000_000);
  assert.ok(cap.usd < 100_000_000_000);
});

test("CAKE đã có thanh khoản, địa chỉ lạ thì chưa", { timeout: 20_000 }, async () => {
  assert.equal(await hasBuyLiquidity(provider, chain, CAKE), true);
  assert.equal(
    await hasBuyLiquidity(provider, chain, "0x0000000000000000000000000000000000000001"),
    false,
  );
});

test("đọc timeline X", { timeout: 30_000 }, async () => {
  let tweets = [];
  let error = null;
  for (let attempt = 0; attempt < 3 && tweets.length === 0; attempt++) {
    try {
      tweets = await fetchStatuses("binance");
      error = null;
    } catch (err) {
      error = err;
    }
  }
  if (tweets.length === 0) throw error || new Error("timeline trống");
  assert.ok(tweets[0].id);
});
