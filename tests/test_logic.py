import unittest
from dataclasses import replace

from spread_alert.cex import ListedCoin, PriceQuote, _prices_binance, _prices_gate
from spread_alert.logic import (
    ChainGate,
    Listing,
    Pool,
    anchor_indexes,
    best_opportunity,
    chain_id,
    clean_address,
    is_ignored_asset,
    pick_pool,
    symbols_match,
    transfer_lines,
)
from spread_alert.tax import percent_from_fee_rate, percent_from_fraction, tax_from_payload, tax_line
from spread_alert.telegram import format_opportunity, format_price
from spread_alert.universe import assemble_markets


def _quote(last: float, bid: float | None = None, ask: float | None = None, volume: float | None = 100_000) -> PriceQuote:
    return PriceQuote(pair="X/USDT", quote="USDT", last=last, bid=bid, ask=ask, quote_volume=volume)


def _listing(exchange: str, base: str, last: float, bid=None, ask=None, volume=100_000, top=None) -> Listing:
    return Listing(
        exchange=exchange,
        base=base,
        pair=f"{base}/USDT",
        quote="USDT",
        last=last,
        bid=bid,
        ask=ask,
        quote_volume=volume,
        top_notional=top,
    )


def _pool(**overrides) -> Pool:
    data = dict(
        chain="ethereum",
        dex="uniswap",
        url="https://dexscreener.com/ethereum/abc",
        base_symbol="PEPE",
        quote_symbol="WETH",
        price_usd=1.05,
        liquidity_usd=80_000,
    )
    data.update(overrides)
    return Pool(**data)


class LogicTest(unittest.TestCase):
    def test_chain_aliases(self):
        self.assertEqual(chain_id("ETH"), "ethereum")
        self.assertEqual(chain_id("BEP20"), "bsc")
        self.assertEqual(chain_id("ARBEVM"), "arbitrum")
        self.assertEqual(chain_id("AVAXC-Chain"), "avalanche")
        self.assertEqual(chain_id("BASEEVM"), "base")
        self.assertIsNone(chain_id("BTC"))
        self.assertIsNone(chain_id(""))

    def test_addresses(self):
        self.assertIsNone(clean_address("0x0000000000000000000000000000000000000000"))
        self.assertIsNone(clean_address("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"))
        self.assertEqual(clean_address("0xABC"), None)
        self.assertEqual(
            clean_address("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        )
        sol = "So11111111111111111111111111111111111111112"
        self.assertEqual(clean_address(sol), sol)

    def test_symbol_match(self):
        self.assertEqual(symbols_match("PEPE", "PEPE"), (True, 1.0))
        self.assertEqual(symbols_match("ETH", "WETH"), (True, 1.0))
        self.assertEqual(symbols_match("1000PEPE", "PEPE"), (True, 1000.0))
        self.assertEqual(symbols_match("PEPE", "1000PEPE")[0], True)
        self.assertAlmostEqual(symbols_match("PEPE", "1000PEPE")[1], 0.001)
        self.assertEqual(symbols_match("JUP", "JUP"), (True, 1.0))
        self.assertFalse(symbols_match("IN", "WIN")[0])
        self.assertFalse(symbols_match("PEPE", "DOGE")[0])

    def test_ignored_assets(self):
        self.assertTrue(is_ignored_asset("USDT"))
        self.assertTrue(is_ignored_asset("BTC3L"))
        self.assertTrue(is_ignored_asset("ETH", "ETH 3x Leveraged"))
        self.assertFalse(is_ignored_asset("JUP", "Jupiter"))
        self.assertFalse(is_ignored_asset("BTC"))

    def test_anchor_indexes(self):
        self.assertEqual(anchor_indexes([1, 1.1, 100]), [0, 1])
        self.assertIsNone(anchor_indexes([1, 2, 3]))
        self.assertEqual(anchor_indexes([10]), [0])
        self.assertIsNone(anchor_indexes([]))

    def test_pick_pool_keeps_deepest_major_quote(self):
        address = "0xabc0000000000000000000000000000000000001"
        listings = [_listing("binance", "PEPE", 1)]
        pairs = [
            {
                "chainId": "ethereum",
                "dexId": "uniswap",
                "url": "https://dexscreener.com/a",
                "baseToken": {"address": address, "symbol": "PEPE"},
                "quoteToken": {"symbol": "WETH"},
                "priceUsd": "1.1",
                "liquidity": {"usd": 10_000},
            },
            {
                "chainId": "ethereum",
                "dexId": "sushiswap",
                "url": "https://dexscreener.com/b",
                "baseToken": {"address": address, "symbol": "PEPE"},
                "quoteToken": {"symbol": "USDC"},
                "priceUsd": "1.2",
                "liquidity": {"usd": 90_000, "base": 1_500_000, "quote": 45_000},
                "volume": {"h24": 12_300},
            },
            {
                "chainId": "ethereum",
                "dexId": "junk",
                "url": "https://dexscreener.com/c",
                "baseToken": {"address": address, "symbol": "PEPE"},
                "quoteToken": {"symbol": "SCAM"},
                "priceUsd": "9",
                "liquidity": {"usd": 500_000},
            },
        ]
        pool = pick_pool(pairs, address, listings, min_liquidity=25_000)
        self.assertIsNotNone(pool)
        self.assertEqual(pool.dex, "sushiswap")
        self.assertAlmostEqual(pool.price_usd, 1.2)
        self.assertAlmostEqual(pool.liquidity_base, 1_500_000)
        self.assertAlmostEqual(pool.liquidity_quote, 45_000)
        self.assertAlmostEqual(pool.volume_h24, 12_300)

    def test_edges_use_bid_ask(self):
        pool = _pool(price_usd=100)
        # Ask is far above the pool, so the buy-CEX edge is gone. Bid still clears a small DEX discount.
        wide = _listing("gate", "PEPE", 105, bid=103, ask=120)
        missed = best_opportunity(
            [wide],
            pool,
            token_address="0xabc",
            chain="ethereum",
            min_volume=10_000,
            min_top_notional=0,
            max_spread=80,
        )
        self.assertIsNotNone(missed)
        self.assertEqual(missed.direction, "buy_dex")
        self.assertLess(missed.edge_pct, 5)

        pool = _pool(price_usd=106)
        tight = _listing("binance", "PEPE", 100, bid=99.5, ask=100.4)
        hit = best_opportunity(
            [tight],
            pool,
            token_address="0xabc",
            chain="ethereum",
            min_volume=10_000,
            min_top_notional=0,
            max_spread=80,
        )
        self.assertEqual(hit.direction, "buy_cex")
        self.assertGreater(hit.edge_pct, 5)
        self.assertEqual(hit.exchange, "binance")

    def test_low_volume_and_symbol_mismatch_are_dropped(self):
        pool = _pool(price_usd=2)
        thin = _listing("mexc", "PEPE", 1, volume=100)
        wrong = _listing("mexc", "DOGE", 1, volume=100_000)
        self.assertIsNone(
            best_opportunity(
                [thin, wrong],
                pool,
                token_address="0x1",
                chain="ethereum",
                min_volume=10_000,
                min_top_notional=0,
                max_spread=80,
            )
        )

    def test_assemble_links_symbol_only_when_anchors_agree(self):
        def coin(exchange, base, last, contracts, owned):
            return ListedCoin(
                exchange=exchange,
                base=base,
                name=base,
                quote=_quote(last),
                contracts=contracts,
                has_own_contracts=owned,
            )

        eth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
        pepe = "0x6982508145454ce325ddbe47a25d4ec3d2311933"
        coins = [
            coin("gate", "BTC", 100000, [("BTC", "")], True),
            coin("gate", "ETH", 2000, [("ETH", "")], True),
            coin("kucoin", "PEPE", 0.00001, [("eth", pepe)], True),
            coin("bitget", "PEPE", 0.000011, [("ERC20", pepe)], True),
            coin("okx", "PEPE", 0.0000095, [], False),
            coin("mexc", "FAKE", 1, [], False),
            coin("bybit", "PEPE", 3, [], False),
        ]
        markets, _index, _unmapped = assemble_markets(coins)
        eth_market = markets[("ethereum", eth)]
        self.assertEqual({item.exchange for item in eth_market.listings}, {"gate"})
        wbtc = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"
        self.assertIn("gate", {item.exchange for item in markets[("ethereum", wbtc)].listings})
        pepe_market = markets[("ethereum", pepe)]
        self.assertEqual({item.exchange for item in pepe_market.listings}, {"kucoin", "bitget", "okx"})
        self.assertNotIn(("ethereum", "nope"), markets)

    def test_price_parsers_and_message(self):
        gate = _prices_gate(
            [
                {
                    "currency_pair": "PEPE_USDT",
                    "last": "0.00001",
                    "highest_bid": "0.0000099",
                    "lowest_ask": "0.0000101",
                    "quote_volume": "80000",
                }
            ],
            ("USDT", "USDC"),
        )
        self.assertAlmostEqual(gate["PEPE"].last, 0.00001)
        book = _prices_binance(
            [
                {
                    "symbol": "BTCUSDT",
                    "bidPrice": "100",
                    "askPrice": "102",
                    "bidQty": "1",
                    "askQty": "2",
                }
            ],
            ("USDT",),
        )
        self.assertAlmostEqual(book["BTC"].last, 101)
        self.assertAlmostEqual(book["BTC"].top_notional, 204)
        opportunity = best_opportunity(
            [_listing("binance", "PEPE", 1, bid=0.99, ask=1.01)],
            _pool(price_usd=1.2, liquidity_base=1_500_000, liquidity_quote=45_000, volume_h24=12_300),
            token_address="0x6982508145454ce325ddbe47a25d4ec3d2311933",
            chain="ethereum",
            min_volume=0,
            min_top_notional=0,
            max_spread=80,
        )
        text = format_opportunity(opportunity)
        self.assertIn("PEPE", text)
        self.assertIn("Liquidity DEX:", text)
        self.assertNotIn("Tax DEX", text)
        taxed = replace(opportunity, buy_tax=5, sell_tax=10.5, transfer_tax=0)
        self.assertIn("Tax DEX: mua 5% · bán 10.5% · chuyển 0%", format_opportunity(taxed))
        self.assertIn("1.50M PEPE", text)
        self.assertIn("45.0K WETH", text)
        self.assertIn("Vol DEX 24h:", text)
        self.assertIn("DexScreener", text)
        self.assertIn("không có dữ liệu công khai", text)
        self.assertTrue(format_price(0.000004898).startswith("$0.000004898"))

    def test_transfer_lines_same_chain_and_bridge(self):
        same = transfer_lines(
            "binance",
            "ENJ",
            "buy_cex",
            "ethereum",
            (ChainGate("ethereum", "ETH", True, True),),
        )
        self.assertTrue(any(line.startswith("Chain DEX: Ethereum") and "Cùng chain" in line for line in same))
        self.assertTrue(any(line.startswith("Rút ") and "đang mở trên Ethereum" in line for line in same))
        self.assertTrue(any(line.startswith("Nạp ") and "đang mở trên Ethereum" in line for line in same))
        self.assertTrue(any("không cần cầu" in line for line in same))

        shifted = transfer_lines(
            "gate",
            "ENJ",
            "buy_cex",
            "ethereum",
            (
                ChainGate("ethereum", "ETH", False, True),
                ChainGate("bsc", "BSC", True, False),
            ),
        )
        self.assertTrue(any(line.startswith("Chain DEX: Ethereum") and "Cùng chain" in line for line in shifted))
        other = transfer_lines(
            "gate",
            "ENJ",
            "buy_cex",
            "ethereum",
            (ChainGate("bsc", "BSC", True, True),),
        )
        self.assertTrue(any(line.startswith("Chain DEX: Ethereum") and "Khác chain" in line and "BSC" in line for line in other))
        self.assertTrue(any(line.startswith("Rút ") and "đang mở trên BSC" in line for line in shifted))
        self.assertTrue(any(line.startswith("Rút ") and "đang khóa trên Ethereum" in line for line in shifted))
        self.assertTrue(any(line.startswith("Nạp ") and "đang mở trên Ethereum" in line for line in shifted))
        self.assertTrue(any("deBridge" in line for line in shifted))

        deposit_closed = transfer_lines(
            "gate",
            "ENJ",
            "buy_dex",
            "ethereum",
            (ChainGate("ethereum", "ETH", True, False),),
        )
        self.assertTrue(any(line.startswith("Nạp ") and "đang khóa" in line for line in deposit_closed))
        self.assertTrue(any("Không nạp được" in line for line in deposit_closed))

        closed = _listing("gate", "ENJ", 1, bid=0.99, ask=1.01)
        closed.gates = (ChainGate("ethereum", "ETH", True, False),)
        kept = best_opportunity(
            [closed],
            _pool(price_usd=0.8, base_symbol="ENJ"),
            token_address="0xabc",
            chain="ethereum",
            min_volume=0,
            min_top_notional=0,
            max_spread=80,
        )
        self.assertIsNotNone(kept)
        colored = format_opportunity(kept)
        self.assertIn('class="language-diff"', colored)
        self.assertIn("+ Chain DEX: Ethereum", colored)
        self.assertNotIn("- Chain DEX: Ethereum", colored)
        self.assertIn("+ Rút Gate", colored)
        self.assertIn("- Nạp Gate", colored)

        missing = transfer_lines("bybit", "ENJ", "buy_cex", "ethereum", ())
        self.assertTrue(any(line.startswith("Chain DEX: Ethereum") and "không ghi chain" in line for line in missing))
        self.assertTrue(any("Rút " in line and "không có dữ liệu công khai" in line for line in missing))
        self.assertTrue(any("Nạp " in line and "không có dữ liệu công khai" in line for line in missing))
        self.assertTrue(any("bybit.com" in line and "ENJ" in line for line in missing))

    def test_tax_is_percent_and_hidden_when_zero(self):
        self.assertAlmostEqual(percent_from_fraction("0.1"), 10)
        self.assertAlmostEqual(percent_from_fraction("1"), 100)
        self.assertIsNone(percent_from_fraction(""))
        self.assertAlmostEqual(percent_from_fee_rate("200"), 2)
        evm = tax_from_payload(
            {"code": 1, "result": {"0xabc": {"buy_tax": "0.05", "sell_tax": "0", "transfer_tax": ""}}},
            "0xAbC",
            "ethereum",
        )
        self.assertAlmostEqual(evm.buy, 5)
        self.assertAlmostEqual(evm.sell, 0)
        self.assertIsNone(evm.transfer)
        self.assertEqual(tax_line(evm.buy, evm.sell, evm.transfer), "Tax DEX: mua 5% · bán 0%")
        sol = tax_from_payload(
            {"code": 1, "result": {"mint": {"transfer_fee": {"current_fee_rate": {"fee_rate": "200"}}}}},
            "mint",
            "solana",
        )
        self.assertEqual(tax_line(sol.buy, sol.sell, sol.transfer), "Tax DEX: chuyển 2%")
        self.assertEqual(tax_line(0, 0, 0), "Tax DEX: mua 0% · bán 0% · chuyển 0%")
        self.assertIsNone(tax_line(None, None, None))
        self.assertIsNone(tax_from_payload({"code": 0}, "0xabc", "ethereum"))


if __name__ == "__main__":
    unittest.main()
