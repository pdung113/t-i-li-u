import { formatVnd } from "./money.js";

const SEARCH_URL = `https://www.tiktok.com/search?q=${encodeURIComponent("săn sale 1đ tiktok shop")}`;

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
  if (!Array.isArray(list) || list.length === 0) {
    return blocked("TikTok Shop chưa trả deal nào cho máy chủ này.");
  }
  const deals = [];
  for (const raw of list) {
    const itemId = raw.id || raw.product_id || raw.productId;
    const name = String(raw.title || raw.name || "").trim();
    if (!itemId || !name) continue;
    const priceVnd = numberPrice(raw.price ?? raw.priceVnd ?? raw.sale_price);
    const wasVnd = numberPrice(raw.originalPrice ?? raw.original_price ?? raw.wasVnd);
    const discount = Math.max(
      0,
      Math.min(99, Math.round(Number(raw.discount) || (wasVnd > priceVnd ? (1 - priceVnd / wasVnd) * 100 : 0))),
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
      image: typeof raw.image === "string" ? raw.image : "",
      url: httpsUrl(raw.url) || `https://shop.tiktok.com/vn/pdp/${itemId}`,
      rating: 0,
      soldCount: Number(raw.sold) || 0,
      official: false,
      sessionId: null,
      sessionLabel: "TikTok Shop",
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

function httpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol === "https:") return parsed.href;
  } catch {
    return "";
  }
  return "";
}

function numberPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function loadTikTok() {
  try {
    const response = await fetch("https://shop-vn.tiktok.com/api/shop/home/product_list?region=VN", {
      headers: {
        Accept: "application/json",
        "Accept-Language": "vi-VN,vi;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (/captcha|Security Check/i.test(text)) {
      return blocked("TikTok Shop đang chặn máy chủ bằng captcha, chưa đọc được deal 1đ.");
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return blocked("TikTok Shop không trả JSON sản phẩm.");
    }
    return parseTikTokPayload(body);
  } catch {
    return blocked("Không kết nối được TikTok Shop lúc này.");
  }
}

export const TIKTOK_SEARCH_URL = SEARCH_URL;
