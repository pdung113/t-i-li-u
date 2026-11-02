"""Run the DEX/CEX spread watcher.

    python -m spread_alert
    python -m spread_alert --once
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone

import aiohttp

from spread_alert.config import Config, load_env_file
from spread_alert.logic import EXCHANGE_NAMES
from spread_alert.scanner import Scanner
from spread_alert.telegram import format_hidden, format_opportunity, format_price, format_startup, send_message

BKK = timezone(timedelta(hours=7))


class BangkokFormatter(logging.Formatter):
    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        moment = datetime.fromtimestamp(record.created, BKK)
        return moment.strftime(datefmt or "%Y-%m-%d %H:%M:%S")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Theo dõi chênh lệch giá DEX và CEX, báo Telegram.")
    parser.add_argument("--once", action="store_true", help="Quét một vòng rồi thoát")
    parser.add_argument("--top", type=int, default=15, help="Số cơ hội in ra ở chế độ --once")
    return parser


def _setup_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(BangkokFormatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)


def _log_result(result, config: Config, top: int, once: bool) -> None:
    logging.info(
        "Vòng quét %.1fs | %s hợp đồng | %s pool | %s request DEX | %s cảnh báo",
        result.duration_sec,
        result.markets,
        result.pools,
        result.dex_requests,
        len(result.alerts),
    )
    for line in result.sanity:
        logging.info(line)
    rows = result.leaders if once else result.alerts
    for opportunity in rows[:top]:
        venue = EXCHANGE_NAMES.get(opportunity.exchange, opportunity.exchange)
        if opportunity.direction == "cex_cex":
            sell = EXCHANGE_NAMES.get(opportunity.sell_exchange, opportunity.sell_exchange)
            logging.info(
                "%6.2f%%  %-8s mua %-12s %s  bán %-12s %s  %s",
                opportunity.edge_pct,
                opportunity.base,
                venue,
                format_price(opportunity.cex_price),
                sell,
                format_price(opportunity.dex_price),
                opportunity.chain,
            )
        else:
            side = "CEX rẻ" if opportunity.direction == "buy_cex" else "DEX rẻ"
            logging.info(
                "%6.2f%%  %-8s %-12s %-10s %-8s CEX %s  DEX %s  liq $%.0f",
                opportunity.edge_pct,
                opportunity.base,
                venue,
                opportunity.chain,
                side,
                format_price(opportunity.cex_price),
                format_price(opportunity.dex_price),
                opportunity.liquidity_usd,
            )
    if not once and not result.alerts and result.leaders:
        leader = result.leaders[0]
        logging.info(
            "Chưa có lệnh >= %.2f%%. Lệch cao nhất %s %.2f%%",
            config.spread_threshold_pct,
            leader.base,
            leader.edge_pct,
        )


async def _async_main(once: bool, top: int) -> None:
    load_env_file()
    config = Config.from_env()
    if config.dex_requests_per_sec > 5:
        logging.warning(
            "DEX_REQUESTS_PER_SEC=%.2f vượt khoảng 5 request/giây của DexScreener và dễ bị 429.",
            config.dex_requests_per_sec,
        )
    if not config.telegram_ready:
        logging.warning("Chưa có TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Cảnh báo chỉ ghi ra log.")

    timeout = aiohttp.ClientTimeout(total=config.request_timeout_sec)
    connector = aiohttp.TCPConnector(limit=40, ttl_dns_cache=300)
    headers = {"User-Agent": "dex-cex-spread/1.0", "Accept": "application/json"}
    async with aiohttp.ClientSession(timeout=timeout, connector=connector, headers=headers) as session:
        scanner = Scanner(config, session)
        if config.telegram_ready and config.startup_message and not once:
            try:
                await send_message(
                    session,
                    config.telegram_bot_token,
                    config.telegram_chat_id,
                    format_startup(config.spread_threshold_pct, config.exchanges),
                )
            except Exception as exc:
                logging.error("Không gửi được tin nhắn khởi động: %s", exc)

        async def on_alert(opportunity) -> None:
            text = format_opportunity(opportunity)
            logging.info(
                "Cảnh báo %s %.2f%% trên %s",
                opportunity.base,
                opportunity.edge_pct,
                EXCHANGE_NAMES.get(opportunity.exchange, opportunity.exchange),
            )
            if config.telegram_ready:
                try:
                    await send_message(session, config.telegram_bot_token, config.telegram_chat_id, text)
                except Exception as exc:
                    logging.error("Không gửi được Telegram: %s", exc)
                    logging.info("Nội dung cảnh báo:\n%s", text)

        while True:
            try:
                result = await scanner.scan(on_alert=on_alert)
            except Exception:
                logging.exception("Vòng quét lỗi")
                if once:
                    raise
                await asyncio.sleep(5)
                continue
            _log_result(result, config, top=top, once=once)
            if result.hidden and config.telegram_ready:
                try:
                    await send_message(
                        session,
                        config.telegram_bot_token,
                        config.telegram_chat_id,
                        format_hidden(result.hidden, config.spread_threshold_pct),
                    )
                except Exception as exc:
                    logging.error("Không gửi được Telegram: %s", exc)
            if once:
                return
            if result.markets == 0:
                await asyncio.sleep(15)


def main() -> None:
    _setup_logging()
    args = _parser().parse_args()
    try:
        asyncio.run(_async_main(args.once, args.top))
    except KeyboardInterrupt:
        logging.info("Đã dừng.")


if __name__ == "__main__":
    main()
