import { isDeepSale, isHuntDeal, shelfDeals } from "./deals.js";
import { formatVnd, isOneDong } from "./money.js";

const SEARCH_URL = "https://shop.tiktok.com/vn/s?q=h%C3%A0ng%201%20%C4%91";
const WORDS = ["hàng 1 đ", "1.000đ", "1k", "giảm 70%", "flash sale"];

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
    return blocked("TikTok Shop đang chặn máy chủ bằng captcha, chưa đọc được deal từ 1.200đ trở xuống.");
  }
  const list = body.products || body.data?.products || body.data?.product_list || [];
  if (!Array.isArray(list)) return blocked("TikTok Shop chưa trả deal nào cho máy chủ này.");
  const deals = [];
  for (const raw of list) {
    const itemId = raw.id || raw.product_id || raw.productId;
    const name = String(raw.title || raw.name || "").trim();
    const info = raw.product_price_info || {};
    const currency = currencyCode(info, raw);
    if (!itemId || !name || currency !== "VND") continue;
    const priceVnd = vndAmount(info.sale_price_decimal ?? info.sale_price_format ?? info.sale_price ?? raw.price ?? raw.priceVnd ?? raw.sale_price, currency);
    const wasVnd = vndAmount(
      info.raw_origin_price_decimal ?? info.raw_origin_price_format ?? info.origin_price_decimal ?? info.original_price ?? raw.originalPrice ?? raw.original_price ?? raw.wasVnd,
      currency,
    );
    const labeled = Number(String(info.discount_format || raw.discount || "").replace(/[^\d.]/g, ""));
    const discount = Math.max(
      0,
      Math.min(99, Math.round(labeled || (wasVnd > priceVnd && priceVnd > 0 ? (1 - priceVnd / wasVnd) * 100 : 0))),
    );
    const oneDong = isOneDong(priceVnd);
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
      rating: Number(raw.rate_info?.score) || 0,
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

function currencyCode(info, raw) {
  const rawCode = String(info.currency_name || info.currency || raw.currency || info.currency_symbol || "VND").trim().toUpperCase();
  if (rawCode === "VND" || rawCode === "VNĐ" || rawCode === "₫" || rawCode === "Đ") return "VND";
  return rawCode;
}

function vndAmount(value, currency = "VND") {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (!text) return 0;
  if (currency === "VND" || currency === "₫") {
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
    if (/^\d+([.,]\d{1,2})?$/.test(text)) return Math.round(Number(text.replace(",", ".")));
  }
  return numberPrice(text);
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

export function regionFromRouter(data) {
  const page = data?.loaderData?.["(region)/(route_page_name)/page"];
  return String(page?.region_info?.current_v_region || "");
}

export function catalogMessage({ region = "", scanned = 0, deals = 0, deepest = 0 } = {}) {
  if (deals > 0) return `TikTok Shop Việt Nam · ${deals} deal`;
  if (scanned > 0) {
    const depth = deepest ? ` Sâu nhất đã thấy -${deepest}%.` : "";
    return `TikTok Shop Việt Nam · đã xem ${scanned} món, chưa có món từ 1.200đ trở xuống, -90%, -70% hay giảm sâu từ 50%.${depth}`;
  }
  if (!region || /US|TTP/i.test(region)) {
    const where = region ? ` Máy này đang bị gắn vùng ${region}.` : "";
    return `TikTok chỉ gửi giá 1đ, 1k và deal giảm sâu cho máy đang ở Việt Nam.${where} Trên máy đó chạy npm run sale rồi mở http://127.0.0.1:8787.`;
  }
  return "TikTok không gửi sản phẩm cho máy này. Chạy lại npm run sale trên máy Việt Nam.";
}

export async function loadTikTok() {
  const seen = new Set();
  const found = [];
  let scanned = 0;
  let deepest = 0;
  let region = "";
  try {
    for (const word of WORDS) {
      const body = await searchVietnam(word);
      region = region || body.region || "";
      const parsed = parseTikTokPayload(body);
      if (!parsed.ok && body?.code === 10000 && found.length === 0 && word === WORDS[0]) {
        return { ...parsed, scanned, deepest, region, shelf: [] };
      }
      if (!scanned && found.length === 0 && /US|TTP/i.test(region) && (body.products || []).length === 0) {
        break;
      }
      if (!parsed.ok) continue;
      for (const deal of parsed.deals) {
        if (seen.has(deal.id) || !deal.url.startsWith("https://shop.tiktok.com/vn/")) continue;
        seen.add(deal.id);
        scanned += 1;
        deepest = Math.max(deepest, deal.discount || 0);
        found.push(deal);
      }
    }
  } catch {
    return { ...blocked("Không kết nối được TikTok Shop Việt Nam lúc này."), scanned, deepest, region, shelf: [] };
  }
  const deals = found.filter((deal) => isHuntDeal(deal) || isDeepSale(deal));
  return {
    ok: true,
    deals,
    shelf: shelfDeals(found),
    scanned,
    deepest,
    region,
    message: catalogMessage({ region, scanned, deals: deals.length, deepest }),
    openUrl: SEARCH_URL,
  };
}

async function searchVietnam(word) {
  const [page, posted] = await Promise.all([
    readSearchPage(word).catch(() => ({ products: [], region: "" })),
    postProductList(word).catch(() => ({ products: [] })),
  ]);
  if (posted?.code === 10000 && page.products.length === 0) return { ...posted, region: page.region, products: [] };
  const postedList = posted?.products || posted?.data?.products || posted?.data?.product_list || [];
  return {
    products: [...page.products, ...(Array.isArray(postedList) ? postedList : [])],
    region: page.region || "",
  };
}

async function readSearchPage(word) {
  const response = await fetch(`https://shop.tiktok.com/vn/s?q=${encodeURIComponent(word)}`, {
    headers: shopHeaders(word),
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status >= 300 && response.status < 400) return { products: [], region: "" };
  const text = await response.text();
  const match = text.match(/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>(.*?)<\/script>/);
  if (!match) return { products: [], region: "" };
  const data = JSON.parse(match[1]);
  return { products: collectProducts(data), region: regionFromRouter(data) };
}

export function collectProducts(node, found = [], depth = 0) {
  if (!node || depth > 12) return found;
  if (Array.isArray(node)) {
    if (node.some(isProductRecord)) found.push(...node.filter(isProductRecord));
    else for (const item of node) collectProducts(item, found, depth + 1);
    return found;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) collectProducts(value, found, depth + 1);
  }
  return found;
}

function isProductRecord(item) {
  if (!item || typeof item !== "object") return false;
  const id = item.product_id || item.productId || item.id;
  return Boolean(id && (item.title || item.name || item.product_price_info));
}

function shopHeaders(word) {
  return {
    Accept: "text/html,application/json",
    "Accept-Language": "vi-VN,vi;q=0.9",
    Cookie: "store-country-code=vn",
    Origin: "https://shop.tiktok.com",
    Referer: `https://shop.tiktok.com/vn/s?q=${encodeURIComponent(word)}`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
}

async function postProductList(word) {
  const products = [];
  let offset = 0;
  let pageToken = "";
  for (let page = 0; page < 3; page += 1) {
    const response = await fetch("https://shop.tiktok.com/api/shop/brandy_desktop/s/product_list", {
      method: "POST",
      headers: { ...shopHeaders(word), Accept: "application/json", "Content-Type": "application/json" },
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
          offset,
          page_token: pageToken,
          search_word: word,
          exclude_product_ids: [],
        }),
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    if (/captcha|Security Check/i.test(text)) return { code: 10000, products };
    const body = JSON.parse(text);
    const list = body.data?.products || body.products || [];
    if (Array.isArray(list)) products.push(...list);
    const more = body.data?.load_more_params || {};
    if (!body.data?.has_more || !Array.isArray(list) || list.length === 0) break;
    offset = Number(more.offset ?? offset + list.length);
    pageToken = more.page_token || "";
  }
  return { products };
}

export function acceptPhoneDeals(raw) {
  const list = unpackPhone(raw);
  const found = [];
  const seen = new Set();
  for (const item of list.slice(0, 40)) {
    const deal = phoneDeal(item);
    if (!deal || seen.has(deal.id)) continue;
    seen.add(deal.id);
    found.push(deal);
  }
  const deals = found.filter((deal) => isHuntDeal(deal) || isDeepSale(deal));
  const deepest = found.reduce((max, deal) => Math.max(max, deal.discount || 0), 0);
  return {
    ok: found.length > 0,
    deals,
    shelf: shelfDeals(found),
    scanned: found.length,
    deepest,
    source: "phone",
    message: found.length
      ? `TikTok Shop Việt Nam · ${found.length} món từ trang trên điện thoại`
      : "Trang TikTok chưa gửi được món nào về bảng.",
    openUrl: SEARCH_URL,
  };
}

export function preferPhoneCatalog(serverResult, phoneResult, now = Date.now()) {
  const serverHas = (serverResult?.scanned || 0) > 0 || (serverResult?.deals || []).length > 0 || (serverResult?.shelf || []).length > 0;
  const fresh = phoneResult && now - (phoneResult.checkedAt || 0) < 30 * 60 * 1000 && (phoneResult.scanned || 0) > 0;
  if (serverHas || !fresh) return serverResult;
  return { ...phoneResult, ok: true };
}

function unpackPhone(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const pad = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function phoneDeal(item) {
  const row = Array.isArray(item)
    ? { name: item[0], priceVnd: item[1], wasVnd: item[2], discount: item[3], url: item[4] }
    : item;
  if (!row || typeof row !== "object") return null;
  const name = String(row.name || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const url = vietnamShopUrl(row.url);
  const itemId = String(url.match(/(\d+)(?!.*\d)/)?.[1] || "");
  const priceVnd = Math.round(Number(row.priceVnd) || 0);
  if (!name || !url || !itemId || priceVnd <= 0 || priceVnd > 500_000_000) return null;
  const wasVnd = Math.round(Number(row.wasVnd) || 0);
  const fromPrice = wasVnd > priceVnd ? Math.round((1 - priceVnd / wasVnd) * 100) : 0;
  const discount = Math.max(0, Math.min(99, Math.round(Number(row.discount) || fromPrice || 0)));
  return {
    id: `tiktok:${itemId}`,
    platform: "tiktok",
    shopId: "",
    itemId,
    name,
    priceVnd,
    wasVnd: wasVnd > priceVnd ? wasVnd : 0,
    saveVnd: wasVnd > priceVnd ? wasVnd - priceVnd : 0,
    discount,
    stock: 0,
    stockTotal: 0,
    sold: 0,
    soldOut: false,
    oneDong: isOneDong(priceVnd),
    deep: discount >= 90,
    image: "",
    url,
    rating: 0,
    soldCount: 0,
    official: false,
    sessionId: null,
    sessionLabel: "TikTok Shop Việt Nam",
    sessionEnd: 0,
    sessionOngoing: true,
    priceText: formatVnd(priceVnd),
    wasText: wasVnd > priceVnd ? formatVnd(wasVnd) : "",
    saveText: wasVnd > priceVnd ? formatVnd(wasVnd - priceVnd) : "",
  };
}

function vietnamShopUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || parsed.hostname !== "shop.tiktok.com" || !parsed.pathname.startsWith("/vn/")) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export const TIKTOK_SEARCH_URL = SEARCH_URL;
