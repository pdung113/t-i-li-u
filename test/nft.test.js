import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { nftIface, seaDropIface } from "../src/nft/abi.js";
import { chainFromId, resolveNftChain } from "../src/nft/chains.js";
import { loadNftOptions, main } from "../src/nft/index.js";
import { formatReport, multiplyGas, parseNotepad, shortAddress } from "../src/nft/notepad.js";
import { pickCheapest } from "../src/nft/listings.js";
import { proofFromLeaves, thirdwebLeaf, verifyProof } from "../src/nft/merkle.js";
import { contractsFromCollection } from "../src/nft/opensea.js";
import { chainHintsFromText, collectAllowInfo, extractCandidates, parseMarketUrl } from "../src/nft/parse.js";
import { mintPlanFromText } from "../src/nft/pageAbi.js";
import { capQuantity, chooseFeeRecipient, eligibleRounds, genericRounds, selectRound, thirdwebRound } from "../src/nft/rounds.js";
import { exposes } from "../src/nft/read.js";
import { loadPage, runBuy, runMint, runMintWallets } from "../src/nft/run.js";

const nft = "0x1111111111111111111111111111111111111111";
const sea = "0x2222222222222222222222222222222222222222";
const creator = "0x3333333333333333333333333333333333333333";
const wallet = "0x4444444444444444444444444444444444444444";
const other = "0x5555555555555555555555555555555555555555";

test("chưa có notepad thì tạo file và dừng", async () => {
  const previous = process.exitCode;
  const writes = [];
  await main([], {
    file: "nft.txt",
    exists: () => false,
    example: "chain=\n",
    writeFile: (target, text) => writes.push({ target, text }),
  });
  assert.equal(process.exitCode, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].text, "chain=\n");
  process.exitCode = previous;
});

test("notepad đọc chain, gas, link và nhiều ví", () => {
  const secret = `${"ab".repeat(32)}`;
  const first = ethers.Wallet.createRandom();
  const second = ethers.Wallet.createRandom();
  const config = parseNotepad(`
    # ghi chú
    chain=base
    gas=12
    gas_limit=400000
    qty=3
    max_price=0.05
    dry_run=false
    link=https://mint.example/drop
    key=${first.privateKey}
    ${second.privateKey}
  `);
  assert.equal(config.chain, "base");
  assert.equal(config.gas, "12");
  assert.equal(config.gasX, null);
  const boosted = parseNotepad(`chain=base\ngas=5\ngas_x=x3\nlink=https://mint.example/drop\nkey=${first.privateKey}`);
  assert.equal(boosted.gasX, 3);
  assert.equal(multiplyGas(boosted.gas, boosted.gasX), "15");
  assert.equal(multiplyGas("5", 2), "10");
  assert.equal(config.gasLimit, 400000);
  assert.equal(config.qty, 3);
  assert.equal(config.maxPrice, "0.05");
  assert.equal(config.dryRun, false);
  assert.equal(config.links.length, 1);
  assert.equal(config.keys.length, 2);
  const elysium = parseNotepad(`chain=elysium\nrpc=https://rpc.example/elysium\nlink=https://mint.example/drop\nkey=${first.privateKey}`);
  assert.equal(elysium.chain, "elysium");
  assert.equal(elysium.rpc, "https://rpc.example/elysium");
  assert.equal(elysium.links[0].url, "https://mint.example/drop");
  assert.equal(elysium.links[0].chain, null);
  const mixed = parseNotepad(`chain=base\nlink=elysium https://two.example/drop\nkey=${first.privateKey}`);
  assert.equal(mixed.links[0].chain, "elysium");
  assert.equal(mixed.links[0].url, "https://two.example/drop");
  assert.throws(() => parseNotepad(`chain=elysium\nrpc=not-a-url\nlink=https://mint.example/drop\nkey=${first.privateKey}`), /rpc dòng/);
  assert.throws(() => parseNotepad(`chain=base\nlink=https://a.example\nkey=${secret}zz`), /dòng/);
  let leaked = false;
  try {
    parseNotepad(`chain=base\nlink=https://a.example\nkey=super-secret-not-a-key`);
  } catch (error) {
    leaked = error.message.includes("super-secret");
    assert.match(error.message, /dòng 3/);
  }
  assert.equal(leaked, false);
  assert.throws(() => parseNotepad(`chain=base\nlink=https://a.example\nkey=${first.privateKey}\nkey=${first.privateKey}`), /Trùng ví/);
});

test("báo cáo chain, ví thành công và số NFT", () => {
  const text = formatReport(
    [
      { wallet, sent: true, ok: true, quantity: 2 },
      { wallet: other, sent: false, ok: false, quantity: 0, reason: `revert 0x${"aa".repeat(32)}` },
    ],
    "base",
  );
  assert.match(text, /Kết quả \| chain base/);
  assert.match(text, new RegExp(`${shortAddress(wallet)} \\| chain base \\| thành công \\| 2 NFT`));
  assert.match(text, /thất bại \| 0 NFT/);
  assert.equal(text.includes("aa".repeat(32)), false);
  assert.match(text, /Thành công 1\/2 ví, tổng 2 NFT/);
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
  const elysium = resolveNftChain("elysium");
  assert.equal(elysium.chainId, 99901);
  assert.equal(elysium.nativeSymbol, "HYPE");
  assert.equal(elysium.eip1559, true);
  assert.equal(elysium.opensea, null);
  assert.equal(resolveNftChain("elys").name, "elysium");
  assert.equal(chainFromId(99901).name, "elysium");
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

  const assets = parseMarketUrl(`https://opensea.io/assets/ethereum/${nft}/7`);
  assert.equal(assets.kind, "item");
  assert.equal(assets.chain, "eth");
  assert.equal(assets.contract, ethers.getAddress(nft));
  assert.equal(assets.tokenId, "7");

  const market = parseMarketUrl(`https://blur.io/eth/collection/${nft}`);
  assert.equal(market.contract, ethers.getAddress(nft));
  assert.equal(market.chain, "eth");
  assert.equal(market.tokenId, null);

  const elysiumPage = parseMarketUrl(`https://mint.example/elysium/${nft}`);
  assert.equal(elysiumPage.chain, "elysium");
  assert.equal(elysiumPage.contract, ethers.getAddress(nft));

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
  const open = genericRounds({ ...base, allowlisted: true, allowStart: 40, publicStart: 40 });
  assert.deepEqual(
    eligibleRounds(open, 50).map((round) => round.label),
    ["allowlist", "public"],
  );
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
  assert.equal(result.tx.data.slice(0, 10), seaDropIface.getFunction("mintPublic").selector);
  const mintArgs = seaDropIface.decodeFunctionData("mintPublic", result.tx.data);
  assert.equal(mintArgs[0], ethers.getAddress(nft));
  assert.equal(mintArgs[3], 2n);
  assert.notEqual(mintArgs[1], ethers.ZeroAddress);
  assert.ok(logs.some((line) => line.includes("Chọn round public")));
  assert.ok(logs.some((line) => line.includes("Đang chờ tới giờ mint")));
  assert.ok(logs.some((line) => line.includes("gửi liên tục")));
});

test("sát giờ mở thì gọi lại đến khi mint được", async () => {
  const now = 1_700_000_000;
  const routes = new Map();
  const add = (to, iface, fn, values) => {
    routes.set(`${to.toLowerCase()}:${iface.getFunction(fn).selector.toLowerCase()}`, iface.encodeFunctionResult(fn, values));
  };
  add(nft, nftIface, "getAllowedSeaDrop", [[sea]]);
  add(sea, seaDropIface, "getPublicDrop", [ethers.parseEther("0.01"), now, now + 3600, 1, 0, false]);
  add(sea, seaDropIface, "getCreatorPayoutAddress", [creator]);
  add(sea, seaDropIface, "getAllowedFeeRecipients", [[]]);
  add(sea, seaDropIface, "getAllowListMerkleRoot", [ethers.ZeroHash]);
  add(nft, nftIface, "getMintStats", [0, 0, 1000]);
  add(sea, seaDropIface, "getTokenGatedAllowedTokens", [[]]);
  const mintSelector = seaDropIface.getFunction("mintPublic").selector.toLowerCase();
  let mintCalls = 0;
  const sends = [];
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
      const selector = data.slice(0, 10).toLowerCase();
      if (selector === mintSelector) {
        mintCalls += 1;
        if (mintCalls < 4) {
          const error = new Error("PublicDropNotStarted");
          error.shortMessage = "PublicDropNotStarted";
          throw error;
        }
        return "0x";
      }
      const result = routes.get(`${to.toLowerCase()}:${selector}`);
      if (!result) throw new Error(`missing ${selector}`);
      return result;
    },
    async destroy() {},
  };
  const logs = [];
  const result = await runMint(
    {
      url: `https://mint.example/base/${nft}`,
      quantity: 1,
      gasGwei: "9",
      gasLimit: 400_000,
      maxPrice: ethers.parseEther("0.2"),
      chain: null,
      rpc: "",
      apiKey: "",
      dryRun: false,
      wallet,
      signer: {
        address: wallet,
        connect() {
          return this;
        },
        async sendTransaction(tx) {
          sends.push(tx);
          return { hash: `0x${"ab".repeat(32)}`, async wait() { return { status: 1 }; } };
        },
      },
    },
    {
      listen: false,
      log: (message) => logs.push(message),
      fetch: async () => ({ ok: true, text: async () => "<html>mint</html>" }),
      providerFactory: () => provider,
    },
  );
  assert.equal(result.sent, true);
  assert.equal(sends.length, 1);
  assert.ok(mintCalls >= 4);
  assert.equal(sends[0].value, ethers.parseEther("0.01"));
  assert.ok(logs.some((line) => line.includes("Gửi lại liên tục")));
  assert.ok(logs.some((line) => line.includes("Mint thành công")));
});

test("nhiều ví trong notepad mint cùng lúc và báo số lượng", async () => {
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
  const first = ethers.Wallet.createRandom();
  const second = ethers.Wallet.createRandom();
  const logs = [];
  const reports = await main([], {
    exists: () => true,
    readFile: () =>
      [
        "chain=base",
        "gas=9",
        "qty=5",
        "max_price=0.2",
        "dry_run=true",
        `link=https://mint.example/base/${nft}`,
        `key=${first.privateKey}`,
        `key=${second.privateKey}`,
      ].join("\n"),
    env: {},
    listen: false,
    log: (message) => logs.push(message),
    fetch: async () => ({ ok: true, text: async () => "<html>mint</html>" }),
    providerFactory: () => provider,
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].chain, "base");
  assert.equal(reports[0].rows.length, 2);
  assert.equal(reports[0].rows.every((row) => row.ok && row.quantity === 2 && row.sent === false), true);
  assert.match(reports[0].text, /Kết quả \| chain base/);
  assert.match(reports[0].text, /Sẵn sàng 2\/2 ví, tổng sẽ mint 4 NFT/);
  assert.match(reports[0].text, new RegExp(shortAddress(first.address)));
  assert.match(reports[0].text, new RegExp(shortAddress(second.address)));
  assert.equal(reports[0].text.includes(first.privateKey.slice(2)), false);
  assert.ok(logs.some((line) => line.includes("chain base") && line.includes("2 ví") && line.includes("gas 9")));

  const failed = await runMintWallets(
    {
      url: "https://mint.example/missing",
      quantity: 1,
      gasGwei: "5",
      gasLimit: 500_000,
      maxPrice: ethers.parseEther("0.2"),
      chain: resolveNftChain("base"),
      rpc: "",
      apiKey: "",
      dryRun: true,
      wallet: null,
      signer: null,
    },
    [
      { address: first.address, signer: null },
      { address: second.address, signer: null },
    ],
    {
      listen: false,
      log: () => {},
      fetch: async () => {
        throw new Error("không tải được trang");
      },
      providerFactory: () => provider,
    },
  );
  assert.match(failed.text, /Thành công 0\/2 ví, tổng 0 NFT/);
  assert.match(failed.text, /chain base/);
  assert.match(failed.text, /thất bại \| 0 NFT/);
});

test("nhiều dự án chạy cùng lúc", async () => {
  const first = ethers.Wallet.createRandom();
  let active = 0;
  let maxActive = 0;
  const logs = [];
  const reports = await main([], {
    exists: () => true,
    readFile: () =>
      [
        "chain=base",
        "dry_run=true",
        `link=https://one.example/drop/${nft}`,
        `link=elysium https://two.example/drop/${nft}`,
        `key=${first.privateKey}`,
      ].join("\n"),
    env: {},
    listen: false,
    log: (message) => logs.push(message),
    fetch: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { ok: true, text: async () => "<html>mint</html>" };
    },
    providerFactory: () => ({
      async getCode() {
        return "0x";
      },
      async destroy() {},
    }),
  });
  assert.equal(reports.length, 2);
  assert.equal(reports[0].chain, "base");
  assert.equal(reports[1].chain, "elysium");
  assert.ok(maxActive >= 2);
  assert.ok(logs.some((line) => line.startsWith("1 one.example |")));
  assert.ok(logs.some((line) => line.startsWith("2 two.example |")));
});

test("mua OpenSea không chạy trên elysium", async () => {
  await assert.rejects(
    () =>
      runBuy(
        {
          url: `https://mint.example/elysium/${nft}`,
          quantity: 1,
          gasGwei: "5",
          gasLimit: 500_000,
          maxPrice: ethers.parseEther("0.2"),
          chain: resolveNftChain("elysium"),
          rpc: "",
          apiKey: "test",
          dryRun: true,
          wallet: null,
          signer: null,
        },
        {
          log: () => {},
          fetch: async () => ({ ok: true, text: async () => "<html>mint</html>" }),
          providerFactory: () => ({ async destroy() {} }),
        },
      ),
    /OpenSea chưa có chain elysium/,
  );
});

test("mua ask rẻ nhất dưới trần và không gửi khi dry run", async () => {
  const protocol = "0x0000000000000068F116a894984e2DB1123eB395";
  const cheap = `0x${"22".repeat(32)}`;
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body });
    const href = String(url);
    if (href.includes("/collections/")) {
      return { ok: true, json: async () => ({ contracts: [{ address: nft, chain: "ethereum" }] }) };
    }
    if (href.includes("/orders/")) {
      return {
        ok: true,
        json: async () => ({
          orders: [
            { order_hash: `0x${"11".repeat(32)}`, protocol_address: protocol, price: { current: { value: "50000000000000000" } }, tokenId: "2" },
            { order_hash: cheap, protocol_address: protocol, price: { current: { value: "10000000000000000" } }, tokenId: "1" },
            { order_hash: `0x${"33".repeat(32)}`, protocol_address: protocol, price: { current: { value: "900000000000000000" } }, tokenId: "3" },
          ],
        }),
      };
    }
    if (href.includes("fulfillment_data")) {
      return {
        ok: true,
        json: async () => ({
          fulfillment_data: { transaction: { to: protocol, input_data: "0xabcd", value: "10000000000000000" } },
        }),
      };
    }
    return { ok: false, status: 404 };
  };
  const result = await runBuy(
    {
      url: "https://opensea.io/collection/cool-cats",
      quantity: 1,
      gasGwei: "5",
      gasLimit: 500_000,
      maxPrice: ethers.parseEther("0.2"),
      chain: resolveNftChain("eth"),
      rpc: "",
      apiKey: "test-key",
      dryRun: true,
      wallet,
      signer: null,
    },
    {
      listen: false,
      log: () => {},
      fetch: fetchImpl,
      providerFactory: () => ({ async destroy() {} }),
    },
  );
  assert.equal(result.sent, false);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].tokenId, "1");
  assert.equal(result.listings[0].price, 10_000_000_000_000_000n);
  const posted = calls.find((call) => call.method === "POST");
  assert.match(posted.url, /\/listings\/fulfillment_data$/);
  assert.equal(JSON.parse(posted.body).listing.hash, cheap);
  assert.equal(JSON.parse(posted.body).fulfiller.address, ethers.getAddress(wallet));
});

function openDropProvider(now, start = now + 3600) {
  const routes = new Map();
  const add = (to, iface, fn, values) => {
    routes.set(`${to.toLowerCase()}:${iface.getFunction(fn).selector.toLowerCase()}`, iface.encodeFunctionResult(fn, values));
  };
  add(nft, nftIface, "getAllowedSeaDrop", [[sea]]);
  add(sea, seaDropIface, "getPublicDrop", [ethers.parseEther("0.01"), start, now + 7200, 2, 0, false]);
  add(sea, seaDropIface, "getCreatorPayoutAddress", [creator]);
  add(sea, seaDropIface, "getAllowedFeeRecipients", [[]]);
  add(sea, seaDropIface, "getAllowListMerkleRoot", [ethers.ZeroHash]);
  add(nft, nftIface, "getMintStats", [0, 0, 1000]);
  add(sea, seaDropIface, "getTokenGatedAllowedTokens", [[]]);
  return {
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
      const selector = data.slice(0, 10).toLowerCase();
      if (selector === seaDropIface.getFunction("mintPublic").selector.toLowerCase()) return "0x";
      const result = routes.get(`${to.toLowerCase()}:${selector}`);
      if (!result) throw new Error("missing");
      return result;
    },
    async destroy() {},
  };
}

test("bốn dự án và ba ví chạy cùng lúc, một dự án lỗi không kéo cả đợt", async () => {
  const now = 1_700_000_000;
  const wallets = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  let active = 0;
  let maxActive = 0;
  const logs = [];
  const reports = await main([], {
    exists: () => true,
    readFile: () =>
      [
        "chain=base",
        "gas=4",
        "gas_x=3",
        "qty=5",
        "dry_run=true",
        `link=https://one.example/base/${nft}`,
        `link=elysium https://two.example/elysium/${nft}`,
        `link=https://three.example/base/${nft}`,
        "link=https://broken.example/drop",
        ...wallets.map((item) => `key=${item.privateKey}`),
      ].join("\n"),
    env: {},
    listen: false,
    log: (message) => logs.push(message),
    fetch: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      if (String(url).includes("broken.example")) throw new Error("không tải được trang");
      return { ok: true, text: async () => "<html>mint</html>" };
    },
    providerFactory: () => openDropProvider(now),
  });
  const joined = logs.join("\n");
  assert.equal(reports.length, 4);
  assert.deepEqual(
    reports.map((report) => report.chain),
    ["base", "elysium", "base", "base"],
  );
  for (const report of reports.slice(0, 3)) {
    assert.equal(report.rows.length, 3);
    assert.equal(report.rows.every((row) => row.ok && row.quantity === 2 && row.sent === false), true);
    assert.match(report.text, /Sẵn sàng 3\/3 ví, tổng sẽ mint 6 NFT/);
  }
  assert.match(reports[3].text, /Thành công 0\/3 ví, tổng 0 NFT/);
  assert.ok(maxActive >= 4);
  assert.match(joined, /12 gwei \(4 x3\)/);
  assert.ok(logs.some((line) => line.startsWith("1 one.example |")));
  assert.ok(logs.some((line) => line.startsWith("2 two.example |")));
  assert.ok(logs.some((line) => line.startsWith("3 three.example |")));
  assert.ok(logs.some((line) => line.startsWith("4 broken.example |")));
  for (const item of wallets) assert.equal(joined.includes(item.privateKey.slice(2)), false);
});

test("hai dự án cùng chain không gửi trùng nonce của một ví", async () => {
  const now = 1_700_000_000;
  const signerWallet = ethers.Wallet.createRandom();
  let pending = 4;
  const nonces = [];
  const provider = openDropProvider(now, now);
  provider.getTransactionCount = async () => pending;
  const signer = {
    address: signerWallet.address,
    connect() {
      return this;
    },
    async sendTransaction(tx) {
      nonces.push(tx.nonce);
      await new Promise((resolve) => setTimeout(resolve, 40));
      pending += 1;
      return { hash: `0x${"cd".repeat(32)}`, async wait() { return { status: 1 }; } };
    },
  };
  const options = {
    url: `https://mint.example/base/${nft}`,
    quantity: 1,
    gasGwei: "9",
    gasLimit: 400_000,
    maxPrice: ethers.parseEther("0.2"),
    chain: resolveNftChain("base"),
    rpc: "",
    apiKey: "",
    dryRun: false,
    wallet: signerWallet.address,
    signer,
  };
  const deps = {
    listen: false,
    log: () => {},
    fetch: async () => ({ ok: true, text: async () => "<html>mint</html>" }),
    providerFactory: () => provider,
  };
  const results = await Promise.all([runMint(options, deps), runMint({ ...options }, deps)]);
  assert.equal(results.every((result) => result.sent), true);
  assert.deepEqual(nonces.slice().sort((a, b) => a - b), [4, 5]);
});

test("contract nằm trong file js của trang thì vẫn lấy được", async () => {
  const html = `<script type="module" src="/assets/index-aaa.js"></script>`;
  const index = `const files=["assets/Mint-bbb.js","assets/Other-ccc.js"]`;
  const mintJs = `contract:"${nft}",chainId:99901`;
  const seen = [];
  const page = await loadPage("https://drop.example/mint", async (url) => {
    const href = String(url);
    seen.push(href);
    if (href.endsWith("/mint")) return { ok: true, text: async () => html };
    if (href.endsWith("index-aaa.js")) return { ok: true, text: async () => index };
    if (href.endsWith("Mint-bbb.js")) return { ok: true, text: async () => mintJs };
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  });
  assert.equal(page.candidates[0].address, ethers.getAddress(nft));
  assert.ok(page.hints.includes("elysium"));
  assert.ok(seen.some((href) => href.endsWith("/assets/Mint-bbb.js")));
});

test("trang để contract trống thì báo chưa công bố, không hỏi sửa code", async () => {
  const html = `<script type="module" src="/app.js"></script>`;
  const js = `function setup(){return {contract:void 0,ready:false}} function mint(){return "mint"}`;
  await assert.rejects(
    () =>
      runMint(
        {
          url: "https://rektsouls.example/mint",
          quantity: 1,
          gasGwei: "1",
          gasLimit: 300_000,
          maxPrice: ethers.parseEther("1"),
          chain: resolveNftChain("base"),
          rpc: "",
          apiKey: "",
          dryRun: true,
          wallet,
          signer: null,
        },
        {
          listen: false,
          log: () => {},
          fetch: async (url) => {
            const href = String(url);
            if (href.endsWith("/app.js")) return { ok: true, text: async () => js, json: async () => ({}) };
            if (href.endsWith("/mint")) return { ok: true, text: async () => html, json: async () => ({}) };
            return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
          },
          providerFactory: () => ({ async destroy() {} }),
        },
      ),
    /chưa công bố contract/,
  );
});

test("trang tự khai ABI thì chờ đúng phase, không cần code riêng cho web đó", async () => {
  const now = 1_700_000_000;
  const abi = [
    '{type:"function",name:"mint",stateMutability:"payable",inputs:[{name:"quantity",type:"uint256"},{name:"allowance",type:"uint16"},{name:"pass",type:"bytes"}],outputs:[]}',
    '{type:"function",name:"info",stateMutability:"view",inputs:[],outputs:[{name:"p",type:"uint8"},{name:"start",type:"uint64"},{name:"frLen",type:"uint32"},{name:"rushLen",type:"uint32"},{name:"isPaused",type:"bool"},{name:"minted",type:"uint256"},{name:"supply",type:"uint256"},{name:"frPrice",type:"uint256"},{name:"pubPrice",type:"uint256"},{name:"frCap",type:"uint16"},{name:"pubCap",type:"uint16"},{name:"rPrice",type:"uint256"}]}',
    '{type:"function",name:"frontRowMinted",stateMutability:"view",inputs:[{type:"address"}],outputs:[{type:"uint256"}]}',
    '{type:"function",name:"publicMinted",stateMutability:"view",inputs:[{type:"address"}],outputs:[{type:"uint256"}]}',
  ].join(",");
  const html = `<script>const contract="${nft}"; chainId:99901; ${abi}; const pass=\`/pass?wallet=\${n}\`; const check=\`/check?wallet=\${n}\`;</script>`;
  const plan = mintPlanFromText(html, "https://drop.example/mint");
  assert.equal(plan.passPath, "/pass?wallet=");
  assert.equal(plan.checkPath, "/check?wallet=");
  const prefixed = mintPlanFromText(`${html} async function api(e){return fetch(\`/api\${e}\`)}`, "https://drop.example/mint");
  assert.equal(prefixed.passPath, "/api/pass?wallet=");
  assert.equal(prefixed.checkPath, "/api/check?wallet=");
  const info = plan.infoIface.encodeFunctionResult("info", [0, now + 3600, 3600, 1800, false, 0, 2222, 1000, 2000, 2, 5, 1500]);
  const code = `0x${plan.selector.slice(2)}6000`;
  const calls = [];
  const logs = [];
  const result = await runMint(
    {
      url: "https://drop.example/mint",
      quantity: 1,
      gasGwei: "1",
      gasLimit: 300_000,
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
        calls.push(href);
        if (href.includes("/check")) return { ok: true, json: async () => ({ status: "approved" }), text: async () => "" };
        return { ok: true, text: async () => html, json: async () => ({}) };
      },
      providerFactory: (chain) => ({
        async getCode() {
          return chain.name === "elysium" ? code : "0x";
        },
        async call(tx) {
          if (String(tx.data).toLowerCase() === plan.infoData.toLowerCase()) return info;
          return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0]);
        },
        async getBlock() {
          return { timestamp: now };
        },
        async getBalance() {
          return ethers.parseEther("1");
        },
        async destroy() {},
      }),
    },
  );
  assert.equal(result.chain, "elysium");
  assert.equal(result.rounds[0].label, "Front Row");
  assert.match(logs.join("\n"), /Đang chờ tới giờ mint Front Row/);
  assert.equal(calls.some((href) => href.includes("/pass")), false);
});
