export const MAX_NATIVE = 5;

export function amountFor(chainId, amounts) {
  const value = Number(amounts?.[chainId] || 0);
  return Number.isFinite(value) ? value : 0;
}

export function fdvUsd({ amountIn, amountOut, totalSupply, nativeUsd, nativeDecimals }) {
  if (typeof amountIn !== "bigint" || typeof amountOut !== "bigint" || typeof totalSupply !== "bigint") return null;
  if (amountIn <= 0n || amountOut <= 0n || totalSupply <= 0n || !(nativeUsd > 0)) return null;
  const usdScaled = BigInt(Math.round(Number(nativeUsd) * 1_000_000));
  const product = totalSupply * amountIn * usdScaled;
  const divisor = amountOut * (10n ** BigInt(nativeDecimals)) * 1_000_000n;
  if (divisor <= 0n) return null;
  return Number(product / divisor) + Number(product % divisor) / Number(divisor);
}

export function formatUsd(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function fdvAllows(fdv, maxFdv) {
  const cap = Number(maxFdv);
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };
  if (!(fdv > 0)) return { ok: false, reason: "Không đọc được FDV nên không mua." };
  if (fdv > cap) return { ok: false, reason: `FDV ${formatUsd(fdv)} USD cao hơn mức tối đa ${formatUsd(cap)} USD.` };
  return { ok: true, fdv };
}
