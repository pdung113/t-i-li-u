"""CEX metadata (contract addresses) and bulk ticker prices."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from spread_alert.logic import ChainGate, Listing, clean_address, is_ignored_asset, make_gate

log = logging.getLogger(__name__)

CONTRACT_EXCHANGES = {"binance", "gate", "kucoin", "bitget", "htx"}
SYMBOL_EXCHANGES = {"mexc", "okx", "bybit"}


@dataclass(slots=True)
class PriceQuote:
    pair: str
    quote: str
    last: float
    bid: float | None = None
    ask: float | None = None
    quote_volume: float | None = None
    top_notional: float | None = None
    bid_notional: float | None = None
    ask_notional: float | None = None
    low: float | None = None
    high: float | None = None


@dataclass(slots=True)
class ListedCoin:
    exchange: str
    base: str
    name: str
    quote: PriceQuote | None
    # Raw network name and raw contract text. Empty address means native on that network.
    contracts: list[tuple[str, str]]
    has_own_contracts: bool
    gates: list[ChainGate] = field(default_factory=list)


def listing_from(coin: ListedCoin, quote: PriceQuote) -> Listing:
    return Listing(
        exchange=coin.exchange,
        base=coin.base,
        pair=quote.pair,
        quote=quote.quote,
        last=quote.last,
        bid=quote.bid,
        ask=quote.ask,
        quote_volume=quote.quote_volume,
        top_notional=quote.top_notional,
        bid_notional=quote.bid_notional,
        ask_notional=quote.ask_notional,
        low=quote.low,
        high=quote.high,
        name=coin.name,
        gates=tuple(coin.gates),
    )


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def _split_compact(symbol: str, quotes: tuple[str, ...]) -> tuple[str, str] | None:
    upper = symbol.upper()
    for quote in sorted(quotes, key=len, reverse=True):
        if upper.endswith(quote) and len(upper) > len(quote):
            return upper[: -len(quote)], quote
    return None


def _split_sep(symbol: str, sep: str, quotes: tuple[str, ...]) -> tuple[str, str] | None:
    if sep not in symbol:
        return None
    base, quote = symbol.upper().rsplit(sep, 1)
    if quote in quotes and base:
        return base, quote
    return None


def _prefer(found: dict[str, dict[str, PriceQuote]], quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    chosen: dict[str, PriceQuote] = {}
    for base, by_quote in found.items():
        for quote in quotes:
            if quote in by_quote:
                chosen[base] = by_quote[quote]
                break
    return chosen


def _store(
    found: dict[str, dict[str, PriceQuote]],
    base: str,
    quote: str,
    price: PriceQuote,
) -> None:
    if price.last <= 0:
        return
    found.setdefault(base, {})[quote] = price


async def _json(session: aiohttp.ClientSession, url: str, params: dict | None = None) -> Any:
    async with session.get(url, params=params) as response:
        if response.status in {403, 451}:
            raise PermissionError(f"{response.status} {url}")
        response.raise_for_status()
        return await response.json(content_type=None)


def _prices_binance(rows: list[dict], quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    for row in rows:
        parts = _split_compact(str(row.get("symbol") or ""), quotes)
        if not parts:
            continue
        base, quote = parts
        bid = _num(row.get("bidPrice"))
        ask = _num(row.get("askPrice"))
        bid_qty = _num(row.get("bidQty"))
        ask_qty = _num(row.get("askQty"))
        if bid and ask:
            last = (bid + ask) / 2
        else:
            last = bid or ask or 0
        notionals = []
        if bid and bid_qty:
            notionals.append(bid * bid_qty)
        if ask and ask_qty:
            notionals.append(ask * ask_qty)
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=last or 0,
                bid=bid,
                ask=ask,
                top_notional=max(notionals) if notionals else None,
            ),
        )
    return _prefer(found, quotes)


def _prices_gate(rows: list[dict], quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    for row in rows:
        parts = _split_sep(str(row.get("currency_pair") or ""), "_", quotes)
        if not parts:
            continue
        base, quote = parts
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=_num(row.get("last")) or 0,
                bid=_num(row.get("highest_bid")),
                ask=_num(row.get("lowest_ask")),
                quote_volume=_num(row.get("quote_volume")),
            ),
        )
    return _prefer(found, quotes)


def _prices_kucoin(payload: dict, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    rows = ((payload.get("data") or {}).get("ticker")) or []
    for row in rows:
        parts = _split_sep(str(row.get("symbol") or ""), "-", quotes)
        if not parts:
            continue
        base, quote = parts
        bid = _num(row.get("buy"))
        ask = _num(row.get("sell"))
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=_num(row.get("last")) or 0,
                bid=bid,
                ask=ask,
                quote_volume=_num(row.get("volValue")),
                bid_notional=_notional(bid, _num(row.get("bestBidSize"))),
                ask_notional=_notional(ask, _num(row.get("bestAskSize"))),
                low=_num(row.get("low")),
                high=_num(row.get("high")),
            ),
        )
    return _prefer(found, quotes)


def _notional(price: float | None, size: float | None) -> float | None:
    if price is None or size is None or price <= 0 or size <= 0:
        return None
    return price * size


async def kucoin_level1(session: aiohttp.ClientSession, symbol: str) -> PriceQuote | None:
    """Fresh KuCoin top of book. allTickers can print an ask the page is not trading."""
    payload = await _json(session, "https://api.kucoin.com/api/v1/market/orderbook/level1", {"symbol": symbol})
    row = payload.get("data") or {}
    last = _num(row.get("price"))
    if not last or last <= 0:
        return None
    bid = _num(row.get("bestBid"))
    ask = _num(row.get("bestAsk"))
    base, _, quote = symbol.partition("-")
    return PriceQuote(
        pair=f"{base}/{quote}",
        quote=quote,
        last=last,
        bid=bid,
        ask=ask,
        bid_notional=_notional(bid, _num(row.get("bestBidSize"))),
        ask_notional=_notional(ask, _num(row.get("bestAskSize"))),
    )


def _prices_bitget(payload: dict, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    for row in payload.get("data") or []:
        parts = _split_compact(str(row.get("symbol") or ""), quotes)
        if not parts:
            continue
        base, quote = parts
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=_num(row.get("lastPr")) or 0,
                bid=_num(row.get("bidPr")),
                ask=_num(row.get("askPr")),
                quote_volume=_num(row.get("usdtVolume")) or _num(row.get("quoteVolume")),
            ),
        )
    return _prefer(found, quotes)


def _prices_htx(payload: dict, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    for row in payload.get("data") or []:
        parts = _split_compact(str(row.get("symbol") or ""), quotes)
        if not parts:
            continue
        base, quote = parts
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=_num(row.get("close")) or 0,
                bid=_num(row.get("bid")),
                ask=_num(row.get("ask")),
                quote_volume=_num(row.get("vol")),
            ),
        )
    return _prefer(found, quotes)


def _prices_mexc(payload: Any, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    rows = payload if isinstance(payload, list) else []
    for row in rows:
        parts = _split_compact(str(row.get("symbol") or ""), quotes)
        if not parts:
            continue
        base, quote = parts
        last = _num(row.get("lastPrice")) or _num(row.get("price")) or 0
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=last,
                bid=_num(row.get("bidPrice")),
                ask=_num(row.get("askPrice")),
                quote_volume=_num(row.get("quoteVolume")),
            ),
        )
    return _prefer(found, quotes)


def _prices_okx(payload: dict, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    for row in payload.get("data") or []:
        parts = _split_sep(str(row.get("instId") or ""), "-", quotes)
        if not parts:
            continue
        base, quote = parts
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=_num(row.get("last")) or 0,
                bid=_num(row.get("bidPx")),
                ask=_num(row.get("askPx")),
                quote_volume=_num(row.get("volCcy24h")),
            ),
        )
    return _prefer(found, quotes)


def _prices_bybit(payload: dict, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    found: dict[str, dict[str, PriceQuote]] = {}
    rows = ((payload.get("result") or {}).get("list")) or []
    for row in rows:
        parts = _split_compact(str(row.get("symbol") or ""), quotes)
        if not parts:
            continue
        base, quote = parts
        _store(
            found,
            base,
            quote,
            PriceQuote(
                pair=f"{base}/{quote}",
                quote=quote,
                last=_num(row.get("lastPrice")) or 0,
                bid=_num(row.get("bid1Price")),
                ask=_num(row.get("ask1Price")),
                quote_volume=_num(row.get("turnover24h")),
            ),
        )
    return _prefer(found, quotes)


def _coin(
    exchange: str,
    base: str,
    name: str,
    prices: dict[str, PriceQuote],
    contracts: list[tuple[str, str]],
    owned: bool,
    gates: list[ChainGate] | None = None,
) -> ListedCoin | None:
    if is_ignored_asset(base, name):
        return None
    return ListedCoin(
        exchange=exchange,
        base=base.upper(),
        name=name or base,
        quote=prices.get(base.upper()),
        contracts=contracts,
        has_own_contracts=owned,
        gates=gates or [],
    )


def _coins_from_prices(exchange: str, prices: dict[str, PriceQuote]) -> list[ListedCoin]:
    coins = []
    for base, quote in prices.items():
        coin = _coin(exchange, base, base, {base: quote}, [], False)
        if coin:
            coins.append(coin)
    return coins


async def load_prices(session: aiohttp.ClientSession, exchange: str, quotes: tuple[str, ...]) -> dict[str, PriceQuote]:
    if exchange == "binance":
        payload = await _json(session, "https://data-api.binance.vision/api/v3/ticker/bookTicker")
        return _prices_binance(payload, quotes)
    if exchange == "gate":
        payload = await _json(session, "https://api.gateio.ws/api/v4/spot/tickers")
        return _prices_gate(payload, quotes)
    if exchange == "kucoin":
        payload = await _json(session, "https://api.kucoin.com/api/v1/market/allTickers")
        return _prices_kucoin(payload, quotes)
    if exchange == "bitget":
        payload = await _json(session, "https://api.bitget.com/api/v2/spot/market/tickers")
        return _prices_bitget(payload, quotes)
    if exchange == "htx":
        payload = await _json(session, "https://api.huobi.pro/market/tickers")
        return _prices_htx(payload, quotes)
    if exchange == "mexc":
        try:
            payload = await _json(session, "https://api.mexc.com/api/v3/ticker/24hr")
        except (aiohttp.ClientError, PermissionError):
            payload = await _json(session, "https://api.mexc.com/api/v3/ticker/price")
        return _prices_mexc(payload, quotes)
    if exchange == "okx":
        payload = await _json(session, "https://www.okx.com/api/v5/market/tickers", {"instType": "SPOT"})
        return _prices_okx(payload, quotes)
    if exchange == "bybit":
        payload = await _json(session, "https://api.bybit.com/v5/market/tickers", {"category": "spot"})
        return _prices_bybit(payload, quotes)
    raise KeyError(exchange)


async def load_coins(session: aiohttp.ClientSession, exchange: str, quotes: tuple[str, ...]) -> list[ListedCoin]:
    prices = await load_prices(session, exchange, quotes)
    if exchange == "binance":
        return await _coins_binance(session, prices)
    if exchange == "gate":
        return await _coins_gate(session, prices)
    if exchange == "kucoin":
        return await _coins_kucoin(session, prices)
    if exchange == "bitget":
        return await _coins_bitget(session, prices)
    if exchange == "htx":
        return await _coins_htx(session, prices)
    if exchange in SYMBOL_EXCHANGES:
        return _coins_from_prices(exchange, prices)
    raise KeyError(exchange)


async def _coins_binance(session: aiohttp.ClientSession, prices: dict[str, PriceQuote]) -> list[ListedCoin]:
    payload = await _json(session, "https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll")
    coins: list[ListedCoin] = []
    for row in payload.get("data") or []:
        if row.get("trading") is False:
            continue
        base = str(row.get("coin") or "")
        contracts = []
        gates = []
        for net in row.get("networkList") or []:
            raw = str(net.get("network") or "")
            contracts.append((raw, str(net.get("contractAddress") or "")))
            gates.append(make_gate(raw, net.get("withdrawEnable"), net.get("depositEnable")))
        coin = _coin("binance", base, str(row.get("name") or ""), prices, contracts, True, gates)
        if coin and (coin.quote or contracts):
            coins.append(coin)
    return coins


async def _coins_gate(session: aiohttp.ClientSession, prices: dict[str, PriceQuote]) -> list[ListedCoin]:
    rows = await _json(session, "https://api.gateio.ws/api/v4/spot/currencies")
    coins: list[ListedCoin] = []
    for row in rows:
        if row.get("delisted") or row.get("trade_disabled"):
            continue
        base = str(row.get("currency") or "")
        contracts = []
        gates = []
        for item in row.get("chains") or []:
            raw = str(item.get("name") or "")
            contracts.append((raw, str(item.get("addr") or "")))
            withdraw = None if "withdraw_disabled" not in item else not bool(item.get("withdraw_disabled"))
            deposit = None if "deposit_disabled" not in item else not bool(item.get("deposit_disabled"))
            gates.append(make_gate(raw, withdraw, deposit))
        coin = _coin("gate", base, str(row.get("name") or ""), prices, contracts, True, gates)
        if coin and (coin.quote or contracts):
            coins.append(coin)
    return coins


async def _coins_kucoin(session: aiohttp.ClientSession, prices: dict[str, PriceQuote]) -> list[ListedCoin]:
    payload = await _json(session, "https://api.kucoin.com/api/v3/currencies")
    coins: list[ListedCoin] = []
    for row in payload.get("data") or []:
        base = str(row.get("currency") or "")
        contracts = []
        gates = []
        for item in row.get("chains") or []:
            chain = str(item.get("chainId") or item.get("chainName") or "")
            contracts.append((chain, str(item.get("contractAddress") or "")))
            gates.append(make_gate(chain, item.get("isWithdrawEnabled"), item.get("isDepositEnabled")))
        name = str(row.get("fullName") or row.get("name") or "")
        coin = _coin("kucoin", base, name, prices, contracts, True, gates)
        if coin and (coin.quote or contracts):
            coins.append(coin)
    return coins


async def _coins_bitget(session: aiohttp.ClientSession, prices: dict[str, PriceQuote]) -> list[ListedCoin]:
    payload = await _json(session, "https://api.bitget.com/api/v2/spot/public/coins")
    coins: list[ListedCoin] = []
    for row in payload.get("data") or []:
        base = str(row.get("coin") or "")
        contracts = []
        gates = []
        for item in row.get("chains") or []:
            raw = str(item.get("chain") or "")
            contracts.append((raw, str(item.get("contractAddress") or "")))
            gates.append(make_gate(raw, item.get("withdrawable"), item.get("rechargeable")))
        coin = _coin("bitget", base, base, prices, contracts, True, gates)
        if coin and (coin.quote or contracts):
            coins.append(coin)
    return coins


async def _coins_htx(session: aiohttp.ClientSession, prices: dict[str, PriceQuote]) -> list[ListedCoin]:
    payload = await _json(session, "https://api.huobi.pro/v2/reference/currencies")
    coins: list[ListedCoin] = []
    for row in payload.get("data") or []:
        base = str(row.get("currency") or "").upper()
        contracts = []
        gates = []
        for item in row.get("chains") or []:
            chain = str(item.get("baseChain") or item.get("displayName") or "")
            contracts.append((chain, str(item.get("contractAddress") or "")))
            gates.append(make_gate(chain, item.get("withdrawStatus"), item.get("depositStatus")))
        coin = _coin("htx", base, str(row.get("currency") or ""), prices, contracts, True, gates)
        if coin and (coin.quote or contracts):
            coins.append(coin)
    return coins


def known_exchanges() -> tuple[str, ...]:
    return tuple(sorted(CONTRACT_EXCHANGES | SYMBOL_EXCHANGES))
