import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { queryString, readJwtPayload, signJwt } from "../src/auth.js";
import { coerceNotice, decideNotice, parseContract, parseNetwork } from "../src/notice.js";
import { executeListing, listingIsFresh, FRESH_MS, shouldBuyNow, startEngine } from "../src/engine.js";
import { ethers } from "ethers";
import { MULTICALL, choosePool, createBuyer, decodeQuote, isBaseAsset, quoteCalls, quoteOnProvider, v2PairAddress, v3PoolAddress } from "../src/swap.js";
import { chainById } from "../src/networks.js";
import { amountFor, fdvAllows, fdvUsd, liquidityAllows, parseUserNumber, poolSidesUsd, routeImpactAllows, solanaLiquidityAllows } from "../src/limits.js";
import { minOut, priorityLamports, scaleUnits } from "../src/networks.js";
import { resultText } from "../src/telegram.js";
import { buyUrl, endpointPair, expandRpc, resolveRpcChoice, scrubRpcError } from "../src/rpc.js";

const SANC_TITLE = "생텀(SANC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)";
const SANC_BODY = `
디지털 자산 | 마켓 | 네트워크 | 입출금 개시 시점 | 거래지원 개시 시점
생텀(SANC) | KRW, BTC, USDT | Solana | 공지 게시 시점으로부터 1시간 이내 | 11월 13일 13시 예정
안내된 네트워크 (SANC-Solana)
SANC 컨트랙트 주소는 CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu
※ 거래 제한 안내
매수 제한 : 거래 지원 이후 약 5분간 매수 주문이 제한됩니다.
이 프로젝트는 Ethereum에서 시작했습니다.
`;

test("thông báo SANC là listing KRW và mua trên Solana, không chờ giờ mở sàn", () => {
  const decision = decideNotice({
    id: "71709e8e-3977-4199-844a-797e31256b4e",
    title: SANC_TITLE,
    body: SANC_BODY,
    category: "trade",
    listed_at: "2026-11-12T21:25:00+09:00",
  });
  assert.equal(decision.action, "buy");
  assert.equal(decision.listings.length, 1);
  const listing = decision.listings[0];
  assert.equal(listing.market, "KRW-SANC");
  assert.equal(listing.chain, "solana");
  assert.equal(listing.contract, "CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu");
  assert.equal(listing.openAt, undefined);
  assert.equal(parseNetwork(SANC_BODY, "SANC"), "solana");
});

test("OPEN trên Ethereum lấy đúng contract, kể cả tin bọc trong announcement", () => {
  const body = "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447";
  const decision = decideNotice({
    type: "announcement",
    announcement: {
      id: "open-1",
      title: "오픈(OPEN) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)",
      body,
      category: "trade",
      listed_at: "2026-11-13T10:00:00+09:00",
    },
  });
  assert.equal(decision.listings[0].chain, "ethereum");
  assert.equal(decision.listings[0].contract, "0xa227cc36938f0c9e09ce0e64dfab226cad739447");
  assert.equal(parseContract(body, "OPEN"), "0xa227cc36938f0c9e09ce0e64dfab226cad739447");
});

test("bỏ listing không có KRW, thêm thị trường, và thông báo đóng giao dịch", () => {
  const btc = decideNotice({ title: "페페(PEPE) 신규 거래지원 안내 (BTC, USDT 마켓)", category: "trade" });
  assert.equal(btc.reason, "no-krw");
  const added = decideNotice({ title: "아이오타(IOTA) KRW 마켓 추가", category: "trade" });
  assert.equal(added.reason, "not-new-listing");
  const closed = decideNotice({ title: "샌텀(SANC) 거래지원 종료 안내 (KRW 마켓)", category: "trade" });
  assert.equal(closed.reason, "not-new-listing");
});

test("một thông báo hai coin lấy contract theo từng ticker", () => {
  const decision = decideNotice({
    id: "abc",
    title: "에이(AAA), 비(BBB) 신규 거래지원 안내 (KRW 마켓)",
    body: "AAA 컨트랙트 주소는 0x1111111111111111111111111111111111111111\n안내된 네트워크 (AAA-Ethereum)\nBBB 컨트랙트 주소는 0x2222222222222222222222222222222222222222\n안내된 네트워크 (BBB-Base)",
    category: "거래",
    listed_at: "2026-11-13T09:00:00+09:00",
  });
  assert.deepEqual(decision.listings.map((item) => item.market), ["KRW-AAA", "KRW-BBB"]);
  assert.equal(decision.listings[0].chain, "ethereum");
  assert.equal(decision.listings[0].contract, "0x1111111111111111111111111111111111111111");
  assert.equal(decision.listings[1].chain, "base");
  assert.equal(decision.listings[1].contract, "0x2222222222222222222222222222222222222222");
});

test("gas nhân đúng hệ số và trượt giá trừ đúng phần trăm", () => {
  assert.equal(scaleUnits(100n, 2), 200n);
  assert.equal(scaleUnits(150n, 2.5), 375n);
  assert.equal(minOut(10000n, 10), 9000n);
  assert.equal(priorityLamports([1000, 5000, 9000], 2), 5000);
  assert.equal(priorityLamports([100000], 2), 80000);
  assert.equal(priorityLamports([], 2), 8000);
});

test("JWT socket không kèm query hash", () => {
  const query = queryString({ market: "KRW-BTC", side: "bid" });
  assert.equal(query, "market=KRW-BTC&side=bid");
  const token = signJwt("access", "secret", query);
  const payload = readJwtPayload(token);
  assert.equal(payload.access_key, "access");
  assert.equal(payload.query_hash, crypto.createHash("sha512").update(query).digest("hex"));
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "HS512");
  assert.equal(readJwtPayload(signJwt("access", "secret")).query_hash, undefined);
});

test("tin nhắn Telegram nói kết quả DEX và không chứa private key", () => {
  const text = resultText({
    ok: true,
    market: "KRW-SANC",
    chain: "solana",
    contract: "CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu",
    tx: "sig123",
    venue: "Jupiter",
    gasMultiple: 2,
  });
  assert.match(text, /Mua được/);
  assert.match(text, /solana/);
  assert.match(text, /sig123/);
  assert.match(text, /Gas x2/);
  assert.doesNotMatch(text, /private|secret|uuid/i);
  const missed = resultText({ ok: false, market: "KRW-SANC", reason: "Thiếu private key ví Solana." });
  assert.match(missed, /Không mua được/);
  assert.doesNotMatch(missed, /[1-9A-HJ-NP-Za-km-z]{64}/);
});

test("mỗi chain một số lượng và FDV cao thì không mua", () => {
  const amounts = { ethereum: 0.02, bsc: 0.4, solana: 1, base: 0 };
  assert.equal(amountFor("ethereum", amounts), 0.02);
  assert.equal(amountFor("bsc", amounts), 0.4);
  assert.equal(amountFor("solana", amounts), 1);
  assert.equal(amountFor("base", amounts), 0);
  const fdv = fdvUsd({
    amountIn: 10n ** 18n,
    amountOut: 10n ** 18n,
    totalSupply: 1000n * 10n ** 18n,
    nativeUsd: 2000,
    nativeDecimals: 18,
  });
  assert.equal(Math.round(fdv), 2_000_000);
  assert.equal(fdvAllows(fdv, 10_000_000).ok, true);
  assert.equal(fdvAllows(fdv, 1_000_000).ok, false);
  assert.equal(fdvAllows(null, 1_000_000).ok, false);
  assert.equal(fdvAllows(fdv, null).ok, true);
});

test("thanh khoản tính riêng hai bên và 100.000 vẫn là một trăm nghìn", () => {
  assert.equal(parseUserNumber("100.000"), 100000);
  assert.equal(parseUserNumber("100,000"), 100000);
  assert.equal(parseUserNumber("0,05"), 0.05);
  assert.equal(parseUserNumber(""), null);
  const sides = poolSidesUsd({
    nativeReserve: 100n * 10n ** 18n,
    tokenReserve: 10n ** 22n,
    amountIn: 10n ** 16n,
    amountOut: 10n ** 18n,
    nativeUsd: 2000,
    nativeDecimals: 18,
  });
  assert.equal(Math.round(sides.native), 200_000);
  assert.equal(Math.round(sides.token), 200_000);
  assert.equal(liquidityAllows(sides, 100_000, "ETH").ok, true);
  const thin = { native: 200_000, token: 40_000 };
  const refused = liquidityAllows(thin, 100_000, "ETH");
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /40,000 USD/);
  assert.match(refused.reason, /mỗi bên/);
  assert.match(liquidityAllows(null, 100_000).reason, /Không đọc được thanh khoản/);
  assert.equal(liquidityAllows(thin, null).ok, true);
  assert.equal(solanaLiquidityAllows(250_000, 100_000).ok, true);
  assert.equal(solanaLiquidityAllows(150_000, 100_000).ok, false);
  assert.match(solanaLiquidityAllows(null, 100_000).reason, /Không đọc được thanh khoản Solana/);
  assert.equal(routeImpactAllows(-0.0005).ok, true);
  assert.match(routeImpactAllows(-0.08).reason, /8%/);
});

test("địa chỉ pool CREATE2 trùng pool đang có trên chain", () => {
  const eth = chainById("ethereum");
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  assert.equal(v2PairAddress(eth, usdc).pair, "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc");
  assert.equal(v3PoolAddress(eth, usdc, 500), "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640");
  const bsc = chainById("bsc");
  const usdt = "0x55d398326f99059fF775485246999027B3197955";
  assert.equal(v2PairAddress(bsc, usdt).pair, "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE");
  assert.equal(v3PoolAddress(bsc, usdt, 2500), "0x1401ff943D08a7E098328C1d3a9d388923B115D2");
});

test("chain chưa nhập số lượng thì không gọi swap", async () => {
  let called = false;
  const result = await executeListing({
    noticeId: "n3",
    ticker: "SANC",
    market: "KRW-SANC",
    chain: "solana",
    contract: "CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu",
    listedAt: Date.now(),
  }, {
    live: true,
    gasMultiple: 2,
    amounts: { solana: 0, ethereum: 0.1 },
    state: { bought: {}, tickerBoughtAt: {} },
    now: () => Date.now(),
    stopped: () => false,
    swap: async () => { called = true; return { ok: true }; },
    notify: () => {},
  });
  assert.equal(called, false);
  assert.match(result.reason, /solana/);
});

test("thông báo cũ hơn 3 phút không được coi là mới", () => {
  const now = 1_000_000;
  assert.equal(listingIsFresh({ listedAt: now - FRESH_MS }, now), true);
  assert.equal(listingIsFresh({ listedAt: now - FRESH_MS - 1 }, now), false);
  assert.equal(listingIsFresh({ listedAt: null }, now), false);
  assert.equal(listingIsFresh({ listedAt: now + 120_000 }, now), false);
  assert.equal(shouldBuyNow({ listedAt: now }, now, now - 10_000), true);
  assert.equal(shouldBuyNow({ listedAt: now - 60_000 }, now, now), false);
});

test("mua DEX ngay một lần và không mua lần hai", async () => {
  const calls = [];
  const notes = [];
  const state = { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] };
  const listing = {
    noticeId: "n1",
    ticker: "SANC",
    market: "KRW-SANC",
    chain: "solana",
    contract: "CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu",
    listedAt: Date.now(),
    url: "https://www.upbit.com/service_center/notice?id=n1",
  };
  const ctx = {
    live: true,
    gasMultiple: 2,
    state,
    now: () => Date.now(),
    stopped: () => false,
    swap: async (item) => {
      calls.push(item.market);
      return { ok: true, tx: "sig123", venue: "Jupiter" };
    },
    notify: (text) => notes.push(text),
    save: () => {},
  };
  const first = await executeListing(listing, ctx);
  const second = await executeListing(listing, ctx);
  assert.deepEqual(calls, ["KRW-SANC"]);
  assert.equal(first.ok, true);
  assert.equal(first.tx, "sig123");
  assert.equal(second.skipped, true);
  assert.match(notes[0], /Mua được/);
  assert.match(notes[0], /Gas x2/);
  assert.equal(state.bought["n1:SANC"].tx, "sig123");
});

test("chế độ xem thử hỏi giá nhưng không giữ giao dịch", async () => {
  let dry = false;
  const notes = [];
  const result = await executeListing({
    noticeId: "n2",
    ticker: "OPEN",
    market: "KRW-OPEN",
    chain: "ethereum",
    contract: "0xa227cc36938f0c9e09ce0e64dfab226cad739447",
    listedAt: Date.now(),
  }, {
    live: false,
    gasMultiple: 2,
    state: { bought: {}, tickerBoughtAt: {} },
    now: () => Date.now(),
    stopped: () => false,
    swap: async (listing) => {
      dry = listing.dry === true;
      return { ok: true, tx: "0xshould-not-stick", reason: "Sẽ mua trên Uniswap V2." };
    },
    notify: (text) => notes.push(text),
  });
  assert.equal(dry, true);
  assert.equal(result.dry, true);
  assert.equal(result.ok, false);
  assert.equal(result.tx, undefined);
  assert.match(notes[0], /xem thử/);
  assert.match(notes[0], /Sẽ mua/);
});

test("kênh Upbit tự đẩy tin, không cần dán link, và chờ contract rồi mới mua", async () => {
  const calls = [];
  const listedAt = new Date().toISOString();
  const client = {
    async listNotices() {
      const error = new Error("blocked");
      error.status = 403;
      throw error;
    },
    async fetchNotice() {
      return null;
    },
    listenAnnouncements(onNotice) {
      onNotice({
        type: "announcement",
        event_type: "CREATED",
        uuid: "notice-1",
        title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
        category: "trade",
        listed_at: listedAt,
        receivedAt: Date.now(),
        body: null,
      });
      onNotice({
        type: "announcement",
        event_type: "UPDATED",
        uuid: "notice-1",
        title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
        category: "trade",
        listed_at: listedAt,
        receivedAt: Date.now(),
        url: "https://www.upbit.com/service_center/notice?id=notice-1&view=share",
        body: "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447",
      });
      return () => {};
    },
  };
  const engine = startEngine({
    client,
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      amounts: { ethereum: 0.01 },
      swap: async (listing) => {
        calls.push(listing.contract);
        return { ok: true, tx: "0xabc", venue: "Uniswap V2" };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  engine.stop();
  assert.deepEqual(calls, ["0xa227cc36938f0c9e09ce0e64dfab226cad739447"]);
});

test("câu chữ Ethereum trong bài không được đè mạng Solana, và không đoán mạng khi chưa có dòng mạng", () => {
  const tagged = `이 프로젝트는 Ethereum에서 시작했습니다.
안내된 네트워크 (SANC-Solana)
SANC 컨트랙트 주소는 CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu`;
  assert.equal(parseNetwork(tagged, "SANC"), "solana");
  const table = "생텀(SANC) | KRW, BTC, USDT | Solana | 곧";
  assert.equal(parseNetwork(table, "SANC"), "solana");
  const vague = "이 프로젝트는 Ethereum에서 시작했습니다. SANC 컨트랙트 주소는 0x1111111111111111111111111111111111111111";
  assert.equal(parseNetwork(vague, "SANC"), "");
  assert.equal(parseContract(`${"1".repeat(80)}`, "SANC"), "");
  assert.equal(parseContract(`SANC 컨트랙트 주소는 ${"1".repeat(64)}`), "");
});

test("giờ đăng còn sau khi đọc lại thông báo, và hai coin không dùng chung một contract", () => {
  const once = coerceNotice({
    title: SANC_TITLE,
    body: SANC_BODY,
    category: "trade",
    listed_at: "2026-11-13T01:00:00Z",
  });
  const twice = decideNotice(once);
  assert.equal(twice.listings[0].listedAt, once.listedAt);
  const shared = decideNotice({
    id: "two",
    title: "에이(AAA), 비(BBB) 신규 거래지원 안내 (KRW 마켓)",
    body: "컨트랙트 주소는 0x1111111111111111111111111111111111111111",
    category: "trade",
    listed_at: "2026-11-13T01:00:00Z",
  });
  assert.deepEqual(shared.listings.map((item) => item.contract), ["", ""]);
});

test("pool lệch giá thì không mua, pool gần nhau thì dùng V2, không mua WETH", () => {
  const suspicious = choosePool(200n, [{ fee: 3000, out: 100n }]);
  assert.equal(suspicious.ok, false);
  const close = choosePool(100n, [{ fee: 500, out: 110n }]);
  assert.equal(close.version, 2);
  assert.equal(close.quoted, 100n);
  const real = choosePool(100n, [{ fee: 3000, out: 180n }]);
  assert.equal(real.version, 3);
  assert.equal(real.feeTier, 3000);
  assert.equal(choosePool(null, []).reason, "NO_POOL");
  assert.equal(isBaseAsset(chainById("ethereum"), "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), true);
  assert.equal(isBaseAsset(chainById("ethereum"), "0x1111111111111111111111111111111111111111"), false);
  const pumped = fdvUsd({
    amountIn: 2n * 10n ** 16n,
    amountOut: 1n * 10n ** 18n,
    totalSupply: 1_000_000_000n * 10n ** 18n,
    nativeUsd: 2000,
    nativeDecimals: 18,
  });
  assert.equal(fdvAllows(pumped, 5_000_000).ok, false);
});

function engineClient(onNotice) {
  return {
    async listNotices() {
      const error = new Error("blocked");
      error.status = 403;
      throw error;
    },
    async fetchNotice() {
      return null;
    },
    listenAnnouncements(handler) {
      onNotice(handler);
      return () => {};
    },
  };
}

test("tin có trước khi bật tool không mua, tin không có giờ không mua, tin mới thì mua một lần", async () => {
  const calls = [];
  let push = () => {};
  const oldAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const engine = startEngine({
    client: engineClient((handler) => {
      push = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      maxFdv: 5_000_000,
      amounts: { ethereum: 0.01 },
      swap: async (listing) => {
        calls.push(listing.contract);
        return { ok: true, tx: "0xabc", venue: "Uniswap V2" };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  const fresh = new Date().toISOString();
  push({
    type: "announcement",
    event_type: "CREATED",
    uuid: "old-1",
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    listed_at: oldAt,
    body: "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447",
  });
  push({
    type: "announcement",
    event_type: "CREATED",
    uuid: "notime",
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    body: "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447",
  });
  push({
    type: "announcement",
    event_type: "CREATED",
    uuid: "new-1",
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    listed_at: fresh,
    body: "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447",
  });
  push({
    type: "announcement",
    event_type: "UPDATED",
    uuid: "new-1",
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    listed_at: fresh,
    body: "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  engine.stop();
  assert.deepEqual(calls, ["0xa227cc36938f0c9e09ce0e64dfab226cad739447"]);
});

test("tin chưa có contract không khoá lệnh, bản sau có contract thì mua", async () => {
  const calls = [];
  let push = () => {};
  const listedAt = new Date().toISOString();
  const engine = startEngine({
    client: engineClient((handler) => {
      push = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      amounts: { ethereum: 0.01 },
      swap: async (listing) => {
        calls.push(listing.contract);
        return { ok: true, tx: "0xabc", venue: "Uniswap V2" };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  push({
    type: "announcement",
    event_type: "CREATED",
    uuid: "late-body",
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    listed_at: listedAt,
    body: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  push({
    type: "announcement",
    event_type: "UPDATED",
    uuid: "late-body",
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    listed_at: listedAt,
    body: "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.stop();
  assert.deepEqual(calls, ["0xa227cc36938f0c9e09ce0e64dfab226cad739447"]);
});

test("cùng ticker đang mua thì không mua thêm, pool chưa có thì thử lại, FDV cao thì dừng", async () => {
  const contracts = [];
  let release = () => {};
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let push = () => {};
  const listedAt = new Date().toISOString();
  const engine = startEngine({
    client: engineClient((handler) => {
      push = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      amounts: { ethereum: 0.01 },
      swap: async (listing) => {
        contracts.push(listing.contract);
        await hold;
        return { ok: true, tx: "0xhold", venue: "Uniswap V2" };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  const body = "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447";
  push({
    type: "announcement", event_type: "CREATED", uuid: "hold-1", title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade", listed_at: listedAt, body,
  });
  push({
    type: "announcement", event_type: "CREATED", uuid: "hold-2", title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade", listed_at: listedAt, body,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(contracts, ["0xa227cc36938f0c9e09ce0e64dfab226cad739447"]);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.stop();

  let tries = 0;
  let pushRetry = () => {};
  const retry = startEngine({
    client: engineClient((handler) => {
      pushRetry = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      amounts: { ethereum: 0.01 },
      swap: async () => {
        tries += 1;
        if (tries === 1) return { ok: false, reason: "Không thấy pool DEX cho token trên ethereum." };
        return { ok: true, tx: "0xretry", venue: "Uniswap V3" };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  pushRetry({
    type: "announcement", event_type: "CREATED", uuid: "retry-1", title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade", listed_at: new Date().toISOString(), body,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  retry.stop();
  assert.equal(tries, 2);

  let fdvTries = 0;
  let pushFdv = () => {};
  const fdv = startEngine({
    client: engineClient((handler) => {
      pushFdv = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      maxFdv: 1_000_000,
      amounts: { ethereum: 0.01 },
      swap: async () => {
        fdvTries += 1;
        return { ok: false, reason: "FDV 9,000,000 USD cao hơn mức tối đa 1,000,000 USD." };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  pushFdv({
    type: "announcement", event_type: "CREATED", uuid: "fdv-1", title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade", listed_at: new Date().toISOString(), body,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  fdv.stop();
  assert.equal(fdvTries, 1);
});

const MC = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const V2_RESULT = new ethers.Interface(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
const V3_RESULT = new ethers.Interface(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint256,uint32,uint160)"]);
const SUPPLY_RESULT = new ethers.Interface(["function totalSupply() view returns (uint256)"]);
const RESERVE_RESULT = new ethers.Interface([
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function balanceOf(address) view returns (uint256)",
]);

function quotePayload(plan, valueFor) {
  const rows = plan.map((step) => {
    const spec = valueFor(step);
    if (!spec) return [false, "0x"];
    if (step.kind === "v2") return [true, V2_RESULT.encodeFunctionResult("getAmountsOut", [[0n, spec]])];
    if (step.kind === "v3") return [true, V3_RESULT.encodeFunctionResult("quoteExactInputSingle", [spec, 0n, 0, 0n])];
    if (step.kind === "v2reserves") {
      const reserve0 = step.wrappedIs0 ? spec.native : spec.token;
      const reserve1 = step.wrappedIs0 ? spec.token : spec.native;
      return [true, RESERVE_RESULT.encodeFunctionResult("getReserves", [reserve0, reserve1, 0])];
    }
    if (step.kind === "v3native" || step.kind === "v3token") {
      return [true, RESERVE_RESULT.encodeFunctionResult("balanceOf", [spec])];
    }
    return [true, SUPPLY_RESULT.encodeFunctionResult("totalSupply", [spec])];
  });
  return MC.encodeFunctionResult("aggregate3", [rows]);
}

function fakeProvider(onCall) {
  const calls = [];
  return {
    calls,
    async getFeeData() {
      calls.push("fee");
      return { maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 1n * 10n ** 9n, gasPrice: 2n * 10n ** 9n };
    },
    async getTransactionCount() {
      calls.push("nonce");
      return 4;
    },
    async call(tx) {
      calls.push("quote");
      return onCall(tx, calls);
    },
    async broadcastTransaction() {
      calls.push("send");
      return { hash: `0x${"ab".repeat(32)}`, wait: async () => ({ status: 1 }) };
    },
  };
}

test("hỏi giá một lần khi RPC đã nóng, pool lệch hoặc FDV cao thì không gửi", async () => {
  const chain = chainById("ethereum");
  const token = "0x1111111111111111111111111111111111111111";
  const value = ethers.parseEther("0.01");
  const plan = quoteCalls(chain, token, value, false);
  assert.equal(plan.filter((step) => step.kind === "v2").length, 1);
  assert.equal(plan.filter((step) => step.kind === "v3").length, 4);
  assert.equal(plan.filter((step) => step.kind === "v2reserves").length, 1);
  const raw = quotePayload(plan, (step) => {
    if (step.kind === "v2") return 1_000_000n;
    if (step.fee === 3000) return 900_000n;
    return null;
  });
  const decoded = decodeQuote(plan, raw);
  assert.equal(decoded.v2, 1_000_000n);
  assert.equal(choosePool(decoded.v2, decoded.v3).version, 2);

  const provider = fakeProvider((tx) => {
    assert.equal(String(tx.to).toLowerCase(), MULTICALL.toLowerCase());
    return raw;
  });
  const buyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    maxFdv: null,
    providerFor: () => provider,
  });
  await buyer.warm();
  provider.calls.length = 0;
  const started = Date.now();
  const bought = await buyer.buy({ chain: "ethereum", contract: token, receivedAt: started });
  buyer.stop();
  assert.deepEqual(provider.calls, ["fee", "quote", "send"]);
  assert.equal(bought.ok, true);
  assert.equal(bought.pending, true);
  assert.equal(bought.venue, "Uniswap V2");
  assert.ok(Date.now() - started < 100);

  const skewed = quotePayload(plan, (step) => {
    if (step.kind === "v2") return 10_000n;
    if (step.fee === 3000) return 1_000n;
    return null;
  });
  const skewProvider = fakeProvider(() => skewed);
  const skewBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    providerFor: () => skewProvider,
  });
  await skewBuyer.warm();
  skewProvider.calls.length = 0;
  const refused = await skewBuyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  skewBuyer.stop();
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /lệch giá/);
  assert.deepEqual(skewProvider.calls, ["fee", "quote"]);

  const cappedPlan = quoteCalls(chain, token, value, true);
  const cappedRaw = quotePayload(cappedPlan, (step) => {
    if (step.kind === "v2") return 1_000_000n;
    if (step.kind === "supply") return 10n ** 30n;
    return null;
  });
  const cappedProvider = fakeProvider(() => cappedRaw);
  const cappedBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    maxFdv: 1,
    providerFor: () => cappedProvider,
  });
  await cappedBuyer.warm();
  cappedProvider.calls.length = 0;
  const overCap = await cappedBuyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  cappedBuyer.stop();
  assert.equal(overCap.ok, false);
  assert.match(overCap.reason, /FDV/);
  assert.deepEqual(cappedProvider.calls, ["fee", "quote"]);
});

test("multicall hỏng thì vẫn đọc được pool V2", async () => {
  const chain = chainById("ethereum");
  const token = "0x1111111111111111111111111111111111111111";
  const value = ethers.parseEther("0.01");
  let first = true;
  const provider = {
    async call(tx) {
      if (first) {
        first = false;
        throw new Error("multicall down");
      }
      if (String(tx.to).toLowerCase() === chain.v2Router.toLowerCase()) {
        return V2_RESULT.encodeFunctionResult("getAmountsOut", [[0n, 1234n]]);
      }
      throw new Error("no pool");
    },
  };
  const bundle = await quoteOnProvider(provider, chain, token, value, false);
  assert.equal(bundle.v2, 1234n);
  assert.equal(first, false);
});

test("pool mỏng hơn 100k mỗi bên thì không gửi giao dịch", async () => {
  const chain = chainById("ethereum");
  const token = "0x1111111111111111111111111111111111111111";
  const value = ethers.parseEther("0.01");
  const plan = quoteCalls(chain, token, value, false);
  const thin = quotePayload(plan, (step) => {
    if (step.kind === "v2") return 10n ** 18n;
    if (step.kind === "v2reserves") return { native: 10n ** 18n, token: 10n ** 20n };
    return null;
  });
  const thinProvider = fakeProvider(() => thin);
  const thinBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    minLiquidity: 100_000,
    prices: { ETH: 2000 },
    providerFor: () => thinProvider,
  });
  await thinBuyer.warm();
  thinProvider.calls.length = 0;
  const refused = await thinBuyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  thinBuyer.stop();
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Thanh khoản thấp/);
  assert.match(refused.reason, /100,000 USD/);
  assert.deepEqual(thinProvider.calls, ["fee", "quote"]);

  const deep = quotePayload(plan, (step) => {
    if (step.kind === "v2") return 10n ** 18n;
    if (step.kind === "v2reserves") return { native: 100n * 10n ** 18n, token: 10n ** 22n };
    return null;
  });
  const deepProvider = fakeProvider(() => deep);
  const deepBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    minLiquidity: 100_000,
    prices: { ETH: 2000 },
    providerFor: () => deepProvider,
  });
  await deepBuyer.warm();
  deepProvider.calls.length = 0;
  const bought = await deepBuyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  deepBuyer.stop();
  assert.equal(bought.ok, true);
  assert.equal(Math.round(bought.nativeLiquidity), 200_000);
  assert.equal(Math.round(bought.tokenLiquidity), 200_000);
  assert.deepEqual(deepProvider.calls, ["fee", "quote", "send"]);

  const unread = quotePayload(plan, (step) => (step.kind === "v2" ? 10n ** 18n : null));
  const unreadProvider = fakeProvider(() => unread);
  const unreadBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    minLiquidity: 100_000,
    prices: { ETH: 2000 },
    providerFor: () => unreadProvider,
  });
  await unreadBuyer.warm();
  unreadProvider.calls.length = 0;
  const blocked = await unreadBuyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  unreadBuyer.stop();
  assert.match(blocked.reason, /Không đọc được thanh khoản/);
  assert.deepEqual(unreadProvider.calls, ["fee", "quote"]);

  const preview = fakeProvider(() => deep);
  const previewBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    minLiquidity: 100_000,
    prices: { ETH: 2000 },
    providerFor: () => preview,
  });
  await previewBuyer.warm();
  preview.calls.length = 0;
  const looked = await previewBuyer.buy({ chain: "ethereum", contract: token, dry: true, receivedAt: Date.now() });
  previewBuyer.stop();
  assert.equal(looked.dry, true);
  assert.match(looked.reason, /Sẽ mua trên Uniswap V2/);
  assert.match(looked.reason, /200,000 USD/);
  assert.deepEqual(preview.calls, ["fee", "quote"]);
});

test("gửi xong là trả về, socket đứt thì hỏi lại một lần", async () => {
  const chain = chainById("ethereum");
  const token = "0x1111111111111111111111111111111111111111";
  const value = ethers.parseEther("0.01");
  const plan = quoteCalls(chain, token, value, false);
  const raw = quotePayload(plan, (step) => (step.kind === "v2" ? 1_000_000n : null));
  let settled;
  const settledPromise = new Promise((resolve) => {
    settled = resolve;
  });
  let waited = false;
  const provider = fakeProvider(() => raw);
  provider.broadcastTransaction = async () => ({
    hash: `0x${"cd".repeat(32)}`,
    async wait() {
      await new Promise((resolve) => setTimeout(resolve, 250));
      waited = true;
      return { status: 0 };
    },
  });
  const buyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    providerFor: () => provider,
    onReceipt: (info) => settled(info),
  });
  await buyer.warm();
  provider.calls.length = 0;
  const started = Date.now();
  const bought = await buyer.buy({ chain: "ethereum", contract: token, market: "KRW-OPEN", receivedAt: started });
  assert.equal(bought.pending, true);
  assert.equal(waited, false);
  assert.ok(Date.now() - started < 100);
  const receipt = await settledPromise;
  buyer.stop();
  assert.equal(waited, true);
  assert.equal(receipt.ok, false);
  assert.match(receipt.reason, /revert/);
  assert.match(resultText(receipt), /không mua thêm/);

  let quotes = 0;
  const flaky = fakeProvider(() => {
    quotes += 1;
    if (quotes === 1) throw new Error("socket hang up");
    return raw;
  });
  const flakyBuyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    providerFor: () => flaky,
  });
  await flakyBuyer.warm();
  flaky.calls.length = 0;
  quotes = 0;
  const recovered = await flakyBuyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  flakyBuyer.stop();
  assert.equal(recovered.pending, true);
  assert.equal(quotes, 2);
});

test("cùng một lệnh được gửi trên hai đường RPC", async () => {
  const chain = chainById("ethereum");
  const token = "0x1111111111111111111111111111111111111111";
  const value = ethers.parseEther("0.01");
  const plan = quoteCalls(chain, token, value, false);
  const raw = quotePayload(plan, (step) => (step.kind === "v2" ? 1_000_000n : null));
  const provider = fakeProvider(() => raw);
  const extra = [];
  const buyer = createBuyer({
    evmPrivateKey: `0x${"11".repeat(32)}`,
    amounts: { ethereum: 0.01 },
    gasMultiple: 2,
    slippagePercent: 10,
    providerFor: () => provider,
    broadcastFor: () => ({
      async broadcastTransaction(signed) {
        extra.push(signed);
        return { hash: `0x${"ef".repeat(32)}`, wait: async () => ({ status: 1 }) };
      },
    }),
  });
  await buyer.warm();
  provider.calls.length = 0;
  const bought = await buyer.buy({ chain: "ethereum", contract: token, receivedAt: Date.now() });
  buyer.stop();
  assert.equal(bought.pending, true);
  assert.equal(extra.length, 1);
  assert.equal(provider.calls.filter((call) => call === "send").length, 1);
});

test("chưa có giá thì thử lại, pool mỏng thì dừng", async () => {
  const body = "안내된 네트워크 (OPEN-Ethereum)\nOPEN 컨트랙트 주소는 0xa227cc36938f0c9e09ce0e64dfab226cad739447";
  const notice = (id) => ({
    type: "announcement",
    event_type: "CREATED",
    uuid: id,
    title: "오픈(OPEN) 신규 거래지원 안내 (KRW 마켓)",
    category: "trade",
    listed_at: new Date().toISOString(),
    body,
  });
  let tries = 0;
  let push = () => {};
  const engine = startEngine({
    client: engineClient((handler) => {
      push = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      amounts: { ethereum: 0.01 },
      swap: async () => {
        tries += 1;
        if (tries === 1) return { ok: false, reason: "Chưa có giá USD nên không mua." };
        return { ok: true, tx: "0xprice", pending: true };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  push(notice("price-1"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  engine.stop();
  assert.equal(tries, 2);

  let thinTries = 0;
  let pushThin = () => {};
  const thin = startEngine({
    client: engineClient((handler) => {
      pushThin = handler;
    }),
    config: {
      live: true,
      gasMultiple: 2,
      slippagePercent: 10,
      amounts: { ethereum: 0.01 },
      swap: async () => {
        thinTries += 1;
        return { ok: false, reason: "Thanh khoản thấp: ETH 1,000 USD, token 1,000 USD. Cần mỗi bên ít nhất 100,000 USD." };
      },
    },
    log: () => {},
    notify: () => {},
    state: { bought: {}, tickerBoughtAt: {}, notified: {}, armed: [] },
  });
  pushThin(notice("thin-1"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  thin.stop();
  assert.equal(thinTries, 1);
});

test("một API key Alchemy phủ bảy chain và lỗi không chứa key", () => {
  const key = "A".repeat(32);
  const urls = expandRpc("alchemy", key);
  assert.equal(urls.ethereum, `wss://eth-mainnet.g.alchemy.com/v2/${key}`);
  assert.equal(urls.bsc, `wss://bnb-mainnet.g.alchemy.com/v2/${key}`);
  assert.equal(urls.solana, `wss://solana-mainnet.g.alchemy.com/v2/${key}`);
  assert.equal(Object.keys(urls).length, 7);
  const fromLink = expandRpc("infura", `https://eth-mainnet.g.alchemy.com/v2/${key}`);
  assert.equal(fromLink.base, `wss://base-mainnet.g.alchemy.com/v2/${key}`);
  const pair = endpointPair(urls.ethereum);
  assert.equal(pair.http, `https://eth-mainnet.g.alchemy.com/v2/${key}`);
  assert.equal(buyUrl(`https://mainnet.infura.io/v3/${key}`), `wss://mainnet.infura.io/v3/${key}`);
  assert.equal(endpointPair("https://example-rpc.invalid/path").ws, "");
  const kept = resolveRpcChoice({ provider: "alchemy", secret: "", saved: { ethereum: "https://rpc.example/eth" } });
  assert.equal(kept.ethereum, "https://rpc.example/eth");
  assert.deepEqual(resolveRpcChoice({ provider: "public", saved: { ethereum: "https://rpc.example/eth" } }).ethereum, "");
  const leaked = `request to https://eth-mainnet.g.alchemy.com/v2/${key} failed`;
  const scrubbed = scrubRpcError(leaked, key);
  assert.equal(scrubbed.includes(key), false);
  assert.equal(scrubbed.includes("alchemy.com"), false);
});
