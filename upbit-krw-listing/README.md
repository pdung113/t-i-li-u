# Mua listing KRW trên Upbit

Tool riêng này canh thông báo Upbit. Chỉ mua coin **listing mới có cặp KRW**. Cặp BTC hoặc USDT không mua. Kết quả mua được hay không được gửi qua bot [t.me/follow07_bot](https://t.me/follow07_bot).

Upbit không có gas và không nhận private key của ví. Lệnh đi qua Open API, trừ số dư KRW trong tài khoản. Ô **hệ số giá** mặc định là 2: với coin bị cấm lệnh thị trường, tool đặt lệnh giới hạn ở giá trần gấp đôi giá ghi trong thông báo.

Thông báo kiểu SANC còn ghi hai giới hạn: khoảng 5 phút đầu không được mua, và khoảng 2 giờ sau chỉ nhận lệnh giới hạn. Tool đọc đúng hai câu đó trong từng thông báo, rồi gửi một lệnh khi hết khoảng cấm mua.

## Chạy

```bash
cd upbit-krw-listing
npm install
npm start
```

Mở http://127.0.0.1:8787

Điền Access Key, Secret Key, số KRW, hệ số giá, token bot và chat id. Muốn mua thật thì tick **Gửi lệnh thật**. Không tick thì tool chỉ canh và báo lệnh dự kiến.

API key cần quyền đặt lệnh, không cần quyền rút tiền. IP của máy phải nằm trong danh sách cho phép của key.

Với bot, mở https://t.me/follow07_bot, bấm Start, gửi một tin nhắn, rồi bấm **Lấy chat id**.

Muốn chạy lại cùng cấu hình:

```bash
npm start -- --run
```

## Kiểm tra

```bash
npm test
```
