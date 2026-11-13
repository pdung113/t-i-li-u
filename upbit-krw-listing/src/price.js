// Bảng bước giá KRW sau thay đổi ngày 31/7/2025.
const TICKS = [
  [1_000_000, 1000],
  [500_000, 500],
  [100_000, 100],
  [50_000, 50],
  [10_000, 10],
  [5_000, 5],
  [100, 1],
  [10, 0.1],
  [1, 0.01],
  [0.1, 0.001],
  [0.01, 0.0001],
  [0.001, 0.00001],
  [0.0001, 0.000001],
  [0.00001, 0.0000001],
  [0, 0.00000001],
];

export const UPBIT_KRW_FEE = 0.0005;
export const MIN_KRW_ORDER = 5000;

export function tickSize(price) {
  for (const [min, tick] of TICKS) {
    if (price >= min) return tick;
  }
  return 0.00000001;
}

export function decimalsOf(tick) {
  const text = tick.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function ceilTo(price, tick) {
  const decimals = decimalsOf(tick);
  const scale = 10 ** decimals;
  const units = Math.ceil((price * scale) / Math.round(tick * scale) - 1e-9);
  return (units * Math.round(tick * scale)) / scale;
}

export function roundUpToTick(price) {
  let current = price;
  for (let i = 0; i < 4; i += 1) {
    const tick = tickSize(current);
    const next = ceilTo(current, tick);
    if (Math.abs(next - current) < tick / 1e6) return next;
    if (tickSize(next) === tick) return next;
    current = next;
  }
  return current;
}

export function formatDecimal(value, maxDecimals) {
  let text = Number(value).toFixed(maxDecimals);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

export function floorDecimals(value, decimals) {
  const scale = 10 ** decimals;
  return Math.floor(value * scale + 1e-8) / scale;
}

export function limitPrice(reference, multiple) {
  return roundUpToTick(reference * multiple);
}

export function limitVolume(budgetKrw, price, fee = UPBIT_KRW_FEE) {
  if (!(price > 0) || !(budgetKrw > 0)) return 0;
  return floorDecimals(budgetKrw / (price * (1 + fee)), 8);
}
