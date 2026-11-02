"""Join CEX listings onto DEX contracts."""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict

from spread_alert.cex import ListedCoin, listing_from
from spread_alert.logic import (
    Listing,
    Market,
    anchor_indexes,
    chain_id,
    clean_address,
    stripped_base,
    symbols_match,
    wrapped_native,
)


# Native BTC has no EVM contract. WBTC is the liquid Ethereum market for that price.
_EXTRA_CONTRACTS: dict[str, tuple[tuple[str, str], ...]] = {
    "BTC": (("ethereum", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"),),
}


def assemble_markets(
    coins: list[ListedCoin],
    chains: frozenset[str] | set[str] = frozenset(),
) -> tuple[dict[tuple[str, str], Market], dict[tuple[str, str], list[Listing]], Counter]:
    markets: dict[tuple[str, str], Market] = {}
    anchors: dict[str, list[tuple[Market, Listing]]] = defaultdict(list)
    unmapped: Counter = Counter()

    for coin in coins:
        if not coin.has_own_contracts or coin.quote is None:
            continue
        listing = listing_from(coin, coin.quote)
        seen: set[tuple[str, str]] = set()
        contract_rows = list(coin.contracts)
        contract_rows.extend(_EXTRA_CONTRACTS.get(coin.base, ()))
        for raw_chain, raw_address in contract_rows:
            mapped = chain_id(raw_chain)
            if mapped is None:
                if clean_address(raw_address):
                    unmapped[raw_chain or "?"] += 1
                continue
            if chains and mapped not in chains:
                continue
            address = clean_address(raw_address) or wrapped_native(mapped, coin.base)
            if not address:
                continue
            key = (mapped, address)
            if key in seen:
                continue
            seen.add(key)
            market = markets.get(key)
            if market is None:
                market = Market(chain=mapped, address=address, listings=[])
                markets[key] = market
            if _has_listing(market, listing):
                continue
            market.listings.append(listing)
            anchors[coin.base].append((market, listing))

    for coin in coins:
        if coin.has_own_contracts or coin.quote is None:
            continue
        listing = listing_from(coin, coin.quote)
        group = anchors.get(coin.base)
        scale = 1.0
        if not group:
            fallback = stripped_base(coin.base)
            group = anchors.get(fallback) if fallback else None
            if group and fallback:
                matched, scale = symbols_match(coin.base, fallback)
                if not matched or scale <= 0:
                    continue
        if not group:
            continue
        chosen = anchor_indexes([item.last for _, item in group])
        if chosen is None:
            continue
        midpoint = statistics.median(group[index][1].last for index in chosen)
        scaled = coin.quote.last / scale
        if midpoint <= 0 or abs(scaled - midpoint) / midpoint > 0.25:
            continue
        attached: set[tuple[str, str]] = set()
        for index in chosen:
            market, _anchor = group[index]
            key = (market.chain, market.address)
            if key in attached or _has_listing(market, listing):
                continue
            attached.add(key)
            market.listings.append(listing)

    index: dict[tuple[str, str], list[Listing]] = defaultdict(list)
    for market in markets.values():
        for listing in market.listings:
            bucket = index[(listing.exchange, listing.base)]
            if all(existing is not listing for existing in bucket):
                bucket.append(listing)
    return markets, index, unmapped


def _has_listing(market: Market, listing: Listing) -> bool:
    return any(item.exchange == listing.exchange and item.base == listing.base for item in market.listings)
