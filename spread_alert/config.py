"""Environment configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_env_file(path: Path | None = None) -> None:
    env_path = path or Path.cwd() / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return float(raw)


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _tuple(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


@dataclass(frozen=True, slots=True)
class Config:
    telegram_bot_token: str
    telegram_chat_id: str
    spread_threshold_pct: float = 5.0
    min_dex_liquidity_usd: float = 25_000
    min_cex_quote_volume_usd: float = 10_000
    min_top_notional_usd: float = 200
    max_spread_pct: float = 80
    alert_cooldown_sec: float = 900
    realert_step_pct: float = 2
    universe_refresh_sec: float = 600
    dex_requests_per_sec: float = 4.5
    dex_batch_size: int = 30
    quotes: tuple[str, ...] = ("USDT", "USDC")
    exchanges: tuple[str, ...] = (
        "binance",
        "gate",
        "kucoin",
        "bitget",
        "htx",
        "mexc",
        "okx",
        "bybit",
    )
    chains: frozenset[str] = frozenset()
    max_alerts_per_scan: int = 20
    startup_message: bool = True
    price_refresh_sec: float = 8
    request_timeout_sec: float = 45

    @property
    def telegram_ready(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)

    @classmethod
    def from_env(cls) -> "Config":
        chains = _tuple("CHAINS", ())
        return cls(
            telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID", "").strip(),
            spread_threshold_pct=_float("SPREAD_THRESHOLD_PCT", 5),
            min_dex_liquidity_usd=_float("MIN_DEX_LIQUIDITY_USD", 25_000),
            min_cex_quote_volume_usd=_float("MIN_CEX_QUOTE_VOLUME_USD", 10_000),
            min_top_notional_usd=_float("MIN_TOP_NOTIONAL_USD", 200),
            max_spread_pct=_float("MAX_SPREAD_PCT", 80),
            alert_cooldown_sec=_float("ALERT_COOLDOWN_SEC", 900),
            realert_step_pct=_float("REALERT_STEP_PCT", 2),
            universe_refresh_sec=_float("UNIVERSE_REFRESH_SEC", 600),
            dex_requests_per_sec=_float("DEX_REQUESTS_PER_SEC", 4.5),
            dex_batch_size=max(1, min(30, _int("DEX_BATCH_SIZE", 30))),
            quotes=tuple(part.upper() for part in _tuple("QUOTES", ("usdt", "usdc"))),
            exchanges=_tuple(
                "EXCHANGES",
                ("binance", "gate", "kucoin", "bitget", "htx", "mexc", "okx", "bybit"),
            ),
            chains=frozenset(chains),
            max_alerts_per_scan=max(1, _int("MAX_ALERTS_PER_SCAN", 20)),
            startup_message=_bool("SEND_STARTUP_MESSAGE", True),
            price_refresh_sec=_float("PRICE_REFRESH_SEC", 8),
            request_timeout_sec=_float("REQUEST_TIMEOUT_SEC", 45),
        )
