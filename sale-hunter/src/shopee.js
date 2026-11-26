import { cheapDeals, halfOffDeals, isHuntDeal, lowStockDeals, normalizeSession, normalizeShopeeItem, shelfDeals } from "./deals.js";

const ORIGIN = "https://shopee.vn";

const HEADERS = {
  Accept: "application/json",
  Referer: `${ORIGIN}/flash_sale`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "vi-VN,vi;q=0.9",
  "X-API-SOURCE": "pc",
  "X-Shopee-Language": "vi",
};

async function getJson(path) {
  const response = await fetch(`${ORIGIN}${path}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Shopee ${response.status}`);
  }
  const body = await response.json();
  if (body?.error) {
    throw new Error(body.error_msg || `Shopee lỗi ${body.error}`);
  }
  return body;
}

export async function loadShopee(nowSec = Math.floor(Date.now() / 1000)) {
  const sessionsBody = await getJson(
    "/api/v4/flash_sale/get_all_sessions?category_personalization_type=1&tracker_info_version=1",
  );
  const sessions = (sessionsBody?.data?.sessions || []).map((raw) => normalizeSession(raw, nowSec));
  const ongoing = sessions.find((session) => session.ongoing) || sessions[0];
  if (!ongoing) {
    return { sessions: [], deals: [], scanned: 0, watched: "Chưa có khung giờ vàng" };
  }
  const itemsBody = await getJson(
    `/api/v4/flash_sale/flash_sale_get_items?limit=50&offset=0&promotionid=${encodeURIComponent(ongoing.id)}&categoryid=0&sort_soldout=false&need_personalize=false&with_dp_items=true&tracker_info_version=1`,
  );
  const seen = new Set();
  const deals = [];
  for (const raw of itemsBody?.data?.items || []) {
    if (!raw?.itemid || seen.has(raw.itemid)) continue;
    const deal = normalizeShopeeItem(raw, ongoing);
    if (!deal || !deal.url.startsWith("https://shopee.vn/")) continue;
    seen.add(raw.itemid);
    deals.push(deal);
  }
  const hunts = deals.filter(isHuntDeal);
  const deepest = deals.reduce((max, deal) => Math.max(max, deal.discount || 0), 0);
  return {
    sessions,
    deals: hunts,
    cheap: cheapDeals(deals),
    half: halfOffDeals(deals),
    low: lowStockDeals(deals),
    shelf: shelfDeals(deals),
    scanned: deals.length,
    deepest,
    watched: `Shopee Việt Nam · ${ongoing.label}`,
  };
}
