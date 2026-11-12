# Bản thử nghiệm streaming theo chunk 8 MiB

Tệp `wrangler.chunk-streaming.jsonc` là cấu hình cho Worker thử nghiệm riêng
`tm-lt-stremio-chunk-streaming-test`. Nó không khai báo D1, Queue, Cron,
Reindex hay TMDB. Vì vậy chỉ endpoint `/file/:fileId` mới nằm trong phạm vi
kiểm thử.

## Cách hoạt động

- `Range: bytes=N-M` được chuyển nguyên trạng tới Google Drive.
- `Range: bytes=N-` được đổi thành các yêu cầu liên tiếp tối đa 8 MiB.
- Worker trả `206`, `Content-Range` và `Content-Length` cho toàn bộ phần còn
  lại, không phải chỉ cho chunk đầu tiên.
- Một Range mới từ trình phát bắt đầu một luồng mới, nên hỗ trợ tua.
- Khi người xem dừng phát, yêu cầu Drive đang mở bị hủy.
- Nếu một chunk tiếp theo thất bại, kết nối stream bị lỗi/đóng; Worker không
  báo thành công với dữ liệu bị thiếu.

Chia chunk không đảm bảo vượt qua giới hạn tải của Google Drive. Nếu Drive trả
`downloadQuotaExceeded` ở bất kỳ chunk nào, quá trình phát vẫn có thể thất bại.

## Kiểm tra cục bộ

Mỗi lệnh PowerShell dưới đây là một lệnh riêng:

```powershell
npm test
```

```powershell
npx wrangler deploy --dry-run --config .\wrangler.chunk-streaming.jsonc
```

## Điều kiện trước khi triển khai thử

Worker thử chỉ cần hai secret đang có giá trị hợp lệ:

- `GDRIVE_CLIENT_EMAIL`
- `GDRIVE_PRIVATE_KEY`

Chỉ sau khi kiểm tra hai secret trên Worker thử và có xác nhận triển khai mới
chạy các lệnh tạo/cập nhật secret hoặc deploy. Không dùng lại cấu hình
`wrangler.jsonc` vì cấu hình đó gắn D1, Queue và Cron của Worker chính.
