# Mua listing KRW của Upbit trên DEX

Tool riêng này đọc thông báo Upbit. Khi có **listing mới có cặp KRW**, tool mua coin đó ngay trên DEX của mạng ghi trong thông báo. Không đặt lệnh trên sàn KRW của Upbit.

Cặp chỉ có BTC hoặc USDT không mua. Tin thêm thị trường và tin đóng giao dịch cũng không mua. Thông báo cũ hơn 3 phút không mua khi mở lại tool.

Access Key và Secret Key chỉ để nhận thông báo. Private key ví ký giao dịch DEX trên máy này. Ô **hệ số gas** mặc định là 2. Ô số lượng là số đồng native của mạng trong tin (ETH, BNB, SOL hoặc POL), tối đa 5. Thiếu private key của đúng mạng thì không mua được. Kết quả gửi qua bot [t.me/follow07_bot](https://t.me/follow07_bot).

## Chạy

```bash
cd upbit-krw-listing
npm install
npm start
```

Mở http://127.0.0.1:8787

Điền key Upbit, private key ví EVM hoặc Solana, số lượng, hệ số gas, trượt giá, token bot và chat id. Muốn mua thật thì tick **Gửi giao dịch thật trên DEX**. Không tick thì tool chỉ báo kế hoạch, không ký giao dịch.

API key cần nằm trong danh sách IP cho phép. Không cần quyền rút tiền và không cần quyền đặt lệnh trên Upbit.

Với bot, mở https://t.me/follow07_bot, bấm Start, gửi một tin nhắn, rồi bấm **Lấy chat id**.

Muốn chạy lại cùng cấu hình:

```bash
npm start -- --run
```

RPC và khóa Jupiter có thể thêm trong `.env` nếu RPC công cộng chậm hoặc Jupiter yêu cầu khóa: `RPC_ETHEREUM`, `RPC_BSC`, `RPC_BASE`, `RPC_ARBITRUM`, `RPC_OPTIMISM`, `RPC_POLYGON`, `RPC_SOLANA`, `JUPITER_API_KEY`.

## Kiểm tra

```bash
npm test
```
