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

export function parseUserNumber(value) {
  let text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(text)) text = text.replace(/[.,]/g, "");
  else text = text.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

export function reserveUsd(reserve, decimals, priceUsd) {
  if (typeof reserve !== "bigint" || !(priceUsd > 0)) return null;
  const scale = 10n ** BigInt(decimals);
  const usdScaled = BigInt(Math.round(Number(priceUsd) * 1_000_000));
  const product = reserve * usdScaled;
  const divisor = scale * 1_000_000n;
  if (divisor <= 0n) return null;
  return Number(product / divisor) + Number(product % divisor) / Number(divisor);
}

export function poolSidesUsd({ nativeReserve, tokenReserve, amountIn, amountOut, nativeUsd, nativeDecimals }) {
  if (typeof nativeReserve !== "bigint" || typeof tokenReserve !== "bigint") return null;
  if (typeof amountIn !== "bigint" || typeof amountOut !== "bigint") return null;
  if (amountIn <= 0n || amountOut <= 0n || !(nativeUsd > 0)) return null;
  const native = reserveUsd(nativeReserve, nativeDecimals, nativeUsd);
  const scale = 10n ** BigInt(nativeDecimals);
  const usdScaled = BigInt(Math.round(Number(nativeUsd) * 1_000_000));
  const product = tokenReserve * amountIn * usdScaled;
  const divisor = amountOut * scale * 1_000_000n;
  if (native == null || divisor <= 0n) return null;
  const token = Number(product / divisor) + Number(product % divisor) / Number(divisor);
  return { native, token };
}

export function liquidityAllows(sides, minUsd, symbol = "") {
  const min = Number(minUsd);
  if (!Number.isFinite(min) || min <= 0) return { ok: true };
  if (!sides || sides.native == null || sides.token == null) {
    return { ok: false, reason: "Không đọc được thanh khoản pool nên không mua." };
  }
  if (sides.native < min || sides.token < min) {
    const name = symbol || "native";
    return {
      ok: false,
      reason: `Thanh khoản thấp: ${name} ${formatUsd(sides.native)} USD, token ${formatUsd(sides.token)} USD. Cần mỗi bên ít nhất ${formatUsd(min)} USD.`,
      native: sides.native,
      token: sides.token,
    };
  }
  return { ok: true, native: sides.native, token: sides.token };
}

export function solanaLiquidityAllows(totalUsd, minPerSide) {
  const min = Number(minPerSide);
  if (!Number.isFinite(min) || min <= 0) return { ok: true };
  if (totalUsd == null || !Number.isFinite(Number(totalUsd))) {
    return { ok: false, reason: "Không đọc được thanh khoản Solana nên không mua." };
  }
  const total = Number(totalUsd);
  const need = min * 2;
  if (total < need) {
    return {
      ok: false,
      reason: `Thanh khoản Solana ${formatUsd(total)} USD cho cả pool. Cần khoảng ${formatUsd(need)} USD, tức mỗi bên khoảng ${formatUsd(min)} USD.`,
      poolLiquidity: total,
    };
  }
  return { ok: true, poolLiquidity: total };
}

export function fdvAllows(fdv, maxFdv) {
  const cap = Number(maxFdv);
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };
  if (!(fdv > 0)) return { ok: false, reason: "Không đọc được FDV nên không mua." };
  if (fdv > cap) return { ok: false, reason: `FDV ${formatUsd(fdv)} USD cao hơn mức tối đa ${formatUsd(cap)} USD.` };
  return { ok: true, fdv };
}
