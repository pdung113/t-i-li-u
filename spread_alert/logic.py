"""Pure helpers: chain ids, symbol matching, and spread math."""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass

# Exchange network name -> DexScreener chain id.
# Only aliases that are unambiguous. Unknown networks are skipped.
CHAIN_ALIASES: dict[str, str] = {
    "eth": "ethereum",
    "erc20": "ethereum",
    "ethereum": "ethereum",
    "bsc": "bsc",
    "bep20": "bsc",
    "bnb smart chain": "bsc",
    "sol": "solana",
    "solana": "solana",
    "base": "base",
    "baseevm": "base",
    "matic": "polygon",
    "polygon": "polygon",
    "polygon pos": "polygon",
    "avax_c": "avalanche",
    "avaxc": "avalanche",
    "avaxc-chain": "avalanche",
    "avaxcchain": "avalanche",
    "c-chain": "avalanche",
    "arbevm": "arbitrum",
    "arbitrum": "arbitrum",
    "arbitrumone": "arbitrum",
    "arb": "arbitrum",
    "op": "optimism",
    "optimism": "optimism",
    "opeth": "optimism",
    "linea": "linea",
    "lineaeth": "linea",
    "zksync": "zksync",
    "zksyncera": "zksync",
    "zksera": "zksync",
    "zksync2": "zksync",
    "scroll": "scroll",
    "blast": "blast",
    "blasteth": "blast",
    "mantle": "mantle",
    "mnt": "mantle",
    "trx": "tron",
    "trc20": "tron",
    "tron": "tron",
    "ton": "ton",
    "ton2": "ton",
    "sui": "sui",
    "suinew": "sui",
    "apt": "aptos",
    "aptos": "aptos",
    "ftm": "fantom",
    "fantom": "fantom",
    "cro": "cronos",
    "cronos": "cronos",
    "cronoschain": "cronos",
    "xdai": "gnosis",
    "gnosis": "gnosis",
    "celo": "celo",
    "glmr": "moonbeam",
    "moonbeam": "moonbeam",
    "movr": "moonriver",
    "moonriver": "moonriver",
    "kava": "kava",
    "kavaevm": "kava",
    "metis": "metis",
    "core": "core",
    "coredao": "core",
    "opbnb": "opbnb",
    "pulse": "pulsechain",
    "pulsechain": "pulsechain",
    "manta": "manta",
    "mantanetwork": "manta",
    "merlin": "merlin",
    "taiko": "taiko",
    "mode": "mode",
    "sei": "sei",
    "seievm": "sei",
    "sonic": "sonic",
    "bera": "berachain",
    "berachain": "berachain",
    "near": "near",
    "nearprotocol": "near",
    "starknet": "starknet",
    "worldchain": "worldchain",
    "unichain": "unichain",
    "abstract": "abstract",
    "abs": "abstract",
    "hyperevm": "hyperevm",
    "hype": "hyperevm",
    "soneium": "soneium",
    "ink": "ink",
    "apechain": "apechain",
    "kaia": "kaia",
    "klay": "kaia",
    "chz2": "chiliz",
    "chiliz": "chiliz",
    "cap20": "chiliz",
    "ron": "ronin",
    "ronin": "ronin",
    "morph": "morph",
    "kcc": "kcc",
    "aurora": "aurora",
    "scrl": "scroll",
}

# Native gas token -> wrapped contract used when the CEX leaves the address blank.
WRAPPED_NATIVE: dict[tuple[str, str], str] = {
    ("ethereum", "ETH"): "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    ("bsc", "BNB"): "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    ("polygon", "POL"): "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    ("polygon", "MATIC"): "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    ("avalanche", "AVAX"): "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    ("arbitrum", "ETH"): "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    ("optimism", "ETH"): "0x4200000000000000000000000000000000000006",
    ("base", "ETH"): "0x4200000000000000000000000000000000000006",
    ("linea", "ETH"): "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f",
    ("scroll", "ETH"): "0x5300000000000000000000000000000000000004",
    ("blast", "ETH"): "0x4300000000000000000000000000000000000004",
    ("zksync", "ETH"): "0x5aea5775959fbc2557cc8789bc1bf90a239d9a91",
    ("solana", "SOL"): "So11111111111111111111111111111111111111112",
    ("tron", "TRX"): "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR",
    ("mantle", "MNT"): "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8",
    ("fantom", "FTM"): "0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83",
    ("cronos", "CRO"): "0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23",
    ("sui", "SUI"): "0x2::sui::SUI",
    ("aptos", "APT"): "0x1::aptos_coin::AptosCoin",
}

_PLACEHOLDERS = {
    "",
    "0x",
    "0x0",
    "0x0000000000000000000000000000000000000000",
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "null",
    "none",
    "-",
}

_WRAPPED_BASES = {"ETH", "BTC", "BNB", "SOL", "MATIC", "POL", "AVAX", "FTM", "CRO", "MNT", "BERA", "TRX", "S"}
_MULTIPLIER = re.compile(r"^(1000000|100000|10000|1000)([A-Z][A-Z0-9]{1,20})$")
_LEVERAGED = re.compile(r"^[A-Z0-9]{2,15}(2L|2S|3L|3S|5L|5S)$")

STABLES = {
    "USDT",
    "USDC",
    "DAI",
    "FDUSD",
    "TUSD",
    "USDE",
    "USD1",
    "BUSD",
    "USDP",
    "FRAX",
    "PYUSD",
    "GUSD",
    "USDD",
    "EURC",
    "EURT",
    "USDY",
    "USDS",
    "RLUSD",
    "USD",
    "USDP",
    "CRVUSD",
    "GHO",
    "USDG",
    "XUSD",
}

FIAT = {
    "EUR",
    "GBP",
    "TRY",
    "BRL",
    "AUD",
    "RUB",
    "UAH",
    "PLN",
    "ARS",
    "NGN",
    "ZAR",
    "VND",
    "IDR",
    "JPY",
    "KRW",
    "MXN",
    "COP",
    "CZK",
    "CAD",
    "CHF",
    "SGD",
    "HKD",
    "INR",
}

MAJOR_QUOTES = STABLES | {
    "WETH",
    "ETH",
    "WBNB",
    "BNB",
    "WSOL",
    "SOL",
    "WBTC",
    "BTC",
    "WMATIC",
    "POL",
    "MATIC",
    "WAVAX",
    "AVAX",
    "WTRX",
    "TRX",
    "SUI",
    "TON",
}

EXCHANGE_NAMES = {
    "binance": "Binance",
    "gate": "Gate.io",
    "kucoin": "KuCoin",
    "bitget": "Bitget",
    "htx": "HTX",
    "mexc": "MEXC",
    "okx": "OKX",
    "bybit": "Bybit",
}


def chain_id(raw: str | None) -> str | None:
    if not raw:
        return None
    lowered = raw.strip().lower()
    squashed = re.sub(r"[\s_\-]+", "", lowered)
    return CHAIN_ALIASES.get(lowered) or CHAIN_ALIASES.get(squashed)


def normalize_address(address: str) -> str:
    value = address.strip()
    if value.startswith("0x") and "::" not in value:
        return value.lower()
    return value


def clean_address(address: str | None) -> str | None:
    if address is None:
        return None
    value = str(address).strip()
    if value.lower() in _PLACEHOLDERS:
        return None
    if len(value) < 6:
        return None
    return normalize_address(value)


def wrapped_native(chain: str, base: str) -> str | None:
    return WRAPPED_NATIVE.get((chain, base.upper()))


def normalize_symbol(symbol: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", symbol.upper())


def symbols_match(cex_base: str, dex_symbol: str) -> tuple[bool, float]:
    """Return (matches, divisor applied to the CEX price).

    Divisor converts the CEX quote into the same unit the DEX pool uses.
    Binance lists 1000PEPE as the price of 1000 tokens; the pool is usually 1 PEPE.
    """
    cex = normalize_symbol(cex_base)
    dex = normalize_symbol(dex_symbol)
    if not cex or not dex:
        return False, 1.0
    if cex == dex:
        return True, 1.0
    if _is_wrapped_alias(dex, cex) or _is_wrapped_alias(cex, dex):
        return True, 1.0
    scaled = _MULTIPLIER.fullmatch(cex)
    if scaled and (scaled.group(2) == dex or _is_wrapped_alias(dex, scaled.group(2))):
        return True, float(scaled.group(1))
    scaled = _MULTIPLIER.fullmatch(dex)
    if scaled and (scaled.group(2) == cex or _is_wrapped_alias(cex, scaled.group(2))):
        return True, 1.0 / float(scaled.group(1))
    return False, 1.0


def _is_wrapped_alias(maybe_wrapped: str, underlying: str) -> bool:
    return maybe_wrapped == f"W{underlying}" and underlying in _WRAPPED_BASES


def is_ignored_asset(base: str, name: str = "") -> bool:
    symbol = normalize_symbol(base)
    if not symbol or symbol in STABLES or symbol in FIAT:
        return True
    if _LEVERAGED.fullmatch(symbol):
        return True
    label = name.lower()
    if "leveraged" in label or "leverage token" in label:
        return True
    return False


def anchor_indexes(prices: list[float], tolerance: float = 0.25) -> list[int] | None:
    """Indexes of prices that sit near the median.

    Returns None when there is no majority, so a shared ticker symbol is not
    treated as one asset.
    """
    if not prices:
        return None
    midpoint = statistics.median(prices)
    if midpoint <= 0:
        return None
    chosen = [index for index, price in enumerate(prices) if abs(price - midpoint) / midpoint <= tolerance]
    if len(chosen) * 2 < len(prices):
        return None
    return chosen


def stripped_base(base: str) -> str | None:
    matched = _MULTIPLIER.fullmatch(normalize_symbol(base))
    if not matched:
        return None
    return matched.group(2)


@dataclass(frozen=True, slots=True)
class ChainGate:
    """Deposit and withdrawal status for one network on a CEX."""

    chain: str
    raw_name: str
    withdraw_open: bool | None
    deposit_open: bool | None


@dataclass(slots=True)
class Listing:
    exchange: str
    base: str
    pair: str
    quote: str
    last: float
    bid: float | None = None
    ask: float | None = None
    quote_volume: float | None = None
    top_notional: float | None = None
    name: str = ""
    gates: tuple[ChainGate, ...] = ()


@dataclass(slots=True)
class Market:
    chain: str
    address: str
    listings: list[Listing]


@dataclass(frozen=True, slots=True)
class Pool:
    chain: str
    dex: str
    url: str
    base_symbol: str
    quote_symbol: str
    price_usd: float
    liquidity_usd: float


@dataclass(frozen=True, slots=True)
class Opportunity:
    exchange: str
    base: str
    pair: str
    chain: str
    address: str
    dex: str
    url: str
    direction: str
    edge_pct: float
    cex_price: float
    dex_price: float
    liquidity_usd: float
    quote_volume: float | None
    dex_symbol: str
    quote_symbol: str
    gates: tuple[ChainGate, ...] = ()


def pick_pool(pairs: list[dict], address: str, listings: list[Listing], min_liquidity: float) -> Pool | None:
    wanted = normalize_address(address)
    best: Pool | None = None
    for pair in pairs:
        base = pair.get("baseToken") or {}
        quote = pair.get("quoteToken") or {}
        base_addr = clean_address(str(base.get("address") or ""))
        if base_addr != wanted:
            continue
        quote_symbol = normalize_symbol(str(quote.get("symbol") or ""))
        if quote_symbol not in MAJOR_QUOTES:
            continue
        base_symbol = str(base.get("symbol") or "")
        if not any(symbols_match(item.base, base_symbol)[0] for item in listings):
            continue
        try:
            price = float(pair["priceUsd"])
            liquidity = float((pair.get("liquidity") or {}).get("usd") or 0)
        except (TypeError, ValueError, KeyError):
            continue
        if price <= 0 or liquidity < min_liquidity:
            continue
        pool = Pool(
            chain=str(pair.get("chainId") or ""),
            dex=str(pair.get("dexId") or "dex"),
            url=str(pair.get("url") or ""),
            base_symbol=base_symbol,
            quote_symbol=str(quote.get("symbol") or ""),
            price_usd=price,
            liquidity_usd=liquidity,
        )
        if best is None or pool.liquidity_usd > best.liquidity_usd:
            best = pool
    return best


def best_opportunity(
    listings: list[Listing],
    pool: Pool,
    *,
    token_address: str,
    chain: str,
    min_volume: float,
    min_top_notional: float,
    max_spread: float,
) -> Opportunity | None:
    best: Opportunity | None = None
    for listing in listings:
        opportunity = _opportunity_for(
            listing,
            pool,
            token_address=token_address,
            chain=chain,
            min_volume=min_volume,
            min_top_notional=min_top_notional,
        )
        if opportunity is None or opportunity.edge_pct > max_spread:
            continue
        if best is None or opportunity.edge_pct > best.edge_pct:
            best = opportunity
    return best


def raw_spread_pct(listing: Listing, pool: Pool) -> float | None:
    matched, divisor = symbols_match(listing.base, pool.base_symbol)
    if not matched or divisor <= 0 or listing.last <= 0:
        return None
    last = listing.last / divisor
    if last <= 0:
        return None
    return (pool.price_usd - last) / last * 100.0


def _opportunity_for(
    listing: Listing,
    pool: Pool,
    *,
    token_address: str,
    chain: str,
    min_volume: float,
    min_top_notional: float,
) -> Opportunity | None:
    matched, divisor = symbols_match(listing.base, pool.base_symbol)
    if not matched or divisor <= 0 or listing.last <= 0:
        return None
    if listing.quote_volume is not None and listing.quote_volume < min_volume:
        return None
    if listing.top_notional is not None and listing.top_notional < min_top_notional:
        return None
    last = listing.last / divisor
    bid = listing.bid / divisor if listing.bid and listing.bid > 0 else None
    ask = listing.ask / divisor if listing.ask and listing.ask > 0 else None
    if last <= 0:
        return None
    buy_px = ask or last
    sell_px = bid or last
    if buy_px <= 0 or sell_px <= 0:
        return None
    edge_buy_cex = (pool.price_usd - buy_px) / buy_px * 100.0
    edge_buy_dex = (sell_px - pool.price_usd) / pool.price_usd * 100.0
    if edge_buy_cex >= edge_buy_dex:
        direction, edge, cex_price = "buy_cex", edge_buy_cex, buy_px
    else:
        direction, edge, cex_price = "buy_dex", edge_buy_dex, sell_px
    if edge <= 0:
        return None
    return Opportunity(
        exchange=listing.exchange,
        base=listing.base,
        pair=listing.pair,
        chain=pool.chain or chain,
        address=token_address,
        dex=pool.dex,
        url=pool.url,
        direction=direction,
        edge_pct=edge,
        cex_price=cex_price,
        dex_price=pool.price_usd,
        liquidity_usd=pool.liquidity_usd,
        quote_volume=listing.quote_volume,
        dex_symbol=pool.base_symbol,
        quote_symbol=pool.quote_symbol,
        gates=tuple(listing.gates),
    )


_CHAIN_LABELS = {
    "ethereum": "Ethereum",
    "bsc": "BSC",
    "solana": "Solana",
    "arbitrum": "Arbitrum",
    "optimism": "Optimism",
    "base": "Base",
    "polygon": "Polygon",
    "avalanche": "Avalanche",
    "tron": "Tron",
    "ton": "TON",
    "sui": "Sui",
    "aptos": "Aptos",
    "linea": "Linea",
    "scroll": "Scroll",
    "zksync": "zkSync",
    "blast": "Blast",
    "mantle": "Mantle",
}

# Well-known routes only. A bridge still has to list that exact token.
_BRIDGES: dict[frozenset[str], tuple[tuple[str, str], ...]] = {
    frozenset({"ethereum", "arbitrum"}): (("Arbitrum Bridge", "https://bridge.arbitrum.io"),),
    frozenset({"ethereum", "optimism"}): (("Optimism Bridge", "https://app.optimism.io/bridge"),),
    frozenset({"ethereum", "base"}): (
        ("Superbridge", "https://superbridge.app"),
        ("Across", "https://app.across.to"),
    ),
    frozenset({"ethereum", "polygon"}): (("Polygon Portal", "https://portal.polygon.technology/bridge"),),
    frozenset({"ethereum", "bsc"}): (
        ("deBridge", "https://app.debridge.finance"),
        ("Stargate", "https://stargate.finance/bridge"),
    ),
    frozenset({"ethereum", "avalanche"}): (
        ("Core", "https://core.app/bridge"),
        ("Stargate", "https://stargate.finance/bridge"),
    ),
    frozenset({"ethereum", "linea"}): (("Linea Bridge", "https://bridge.linea.build"),),
    frozenset({"ethereum", "scroll"}): (("Scroll Bridge", "https://scroll.io/bridge"),),
    frozenset({"ethereum", "zksync"}): (("zkSync Bridge", "https://portal.zksync.io/bridge"),),
    frozenset({"ethereum", "blast"}): (("Blast Bridge", "https://blast.io/bridge"),),
    frozenset({"ethereum", "mantle"}): (("Mantle Bridge", "https://app.mantle.xyz/bridge"),),
    frozenset({"ethereum", "solana"}): (
        ("deBridge", "https://app.debridge.finance"),
        ("Mayan", "https://mayan.finance"),
    ),
    frozenset({"ethereum", "tron"}): (("deBridge", "https://app.debridge.finance"),),
    frozenset({"arbitrum", "base"}): (("Across", "https://app.across.to"),),
    frozenset({"arbitrum", "optimism"}): (("Across", "https://app.across.to"), ("Stargate", "https://stargate.finance/bridge")),
    frozenset({"arbitrum", "polygon"}): (("Across", "https://app.across.to"),),
    frozenset({"base", "optimism"}): (("Superbridge", "https://superbridge.app"), ("Across", "https://app.across.to")),
    frozenset({"bsc", "arbitrum"}): (("deBridge", "https://app.debridge.finance"), ("Stargate", "https://stargate.finance/bridge")),
    frozenset({"bsc", "solana"}): (("deBridge", "https://app.debridge.finance"),),
}

_WITHDRAW_PAGE = {
    "binance": "https://www.binance.com/en/my/wallet/account/main/withdrawal/crypto/{coin}",
    "gate": "https://www.gate.io/myaccount/withdraw/{coin}",
    "kucoin": "https://www.kucoin.com/assets/withdraw/{coin}",
    "bitget": "https://www.bitget.com/asset/withdraw?coinId=2&coin={coin}",
    "htx": "https://www.htx.com/finance/withdraw/",
    "mexc": "https://www.mexc.com/assets/withdraw/{coin}",
    "okx": "https://www.okx.com/balance/withdrawal/{coin}",
    "bybit": "https://www.bybit.com/user/assets/withdraw?coin={coin}",
}


def chain_label(chain: str) -> str:
    return _CHAIN_LABELS.get(chain, chain or "?")


def flag_open(value: object) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "allowed", "normal"}:
        return True
    if text in {"0", "false", "no", "prohibited", "suspended", "delisted"}:
        return False
    return None


def make_gate(raw_name: str, withdraw: object, deposit: object) -> ChainGate:
    return ChainGate(
        chain=chain_id(raw_name) or "",
        raw_name=raw_name,
        withdraw_open=flag_open(withdraw),
        deposit_open=flag_open(deposit),
    )


def _open_chains(gates: list[ChainGate], withdraw: bool) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for gate in gates:
        flag = gate.withdraw_open if withdraw else gate.deposit_open
        if flag is not True:
            continue
        label = chain_label(gate.chain) if gate.chain else gate.raw_name
        if label in seen:
            continue
        seen.add(label)
        found.append((gate.chain, label))
    return found


def _status_line(action: str, venue: str, gates: list[ChainGate], pool_chain: str, withdraw: bool) -> str:
    open_chains = _open_chains(gates, withdraw)
    on_pool = [gate for gate in gates if gate.chain == pool_chain]
    pool_label = chain_label(pool_chain)

    def closed(gate: ChainGate) -> bool:
        flag = gate.withdraw_open if withdraw else gate.deposit_open
        return flag is False

    if open_chains:
        shown = ", ".join(label for _chain, label in open_chains[:4])
        locked = f" Đang khóa trên {pool_label}." if on_pool and all(closed(gate) for gate in on_pool) else ""
        return f"{action} {venue}: đang mở trên {shown}.{locked}"
    if any(closed(gate) for gate in gates):
        return f"{action} {venue}: đang khóa"
    return f"{action} {venue}: sàn không ghi rõ trạng thái"


def transfer_lines(exchange: str, base: str, direction: str, pool_chain: str, gates: tuple[ChainGate, ...]) -> list[str]:
    """Withdraw and deposit status for the CEX in this alert.

    Buying the CEX and selling the pool needs a withdrawal. Buying the pool and
    selling the CEX needs a deposit, which many venues suspend while the CEX
    price is the higher one.
    """
    venue = EXCHANGE_NAMES.get(exchange, exchange)
    usable = [gate for gate in gates if gate.chain or gate.raw_name]
    if not usable:
        lines = [
            f"Rút {venue}: không có dữ liệu công khai về khóa hay mở",
            f"Nạp {venue}: không có dữ liệu công khai về khóa hay mở",
        ]
        page = _WITHDRAW_PAGE.get(exchange)
        if page:
            lines.append(f"Xem trên sàn: {page.format(coin=base)}")
        return lines

    lines = [
        _status_line("Rút", venue, usable, pool_chain, withdraw=True),
        _status_line("Nạp", venue, usable, pool_chain, withdraw=False),
    ]
    need_withdraw = direction == "buy_cex"
    pool_label = chain_label(pool_chain)
    on_pool = [gate for gate in usable if gate.chain == pool_chain]

    def opened(gate: ChainGate) -> bool:
        flag = gate.withdraw_open if need_withdraw else gate.deposit_open
        return flag is True

    open_chains = _open_chains(usable, need_withdraw)
    if any(opened(gate) for gate in on_pool):
        verb = "rút" if need_withdraw else "nạp"
        lines.append(f"Trùng chain với pool, {verb} thẳng, không cần cầu")
        return lines
    if not open_chains:
        if need_withdraw:
            lines.append("Không rút được coin ra khỏi sàn")
        else:
            lines.append("Không nạp được coin lên sàn")
        return lines

    lines.append(f"Pool ở {pool_label}, lệch chain")
    named = False
    for chain, label in open_chains[:3]:
        routes = _BRIDGES.get(frozenset({chain, pool_chain}), ()) if chain and pool_chain else ()
        if not routes:
            continue
        joined = ", ".join(f"{name} {url}" for name, url in routes[:2])
        if need_withdraw:
            lines.append(f"Cầu {label} → {pool_label}: {joined}")
        else:
            lines.append(f"Cầu {pool_label} → {label}: {joined}")
        named = True
    if not named:
        lines.append("Chưa có cầu riêng cho cặp chain này. Thử https://app.debridge.finance hoặc https://app.across.to")
    lines.append("Cầu chỉ đi được khi đúng token có trong danh sách. Bản bọc của sàn thường không sang được pool.")
    return lines
