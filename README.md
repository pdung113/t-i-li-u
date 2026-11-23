# X snipe

Mở `setup.txt` bằng Notepad, sửa, lưu. Sau đó chỉ cần một lệnh:

```powershell
cd $HOME\t-i-li-u
npm start
```

Ba chế độ, sửa `MODE` trong `setup.txt`:

- `MODE=twitter` và điền `LINK`: chỉ mua contract đăng sau khi tool đang chạy.
- `MODE=liquid` và điền `CONTRACT=0x...`: contract đã biết. Có thanh khoản thì đo tax, vốn hóa và gas cùng lúc rồi mua ngay.
- `MODE=mint` và điền `CONTRACT`, `MINT_PRICE`, `MINT_COUNT`: chờ cửa mint mở rồi mint ngay.

`CHAIN` là `bsc`, `eth`, `base`, hoặc `robinhood`.

`GAS_X=2` nghĩa là trả gấp 2 lần giá gas đang chạy trên mạng lúc mua. Điền `5` nếu muốn x5. `SLIPPAGE_PERCENT=15` là chấp nhận giá tệ hơn 15% so với lúc mô phỏng.

`MAX_TAX_PERCENT=10` nghĩa là tax trên 10% thì không mua. `MAX_MCAP_USD=100000` nghĩa là vốn hóa trên 100.000 USD thì không mua. Điền `0` nếu không muốn chặn theo vốn hóa.

`DRY_RUN=true` thì chưa gửi tiền. Muốn mua thật thì đổi thành `false` và điền `PRIVATE_KEY`.

Ví phải có BNB nếu chain là `bsc`, hoặc ETH đúng mạng nếu chain là `eth`, `base`, hay `robinhood`.
