# Theo dõi chênh lệch giá DEX / CEX

Tool quét coin đang niêm yết trên CEX, lấy giá pool DEX theo **đúng hợp đồng**, và nhắn Telegram khi lệch từ mức bạn đặt (mặc định **5%**).

Mỗi vòng làm mới giá của cả sàn trong một request, rồi hỏi DexScreener theo lô 30 hợp đồng. Tốc độ bám trần API công khai của DexScreener, khoảng **300 request/phút** (tầm 9.000 hợp đồng/phút). Vòng sau bắt đầu ngay khi vòng trước xong.

## Sàn và chain

Hợp đồng lấy từ Binance, Gate.io, KuCoin, Bitget, HTX. MEXC, OKX và Bybit không công bố hợp đồng; giá của họ chỉ được gắn vào coin khi các sàn kia đã thống nhất cùng một mức giá cho ký hiệu đó. Nếu mạng của bạn chặn Bybit, tool bỏ qua sàn đó và quét tiếp.

Chain phủ các mạng DexScreener đang có pool: Ethereum, BSC, Solana, Base, Arbitrum, Optimism, Polygon, Avalanche, và các mạng khác đã map. Coin không có hợp đồng (hoặc chỉ nằm trên chain lạ) không thể so giá DEX nên được bỏ qua. Stablecoin và token đòn bẩy (`BTC3L`, …) cũng bị bỏ.

Giá thực thi dùng ask khi mua CEX và bid khi bán CEX, nếu sàn trả sổ lệnh. Pool DEX phải có thanh khoản tối thiểu và quote là stablecoin hoặc coin lớn (WETH, WBNB, SOL, …). BTC trên CEX còn được so với WBTC trên Ethereum, vì Bitcoin không có hợp đồng ERC-20.

## Cài đặt

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Trong `.env`:

1. Tạo bot với [@BotFather](https://t.me/BotFather), dán token vào `TELEGRAM_BOT_TOKEN`.
2. Nhắn `/start` cho bot. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates` và dán `chat.id` vào `TELEGRAM_CHAT_ID`.

## Chạy

Quét liên tục, đây là chế độ nhanh nhất:

```bash
python -m spread_alert
```

Một vòng rồi thoát (xem log, vẫn gửi Telegram nếu đã cấu hình):

```bash
python -m spread_alert --once
```

Muốn mỗi vòng ngắn hơn thì giới hạn chain trong `.env`:

```bash
CHAINS=ethereum,bsc,solana,base,arbitrum
```

`DEX_REQUESTS_PER_SEC` mặc định `4.5`. Để sát trần hơn có thể đặt `4.8`. Vượt `5` dễ bị DexScreener trả 429 và vòng quét bị dừng khoảng 20 giây.

## Đọc cảnh báo

`Mua Binance → bán Uniswap` nghĩa là giá mua trên CEX thấp hơn giá pool. Phần trăm đã tính phí spread của sổ lệnh, chưa tính phí nạp/rút, phí gas, trượt giá khi khớp lệnh lớn, hay thời gian chuyển chain. Cùng một ticker trên hai sàn đôi khi là hai tài sản khác nhau nếu không khớp hợp đồng; tool chỉ so những cặp đã có địa chỉ hợp đồng.

Ngưỡng, thanh khoản, volume và thời gian im giữa hai tin cùng một cơ hội chỉnh trong `.env.example`.
