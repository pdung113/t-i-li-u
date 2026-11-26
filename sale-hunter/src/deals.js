import {
  discountPercent,
  formatVnd,
  imageUrl,
  isDeepDiscount,
  isOneDong,
  shopeeUrl,
  vndFromMicro,
} from "./money.js";

export function normalizeShopeeItem(raw, session) {
  const shopId = raw?.shopid;
  const itemId = raw?.itemid;
  if (!shopId || !itemId) return null;
  const name = String(raw.name || raw.promo_name || "Sản phẩm Shopee").trim();
  const priceVnd = vndFromMicro(raw.price);
  const wasVnd = vndFromMicro(raw.price_before_discount);
  const discount = discountPercent(raw.price, raw.price_before_discount, raw.raw_discount);
  const stockTotal = Math.max(0, Number(raw.flash_sale_stock) || 0);
  const stock = Math.max(0, Number(raw.stock) || 0);
  const sold = stockTotal > 0 ? Math.max(0, stockTotal - stock) : 0;
  const soldOut = stock <= 0;
  const oneDong = isOneDong(priceVnd);
  const deep = isDeepDiscount(discount);
  const rating = Number(raw.item_rating?.rating_star);
  return {
    id: `shopee:${itemId}`,
    platform: "shopee",
    shopId: String(shopId),
    itemId: String(itemId),
    name,
    priceVnd,
    wasVnd: wasVnd > priceVnd ? wasVnd : 0,
    saveVnd: wasVnd > priceVnd ? wasVnd - priceVnd : 0,
    discount,
    stock,
    stockTotal,
    sold,
    soldOut,
    oneDong,
    deep,
    image: imageUrl(raw.image),
    url: shopeeUrl(shopId, itemId, name),
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : 0,
    soldCount: Math.max(0, Number(raw.historical_sold) || 0),
    official: Boolean(raw.is_shop_official),
    sessionId: session?.id || raw.promotionid || null,
    sessionLabel: session?.label || "",
    sessionEnd: session?.end || raw.end_time || 0,
    sessionOngoing: session ? Boolean(session.ongoing) : true,
    priceText: priceVnd > 0 ? formatVnd(priceVnd) : "Chưa hiện giá",
    wasText: wasVnd > priceVnd ? formatVnd(wasVnd) : "",
    saveText: wasVnd > priceVnd ? formatVnd(wasVnd - priceVnd) : "",
  };
}

export function normalizeSession(raw, nowSec) {
  const start = Number(raw.start_time) || 0;
  const end = Number(raw.end_time) || 0;
  return {
    id: raw.promotionid,
    name: raw.name || "",
    start,
    end,
    ongoing: Boolean(raw.is_ongoing) || (start <= nowSec && nowSec < end),
    label: rangeLabel(start, end),
  };
}

export function rangeLabel(startSec, endSec) {
  const a = clock(startSec);
  const b = clock(endSec);
  if (!a || !b) return "Flash sale";
  return `${a}–${b}`;
}

function clock(sec) {
  if (!sec) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(sec * 1000));
}

export function huntTier(deal) {
  if (!deal) return "";
  if (deal.oneDong) return "1d";
  if (deal.discount >= 90) return "90";
  if (deal.discount >= 70) return "70";
  return "";
}

export function isHuntDeal(deal) {
  return Boolean(huntTier(deal));
}

export function isDeepSale(deal) {
  return deal?.platform === "tiktok" && deal.discount >= 50 && !isHuntDeal(deal);
}

export function shelfDeals(deals, limit = 16) {
  return [...(deals || [])]
    .filter((deal) => deal && !isHuntDeal(deal) && !isDeepSale(deal) && deal.priceVnd > 0 && !deal.soldOut)
    .sort((a, b) => (b.saveVnd || 0) - (a.saveVnd || 0) || b.discount - a.discount)
    .slice(0, limit);
}

export function matchFilter(deal, filter) {
  switch (filter) {
    case "1d":
      return deal.oneDong;
    case "90":
      return deal.discount >= 90;
    case "cheap":
      return deal.priceVnd > 0 && deal.priceVnd <= 50_000;
    case "low":
      return !deal.soldOut && deal.stockTotal > 0 && deal.stock / deal.stockTotal <= 0.3;
    case "instock":
      return !deal.soldOut;
    default:
      return true;
  }
}

export function huntRank(deal) {
  if (deal.soldOut) return -1;
  let score = deal.saveVnd + deal.discount;
  if (deal.oneDong) score += 1e15;
  else if (deal.deep) score += 1e14;
  return score;
}

export function sortDeals(deals, mode = "save") {
  const list = [...deals];
  const tie = (a, b) => String(a.itemId).localeCompare(String(b.itemId));
  list.sort((a, b) => {
    if (a.soldOut !== b.soldOut) return a.soldOut ? 1 : -1;
    const pin = (deal) => (deal.oneDong ? 2 : deal.deep ? 1 : 0);
    if (mode !== "price" && mode !== "stock" && pin(a) !== pin(b)) return pin(b) - pin(a);
    if (mode === "discount") {
      if (b.discount !== a.discount) return b.discount - a.discount;
      if (b.saveVnd !== a.saveVnd) return b.saveVnd - a.saveVnd;
      return tie(a, b);
    }
    if (mode === "price") {
      const ap = a.priceVnd || Number.MAX_SAFE_INTEGER;
      const bp = b.priceVnd || Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
      return tie(a, b);
    }
    if (mode === "stock") {
      const ar = a.stockTotal > 0 ? a.stock / a.stockTotal : 1;
      const br = b.stockTotal > 0 ? b.stock / b.stockTotal : 1;
      if (ar !== br) return ar - br;
      return tie(a, b);
    }
    const diff = huntRank(b) - huntRank(a);
    if (diff !== 0) return diff;
    return tie(a, b);
  });
  return list;
}
