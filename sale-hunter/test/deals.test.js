import assert from "node:assert/strict";
import test from "node:test";
import { huntTier, isHuntDeal, matchFilter, normalizeShopeeItem, shelfDeals, sortDeals } from "../src/deals.js";
import { discountPercent, formatVnd, isOneDong, shopeeUrl, vndFromMicro } from "../src/money.js";
import { createRadar } from "../src/radar.js";
import { parseTikTokPayload } from "../src/tiktok.js";

const session = { id: 1, label: "09:00–12:00", end: 1_700_000_000, ongoing: true };

function item(overrides) {
  return {
    itemid: 42222131630,
    shopid: 1628729099,
    name: "Cà phê Cold Brew",
    price: 31_281_600_000,
    price_before_discount: 84_545_000_000,
    raw_discount: 63,
    stock: 8,
    flash_sale_stock: 40,
    image: "vn-11134207-7ra0g-m914g3h3tkef1d",
    historical_sold: 1200,
    item_rating: { rating_star: 4.86 },
    ...overrides,
  };
}

test("giá Shopee đổi từ micro sang đồng", () => {
  assert.equal(vndFromMicro(100_000), 1);
  assert.equal(vndFromMicro(31_281_600_000), 312_816);
  assert.equal(vndFromMicro(0), 0);
});

test("định dạng tiền có dấu chấm", () => {
  assert.equal(formatVnd(1), "1đ");
  assert.equal(formatVnd(312816), "312.816đ");
  assert.equal(formatVnd(3329000), "3.329.000đ");
});

test("mức giảm lấy số sâu hơn giữa raw và giá", () => {
  assert.equal(discountPercent(900_000_000, 5_000_000_000, 82), 82);
  assert.equal(discountPercent(100_000, 10_000_000_000, 0), 99);
  assert.equal(discountPercent(100_000, 0, 0), 0);
});

test("1đ và link mua luôn có shopid itemid", () => {
  const deal = normalizeShopeeItem(item({ price: 100_000, price_before_discount: 5_000_000_000, raw_discount: 99 }), session);
  assert.equal(deal.oneDong, true);
  assert.equal(deal.deep, true);
  assert.equal(deal.priceText, "1đ");
  assert.equal(new URL(deal.url).hostname, "shopee.vn");
  assert.match(deal.url, /^https:\/\/shopee\.vn\/ca-phe-cold-brew-i\.1628729099\.42222131630$/);
  assert.equal(deal.image, "https://down-vn.img.susercontent.com/file/vn-11134207-7ra0g-m914g3h3tkef1d");
  assert.equal(isOneDong(1), true);
  assert.equal(isOneDong(1000), false);
});

test("hết suất và còn ít suất", () => {
  const gone = normalizeShopeeItem(item({ stock: 0, flash_sale_stock: 20 }), session);
  assert.equal(gone.soldOut, true);
  assert.equal(gone.sold, 20);
  const low = normalizeShopeeItem(item({ stock: 4, flash_sale_stock: 40 }), session);
  assert.equal(matchFilter(low, "low"), true);
  assert.equal(matchFilter(gone, "instock"), false);
});

test("cột tách 1đ, từ 90% và từ 70%", () => {
  const mild = normalizeShopeeItem(item(), session);
  const mid = normalizeShopeeItem(
    item({ itemid: 7, raw_discount: 75, price: 250_000_000_000, price_before_discount: 1_000_000_000_000 }),
    session,
  );
  const deep = normalizeShopeeItem(
    item({ itemid: 8, raw_discount: 91, price: 200_000_000_000, price_before_discount: 2_200_000_000_000 }),
    session,
  );
  const one = normalizeShopeeItem(
    item({ itemid: 9, price: 100_000, raw_discount: 99, price_before_discount: 5_000_000 }),
    session,
  );
  assert.equal(huntTier(mild), "");
  assert.equal(huntTier(mid), "70");
  assert.equal(huntTier(deep), "90");
  assert.equal(huntTier(one), "1d");
  assert.equal(isHuntDeal(mild), false);
  assert.equal(isHuntDeal(mid), true);
  const shelf = shelfDeals([mild, mid, deep, one]);
  assert.deepEqual(shelf.map((deal) => deal.itemId), [mild.itemId]);
});

test("lọc 90% không nhận deal 63%", () => {
  const mild = normalizeShopeeItem(item(), session);
  const deep = normalizeShopeeItem(
    item({ itemid: 2, raw_discount: 91, price: 200_000_000_000, price_before_discount: 2_200_000_000_000 }),
    session,
  );
  assert.equal(mild.discount, 63);
  assert.equal(matchFilter(mild, "90"), false);
  assert.equal(matchFilter(deep, "90"), true);
  assert.equal(matchFilter(deep, "cheap"), false);
});

test("xếp 1đ và hời nhiều tiền lên trước, hết suất xuống cuối", () => {
  const one = normalizeShopeeItem(item({ itemid: 1, price: 100_000, price_before_discount: 9_000_000, raw_discount: 99, stock: 2, flash_sale_stock: 5 }), session);
  const big = normalizeShopeeItem(item({ itemid: 2, name: "Máy", price: 332_900_000_000, price_before_discount: 693_500_000_000, raw_discount: 52, stock: 10, flash_sale_stock: 20 }), session);
  const small = normalizeShopeeItem(item({ itemid: 3, price: 5_000_000_000, price_before_discount: 8_000_000_000, raw_discount: 37, stock: 10, flash_sale_stock: 20 }), session);
  const gone = normalizeShopeeItem(item({ itemid: 4, stock: 0, raw_discount: 99, price: 100_000 }), session);
  const ranked = sortDeals([small, gone, big, one], "save").map((deal) => deal.itemId);
  assert.deepEqual(ranked, ["1", "2", "3", "4"]);
});

test("vòng đầu không kêu, vòng sau chỉ kêu khi chạm 1đ hoặc 90%", () => {
  const radar = createRadar();
  const first = [normalizeShopeeItem(item(), session)];
  assert.deepEqual(radar.take(first, 1_000), []);
  assert.equal(first[0].isNew, false);
  const again = [normalizeShopeeItem(item(), session), normalizeShopeeItem(item({ itemid: 9, price: 100_000, raw_discount: 99, price_before_discount: 5_000_000 }), session)];
  const alerts = radar.take(again, 2_000);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].itemId, "9");
  assert.equal(again[1].isNew, true);
  const quiet = radar.take(again, 3_000);
  assert.deepEqual(quiet, []);
});

test("TikTok captcha không bị nhận thành deal", () => {
  const blocked = parseTikTokPayload({ code: 10000 });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.deals, []);
  assert.match(blocked.openUrl, /^https:\/\/shop\.tiktok\.com\/vn\//);
});

test("TikTok bỏ giá USD và không dùng link ngoài Việt Nam", () => {
  const parsed = parseTikTokPayload({
    products: [
      { id: "1", title: "Giá Mỹ", price: 1, currency: "USD", url: "https://shop.tiktok.com/us/pdp/1" },
      { id: "2", title: "Áo 50%", price: 50000, originalPrice: 100000, url: "https://shop.tiktok.com/us/pdp/2" },
    ],
  });
  assert.equal(parsed.deals.length, 1);
  assert.equal(parsed.deals[0].itemId, "2");
  assert.equal(parsed.deals[0].url, "https://shop.tiktok.com/vn/pdp/2");
  assert.equal(isHuntDeal(parsed.deals[0]), false);
});

test("TikTok có giá 1đ thì ra link mua", () => {
  const parsed = parseTikTokPayload({
    products: [{ id: "1729605786167118289", title: "Ốp 1đ", price: 1, originalPrice: 28000, stock: 3 }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.deals[0].oneDong, true);
  assert.equal(parsed.deals[0].deep, true);
  assert.equal(parsed.deals[0].url, "https://shop.tiktok.com/vn/pdp/1729605786167118289");
});

test("slug giữ link sạch", () => {
  assert.equal(
    shopeeUrl(11, 22, "Ốp lưng iPhone 1đ!!!"),
    "https://shopee.vn/op-lung-iphone-1d-i.11.22",
  );
});
