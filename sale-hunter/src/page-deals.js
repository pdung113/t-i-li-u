export function dealsFromRouter(data) {
  const products = [];
  collect(data, products, 0);
  const deals = [];
  for (const raw of products) {
    const deal = toDeal(raw);
    if (deal) deals.push(deal);
  }
  return deals;
}

export function hunterReturnUrl(origin, deals) {
  const packed = (deals || []).slice(0, 40).map((deal) => [
    String(deal.name || "").slice(0, 80),
    deal.priceVnd,
    deal.wasVnd,
    deal.discount,
    deal.url,
  ]);
  const bytes = new TextEncoder().encode(JSON.stringify(packed));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${String(origin || "").replace(/\/$/, "")}/#tiktok=${token}`;
}

export function tierOfPrice(deal) {
  if (deal.priceVnd > 0 && deal.priceVnd <= 1200) return "≤1.200đ";
  if (deal.discount >= 90) return "Từ 90%";
  if (deal.discount >= 70) return "Từ 70%";
  if (deal.discount >= 50) return "Giảm sâu";
  return "Sâu nhất";
}

export function dealFromCardText(text, url) {
  const raw = String(text || "");
  const discountMatch = raw.match(/-(\d{1,2})\s*%/);
  const priceMatch = raw.match(/(\d{1,3}(?:\.\d{3})+|\d+)\s*đ/i);
  if (!priceMatch) return null;
  const priceVnd = vndAmount(priceMatch[1], "VND");
  if (priceVnd <= 0) return null;
  const discount = discountMatch ? Math.min(99, Number(discountMatch[1])) : 0;
  const wasVnd = discount > 0 && discount < 100 ? Math.round(priceVnd / (1 - discount / 100)) : 0;
  const name = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 8 && !/^\d|^-\d|đ$|free shipping|đã bán|xem thêm/i.test(line));
  if (!name) return null;
  const itemId = String(url || "").match(/(\d+)(?!.*\d)/)?.[1] || "";
  const href = vietnamUrl(url, itemId);
  if (!href) return null;
  return {
    name: name.slice(0, 180),
    priceVnd,
    wasVnd: wasVnd > priceVnd ? wasVnd : 0,
    discount,
    url: href,
    saveVnd: wasVnd > priceVnd ? wasVnd - priceVnd : 0,
  };
}

export function dealsFromCardTexts(cards) {
  const deals = [];
  const seen = new Set();
  for (const card of cards || []) {
    const deal = dealFromCardText(card?.text, card?.url);
    if (!deal || seen.has(deal.url)) continue;
    seen.add(deal.url);
    deals.push(deal);
  }
  return deals;
}

function collect(node, found, depth) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    if (node.some(isProduct)) found.push(...node.filter(isProduct));
    else for (const item of node) collect(item, found, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) collect(value, found, depth + 1);
  }
}

function isProduct(item) {
  return Boolean(item && typeof item === "object" && (item.product_id || item.productId || item.id) && (item.title || item.name || item.product_price_info));
}

function toDeal(raw) {
  const info = raw.product_price_info || {};
  const currency = currencyCode(info, raw);
  const itemId = raw.id || raw.product_id || raw.productId;
  const name = String(raw.title || raw.name || "").trim();
  if (!itemId || !name || currency !== "VND") return null;
  const priceVnd = vndAmount(info.sale_price_decimal ?? info.sale_price_format ?? raw.price, currency);
  const wasVnd = vndAmount(info.raw_origin_price_decimal ?? info.raw_origin_price_format ?? raw.originalPrice, currency);
  const labeled = Number(String(info.discount_format || raw.discount || "").replace(/[^\d.]/g, ""));
  const discount = Math.max(0, Math.min(99, Math.round(labeled || (wasVnd > priceVnd && priceVnd > 0 ? (1 - priceVnd / wasVnd) * 100 : 0))));
  const url = vietnamUrl(raw.url || raw.seo_url?.canonical_url, itemId);
  if (!url) return null;
  return { name, priceVnd, wasVnd: wasVnd > priceVnd ? wasVnd : 0, discount, url, saveVnd: wasVnd > priceVnd ? wasVnd - priceVnd : 0 };
}

function currencyCode(info, raw) {
  const code = String(info.currency_name || info.currency || raw.currency || info.currency_symbol || "VND").trim().toUpperCase();
  if (code === "VND" || code === "VNĐ" || code === "₫" || code === "Đ") return "VND";
  return code;
}

function vndAmount(value, currency) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (currency === "VND") {
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
    if (/^\d+([.,]\d{1,2})?$/.test(text)) return Math.round(Number(text.replace(",", ".")));
  }
  const cleaned = text.replace(/[^\d,.]/g, "");
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) return Number(cleaned.replace(/\./g, ""));
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function vietnamUrl(value, itemId) {
  const fallback = `https://shop.tiktok.com/vn/pdp/${itemId}`;
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || parsed.hostname !== "shop.tiktok.com") return fallback;
    if (!parsed.pathname.startsWith("/vn/")) return "";
    return parsed.href;
  } catch {
    return fallback;
  }
}

export function startPhoneScan(origin) {
  const host = location.hostname;
  const onVietnamShop = host === "shop.tiktok.com" && location.pathname.startsWith("/vn/");
  const node = document.getElementById("__MODERN_ROUTER_DATA__");
  let deals = [];
  if (onVietnamShop && node) {
    try {
      deals = dealsFromRouter(JSON.parse(node.textContent));
    } catch {
      deals = [];
    }
  }
  if (onVietnamShop && !deals.length) {
    deals = dealsFromCardTexts(readVisibleCards(document));
  }
  if (onVietnamShop && deals.length && origin) {
    location.assign(hunterReturnUrl(origin, deals));
    return;
  }
  renderPanel(onVietnamShop, deals);
}

function readVisibleCards(doc) {
  return [...doc.querySelectorAll('a[href*="/vn/"]')]
    .map((anchor) => ({ text: anchor.innerText || "", url: anchor.href }))
    .filter((card) => /đ/i.test(card.text) && /\/vn\/(pdp|view)/.test(card.url));
}

function renderPanel(onVietnamShop, deals) {
  document.getElementById("sale-phone-panel")?.remove();
  const panel = document.createElement("section");
  panel.id = "sale-phone-panel";
  panel.style.cssText = "position:fixed;inset:auto 8px 8px 8px;max-height:70vh;overflow:auto;z-index:2147483646;background:#1c140f;color:#fff8ee;border-radius:16px;padding:12px;font:14px/1.4 sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45)";
  const title = document.createElement("strong");
  title.textContent = "Săn giảm giá";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Đóng";
  close.style.cssText = "float:right;background:#ffb703;color:#2a1d05;border:0;border-radius:999px;padding:6px 10px;font-weight:700";
  close.onclick = () => panel.remove();
  panel.append(title, close);
  const note = document.createElement("p");
  if (!onVietnamShop) {
    note.textContent = "Mở TikTok Shop Việt Nam trên điện thoại, tìm hàng 1 đ, rồi bấm lại dấu trang Săn giảm giá.";
    panel.append(note);
    const open = document.createElement("a");
    open.href = "https://shop.tiktok.com/vn/s?q=h%C3%A0ng%201%20%C4%91";
    open.textContent = "Mở TikTok Shop";
    open.style.cssText = "display:inline-block;margin-top:8px;background:#ff5a36;color:white;padding:10px 12px;border-radius:10px;font-weight:700;text-decoration:none";
    panel.append(open);
  } else if (!deals.length) {
    note.textContent = "Trang TikTok này chưa có sản phẩm để đọc. Tìm hàng 1 đ rồi bấm lại dấu trang.";
    panel.append(note);
  } else {
    note.textContent = `${deals.length} món trên trang này.`;
    panel.append(note);
    const order = ["≤1.200đ", "Từ 90%", "Từ 70%", "Giảm sâu", "Sâu nhất"];
    const ranked = [...deals].sort((a, b) => b.saveVnd - a.saveVnd || b.discount - a.discount);
    for (const label of order) {
      const group = ranked.filter((deal) => tierOfPrice(deal) === label).slice(0, label === "Sâu nhất" ? 8 : 20);
      if (!group.length) continue;
      const heading = document.createElement("h3");
      heading.textContent = `${label} · ${group.length}`;
      heading.style.margin = "10px 0 6px";
      panel.append(heading);
      for (const deal of group) panel.append(row(deal));
    }
  }
  document.documentElement.append(panel);
}

function row(deal) {
  const line = document.createElement("a");
  line.href = deal.url;
  line.style.cssText = "display:block;margin:6px 0;padding:8px;border-radius:10px;background:#2a211c;color:inherit;text-decoration:none";
  const price = new Intl.NumberFormat("vi-VN").format(deal.priceVnd) + "đ";
  line.textContent = `${deal.discount ? "-" + deal.discount + "% " : ""}${price} · ${deal.name}`;
  return line;
}
