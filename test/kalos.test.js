import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { seaDropIface } from "../src/nft/abi.js";
import { kalosAllowEntries } from "../src/nft/kalos.js";
import { seaDropLeaf } from "../src/nft/merkle.js";
import { parseMarketUrl } from "../src/nft/parse.js";
import { runMint } from "../src/nft/run.js";
import { resolveNftChain } from "../src/nft/chains.js";

const nft = "0x4A19D4108Faec0FB0567fCC386a24A6a7E677809";
const sea = "0xCa10569ec3EdA292f435041d7610150e53119BaE";
const creator = "0xa0BC9A9e2d8D05eCc9491f8cB5C2cb06334F353D";
const fee = "0xcA105395094Ceb27e6AfdA492c6379cBF468CDb8";
const wallet = "0x4444444444444444444444444444444444444444";

test("link Kalos lấy slug và chain elysium", () => {
  const parsed = parseMarketUrl("https://www.kalos.fun/mint/slymz-crew");
  assert.equal(parsed.kind, "kalos");
  assert.equal(parsed.slug, "slymz-crew");
  assert.equal(parsed.chain, "elysium");
  assert.equal(kalosAllowEntries({ published: false, rootIsKalos: true, entries: [{}] }).length, 0);
});

test("trang Kalos mint public và allowlist trên SeaDrop", async () => {
  const now = 1_700_000_000;
  const allow = {
    mintPrice: 0n,
    maxTotalMintableByWallet: 1n,
    startTime: BigInt(now - 100),
    endTime: BigInt(now + 3600),
    dropStageIndex: 1n,
    maxTokenSupplyForStage: 1527n,
    feeBps: 1000n,
    restrictFeeRecipients: true,
  };
  const root = seaDropLeaf(wallet, allow);
  const routes = new Map();
  const add = (to, fn, values) => {
    routes.set(`${to.toLowerCase()}:${seaDropIface.getFunction(fn).selector.toLowerCase()}`, seaDropIface.encodeFunctionResult(fn, values));
  };
  add(sea, "getPublicDrop", [0n, now + 7200, now + 10_000, 1, 1000, true]);
  add(sea, "getCreatorPayoutAddress", [creator]);
  add(sea, "getAllowedFeeRecipients", [[fee]]);
  add(sea, "getAllowListMerkleRoot", [root]);
  add(sea, "getTokenGatedAllowedTokens", [[]]);
  const provider = {
    async getCode() {
      return "0x60016000";
    },
    async getBlock() {
      return { timestamp: now };
    },
    async getBalance() {
      return ethers.parseEther("1");
    },
    async call({ to, data }) {
      const hit = routes.get(`${to.toLowerCase()}:${data.slice(0, 10).toLowerCase()}`);
      if (hit) return hit;
      if (to.toLowerCase() === sea.toLowerCase()) return "0x";
      throw new Error("missing");
    },
    async destroy() {},
  };
  const logs = [];
  const result = await runMint(
    {
      url: "https://www.kalos.fun/mint/slymz-crew",
      quantity: 1,
      gasGwei: "1",
      gasLimit: 400_000,
      maxPrice: ethers.parseEther("0.2"),
      chain: resolveNftChain("base"),
      rpc: "https://base.example",
      apiKey: "should-not-call-opensea",
      dryRun: true,
      wallet,
      signer: null,
    },
    {
      listen: false,
      log: (message) => logs.push(message),
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("/eligibility/")) {
          return {
            ok: true,
            json: async () => ({
              published: true,
              rootIsKalos: true,
              entries: [
                {
                  stageName: "guaranteed",
                  stageIndex: 1,
                  proof: [],
                  mintParams: {
                    mintPrice: "0",
                    maxTotalMintableByWallet: "1",
                    startTime: String(now - 100),
                    endTime: String(now + 3600),
                    dropStageIndex: "1",
                    maxTokenSupplyForStage: "1527",
                    feeBps: "1000",
                    restrictFeeRecipients: true,
                  },
                },
              ],
            }),
          };
        }
        if (href.includes("/v2/launch/drops/slymz-crew")) {
          return { ok: true, json: async () => ({ slug: "slymz-crew", name: "slymz crew", address: nft, seaDrop: sea }) };
        }
        throw new Error(`không gọi ${href}`);
      },
      providerFactory: () => provider,
    },
  );
  assert.equal(result.chain, "elysium");
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0].label, "guaranteed");
  assert.equal(result.rounds[1].label, "public");
  assert.equal(result.tx.to, ethers.getAddress(sea));
  assert.match(logs.join("\n"), /chain elysium/);
  assert.match(logs.join("\n"), new RegExp(nft));
});
