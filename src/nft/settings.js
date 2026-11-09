/**
 * Chỉnh gas và số lượng tại đây, hoặc ghi đè lúc chạy:
 * npm run nft -- mint <link> --qty 2 --gas 20 --max-price 0.05
 */

/** Số NFT mỗi lệnh mint, và số listing rẻ nhất khi mua. */
export const MINT_QUANTITY = 1;

/** Trần giá mỗi NFT lúc mint, tính bằng coin native của chain. */
export const MAX_MINT_PRICE = "0.2";

/** Trần giá mỗi NFT lúc mua listing. */
export const MAX_BUY_PRICE = "0.5";

/** Gas price (gwei). Chain EIP-1559 dùng mức này cho cả max fee và priority fee. */
export const GAS_GWEI = "5";

/** Trần gas limit của lệnh mint hoặc mua. */
export const GAS_LIMIT = 500_000;

/** true = in lệnh và giờ mở round, không gửi giao dịch. */
export const DRY_RUN = true;
