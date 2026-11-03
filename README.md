# X snipe

Mở `setup.txt` bằng Notepad, sửa, lưu. Sau đó chỉ cần một lệnh:

```powershell
cd $HOME\t-i-li-u
npm start
```

`LINK` là link X của dự án. `CHAIN` là `bsc`, `eth`, `base`, hoặc `robinhood`.

`MAX_TAX_PERCENT=10` nghĩa là tax trên 10% thì không mua. `MAX_MCAP_USD=100000` nghĩa là vốn hóa trên 100.000 USD thì không mua. Điền `0` nếu không muốn chặn theo vốn hóa.

`DRY_RUN=true` thì chưa gửi tiền. Muốn mua thật thì đổi thành `false` và điền `PRIVATE_KEY`.

Ví phải có BNB nếu chain là `bsc`, hoặc ETH đúng mạng nếu chain là `eth`, `base`, hay `robinhood`.
