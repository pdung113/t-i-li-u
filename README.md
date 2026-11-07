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

## Báo follow mới qua Telegram

Mở `theo-doi.txt` bằng Notepad. Mỗi dòng là một tài khoản X. @vladtenev đã có sẵn. Muốn theo dõi thêm ai thì thêm một dòng, ví dụ `https://x.com/ten_khac` hoặc `@ten_khac`, rồi lưu.

GitHub giữ một phiên chạy và hỏi follow mới khoảng 15 giây một lần, kể cả khi máy tính đang tắt. GitHub không cho mở phiên mới nhanh hơn 5 phút, nên mỗi phiên ngồi khoảng 6 tiếng rồi phiên sau nối tiếp. Lúc đổi phiên, hoặc lúc GitHub khởi động chậm, tin có thể tới sau khoảng một phút.

Chạy thêm `chay.bat` trên máy thì tin tới khoảng 3 giây. Cùng một follow có thể thành hai tin: một từ máy, một từ GitHub.

Người được theo dõi là những dòng trong `theo-doi.txt` trên GitHub. Hiện có @vladtenev. Sửa file trên máy không đổi bản GitHub đang chạy.

Chạy thêm trên máy của bạn, nếu muốn:

```bash
npm run follow
```

Trên Windows có thể double-click `chay.bat`.

Lần chạy đầu chỉ nhớ follow hiện tại của từng người, không gửi tin cũ. Follow mới sau đó được gửi qua Telegram, kèm link X. Nếu tài khoản vừa được follow để contract trong bio hoặc bài viết, tin thêm dòng `Contract: 0x...`.

Tài khoản khoá không theo dõi được, vì danh sách follow không công khai. Token Telegram nằm trong `.env`, không ghi vào `theo-doi.txt`.

Lệnh `npm run follow` chỉ gọi `api.fxtwitter.com` và `api.telegram.org`. Nó không mở cổng vào máy và không đọc `PRIVATE_KEY`. File `.env` không được gửi cho người khác. Token bot đã dán trong chat thì vào @BotFather, chọn bot, lấy token mới, rồi sửa dòng `TELEGRAM_BOT_TOKEN` trong `.env`. Không gửi token mới vào chat.

Follow đã báo được lưu trong `data/follows/`. Xoá file của username đó nếu muốn lập mốc lại từ đầu.
