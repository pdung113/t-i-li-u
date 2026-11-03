# X snipe

Dán link X của dự án. Khi tài khoản đó đăng contract, tool mô phỏng mua và bán trên pool V2. Tax còn trong ngưỡng thì gửi lệnh mua ngay. Tax cao hơn ngưỡng, hoặc không bán được, thì bỏ qua.

Pool hỗ trợ: PancakeSwap V2 (BSC), Uniswap V2 (Ethereum và Base).

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
| `CHAIN` | `bsc`, `eth`, hoặc `base` |
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
