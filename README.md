# 🎶 YT Jukebox – Phòng nghe nhạc chung (Cloudflare)

Website cố định: mọi người vào chọn bài YouTube, chat chung. Máy tính của Admin mở trang `/admin` để phát nhạc ra loa bằng tài khoản YouTube Premium.

Địa chỉ chính: **https://music.khai99.id.vn** (dự phòng: https://youtube3a.khaimain251099.workers.dev)

- `https://music.khai99.id.vn/` dành cho **khách**: nhập tên (và mã phòng nếu có), tìm bài, dán link, xếp hàng chờ, chat.
- `https://music.khai99.id.vn/admin` dành cho **Admin** (máy phát nhạc): cần mật khẩu. Trang này phát nhạc, điều khiển hàng chờ và hiện mã QR. Tin nhắn của Admin có màu vàng.

Toàn bộ chạy trên gói **miễn phí** của Cloudflare Workers và Durable Objects.

## Deploy lần đầu (khoảng 5 phút)

1. Vào https://dash.cloudflare.com và đăng nhập (tạo tài khoản miễn phí nếu chưa có).
2. Mở **Workers & Pages** → **Create application** → **Import a repository** (Continue with GitHub).
3. Cho Cloudflare truy cập GitHub, rồi chọn repo **youtube3a**.
4. Giữ nguyên các thiết lập:
   - Project name: `youtube3a` (phải trùng với `name` trong `wrangler.jsonc`)
   - Build command: *(để trống)*
   - Deploy command: `npx wrangler deploy`
5. Bấm **Deploy** và đợi khoảng 1 phút.
6. Vào Worker **youtube3a** → **Settings** → **Variables and Secrets** → **Add**. Thêm các biến sau, mỗi biến chọn loại **Secret**:

   | Tên | Giá trị |
   |---|---|
   | `YOUTUBE_API_KEY` | Key YouTube Data API v3 |
   | `HOST_PASSWORD` | Mật khẩu để mở trang `/admin` (tự đặt) |
   | `ROOM_PIN` | *(Không bắt buộc)* Mã phòng khách phải nhập, ví dụ `2468`. Để trống thì ai có link cũng vào được |

   Bấm **Deploy** để lưu.
7. *(Tuỳ chọn)* Gắn tên miền riêng: Worker → **Domains** → **Add Domain** → chọn tên miền → nhập tên miền con (ví dụ `music`).
8. Mở `https://music.khai99.id.vn/admin` trên máy tính, nhập mật khẩu rồi bấm **▶ Bắt đầu phát**.

Từ đó về sau, mỗi lần có commit mới lên nhánh `main`, Cloudflare tự deploy lại.

## Dùng hằng ngày
1. Máy tính: mở Chrome/Edge **đã đăng nhập YouTube Premium** → vào `/admin` → bấm **Bắt đầu phát**. Kết nối loa Bluetooth như bình thường.
2. Mọi người quét mã QR trên màn hình, dùng Wi-Fi nào hay 4G đều được. Nếu có mã phòng, mã QR đã kèm sẵn nên không cần gõ.
3. Để tab `/admin` mở suốt buổi. Có thể thu nhỏ cửa sổ.

Hàng chờ và chat được lưu trên Cloudflare, nên tắt máy rồi mở lại vẫn còn.

## Cấu hình thêm (trong `wrangler.jsonc` → `vars`)
| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MAX_SONGS_PER_USER` | Số bài tối đa mỗi người xếp chờ cùng lúc (0 = không giới hạn) | 3 |
| `MAX_DURATION_MIN` | Video dài tối đa bao nhiêu phút (0 = không giới hạn) | 15 |
| `MAX_SEARCHES_PER_DAY` | Giới hạn lượt tìm kiếm mỗi ngày (0 = không giới hạn). Có thể đổi trên trang `/admin` | 100 |

## Theo dõi hạn mức & đổi API key
Trang `/admin` có khung **Hạn mức YouTube API**:
- Số lượt **tìm kiếm** (search.list, mặc định 100 lượt/ngày) và **thêm bằng link** (videos.list, 10.000 đơn vị/ngày) mà website đã dùng hôm nay, giờ reset, lỗi gần nhất, biểu đồ 7 ngày.
- Nút ⚡ kiểm tra key, nút **Đổi key**: key mới được kiểm tra trước khi lưu và có hiệu lực ngay (ưu tiên hơn `YOUTUBE_API_KEY` trong Cloudflare). Có thể đổi giới hạn tìm kiếm mỗi ngày.
- Khi YouTube báo hết hạn mức (`quotaExceeded`), website tự nhận biết: trang khách hiện thông báo và chuyển sang chế độ tìm trên YouTube rồi dán link.

> Số liệu do website tự đếm cho key đang dùng. Nếu key đó còn được dùng ở nơi khác, con số thực tế trong Google Cloud Console sẽ cao hơn.
> Theo chính sách YouTube API, mỗi dịch vụ chỉ dùng một dự án Google Cloud; muốn thêm hạn mức hãy gửi *Audit and Quota Extension Form*.

## Lưu ý
- **Hạn mức YouTube API:** mức miễn phí là 10.000 đơn vị/ngày, mỗi lượt tìm tốn khoảng 101 đơn vị, tức khoảng 98 lượt/ngày. Kết quả tìm giống nhau được lưu tạm 1 giờ. Thêm bằng link chỉ tốn 1 đơn vị và không bị giới hạn. Hạn mức reset lúc 14–15h giờ Việt Nam.
- **Bảo mật key:** trong Google Cloud Console → Credentials, giới hạn key chỉ dùng cho *YouTube Data API v3*. Key nằm trong Secret của Cloudflare, khách không nhìn thấy, và không bao giờ được đưa lên GitHub.
- **Video bị chặn nhúng:** một số MV không cho phát ngoài youtube.com. Ô tìm kiếm đã tự lọc bớt; nếu vẫn gặp, máy phát tự chuyển bài.
- **Chạy thử trên máy:** đổi tên `.dev.vars.example` thành `.dev.vars`, điền key, rồi chạy `npx wrangler dev`.

## Cấu trúc
```
src/worker.js        Worker + Durable Object "Room" (hàng chờ, chat, WebSocket, gọi YouTube API)
public/index.html    Trang khách
public/admin.html    Trang Admin / máy phát (YouTube IFrame Player)
public/host.html     Chuyển hướng /host cũ sang /admin
public/static/       CSS + JS dùng chung
wrangler.jsonc       Cấu hình Cloudflare
```
