import { isDeepSale, isHuntDeal, shelfDeals } from "./deals.js";
import { formatVnd, isOneDong } from "./money.js";

const SEARCH_URL = "https://shop.tiktok.com/vn/s?q=h%C3%A0ng%201%20%C4%91";
const WORDS = ["hàng 1 đ", "1.000đ", "1k", "giảm 70%", "flash sale"];
const CLUSTERS = ["sg1", "my", "alisg"];
let cluster = CLUSTERS[0];

function blocked(message) {
  return {
    ok: false,
    deals: [],
    message,
    openUrl: SEARCH_URL,
  };
}

export function productList(body) {
  const lists = [];
  const push = (value) => {
    if (Array.isArray(value)) lists.push(...value);
  };
  push(body?.products);
  push(body?.data?.products);
  push(body?.data?.product_list);
  push(body?.data?.productList);
  const components = body?.data?.components || body?.components;
  if (components && typeof components === "object") {
    for (const value of Object.values(components)) {
      push(value?.products);
      push(value?.product_list);
      push(value?.productList);
      push(value?.data?.products);
      push(value?.data?.product_list);
    }
  }
  return lists;
}

export function asTikTokProduct(raw) {
  if (!raw || typeof raw !== "object") return null;
  const packed = raw.packed_product || raw.packedProduct;
  const source = packed && typeof packed === "object" ? packed : raw;
  const base = source.product_base || source.productBase || {};
  const price = base.price && typeof base.price === "object" ? base.price : {};
  const promo = source.promotion_info?.product_price?.min_price || source.promotionInfo?.productPrice?.minPrice;
  const sku = Array.isArray(source.skus) ? source.skus.find((row) => row && (row.price || row.sku_price)) : null;
  const skuPrice = sku?.price || sku?.sku_price || {};
  const info = { ...(source.product_price_info || {}) };
  if (promo && typeof promo === "object") Object.assign(info, promo);
  const saleText = moneyText(
    price.real_price_decimal ?? price.realPriceDecimal ?? price.real_price ?? price.realPrice
      ?? skuPrice.real_price_decimal ?? skuPrice.real_price ?? skuPrice.sale_price ?? promo,
  );
  const originText = moneyText(
    price.original_price_decimal ?? price.originalPriceDecimal ?? price.original_price ?? price.originalPrice
      ?? skuPrice.original_price_decimal ?? skuPrice.original_price ?? skuPrice.origin_price,
  );
  if ((info.sale_price_decimal == null || info.sale_price_decimal === "") && saleText) {
    info.sale_price_decimal = saleText;
    info.currency_name = info.currency_name || price.currency || price.currency_name || skuPrice.currency || skuPrice.currency_name;
    info.currency_symbol = info.currency_symbol || price.currency_symbol || price.currencySymbol || skuPrice.currency_symbol;
    if (originText) info.raw_origin_price_decimal = originText;
  }
  if (!info.discount_format && (price.discount || price.discount_format)) info.discount_format = price.discount || price.discount_format;
  const itemId = source.product_id || source.productId || source.id;
  return {
    ...source,
    id: itemId,
    product_id: itemId,
    title: source.title || source.name || base.title || "",
    image: source.image || base.images?.[0],
    images: source.images || base.images,
    product_price_info: info,
    seo_url: source.seo_url || (itemId ? { canonical_url: `https://shop.tiktok.com/vn/pdp/${itemId}` } : undefined),
  };
}

export function parseTikTokPayload(body) {
  if (!body || typeof body !== "object") return blocked("TikTok không trả danh sách sản phẩm.");
  if (body.code === 10000 || body.error === 10000) {
    return blocked("TikTok Shop đang chặn máy chủ bằng captcha, chưa đọc được deal từ 1.200đ trở xuống.");
  }
  const list = productList(body);
  if (!Array.isArray(list)) return blocked("TikTok Shop chưa trả deal nào cho máy chủ này.");
  const deals = [];
  for (const item of list) {
    const raw = asTikTokProduct(item);
    if (!raw) continue;
    const itemId = raw.id || raw.product_id || raw.productId;
    const name = String(raw.title || raw.name || "").trim();
    const info = raw.product_price_info || {};
    const currency = currencyCode(info, raw);
    if (!itemId || !name || currency !== "VND") continue;
    const priceVnd = firstAmount(
      [
        info.sale_price_decimal,
        info.sale_price_format,
        info.sale_price,
        info.sale_price_value,
        info.min_price,
        raw.price,
        raw.priceVnd,
        raw.sale_price,
        digSale(raw),
      ],
      currency,
    );
    const wasVnd = firstAmount(
      [
        info.raw_origin_price_decimal,
        info.raw_origin_price_format,
        info.origin_price_decimal,
        info.origin_price_format,
        info.original_price,
        info.original_price_value,
        raw.originalPrice,
        raw.original_price,
        raw.wasVnd,
        digMarked(raw, /origin|original|was/i),
      ],
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

function moneyText(value, depth = 0) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const text = value.trim();
    return text && text !== "[object Object]" ? text : "";
  }
  if (typeof value !== "object" || depth > 3) return "";
  const keys = [
    "price_str",
    "price_val",
    "sale_price_decimal",
    "sale_price_format",
    "sale_price",
    "sale_price_value",
    "real_price_decimal",
    "real_price",
    "min_price",
    "price",
  ];
  for (const key of keys) {
    if (value[key] == null || value[key] === "") continue;
    const found = moneyText(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function digMarked(node, pattern, depth = 0, skip = null) {
  if (!node || typeof node !== "object" || depth > 5) return "";
  const entries = Object.entries(node);
  for (const [key, nested] of entries) {
    if (skip?.test(key) || !pattern.test(key) || /id|sold|stock|score|count|offset|token/i.test(key)) continue;
    const text = moneyText(nested);
    if (text) return text;
  }
  for (const [key, value] of entries) {
    if (skip?.test(key) || !value || typeof value !== "object") continue;
    const found = digMarked(value, pattern, depth + 1, skip);
    if (found) return found;
  }
  return "";
}

function digSale(node) {
  return digMarked(node, /sale|real_price|min_price|price_str|price_val/i, 0, /origin|original|was/i);
}

function firstAmount(values, currency) {
  for (const value of values) {
    const amount = vndAmount(moneyText(value), currency);
    if (amount > 0) return amount;
  }
  return 0;
}

function vndAmount(value, currency = "VND") {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (!text || text === "[object Object]") return 0;
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

export function shopFromRouter(data) {
  const info = data?.loaderData?.["(region)/(route_page_name)/page"]?.region_info || {};
  return String(info.real_region || info.path_region || "");
}

export function regionFromText(text) {
  return String(text || "").match(/"current_v_region":"([^"]+)"/)?.[1] || "";
}

export function catalogMessage({ region = "", shop = "", scanned = 0, deals = 0, deepest = 0 } = {}) {
  if (deals > 0) return `TikTok Shop Việt Nam · ${deals} deal`;
  if (scanned > 0) {
    const depth = deepest ? ` Sâu nhất đã thấy -${deepest}%.` : "";
    return `TikTok Shop Việt Nam · đã xem ${scanned} món, chưa có món từ 1.200đ trở xuống, -90%, -70% hay giảm sâu từ 50%.${depth}`;
  }
  return "TikTok Shop Việt Nam. Lượt này trả 0 món. Bảng vẫn quét mỗi 15 giây.";
}

export async function loadTikTok() {
  const seen = new Set();
  const found = [];
  let scanned = 0;
  let deepest = 0;
  let region = "";
  let shop = "";
  let received = 0;
  let pageStatus = 0;
  let apiStatus = 0;
  try {
    for (const word of WORDS) {
      const body = await searchVietnam(word);
      region = region || body.region || "";
      shop = shop || body.shop || "";
      pageStatus = pageStatus || body.pageStatus || 0;
      apiStatus = apiStatus || body.apiStatus || 0;
      received += body.products?.length || 0;
      const parsed = parseTikTokPayload(body);
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
    return { ...blocked("Không kết nối được TikTok Shop Việt Nam lúc này."), scanned, deepest, region, shop, received, pageStatus, apiStatus, shelf: [] };
  }
  const deals = found.filter((deal) => isHuntDeal(deal) || isDeepSale(deal));
  const pricedShelf = shelfDeals(found);
  const placed = new Set([...deals, ...pricedShelf].map((deal) => deal.id));
  const rest = found.filter((deal) => !deal.soldOut && deal.name && !placed.has(deal.id));
  const shelf = [...pricedShelf, ...rest].slice(0, 16);
  return {
    ok: true,
    deals,
    shelf,
    scanned,
    deepest,
    region,
    shop,
    received,
    pageStatus,
    apiStatus,
    message: catalogMessage({ region, shop, scanned, deals: deals.length + shelf.length, deepest }),
    openUrl: SEARCH_URL,
  };
}

async function searchVietnam(word) {
  const [page, posted] = await Promise.all([
    readSearchPage(word).catch(() => ({ products: [], region: "", status: 0 })),
    postProductList(word).catch(() => ({ products: [], status: 0 })),
  ]);
  const postedList = productList(posted);
  if (posted?.code === 10000 && page.products.length === 0) {
    return { products: [], region: page.region || "", shop: page.shop || "", pageStatus: page.status || 0, apiStatus: posted.status || 0, code: 10000 };
  }
  return {
    products: [...page.products, ...postedList],
    region: page.region || "",
    shop: page.shop || "",
    pageStatus: page.status || 0,
    apiStatus: posted.status || 0,
    code: posted.code,
  };
}

async function readSearchPage(word) {
  const response = await fetchShop(`https://shop.tiktok.com/vn/s?q=${encodeURIComponent(word)}`, {
    headers: shopHeaders(word),
  });
  if (!response) return { products: [], region: "", shop: "", status: 0 };
  const text = await response.text();
  const match = text.match(/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) return { products: [], region: regionFromText(text), shop: "", status: response.status };
  let data = {};
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { products: [], region: regionFromText(text), shop: "", status: response.status };
  }
  return {
    products: collectProducts(data),
    region: regionFromRouter(data) || regionFromText(text),
    shop: shopFromRouter(data),
    status: response.status,
  };
}

async function fetchShop(url, options) {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, { ...options, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    if (response.status < 300 || response.status >= 400) return response;
    const next = response.headers.get("location");
    if (!next) return response;
    const resolved = new URL(next, current);
    if (resolved.hostname !== "shop.tiktok.com") return response;
    current = resolved.href;
  }
  return null;
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
  const raw = asTikTokProduct(item);
  if (!raw) return false;
  return Boolean(raw.product_id && (raw.title || raw.product_price_info?.sale_price_decimal));
}

function shopHeaders(word, idc = cluster) {
  return {
    Accept: "text/html,application/json",
    "Accept-Language": "vi-VN,vi;q=0.9",
    Cookie: `store-country-code=vn; store-country-src=uid; tt-target-idc=${idc}`,
    "x-tt-store-region": "vn",
    Origin: "https://shop.tiktok.com",
    Referer: `https://shop.tiktok.com/vn/s?q=${encodeURIComponent(word)}`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
}

async function postProductList(word) {
  const order = [cluster, ...CLUSTERS.filter((idc) => idc !== cluster)];
  let last = { products: [], status: 0, code: 0 };
  for (const idc of order) {
    const result = await postProductListOn(word, idc);
    last = result;
    if (result.products.length) {
      cluster = idc;
      return result;
    }
  }
  return last;
}

async function postProductListOn(word, idc) {
  const products = [];
  let offset = 0;
  let pageToken = "";
  let status = 0;
  for (let page = 0; page < 3; page += 1) {
    const response = await fetch("https://shop.tiktok.com/api/shop/brandy_desktop/s/product_list?region=VN&locale=vi-VN", {
      method: "POST",
      headers: { ...shopHeaders(word, idc), Accept: "application/json", "Content-Type": "application/json" },
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
    status = response.status;
    const text = await response.text();
    if (/captcha|Security Check/i.test(text)) return { code: 10000, products, status };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { products, status };
    }
    const list = productList(body);
    if (list.length) products.push(...list);
    const more = body.data?.load_more_params || {};
    if (!body.data?.has_more || list.length === 0) break;
    offset = Number(more.offset ?? offset + list.length);
    pageToken = more.page_token || "";
  }
  return { products, status };
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

export function keepTikTokCatalog(previous, next, now = Date.now()) {
  const has = (value) => (value?.scanned || 0) > 0 || (value?.deals || []).length > 0 || (value?.shelf || []).length > 0;
  if (has(next)) return next;
  if (has(previous) && now - (previous.checkedAt || 0) < 10 * 60 * 1000) return previous;
  return next;
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
