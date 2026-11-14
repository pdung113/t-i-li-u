export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const QUOTE_MINTS = new Set([
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
]);

export function solToLamports(value) {
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error("Số SOL không hợp lệ");
  const [, whole, frac = ""] = match;
  if (frac.length > 9) throw new Error("Số SOL tối đa 9 chữ số thập phân");
  const padded = (frac + "000000000").slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(padded);
}

export function formatLamports(lamports) {
  const value = BigInt(lamports);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function accountKeysOf(message, meta) {
  const raw = message?.accountKeys || [];
  const staticKeys = raw
    .map((key) => (typeof key === "string" ? key : key?.pubkey))
    .filter(Boolean);
  const loaded = meta?.loadedAddresses || {};
  return [...staticKeys, ...(loaded.writable || []), ...(loaded.readonly || [])];
}

export function fromNotification(result) {
  if (!result) return null;
  const wrapper = result.transaction || {};
  const meta = result.meta || wrapper.meta || null;
  if (!meta) return null;
  const inner = wrapper.transaction;
  const message = inner && !Array.isArray(inner) ? inner.message : wrapper.message;
  return {
    signature: result.signature || null,
    slot: result.slot ?? null,
    meta,
    accountKeys: accountKeysOf(message, meta),
  };
}

export function fromRpcTransaction(signature, result) {
  if (!result?.meta) return null;
  return {
    signature,
    slot: result.slot ?? null,
    meta: result.meta,
    accountKeys: accountKeysOf(result.transaction?.message, result.meta),
  };
}

function tokenAmount(balance) {
  const raw = balance?.uiTokenAmount?.amount;
  if (raw == null) return 0n;
  return BigInt(raw);
}

function tokenDeltas(meta, owner) {
  const totals = new Map();
  const add = (rows, field) => {
    for (const row of rows || []) {
      if (row.owner !== owner || !row.mint) continue;
      const current = totals.get(row.mint) || { pre: 0n, post: 0n };
      current[field] += tokenAmount(row);
      totals.set(row.mint, current);
    }
  };
  add(meta.preTokenBalances, "pre");
  add(meta.postTokenBalances, "post");
  return totals;
}

function nativeSpent(meta, accountKeys, target) {
  const index = accountKeys.indexOf(target);
  if (index < 0) return 0n;
  const pre = BigInt(meta.preBalances?.[index] ?? 0);
  const post = BigInt(meta.postBalances?.[index] ?? 0);
  let spent = pre - post;
  if (index === 0) spent -= BigInt(meta.fee ?? 0);
  return spent > 0n ? spent : 0n;
}

export function detectBuy(tx, target, { minSolLamports = 5_000_000n } = {}) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const deltas = tokenDeltas(meta, target);
  const gained = [];
  let spentQuote = false;
  let soldToken = false;
  for (const [mint, row] of deltas) {
    const change = row.post - row.pre;
    if (change > 0n && !QUOTE_MINTS.has(mint)) gained.push({ mint, amount: change });
    if (change < 0n && QUOTE_MINTS.has(mint)) spentQuote = true;
    if (change < 0n && !QUOTE_MINTS.has(mint)) soldToken = true;
  }
  if (gained.length === 0) return null;
  const solSpent = nativeSpent(meta, tx.accountKeys || [], target);
  if (!spentQuote && !soldToken && solSpent < minSolLamports) return null;
  gained.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  return {
    mint: gained[0].mint,
    amount: gained[0].amount,
    solSpent,
    signature: tx.signature || null,
    slot: tx.slot ?? null,
  };
}

export function priceImpactPercent(build) {
  const ratio = Number(build?.priceImpactPct);
  if (!Number.isFinite(ratio)) return null;
  return ratio * 100;
}

export function overImpact(build, maxPercent) {
  const impact = priceImpactPercent(build);
  return impact != null && impact > maxPercent;
}
