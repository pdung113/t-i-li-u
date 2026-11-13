import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { queryString, readJwtPayload, signJwt } from "../src/auth.js";
import { decideNotice, kstToMs, parseKoreanDate } from "../src/notice.js";
import { buildOrder, explainError, judgeResponse } from "../src/order.js";
import { limitVolume, roundUpToTick, tickSize } from "../src/price.js";
import { executeListing } from "../src/engine.js";
import { resultText } from "../src/telegram.js";

const SANC_TITLE = "생텀(SANC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)";
const SANC_BODY = `
디지털 자산 | 마켓 | 네트워크 | 입출금 개시 시점 | 거래지원 개시 시점
생텀(SANC) | KRW, BTC, USDT | Solana | 공지 게시 시점으로부터 1시간 이내 | 11월 13일 13시 예정
※ 거래 제한 안내
매수 제한 : 거래 지원 이후 약 5분간 매수 주문이 제한됩니다.
최저 매도가 제한 : 거래 지원 이후 약 5분간 전일 종가 대비 10% 이하 가격의 매도 주문이 제한됩니다.
주문 타입 제한 : 거래 지원 이후 약 2시간 동안 지정가 주문을 제외한 모든 타입 및 조건의 주문이 제한됩니다.
전일 종가 | 최근 시세 (11월 13일 11시 10분 기준)
SANC | 58.45 KRW | 58.37 KRW
| 0.04382 USDT | 0.04383 USDT
`;

const listedAt = Date.parse("2026-11-12T21:25:00+09:00");

test("thông báo SANC là listing KRW, mua sau 5 phút bằng lệnh giới hạn", () => {
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
  assert.equal(listing.openAt, Date.parse("2026-11-13T13:00:00+09:00"));
  assert.equal(listing.buyBanMs, 5 * 60 * 1000);
  assert.equal(listing.limitOnlyMs, 2 * 60 * 60 * 1000);
  assert.equal(listing.refPrice, 58.37);

  const order = buildOrder(
    { ...listing, identifier: "order-1" },
    { budgetKrw: 100000, multiple: 2, atMs: listing.openAt + listing.buyBanMs },
  );
  assert.equal(order.kind, "limit");
  assert.equal(order.params.price, "117");
  assert.equal(order.params.ord_type, "limit");
  assert.equal(order.params.market, "KRW-SANC");
  assert.equal(order.params.side, "bid");
  assert.ok(Number(order.params.volume) * 117 * 1.0005 <= 100000);
  assert.equal(order.params.volume, String(limitVolume(100000, 117)));
});

test("bỏ listing không có KRW, thêm thị trường, và thông báo đóng giao dịch", () => {
  const btc = decideNotice({ title: "페페(PEPE) 신규 거래지원 안내 (BTC, USDT 마켓)", category: "trade" });
  assert.equal(btc.reason, "no-krw");
  const added = decideNotice({ title: "아이오타(IOTA) KRW 마켓 추가", category: "trade" });
  assert.equal(added.reason, "not-new-listing");
  const closed = decideNotice({ title: "샌텀(SANC) 거래지원 종료 안내 (KRW 마켓)", category: "trade" });
  assert.equal(closed.reason, "not-new-listing");
});

test("một thông báo hai coin KRW tạo hai lệnh", () => {
  const decision = decideNotice({
    id: "abc",
    title: "에이(AAA), 비(BBB) 신규 거래지원 안내 (KRW 마켓)",
    body: "거래지원 개시 시점 11월 14일 9시 30분\n거래 제한\n매수 제한 약 5분간\n약 2시간 동안 지정가\n최근 시세 10 KRW",
    category: "거래",
    listed_at: "2026-11-13T09:00:00+09:00",
  });
  assert.deepEqual(decision.listings.map((item) => item.market), ["KRW-AAA", "KRW-BBB"]);
  assert.equal(decision.listings[0].openAt, kstToMs(2026, 11, 14, 9, 30));
});

test("không có câu hạn chế thì mua thị trường đúng số KRW", () => {
  const decision = decideNotice({
    id: "now",
    title: "코인(FAST) 신규 거래지원 안내 (KRW 마켓)",
    body: "거래지원 개시 시점 11월 13일 오후 1시\n최근 시세 20 KRW",
    category: "trade",
    listed_at: "2026-11-13T12:00:00+09:00",
  });
  const listing = decision.listings[0];
  assert.equal(listing.buyBanMs, 0);
  assert.equal(listing.limitOnlyMs, 0);
  assert.equal(listing.openAt, Date.parse("2026-11-13T13:00:00+09:00"));
  const order = buildOrder({ ...listing, identifier: "m1" }, { budgetKrw: 50000, multiple: 2, atMs: listing.openAt });
  assert.equal(order.params.ord_type, "price");
  assert.equal(order.params.price, "50000");
  assert.equal(order.params.volume, undefined);
});

test("đọc được nội dung HTML và giờ chiều", () => {
  const decision = decideNotice({
    title: "코인(HTML) 신규 거래지원 안내 (KRW 마켓)",
    body: "<p>거래지원 개시 시점</p><p>11월 2일 오후 1시 05분</p><p>거래 제한</p><p>매수 제한 약 10분간</p>",
    listed_at: "2026-11-01T00:00:00+09:00",
    category: "trade",
  });
  assert.equal(decision.listings[0].openAt, kstToMs(2026, 11, 2, 13, 5));
  assert.equal(decision.listings[0].buyBanMs, 10 * 60 * 1000);
  assert.equal(parseKoreanDate("11월 13일 13:00", listedAt), Date.parse("2026-11-13T13:00:00+09:00"));
});

test("bước giá KRW làm tròn lên", () => {
  assert.equal(tickSize(15), 0.1);
  assert.equal(roundUpToTick(15.01), 15.1);
  assert.equal(roundUpToTick(116.74), 117);
  assert.equal(tickSize(1_000_000), 1000);
  assert.equal(tickSize(999_999), 500);
  assert.equal(tickSize(5_000), 5);
  assert.equal(tickSize(4_999), 1);
  assert.equal(tickSize(100), 1);
  assert.equal(tickSize(99.9), 0.1);
  assert.equal(tickSize(0.000009), 0.00000001);
});

test("JWT ký đúng chuỗi tham số lệnh, không kèm query khi chỉ mở socket", () => {
  const query = queryString({
    market: "KRW-BTC",
    side: "bid",
    volume: "0.01",
    price: "100.0",
    ord_type: "limit",
  });
  assert.equal(query, "market=KRW-BTC&side=bid&volume=0.01&price=100.0&ord_type=limit");
  const token = signJwt("access", "secret", query);
  const payload = readJwtPayload(token);
  assert.equal(payload.access_key, "access");
  assert.equal(payload.query_hash_alg, "SHA512");
  assert.equal(payload.query_hash, crypto.createHash("sha512").update(query).digest("hex"));
  assert.equal(token.split(".").length, 3);
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "HS512");
  const socketToken = readJwtPayload(signJwt("access", "secret"));
  assert.equal(socketToken.query_hash, undefined);
});

test("phân loại lỗi mua được và không mua được", () => {
  assert.equal(judgeResponse(201, { uuid: "u1" }).ok, true);
  assert.equal(judgeResponse(400, { error: { name: "insufficient_funds_bid", message: "부족" } }).fatal, true);
  assert.equal(judgeResponse(400, { error: { name: "invalid_price_bid" } }).correctable, "price");
  assert.match(explainError("no_authorization_ip", "ip"), /IP/);
  const text = resultText({ ok: false, market: "KRW-SANC", reason: "Không đủ KRW." });
  assert.match(text, /Không mua được/);
  assert.doesNotMatch(text, /secret|private/i);
  assert.match(resultText({ ok: true, market: "KRW-SANC", orderUuid: "u1", kind: "limit", price: "117", volume: "10" }), /Mua được/);
});

test("không gửi lệnh trước khi hết thời gian cấm mua", async () => {
  let placed = 0;
  const clock = { value: 0 };
  const result = await executeListing({
    noticeId: "n1",
    ticker: "SANC",
    market: "KRW-SANC",
    openAt: null,
    buyBanMs: 5 * 60 * 1000,
    limitOnlyMs: 2 * 60 * 60 * 1000,
    refPrice: 58.37,
    listedAt: 0,
  }, {
    budgetKrw: 100000,
    multiple: 2,
    live: true,
    state: { bought: {}, tickerBoughtAt: {}, armed: [] },
    now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; },
    stopped: () => false,
    deadline: 1000,
    hasMarket: () => true,
    place: async () => { placed += 1; return { ok: true, order: { uuid: "x" } }; },
  });
  assert.equal(placed, 0);
  assert.equal(result.reason, "stopped");
});

test("đặt một lệnh giới hạn đúng giờ và không đặt lần hai", async () => {
  const calls = [];
  const clock = { value: 1_290_000 };
  const state = { bought: {}, tickerBoughtAt: {}, armed: [] };
  const listing = {
    noticeId: "n1",
    ticker: "SANC",
    market: "KRW-SANC",
    openAt: 1_000_000,
    buyBanMs: 300_000,
    limitOnlyMs: 7_200_000,
    refPrice: 58.37,
    listedAt: 0,
    url: "https://www.upbit.com/service_center/notice?id=n1",
  };
  const ctx = {
    budgetKrw: 100000,
    multiple: 2,
    live: true,
    state,
    now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; },
    stopped: () => false,
    hasMarket: () => true,
    krwBalance: async () => 200000,
    chance: async () => ({ fee: 0.0005 }),
    bestAsk: async () => 60,
    place: async (params) => {
      calls.push({ at: clock.value, params });
      return { ok: true, order: { uuid: "order-uuid" } };
    },
  };
  const notes = [];
  ctx.notify = (text) => notes.push(text);
  const result = await executeListing(listing, ctx);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].at >= 1_300_000);
  assert.equal(calls[0].params.ord_type, "limit");
  assert.equal(calls[0].params.price, "117");
  assert.equal(result.ok, true);
  assert.match(notes[0], /Mua được/);
  assert.equal(state.bought["n1:SANC"].uuid, "order-uuid");
});
