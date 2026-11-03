"""DexScreener batch quotes, paced under the public rate limit."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterable

import aiohttp

from spread_alert.logic import Listing, Pool, pick_pool

log = logging.getLogger(__name__)

DEX_URL = "https://api.dexscreener.com/tokens/v1/{chain}/{addresses}"


class Pace:
    """Space request start times so a full scan stays at the configured rate."""

    def __init__(self, per_sec: float) -> None:
        self.interval = 1.0 / per_sec if per_sec > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def wait(self) -> None:
        if self.interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            slot = self._next if self._next > now else now
            self._next = slot + self.interval
            delay = slot - now
        if delay > 0:
            await asyncio.sleep(delay)


class DexClient:
    def __init__(self, session: aiohttp.ClientSession, per_sec: float, batch_size: int, min_liquidity: float) -> None:
        self.session = session
        self.pace = Pace(per_sec)
        self.batch_size = max(1, min(30, batch_size))
        self.min_liquidity = min_liquidity
        self.blocked_chains: set[str] = set()
        self._pause_until = 0.0
        self.requests = 0

    async def fetch_pools(
        self,
        groups: dict[str, dict[str, list[Listing]]],
        on_chunk: Callable[[dict[tuple[str, str], Pool]], Awaitable[None]] | None = None,
    ) -> dict[tuple[str, str], Pool]:
        """Fetch the deepest eligible pool for every (chain, address)."""
        batches: list[tuple[str, list[str]]] = []
        for chain, by_address in groups.items():
            if chain in self.blocked_chains:
                continue
            addresses = list(by_address)
            for index in range(0, len(addresses), self.batch_size):
                batches.append((chain, addresses[index : index + self.batch_size]))
        found: dict[tuple[str, str], Pool] = {}
        if not batches:
            return found
        queue: asyncio.Queue[tuple[str, list[str]] | None] = asyncio.Queue()
        for batch in batches:
            queue.put_nowait(batch)
        workers = min(8, len(batches))
        for _ in range(workers):
            queue.put_nowait(None)
        done = 0
        started = time.monotonic()
        total = len(batches)

        async def worker() -> None:
            nonlocal done
            while True:
                item = await queue.get()
                if item is None:
                    return
                chain, addresses = item
                chunk: dict[tuple[str, str], Pool] = {}
                if chain not in self.blocked_chains:
                    pairs = await self._fetch(chain, addresses)
                    by_address = groups[chain]
                    for address in addresses:
                        pool = pick_pool(pairs, address, by_address.get(address, []), self.min_liquidity)
                        if pool is not None:
                            found[(chain, address)] = pool
                            chunk[(chain, address)] = pool
                if chunk and on_chunk is not None:
                    await on_chunk(chunk)
                done += 1
                if done == total or done % 25 == 0:
                    log.info(
                        "DEX %s/%s lô, %s pool, %.0fs",
                        done,
                        total,
                        len(found),
                        time.monotonic() - started,
                    )

        await asyncio.gather(*(worker() for _ in range(workers)))
        return found

    async def _fetch(self, chain: str, addresses: Iterable[str]) -> list[dict]:
        joined = ",".join(addresses)
        url = DEX_URL.format(chain=chain, addresses=joined)
        for attempt in range(3):
            await self._wait_pause()
            await self.pace.wait()
            self.requests += 1
            try:
                async with self.session.get(url) as response:
                    if response.status == 400:
                        log.debug("DEX 400 trên %s, bỏ lô này", chain)
                        return []
                    if response.status == 404:
                        self.blocked_chains.add(chain)
                        log.warning("Bỏ chain %s vì DexScreener trả 404", chain)
                        return []
                    if response.status == 429:
                        retry = _retry_after(response.headers.get("Retry-After"))
                        self._pause_until = max(self._pause_until, time.monotonic() + retry)
                        log.warning("DexScreener 429, tạm dừng %.0fs", retry)
                        continue
                    if response.status >= 500:
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue
                    response.raise_for_status()
                    payload = await response.json(content_type=None)
                    return payload if isinstance(payload, list) else []
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                log.debug("DEX %s lỗi lần %s: %s", chain, attempt + 1, exc)
                await asyncio.sleep(1.0 * (attempt + 1))
        log.warning("Bỏ một lô %s (%s token) sau khi thử lại", chain, len(joined.split(",")))
        return []

    async def _wait_pause(self) -> None:
        delay = self._pause_until - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)


def _retry_after(header: str | None) -> float:
    if not header:
        return 20.0
    try:
        return max(1.0, float(header))
    except ValueError:
        return 20.0
