/** @param {bigint | null} expected @param {bigint | null} actual */
export function taxBps(expected, actual) {
  if (expected == null || actual == null) return null;
  if (expected <= 0n) return null;
  if (actual >= expected) return 0;
  const bps = Number(((expected - actual) * 10000n) / expected);
  if (!Number.isFinite(bps)) return null;
  return Math.min(10000, bps);
}

export function formatTax(bps) {
  if (bps == null) return "?";
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * @param {{
 *   buyFailed: boolean,
 *   sellFailed: boolean,
 *   buyTaxBps: number | null,
 *   sellTaxBps: number | null,
 *   gotTokens: bigint,
 * }} sim
 * @param {number} maxTaxPercent
 */
export function decide(sim, maxTaxPercent) {
  const maxBps = Math.round(Number(maxTaxPercent) * 100);
  if (!Number.isFinite(maxBps) || maxBps < 0 || maxBps > 10000) {
    throw new Error("MAX_TAX_PERCENT phải từ 0 đến 100");
  }

  if (sim.buyFailed) {
    return { ok: false, terminal: false, reason: "chua_mua_duoc" };
  }
  if (sim.gotTokens === 0n) {
    return { ok: false, terminal: true, reason: "mua_khong_nhan_token" };
  }
  if (sim.buyTaxBps == null) {
    return { ok: false, terminal: true, reason: "khong_do_duoc_buy_tax" };
  }
  if (sim.buyTaxBps > maxBps) {
    return { ok: false, terminal: true, reason: "buy_tax_cao" };
  }
  if (sim.sellFailed) {
    return { ok: false, terminal: true, reason: "khong_ban_duoc" };
  }
  if (sim.sellTaxBps == null) {
    return { ok: false, terminal: true, reason: "khong_do_duoc_sell_tax" };
  }
  if (sim.sellTaxBps > maxBps) {
    return { ok: false, terminal: true, reason: "sell_tax_cao" };
  }
  return { ok: true, terminal: true, reason: "ok" };
}

export const REASON_TEXT = {
  chua_mua_duoc: "chưa mua được (chưa có pool, chưa mở trade, hoặc lệnh revert)",
  mua_khong_nhan_token: "mô phỏng mua xong nhưng ví nhận 0 token",
  khong_do_duoc_buy_tax: "không đo được buy tax",
  buy_tax_cao: "buy tax vượt ngưỡng",
  khong_ban_duoc: "không bán được (honeypot, hoặc token chặn bán)",
  khong_do_duoc_sell_tax: "không đo được sell tax",
  sell_tax_cao: "sell tax vượt ngưỡng",
  ok: "tax trong ngưỡng",
};
