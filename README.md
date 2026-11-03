# X snipe

Mở `setup.txt` bằng Notepad, sửa, lưu. Sau đó chỉ cần một lệnh:

```powershell
cd $HOME\t-i-li-u
npm start
```

Hai chế độ, sửa `MODE` trong `setup.txt`:

- `MODE=twitter` và điền `LINK`: chờ tài khoản X đăng contract rồi mua.
- `MODE=liquid` và điền `CONTRACT=0x...`: contract đã biết. Tool chờ đến lúc add liquidity hoặc mở trade thì mua ngay.

`CHAIN` là `bsc`, `eth`, `base`, hoặc `robinhood`.

`GAS_X=2` nghĩa là trả gấp 2 lần giá gas đang chạy trên mạng lúc mua. Điền `5` nếu muốn x5. `SLIPPAGE_PERCENT=15` là chấp nhận giá tệ hơn 15% so với lúc mô phỏng.

`MAX_TAX_PERCENT=10` nghĩa là tax trên 10% thì không mua. `MAX_MCAP_USD=100000` nghĩa là vốn hóa trên 100.000 USD thì không mua. Điền `0` nếu không muốn chặn theo vốn hóa.

`DRY_RUN=true` thì chưa gửi tiền. Muốn mua thật thì đổi thành `false` và điền `PRIVATE_KEY`.

Ví phải có BNB nếu chain là `bsc`, hoặc ETH đúng mạng nếu chain là `eth`, `base`, hay `robinhood`.
