import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { scheduleFromText } from "../src/nft/schedule.js";
import { resolveNftChain } from "../src/nft/chains.js";
import { runMint } from "../src/nft/run.js";

const nft = "0x6613acc9c313a21ba1e79d35af6564d2f571a54d";
const wallet = "0x4444444444444444444444444444444444444444";

test("trang có lịch mint thì báo đang chờ tới giờ mint", async () => {
  const now = 1_700_000_000;
  const html = `<html><script>window.__PRE={"/api/mint":{"chainId":99901,"name":"TORPOR","collection":"${nft}","phases":[{"key":"A","name":"Tier A","price":"90000000000000000","per_wallet":1,"starts":"2026-11-09T13:00:00Z"},{"key":"public","name":"Public","price":"0","per_wallet":20,"starts":"2099-01-01T00:00:00Z"}]}}</script></html>`;
  const schedule = scheduleFromText(html, "https://torpor.si/mint");
  assert.equal(schedule.collection, ethers.getAddress(nft));
  assert.equal(schedule.chain, "elysium");
  assert.equal(schedule.phases[1].public, true);
  const logs = [];
  const result = await runMint(
    {
      url: "https://torpor.si/mint",
      quantity: 1,
      gasGwei: "1",
      gasLimit: 400_000,
      maxPrice: ethers.parseEther("1"),
      chain: resolveNftChain("base"),
      rpc: "https://base.example",
      apiKey: "",
      dryRun: true,
      wallet,
      signer: null,
    },
    {
      listen: false,
      log: (message) => logs.push(message),
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("/api/proof/")) return { ok: false, status: 403, json: async () => ({ error: "no" }) };
        return { ok: true, text: async () => html, json: async () => ({}) };
      },
      providerFactory: () => ({
        async getCode() {
          return "0x60016000";
        },
        async getBlock() {
          return { timestamp: now };
        },
        async getBalance() {
          return ethers.parseEther("1");
        },
        async call() {
          return "0x";
        },
        async destroy() {},
      }),
    },
  );
  assert.equal(result.chain, "elysium");
  assert.equal(result.rounds.some((round) => round.label === "Public"), true);
  assert.match(logs.join("\n"), /Đang chờ tới giờ mint Public/);
});

test("web cùng kiểu tự lấy contract, đủ tier nào thì chờ tier đó", async () => {
  const now = 1_700_000_000;
  const proof = `0x${"ab".repeat(32)}`;
  const html = JSON.stringify({
    contract: nft,
    chainId: 99901,
    stages: [
      { key: "A", name: "Tier A", price: "0", per_wallet: 1, startTime: now + 3600 },
      { key: "public", name: "Public", price: "0", per_wallet: 2, startTime: now + 7200 },
    ],
  });
  const logs = [];
  const result = await runMint(
    {
      url: "https://mint.example/drop",
      quantity: 1,
      gasGwei: "1",
      gasLimit: 400_000,
      maxPrice: ethers.parseEther("1"),
      chain: null,
      rpc: "",
      apiKey: "",
      dryRun: true,
      wallet,
      signer: null,
    },
    {
      listen: false,
      log: (message) => logs.push(message),
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("/api/proof/")) {
          return { ok: true, json: async () => ({ tier: "A", proof: [proof] }) };
        }
        return { ok: true, text: async () => html, json: async () => JSON.parse(html) };
      },
      providerFactory: () => ({
        async getCode() {
          return "0x60016000";
        },
        async getBlock() {
          return { timestamp: now };
        },
        async getBalance() {
          return ethers.parseEther("1");
        },
        async call() {
          return "0x";
        },
        async destroy() {},
      }),
    },
  );
  assert.equal(result.chain, "elysium");
  assert.deepEqual(result.rounds.map((round) => round.label), ["Tier A", "Public"]);
  const text = logs.join("\n");
  assert.match(text, new RegExp(ethers.getAddress(nft)));
  assert.match(text, /Ví đủ điều kiện Tier A\. Đang chờ tới giờ mint Tier A/);
  assert.match(text, /Ví đủ điều kiện Public\. Đang chờ tới giờ mint Public/);
});
