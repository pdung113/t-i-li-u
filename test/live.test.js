import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { resolveChain } from "../src/chains.js";
import { simulateSwap, underlyingToken } from "../src/simulate.js";
import { fetchStatuses } from "../src/twitter.js";

const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const chain = resolveChain("bsc");
const provider = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });

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
