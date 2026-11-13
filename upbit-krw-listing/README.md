# Mua listing KRW của Upbit trên DEX

Tool riêng này đọc thông báo Upbit. Khi có **listing mới có cặp KRW**, tool mua coin đó ngay trên DEX của mạng ghi trong thông báo. Không đặt lệnh trên sàn KRW của Upbit.

Cặp chỉ có BTC hoặc USDT không mua. Tin thêm thị trường và tin đóng giao dịch cũng không mua. Thông báo cũ hơn 3 phút không mua khi mở lại tool.

Access Key và Secret Key chỉ để nhận thông báo. Có hai private key vì hai ví khác nhau: ví ERC và ví Solana. Mỗi chain một ô số lượng, tối đa 5. Chain để trống thì không mua. Có ô trượt giá và ô FDV tối đa. FDV cao hơn mức đã nhập thì không mua. Ô **hệ số gas** mặc định là 2. Tool giữ sẵn RPC và gas để gửi giao dịch trong khoảng 0,5 giây sau khi nhận tin. Kết quả gửi qua bot [t.me/follow07_bot](https://t.me/follow07_bot).

## Chạy

```bash
cd upbit-krw-listing
npm install
npm start
```

Mở http://127.0.0.1:8787

Điền key Upbit, private key ví ERC, private key ví Solana, số lượng từng chain, trượt giá, FDV tối đa, hệ số gas, token bot và chat id. Muốn mua thật thì tick **Gửi giao dịch thật trên DEX**. Không tick thì tool chỉ báo kế hoạch, không ký giao dịch. RPC công cộng có thể khiến lượt gửi vượt 0,5 giây. Điền RPC riêng trong `.env` nếu cần sát mục tiêu đó.

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
