# X snipe

Dán link X của dự án. Khi tài khoản đó đăng contract, tool mô phỏng mua và bán trên pool V2. Tax còn trong ngưỡng thì gửi lệnh mua ngay. Tax cao hơn ngưỡng, hoặc không bán được, thì bỏ qua.

Pool hỗ trợ: PancakeSwap V2 (BSC) và Uniswap V2 (Ethereum, Base, Robinhood Chain). Chọn chain lúc chạy:

```bash
node src/index.js --chain eth https://x.com/ten_du_an
node src/index.js --chain base https://x.com/ten_du_an
node src/index.js --chain robinhood https://x.com/ten_du_an
```

Ví phải có native coin của đúng chain đó: BNB trên BSC, ETH trên Ethereum, Base, hoặc Robinhood Chain. Gas cũng trả bằng coin đó.

## Chạy

```bash
npm install
cp .env.example .env
npm start -- https://x.com/ten_du_an
```

Chỉ xem tax của một contract, không gửi lệnh:

```bash
npm start -- --token 0x...
```

`DRY_RUN` mặc định là `true`: tool in lệnh sẽ mua nhưng không phát giao dịch. Muốn mua thật thì sửa `DRY_RUN` trong `src/settings.js` (hoặc `DRY_RUN=false` trong `.env`) và điền `PRIVATE_KEY` trong `.env`. Dùng ví riêng, chỉ nạp số tiền chấp nhận mất.

## Chỉnh trong code

Sửa `src/settings.js`:

| Hằng số | Ý nghĩa |
| --- | --- |
| `BUY_AMOUNT` | Số BNB hoặc ETH mỗi lệnh mua |
| `GAS_GWEI` | Gas price |
| `GAS_LIMIT` | Trần gas. Token nặng bị out-of-gas thì tăng |
| `MAX_TAX_PERCENT` | Không mua nếu buy tax **hoặc** sell tax cao hơn mức này. `10` = 10% |
| `SLIPPAGE_PERCENT` | Trần trượt giá thêm so với kết quả mô phỏng |
| `PROBE_AMOUNT` | Lệnh nhỏ để đo tax, tránh tính price impact thành tax |
| `CHAIN` | `bsc`, `eth`, `base`, hoặc `robinhood` |
| `DRY_RUN` | `true` thì không gửi giao dịch |

Link tweet cụ thể (`https://x.com/user/status/...`) được quét ngay, kể cả tweet cũ. Link profile chỉ mua contract trong tweet mới, cộng thêm tweet đăng trong `LOOKBACK_SEC` giây gần nhất.

## Tốc độ

Sau khi API trả về tweet có contract, mô phỏng tax trên RPC public của BSC đo được khoảng 60–80ms (mua và bán trong một request). Ký và gửi lệnh nằm sau bước đó. Tổng từ lúc đọc được contract tới lúc gửi thường dưới 1 giây nếu RPC phản hồi nhanh. RPC công cộng chậm thì điền `RPC_URL` riêng trong `.env`.

Phần chờ tweet xuất hiện phụ thuộc API đọc timeline (thường vài trăm ms mỗi vòng). `POLL_MS = 0` nghĩa là hỏi vòng tiếp theo ngay khi vòng trước xong.

## Khi nào không mua

- Buy tax hoặc sell tax cao hơn `MAX_TAX_PERCENT`
- Mô phỏng bán bị revert (honeypot, hoặc token chặn ví)
- Chưa có pair V2 / chưa mở trade, và hết `WAIT_FOR_PAIR_MS`
- Khối lượng `BUY_AMOUNT` không khớp được pool

Token chỉ có pool V3, hoặc đang nằm trên bonding curve (Four.meme, pump.fun), sẽ không được mua.

Mô phỏng bán dùng một ví sạch và nhích thời gian 3 phút để né cooldown cùng block. Token cố tình chặn hợp đồng lúc bán có thể bị bỏ qua dù ví thường vẫn bán được. Một số honeypot chỉ hiện sau khi mua thật; mô phỏng không bắt hết.

## Sao chép lệnh mua trên Solana

Tool nghe một ví Solana. Khi ví đó mua một token, tool mua cùng token bằng SOL của ví bạn. Tín hiệu là giao dịch của họ ở mức `processed`: lệnh của họ đã nằm trong block đang xử lý, rồi tool mới ký lệnh của bạn. Lệnh mình vì vậy đứng sau lệnh của họ.

```bash
npm install
cp .env.example .env
npm run copy -- <địa chỉ ví Solana>
```

`DRY_RUN` mặc định là `true`. Tool in token, số nhận tối thiểu, và impact, rồi không gửi. Muốn mua thật thì đặt `DRY_RUN=false` và điền `SOLANA_PRIVATE_KEY`. Dùng ví riêng, chỉ nạp số SOL chấp nhận mất.

Chỉnh số SOL, trượt giá, tip, và trần impact trong `src/solana/settings.js`.

| Hằng số | Ý nghĩa |
| --- | --- |
| `BUY_SOL` | Số SOL mỗi lệnh mua |
| `SLIPPAGE_BPS` | Trần trượt giá. `1500` = 15% |
| `JITO_TIP_LAMPORTS` | Tip để đường Jito nhận lệnh. `1000000` = 0.001 SOL |
| `MAX_PRICE_IMPACT_PERCENT` | Bỏ qua nếu chính lệnh mình đội giá quá mức này |
| `MIN_SOL_SPENT` | Bỏ qua nếu ví kia tiêu ít SOL hơn mức này |
| `COPY_ONCE_PER_MINT` | Mỗi token chỉ mua một lần trong phiên |
| `MAX_BUYS` | Trần số lệnh mua thật |

Điền `HELIUS_API_KEY` để dùng `transactionSubscribe`. Không có key thì tool nghe `logsSubscribe` rồi gọi `getTransaction`, chậm hơn một nhịp. Route swap lấy từ Jupiter (`mode=fast`). Lệnh được gửi cùng lúc lên RPC và các máy Jito.

Slot Solana khoảng 400ms, và hỏi route mất thêm vài trăm mili giây. Lệnh của bạn vào cùng slot nếu leader còn nhận, hoặc slot kế tiếp. Cả hai trường hợp đều sau lệnh đã thấy. Tool không nghe shred trước khi lệnh của họ được xử lý, nên không chen lên trước.

Tool chỉ theo lệnh mua (ví nhận token và tiêu SOL, WSOL, USDC, hoặc USDT). Lệnh bán, chuyển token không tốn tiền, và stablecoin không được mua theo. Token chưa có route trên Jupiter thì bỏ qua.
