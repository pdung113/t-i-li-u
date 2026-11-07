export function normalizeListing(raw) {
  if (!raw || typeof raw !== "object") return null;
  const priceRaw = raw.price?.current?.value ?? raw.price?.value ?? raw.current_price ?? raw.currentPrice;
  const offer = raw.protocol_data?.parameters?.offer?.[0] ?? raw.protocolData?.parameters?.offer?.[0];
  const tokenId = raw.tokenId ?? raw.token_id ?? offer?.identifierOrCriteria ?? null;
  const hash = raw.order_hash ?? raw.orderHash ?? raw.hash ?? null;
  const protocol = raw.protocol_address ?? raw.protocolAddress ?? null;
  if (priceRaw == null || !hash) return null;
  try {
    return {
      price: BigInt(priceRaw),
      tokenId: tokenId == null ? null : String(tokenId),
      hash: String(hash),
      protocol: protocol ? String(protocol) : null,
      chain: raw.chain ?? null,
    };
  } catch {
    return null;
  }
}

export function pickCheapest(listings, maxPrice, quantity, tokenId) {
  const wanted = tokenId == null ? null : String(tokenId);
  return (listings || [])
    .map(normalizeListing)
    .filter((item) => item && item.price <= maxPrice && (wanted == null || item.tokenId === wanted))
    .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
    .slice(0, Math.max(0, quantity));
}

export function fulfillmentTx(body) {
  const tx = body?.fulfillment_data?.transaction ?? body?.fulfillmentData?.transaction ?? body?.transaction;
  if (!tx?.to || !(tx.input_data || tx.inputData || tx.data)) return null;
  const valueRaw = tx.value ?? 0;
  return {
    to: tx.to,
    data: tx.input_data ?? tx.inputData ?? tx.data,
    value: BigInt(valueRaw),
  };
}
