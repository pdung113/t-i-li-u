import {
  MIN_KRW_ORDER,
  UPBIT_KRW_FEE,
  decimalsOf,
  formatDecimal,
  limitPrice,
  limitVolume,
  tickSize,
} from "./price.js";

const FATAL = new Set([
  "insufficient_funds_bid",
  "insufficient_funds",
  "under_min_total_bid",
  "under_min_total_market_bid",
  "invalid_access_key",
  "invalid_secret_key",
  "jwt_verification",
  "expired_jwt",
  "nonce_used",
  "no_authorization_ip",
  "out_of_scope",
  "no_authorization",
]);

const HINTS = {
  insufficient_funds_bid: "Không đủ KRW trong tài khoản Upbit.",
  under_min_total_bid: "Dưới số tiền tối thiểu, thường 5.000 KRW.",
  under_min_total_market_bid: "Dưới số tiền tối thiểu, thường 5.000 KRW.",
  invalid_price_bid: "Giá không đúng bước giá của Upbit.",
  invalid_volume_bid: "Số lượng không đúng đơn vị của Upbit.",
  invalid_access_key: "Access Key không đúng.",
  jwt_verification: "Secret Key không khớp Access Key.",
  no_authorization_ip: "IP máy này chưa được thêm vào API key.",
  out_of_scope: "API key chưa bật quyền đặt lệnh.",
};

export function explainError(name, message) {
  const hint = HINTS[name];
  const detail = [name, message].filter(Boolean).join(": ");
  return hint ? `${hint} (${detail})` : detail || "Upbit từ chối lệnh.";
}

export function judgeResponse(status, body) {
  if (status >= 200 && status < 300 && body?.uuid) return { ok: true, order: body };
  const name = body?.error?.name || "";
  const message = body?.error?.message || "";
  if (/identifier/i.test(name) || /identifier/i.test(message)) {
    return { duplicateIdentifier: true, name, message };
  }
  if (FATAL.has(name)) return { fatal: true, name, message };
  if (/invalid_price/.test(name)) return { correctable: "price", name, message };
  if (/invalid_volume/.test(name)) return { correctable: "volume", name, message };
  return { retry: true, name, message, status };
}

export function usesLimit(listing, atMs) {
  if (!(listing.limitOnlyMs > 0)) return false;
  if (listing.openAt == null) return true;
  return atMs < listing.openAt + listing.limitOnlyMs;
}

export function buildOrder(listing, { budgetKrw, multiple, fee = UPBIT_KRW_FEE, atMs, volumeDecimals = 8 }) {
  const identifier = listing.identifier;
  const limit = usesLimit(listing, atMs);
  if (!limit) {
    const total = Math.floor(Number(budgetKrw));
    if (total < MIN_KRW_ORDER) return { error: `Số KRW phải từ ${MIN_KRW_ORDER}.` };
    return {
      params: {
        market: listing.market,
        side: "bid",
        price: String(total),
        ord_type: "price",
        identifier,
      },
      kind: "market",
      fee,
    };
  }
  if (!(listing.refPrice > 0)) return { error: "Chưa có giá tham chiếu để đặt lệnh giới hạn." };
  const price = limitPrice(listing.refPrice, multiple);
  const volume = limitVolume(budgetKrw, price, fee);
  const decimals = Math.min(8, volumeDecimals);
  const volumeText = formatDecimal(volume, decimals);
  const priceText = formatDecimal(price, decimalsOf(tickSize(price)));
  if (!(Number(volumeText) > 0) || Number(priceText) * Number(volumeText) < MIN_KRW_ORDER) {
    return { error: `Lệnh dưới ${MIN_KRW_ORDER} KRW.` };
  }
  return {
    params: {
      market: listing.market,
      side: "bid",
      volume: volumeText,
      price: priceText,
      ord_type: "limit",
      identifier,
    },
    kind: "limit",
    fee,
    limitPrice: Number(priceText),
  };
}

export function correctOrder(params, problem) {
  if (problem === "volume") {
    const next = Math.floor(Number(params.volume) * 10000) / 10000;
    return { ...params, volume: formatDecimal(next, 4) };
  }
  if (problem === "price") {
    const tick = tickSize(Number(params.price));
    const raised = Number(params.price) + tick;
    return { ...params, price: formatDecimal(raised, decimalsOf(tickSize(raised))) };
  }
  return params;
}
