# X snipe

Có hai tool tách nhau. `npm start` mua token trên pool V2. `npm run nft` mint hoặc mua NFT, không đụng đường mua token.

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

## NFT

Mở `nft.txt` bằng Notepad. Sửa chain, gas, số lượng, link và private key trong file đó, rồi chạy:

```bash
npm run nft
```

Chưa có `nft.txt` thì lệnh trên tạo file từ `nft.example.txt`. Mỗi dòng `key=` là một ví. Nhiều ví mint cùng lúc. Xong, tool in chain đang mint, ví nào thành công, ví nào thất bại, và tổng số NFT.

`dry_run=true` trong file thì chỉ xem trước, không gửi. Đổi thành `false` khi muốn mint thật. Dùng ví riêng, chỉ nạp số chấp nhận mất. Không đưa `nft.txt` lên git sau khi đã dán key.

Tool cũng nhận link OpenSea, link chợ có địa chỉ contract, hoặc trang mint. Ví đủ round nào thì canh đúng round đó.

```bash
npm run nft -- mint https://mint.du-an.xyz --qty 2 --gas 20 --max-price 0.05
npm run nft -- buy https://opensea.io/collection/ten-bo-suu-tap --qty 1 --max-price 0.2
```

`mint` kiểm tra lần lượt allowlist, token-gated và public:

- Round chưa mở mà ví đủ điều kiện thì canh đúng giờ mở rồi gửi một giao dịch.
- Ví có proof allowlist khớp merkle, hoặc đang giữ token của round token-gated, thì chọn round đó nếu nó mở trước public.
- Ví không đủ allowlist thì bỏ round đó và canh public.
- Round chữ ký server không có chữ ký trên trang thì bỏ qua. Tool không tự tạo chữ ký.
- Giá mỗi NFT cao hơn trần, hoặc số dư không đủ giá cộng gas, thì không mint.

Chain ghi trong `nft.txt`: `eth`, `base`, `polygon`, `arbitrum`, `optimism`, `bsc`. Gas và số lượng cũng ghi trong file đó. `src/nft/settings.js` chỉ là mặc định khi chạy lệnh lẻ.

`buy` lấy listing đang rẻ nhất dưới trần giá. Cần `OPENSEA_API_KEY`. Link collection OpenSea cũng cần key này nếu trang không hiện địa chỉ contract. Link đã có `0x` thì mint không cần key.

Trang mint phải để contract trong HTML, JSON hoặc file script của trang. Contract lạ không có SeaDrop, claim condition của thirdweb, hoặc hàm `mint(uint256)` thì tool dừng và nói rõ. ERC1155 không được mint tự động.
