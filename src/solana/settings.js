/**
 * Chỉnh tại file này.
 * Số SOL mua, trượt giá, và tip không đọc từ biến môi trường.
 */

/** Số SOL dùng để mua mỗi token ví mục tiêu vừa mua. */
export const BUY_SOL = "0.05";

/**
 * Trần trượt giá, basis point. 1500 = 15%.
 * Lệnh đứng sau một lệnh mua khác thường cần trần này, nếu không swap bị revert.
 */
export const SLIPPAGE_BPS = 1500;

/** Trần compute unit của lệnh mua. Tăng nếu Jupiter báo vượt compute. */
export const CU_LIMIT = 600_000;

/** Mức priority fee Jupiter gắn vào lệnh. veryHigh giúp vào block sớm hơn. */
export const COMPUTE_UNIT_PRICE_PERCENTILE = "veryHigh";

/**
 * Tip Jito, lamports. 1_000_000 = 0.001 SOL.
 * Tip này nằm trong cùng lệnh mua và chỉ bị trừ khi lệnh thành công.
 */
export const JITO_TIP_LAMPORTS = 1_000_000;

/**
 * Bỏ qua nếu mức đội giá của chính lệnh mình vượt ngưỡng này.
 * 25 = 25%. Đây là impact của số SOL mình mua, không phải của ví kia.
 */
export const MAX_PRICE_IMPACT_PERCENT = 25;

/**
 * Ví mục tiêu phải tiêu ít nhất ngần này SOL (ngoài phí mạng) thì mới coi là lệnh mua.
 * Mức này né giao dịch chỉ trả phí thuê tài khoản token.
 */
export const MIN_SOL_SPENT = "0.005";

/** true = mỗi mint chỉ mua một lần trong phiên. */
export const COPY_ONCE_PER_MINT = true;

/** Trần số lệnh mua thành công mỗi lần chạy. */
export const MAX_BUYS = 10;

/** true = chỉ in lệnh, không gửi. DRY_RUN trong .env ghi đè dòng này. */
export const DRY_RUN = true;
