# X snipe

Theo dõi một tài khoản X. Khi họ đăng địa chỉ contract, tool mô phỏng mua và bán trên pool V2. Tax còn trong ngưỡng thì gửi lệnh mua. Tax cao hơn ngưỡng, hoặc không bán được, thì bỏ qua.

Pool: PancakeSwap V2 (BSC), Uniswap V2 (Ethereum, Base, Robinhood Chain).

Điểm vào: `src/index.js` (`npm start` gọi đúng file này).

## Chạy

```bash
npm install
cp .env.example .env
npm start -- --chain bsc https://x.com/ten_du_an
```

Lệnh tương đương:

```bash
node src/index.js --chain bsc https://x.com/ten_du_an
node src/index.js --chain eth https://x.com/ten_du_an
node src/index.js --chain base https://x.com/ten_du_an
node src/index.js --chain robinhood https://x.com/ten_du_an
```

Chỉ đo tax, không theo dõi X và không gửi giao dịch:

```bash
npm start -- --chain bsc --token 0x...
```

File cần có:

| File | Việc |
| --- | --- |
| `src/settings.js` | Số mua, gas, ngưỡng tax, chain mặc định, `DRY_RUN` mặc định |
| `.env` | Không bắt buộc khi chỉ xem. Copy từ `.env.example` khi cần khóa, RPC, hoặc ghi đè chain / dry-run |
| `package.json` | `npm install` để có `ethers` và `dotenv` |

`.env` đọc từ thư mục repo, không phụ thuộc thư mục đang đứng.

## Cờ

| Cờ | Tác dụng |
| --- | --- |
| `--chain <tên>` | `bsc`, `eth`, `base`, `robinhood`. Cũng nhận `ethereum`, `bnb`, `rh`, `robinhoodchain`. Đè `CHAIN` trong `.env` và `CHAIN` trong `src/settings.js`. |
| `--token <0x...>` | Đo tax một contract rồi thoát. Không đọc timeline, không phát giao dịch. |
| `--help` | In cách dùng rồi thoát. |

Một lần chạy chỉ nhận một link. Link profile (`https://x.com/ten_du_an` hoặc `@ten_du_an`) chỉ mua contract trong tweet mới, cộng tweet đăng trong `LOOKBACK_SEC` giây gần nhất. Link tweet (`.../status/<id>`, kể cả `https://x.com/i/web/status/<id>`) được quét ngay, kể cả tweet cũ, rồi tiếp tục theo dõi tài khoản đó.

Nếu tweet dán địa chỉ pair V2 của đúng factory, tool mua token còn lại (không mua LP), kể cả khi LP vẫn swap được.

## Biến `.env`

| Biến | Tác dụng |
| --- | --- |
| `PRIVATE_KEY` | Khóa ví mua. Chỉ cần khi `DRY_RUN` tắt. Ví riêng, chỉ nạp số chấp nhận mất. |
| `RPC_URL` | RPC của đúng chain. Để trống thì dùng RPC trong `src/chains.js`. RPC phải hỗ trợ `eth_simulateV1`. Tool đối chiếu `eth_chainId` với chain đã chọn trước khi chạy. |
| `CHAIN` | Chain mặc định nếu không truyền `--chain`. Để trống thì dùng `src/settings.js`. |
| `DRY_RUN` | `true` / `1` / `yes` / `on` = không gửi giao dịch. `false` = mua thật, bắt buộc có `PRIVATE_KEY`. Để trống thì dùng `DRY_RUN` trong `src/settings.js` (mặc định `true`). Giá trị trong `.env` thắng file settings. |

Ngưỡng tax, gas, và số lượng mua chỉ sửa trong `src/settings.js`:

| Hằng số | Ý nghĩa |
| --- | --- |
| `BUY_AMOUNT` | Số BNB hoặc ETH mỗi lệnh |
| `GAS_GWEI` | Gas price. Thấp hơn base fee / gas mạng thì tool không gửi lệnh thật |
| `GAS_LIMIT` | Trần gas |
| `MAX_TAX_PERCENT` | Không mua nếu buy tax hoặc sell tax cao hơn mức này. `10` = 10% |
| `SLIPPAGE_PERCENT` | `amountOutMin` = token mô phỏng nhận được × (1 − slippage). `minOut` bằng 0 thì không gửi |
| `PROBE_AMOUNT` | Lệnh nhỏ để đo tax. Lớn hơn hoặc bằng `BUY_AMOUNT` thì đo bằng đúng khối lượng mua |
| `POLL_MS` | Nghỉ giữa hai lần hỏi timeline, ms. `0` = hỏi lại ngay. API trả trống thì tool tự chờ khoảng 2 giây |
| `LOOKBACK_SEC` | Tweet cũ hơn mức này không mua lúc vừa dán link profile |
| `WAIT_FOR_PAIR_MS` | Chờ pool / mở trade sau khi thấy contract |
| `RETRY_MS` | Nghỉ giữa các lần thử lại |
| `DRY_RUN` | `true` thì không gửi giao dịch |

Ví phải có native coin của đúng chain: BNB trên BSC, ETH trên Ethereum, Base, hoặc Robinhood Chain. Gas cũng trả bằng coin đó.

## Khi nào không mua

- Buy tax hoặc sell tax cao hơn `MAX_TAX_PERCENT`
- Mô phỏng bán bị revert (honeypot, hoặc token chặn ví)
- Chưa có pair V2 / chưa mở trade, và hết `WAIT_FOR_PAIR_MS`
- Khối lượng `BUY_AMOUNT` không khớp được pool
- Địa chỉ nằm trong blacklist của chain (WETH, router, stable, token hệ thống) hoặc `0x0` / `0x…dead`
- RPC không cùng chain, hoặc không chạy được `eth_simulateV1`

Token chỉ có pool V3, hoặc đang nằm trên bonding curve (Four.meme, pump.fun), không được mua. Hash giao dịch 64 ký tự trong tweet không bị nhận nhầm thành địa chỉ.

Mô phỏng bán gắn bytecode tạm vào ví sạch và nhích thời gian 3 phút. Token cố tình chặn hợp đồng lúc bán có thể bị bỏ qua dù ví thường vẫn bán được. Một số honeypot chỉ hiện sau khi mua thật.

Trên RPC public BSC, mô phỏng mua và bán CAKE đo được khoảng vài chục ms. Phần chờ tweet phụ thuộc API `api.fxtwitter.com`. API hay trả HTTP 404 khi timeline trống hoặc bị giới hạn; tool thử lại, không gửi lệnh vì lỗi đó.
