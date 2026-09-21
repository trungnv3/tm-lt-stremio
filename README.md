# Stremio Addon Tester

> Hướng dẫn xây dựng một Stremio Addon từ đầu dành cho người mới bắt đầu lập trình.

---

## 1. Giới thiệu

**Stremio Addon Tester** là tên dự án mẫu được sử dụng trong tài liệu này.

Đây **không phải tên bắt buộc**. Khi xây dựng addon của riêng mình, bạn có thể đặt bất kỳ tên nào, ví dụ:

```text
My Stremio Addon
Family Movies
My Media Library
Home Cinema
Anime Library
```

Mục tiêu của hướng dẫn là xây dựng một Stremio Addon có khả năng:

* Hiển thị danh sách phim.
* Hiển thị thông tin chi tiết phim.
* Hiển thị poster và backdrop.
* Tìm kiếm metadata từ TMDB.
* Đọc danh sách video từ Google Drive.
* Lưu catalog vào Cloudflare D1.
* Cung cấp stream cho Stremio.
* Proxy video thông qua Cloudflare Worker.
* Tự động cập nhật thư viện.
* Hỗ trợ nhiều thư viện Google Drive.
* Có trang quản trị đơn giản.
* Có cơ chế Reindex.
* Có Queue để xử lý thư viện lớn.
* Có Cron để tự động cập nhật.
* Có thể triển khai hoàn toàn trên Cloudflare.

---

# 2. Kiến trúc tổng thể

Mô hình tổng quát:

```text
                    ┌──────────────────┐
                    │      Stremio     │
                    └────────┬─────────┘
                             │
                             │ HTTP
                             ▼
                 ┌──────────────────────┐
                 │  Cloudflare Worker   │
                 │                      │
                 │ Manifest             │
                 │ Catalog              │
                 │ Meta                 │
                 │ Stream               │
                 │ Admin                │
                 └───────┬───────┬──────┘
                         │       │
              ┌──────────┘       └───────────┐
              ▼                              ▼
      ┌──────────────┐                ┌──────────────┐
      │ Cloudflare   │                │ Google Drive │
      │ D1 Database  │                │              │
      └──────────────┘                └──────────────┘
              │
              │
       ┌──────┴───────┐
       ▼              ▼
 ┌──────────┐   ┌──────────┐
 │   TMDB   │   │  Gemini  │
 │ Metadata │   │ Fallback │
 └──────────┘   └──────────┘
```

---

# 3. Luồng hoạt động

Khi người dùng mở addon trong Stremio:

```text
Stremio
   │
   ├── /manifest.json
   │
   ├── /catalog/...
   │
   ├── /meta/...
   │
   └── /stream/...
             │
             ▼
      Cloudflare Worker
             │
       ┌─────┴─────┐
       ▼           ▼
      D1       Google Drive
```

Khi cập nhật thư viện:

```text
Cron / Admin
      │
      ▼
 Reindex Job
      │
      ▼
 Cloudflare Queue
      │
      ▼
 Scan Google Drive
      │
      ▼
 Parse tên file
      │
      ├── TMDB
      │
      └── Gemini fallback
      │
      ▼
 Cloudflare D1
      │
      ▼
 Stremio Catalog
```

---

# 4. Những thành phần cần chuẩn bị

Để xây dựng hệ thống, cần chuẩn bị:

1. Máy tính Windows/macOS/Linux.
2. Tài khoản GitHub.
3. Tài khoản Cloudflare.
4. Google Cloud Project.
5. Google Drive.
6. TMDB API.
7. Gemini API nếu muốn sử dụng AI fallback.
8. Node.js.
9. Wrangler CLI.
10. Git.

---

# 5. Kiến thức cần biết

Không cần phải là lập trình viên chuyên nghiệp.

Nên biết những khái niệm cơ bản:

```text
File
Folder
URL
API
JSON
HTTP
JavaScript
Database
Cloudflare Worker
Git
GitHub
```

Trong quá trình làm, chỉ cần thực hiện từng bước theo hướng dẫn.

---

# 6. Cài đặt Node.js

Truy cập trang chính thức của Node.js và cài đặt phiên bản LTS.

Sau khi cài đặt, mở PowerShell:

```powershell
node -v
```

Kiểm tra npm:

```powershell
npm -v
```

Nếu cả hai lệnh trả về phiên bản thì Node.js đã hoạt động.

---

# 7. Cài đặt Git

Kiểm tra:

```powershell
git --version
```

Nếu chưa có Git, cài Git rồi mở lại PowerShell.

---

# 8. Cài đặt Wrangler

Wrangler là công cụ dòng lệnh dùng để quản lý Cloudflare Workers.

Cài đặt:

```powershell
npm install -g wrangler
```

Kiểm tra:

```powershell
wrangler --version
```

Đăng nhập Cloudflare:

```powershell
wrangler login
```

Trình duyệt sẽ mở để xác nhận tài khoản Cloudflare.

---

# 9. Tạo project

Tạo thư mục:

```powershell
mkdir stremio-addon-tester
cd stremio-addon-tester
```

Khởi tạo npm:

```powershell
npm init -y
```

Cài Wrangler:

```powershell
npm install -D wrangler
```

Tạo thư mục source:

```powershell
mkdir src
```

Cấu trúc ban đầu:

```text
stremio-addon-tester/
│
├── src/
│
├── package.json
│
└── wrangler.jsonc
```

---

# 10. Tạo Cloudflare Worker

Tạo Worker với tên tùy ý.

Ví dụ:

```text
YOUR_WORKER_NAME
```

Không nhất thiết phải dùng tên:

```text
stremio-addon-tester
```

Bạn có thể đặt:

```text
my-stremio-addon
```

hoặc:

```text
family-media-addon
```

---

# 11. File wrangler.jsonc

Một cấu hình cơ bản:

```json
{
  "$schema": "node_modules/wrangler/config-schema.json",

  "name": "YOUR_WORKER_NAME",

  "main": "src/index.js",

  "compatibility_date": "YYYY-MM-DD"
}
```

Sau này có thể bổ sung:

* D1
* Cron
* Queue
* Durable Objects nếu cần
* các binding khác

---

# 12. Tạo Cloudflare D1

D1 là database SQL của Cloudflare.

Tạo database:

```powershell
npx wrangler d1 create YOUR_DATABASE_NAME
```

Cloudflare sẽ trả về thông tin database.

Ví dụ:

```text
database_name = YOUR_DATABASE_NAME
database_id   = YOUR_DATABASE_ID
```

Không đưa ID thật của database cá nhân vào README công khai.

---

# 13. Khai báo D1

Trong `wrangler.jsonc`:

```json
{
  "$schema": "node_modules/wrangler/config-schema.json",

  "name": "YOUR_WORKER_NAME",

  "main": "src/index.js",

  "compatibility_date": "YYYY-MM-DD",

  "d1_databases": [
    {
      "binding": "stremio_db",
      "database_name": "YOUR_DATABASE_NAME",
      "database_id": "YOUR_DATABASE_ID"
    }
  ]
}
```

Trong JavaScript có thể truy cập:

```javascript
env.stremio_db
```

---

# 14. Thiết kế database

Một addon đơn giản có thể bắt đầu với bảng:

```text
libraries
movies
streams
reindex_jobs
```

---

## 14.1. Bảng libraries

Dùng để lưu các thư viện Google Drive.

```sql
CREATE TABLE libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  folder_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 14.2. Bảng movies

Lưu thông tin phim.

```sql
CREATE TABLE movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  library_id INTEGER NOT NULL,

  drive_file_id TEXT NOT NULL,
  drive_parent_id TEXT,
  drive_name TEXT NOT NULL,
  drive_mime_type TEXT,
  drive_size INTEGER,
  drive_modified_time TEXT,

  title TEXT NOT NULL,
  year INTEGER,

  tmdb_id INTEGER,
  tmdb_type TEXT,

  poster_url TEXT,
  backdrop_url TEXT,
  overview TEXT,
  genres TEXT,

  is_active INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  vote_average REAL DEFAULT 0
);
```

---

## 14.3. Bảng streams

Dùng để lưu thông tin stream.

Ví dụ:

```sql
CREATE TABLE streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  movie_id INTEGER NOT NULL,

  drive_file_id TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 14.4. Bảng reindex_jobs

Theo dõi quá trình cập nhật thư viện:

```sql
CREATE TABLE reindex_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  library_id INTEGER NOT NULL,

  status TEXT NOT NULL,

  started_at TEXT NOT NULL,

  finished_at TEXT,

  files_found INTEGER DEFAULT 0,

  files_added INTEGER DEFAULT 0,

  files_updated INTEGER DEFAULT 0,

  files_removed INTEGER DEFAULT 0,

  error_message TEXT
);
```

---

# 15. Google Drive

Addon có thể sử dụng Google Drive làm nguồn lưu trữ video.

Mô hình:

```text
Google Drive
│
└── Thư mục thư viện
    │
    ├── Phim A
    ├── Phim B
    ├── Phim C
    │
    └── Các thư mục con
        ├── Phim D
        └── Phim E
```

Addon có thể quét đệ quy toàn bộ thư mục.

---

# 16. Google Cloud Project

Truy cập Google Cloud Console.

Tạo project riêng cho addon.

Ví dụ:

```text
YOUR_GOOGLE_PROJECT
```

Không bắt buộc phải dùng tên này.

---

# 17. Google Drive API

Trong Google Cloud:

```text
APIs & Services
        │
        └── Library
             │
             └── Google Drive API
```

Bật:

```text
Google Drive API
```

---

# 18. Service Account

Tạo Service Account.

Ví dụ:

```text
stremio-addon-service
```

Service Account sẽ có:

```text
client_email
private_key
```

Các thông tin này phải được bảo mật.

**Không commit private key lên GitHub.**

---

# 19. Chia sẻ Google Drive

Chia sẻ thư mục thư viện cho email của Service Account.

Ví dụ:

```text
YOUR_SERVICE_ACCOUNT_EMAIL
```

Chỉ nên cấp quyền cần thiết.

Nếu addon chỉ đọc video:

```text
Viewer
```

thường là đủ.

---

# 20. Google Drive Folder ID

Một URL Google Drive:

```text
https://drive.google.com/drive/folders/XXXXXXXXXXXXXXXX
```

Phần:

```text
XXXXXXXXXXXXXXXX
```

là Folder ID.

Có thể cho người dùng nhập:

```text
Folder ID
```

hoặc:

```text
Full Google Drive URL
```

Addon sẽ tự lấy Folder ID.

---

# 21. Lưu Google Credentials

Không viết private key trực tiếp vào source code.

Sử dụng Cloudflare Secrets.

Ví dụ:

```powershell
npx wrangler secret put GDRIVE_CLIENT_EMAIL
```

và:

```powershell
npx wrangler secret put GDRIVE_PRIVATE_KEY
```

Trong Worker:

```javascript
env.GDRIVE_CLIENT_EMAIL
env.GDRIVE_PRIVATE_KEY
```

---

# 22. Xử lý Private Key

Một số môi trường lưu private key dưới dạng:

```text
-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

Có thể chuẩn hóa:

```javascript
function normalizePrivateKey(key) {
  return key.replace(/\\n/g, "\n");
}
```

---

# 23. TMDB

TMDB dùng để lấy metadata phim.

Thông tin có thể lấy:

```text
Tên phim
Năm
Poster
Backdrop
Overview
Genre
Rating
TMDB ID
```

Tạo TMDB API Key.

Không đưa API Key thật lên GitHub.

Lưu bằng Cloudflare Secret:

```powershell
npx wrangler secret put TMDB_API_KEY
```

Trong Worker:

```javascript
env.TMDB_API_KEY
```

---

# 24. Gemini

Gemini không bắt buộc.

Có thể sử dụng Gemini làm fallback khi parser không xác định được tên phim.

Ví dụ tên file:

```text
Movie.Name.2024.1080p.WEB-DL.x264.mkv
```

Parser cố gắng xử lý trước.

Nếu không xác định được:

```text
Parser
   │
   ├── Thành công → TMDB
   │
   └── Không chắc chắn
             │
             ▼
          Gemini
             │
             ▼
            TMDB
```

API Key:

```powershell
npx wrangler secret put GEMINI_API_KEY
```

---

# 25. Parser

Tên file video thường chứa nhiều thông tin kỹ thuật.

Ví dụ:

```text
Movie.Name.2024.1080p.WEB-DL.x264-GROUP.mkv
```

Không nên gửi nguyên tên file cho TMDB.

Parser cần loại bỏ:

```text
1080p
2160p
720p
WEB-DL
WEBRip
BluRay
BDRip
HDR
HDR10
x264
x265
HEVC
AAC
DTS
5.1
7.1
GROUP
```

Sau khi xử lý:

```text
Movie Name
```

---

# 26. Xử lý năm

Ví dụ:

```text
Movie.Name.2024.1080p.mkv
```

Parser nhận:

```text
title = Movie Name
year  = 2024
```

Năm có thể được dùng để tăng độ chính xác khi tìm TMDB.

---

# 27. Xử lý số phần

Một số tên phim có dạng:

```text
Hotel Transylvania 1
```

Trong một số trường hợp số cuối là số phần chứ không phải một phần của tên phim.

Parser có thể xử lý:

```text
Hotel Transylvania 1
```

thành:

```text
Hotel Transylvania
```

Tuy nhiên không nên xóa số một cách máy móc.

Ví dụ:

```text
Captain Underpants The First Epic Movie
```

không được xử lý thành tên sai.

Vì vậy parser nên có các quy tắc bảo vệ.

---

# 28. TMDB Search

Sau khi parser tạo được:

```text
title
year
```

Worker gọi TMDB.

Ví dụ:

```text
title = Only Yesterday
year  = 1991
```

TMDB có thể trả về nhiều kết quả.

Không nên chọn kết quả đầu tiên một cách mù quáng.

---

# 29. Chọn kết quả TMDB

Có thể xây dựng hệ thống tính điểm:

```text
Tên trùng chính xác
Tên gần giống
Năm trùng
Có poster
Popularity
Vote count
```

Ví dụ logic:

```text
Exact title       +500
Compact title     +480
Year exact        +300
Poster            + điểm
Vote count        + điểm
Popularity        + điểm
```

Đồng thời loại các kết quả không phải nội dung chính:

```text
Making of
Behind the Scenes
Featurette
Interview
Trailer
Teaser
Short
Special
Documentary
Extras
Bonus
Production
```

Mục tiêu là chọn **phim chính**, thay vì video hậu trường hoặc nội dung phụ.

---

# 30. Movie và Series

Stremio có thể sử dụng:

```text
movie
series
```

Ví dụ:

```text
Movie
  └── /meta/movie/...

Series
  └── /meta/series/...
```

Nếu hệ thống chỉ quản lý phim điện ảnh, có thể bắt đầu với:

```text
movie
```

Sau đó mở rộng sang series.

---

# 31. Manifest

Manifest là thành phần quan trọng nhất của Stremio Addon.

Ví dụ:

```json
{
  "id": "YOUR_ADDON_ID",
  "version": "1.0.0",
  "name": "YOUR_ADDON_NAME",
  "description": "YOUR_ADDON_DESCRIPTION",

  "resources": [
    "catalog",
    "meta",
    "stream"
  ],

  "types": [
    "movie"
  ],

  "catalogs": [
    {
      "type": "movie",
      "id": "movies",
      "name": "Phim"
    }
  ]
}
```

---

# 32. Các endpoint chính

Một addon cơ bản cần:

```text
/manifest.json
/catalog/...
/meta/...
/stream/...
```

Ví dụ:

```text
GET /manifest.json

GET /catalog/movie/movies.json

GET /meta/movie/tt1234567.json

GET /stream/movie/tt1234567.json
```

---

# 33. Catalog

Catalog trả về danh sách phim.

Ví dụ:

```json
{
  "metas": [
    {
      "id": "tt1234567",
      "type": "movie",
      "name": "Example Movie",
      "poster": "https://example.com/poster.jpg"
    }
  ]
}
```

Stremio sử dụng dữ liệu này để hiển thị danh sách.

---

# 34. Meta

Meta trả về thông tin chi tiết.

Ví dụ:

```json
{
  "meta": {
    "id": "tt1234567",
    "type": "movie",
    "name": "Example Movie",
    "year": 2024,
    "poster": "https://example.com/poster.jpg",
    "background": "https://example.com/backdrop.jpg",
    "description": "Example description."
  }
}
```

---

# 35. Stream

Stream trả về nguồn phát.

Ví dụ:

```json
{
  "streams": [
    {
      "name": "Google Drive",
      "title": "Example Movie",
      "url": "https://YOUR_WORKER_URL/file/YOUR_FILE_ID"
    }
  ]
}
```

---

# 36. Google Drive Proxy

Không nên đưa trực tiếp mọi thông tin nội bộ của Google Drive cho client.

Worker có thể tạo route:

```text
/file/:fileId
```

Ví dụ:

```text
https://YOUR_WORKER_URL/file/FILE_ID
```

Worker nhận request:

```text
Stremio
   │
   ▼
Cloudflare Worker
   │
   ▼
Google Drive
   │
   ▼
Video
```

---

# 37. HTTP Range

Video streaming thường cần hỗ trợ:

```text
Range
Content-Range
Accept-Ranges
Content-Length
```

Đặc biệt khi tua video.

Worker cần chuyển tiếp các header phù hợp giữa Stremio và Google Drive.

Nếu không xử lý Range đúng, có thể gặp:

```text
Không tua được
Video không phát
Video tải toàn bộ
Playback bị giật
```

---

# 38. Kiểm tra endpoint

Trước khi đưa vào Stremio, nên kiểm tra từng endpoint.

Ví dụ:

```text
https://YOUR_WORKER_URL/manifest.json
```

Sau đó:

```text
https://YOUR_WORKER_URL/catalog/movie/movies.json
```

Tiếp theo:

```text
https://YOUR_WORKER_URL/meta/movie/...
```

Cuối cùng:

```text
https://YOUR_WORKER_URL/stream/movie/...
```

---

# 39. Local Development

Nên test local trước khi deploy production.

Chạy:

```powershell
npx wrangler dev
```

Thông thường Worker sẽ chạy tại:

```text
http://localhost:8787
```

Kiểm tra:

```text
http://localhost:8787/
```

và:

```text
http://localhost:8787/manifest.json
```

---

# 40. Kiểm tra D1 local

Nếu sử dụng D1 local:

```powershell
npx wrangler d1 execute YOUR_DATABASE_NAME --local --command="SELECT * FROM movies LIMIT 10"
```

Ví dụ:

```powershell
npx wrangler d1 execute YOUR_DATABASE_NAME --local --command="SELECT COUNT(*) AS total FROM movies"
```

---

# 41. Kiểm tra D1 production

Khi muốn kiểm tra database thật:

```powershell
npx wrangler d1 execute YOUR_DATABASE_NAME --remote --command="SELECT COUNT(*) AS total FROM movies"
```

Cần phân biệt:

```text
--local
```

và:

```text
--remote
```

### Local

```text
Database trên máy
```

### Remote

```text
Database Cloudflare thật
```

---

# 42. Quy trình test local

Nên sử dụng quy trình:

```text
Sửa code
   │
   ▼
Lưu file
   │
   ▼
npx wrangler dev
   │
   ▼
Test API
   │
   ▼
Kiểm tra log
   │
   ▼
Sửa lỗi
   │
   ▼
Test lại
```

Chỉ khi local hoạt động ổn định mới deploy.

---

# 43. Test Manifest

Kiểm tra:

```text
/manifest.json
```

Phải trả về JSON hợp lệ.

Kiểm tra:

```powershell
curl http://localhost:8787/manifest.json
```

---

# 44. Test Catalog

Kiểm tra:

```text
/catalog/movie/movies.json
```

Cần kiểm tra:

* Có dữ liệu.
* ID đúng.
* Tên đúng.
* Poster hoạt động.
* Type đúng.

---

# 45. Test Meta

Lấy một ID từ catalog.

Ví dụ:

```text
example-id
```

Kiểm tra:

```text
/meta/movie/example-id.json
```

Cần kiểm tra:

```text
Tên phim
Năm
Poster
Backdrop
Overview
Rating
```

---

# 46. Test Stream

Kiểm tra:

```text
/stream/movie/example-id.json
```

Cần có:

```json
{
  "streams": [
    {
      "name": "...",
      "title": "...",
      "url": "https://..."
    }
  ]
}
```

---

# 47. Reindex

Reindex là quá trình quét lại thư viện.

Ví dụ:

```text
Google Drive
      │
      ▼
Scan
      │
      ▼
106 files
      │
      ▼
Parser
      │
      ▼
TMDB
      │
      ▼
D1
```

---

# 48. Tại sao cần Reindex?

Khi thư viện thay đổi:

```text
Thêm phim
Xóa phim
Đổi tên phim
Thay file
Thêm thư mục
```

Addon cần biết thay đổi đó.

Reindex giúp đồng bộ:

```text
Google Drive
       ↕
      D1
```

---

# 49. Chỉ xử lý file thay đổi

Không nên gọi TMDB cho toàn bộ thư viện mỗi lần.

Có thể lưu:

```text
drive_name
drive_modified_time
```

Lần sau so sánh:

```text
Tên file cũ
Tên file mới

Modified time cũ
Modified time mới
```

Nếu không thay đổi:

```text
Skip
```

Nếu thay đổi:

```text
Process
```

Điều này giúp giảm:

* thời gian xử lý
* số lần gọi API
* chi phí
* tải hệ thống

---

# 50. Reindex Job

Nên lưu trạng thái Reindex vào D1.

Ví dụ:

```text
queued
running
completed
completed_with_errors
failed
```

Có thể lưu:

```text
files_found
files_added
files_updated
files_removed
started_at
finished_at
error_message
```

---

# 51. Cloudflare Queue

Khi thư viện nhỏ, có thể xử lý trực tiếp.

Nhưng với thư viện lớn, nên chia thành nhiều batch.

Ví dụ:

```text
106 files
```

chia:

```text
Batch 1 → 0–4
Batch 2 → 5–9
Batch 3 → 10–14
...
```

Queue sẽ xử lý từng batch.

---

# 52. Luồng Queue

```text
Admin
  │
  ▼
Create Reindex Job
  │
  ▼
Queue
  │
  ▼
Batch 1
  │
  ▼
Batch 2
  │
  ▼
Batch 3
  │
  ▼
...
  │
  ▼
Completed
```

---

# 53. Batch Size

Có thể chọn:

```text
5
10
20
50
```

Tùy vào:

* số lượng file
* thời gian Worker
* giới hạn API
* tốc độ xử lý

Với hệ thống mới, batch nhỏ thường dễ kiểm soát hơn.

---

# 54. Cron

Cloudflare Worker có thể chạy tự động theo lịch.

Ví dụ muốn chạy:

```text
06:00 mỗi ngày
```

Nếu cấu hình theo UTC:

```text
23:00 UTC
```

tương ứng với:

```text
06:00 UTC+7
```

Ví dụ:

```json
{
  "triggers": {
    "crons": [
      "0 23 * * *"
    ]
  }
}
```

Khi sử dụng Cron, cần kiểm tra múi giờ và daylight-saving nếu hệ thống triển khai ở khu vực có thay đổi giờ.

---

# 55. Admin Panel

Có thể xây dựng một trang quản trị ngay trong Worker.

Ví dụ:

```text
/admin
```

Trang quản trị có thể cho phép:

```text
Xem thư viện
Thêm thư viện
Xóa thư viện
Reindex
Xem trạng thái Reindex
```

---

# 56. Quản lý nhiều Google Drive

Thay vì chỉ có một thư viện:

```text
Google Drive
└── Library A
```

có thể hỗ trợ:

```text
Library A
Library B
Library C
Library D
```

Dữ liệu được lưu trong bảng:

```text
libraries
```

Mỗi thư viện có:

```text
id
name
folder_id
folder_url
enabled
```

---

# 57. Thêm thư viện

Admin có thể nhập:

```text
Tên thư viện
```

và:

```text
Folder ID
```

hoặc:

```text
Google Drive Folder URL
```

Ví dụ:

```text
Tên:
Phim hoạt hình

Folder:
https://drive.google.com/drive/folders/XXXXXXXX
```

Worker sẽ lấy:

```text
folder_id
```

và lưu vào D1.

---

# 58. Xóa thư viện

Khi xóa một thư viện, cần xác định rõ cách xử lý dữ liệu:

### Cách 1

Xóa thư viện và toàn bộ catalog liên quan.

### Cách 2

Chỉ vô hiệu hóa:

```text
enabled = 0
```

Cách thứ hai thường dễ khôi phục hơn.

---

# 59. REINDEX_SECRET

Nếu Admin có chức năng Reindex, không nên để API mở hoàn toàn.

Có thể sử dụng:

```text
REINDEX_SECRET
```

Client gửi:

```http
Authorization: Bearer YOUR_REINDEX_SECRET
```

Worker kiểm tra:

```javascript
const auth = request.headers.get("Authorization");

if (auth !== `Bearer ${env.REINDEX_SECRET}`) {
  return new Response("Unauthorized", {
    status: 401
  });
}
```

---

# 60. Nguyên tắc bảo mật

Không lưu secret trong:

```text
localStorage
sessionStorage
cookie
HTML
JavaScript public
GitHub
README
```

Không commit:

```text
API Key
Private Key
Service Account JSON
REINDEX_SECRET
```

Sử dụng:

```text
Cloudflare Secrets
```

---

# 61. Admin HTTPS

Admin nên được sử dụng qua:

```text
HTTPS
```

Không nên truyền secret qua HTTP không mã hóa.

Không đưa secret thật vào URL:

```text
/admin?secret=...
```

Không đưa secret vào:

```text
GitHub
README
Screenshot
```

---

# 62. Escape HTML

Nếu Admin UI hiển thị dữ liệu do người dùng nhập, cần escape HTML.

Ví dụ:

```javascript
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
```

Điều này giúp hạn chế việc dữ liệu được nhập vào được trình duyệt hiểu như HTML/JavaScript.

---

# 63. Trạng thái Reindex

Admin có thể hiển thị:

```text
Đang chờ
Đang xử lý
Hoàn thành
Hoàn thành có lỗi
Thất bại
```

Ví dụ:

```text
Reindex

106 files found
100 added
5 updated
1 removed

Status: Completed
```

---

# 64. API kiểm tra trạng thái

Có thể tạo:

```text
GET /admin/reindex/status/:jobId
```

API trả về:

```json
{
  "status": "ok",
  "job": {
    "id": 1,
    "status": "completed",
    "files_found": 106,
    "files_added": 100,
    "files_updated": 5,
    "files_removed": 1
  }
}
```

Admin có thể polling endpoint này để cập nhật giao diện.

---

# 65. Cấu trúc project đề xuất

```text
stremio-addon-tester/
│
├── src/
│   ├── index.js
│   ├── drive.js
│   ├── parser.js
│   ├── tmdb.js
│   └── gemini.js
│
├── migrations/
│   └── 0001_initial.sql
│
├── package.json
├── wrangler.jsonc
├── README.md
└── .gitignore
```

---

# 66. Vai trò của từng file

## index.js

Xử lý:

```text
HTTP request
Manifest
Catalog
Meta
Stream
Admin
Reindex
Queue
Cron
```

---

## drive.js

Xử lý:

```text
Google authentication
Drive API
Folder
File
Recursive scan
Download/stream
```

---

## parser.js

Xử lý:

```text
Tên file
Năm
Tên phim
Technical tags
TMDB ID
```

---

## tmdb.js

Xử lý:

```text
TMDB Search
TMDB Details
Movie metadata
Series metadata
```

---

## gemini.js

Xử lý:

```text
Tên file khó
Phân tích tên phim
Fallback
```

---

# 67. .gitignore

Không commit các file nhạy cảm.

Ví dụ:

```gitignore
node_modules/

.wrangler/

.env
.env.*
*.json.key
service-account.json

.DS_Store
Thumbs.db
```

---

# 68. GitHub

Khởi tạo Git:

```powershell
git init
```

Thêm file:

```powershell
git add .
```

Commit:

```powershell
git commit -m "Initial Stremio addon"
```

Đổi branch:

```powershell
git branch -M main
```

Thêm remote:

```powershell
git remote add origin YOUR_GITHUB_REPOSITORY_URL
```

Push:

```powershell
git push -u origin main
```

---

# 69. Quy trình phát triển sau này

Sau khi project đã hoạt động:

```text
Sửa code
   ↓
Test local
   ↓
Kiểm tra log
   ↓
Test API
   ↓
Test Stremio
   ↓
Git commit
   ↓
Git push
   ↓
Deploy Cloudflare
```

---

# 70. Không nên sửa trực tiếp production

Không nên:

```text
Sửa code
    ↓
Deploy ngay
```

Nên:

```text
Local
  ↓
Test
  ↓
Git
  ↓
Deploy
  ↓
Production test
```

---

# 71. Deploy Cloudflare

Khi local hoạt động:

```powershell
npx wrangler deploy
```

Sau khi deploy, Cloudflare sẽ cung cấp Worker URL.

Ví dụ:

```text
https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev
```

Không cần sử dụng URL mẫu này trong README cá nhân.

---

# 72. Kiểm tra production

Sau deploy:

```text
/manifest.json
```

sau đó:

```text
/catalog/...
```

sau đó:

```text
/meta/...
```

và:

```text
/stream/...
```

---

# 73. Cài addon vào Stremio

Trong Stremio:

```text
Addons
   ↓
Community Addons
   ↓
Install via URL
```

Nhập:

```text
https://YOUR_WORKER_URL/manifest.json
```

Sau đó cài addon.

---

# 74. Kiểm tra theo thứ tự

Không nên kiểm tra tất cả cùng lúc.

Thứ tự nên là:

```text
1. Worker
2. Manifest
3. D1
4. Google Drive
5. Parser
6. TMDB
7. Catalog
8. Meta
9. Stream
10. Playback
11. Reindex
12. Queue
13. Cron
14. Admin
```

---

# 75. Các lỗi thường gặp

## Lỗi 1: Worker không chạy

Kiểm tra:

```powershell
npx wrangler dev
```

Xem log.

---

## Lỗi 2: D1 không tìm thấy

Kiểm tra:

```text
wrangler.jsonc
```

Đảm bảo:

```text
database_name
database_id
binding
```

đúng.

---

## Lỗi 3: Google Drive không đọc được

Kiểm tra:

```text
Service Account
```

và quyền của folder.

Folder phải được chia sẻ cho Service Account.

---

## Lỗi 4: Private key lỗi

Kiểm tra ký tự:

```text
\n
```

và xử lý bằng:

```javascript
replace(/\\n/g, "\n")
```

---

## Lỗi 5: TMDB trả sai phim

Không nên chọn kết quả đầu tiên.

Kiểm tra:

```text
title
year
TMDB result
```

Nên có hệ thống scoring và loại nội dung phụ.

---

## Lỗi 6: Catalog rỗng

Kiểm tra:

```text
SELECT COUNT(*) FROM movies;
```

Nếu:

```text
0
```

thì cần kiểm tra Reindex.

---

## Lỗi 7: Meta sai

Kiểm tra:

```text
tmdb_id
tmdb_type
```

trong D1.

---

## Lỗi 8: Stream có URL nhưng không phát

Kiểm tra:

```text
Stream URL
HTTP status
Range request
Content-Range
Google Drive permissions
```

---

## Lỗi 9: Reindex lỗi

Kiểm tra bảng:

```text
reindex_jobs
```

Ví dụ:

```sql
SELECT *
FROM reindex_jobs
ORDER BY id DESC
LIMIT 10;
```

---

## Lỗi 10: Queue không chạy

Kiểm tra:

```text
Queue name
Producer binding
Consumer
wrangler.jsonc
```

---

# 76. Quy trình debug

Khi có lỗi:

```text
Xác định lỗi xảy ra ở đâu
          ↓
Worker?
          ↓
D1?
          ↓
Google Drive?
          ↓
Parser?
          ↓
TMDB?
          ↓
Stream?
          ↓
Stremio?
```

Không nên sửa nhiều phần cùng lúc.

---

# 77. Logging

Trong quá trình phát triển có thể sử dụng:

```javascript
console.log(...)
```

Ví dụ:

```javascript
console.log("Processing file:", file.name);
```

Hoặc:

```javascript
console.log("TMDB result:", result);
```

Khi production ổn định, nên giảm các log không cần thiết.

---

# 78. Kiểm tra dữ liệu D1

Một số câu lệnh hữu ích:

### Đếm phim

```sql
SELECT COUNT(*) AS total
FROM movies;
```

### Xem phim

```sql
SELECT
  id,
  title,
  year,
  tmdb_id,
  is_active
FROM movies
LIMIT 20;
```

### Xem thư viện

```sql
SELECT *
FROM libraries;
```

### Xem Reindex

```sql
SELECT *
FROM reindex_jobs
ORDER BY id DESC
LIMIT 10;
```

---

# 79. Backup

Trước khi thực hiện thay đổi lớn:

```text
Database
Source code
wrangler.jsonc
Migration
```

nên được lưu lại.

Đặc biệt:

```text
Không xóa database production
```

chỉ để thử nghiệm.

---

# 80. Migration

Khi database thay đổi, nên tạo migration mới.

Ví dụ:

```text
migrations/
│
├── 0001_initial.sql
├── 0002_add_rating.sql
└── 0003_add_library_status.sql
```

Không nên tùy tiện sửa lịch sử migration đã chạy production.

---

# 81. Thứ tự xây dựng addon từ đầu

Nếu là người mới, nên làm theo thứ tự:

```text
Bước 1
Cài Node.js

Bước 2
Cài Git

Bước 3
Cài Wrangler

Bước 4
Tạo Cloudflare Worker

Bước 5
Tạo GitHub repository

Bước 6
Tạo D1

Bước 7
Tạo Google Cloud Project

Bước 8
Bật Google Drive API

Bước 9
Tạo Service Account

Bước 10
Chia sẻ Google Drive

Bước 11
Tạo TMDB API

Bước 12
Tạo Gemini API nếu cần

Bước 13
Viết Drive scanner

Bước 14
Viết parser

Bước 15
Kết nối TMDB

Bước 16
Tạo database

Bước 17
Tạo Manifest

Bước 18
Tạo Catalog

Bước 19
Tạo Meta

Bước 20
Tạo Stream

Bước 21
Tạo Drive Proxy

Bước 22
Test local

Bước 23
Tạo Reindex

Bước 24
Tạo Queue

Bước 25
Tạo Cron

Bước 26
Tạo Admin

Bước 27
Test production

Bước 28
Cài vào Stremio
```

---

# 82. Phiên bản tối thiểu

Không cần xây dựng tất cả ngay từ đầu.

Có thể bắt đầu bằng:

```text
Worker
  │
  ├── manifest
  ├── catalog
  ├── meta
  └── stream
```

Sau khi hoạt động mới thêm:

```text
D1
Google Drive
TMDB
Reindex
Queue
Cron
Admin
Gemini
```

---

# 83. Phiên bản nâng cao

Sau khi hệ thống cơ bản chạy ổn, có thể thêm:

```text
Search
Genres
Collections
Series
Episodes
Multiple libraries
Admin dashboard
Progress
Queue
Cron
Caching
Statistics
User authentication
Subtitle
External metadata
```

---

# 84. Nguyên tắc thiết kế

## Nguyên tắc 1

Mỗi thành phần chỉ nên làm một nhiệm vụ.

```text
Parser → parse
TMDB → metadata
Drive → storage
D1 → database
Worker → API
Queue → background jobs
```

---

## Nguyên tắc 2

Không đưa secret vào source code.

---

## Nguyên tắc 3

Không deploy khi chưa test local.

---

## Nguyên tắc 4

Không xử lý lại toàn bộ dữ liệu nếu không cần thiết.

---

## Nguyên tắc 5

Luôn kiểm tra dữ liệu trước khi ghi database.

---

## Nguyên tắc 6

Luôn có log khi debug.

---

## Nguyên tắc 7

Không phụ thuộc vào một API duy nhất nếu có thể có fallback.

---

# 85. Bảo mật project công khai

Nếu GitHub repository là Public:

**KHÔNG đưa vào repository:**

```text
TMDB API Key
Gemini API Key
Google Service Account Private Key
Google Service Account JSON
REINDEX_SECRET
Cloudflare API Token
Database credentials
Private URLs
Private folder IDs
```

Có thể đưa:

```text
README
Source code
Migration
Example config
Public documentation
```

---

# 86. Sử dụng placeholder

README công khai nên sử dụng:

```text
YOUR_ADDON_NAME
YOUR_WORKER_NAME
YOUR_DATABASE_NAME
YOUR_DATABASE_ID
YOUR_QUEUE_NAME
YOUR_GOOGLE_PROJECT
YOUR_GOOGLE_DRIVE_FOLDER_ID
YOUR_TMDB_API_KEY
YOUR_GEMINI_API_KEY
YOUR_REINDEX_SECRET
YOUR_GITHUB_REPOSITORY_URL
YOUR_WORKER_URL
```

Người dùng tự thay bằng thông tin của họ.

---

# 87. Ví dụ cấu hình trung lập

Không sử dụng:

```text
Tên cá nhân
Tên công ty
Tên thư viện riêng
URL Worker thật
Database ID thật
Drive Folder ID thật
API Key thật
```

Thay vào đó:

```text
Addon:
YOUR_ADDON_NAME

Worker:
YOUR_WORKER_NAME

Database:
YOUR_DATABASE_NAME

Drive:
YOUR_GOOGLE_DRIVE_FOLDER_ID
```

---

# 88. Quy trình thay đổi code

Sau khi project đã hoạt động:

```text
1. Mở project
        ↓
2. Sửa code
        ↓
3. Lưu
        ↓
4. Chạy local
        ↓
5. Test API
        ↓
6. Test Stremio
        ↓
7. git status
        ↓
8. git add .
        ↓
9. git commit
        ↓
10. git push
        ↓
11. Deploy Cloudflare
        ↓
12. Test production
```

---

# 89. Các lệnh Git thường dùng

Xem trạng thái:

```powershell
git status
```

Xem thay đổi:

```powershell
git diff
```

Thêm file:

```powershell
git add .
```

Commit:

```powershell
git commit -m "Update addon"
```

Push:

```powershell
git push
```

Xem lịch sử:

```powershell
git log --oneline
```

---

# 90. Khi muốn quay lại phiên bản cũ

Kiểm tra:

```powershell
git log --oneline
```

Tìm commit cần quay lại.

Không nên xóa lịch sử Git một cách tùy tiện.

Có thể sử dụng:

```powershell
git revert
```

để tạo commit đảo ngược thay đổi.

---

# 91. Checklist trước khi Deploy

## Code

```text
[ ] Không có lỗi JavaScript
[ ] Không có API Key trong source
[ ] Không có private key
[ ] Không có secret
[ ] Parser hoạt động
```

## Database

```text
[ ] D1 đúng
[ ] Migration đúng
[ ] Schema đúng
[ ] Không dùng sai tên column
```

## Google Drive

```text
[ ] Service Account hoạt động
[ ] Folder đã chia sẻ
[ ] Drive API đã bật
[ ] Scanner hoạt động
```

## TMDB

```text
[ ] API Key hoạt động
[ ] Search hoạt động
[ ] Metadata hoạt động
```

## Stremio

```text
[ ] Manifest
[ ] Catalog
[ ] Meta
[ ] Stream
```

## Playback

```text
[ ] Stream URL hoạt động
[ ] HTTP 200/206
[ ] Range hoạt động
[ ] Video phát được
[ ] Có thể tua
```

---

# 92. Checklist Production

```text
[ ] Worker deployed
[ ] D1 remote hoạt động
[ ] Secrets đã cấu hình
[ ] Queue hoạt động
[ ] Cron hoạt động
[ ] Admin hoạt động
[ ] Reindex hoạt động
[ ] Catalog hoạt động
[ ] Meta hoạt động
[ ] Stream hoạt động
[ ] Stremio playback hoạt động
```

---

# 93. Kiến trúc hoàn chỉnh

Sau khi hoàn thành:

```text
                       ┌──────────────┐
                       │   Stremio    │
                       └──────┬───────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ Cloudflare       │
                    │ Worker           │
                    ├──────────────────┤
                    │ Manifest         │
                    │ Catalog          │
                    │ Meta             │
                    │ Stream           │
                    │ Admin            │
                    │ Reindex          │
                    └───────┬──────────┘
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
     ┌─────────┐      ┌──────────┐      ┌──────────┐
     │   D1    │      │  Queue   │      │  Drive   │
     └─────────┘      └────┬─────┘      └──────────┘
                            │
                            ▼
                       Reindex Jobs
                            │
                    ┌───────┴────────┐
                    ▼                ▼
                  TMDB             Gemini
```

---

# 94. Lộ trình học dành cho người mới

Nếu chưa biết lập trình, không nên học tất cả cùng lúc.

Nên học theo thứ tự:

### Giai đoạn 1

```text
File
Folder
URL
HTTP
JSON
```

### Giai đoạn 2

```text
JavaScript cơ bản
```

### Giai đoạn 3

```text
API
```

### Giai đoạn 4

```text
SQL
```

### Giai đoạn 5

```text
Git
GitHub
```

### Giai đoạn 6

```text
Cloudflare Worker
```

### Giai đoạn 7

```text
Google Drive API
```

### Giai đoạn 8

```text
Stremio Addon
```

---

# 95. Những thành phần quan trọng nhất

Nếu chỉ nhớ một số thành phần, hãy nhớ:

```text
Manifest
Catalog
Meta
Stream
```

Đây là phần cốt lõi của Stremio Addon.

Sau đó:

```text
Drive
D1
TMDB
```

là phần dữ liệu.

Và:

```text
Queue
Cron
Admin
```

là phần vận hành.

---

# 96. Mô hình tư duy đơn giản

Có thể hiểu addon như một cửa hàng:

```text
Manifest
= Bảng giới thiệu cửa hàng

Catalog
= Danh sách sản phẩm

Meta
= Thông tin chi tiết sản phẩm

Stream
= Nút lấy sản phẩm

D1
= Kho dữ liệu

Google Drive
= Kho video

TMDB
= Nguồn thông tin phim

Parser
= Người đọc tên file

Queue
= Nhân viên xử lý công việc

Cron
= Lịch tự động

Admin
= Phòng quản lý
```

---

# 97. Những việc không nên làm

Không nên:

```text
Hard-code API Key
```

Không nên:

```text
Commit service-account.json
```

Không nên:

```text
Đưa REINDEX_SECRET vào GitHub
```

Không nên:

```text
Deploy khi chưa test local
```

Không nên:

```text
Chọn TMDB result đầu tiên một cách mù quáng
```

Không nên:

```text
Reindex toàn bộ và gọi TMDB lại mỗi lần
```

Không nên:

```text
Cho phép Admin API không có authentication
```

---

# 98. Phiên bản README công khai

README này được thiết kế để có thể đặt trực tiếp trong một repository GitHub Public.

Các thông tin riêng phải được thay bằng placeholder:

```text
YOUR_...
```

Do đó người khác có thể:

1. Fork repository.
2. Đổi tên addon.
3. Tạo Cloudflare Worker riêng.
4. Tạo D1 riêng.
5. Tạo Google Cloud Project riêng.
6. Tạo Google Drive riêng.
7. Tạo TMDB API riêng.
8. Tạo Gemini API riêng nếu cần.
9. Cấu hình secrets riêng.
10. Deploy addon riêng.

Không cần sử dụng bất kỳ tài nguyên riêng tư nào của tác giả README.

---

# 99. Checklist hoàn thành

```text
[ ] Node.js
[ ] npm
[ ] Git
[ ] Wrangler
[ ] GitHub
[ ] Cloudflare
[ ] Worker
[ ] D1
[ ] Google Cloud
[ ] Google Drive API
[ ] Service Account
[ ] Drive Folder
[ ] TMDB
[ ] Gemini (optional)

[ ] Parser
[ ] Drive scanner
[ ] Manifest
[ ] Catalog
[ ] Meta
[ ] Stream
[ ] Drive proxy

[ ] Local test
[ ] Reindex
[ ] Queue
[ ] Cron
[ ] Admin

[ ] Production deploy
[ ] Stremio install
[ ] Playback test
```

---

# 100. Kết luận

Một Stremio Addon hoàn chỉnh có thể được xây dựng từng bước.

Không cần bắt đầu bằng một hệ thống lớn.

Nên bắt đầu:

```text
Worker
   ↓
Manifest
   ↓
Catalog
   ↓
Meta
   ↓
Stream
```

Sau khi phần cơ bản hoạt động:

```text
Google Drive
   ↓
Parser
   ↓
TMDB
   ↓
D1
```

Sau đó mới mở rộng:

```text
Reindex
   ↓
Queue
   ↓
Cron
   ↓
Admin
   ↓
Multiple Libraries
```

Cách xây dựng từng lớp giúp dễ kiểm tra lỗi và dễ mở rộng hệ thống.

---

# 101. Thông tin cần thay đổi khi tạo project mới

Khi sử dụng README này cho một addon thực tế, hãy thay các giá trị:

```text
YOUR_ADDON_NAME
YOUR_ADDON_ID
YOUR_WORKER_NAME
YOUR_WORKER_URL
YOUR_DATABASE_NAME
YOUR_DATABASE_ID
YOUR_QUEUE_NAME
YOUR_GOOGLE_PROJECT
YOUR_GOOGLE_DRIVE_FOLDER_ID
YOUR_SERVICE_ACCOUNT_EMAIL
YOUR_TMDB_API_KEY
YOUR_GEMINI_API_KEY
YOUR_REINDEX_SECRET
YOUR_GITHUB_REPOSITORY_URL
```

Không sử dụng thông tin cá nhân hoặc thông tin production của một project khác.

---

# 102. Cấu trúc cuối cùng

```text
YOUR-STREMIO-ADDON/
│
├── src/
│   ├── index.js
│   ├── drive.js
│   ├── parser.js
│   ├── tmdb.js
│   └── gemini.js
│
├── migrations/
│   ├── 0001_initial.sql
│   └── 0002_*.sql
│
├── package.json
├── package-lock.json
├── wrangler.jsonc
├── README.md
└── .gitignore
```

---

## License

Nếu muốn phát hành mã nguồn công khai, có thể chọn một giấy phép phù hợp, ví dụ:

```text
MIT
Apache-2.0
GPL-3.0
```

Việc lựa chọn license tùy thuộc vào mục đích của repository.

---

## Ghi chú cuối

README này là **tài liệu mẫu trung lập**.

Tên:

```text
Stremio Addon Tester
```

chỉ là tên minh họa.

Tất cả:

```text
Worker
D1
Google Drive
TMDB
Gemini
Queue
GitHub
Secrets
```

đều phải được tạo và cấu hình riêng cho từng project.

Không sử dụng thông tin credentials, ID, URL hoặc tài nguyên của project khác.
