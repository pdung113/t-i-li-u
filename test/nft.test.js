import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { nftIface, seaDropIface } from "../src/nft/abi.js";
import { resolveNftChain } from "../src/nft/chains.js";
import { loadNftOptions, main } from "../src/nft/index.js";
import { pickCheapest } from "../src/nft/listings.js";
import { proofFromLeaves, thirdwebLeaf, verifyProof } from "../src/nft/merkle.js";
import { contractsFromCollection } from "../src/nft/opensea.js";
import { chainHintsFromText, collectAllowInfo, extractCandidates, parseMarketUrl } from "../src/nft/parse.js";
import { capQuantity, chooseFeeRecipient, genericRounds, selectRound, thirdwebRound } from "../src/nft/rounds.js";
import { exposes } from "../src/nft/read.js";
import { runMint } from "../src/nft/run.js";

const nft = "0x1111111111111111111111111111111111111111";
const sea = "0x2222222222222222222222222222222222222222";
const creator = "0x3333333333333333333333333333333333333333";
const wallet = "0x4444444444444444444444444444444444444444";
const other = "0x5555555555555555555555555555555555555555";

test("main in cách dùng khi thiếu lệnh", async () => {
  const previous = process.exitCode;
  await main([]);
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
});

test("đọc cờ gas và số lượng", () => {
  const options = loadNftOptions(
    ["mint", "https://mint.example/drop", "--qty", "3", "--gas", "12", "--max-price", "0.05", "--chain", "base"],
    {},
  );
  assert.equal(options.command, "mint");
  assert.equal(options.quantity, 3);
  assert.equal(options.gasGwei, "12");
  assert.equal(options.maxPrice, ethers.parseEther("0.05"));
  assert.equal(options.chain.name, "base");
  assert.equal(options.wallet, null);
  assert.equal(resolveNftChain("matic").chainId, 137);
});

test("parse link OpenSea, chợ có contract, và trang mint", () => {
  const collection = parseMarketUrl("https://opensea.io/collection/cool-cats");
  assert.equal(collection.kind, "collection");
  assert.equal(collection.slug, "cool-cats");

  const item = parseMarketUrl(`https://opensea.io/item/base/${nft}/15`);
  assert.equal(item.kind, "item");
  assert.equal(item.chain, "base");
  assert.equal(item.contract, ethers.getAddress(nft));
  assert.equal(item.tokenId, "15");

  const market = parseMarketUrl(`https://blur.io/eth/collection/${nft}`);
  assert.equal(market.contract, ethers.getAddress(nft));
  assert.equal(market.chain, "eth");
  assert.equal(market.tokenId, null);

  const page = parseMarketUrl("https://mint.example/drop/2024");
  assert.equal(page.kind, "page");
  assert.equal(page.tokenId, null);
  assert.throws(() => parseMarketUrl("notaurl"), /Link không hợp lệ/);
});

test("trang mint chỉ ra contract và chain", () => {
  const html = `
    <script type="application/json">
      {"contractAddress":"${nft}","chainId":8453,"allowlist":["${wallet}","${other}"]}
    </script>
    <div>router 0x00000000000000000000000000000000000000aa</div>
  `;
  const ranked = extractCandidates(html);
  assert.equal(ranked[0].address, ethers.getAddress(nft));
  assert.ok(ranked[0].score > ranked[1].score);
  assert.deepEqual(chainHintsFromText(html), ["base"]);
  const info = collectAllowInfo(html, wallet);
  assert.equal(info.lists.length, 1);
  assert.ok(info.lists[0].includes(wallet));
});

test("chọn round ví đủ điều kiện, public bị đẩy sau allowlist", () => {
  const limits = { quantity: 4, maxPrice: 1_000n, gasWei: 0n, now: 50 };
  const base = {
    price: 100n,
    publicStart: 500,
    allowStart: 100,
    maxPerWallet: 2n,
    minted: 0n,
    balance: 10_000n,
    limits,
    nft,
    paused: false,
    publicFn: "mint",
    allowFn: "mintAllowlist",
    saleActive: null,
  };
  const eligibleAllow = genericRounds({ ...base, allowlisted: true });
  assert.equal(selectRound(eligibleAllow, 50).label, "allowlist");
  assert.equal(selectRound(eligibleAllow, 50).quantity, 2);

  const onlyPublic = genericRounds({ ...base, allowlisted: false });
  assert.equal(selectRound(onlyPublic, 50).label, "public");
  assert.equal(selectRound(onlyPublic, 50).start, 500);

  const tooCostly = genericRounds({ ...base, allowlisted: false, price: 5_000n });
  assert.equal(selectRound(tooCostly, 50), null);
  assert.equal(capQuantity(4, 2, 0, false), 2);
  assert.equal(capQuantity(4, 0, 0, true), 4);
});

test("proof allowlist thirdweb khớp merkle thì ví đủ round đó", () => {
  const price = 1000n;
  const limit = 2n;
  const currency = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const addresses = [wallet, other];
  const leaves = addresses.map((item) => thirdwebLeaf(item, limit, price, currency));
  const { root, proof } = proofFromLeaves(leaves, 0);
  assert.equal(verifyProof(proof, root, leaves[0]), true);
  const round = thirdwebRound({
    condition: {
      startTimestamp: 100n,
      maxClaimableSupply: 10n,
      supplyClaimed: 0n,
      quantityLimitPerWallet: limit,
      merkleRoot: root,
      pricePerToken: price,
      currency,
    },
    id: 1,
    claimed: 0n,
    balance: ethers.parseEther("1"),
    limits: { quantity: 2, maxPrice: ethers.parseEther("1"), gasWei: 0n, now: 10 },
    nft,
    wallet,
    allowInfo: { entries: [], lists: [addresses.map((item) => item.toLowerCase())] },
  });
  assert.equal(round.eligible, true);
  assert.equal(round.label, "allowlist");
  assert.equal(round.quantity, 2);
  assert.equal(selectRound([round, { ...round, id: "public", label: "public", start: 400, kind: "public" }], 10).label, "allowlist");
});

test("listing rẻ nhất dưới trần giá", () => {
  const picked = pickCheapest(
    [
      { order_hash: "0x1", protocol_address: "0xabc", price: { current: { value: "30" } }, tokenId: "1" },
      { order_hash: "0x2", protocol_address: "0xabc", price: { current: { value: "10" } }, tokenId: "2" },
      { order_hash: "0x3", protocol_address: "0xabc", price: { current: { value: "100" } }, tokenId: "3" },
    ],
    50n,
    1,
    null,
  );
  assert.equal(picked.length, 1);
  assert.equal(picked[0].tokenId, "2");
  assert.equal(picked[0].price, 10n);
  const one = pickCheapest(
    [{ orderHash: "0x9", protocolAddress: "0xabc", current_price: "4", token_id: "9" }],
    4n,
    1,
    "9",
  );
  assert.equal(one[0].hash, "0x9");
  assert.equal(contractsFromCollection({ contracts: [{ address: nft, chain: "base" }] })[0].chain, "base");
});

test("proxy vẫn được coi là có hàm mint", () => {
  const proxy = `0x363d3d373d3d3d363d73${"11".repeat(20)}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(exposes(proxy, "mintPrice"), true);
  assert.equal(exposes("0x60016000", "mintPrice"), false);
});

test("fee recipient SeaDrop không được là địa chỉ 0", () => {
  assert.equal(chooseFeeRecipient({ restrict: false, allowed: [], creator }), ethers.getAddress(creator));
  assert.equal(chooseFeeRecipient({ restrict: true, allowed: [creator], creator: nft }), ethers.getAddress(creator));
  assert.equal(chooseFeeRecipient({ restrict: true, allowed: [], creator }), null);
});

test("dry run canh public khi ví không có allowlist", async () => {
  const now = 1_700_000_000;
  const routes = new Map();
  const add = (to, iface, fn, values) => {
    routes.set(`${to.toLowerCase()}:${iface.getFunction(fn).selector.toLowerCase()}`, iface.encodeFunctionResult(fn, values));
  };
  add(nft, nftIface, "getAllowedSeaDrop", [[sea]]);
  add(sea, seaDropIface, "getPublicDrop", [ethers.parseEther("0.01"), now + 3600, now + 7200, 2, 0, false]);
  add(sea, seaDropIface, "getCreatorPayoutAddress", [creator]);
  add(sea, seaDropIface, "getAllowedFeeRecipients", [[]]);
  add(sea, seaDropIface, "getAllowListMerkleRoot", [ethers.ZeroHash]);
  add(nft, nftIface, "getMintStats", [0, 0, 1000]);
  add(sea, seaDropIface, "getTokenGatedAllowedTokens", [[]]);

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
      const key = `${to.toLowerCase()}:${data.slice(0, 10).toLowerCase()}`;
      const result = routes.get(key);
      if (!result) throw new Error(`missing ${key}`);
      return result;
    },
    async destroy() {},
  };
  const logs = [];
  const result = await runMint(
    {
      url: `https://mint.example/base/${nft}`,
      quantity: 5,
      gasGwei: "9",
      gasLimit: 400_000,
      maxPrice: ethers.parseEther("0.2"),
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
      fetch: async () => ({ ok: true, text: async () => "<html>mint</html>" }),
      providerFactory: () => provider,
    },
  );
  assert.equal(result.sent, false);
  assert.equal(result.round.label, "public");
  assert.equal(result.round.quantity, 2);
  assert.equal(result.round.start, now + 3600);
  assert.equal(result.tx.to, ethers.getAddress(sea));
  assert.equal(result.tx.value, ethers.parseEther("0.02"));
  assert.equal(result.tx.maxFeePerGas, ethers.parseUnits("9", "gwei"));
  assert.equal(result.tx.maxPriorityFeePerGas, ethers.parseUnits("9", "gwei"));
  assert.ok(logs.some((line) => line.includes("Chọn round public")));
  assert.ok(logs.some((line) => line.includes("Chưa mở")));
});
