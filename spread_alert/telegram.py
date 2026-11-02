"""Telegram alert formatting and delivery."""

from __future__ import annotations

import html
import logging

import aiohttp

from spread_alert.logic import EXCHANGE_NAMES, Opportunity, chain_label, transfer_lines

log = logging.getLogger(__name__)


def format_price(price: float) -> str:
    if price <= 0:
        return "$0"
    if price >= 1000:
        return f"${price:,.2f}"
    if price >= 1:
        text = f"{price:,.4f}".rstrip("0").rstrip(".")
        return f"${text}"
    text = f"{price:.12f}".rstrip("0").rstrip(".")
    if text in {"", "0"}:
        return f"${price:.6g}"
    return f"${text}"


def format_amount(amount: float) -> str:
    if amount >= 1_000_000_000:
        return f"{amount / 1_000_000_000:.2f}B"
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:.2f}M"
    if amount >= 1_000:
        return f"{amount / 1_000:.1f}K"
    if amount >= 1:
        return f"{amount:.2f}".rstrip("0").rstrip(".")
    text = f"{amount:.6f}".rstrip("0").rstrip(".")
    return text or "0"


def format_usd(amount: float) -> str:
    if amount >= 1_000_000_000:
        return f"${amount / 1_000_000_000:.2f}B"
    if amount >= 1_000_000:
        return f"${amount / 1_000_000:.2f}M"
    if amount >= 1_000:
        return f"${amount / 1_000:.1f}K"
    return f"${amount:.0f}"


def short_address(address: str) -> str:
    if len(address) <= 14:
        return address
    return f"{address[:6]}…{address[-4:]}"


def trade_url(exchange: str, base: str, pair: str) -> str | None:
    quote = pair.split("/")[-1]
    links = {
        "binance": f"https://www.binance.com/en/trade/{base}_{quote}",
        "gate": f"https://www.gate.io/trade/{base}_{quote}",
        "kucoin": f"https://www.kucoin.com/trade/{base}-{quote}",
        "bitget": f"https://www.bitget.com/spot/{base}{quote}",
        "htx": f"https://www.htx.com/trade/{base.lower()}_{quote.lower()}",
        "mexc": f"https://www.mexc.com/exchange/{base}_{quote}",
        "okx": f"https://www.okx.com/trade-spot/{base.lower()}-{quote.lower()}",
        "bybit": f"https://www.bybit.com/trade/spot/{base}/{quote}",
    }
    return links.get(exchange)


def _paint_notes(notes: list[str]) -> list[str]:
    """Telegram colors a diff block: lines starting with + are green, - are red."""
    painted: list[str] = []
    chunk: list[str] = []

    def flush() -> None:
        if not chunk:
            return
        body = "\n".join(chunk)
        painted.append(f'<pre><code class="language-diff">{body}</code></pre>')
        chunk.clear()

    for note in notes:
        safe = html.escape(note)
        if note.startswith("Chain DEX:") and "Cùng chain" in note:
            chunk.append(f"+ {safe}")
        elif note.startswith("Chain DEX:") and "Khác chain" in note:
            chunk.append(f"- {safe}")
        elif note.startswith(("Rút ", "Nạp ")) and "đang mở" in note:
            chunk.append(f"+ {safe}")
        elif note.startswith(("Rút ", "Nạp ")) and "đang khóa" in note:
            chunk.append(f"- {safe}")
        elif note.startswith(("Không nạp được", "Không rút được")):
            chunk.append(f"- {safe}")
        else:
            flush()
            painted.append(safe)
    flush()
    return painted


def format_opportunity(opp: Opportunity) -> str:
    venue = EXCHANGE_NAMES.get(opp.exchange, opp.exchange)
    dex = opp.dex.replace("_", " ").title()
    pool = chain_label(opp.chain)
    if opp.direction == "buy_cex":
        route = f"Mua {venue} → bán {dex} ({pool})"
        note = "CEX đang rẻ hơn"
    else:
        route = f"Mua {dex} ({pool}) → bán {venue}"
        note = "DEX đang rẻ hơn"
    lines = [
        f"<b>⚡ {html.escape(opp.base)}</b>  {opp.edge_pct:.2f}%",
        html.escape(route),
        html.escape(note),
        "",
        f"CEX: <b>{format_price(opp.cex_price)}</b>",
        f"DEX: <b>{format_price(opp.dex_price)}</b> ({html.escape(opp.dex_symbol)}/{html.escape(opp.quote_symbol)})",
        f"Liquidity DEX: {format_usd(opp.liquidity_usd)}",
    ]
    if opp.liquidity_base is not None or opp.liquidity_quote is not None:
        parts = []
        if opp.liquidity_base is not None:
            parts.append(f"{format_amount(opp.liquidity_base)} {html.escape(opp.dex_symbol)}")
        if opp.liquidity_quote is not None:
            parts.append(f"{format_amount(opp.liquidity_quote)} {html.escape(opp.quote_symbol)}")
        lines.append("Trong pool: " + " · ".join(parts))
    if opp.dex_volume_h24:
        lines.append(f"Vol DEX 24h: {format_usd(opp.dex_volume_h24)}")
    if opp.quote_volume:
        lines.append(f"Vol CEX 24h: {format_usd(opp.quote_volume)}")
    lines.extend(_paint_notes(transfer_lines(opp.exchange, opp.base, opp.direction, opp.chain, opp.gates)))
    lines.append(f"Hợp đồng: <code>{html.escape(short_address(opp.address))}</code>")
    links = []
    if opp.url:
        links.append(f'<a href="{html.escape(opp.url, quote=True)}">DexScreener</a>')
    venue_url = trade_url(opp.exchange, opp.base, opp.pair)
    if venue_url:
        links.append(f'<a href="{html.escape(venue_url, quote=True)}">{html.escape(venue)}</a>')
    if links:
        lines.append(" · ".join(links))
    return "\n".join(lines)


def format_startup(threshold: float, exchanges: tuple[str, ...]) -> str:
    names = ", ".join(EXCHANGE_NAMES.get(item, item) for item in exchanges)
    return (
        "<b>Đã bật theo dõi chênh lệch DEX / CEX</b>\n"
        f"Ngưỡng báo: {threshold:.2f}%\n"
        f"Sàn: {html.escape(names)}\n"
        "Mỗi vòng quét toàn bộ coin khớp hợp đồng, sát trần tốc độ DexScreener cho phép."
    )


def format_hidden(count: int, threshold: float) -> str:
    return f"Còn {count} cơ hội khác ≥ {threshold:.2f}% trong vòng quét này."


async def send_message(session: aiohttp.ClientSession, token: str, chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    async with session.post(url, json=payload) as response:
        body = await response.json(content_type=None)
        if response.status != 200 or not body.get("ok"):
            description = body.get("description") if isinstance(body, dict) else body
            raise RuntimeError(f"Telegram {response.status}: {description}")


async def send_alerts(
    session: aiohttp.ClientSession,
    token: str,
    chat_id: str,
    opportunities: list[Opportunity],
    hidden: int,
    threshold: float,
) -> None:
    for opportunity in opportunities:
        text = format_opportunity(opportunity)
        try:
            await send_message(session, token, chat_id, text)
        except Exception as exc:
            log.error("Không gửi được Telegram: %s", exc)
            log.info("Nội dung cảnh báo:\n%s", text)
    if hidden > 0:
        try:
            await send_message(session, token, chat_id, format_hidden(hidden, threshold))
        except Exception as exc:
            log.error("Không gửi được Telegram: %s", exc)
