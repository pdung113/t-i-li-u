"""Token buy, sell, and transfer tax from the public GoPlus security API.

DexScreener does not publish a tax. This lookup runs only for an alert, and a
missing or zero tax stays off the message.
"""

from __future__ import annotations

from dataclasses import dataclass

import aiohttp

# GoPlus chain id. Solana uses a separate path.
_CHAIN_IDS = {
    "ethereum": "1",
    "bsc": "56",
    "polygon": "137",
    "arbitrum": "42161",
    "optimism": "10",
    "base": "8453",
    "avalanche": "43114",
    "linea": "59144",
    "scroll": "534352",
    "zksync": "324",
    "blast": "81457",
    "mantle": "5000",
    "tron": "tron",
}

_MIN_SHOWN_PCT = 0.05


@dataclass(frozen=True, slots=True)
class TokenTax:
    buy: float | None = None
    sell: float | None = None
    transfer: float | None = None


def percent_from_fraction(value: object) -> float | None:
    """GoPlus EVM tax is a fraction: 0.1 means 10%, 1 means 100%."""
    number = _float(value)
    if number is None or number < 0:
        return None
    if number <= 1:
        return number * 100.0
    return number


def percent_from_fee_rate(value: object) -> float | None:
    """Solana transfer fee_rate is parts per 10_000: 200 means 2%."""
    number = _float(value)
    if number is None or number < 0:
        return None
    return number / 100.0


def tax_from_payload(payload: object, address: str, chain: str) -> TokenTax | None:
    if not isinstance(payload, dict):
        return None
    if payload.get("code") not in (1, "1", None):
        return None
    row = _match_row(payload.get("result"), address)
    if row is None:
        return TokenTax()
    if chain == "solana":
        fee = ((row.get("transfer_fee") or {}).get("current_fee_rate") or {}).get("fee_rate")
        return TokenTax(transfer=percent_from_fee_rate(fee))
    return TokenTax(
        buy=percent_from_fraction(row.get("buy_tax")),
        sell=percent_from_fraction(row.get("sell_tax")),
        transfer=percent_from_fraction(row.get("transfer_tax")),
    )


def tax_line(buy: float | None, sell: float | None, transfer: float | None) -> str | None:
    parts: list[str] = []
    if _shown(buy):
        parts.append(f"mua {_pct(buy)}")
    if _shown(sell):
        parts.append(f"bán {_pct(sell)}")
    if _shown(transfer):
        parts.append(f"chuyển {_pct(transfer)}")
    if not parts:
        return None
    return "Tax DEX: " + " · ".join(parts)


async def lookup_tax(session: aiohttp.ClientSession, chain: str, address: str) -> TokenTax | None:
    url, params = _request(chain, address)
    if url is None:
        return None
    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with session.get(url, params=params, timeout=timeout) as response:
            if response.status != 200:
                return None
            payload = await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return None
    return tax_from_payload(payload, address, chain)


def _request(chain: str, address: str) -> tuple[str | None, dict[str, str]]:
    if chain == "solana":
        return (
            "https://api.gopluslabs.io/api/v1/solana/token_security",
            {"contract_addresses": address},
        )
    chain_id = _CHAIN_IDS.get(chain)
    if chain_id is None or not address:
        return None, {}
    return (
        f"https://api.gopluslabs.io/api/v1/token_security/{chain_id}",
        {"contract_addresses": address},
    )


def _match_row(result: object, address: str) -> dict | None:
    if not isinstance(result, dict) or not result:
        return None
    wanted = address.lower()
    for key, value in result.items():
        if str(key).lower() == wanted and isinstance(value, dict):
            return value
    if len(result) == 1:
        value = next(iter(result.values()))
        return value if isinstance(value, dict) else None
    return None


def _float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _shown(value: float | None) -> bool:
    return value is not None and value >= _MIN_SHOWN_PCT


def _pct(value: float | None) -> str:
    rounded = round(value or 0, 1)
    if abs(rounded - round(rounded)) < 0.05:
        return f"{int(round(rounded))}%"
    return f"{rounded:.1f}%"
