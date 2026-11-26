import { isHuntDeal } from "./deals.js";
import { formatVnd } from "./money.js";

const SEARCH_URL = "https://shop.tiktok.com/vn/s?q=1%C4%91";
const WORDS = ["1đ", "sale"];

function blocked(message) {
  return {
    ok: false,
    deals: [],
    message,
    openUrl: SEARCH_URL,
  };
}

export function parseTikTokPayload(body) {
  if (!body || typeof body !== "object") return blocked("TikTok không trả danh sách sản phẩm.");
  if (body.code === 10000 || body.error === 10000) {
    return blocked("TikTok Shop đang chặn máy chủ bằng captcha, chưa đọc được deal 1đ.");
  }
  const list = body.products || body.data?.products || body.data?.product_list || [];
  if (!Array.isArray(list)) return blocked("TikTok Shop chưa trả deal nào cho máy chủ này.");
  const deals = [];
  for (const raw of list) {
    const itemId = raw.id || raw.product_id || raw.productId;
    const name = String(raw.title || raw.name || "").trim();
    const info = raw.product_price_info || {};
    const currency = String(info.currency_name || info.currency || raw.currency || "VND").toUpperCase();
    if (!itemId || !name || (currency !== "VND" && currency !== "₫")) continue;
    const priceVnd = numberPrice(info.sale_price_decimal ?? info.sale_price ?? raw.price ?? raw.priceVnd ?? raw.sale_price);
    const wasVnd = numberPrice(info.origin_price_decimal ?? info.original_price ?? raw.originalPrice ?? raw.original_price ?? raw.wasVnd);
    const labeled = Number(String(info.discount_format || raw.discount || "").replace(/[^\d.]/g, ""));
    const discount = Math.max(
      0,
      Math.min(99, Math.round(labeled || (wasVnd > priceVnd && priceVnd > 0 ? (1 - priceVnd / wasVnd) * 100 : 0))),
    );
    const oneDong = priceVnd > 0 && priceVnd <= 1;
    const hasStock = raw.stock != null && raw.stock !== "";
    const stock = hasStock ? Math.max(0, Number(raw.stock) || 0) : 0;
    const soldOut = raw.sold_out === true || (hasStock && stock <= 0);
    deals.push({
      id: `tiktok:${itemId}`,
      platform: "tiktok",
      shopId: "",
      itemId: String(itemId),
      name,
      priceVnd,
      wasVnd: wasVnd > priceVnd ? wasVnd : 0,
      saveVnd: wasVnd > priceVnd ? wasVnd - priceVnd : 0,
      discount,
      stock,
      stockTotal: stock,
      sold: 0,
      soldOut,
      oneDong,
      deep: discount >= 90,
      image: imageUrl(raw),
      url: vietnamUrl(raw.url || raw.seo_url?.canonical_url, itemId),
      rating: 0,
      soldCount: Number(raw.sold || raw.sold_info?.sold_count) || 0,
      official: false,
      sessionId: null,
      sessionLabel: "TikTok Shop Việt Nam",
      sessionEnd: 0,
      sessionOngoing: true,
      priceText: priceVnd > 0 ? formatVnd(priceVnd) : "Chưa hiện giá",
      wasText: wasVnd > priceVnd ? formatVnd(wasVnd) : "",
      saveText: wasVnd > priceVnd ? formatVnd(wasVnd - priceVnd) : "",
    });
  }
  if (deals.length === 0) return blocked("TikTok trả về nhưng không có sản phẩm đọc được.");
  return { ok: true, deals, message: `TikTok Shop: ${deals.length} món`, openUrl: SEARCH_URL };
}

function vietnamUrl(value, itemId) {
  const fallback = `https://shop.tiktok.com/vn/pdp/${itemId}`;
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol === "https:" && parsed.hostname === "shop.tiktok.com" && parsed.pathname.startsWith("/vn/")) {
      return parsed.href;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function imageUrl(raw) {
  const candidates = [raw.image, raw.image?.url_list?.[0], raw.images?.[0]?.url_list?.[0]];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:") return parsed.href;
    } catch {
      continue;
    }
  }
  return "";
}

function numberPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return 0;
  const cleaned = value.replace(/[^\d,.]/g, "");
  if (!cleaned) return 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) return Number(cleaned.replace(/\./g, ""));
  if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) return Number(cleaned.replace(/,/g, ""));
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export async function loadTikTok() {
  const seen = new Set();
  const deals = [];
  let scanned = 0;
  let deepest = 0;
  try {
    for (const word of WORDS) {
      const body = await searchVietnam(word);
      const parsed = parseTikTokPayload(body);
      if (!parsed.ok && body?.code === 10000) return { ...parsed, scanned, deepest };
      for (const deal of parsed.deals) {
        scanned += 1;
        deepest = Math.max(deepest, deal.discount || 0);
        if (seen.has(deal.id) || !isHuntDeal(deal)) continue;
        if (!deal.url.startsWith("https://shop.tiktok.com/vn/")) continue;
        seen.add(deal.id);
        deals.push(deal);
      }
    }
  } catch {
    return { ...blocked("Không kết nối được TikTok Shop Việt Nam lúc này."), scanned, deepest };
  }
  const depth = deepest ? ` Sâu nhất đã thấy -${deepest}%.` : "";
  return {
    ok: true,
    deals,
    scanned,
    deepest,
    message: deals.length
      ? `TikTok Shop Việt Nam · ${deals.length} deal`
      : `TikTok Shop Việt Nam · chưa có 1đ, -90% hay -70%.${depth}`,
    openUrl: SEARCH_URL,
  };
}

async function searchVietnam(word) {
  const response = await fetch("https://shop.tiktok.com/api/shop/brandy_desktop/s/product_list", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": "vi-VN,vi;q=0.9",
      "Content-Type": "application/json",
      Cookie: "store-country-code=vn",
      Origin: "https://shop.tiktok.com",
      Referer: `https://shop.tiktok.com/vn/s?q=${encodeURIComponent(word)}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      component_info: JSON.stringify({
        component_type: "feed_list",
        component_name: "feed_list_search_word",
        fe_config: {
          is_main_feed: true,
          data_source: { type: "search_word", params: { count: 30, clamp: true } },
        },
      }),
      load_more_params: JSON.stringify({
        offset: 0,
        search_word: word,
        exclude_product_ids: [],
      }),
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  if (/captcha|Security Check/i.test(text)) return { code: 10000 };
  return JSON.parse(text);
}

export const TIKTOK_SEARCH_URL = SEARCH_URL;
