# Theo dõi chênh lệch giá DEX / CEX

Tool này chạy trên máy bạn. Nó so giá coin trên sàn tập trung (Binance, Gate, …) với giá pool trên sàn phi tập trung, rồi nhắn Telegram khi lệch từ **5%**.

Máy phải bật, có mạng, và cửa sổ dòng lệnh phải còn mở. Tắt máy hoặc đóng cửa sổ là tool dừng.

## 1. Cài Python

Cần Python 3.11 hoặc 3.12.

**Windows**

1. Vào https://www.python.org/downloads/ và tải bản mới nhất.
2. Mở file cài. Ở màn hình đầu, bật ô **Add python.exe to PATH**, rồi bấm Install.
3. Cài xong, mở **PowerShell** (gõ PowerShell trong menu Start) và chạy:

```powershell
python --version
```

Phải thấy dòng kiểu `Python 3.12.x`. Nếu báo không nhận lệnh `python`, tắt PowerShell, mở lại, rồi thử `py --version`.

**macOS**

Mở Terminal và chạy `python3 --version`. Chưa có Python thì cài từ https://www.python.org/downloads/macos/.

## 2. Tải code về máy

**Windows (PowerShell)**

```powershell
cd $HOME\Desktop
git clone -b cursor/dex-cex-spread-alert-2702 https://github.com/pdung113/t-i-li-u.git
cd t-i-li-u
```

Chưa có Git: vào https://git-scm.com/download/win , cài xong, đóng rồi mở lại PowerShell, chạy lại 3 lệnh trên.

**macOS / Linux**

```bash
cd ~/Desktop
git clone -b cursor/dex-cex-spread-alert-2702 https://github.com/pdung113/t-i-li-u.git
cd t-i-li-u
```

## 3. Cài thư viện của tool

Mỗi lần mở cửa sổ dòng lệnh mới, bạn phải vào đúng thư mục và bật môi trường ảo (dòng lệnh sẽ có `(.venv)` ở đầu).

**Windows (PowerShell)**

```powershell
cd $HOME\Desktop\t-i-li-u
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Nếu PowerShell chặn lệnh Activate, chạy một lần:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

rồi chạy lại `.venv\Scripts\Activate.ps1`.

**macOS / Linux**

```bash
cd ~/Desktop/t-i-li-u
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 4. Tạo bot Telegram và lấy 2 mã

### Mã bot (token)

1. Mở Telegram, tìm **@BotFather** (có dấu tích xanh).
2. Nhắn `/newbot`.
3. BotFather hỏi tên. Gõ tên bất kỳ, ví dụ `Canh bao gia`.
4. BotFather hỏi username. Username phải kết thúc bằng `bot`, ví dụ `canhbaogia_cua_ban_bot`.
5. BotFather trả một dòng token, dạng `7123456789:AAHxxxxxxxx`. Bấm để copy. Giữ kín token này.

### Mã cuộc trò chuyện (chat id)

1. Trong Telegram, mở đúng bot vừa tạo và bấm **Start**. Nếu không thấy nút Start, nhắn `/start`.
2. Nhắn thêm một tin, ví dụ `xin chao`.
3. Mở trình duyệt, dán địa chỉ này (thay token của bạn vào, không có dấu cách):

```text
https://api.telegram.org/bot7123456789:AAHxxxxxxxx/getUpdates
```

4. Trang hiện chữ JSON. Tìm `"chat":{"id":` và lấy con số ngay sau đó, ví dụ `5987654321`. Đó là chat id của bạn.

Nếu trang chỉ có `{"ok":true,"result":[]}` thì bot chưa nhận tin. Quay lại Telegram, nhắn `/start` thêm lần nữa, rồi tải lại trang.

## 5. Điền file cấu hình

Trong thư mục `t-i-li-u`, copy file mẫu thành `.env`.

**Windows**

```powershell
copy .env.example .env
notepad .env
```

**macOS / Linux**

```bash
cp .env.example .env
open -e .env
```

Trên Linux dùng `nano .env`.

Sửa hai dòng đầu. Không thêm dấu nháy, không thêm khoảng trắng:

```text
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxx
TELEGRAM_CHAT_ID=5987654321
```

Dòng `SPREAD_THRESHOLD_PCT=5` nghĩa là báo khi lệch từ 5%. Cứ để nguyên các dòng còn lại. Lưu file và đóng Notepad.

## 6. Chạy thử một vòng

Cửa sổ dòng lệnh phải đang ở thư mục `t-i-li-u` và có `(.venv)` ở đầu. Chưa có thì làm lại bước 3.

```powershell
python -m spread_alert --once
```

Đợi khoảng một phút. Tool đang tải giá, chưa bị treo.

Khi xong bạn sẽ thấy các dòng kiểu:

```text
Vũ trụ: 5000 hợp đồng trên 36 chain
Đối chiếu BTC Binance/ethereum: ... lệch -0.05%
Đối chiếu ETH Binance/ethereum: ... lệch -0.09%
```

BTC, ETH, SOL lệch quanh 0% là tool đang đọc đúng giá. Coin lệch từ 5% được ghi trong cửa sổ và gửi vào Telegram.

Tin đầu trên Telegram có dạng `Đã bật theo dõi` chỉ khi bạn chạy lệnh ở bước 7. Lệnh `--once` gửi từng cơ hội lệch từ 5%, không gửi tin khởi động.

## 7. Chạy liên tục (lệnh dùng hằng ngày)

```powershell
python -m spread_alert
```

Đây là chế độ nhanh nhất: quét hết một vòng là bắt đầu vòng sau ngay. Một vòng toàn bộ coin thường khoảng 45 giây đến 1 phút.

Telegram nhận tin `Đã bật theo dõi chênh lệch DEX / CEX`. Sau đó, mỗi coin lệch từ 5% là một tin. Cùng một coin không bị nhắn lại trong 15 phút, trừ khi lệch tăng thêm 2%.

Muốn dừng: bấm vào cửa sổ dòng lệnh rồi nhấn `Ctrl + C`.

Ngày hôm sau muốn chạy lại: mở PowerShell hoặc Terminal, vào thư mục, bật `.venv`, rồi chạy lại lệnh này. Không cần `pip install` lại.

**Windows**

```powershell
cd $HOME\Desktop\t-i-li-u
.venv\Scripts\Activate.ps1
python -m spread_alert
```

**macOS / Linux**

```bash
cd ~/Desktop/t-i-li-u
source .venv/bin/activate
python -m spread_alert
```

## 8. Đọc một tin nhắn

`Mua Gate.io → bán Uniswap (Ethereum)` nghĩa là giá mua trên Gate đang thấp hơn giá pool. Dòng `Liquidity DEX` là tổng thanh khoản của pool, kèm số coin đang nằm trong pool và vol DEX 24 giờ. Nếu token có tax, tin thêm dòng `Tax DEX` (mua, bán, hoặc chuyển). Token không có tax thì không có dòng này. Dòng `Chain DEX` ghi chain của pool DEX. Chữ xanh là cùng chain với sàn CEX. Chữ đỏ là khác chain. Dòng Rút và Nạp vẫn xanh khi đang mở, đỏ khi đang khóa. Phần trăm đã tính giá ask/bid nếu sàn có sổ lệnh. Chưa trừ phí rút coin, phí gas, và trượt giá khi mua số lượng lớn. Hãy tự kiểm tra pool và hợp đồng trước khi đặt lệnh.

## Việc hay gặp

| Bạn thấy | Cách xử lý |
| --- | --- |
| `python` không được nhận | Cài lại Python và bật **Add python.exe to PATH**. Đóng rồi mở lại PowerShell. |
| Không có `(.venv)` ở đầu dòng | Chạy lại lệnh Activate ở bước 3. |
| `Chưa có TELEGRAM_BOT_TOKEN` | File `.env` chưa điền, hoặc bạn đang đứng sai thư mục. |
| Telegram không tới, log có `Không gửi được Telegram` | Token hoặc chat id sai. Làm lại bước 4 và 5. Nhắn `/start` cho bot trước. |
| `{"ok":true,"result":[]}` khi mở getUpdates | Nhắn `/start` cho bot, rồi tải lại trang. |
| Bybit bị bỏ qua | Một số mạng chặn Bybit. Các sàn khác vẫn quét. |

Muốn mỗi vòng ngắn hơn, mở `.env` và thêm dòng này (xóa dấu `#` nếu dòng đã có sẵn):

```text
CHAINS=ethereum,bsc,solana,base,arbitrum
```

Lưu file, dừng tool bằng `Ctrl + C`, rồi chạy lại.
