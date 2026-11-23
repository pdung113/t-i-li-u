"""Scan loop: refresh the coins that still need a price, then emit spreads."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path

import aiohttp

from spread_alert.cex import known_exchanges, kucoin_level1, load_coins, load_prices
from spread_alert.config import Config
from spread_alert.dex import DexClient
from spread_alert.logic import (
    EXCHANGE_NAMES,
    Listing,
    Market,
    Opportunity,
    best_opportunity,
    cex_spreads,
    coin_identity,
    normalize_address,
    raw_spread_pct,
    repriced,
    symbols_match,
)
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
    mode: str = "full"


class Scanner:
    def __init__(self, config: Config, session: aiohttp.ClientSession, seen_path: Path | None = None) -> None:
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
        self.full_scan_at = 0.0
        self.hot_scan_at = 0.0
        self.last_edge: dict[tuple[str, str], float] = {}
        self.seen_path = seen_path or Path.cwd() / ".alerted-coins.txt"
        self.seen_edges = self._load_seen()
        self.watch: dict[tuple, tuple[float, float, float]] = {}
        remembered = sum(1 for key in self.seen_edges if ":" not in key)
        if remembered:
            log.info(
                "Đã nhớ %s coin. Báo lại khi lệch tăng thêm %.1f%% và đã qua %.0f giây.",
                remembered,
                max(0.0, self.config.realert_step_pct),
                max(0.0, self.config.alert_cooldown_sec),
            )

    async def scan(self, on_alert=None) -> ScanResult:
        started = time.monotonic()
        requests_before = self.dex.requests
        full = self._needs_full_scan()
        await self._ensure_universe()
        if not self.markets:
            return ScanResult(
                markets=0,
                pools=0,
                dex_requests=self.dex.requests - requests_before,
                duration_sec=time.monotonic() - started,
            )

        if full:
            targets = dict(self.markets)
            self.full_scan_at = time.monotonic()
        else:
            targets = self._hot_markets()
            if not targets:
                log.info("Không có coin cần tính lại. Bỏ qua DexScreener và ticker.")
                return ScanResult(
                    markets=len(self.markets),
                    pools=0,
                    dex_requests=self.dex.requests - requests_before,
                    duration_sec=time.monotonic() - started,
                    mode="idle",
                )
            exchanges = sorted({listing.exchange for market in targets.values() for listing in market.listings})
            log.info(
                "Vòng rút gọn: %s/%s coin, giá %s",
                len(targets),
                len(self.markets),
                ", ".join(exchanges) or "(không sàn)",
            )
            await self._refresh_prices(exchanges)

        alerts: list[Opportunity] = []
        leaders: list[Opportunity] = []
        hidden = 0
        repeated = 0
        lock = asyncio.Lock()
        pending_queue: asyncio.Queue[Opportunity | None] = asyncio.Queue()
        still_fetching = set(targets)

        async def sender() -> None:
            nonlocal hidden, repeated
            while True:
                item = await pending_queue.get()
                if item is None:
                    return
                try:
                    checked = await self._confirm_before_send(item)
                    if checked is None:
                        continue
                    item = checked
                    async with lock:
                        if item.edge_pct < self.config.spread_threshold_pct:
                            continue
                        if not self._due(item):
                            repeated += 1
                            continue
                        extra_room = len(alerts) < self.config.max_alerts_per_scan
                        bigger = alerts and item.edge_pct > min(existing.edge_pct for existing in alerts)
                        if not extra_room and (not bigger or len(alerts) >= self.config.max_alerts_per_scan + 5):
                            hidden += 1
                            continue
                    delivered = await self._finish_alert(item, on_alert)
                    if delivered is not None:
                        alerts.append(delivered)
                except Exception:
                    log.exception("Bỏ tin %s vì lỗi, vòng quét vẫn chạy", item.base)

        async def _consider(opportunity: Opportunity) -> None:
            nonlocal repeated
            leaders.append(opportunity)
            if opportunity.edge_pct < self.config.spread_threshold_pct:
                self.watch.pop(self._watch_key(opportunity), None)
                return
            async with lock:
                if not self._due(opportunity):
                    repeated += 1
                    return
                if not self._price_confirmed(opportunity):
                    return
            pending_queue.put_nowait(opportunity)

        async def on_chunk(chunk: dict) -> None:
            for (chain, address), pool in chunk.items():
                still_fetching.discard((chain, address))
                try:
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
                    self.last_edge[(chain, address)] = opportunity.edge_pct if opportunity is not None else 0.0
                    if opportunity is not None:
                        await _consider(opportunity)
                except Exception:
                    log.exception("Bỏ %s trên %s vì lỗi tính lệch", address, chain)

        async def _emit_cex() -> None:
            spreads = cex_spreads(
                targets,
                min_volume=self.config.min_cex_quote_volume_usd,
                min_top_notional=self.config.min_top_notional_usd,
                max_spread=self.config.max_spread_pct,
            )
            best_cex: dict[tuple[str, str], float] = {}
            for opportunity in spreads:
                key = (opportunity.chain, opportunity.address)
                best_cex[key] = max(best_cex.get(key, 0.0), opportunity.edge_pct)
                await _consider(opportunity)
            for key, edge in best_cex.items():
                self.last_edge[key] = max(self.last_edge.get(key, 0.0), edge)

        sender_task = asyncio.create_task(sender())
        refresh = None
        if full and self.config.price_refresh_sec > 0:
            refresh = asyncio.create_task(self._refresh_pending_once(still_fetching))
        pools: dict = {}
        try:
            groups: dict[str, dict[str, list]] = defaultdict(dict)
            for (chain, address), market in targets.items():
                groups[chain][address] = market.listings
            async def on_batch(chain: str, addresses: list[str]) -> None:
                for address in addresses:
                    still_fetching.discard((chain, address))

            pools = await self.dex.fetch_pools(groups, on_chunk=on_chunk, on_batch=on_batch)
        except Exception:
            log.exception("Quét DEX lỗi")
        finally:
            if refresh is not None:
                refresh.cancel()
                try:
                    await refresh
                except asyncio.CancelledError:
                    pass
            if full:
                for key in targets:
                    if key in pools or key in still_fetching:
                        continue
                    self.last_edge[key] = 0.0
            try:
                await _emit_cex()
            except Exception:
                log.exception("Quét chênh lệch giữa các sàn CEX lỗi")
            pending_queue.put_nowait(None)
            try:
                await sender_task
            except Exception:
                log.exception("Hàng gửi tin bị lỗi, vòng này vẫn kết thúc")
            self.hot_scan_at = time.monotonic()

        leaders.sort(key=lambda item: item.edge_pct, reverse=True)
        alerts.sort(key=lambda item: item.edge_pct, reverse=True)
        if repeated:
            log.info("Bỏ %s coin đã báo ở vòng trước", repeated)
        chain_counts = Counter(chain for chain, _address in self.markets)
        return ScanResult(
            markets=len(self.markets),
            pools=len(pools),
            dex_requests=self.dex.requests - requests_before,
            duration_sec=time.monotonic() - started,
            alerts=alerts,
            hidden=hidden,
            leaders=leaders[:15],
            sanity=sanity_lines(self.markets, pools),
            chains=dict(chain_counts),
            mode="full" if full else "light",
        )

    def _needs_full_scan(self) -> bool:
        if self.full_scan_at <= 0:
            return True
        return time.monotonic() - self.full_scan_at >= self.config.universe_refresh_sec

    def _near_floor(self) -> float:
        return max(0.0, self.config.spread_threshold_pct - max(0.0, self.config.realert_step_pct))

    def _hot_markets(self) -> dict:
        """Coins close to the threshold, or waiting to confirm. Quiet coins stay out."""
        floor = self._near_floor()
        watched = {
            (chain, address)
            for _exchange, _sell, _base, chain, address, _direction in self.watch
        }
        return {
            key: market
            for key, market in self.markets.items()
            if key in watched or self.last_edge.get(key, 0.0) >= floor
        }

    def seconds_until_next_scan(self) -> float:
        """How long to wait before the next pass. Quiet universes wait for a full scan."""
        now = time.monotonic()
        if self.full_scan_at <= 0 or now - self.full_scan_at >= self.config.universe_refresh_sec:
            return 0.0
        until_full = self.config.universe_refresh_sec - (now - self.full_scan_at)
        if not self._hot_markets():
            return until_full
        if self.config.price_refresh_sec <= 0:
            return 0.0
        since = now - self.hot_scan_at if self.hot_scan_at else self.config.price_refresh_sec
        until_hot = max(0.0, self.config.price_refresh_sec - since)
        return min(until_full, until_hot)

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
        self.last_edge = {}
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

    async def _refresh_pending_once(self, pending: set[tuple[str, str]]) -> None:
        """One ticker refresh for exchanges that still have tokens left in this full scan."""
        await asyncio.sleep(self.config.price_refresh_sec)
        try:
            exchanges: set[str] = set()
            for key in list(pending):
                market = self.markets.get(key)
                if market is None:
                    continue
                for listing in market.listings:
                    exchanges.add(listing.exchange)
            if not exchanges:
                return
            log.info("Làm mới giá %s sàn còn token chưa quét", len(exchanges))
            await self._refresh_prices(sorted(exchanges))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Làm mới giá CEX lỗi: %s", exc)

    async def _refresh_prices(self, exchanges: list[str] | None = None) -> None:
        if exchanges is None:
            exchanges = sorted({exchange for exchange, _base in self.price_index})
        if not exchanges:
            return

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
                    listing.bid_notional = quote.bid_notional
                    listing.ask_notional = quote.ask_notional
                    listing.low = quote.low
                    listing.high = quote.high

    def _watch_key(self, opportunity: Opportunity) -> tuple:
        return (
            opportunity.exchange,
            opportunity.sell_exchange,
            opportunity.base,
            opportunity.chain,
            opportunity.address,
            opportunity.direction,
        )

    async def _kucoin_still_open(self, opportunity: Opportunity) -> Opportunity | None:
        """Return the alert with KuCoin's fresh last trade, or None to skip it.

        allTickers sometimes prints a tiny ask that the page never traded.
        CEX-CEX routes are rechecked in _confirm_before_send, which also reads
        a KuCoin sell leg.
        """
        if opportunity.exchange != "kucoin" or opportunity.direction == "cex_cex":
            return opportunity
        if self.session is None:
            return None
        symbol = opportunity.pair.replace("/", "-")
        try:
            fresh = await kucoin_level1(self.session, symbol)
        except Exception as exc:
            log.warning("KuCoin %s: không đối lại được giá, bỏ tin (%s)", opportunity.base, exc)
            return None
        if fresh is None:
            return None
        matched, divisor = symbols_match(opportunity.base, opportunity.dex_symbol)
        if not matched or divisor <= 0:
            return None
        last = fresh.last / divisor
        bid = fresh.bid / divisor if fresh.bid and fresh.bid > 0 else None
        ask = fresh.ask / divisor if fresh.ask and fresh.ask > 0 else None
        priced = repriced(
            opportunity.direction,
            last,
            bid,
            ask,
            opportunity.dex_price,
            bid_notional=fresh.bid_notional,
            ask_notional=fresh.ask_notional,
            min_notional=self.config.min_top_notional_usd,
        )
        if priced is None or priced[0] < self.config.spread_threshold_pct:
            return None
        edge, price = priced
        return replace(opportunity, edge_pct=edge, cex_price=price)

    async def _confirm_before_send(self, opportunity: Opportunity) -> Opportunity | None:
        """Re-read the DEX pool, and every KuCoin leg, before a Telegram send."""
        if opportunity.direction == "cex_cex":
            return await self._recheck_cex(opportunity)
        return await self._recheck_dex(opportunity)

    async def _apply_kucoin(self, listing: Listing) -> bool:
        if listing.exchange != "kucoin":
            return True
        if self.session is None:
            log.warning("KuCoin %s: không có phiên để đối soát, bỏ tin", listing.base)
            return False
        symbol = listing.pair.replace("/", "-")
        try:
            fresh = await kucoin_level1(self.session, symbol)
        except Exception as exc:
            log.warning("KuCoin %s: không đối lại được giá, bỏ tin (%s)", listing.base, exc)
            return False
        if fresh is None or fresh.last <= 0:
            log.warning("KuCoin %s: level1 không có giá khớp, bỏ tin", listing.base)
            return False
        listing.last = fresh.last
        listing.bid = fresh.bid
        listing.ask = fresh.ask
        listing.bid_notional = fresh.bid_notional
        listing.ask_notional = fresh.ask_notional
        return True

    def _find_listing(self, exchange: str, base: str, chain: str, address: str) -> Listing | None:
        market = self.markets.get((chain, address))
        if market is None:
            wanted = address.lower()
            for (chain_id, addr), candidate in self.markets.items():
                if chain_id == chain and addr.lower() == wanted:
                    market = candidate
                    break
        if market is None:
            return None
        for listing in market.listings:
            if listing.exchange != exchange:
                continue
            if listing.base == base or symbols_match(listing.base, base)[0]:
                return listing
        return None

    def _edge_still_close(self, previous: float, current: float) -> bool:
        if previous <= 0 or current <= 0:
            return False
        return abs(current - previous) / previous <= 0.03

    async def _recheck_cex(self, opportunity: Opportunity) -> Opportunity | None:
        buy = self._find_listing(opportunity.exchange, opportunity.base, opportunity.chain, opportunity.address)
        sell_symbol = opportunity.dex_symbol or opportunity.base
        sell = self._find_listing(opportunity.sell_exchange, sell_symbol, opportunity.chain, opportunity.address)
        if buy is None or sell is None:
            log.warning("Không còn listing %s để đối soát, bỏ tin", opportunity.base)
            return None
        if not await self._apply_kucoin(buy):
            return None
        if sell is not buy and not await self._apply_kucoin(sell):
            return None
        spreads = cex_spreads(
            {
                (opportunity.chain, opportunity.address): Market(
                    chain=opportunity.chain,
                    address=opportunity.address,
                    listings=[buy, sell],
                )
            },
            min_volume=self.config.min_cex_quote_volume_usd,
            min_top_notional=self.config.min_top_notional_usd,
            max_spread=self.config.max_spread_pct,
        )
        rebuilt = next(
            (
                item
                for item in spreads
                if item.exchange == opportunity.exchange and item.sell_exchange == opportunity.sell_exchange
            ),
            None,
        )
        if rebuilt is None or rebuilt.edge_pct < self.config.spread_threshold_pct:
            return None
        if not self._edge_still_close(opportunity.cex_price, rebuilt.cex_price):
            return None
        if not self._edge_still_close(opportunity.dex_price, rebuilt.dex_price):
            return None
        return rebuilt

    async def _recheck_dex(self, opportunity: Opportunity) -> Opportunity | None:
        listing = self._find_listing(opportunity.exchange, opportunity.base, opportunity.chain, opportunity.address)
        if listing is None:
            log.warning("Không còn listing %s để đối soát, bỏ tin", opportunity.base)
            return None
        if not await self._apply_kucoin(listing):
            return None
        market = self.markets.get((opportunity.chain, opportunity.address))
        listings = market.listings if market is not None else [listing]
        pool = await self.dex.fetch_one(opportunity.chain, opportunity.address, listings)
        if pool is None:
            log.warning("Không đọc lại được pool %s trên %s, bỏ tin", opportunity.base, opportunity.chain)
            return None
        rebuilt = best_opportunity(
            [listing],
            pool,
            token_address=opportunity.address,
            chain=opportunity.chain,
            min_volume=self.config.min_cex_quote_volume_usd,
            min_top_notional=self.config.min_top_notional_usd,
            max_spread=self.config.max_spread_pct,
        )
        if rebuilt is None or rebuilt.edge_pct < self.config.spread_threshold_pct:
            return None
        if rebuilt.direction != opportunity.direction:
            return None
        if not self._edge_still_close(opportunity.cex_price, rebuilt.cex_price):
            return None
        return rebuilt

    async def _attach_tax(self, item: Opportunity) -> Opportunity:
        if self.session is None:
            return item
        found = await lookup_tax(self.session, item.chain, item.address)
        if found is None:
            return item
        item = replace(
            item,
            buy_tax=found.buy,
            sell_tax=found.sell,
            transfer_tax=found.transfer,
        )
        shown = tax_line(item.buy_tax, item.sell_tax, item.transfer_tax)
        if shown:
            log.info("%s %s", item.base, shown)
        return item

    async def _finish_alert(self, item: Opportunity, on_alert) -> Opportunity | None:
        """Remember the coin only after the alert is actually delivered."""
        item = await self._attach_tax(item)
        if on_alert is None:
            return None
        try:
            delivered = await on_alert(item)
        except Exception:
            log.exception("Chưa gửi được %s, không ghi file đã báo", item.base)
            return None
        if not delivered:
            log.warning("Chưa gửi được %s %.2f%%, không ghi file đã báo", item.base, item.edge_pct)
            return None
        self._mark(item)
        return item

    def _price_confirmed(self, opportunity: Opportunity) -> bool:
        """Send only after the spread is still there one refresh interval later.

        A shorter scan must not move the clock. The first sighting keeps its
        timestamp until the interval has elapsed.
        """
        key = self._watch_key(opportunity)
        now = time.monotonic()
        previous = self.watch.get(key)
        if previous is None:
            self.watch[key] = (opportunity.edge_pct, opportunity.cex_price, now)
            return False
        prev_edge, prev_px, seen_at = previous
        if now - seen_at < self.config.price_refresh_sec:
            return False
        moved = prev_px <= 0 or abs(opportunity.cex_price - prev_px) / prev_px > 0.03
        self.watch[key] = (opportunity.edge_pct, opportunity.cex_price, now)
        if prev_edge < self.config.spread_threshold_pct or moved:
            return False
        return True

    def _coin_keys(self, opportunity: Opportunity) -> set[str]:
        keys = set()
        for symbol in (opportunity.base, opportunity.dex_symbol):
            name = coin_identity(symbol)
            if name:
                keys.add(name)
        if opportunity.address:
            keys.add(f"{opportunity.chain}:{normalize_address(opportunity.address)}")
        return keys

    def _due(self, opportunity: Opportunity) -> bool:
        """Alert again only after the step and the cooldown have both passed.

        The same spread stays quiet, including after a restart. A failed send
        does not call this path's writer, so the coin is not burned.
        """
        keys = self._coin_keys(opportunity)
        if not keys:
            return True
        known = [self.seen_edges[key] for key in keys if key in self.seen_edges]
        if not known:
            return True
        last_edge = max(edge for edge, _seen_at in known)
        last_at = max(seen_at for _edge, seen_at in known)
        step = max(0.0, self.config.realert_step_pct)
        if opportunity.edge_pct + 1e-6 < last_edge + step:
            return False
        cooldown = max(0.0, self.config.alert_cooldown_sec)
        if cooldown > 0 and time.time() - last_at < cooldown:
            return False
        return True

    def _mark(self, opportunity: Opportunity) -> None:
        edge = opportunity.edge_pct
        now = time.time()
        for key in self._coin_keys(opportunity):
            current = self.seen_edges.get(key)
            if current is None:
                self.seen_edges[key] = (edge, now)
            else:
                self.seen_edges[key] = (max(current[0], edge), now)
        self._save_seen()

    def _save_seen(self) -> None:
        try:
            self.seen_path.parent.mkdir(parents=True, exist_ok=True)
            lines = [
                f"{key} {edge:.4f} {seen_at:.0f}"
                for key, (edge, seen_at) in sorted(self.seen_edges.items())
            ]
            self.seen_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        except OSError as exc:
            log.warning("Không lưu được danh sách coin đã báo: %s", exc)

    def _load_seen(self) -> dict[str, tuple[float, float]]:
        if not self.seen_path.is_file():
            return {}
        try:
            text = self.seen_path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("Không đọc được danh sách coin đã báo: %s", exc)
            return {}
        found: dict[str, tuple[float, float]] = {}
        for line in text.splitlines():
            parts = line.split()
            if not parts:
                continue
            key = parts[0]
            if len(parts) >= 2:
                try:
                    edge = float(parts[1])
                except ValueError:
                    edge = self.config.spread_threshold_pct
            else:
                # Older files stored only the name. Treat that as an alert at the threshold.
                edge = self.config.spread_threshold_pct
            seen_at = 0.0
            if len(parts) >= 3:
                try:
                    seen_at = float(parts[2])
                except ValueError:
                    seen_at = 0.0
            previous = found.get(key)
            if previous is None or edge > previous[0] or (edge == previous[0] and seen_at > previous[1]):
                found[key] = (edge, seen_at)
        return found


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
