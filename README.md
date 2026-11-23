# Cách dùng

Mở PowerShell. Dòng lệnh bắt đầu bằng `PS`. Chuột phải để dán.

```powershell
cd $HOME\t-i-li-u
git pull
notepad setup.txt
```

Sửa `setup.txt`, `Ctrl+S`, rồi:

```powershell
npm start
```

Dừng bằng `Ctrl+C`.

## Chọn một chế độ

Mua khi tài khoản X đăng contract:

```text
MODE=twitter
CHAIN=bsc
LINK=https://x.com/ten_du_an
CONTRACT=
```

Chỉ mua contract đăng sau khi tool đang chạy. Muốn bắt tweet trong 60 giây vừa rồi thì thêm `LOOKBACK_SEC=60`.

Đã biết contract, mua lúc add liquidity hoặc mở trade:

```text
MODE=liquid
CHAIN=bsc
LINK=
CONTRACT=0xđịa_chỉ_contract
```

Mint NFT lúc cửa mở:

```text
MODE=mint
CHAIN=eth
LINK=
CONTRACT=0xđịa_chỉ_nft
MINT_PRICE=0.01
MINT_COUNT=1
MINT_FUNCTION=mint
```

`MINT_PRICE` là giá mỗi NFT. `MINT_COUNT=3` với giá `0.01` thì trả 0.03. Hàm ghi đúng tên trên contract: `mint`, `mint()`, `publicMint`, `publicMint()`, `mintPublic`, `freeMint`. Mint miễn phí thì `MINT_PRICE=0`. Hàm `mint()` và `publicMint()` chỉ mint 1 cái.

`CHAIN` là `bsc`, `eth`, `base`, hoặc `robinhood`.

## Số chung

- `BUY_AMOUNT`: số BNB hoặc ETH mua mỗi lần khi săn token.
- `GAS_X=2`: trả gấp 2 lần giá gas lúc gửi. Muốn x5 thì điền `5`.
- `MAX_TAX_PERCENT=10`: tax trên 10% thì không mua.
- `SLIPPAGE_PERCENT=15`: giá tệ hơn 15% so với lúc mô phỏng thì lệnh tự hủy.
- `MAX_MCAP_USD=100000`: vốn hóa trên 100.000 USD thì không mua. Điền `0` nếu không giới hạn.
- `DRY_RUN=true`: chỉ thử, chưa trừ ví. Muốn gửi thật thì `DRY_RUN=false` và điền `PRIVATE_KEY`.

Ví cần BNB trên `bsc`, hoặc ETH trên `eth`, `base`, `robinhood`. Dùng ví riêng, chỉ nạp số chấp nhận mất.

Tool mua qua pool V2: PancakeSwap trên BSC, Uniswap V2 trên eth, base và robinhood.
