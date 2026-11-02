"""Full scan loop: refresh CEX prices, batch DEX quotes, emit spreads."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace

import aiohttp

from spread_alert.cex import known_exchanges, load_coins, load_prices
from spread_alert.config import Config
from spread_alert.dex import DexClient
from spread_alert.logic import EXCHANGE_NAMES, Opportunity, best_opportunity, raw_spread_pct
from spread_alert.tax import lookup_tax, tax_line
from spread_alert.universe import assemble_markets

log = logging.getLogger(__name__)

SANITY_SYMBOLS = ("BTC", "ETH", "SOL")
SANITY_CHAIN = {"BTC": "ethereum", "ETH": "ethereum", "SOL": "solana"}


@dataclass(slots=True)
class ScanResult:
    markets: int
    pools: int
    dex_requests: int
    duration_sec: float
    alerts: list[Opportunity] = field(default_factory=list)
    hidden: int = 0
    leaders: list[Opportunity] = field(default_factory=list)
    sanity: list[str] = field(default_factory=list)
    chains: dict[str, int] = field(default_factory=dict)


class Scanner:
    def __init__(self, config: Config, session: aiohttp.ClientSession) -> None:
        self.config = config
        self.session = session
        self.dex = DexClient(
            session,
            per_sec=config.dex_requests_per_sec,
            batch_size=config.dex_batch_size,
            min_liquidity=config.min_dex_liquidity_usd,
        )
        self.markets = {}
        self.price_index = {}
        self.universe_at = 0.0
        self.cooldown: dict[tuple, tuple[float, float]] = {}

    async def scan(self, on_alert=None) -> ScanResult:
        started = time.monotonic()
        requests_before = self.dex.requests
        await self._ensure_universe()
        if not self.markets:
            return ScanResult(
                markets=0,
                pools=0,
                dex_requests=self.dex.requests - requests_before,
                duration_sec=time.monotonic() - started,
            )

        alerts: list[Opportunity] = []
        hidden = 0
        lock = asyncio.Lock()
        pending: asyncio.Queue[Opportunity | None] = asyncio.Queue()

        async def sender() -> None:
            while True:
                item = await pending.get()
                if item is None:
                    return
                original = item
                found = await lookup_tax(self.session, item.chain, item.address)
                if found is not None:
                    item = replace(
                        item,
                        buy_tax=found.buy,
                        sell_tax=found.sell,
                        transfer_tax=found.transfer,
                    )
                    async with lock:
                        for index, existing in enumerate(alerts):
                            if existing is original:
                                alerts[index] = item
                                break
                    shown = tax_line(item.buy_tax, item.sell_tax, item.transfer_tax)
                    if shown:
                        log.info("%s %s", item.base, shown)
                if on_alert is not None:
                    await on_alert(item)

        async def on_chunk(chunk: dict) -> None:
            nonlocal hidden
            for (chain, address), pool in chunk.items():
                market = self.markets.get((chain, address))
                if market is None:
                    continue
                opportunity = best_opportunity(
                    market.listings,
                    pool,
                    token_address=address,
                    chain=chain,
                    min_volume=self.config.min_cex_quote_volume_usd,
                    min_top_notional=self.config.min_top_notional_usd,
                    max_spread=self.config.max_spread_pct,
                )
                if opportunity is None or opportunity.edge_pct < self.config.spread_threshold_pct:
                    continue
                async with lock:
                    if not self._due(opportunity):
                        continue
                    extra_room = len(alerts) < self.config.max_alerts_per_scan
                    bigger = alerts and opportunity.edge_pct > min(item.edge_pct for item in alerts)
                    if not extra_room and (not bigger or len(alerts) >= self.config.max_alerts_per_scan + 5):
                        hidden += 1
                        continue
                    self._mark(opportunity)
                    alerts.append(opportunity)
                pending.put_nowait(opportunity)

        sender_task = asyncio.create_task(sender())
        refresh = asyncio.create_task(self._refresh_loop())
        pools: dict = {}
        try:
            groups: dict[str, dict[str, list]] = defaultdict(dict)
            for (chain, address), market in self.markets.items():
                groups[chain][address] = market.listings
            pools = await self.dex.fetch_pools(groups, on_chunk=on_chunk)
        except Exception:
            log.exception("Quét DEX lỗi")
        finally:
            refresh.cancel()
            try:
                await refresh
            except asyncio.CancelledError:
                pass
            pending.put_nowait(None)
            await sender_task

        found: list[Opportunity] = []
        for (chain, address), market in self.markets.items():
            pool = pools.get((chain, address))
            if pool is None:
                continue
            opportunity = best_opportunity(
                market.listings,
                pool,
                token_address=address,
                chain=chain,
                min_volume=self.config.min_cex_quote_volume_usd,
                min_top_notional=self.config.min_top_notional_usd,
                max_spread=self.config.max_spread_pct,
            )
            if opportunity is not None:
                found.append(opportunity)
        found.sort(key=lambda item: item.edge_pct, reverse=True)
        alerts.sort(key=lambda item: item.edge_pct, reverse=True)
        self._prune_cooldown()
        chain_counts = Counter(chain for chain, _address in self.markets)
        return ScanResult(
            markets=len(self.markets),
            pools=len(pools),
            dex_requests=self.dex.requests - requests_before,
            duration_sec=time.monotonic() - started,
            alerts=alerts,
            hidden=hidden,
            leaders=found[:15],
            sanity=sanity_lines(self.markets, pools),
            chains=dict(chain_counts),
        )

    async def _ensure_universe(self) -> None:
        if self.markets and time.monotonic() - self.universe_at < self.config.universe_refresh_sec:
            return
        enabled = [name for name in self.config.exchanges if name in set(known_exchanges())]
        unknown = [name for name in self.config.exchanges if name not in set(known_exchanges())]
        for name in unknown:
            log.warning("Sàn không hỗ trợ: %s", name)
        log.info("Đang tải hợp đồng và giá từ %s", ", ".join(enabled) or "(không có sàn)")
        loaded = await asyncio.gather(*(self._load_exchange(name) for name in enabled))
        coins = [coin for batch in loaded for coin in batch]
        markets, index, unmapped = assemble_markets(coins, self.config.chains)
        self.markets = markets
        self.price_index = index
        self.universe_at = time.monotonic()
        chain_counts = Counter(chain for chain, _address in markets)
        summary = ", ".join(f"{name} {count}" for name, count in chain_counts.most_common(8))
        log.info("Vũ trụ: %s hợp đồng trên %s chain (%s)", len(markets), len(chain_counts), summary or "trống")
        if unmapped:
            skipped = ", ".join(f"{name}:{count}" for name, count in unmapped.most_common(6))
            log.info("Bỏ qua chain chưa có trên DexScreener: %s", skipped)

    async def _load_exchange(self, exchange: str) -> list:
        try:
            coins = await load_coins(self.session, exchange, self.config.quotes)
        except Exception as exc:
            log.warning("Bỏ qua %s: %s", EXCHANGE_NAMES.get(exchange, exchange), exc)
            return []
        priced = sum(1 for coin in coins if coin.quote is not None)
        log.info("%s: %s coin, %s có giá %s", EXCHANGE_NAMES.get(exchange, exchange), len(coins), priced, "/".join(self.config.quotes))
        return coins

    async def _refresh_loop(self) -> None:
        while True:
            try:
                await self._refresh_prices()
            except Exception as exc:
                log.warning("Làm mới giá CEX lỗi: %s", exc)
            await asyncio.sleep(self.config.price_refresh_sec)

    async def _refresh_prices(self) -> None:
        exchanges = sorted({exchange for exchange, _base in self.price_index})

        async def one(exchange: str):
            try:
                return exchange, await load_prices(self.session, exchange, self.config.quotes)
            except Exception as exc:
                log.warning("Giá %s: %s", exchange, exc)
                return exchange, None

        results = await asyncio.gather(*(one(exchange) for exchange in exchanges))
        for exchange, prices in results:
            if not prices:
                continue
            for base, quote in prices.items():
                for listing in self.price_index.get((exchange, base), ()):
                    listing.last = quote.last
                    listing.bid = quote.bid
                    listing.ask = quote.ask
                    listing.quote_volume = quote.quote_volume
                    listing.top_notional = quote.top_notional

    def _due(self, opportunity: Opportunity) -> bool:
        key = (opportunity.exchange, opportunity.base, opportunity.chain, opportunity.address, opportunity.direction)
        previous = self.cooldown.get(key)
        if previous is None:
            return True
        sent_at, edge = previous
        if opportunity.edge_pct >= edge + self.config.realert_step_pct:
            return True
        return time.monotonic() - sent_at >= self.config.alert_cooldown_sec

    def _mark(self, opportunity: Opportunity) -> None:
        key = (opportunity.exchange, opportunity.base, opportunity.chain, opportunity.address, opportunity.direction)
        self.cooldown[key] = (time.monotonic(), opportunity.edge_pct)

    def _prune_cooldown(self) -> None:
        if len(self.cooldown) < 5000:
            return
        cutoff = time.monotonic() - max(self.config.alert_cooldown_sec * 4, 3600)
        self.cooldown = {key: value for key, value in self.cooldown.items() if value[0] >= cutoff}


def sanity_lines(markets: dict, pools: dict) -> list[str]:
    lines = []
    for symbol in SANITY_SYMBOLS:
        best = None
        preferred_chain = SANITY_CHAIN[symbol]
        for (chain, _address), market in markets.items():
            pool = pools.get((chain, _address))
            if pool is None:
                continue
            listing = next((item for item in market.listings if item.base == symbol), None)
            if listing is None:
                continue
            spread = raw_spread_pct(listing, pool)
            if spread is None:
                continue
            score = (chain == preferred_chain, pool.liquidity_usd)
            if best is None or score > best[0]:
                best = (score, listing, pool, spread, chain)
        if best is None:
            continue
        _score, listing, pool, spread, chain = best
        venue = EXCHANGE_NAMES.get(listing.exchange, listing.exchange)
        lines.append(
            f"Đối chiếu {symbol} {venue}/{chain}: CEX ${listing.last:,.4f} "
            f"DEX ${pool.price_usd:,.4f} lệch {spread:+.2f}% (thanh khoản ${pool.liquidity_usd:,.0f})"
        )
    return lines
