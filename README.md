# X snipe

Có hai tool tách nhau. `npm start` mua token trên pool V2. `node nft` mint hoặc mua NFT, không đụng đường mua token.

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

### Cách dùng

Trong thư mục project:

```bash
npm install
node nft
```

Lần đầu chưa có `nft.txt`, lệnh tạo file đó từ `nft.example.txt` rồi dừng. Mở `nft.txt` bằng Notepad, điền xong, chạy lại `node nft`. `npm run nft` vẫn là cùng một lệnh.

App trên máy mình, key không rời máy:

```bash
npm install
node app/server.js
```

Rồi mở http://127.0.0.1:4173. Trên Windows có thể double-click `Mo-NFT.bat`. Tải mã về: trên GitHub bấm Code, Download ZIP, giải nén, rồi chạy lệnh trên.

Trong app có ô chọn file JSON. Tool lấy link mint hoặc địa chỉ contract trong file, điền vào danh sách, rồi bấm Chạy. File chỉ đọc trên máy này, không gửi đi.

Trong app, nhập mật khẩu ít nhất 8 ký tự rồi bấm Lưu. `nft.txt` chỉ còn bản mã hóa, không còn private key trần. Lần chạy sau nhập lại đúng mật khẩu. App chỉ nghe `127.0.0.1` và không trả key về trình duyệt. Dùng lệnh `node nft` khi file đã khóa thì gõ mật khẩu, hoặc đặt `NFT_PASSWORD`.

```
chain=base
gas=5
gas_limit=500000
qty=1
max_price=0.2
dry_run=true

link=https://opensea.io/collection/ten-drop

key=
key=
```

| Dòng | Ý nghĩa |
| --- | --- |
| `chain` | `eth`, `base`, `polygon`, `arbitrum`, `optimism`, `bsc`, hoặc `elysium` |
| `rpc` | Không bắt buộc. RPC riêng khi RPC mặc định bị giới hạn |
| `gas` | Gas thường, đơn vị gwei |
| `gas_x` | Nhân với gas thường. `2` hoặc `3` để gửi gấp đôi, gấp ba. `gas=5` và `gas_x=3` thì gửi 15 gwei |
| `gas_limit` | Trần gas. Lệnh bị out-of-gas thì tăng, ví dụ `800000` |
| `qty` | Số NFT mỗi ví |
| `max_price` | Trần giá mỗi NFT, tính bằng coin của chain |
| `dry_run` | `true` chỉ xem. `false` mới gửi giao dịch |
| `link` | Mỗi dự án một dòng. Nhiều link chạy cùng lúc. Dòng `elysium https://...` dùng chain riêng |
| `key` | Private key mỗi ví một dòng. Nhiều ví mint cùng lúc |

`chain=elysium` là mainnet Kinetiq, chain id `99901`. Giá và gas tính bằng HYPE. RPC mặc định là `https://rpc.elysp.com`. RPC này dễ bị giới hạn lúc nhiều người mint, nên điền `rpc=` bằng endpoint Alchemy hoặc Hypedexer nếu có. OpenSea không bán trên Elysium; lệnh mint vẫn chạy.

Chạy thử trước. `dry_run=true` in round, giờ mở và giao dịch, không trừ tiền. Thấy đúng ví và đúng số lượng thì đổi `dry_run=false`, chạy lại. Dùng ví riêng, chỉ nạp số chấp nhận mất. Không đưa `nft.txt` lên git sau khi đã dán key.

Kết quả có chain, từng ví, và tổng:

```
Kết quả | chain base
1. 0x1234...abcd | chain base | thành công | 1 NFT
2. 0xabcd...9999 | chain base | thất bại | 0 NFT | ví không đủ điều kiện
Thành công 1/2 ví, tổng 1 NFT.
```

`dry_run=true` thì dòng ví ghi `chưa gửi`, không ghi `thành công`.

Link nhận được: trang mint của dự án, OpenSea collection hoặc item, và link chợ đã có địa chỉ `0x` trong URL.

Nhiều dòng `link` chạy song song. Hai dự án mở cùng giờ thì cả hai cùng canh và cùng gửi, không đợi dự án kia xong. Một dòng có thể ghi chain riêng: `link=elysium https://trang-mint.example`.

Mint xem ví đủ round nào. Allowlist chỉ chạy khi ví có proof khớp merkle trên trang. Token-gated chỉ chạy khi ví đang giữ token của round đó. Không đủ thì canh public. Ví đủ nhiều round thì mint lần lượt từng round, kể cả khi các round đã mở cùng lúc. Hết suất của một round thì bỏ round đó và mint round kế tiếp. Round chưa mở thì tool đứng chờ, 1,5 giây cuối kiểm mỗi 5ms. Đúng giờ mở thì gọi mint liên tục, contract nhận lệnh thì gửi ngay, và gửi lại đến khi một giao dịch thành công hoặc hết 120 giây. Trước giờ mở không gửi, để lệnh revert không tốn gas. Round chữ ký server không có sẵn chữ ký trên trang thì bỏ qua. Giá cao hơn `max_price`, hoặc ví không đủ tiền cộng gas, thì không mint.

Mua giá thấp nhất:

```bash
node nft buy https://opensea.io/collection/ten-drop --qty 1 --max-price 0.2
```

Cần `OPENSEA_API_KEY` trong `.env`. Tool lấy ask rẻ nhất còn dưới trần giá rồi tạo giao dịch mua. `dry_run` vẫn lấy từ `nft.txt` hoặc `DRY_RUN` trong `.env`.

### Khi trang mint đổi API

Tool lấy địa chỉ contract trên link hoặc trong HTML, rồi đọc round trực tiếp trên chuỗi: SeaDrop, claim condition của thirdweb, hoặc hàm `mint(uint256)`. Trang đổi đường dẫn API mà contract và giờ mở round trên chuỗi không đổi thì lần chạy sau vẫn mint được, không cần sửa code.

Link `kalos.fun/mint/...` là ngoại lệ: trang không ghi contract trong HTML, nên tool đọc API Kalos để lấy SeaDrop trên Elysium. Allowlist chỉ chạy khi Kalos xác nhận ví nằm trong danh sách. Public vẫn canh đúng giờ mở.

Hai chỗ không tự đổi theo trang:

- Trang khác không còn hiện địa chỉ contract ở đâu cả, contract chỉ nằm sau API mới. Lúc đó dán link item có `0x`, hoặc link `https://.../0xabc...`.
- Mua trên OpenSea đi qua API v2 cố định (`OPENSEA_API_KEY`). OpenSea đổi đường dẫn thì lệnh mua báo lỗi, phần mint trên chuỗi vẫn chạy.

Contract không có các hàm trên, hoặc là ERC1155, thì tool dừng và ghi lý do. `src/nft/settings.js` chỉ là mặc định khi chạy lệnh lẻ, không qua `nft.txt`.
