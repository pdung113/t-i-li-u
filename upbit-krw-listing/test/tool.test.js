import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { queryString, readJwtPayload, signJwt } from "../src/auth.js";
import { decideNotice, parseContract, parseNetwork } from "../src/notice.js";
import { executeListing, listingIsFresh, FRESH_MS } from "../src/engine.js";
import { minOut, priorityLamports, scaleUnits } from "../src/networks.js";
import { resultText } from "../src/telegram.js";

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

test("thông báo cũ hơn 3 phút không được coi là mới", () => {
  const now = 1_000_000;
  assert.equal(listingIsFresh({ listedAt: now - FRESH_MS }, now), true);
  assert.equal(listingIsFresh({ listedAt: now - FRESH_MS - 1 }, now), false);
  assert.equal(listingIsFresh({ listedAt: null }, now), false);
  assert.equal(listingIsFresh({ listedAt: null }, now, true), true);
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

test("chế độ xem thử không gọi swap", async () => {
  let called = false;
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
    swap: async () => { called = true; return { ok: true }; },
    notify: (text) => notes.push(text),
  });
  assert.equal(called, false);
  assert.equal(result.dry, true);
  assert.match(notes[0], /xem thử/);
  assert.match(notes[0], /Không mua được|Chưa mua/);
});
