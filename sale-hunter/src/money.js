const MICRO = 100_000;

export function vndFromMicro(micro) {
  const n = Number(micro);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / MICRO;
}

export function discountPercent(priceMicro, beforeMicro, raw) {
  const price = Number(priceMicro);
  const before = Number(beforeMicro);
  const fromRaw = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Math.round(Number(raw)) : 0;
  let fromPrice = 0;
  if (Number.isFinite(price) && Number.isFinite(before) && before > price && price > 0) {
    fromPrice = Math.round((1 - price / before) * 100);
  }
  const percent = Math.max(fromRaw, fromPrice);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(99, percent);
}

export function formatVnd(value) {
  const v = Math.round(Number(value) || 0);
  const body = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${v < 0 ? "-" : ""}${body}đ`;
}

export function formatCompact(value) {
  const n = Math.round(Number(value) || 0);
  if (n >= 1_000_000) {
    const x = n / 1_000_000;
    return `${trim1(x)}tr`;
  }
  if (n >= 1000) return `${trim1(n / 1000)}k`;
  return String(n);
}

function trim1(n) {
  return n.toFixed(1).replace(".0", "");
}

export function shopeeUrl(shopId, itemId, name) {
  const slug = slugify(name) || "san-sale";
  return `https://shopee.vn/${slug}-i.${shopId}.${itemId}`;
}

export function slugify(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function imageUrl(image) {
  const raw = String(image || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://down-vn.img.susercontent.com/file/${raw}`;
}

export function isOneDong(priceVnd) {
  return priceVnd > 0 && priceVnd <= 1;
}

export function isDeepDiscount(discount) {
  return discount >= 90;
}
