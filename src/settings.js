/**
 * Chỉnh tại file này.
 * Ngưỡng tax, gas, và số lượng mua không đọc từ biến môi trường.
 */

/** Chain: "bsc" | "eth" | "base". RPC/CHAIN trong .env vẫn ghi đè chain này. */
export const CHAIN = "bsc";

/** Số native (BNB trên BSC, ETH trên Ethereum/Base) cho mỗi lệnh mua. */
export const BUY_AMOUNT = "0.05";

/**
 * Không mua nếu buy tax HOẶC sell tax cao hơn mức này.
 * 10 = 10%. Đặt 0 nếu chỉ mua token không tax.
 */
export const MAX_TAX_PERCENT = 10;

/** Gas price (gwei) của lệnh mua. Tăng khi mạng tắc để vào block sớm hơn. */
export const GAS_GWEI = "3";

/** Trần gas limit. Token tax nặng mà bị out-of-gas thì tăng, ví dụ 1_500_000. */
export const GAS_LIMIT = 1_200_000;

/**
 * Trần trượt giá thêm, tính trên số token mô phỏng nhận được.
 * Lệnh thật dùng amountOutMin = token mô phỏng * (1 - slippage).
 */
export const SLIPPAGE_PERCENT = 15;

/**
 * Khối lượng mô phỏng để đo tax, tránh tính nhầm price impact thành tax.
 * Nếu token có min-buy cao hơn mức này, đặt bằng BUY_AMOUNT.
 */
export const PROBE_AMOUNT = "0.002";

/** Khoảng nghỉ giữa hai lần hỏi timeline X, ms. 0 = hỏi lại ngay khi request trước xong. */
export const POLL_MS = 0;

/**
 * Tweet đã đăng trong khoảng này (giây) vẫn được mua khi vừa dán link.
 * Tweet cũ hơn thì chỉ chờ contract mới.
 */
export const LOOKBACK_SEC = 180;

/** Chờ pool V2 / mở trade tối đa bao lâu sau khi thấy contract, ms. */
export const WAIT_FOR_PAIR_MS = 120_000;

/** Nghỉ giữa các lần thử lại khi chưa có thanh khoản, ms. */
export const RETRY_MS = 400;

/** true = chỉ in lệnh, không gửi tx. Đổi thành false khi muốn mua thật. */
export const DRY_RUN = true;
