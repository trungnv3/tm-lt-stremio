import {
  testDriveConnection,
  scanDriveLibrary,
  getDriveFileStream
} from "./drive.js";
import {
  getMovieById,
  getTvById,
   searchMovie,
  searchTv,
  pickBestMovieResult,
  getPosterUrl,
  getBackdropUrl,
   resolveMovie,
  resolveMovieById,
  resolveTv,
  resolveMedia
} from "./tmdb.js";
import {
  parseFilename,
  testParser
} from "./parser.js";
import {
  getLibraries,
  addLibrary,
  deleteLibrary
} from "./admin.js";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};
async function runReindexWorker(
  env,
  {
    libraryId,
    offset = 0,
    batchSize = 5,
    existingJobId = null,
    origin = ""
  } = {}
) {
  let jobId = null;

  try {
    // -----------------------------------------------------
    // 1. Lấy thư viện được yêu cầu
    // -----------------------------------------------------
    const library = await env.tm_lt_db
      .prepare(
        `SELECT id, name, folder_id
         FROM libraries
         WHERE id = ?
           AND enabled = 1
         LIMIT 1`
      )
      .bind(libraryId)
      .first();

    if (!library) {
      return new Response(
        JSON.stringify(
          {
            status: "error",
            reindex: "library_not_found",
            message:
              "Không tìm thấy thư viện Google Drive đang được bật"
          },
          null,
          2
        ),
        {
          status: 404,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    // -----------------------------------------------------
    // 2. Tạo job mới hoặc tiếp tục job hiện tại
    // -----------------------------------------------------
    if (existingJobId) {
      const existingJob = await env.tm_lt_db
        .prepare(
          `SELECT
             id,
             library_id,
             status
           FROM reindex_jobs
           WHERE id = ?
             AND library_id = ?
           LIMIT 1`
        )
        .bind(
          existingJobId,
          library.id
        )
        .first();

      if (!existingJob) {
        return new Response(
          JSON.stringify(
            {
              status: "error",
              reindex: "job_not_found",
              message:
                "Không tìm thấy Reindex job hoặc job không thuộc thư viện này"
            },
            null,
            2
          ),
          {
            status: 404,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }

      jobId = existingJobId;

    } else {
      const job = await env.tm_lt_db
        .prepare(
          `INSERT INTO reindex_jobs (
             library_id,
             status
           )
           VALUES (?, ?)`
        )
        .bind(
          library.id,
          "running"
        )
        .run();

      jobId =
        job.meta?.last_row_id ?? null;
    }

    // -----------------------------------------------------
    // 3. Scan toàn bộ Google Drive
    // -----------------------------------------------------
    const driveFiles =
      await scanDriveLibrary(
        env,
        library.folder_id
      );

    const videoFiles =
      driveFiles.filter(
        (file) =>
          file?.mimeType?.startsWith("video/") ||
          /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(
            file?.name || ""
          )
      );

    // -----------------------------------------------------
    // 4. Ghi tổng số file tìm thấy
    // -----------------------------------------------------
    await env.tm_lt_db
      .prepare(
        `UPDATE reindex_jobs
         SET files_found = ?
         WHERE id = ?`
      )
      .bind(
        videoFiles.length,
        jobId
      )
      .run();

    // -----------------------------------------------------
    // 5. Danh sách Drive ID hiện tại
    // -----------------------------------------------------
    const currentDriveIds =
      new Set(
        videoFiles.map(
          (file) => file.id
        )
      );

    // -----------------------------------------------------
    // 6. Bộ đếm
    // -----------------------------------------------------
    let filesAdded = 0;
    let filesUpdated = 0;
    let filesSkipped = 0;
    let filesFailed = 0;

    let errors = [];

    // -----------------------------------------------------
    // Nếu tiếp tục job cũ thì lấy số liệu đã tích lũy
    // -----------------------------------------------------
    if (existingJobId) {
      const previousJob =
        await env.tm_lt_db
          .prepare(
            `SELECT
               files_added,
               files_updated,
               files_removed,
               error_message
             FROM reindex_jobs
             WHERE id = ?
             LIMIT 1`
          )
          .bind(existingJobId)
          .first();

      if (previousJob) {
        filesAdded =
          Number(
            previousJob.files_added || 0
          );

        filesUpdated =
          Number(
            previousJob.files_updated || 0
          );

        try {
          errors =
            previousJob.error_message
              ? JSON.parse(
                  previousJob.error_message
                )
              : [];
        } catch {
          errors = [];
        }
      }
    }

    // -----------------------------------------------------
    // 7. Retry TMDB khi gặp lỗi tạm thời
    // -----------------------------------------------------
    const resolveMediaWithRetry =
      async (parsed) => {
        const maxAttempts = 3;

        for (
          let attempt = 1;
          attempt <= maxAttempts;
          attempt++
        ) {
          try {
            return await resolveMedia(
              parsed,
              env
            );

          } catch (error) {
            const message =
              error?.message ||
              String(error);

            const isTransient =
              /TMDB HTTP (502|503|504)\b/i.test(
                message
              );

            if (!isTransient) {
              throw error;
            }

            if (
              attempt === maxAttempts
            ) {
              throw error;
            }

            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  attempt * 1000
                )
            );
          }
        }

        return null;
      };

    // -----------------------------------------------------
    // 8. Lấy batch hiện tại
    // -----------------------------------------------------
    const batchFiles =
      videoFiles.slice(
        offset,
        offset + batchSize
      );

    for (const file of batchFiles) {
      try {
        // -------------------------------------------------
        // Kiểm tra file đã tồn tại trong D1 chưa
        // -------------------------------------------------
        const existing =
          await env.tm_lt_db
            .prepare(
              `SELECT
                 id,
                 drive_name,
                 drive_modified_time,
		 tmdb_id,
                 is_active
               FROM movies
               WHERE drive_file_id = ?
               LIMIT 1`
            )
            .bind(file.id)
            .first();

        // -------------------------------------------------
// File không thay đổi -> bỏ qua
// Trừ khi cần refresh metadata
// -------------------------------------------------
const needsMetadataRefresh =
  existing &&
  (
    existing.tmdb_id === 708702 ||
    existing.tmdb_id === 729191
  );

if (
  existing &&
  existing.drive_name === file.name &&
  (existing.drive_modified_time ?? null) ===
    (file.modifiedTime ?? null) &&
  !needsMetadataRefresh
) {
  if (existing.is_active !== 1) {
    await env.tm_lt_db
      .prepare(
        `UPDATE movies
         SET is_active = 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(existing.id)
      .run();
  }

  filesSkipped++;
  continue;
}

        // -------------------------------------------------
        // File mới hoặc đã thay đổi
        // -------------------------------------------------
        const parsed =
          parseFilename(file.name);

        const tmdb =
          await resolveMediaWithRetry(
            parsed
          );

        // -------------------------------------------------
        // Không tìm thấy TMDB
        // -------------------------------------------------
        if (!tmdb) {
          filesFailed++;

          errors.push({
            driveFileId: file.id,
            fileName: file.name,
            error:
              "Không tìm thấy thông tin TMDB"
          });

          continue;
        }

        const title =
          tmdb.title ||
          parsed.title;

        const year =
          tmdb.year ??
          parsed.year ??
          null;

        const tmdbId =
          tmdb.tmdbId ??
          parsed.tmdbId ??
          null;

        const tmdbType =
          tmdb.type ??
          parsed.tmdbType ??
          "movie";

        const posterUrl =
          tmdb.posterPath
            ? getPosterUrl(
                tmdb.posterPath
              )
            : null;

        const backdropUrl =
          tmdb.backdropPath
            ? getBackdropUrl(
                tmdb.backdropPath,
                "w1280"
              )
            : null;

        const overview =
          tmdb.overview || "";

        const genres =
          Array.isArray(tmdb.genres)
            ? JSON.stringify(
                tmdb.genres
              )
            : "[]";

        // -------------------------------------------------
        // Upsert movie
        // -------------------------------------------------
        await env.tm_lt_db
          .prepare(
            `INSERT INTO movies (
              library_id,
              drive_file_id,
              drive_parent_id,
              drive_name,
              drive_mime_type,
              drive_size,
              drive_modified_time,
              title,
              year,
              tmdb_id,
              tmdb_type,
              poster_url,
              backdrop_url,
              overview,
              genres,
              vote_average,
              is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(drive_file_id)
            DO UPDATE SET
              library_id = excluded.library_id,
              drive_parent_id = excluded.drive_parent_id,
              drive_name = excluded.drive_name,
              drive_mime_type = excluded.drive_mime_type,
              drive_size = excluded.drive_size,
              drive_modified_time = excluded.drive_modified_time,
              title = excluded.title,
              year = excluded.year,
              tmdb_id = excluded.tmdb_id,
              tmdb_type = excluded.tmdb_type,
              poster_url = excluded.poster_url,
              backdrop_url = excluded.backdrop_url,
              overview = excluded.overview,
              genres = excluded.genres,
              vote_average = excluded.vote_average,
              is_active = 1,
              updated_at = CURRENT_TIMESTAMP`
          )
          .bind(
            library.id,
            file.id,
            file.parents?.[0] ?? null,
            file.name,
            file.mimeType ?? null,
            file.size
              ? Number(file.size)
              : null,
            file.modifiedTime ?? null,
            title,
            year,
            tmdbId,
            tmdbType,
            posterUrl,
            backdropUrl,
            overview,
            genres,
            tmdb?.voteAverage ?? 0
          )
          .run();

        // -------------------------------------------------
        // Đếm thêm / cập nhật
        // -------------------------------------------------
        if (existing) {
          filesUpdated++;
        } else {
          filesAdded++;
        }

        // -------------------------------------------------
        // Tạo stream nếu chưa có
        // -------------------------------------------------
        await env.tm_lt_db
          .prepare(
            `INSERT INTO streams (
              movie_id,
              stream_type,
              drive_file_id
            )
            SELECT
              id,
              'google_drive',
              ?
            FROM movies
            WHERE drive_file_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM streams
                WHERE drive_file_id = ?
              )`
          )
          .bind(
            file.id,
            file.id,
            file.id
          )
          .run();

      } catch (fileError) {
        filesFailed++;

        errors.push({
          driveFileId: file.id,
          fileName: file.name,
          error:
            fileError?.message ||
            String(fileError)
        });
      }
    }

    // -----------------------------------------------------
    // 9. Đánh dấu movie không còn trên Drive là inactive
    // Chỉ thực hiện ở batch cuối
    // -----------------------------------------------------
    let filesRemoved = 0;

    const isLastBatch =
      offset + batchSize >=
      videoFiles.length;

    if (isLastBatch) {
      const activeMovies =
        await env.tm_lt_db
          .prepare(
            `SELECT
               id,
               drive_file_id
             FROM movies
             WHERE library_id = ?`
          )
          .bind(library.id)
          .all();

      for (
        const movie
        of activeMovies.results || []
      ) {
        if (
          !currentDriveIds.has(
            movie.drive_file_id
          )
        ) {
          await env.tm_lt_db
            .prepare(
              `UPDATE movies
               SET is_active = 0,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
            .bind(movie.id)
            .run();

          filesRemoved++;
        }
      }
    }

    // -----------------------------------------------------
    // 10. Cập nhật reindex job
    // -----------------------------------------------------
    const finalStatus =
      isLastBatch
        ? (
            filesFailed > 0
              ? "completed_with_errors"
              : "completed"
          )
        : "running";

    const errorMessage =
      errors.length > 0
        ? JSON.stringify(errors)
        : null;

    await env.tm_lt_db
      .prepare(
        `UPDATE reindex_jobs
         SET
           status = ?,
           finished_at = ?,
           files_found = ?,
           files_added = ?,
           files_updated = ?,
           files_removed = ?,
           error_message = ?
         WHERE id = ?`
      )
      .bind(
        finalStatus,
        isLastBatch
          ? new Date().toISOString()
          : null,
        videoFiles.length,
        filesAdded,
        filesUpdated,
        filesRemoved,
        errorMessage,
        jobId
      )
      .run();

    // -----------------------------------------------------
    // 11. Kết quả
    // -----------------------------------------------------
    const nextOffset =
      isLastBatch
        ? null
        : offset + batchSize;

const nextBatchUrl =
  isLastBatch
    ? null
    : `${origin}/admin/reindex/${library.id}?offset=${nextOffset}&limit=${batchSize}&jobId=${jobId}`;

    return new Response(
      JSON.stringify(
        {
          status: "ok",
          reindex: finalStatus,

          jobId,

          nextOffset,

          nextBatchUrl,

          library: {
            id: library.id,
            name: library.name,
            folderId:
              library.folder_id
          },

          filesFound:
            videoFiles.length,

          filesAdded,

          filesUpdated,

          filesSkipped,

          filesRemoved,

          filesFailed,

          errors
        },
        null,
        2
      ),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {

    // -----------------------------------------------------
    // Lỗi toàn bộ Reindex
    // -----------------------------------------------------
    if (jobId !== null) {
      try {
        await env.tm_lt_db
          .prepare(
            `UPDATE reindex_jobs
             SET
               status = ?,
               finished_at = CURRENT_TIMESTAMP,
               error_message = ?
             WHERE id = ?`
          )
          .bind(
            "failed",
            error?.message ||
              String(error),
            jobId
          )
          .run();
      } catch {
        // Không che mất lỗi gốc
      }
    }

    return new Response(
      JSON.stringify(
        {
          status: "error",
          reindex: "failed",
          jobId,
          message:
            error?.message ||
            String(error),
          stack:
            error?.stack || null
        },
        null,
        2
      ),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // ---------------------------------------------------------
    // Admin Web UI
    // ---------------------------------------------------------
    if (
      url.pathname === "/admin" &&
      request.method === "GET"
    ) {
      const html = `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TM-LT Admin</title>

  <style>
  * {
    box-sizing: border-box;
  }

  :root {
    color-scheme: dark;
  }

  body {
    font-family:
      Inter,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Arial,
      sans-serif;
    background: #0b0f14;
    color: #e5e7eb;
    margin: 0;
    padding: 24px 14px;
  }

  .container {
    width: min(760px, 100%);
    margin: 0 auto;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
  }

  .subtitle {
    color: #8b95a5;
    font-size: 13px;
    margin-top: 5px;
    margin-bottom: 18px;
  }

  .card {
    background: #11161d;
    border: 1px solid #202733;
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 12px;
  }

  .section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }

  .section-title h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
  }

  .count {
    color: #7f8a9a;
    font-size: 12px;
  }

  label {
    display: block;
    color: #aab3c2;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 5px;
  }

  input {
    width: 100%;
    padding: 9px 10px;
    border: 1px solid #293241;
    border-radius: 8px;
    background: #0c1117;
    color: #f3f4f6;
    outline: none;
    font-size: 13px;
    margin-bottom: 9px;
  }

  input:focus {
    border-color: #4b8cff;
    box-shadow: 0 0 0 2px rgba(75, 140, 255, 0.12);
  }

  input::placeholder {
    color: #596474;
  }

  button {
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 7px 11px;
    cursor: pointer;
    background: #2563eb;
    color: white;
    font-size: 12px;
    font-weight: 600;
  }

  button:hover {
    opacity: 0.9;
  }

  button.secondary {
    background: #202833;
    border-color: #303a48;
    color: #d7dce4;
  }

  button.danger {
    background: #351a1e;
    border-color: #5b252c;
    color: #fca5a5;
  }

  button.reindex {
    background: #17325e;
    border-color: #234b87;
  }

  .auth-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .auth-row input {
    flex: 1;
    margin-bottom: 0;
  }

  .status {
    color: #9aa5b5;
    font-size: 12px;
    line-height: 1.5;
  }

  .auth-status {
    margin-top: 8px;
  }

  .success {
    color: #4ade80;
    font-weight: 600;
  }

  .error {
    color: #f87171;
    font-weight: 600;
  }

  .warning {
    color: #fbbf24;
    font-weight: 600;
  }

  .library {
    border: 1px solid #222b37;
    background: #0d1218;
    border-radius: 9px;
    padding: 11px 12px;
    margin-top: 8px;
  }

  .library-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .library-name {
    min-width: 0;
    flex: 1;
  }

  .library-title {
    font-size: 13px;
    font-weight: 700;
    color: #edf0f5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .library-info {
    color: #6f7a89;
    font-size: 11px;
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .library-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .library-status {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #1c242f;
  }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    margin-top: 7px;
  }

  .stat {
    background: #111820;
    border-radius: 6px;
    padding: 6px 7px;
  }

  .stat-label {
    color: #687486;
    font-size: 10px;
  }

  .stat-value {
    color: #dce2ea;
    font-size: 12px;
    font-weight: 600;
    margin-top: 1px;
  }

  .add-form {
    display: none;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #202733;
  }

  .add-form.open {
    display: block;
  }

  .add-actions {
    display: flex;
    gap: 6px;
  }

  .footer-note {
    color: #566170;
    font-size: 10px;
    line-height: 1.5;
    text-align: center;
    margin: 14px 4px 0;
  }

  .progress {
    margin-top: 7px;
    height: 4px;
    background: #202733;
    border-radius: 99px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    width: 35%;
    background: #3b82f6;
    animation: progress 1.2s infinite ease-in-out;
  }

  @keyframes progress {
    0% {
      transform: translateX(-130%);
    }

    100% {
      transform: translateX(310%);
    }
  }

  @media (max-width: 560px) {
    body {
      padding: 16px 10px;
    }

    .auth-row {
      flex-direction: column;
      align-items: stretch;
    }

    .auth-row input {
      margin-bottom: 0;
    }

    .library-main {
      align-items: flex-start;
    }

    .library-actions {
      flex-direction: column;
    }

    .status-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
</head>

<body>

<div class="container">

  <h1>VanTrung MediaHub</h1>

  <div class="subtitle">
    Quản lý các thư viện Google Drive và cập nhật catalog.
  </div>

  <!-- SECRET -->
  <div class="card">

    <div class="section-title">
      <h2>REINDEX_SECRET</h2>
    </div>

    <div class="auth-row">

      <input
        id="secret"
        type="password"
        placeholder="Nhập REINDEX_SECRET"
        autocomplete="off"
      >

      <button onclick="loadLibraries()">
        Tải danh sách thư viện
      </button>

    </div>

    <div id="authStatus" class="status auth-status">
      Chưa xác thực
    </div>

  </div>


  <!-- LIBRARIES -->
  <div class="card">

    <div class="section-title">

      <h2>Thư viện Google Drive</h2>

      <span id="libraryCount" class="count">
        0 thư viện
      </span>

    </div>

    <div id="libraries">
      Chưa tải danh sách.
    </div>


    <div style="margin-top:10px;">

      <button
        class="secondary"
        onclick="toggleAddForm()"
      >
        + Thêm thư viện
      </button>

    </div>


    <!-- ADD LIBRARY FORM -->

    <div id="addForm" class="add-form">

      <label>Tên thư viện</label>

      <input
        id="libraryName"
        placeholder="Ví dụ: Phim Hoạt Hình"
      >

      <label>
        Google Drive Folder ID hoặc URL
      </label>

      <input
        id="folderInput"
        placeholder="Folder ID hoặc URL thư mục Drive"
      >

      <div class="add-actions">

        <button onclick="addLibrary()">
          Lưu danh sách
        </button>

        <button
          class="secondary"
          onclick="toggleAddForm(false)"
        >
          Hủy
        </button>

      </div>

    </div>

  </div>


  <div class="footer-note">

    Secret chỉ được gửi qua HTTPS trong header
    Authorization và không lưu trên trình duyệt.
    Có thể dán folder ID hoặc URL thư mục Drive.

  </div>

</div>

<script>
let adminSecret = "";
let pollTimers = {};

function toggleAddForm(force) {
    const form = document.getElementById("addForm");
    const open = typeof force === "boolean" ? force : !form.classList.contains("open");
    form.classList.toggle("open", open);
}

function getHeaders() {
    return { "Authorization": "Bearer " + adminSecret };
}

async function loadLibraries() {
    adminSecret = document.getElementById("secret").value.trim();
    const authStatus = document.getElementById("authStatus");

    if (!adminSecret) {
        authStatus.innerHTML = '<span style="color:#f87171">Vui lòng nhập REINDEX_SECRET</span>';
        return;
    }
    
    authStatus.innerHTML = '⏳ Đang xác thực...';
    
    try {
        const response = await fetch("/admin/libraries", { method: "GET", headers: getHeaders() });
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || "Không thể tải thư viện");
        }
        
        authStatus.innerHTML = '<span style="color:#4ade80">✓ Đã xác thực thành công</span>';
        renderLibraries(data.libraries || []);
    } catch (error) {
        authStatus.innerHTML = '<span style="color:#f87171">✕ ' + escapeHtml(error.message) + '</span>';
    }
}

function renderLibraries(libraries) {
    const container = document.getElementById("libraries");
    const count = document.getElementById("libraryCount");
    
    count.textContent = libraries.length + " thư viện";
    
    if (!libraries.length) {
        container.innerHTML = '<div class="empty-state">Chưa có thư viện.</div>';
        return;
    }
    
    // Sử dụng kỹ thuật dataset để KHÔNG cần escape dấu nháy trong JavaScript
    container.innerHTML = libraries.map(function(library) {
        const id = escapeHtml(library.id);
        const name = escapeHtml(library.name);
        const folder = escapeHtml(library.folder_id);
        
        return '<div class="library-card">' +
                 '<div class="library-header">🎬 ' + name + '</div>' +
                 '<div class="library-folder">Folder: ' + folder + '</div>' +
                 '<div class="library-actions">' +
                   '<button onclick="reindexLibrary(this.dataset.id)" data-id="' + id + '">Reindex</button>' +
                   '<button class="danger" onclick="deleteLibrary(this.dataset.id)" data-id="' + id + '">Xóa</button>' +
                 '</div>' +
                 '<div class="library-status" id="status-' + id + '">Chưa Reindex trong phiên này.</div>' +
               '</div>';
    }).join("");
}

async function addLibrary() {
    const name = document.getElementById("libraryName").value.trim();
    const folder = document.getElementById("folderInput").value.trim();
    
    if (!name || !folder) {
        alert("Vui lòng nhập tên thư viện và Folder ID/URL.");
        return;
    }
    
    try {
        const response = await fetch("/admin/libraries", {
            method: "POST",
            headers: { ...getHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, folder: folder })
        });
        
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.message || "Không thể thêm thư viện");
        }
        
        alert("Đã thêm thư viện.");
        document.getElementById("libraryName").value = "";
        document.getElementById("folderInput").value = "";
        toggleAddForm(false);
        await loadLibraries();
    } catch (error) {
        alert(error.message);
    }
}

async function reindexLibrary(libraryId) {
    const statusElement = document.getElementById("status-" + libraryId);
    statusElement.innerHTML = '<strong>⏳ Đang đưa Reindex vào Queue...</strong>';
    
    try {
        const response = await fetch("/admin/reindex/" + libraryId, { method: "POST", headers: getHeaders() });
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || "Không thể Reindex");
        }
        
        statusElement.innerHTML = '<strong>✓ Đã đưa vào Queue...</strong>';
        if (data.jobId) {
            startPolling(libraryId, data.jobId);
        }
    } catch (error) {
        statusElement.innerHTML = '<strong>✕ ' + escapeHtml(error.message) + '</strong>';
    }
}

function startPolling(libraryId, jobId) {
    if (pollTimers[libraryId]) {
        clearInterval(pollTimers[libraryId]);
    }
    checkJobStatus(libraryId, jobId);
    pollTimers[libraryId] = setInterval(() => checkJobStatus(libraryId, jobId), 3000);
}

async function checkJobStatus(libraryId, jobId) {
    const statusElement = document.getElementById("status-" + libraryId);
    try {
        const response = await fetch("/admin/reindex/status/" + jobId, { method: "GET", headers: getHeaders() });
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || "Không lấy được trạng thái");
        }
        
        const job = data.job;
        let html = "";
        
        if (job.status === "running") {
            html += '<strong>⟳ Đang Reindex...</strong>';
        } else if (job.status === "completed") {
            html += '<strong style="color:#4ade80">✓ Hoàn tất</strong>';
        } else if (job.status === "completed_with_errors") {
            html += '<strong style="color:#fbbf24">⚠ Hoàn tất nhưng có lỗi</strong>';
        } else if (job.status === "failed") {
            html += '<strong style="color:#f87171">✕ Thất bại</strong>';
        } else {
            html += '<strong>' + escapeHtml(job.status) + '</strong>';
        }
        
        html += "<br>Job ID: " + job.id + "<br>";
        html += "Files tìm thấy: " + (job.files_found ?? 0) + "<br>";
        html += "Thêm mới: " + (job.files_added ?? 0) + "<br>";
        html += "Cập nhật: " + (job.files_updated ?? 0) + "<br>";
        html += "Xóa/ngừng hoạt động: " + (job.files_removed ?? 0);
        
        if (job.error_message) {
            html += "<br><span style='color:#f87171'>" + escapeHtml(job.error_message) + "</span>";
        }
        
        statusElement.innerHTML = html;
        
        if (job.status === "completed" || job.status === "completed_with_errors" || job.status === "failed") {
            clearInterval(pollTimers[libraryId]);
            delete pollTimers[libraryId];
        }
    } catch (error) {
        statusElement.innerHTML = '<strong>✕ ' + escapeHtml(error.message) + '</strong>';
    }
}

async function deleteLibrary(libraryId) {
    if (!confirm("Bạn có chắc muốn xóa thư viện này?")) {
        return;
    }
    
    try {
        const response = await fetch("/admin/libraries/" + libraryId, { method: "DELETE", headers: getHeaders() });
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || "Không thể xóa thư viện");
        }
        
        alert("Đã xóa thư viện.");
        await loadLibraries();
    } catch (error) {
        alert(error.message);
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
</script>

</script>

</body>
</html>
`;

      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=UTF-8"
        }
      });
    }

    // ---------------------------------------------------------
    // Admin - Quản lý thư viện
    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // Admin - Quản lý thư viện
    // ---------------------------------------------------------

    // GET /admin/libraries
    if (
      url.pathname === "/admin/libraries" &&
      request.method === "GET"
    ) {
      return getLibraries(request, env);
    }

    // POST /admin/libraries
    if (
      url.pathname === "/admin/libraries" &&
      request.method === "POST"
    ) {
      return addLibrary(request, env);
    }

    // DELETE /admin/libraries/:id
    // ---------------------------------------------------------
    // Admin - Reindex thư viện
    // ---------------------------------------------------------
// GET /admin/reindex/status/:jobId
if (
  url.pathname.startsWith("/admin/reindex/status/") &&
  request.method === "GET"
) {
  const authorization =
    request.headers.get("Authorization");

  if (!authorization) {
    return new Response(
      JSON.stringify({
        status: "error",
        message: "Unauthorized"
      }),
      {
        status: 401,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }

  const match =
    authorization.match(/^Bearer\s+(.+)$/i);

  if (
    !match ||
    !env.REINDEX_SECRET ||
    match[1].trim() !== env.REINDEX_SECRET
  ) {
    return new Response(
      JSON.stringify({
        status: "error",
        message: "Unauthorized"
      }),
      {
        status: 401,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }

  const jobId = Number(
    url.pathname.replace(
      "/admin/reindex/status/",
      ""
    )
  );

  if (!Number.isInteger(jobId) || jobId <= 0) {
    return new Response(
      JSON.stringify({
        status: "error",
        message: "Job ID không hợp lệ"
      }),
      {
        status: 400,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }

  const job =
    await env.tm_lt_db
      .prepare(`
        SELECT
          id,
          library_id,
          status,
          started_at,
          finished_at,
          files_found,
          files_added,
          files_updated,
          files_removed,
          error_message
        FROM reindex_jobs
        WHERE id = ?
        LIMIT 1
      `)
      .bind(jobId)
      .first();

  if (!job) {
    return new Response(
      JSON.stringify({
        status: "error",
        message: "Không tìm thấy Reindex job"
      }),
      {
        status: 404,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }

  return new Response(
    JSON.stringify({
      status: "ok",
      job
    }, null, 2),
    {
      status: 200,
      headers: {
        "content-type":
          "application/json; charset=UTF-8"
      }
    }
  );
}
    // POST /admin/reindex/:id
    if (
      url.pathname.startsWith("/admin/reindex/") &&
      request.method === "POST"
    ) {
      const libraryId =
        url.pathname.replace(
          "/admin/reindex/",
          ""
        );
      const offset = Math.max(
        0,
        Number(
          url.searchParams.get("offset") || 0
        )
      );

      const batchSize = Math.min(
        5,
        Math.max(
          1,
          Number(
            url.searchParams.get("limit") || 5
          )
        )
      );

      const existingJobId =
        Number(
          url.searchParams.get("jobId") || 0
        ) || null;

      // Kiểm tra secret
      const authorization =
        request.headers.get("Authorization");

      if (!authorization) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Unauthorized"
          }),
          {
            status: 401,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }

      const match =
        authorization.match(/^Bearer\s+(.+)$/i);

      if (
        !match ||
        !env.REINDEX_SECRET ||
        match[1].trim() !== env.REINDEX_SECRET
      ) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Unauthorized"
          }),
          {
            status: 401,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }

      const id = Number(libraryId);

      if (!Number.isInteger(id) || id <= 0) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Library ID không hợp lệ"
          }),
          {
            status: 400,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }

      const library =
        await env.tm_lt_db
          .prepare(`
            SELECT id, name, folder_id
            FROM libraries
            WHERE id = ?
              AND enabled = 1
            LIMIT 1
          `)
          .bind(id)
          .first();

      if (!library) {
        return new Response(
          JSON.stringify({
            status: "error",
            message:
              "Không tìm thấy thư viện hoặc thư viện đang tắt"
          }),
          {
            status: 404,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
        // ---------------------------------------------------------
      // Tạo Reindex Job trước khi đưa vào Queue
      // ---------------------------------------------------------

      let jobId = existingJobId;

      if (!jobId) {
        const jobResult =
          await env.tm_lt_db
            .prepare(`
              INSERT INTO reindex_jobs (
                library_id,
                status,
                started_at,
                files_found,
                files_added,
                files_updated,
                files_removed
              )
              VALUES (?, 'queued', CURRENT_TIMESTAMP, 0, 0, 0, 0)
              RETURNING id
            `)
            .bind(library.id)
            .first();

        jobId = jobResult?.id || null;
      }

      if (!jobId) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Không tạo được Reindex Job"
          }),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }

      // ---------------------------------------------------------
      // Đưa Job vào Queue
      // ---------------------------------------------------------

      await env.tm_lt_reindex.send({
        libraryId: library.id,
        offset,
        batchSize,
        existingJobId: jobId
      });

      return new Response(
        JSON.stringify({
          status: "queued",
          message: "Đã đưa yêu cầu Reindex vào Queue",
          libraryId: library.id,
          offset,
          batchSize,
          jobId
        }, null, 2),
        {
          status: 202,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
  
    }
    if (
      url.pathname.startsWith("/admin/libraries/") &&
      request.method === "DELETE"
    ) {
      const libraryId =
        url.pathname.replace(
          "/admin/libraries/",
          ""
        );

      return deleteLibrary(
        request,
        env,
        libraryId
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    // ---------------------------------------------------------
    // Home
    // ---------------------------------------------------------
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "Kho Phim Gia Đình",
          status: "ok",
          version: "0.2.0"
        }, null, 2),
        {
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    // ---------------------------------------------------------
    // Health
    // ---------------------------------------------------------
    if (url.pathname === "/health") {
      try {
        const result = await env.tm_lt_db
          .prepare(
            "SELECT COUNT(*) AS count FROM movies"
          )
          .first();

        return new Response(
          JSON.stringify({
            status: "ok",
            database: "connected",
            movies: result?.count ?? 0
          }, null, 2),
          {
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: "error",
            database: "connection_failed",
            message: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }

    // ---------------------------------------------------------
    // Test Google Drive
    // ---------------------------------------------------------
    if (url.pathname === "/test/drive") {
      try {
        const result =
          await testDriveConnection(env);

        return new Response(
          JSON.stringify({
            status: "ok",
            googleDrive: "connected",
            ...result
          }, null, 2),
          {
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: "error",
            googleDrive: "connection_failed",
            message: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }

    // ---------------------------------------------------------
    // Test recursive Drive scan
    // ---------------------------------------------------------
    if (url.pathname === "/test/drive/scan") {
      try {
        const files =
          await scanDriveLibrary(env);

        return new Response(
          JSON.stringify({
            status: "ok",
            googleDrive: "connected",
            rootFolder:
              "14r5XofFHgMxPtxrFXLP6Rwt5dWRpeP9b",
            videoCount: files.length,
            files: files.map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
              modifiedTime:
                file.modifiedTime
            }))
          }, null, 2),
          {
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            status: "error",
            googleDrive: "scan_failed",
            message: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }
    // ---------------------------------------------------------
    // Test Movie Filename Parser
    // ---------------------------------------------------------
    if (url.pathname === "/test/parser") {
      try {
        const results = testParser();

        return new Response(
          JSON.stringify({
            status: "ok",
            parser: "connected",
            count: results.length,
            results
          }, null, 2),
          {
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            status: "error",
            parser: "failed",
            message: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }
    // ---------------------------------------------------------
    // Test TMDB API
    // ---------------------------------------------------------
    if (url.pathname === "/test/tmdb") {
      try {
        if (!env.TMDB_API_KEY) {
          return new Response(
            JSON.stringify({
              status: "error",
              tmdb: "api_key_missing",
              message: "TMDB_API_KEY chưa được khai báo"
            }, null, 2),
            {
              status: 500,
              headers: {
                "content-type":
                  "application/json; charset=UTF-8"
              }
            }
          );
        }

        const tmdbResponse = await fetch(
          `https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`
        );

        const data = await tmdbResponse.json();

        return new Response(
          JSON.stringify({
            status: tmdbResponse.ok ? "ok" : "error",
            tmdb: tmdbResponse.ok
              ? "connected"
              : "connection_failed",
            httpStatus: tmdbResponse.status,
            result: data
          }, null, 2),
          {
            status: tmdbResponse.ok ? 200 : 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            status: "error",
            tmdb: "connection_failed",
            message: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }
// ---------------------------------------------------------
// Test Movie Filename Parser
// ---------------------------------------------------------
if (url.pathname === "/test/parser") {
  try {
    const results = testParser();

    return new Response(
      JSON.stringify({
        status: "ok",
        parser: "connected",
        count: results.length,
        results
      }, null, 2),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        status: "error",
        parser: "failed",
        message: error.message,
        stack: error.stack
      }, null, 2),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
// ---------------------------------------------------------
// Test TMDB Movie by ID
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/movie") {
  try {
    const data = await getMovieById(
      315162,
      env
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        type: "movie",
        tmdbId: data.id,
        title: data.title,
        originalTitle: data.original_title,
        overview: data.overview,
        releaseDate: data.release_date,
        posterPath: data.poster_path,
        posterUrl: getPosterUrl(
          data.poster_path
        ),
        backdropPath: data.backdrop_path,
        voteAverage: data.vote_average
      }, null, 2),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        status: "error",
        tmdb: "movie_failed",
        message: error.message
      }, null, 2),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}

// ---------------------------------------------------------
// Test TMDB TV by ID
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/tv") {
  try {
    const data = await getTvById(
      57532,
      env
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        type: "tv",
        tmdbId: data.id,
        name: data.name,
        originalName: data.original_name,
        overview: data.overview,
        firstAirDate: data.first_air_date,
        posterPath: data.poster_path,
        posterUrl: getPosterUrl(
          data.poster_path
        ),
        backdropPath: data.backdrop_path,
        voteAverage: data.vote_average
      }, null, 2),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        status: "error",
        tmdb: "tv_failed",
        message: error.message
      }, null, 2),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
// ---------------------------------------------------------
// Test TMDB Movie Search
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/search") {
  try {
 const query =
  url.searchParams.get("query") ||
  "Puss in Boots The Last Wish";

const yearParam =
  url.searchParams.get("year");

const year =
  yearParam
    ? Number(yearParam)
    : 2022;

const data = await searchMovie(
  query,
  env,
  year
);
const best = pickBestMovieResult(
  data,
  year,
  query
);
    return new Response(
      JSON.stringify({
        status: "ok",
        type: "movie",
        query,
year,
        totalResults: data.total_results,
best: best
  ? {
      id: best.id,
      title: best.title,
      originalTitle: best.original_title,
      releaseDate: best.release_date
    }
  : null,
        results: data.results.slice(0, 5).map(item => ({
          id: item.id,
          title: item.title,
          originalTitle:
            item.original_title,
          releaseDate:
            item.release_date,
          overview:
            item.overview,
          posterPath:
            item.poster_path,
          posterUrl:
            getPosterUrl(
              item.poster_path
            )
        }))
      }, null, 2),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        status: "error",
        tmdb: "search_failed",
        message: error.message
      }, null, 2),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
// ---------------------------------------------------------
// Test TMDB Resolve
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/resolve") {
  try {
    const movie = await resolveMovie(
      {
        tmdbId: 315162,
        tmdbType: "movie",
        title: "Puss in Boots The Last Wish",
        year: 2022
      },
      env
    );

    const tv = await resolveTv(
      {
        tmdbId: 57532,
        tmdbType: "tv",
        title: "Paw Patrol"
      },
      env
    );

    return new Response(
      JSON.stringify({
        status: "ok",

        movie: {
          ...movie,
          posterUrl: getPosterUrl(
            movie?.posterPath
          ),
          backdropUrl: getPosterUrl(
            movie?.backdropPath,
            "w1280"
          )
        },

        tv: {
          ...tv,
          posterUrl: getPosterUrl(
            tv?.posterPath
          ),
          backdropUrl: getPosterUrl(
            tv?.backdropPath,
            "w1280"
          )
        }
      }, null, 2),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        status: "error",
        tmdb: "resolve_failed",
        message: error.message,
        stack: error.stack
      }, null, 2),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
if (url.pathname === "/test/drive/tmdb/all") {
  try {
    const driveResult = await scanDriveLibrary(env);

    const files = Array.isArray(driveResult)
      ? driveResult
      : (
          driveResult?.files ||
          driveResult?.videos ||
          driveResult?.results ||
          []
        );

    const videoFiles = files.filter((file) => {
      return (
        file?.mimeType?.startsWith("video/") ||
        /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(
          file?.name || ""
        )
      );
    });

    const results = [];

    for (const file of videoFiles) {
      const parsed = parseFilename(file.name);

      try {
        const tmdb = await resolveMedia(parsed, env);

        results.push({
          filename: file.name,
          fileId: file.id,

          parsedTitle: parsed.title,
          year: parsed.year,

          tmdbId: tmdb?.id ?? parsed.tmdbId ?? null,

          type:
            parsed.tmdbType ??
            tmdb?.type ??
            "movie",

          title:
            tmdb?.title ??
            tmdb?.name ??
            null,

          originalTitle:
            tmdb?.originalTitle ??
            tmdb?.originalName ??
            null,

          overview:
            tmdb?.overview ??
            "",

          posterUrl:
            tmdb?.posterPath
              ? getPosterUrl(tmdb.posterPath)
              : null,

          backdropUrl:
            tmdb?.backdropPath
              ? getBackdropUrl(
                  tmdb.backdropPath,
                  "w1280"
                )
              : null,

          voteAverage:
            tmdb?.voteAverage ??
            null,

          parserQueries:
            parsed.queries,

          status: tmdb
            ? "ok"
            : "not_found"
        });

      } catch (error) {
        results.push({
          filename: file.name,
          fileId: file.id,

          parsedTitle: parsed.title,
          year: parsed.year,

          tmdbId:
            parsed.tmdbId ??
            null,

          type:
            parsed.tmdbType ??
            "movie",

          parserQueries:
            parsed.queries,

          status: "tmdb_error",

          error: error.message
        });
      }
    }

    const success = results.filter(
      (item) => item.status === "ok"
    ).length;

    const failed = results.length - success;

    return new Response(
      JSON.stringify(
        {
          status: "ok",

          totalFiles: videoFiles.length,

          processed: results.length,

          success,

          failed,

          results
        },
        null,
        2
      ),
      {
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify(
        {
          status: "error",

          test: "drive_tmdb_all_failed",

          message: error.message,

          stack: error.stack
        },
        null,
        2
      ),
      {
        status: 500,

        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
    // ---------------------------------------------------------
    // Test Google Drive -> Parser -> TMDB
    // Chỉ test 10 file đầu tiên
    // Không ghi vào D1
    // ---------------------------------------------------------
    if (url.pathname === "/test/drive/tmdb") {
      try {
        // 1. Scan Google Drive
        const driveResult = await scanDriveLibrary(env);

        const files = Array.isArray(driveResult)
          ? driveResult
          : (
              driveResult?.files ||
              driveResult?.videos ||
              driveResult?.results ||
              []
            );

        // 2. Lọc file video
        const videoFiles = files.filter((file) => {
          return (
            file?.mimeType?.startsWith("video/") ||
            /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(
              file?.name || ""
            )
          );
        });

        // 3. Chỉ test 10 file đầu tiên
        const testFiles = videoFiles.slice(0, 10);

        const results = [];

        // 4. Parser -> TMDB
        for (const file of testFiles) {
          const parsed = parseFilename(file.name);

          try {
            const tmdb = await resolveMedia(
              parsed,
              env
            );

            results.push({
              filename: file.name,
              fileId: file.id,

              parsedTitle: parsed.title,
              year: parsed.year,

              tmdbId:
                tmdb?.id ??
                parsed.tmdbId ??
                null,

              type:
                parsed.tmdbType ??
                tmdb?.type ??
                "movie",

              title:
                tmdb?.title ??
                tmdb?.name ??
                null,

              originalTitle:
                tmdb?.originalTitle ??
                tmdb?.originalName ??
                null,

              overview:
                tmdb?.overview ??
                "",

              posterUrl:
                tmdb?.posterPath
                  ? getPosterUrl(
                      tmdb.posterPath
                    )
                  : null,

              backdropUrl:
                tmdb?.backdropPath
                  ? getBackdropUrl(
                      tmdb.backdropPath,
                      "w1280"
                    )
                  : null,

              voteAverage:
                tmdb?.voteAverage ??
                null,

              parserQueries:
                parsed.queries,

              status: tmdb
                ? "ok"
                : "not_found"
            });

          } catch (error) {
            results.push({
              filename: file.name,
              fileId: file.id,

              parsedTitle: parsed.title,
              year: parsed.year,

              tmdbId:
                parsed.tmdbId ??
                null,

              type:
                parsed.tmdbType ??
                "movie",

              parserQueries:
                parsed.queries,

              status: "tmdb_error",

              error: error.message
            });
          }
        }

        // 5. Tổng kết
        const success = results.filter(
          (item) => item.status === "ok"
        ).length;

        const failed =
          results.length - success;

        return new Response(
          JSON.stringify(
            {
              status: "ok",

              totalFiles:
                videoFiles.length,

              tested:
                testFiles.length,

              success,

              failed,

              results
            },
            null,
            2
          ),
          {
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify(
            {
              status: "error",
              test: "drive_tmdb_failed",
              message: error.message,
              stack: error.stack
            },
            null,
            2
          ),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }
// ---------------------------------------------------------
// Tự động refresh rating toàn bộ phim
// Trình duyệt tự chạy từng batch 5 phim
// ---------------------------------------------------------
if (url.pathname === "/test/refresh-ratings-all") {
  const html = `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>TM-LT - Refresh Ratings</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      line-height: 1.5;
    }

    h1 {
      margin-bottom: 10px;
    }

    #status {
      padding: 15px;
      background: #f3f3f3;
      border-radius: 8px;
      white-space: pre-wrap;
    }

    #log {
      margin-top: 20px;
      padding: 15px;
      background: #111;
      color: #0f0;
      border-radius: 8px;
      white-space: pre-wrap;
      font-family: Consolas, monospace;
      max-height: 500px;
      overflow-y: auto;
    }
  </style>
</head>

<body>

<h1>TM-LT - Cập nhật Rating</h1>

<div id="status">
Đang chuẩn bị...
</div>

<div id="log"></div>

<script>
async function refreshAllRatings() {
  const status = document.getElementById("status");
  const log = document.getElementById("log");

  let offset = 0;
  const limit = 5;

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalFailed = 0;

  function writeLog(message) {
    log.textContent += message + "\\n";
    log.scrollTop = log.scrollHeight;
  }

  try {
    while (true) {
      status.textContent =
        "Đang xử lý...\\\\n" +
        "Offset: " + offset + "\\\\n" +
        "Đã xử lý: " + totalProcessed + " phim\\\\n" +
        "Đã cập nhật: " + totalUpdated + " phim\\\\n" +
        "Lỗi: " + totalFailed;

      writeLog(
        "→ Đang xử lý offset " +
        offset +
        "..."
      );

      const response = await fetch(
        "/test/refresh-ratings?offset=" +
        offset +
        "&limit=" +
        limit
      );

      if (!response.ok) {
        throw new Error(
          "HTTP " + response.status
        );
      }

      const data = await response.json();

      if (data.status !== "ok") {
        throw new Error(
          data.message || "Batch thất bại"
        );
      }

      totalProcessed += data.processed || 0;
      totalUpdated += data.updated || 0;
      totalFailed += data.failed || 0;

      writeLog(
        "✓ Offset " +
        offset +
        ": " +
        data.updated +
        "/" +
        data.processed +
        " cập nhật, lỗi " +
        data.failed
      );

      if (
        data.errors &&
        data.errors.length > 0
      ) {
        for (const error of data.errors) {
          writeLog(
            "  ✗ " +
            error.title +
            " - " +
            error.error
          );
        }
      }

      if (
        data.nextOffset === null ||
        data.processed === 0
      ) {
        break;
      }

      offset = data.nextOffset;

      // Nghỉ 300ms giữa các batch
      await new Promise(
        resolve => setTimeout(resolve, 300)
      );
    }

    status.textContent =
      "HOÀN TẤT!\\\\n\\\\n" +
      "Đã xử lý: " +
      totalProcessed +
      " phim\\\\n" +
      "Đã cập nhật: " +
      totalUpdated +
      " phim\\\\n" +
      "Lỗi: " +
      totalFailed +
      " phim";

    writeLog("");
    writeLog("================================");
    writeLog("HOÀN TẤT");
    writeLog(
      "Tổng xử lý: " +
      totalProcessed
    );
    writeLog(
      "Tổng cập nhật: " +
      totalUpdated
    );
    writeLog(
      "Tổng lỗi: " +
      totalFailed
    );
    writeLog("================================");

  } catch (error) {
    status.textContent =
      "CÓ LỖI: " +
      error.message;

    writeLog(
      "✗ LỖI: " +
      error.message
    );
  }
}

refreshAllRatings();
</script>

</body>
</html>
`;

  return new Response(html, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/html; charset=UTF-8"
    }
  });
}
// ---------------------------------------------------------
// Test refresh TMDB rating -> D1
// Mỗi lần cập nhật tối đa 5 phim
// ---------------------------------------------------------
if (url.pathname === "/test/refresh-ratings") {
  try {
    const offset = Math.max(
      0,
      Number(url.searchParams.get("offset") || 0)
    );

    const limit = Math.min(
      5,
      Math.max(
        1,
        Number(url.searchParams.get("limit") || 5)
      )
    );

    const result = await env.tm_lt_db
      .prepare(
        `SELECT
           id,
           tmdb_id,
           title
         FROM movies
         WHERE is_active = 1
           AND tmdb_id IS NOT NULL
         ORDER BY id ASC
         LIMIT ? OFFSET ?`
      )
      .bind(limit, offset)
      .all();

    const movies = result.results || [];

    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const movie of movies) {
      try {
        const tmdb = await resolveMovieById(
          movie.tmdb_id,
          env
        );

        if (
          !tmdb ||
          tmdb.voteAverage === null ||
          tmdb.voteAverage === undefined
        ) {
          failed++;

          errors.push({
            id: movie.id,
            title: movie.title,
            tmdbId: movie.tmdb_id,
            error: "Không lấy được voteAverage từ TMDB"
          });

          continue;
        }

        await env.tm_lt_db
          .prepare(
            `UPDATE movies
             SET vote_average = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .bind(
            Number(tmdb.voteAverage),
            movie.id
          )
          .run();

        updated++;
      } catch (error) {
        failed++;

        errors.push({
          id: movie.id,
          title: movie.title,
          tmdbId: movie.tmdb_id,
          error: error.message
        });
      }
    }

    const nextOffset =
      offset + movies.length;

    const hasMore =
      movies.length === limit;

    return new Response(
      JSON.stringify(
        {
          status: "ok",
          offset,
          limit,
          processed: movies.length,
          updated,
          failed,
          nextOffset: hasMore
            ? nextOffset
            : null,
          nextBatchUrl: hasMore
            ? `/test/refresh-ratings?offset=${nextOffset}&limit=${limit}`
            : null,
          errors
        },
        null,
        2
      ),
      {
        headers: {
          ...CORS_HEADERS,
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify(
        {
          status: "error",
          message: error.message,
          stack: error.stack
        },
        null,
        2
      ),
      {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
// ---------------------------------------------------------
// Helper - Reindex Google Drive -> Parser -> TMDB -> D1
// ---------------------------------------------------------

// ---------------------------------------------------------
// Test Reindex Google Drive -> Parser -> TMDB -> D1
// Chỉ xử lý file mới hoặc file đã thay đổi
// ---------------------------------------------------------
if (url.pathname === "/test/reindex") {
  let jobId = null;

  try {
    // -----------------------------------------------------
    // Batch Reindex
    // Mặc định mỗi lần xử lý 5 file
    // -----------------------------------------------------
    const offset = Math.max(
      0,
      Number(url.searchParams.get("offset") || 0)
    );

    const batchSize = Math.min(
      5,
      Math.max(
        1,
        Number(url.searchParams.get("limit") || 5)
      )
    );

    const existingJobId =
      Number(url.searchParams.get("jobId") || 0) || null;
        // -----------------------------------------------------
        // 1. Lấy thư viện đang bật
        // -----------------------------------------------------
        const library = await env.tm_lt_db
          .prepare(
            `SELECT id, name, folder_id
             FROM libraries
             WHERE enabled = 1
             ORDER BY id
             LIMIT 1`
          )
          .first();

        if (!library) {
          return new Response(
            JSON.stringify(
              {
                status: "error",
                reindex: "library_not_found",
                message:
                  "Không tìm thấy thư viện Google Drive đang được bật"
              },
              null,
              2
            ),
            {
              status: 404,
              headers: {
                "content-type":
                  "application/json; charset=UTF-8"
              }
            }
          );
        }

        // -----------------------------------------------------
// 2. Tạo job mới hoặc tiếp tục job hiện tại
// -----------------------------------------------------
if (existingJobId) {
  jobId = existingJobId;
} else {
  const job = await env.tm_lt_db
    .prepare(
      `INSERT INTO reindex_jobs (
        library_id,
        status
      )
      VALUES (?, ?)`
    )
    .bind(
      library.id,
      "running"
    )
    .run();

  jobId =
    job.meta?.last_row_id ?? null;
}
        // -----------------------------------------------------
        // 3. Scan toàn bộ Google Drive
        // -----------------------------------------------------
        const driveFiles =
          await scanDriveLibrary(
            env,
            library.folder_id
          );

        const videoFiles =
          driveFiles.filter(
            (file) =>
              file?.mimeType?.startsWith("video/") ||
              /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(
                file?.name || ""
              )
          );

        // Ghi files_found ngay sau khi scan
        await env.tm_lt_db
          .prepare(
            `UPDATE reindex_jobs
             SET files_found = ?
             WHERE id = ?`
          )
          .bind(
            videoFiles.length,
            jobId
          )
          .run();

        // -----------------------------------------------------
        // 4. Danh sách Drive ID hiện tại
        // -----------------------------------------------------
        const currentDriveIds =
          new Set(
            videoFiles.map(
              (file) => file.id
            )
          );

        // -----------------------------------------------------
// 5. Bộ đếm
// -----------------------------------------------------
let filesAdded = 0;
let filesUpdated = 0;
let filesSkipped = 0;
let filesFailed = 0;

let errors = [];

// -----------------------------------------------------
// Nếu tiếp tục job cũ thì lấy số liệu đã tích lũy
// -----------------------------------------------------
if (existingJobId) {
  const previousJob =
    await env.tm_lt_db
      .prepare(
        `SELECT
           files_added,
           files_updated,
           files_removed,
           error_message
         FROM reindex_jobs
         WHERE id = ?
         LIMIT 1`
      )
      .bind(existingJobId)
      .first();

  if (previousJob) {
    filesAdded =
      Number(previousJob.files_added || 0);

    filesUpdated =
      Number(previousJob.files_updated || 0);

    try {
      errors =
        previousJob.error_message
          ? JSON.parse(
              previousJob.error_message
            )
          : [];
    } catch {
      errors = [];
    }
  }
}

        // -----------------------------------------------------
        // 6. Xử lý từng file
        // -----------------------------------------------------
                // -----------------------------------------------------
        // Retry TMDB khi gặp lỗi tạm thời
        // -----------------------------------------------------
        const resolveMediaWithRetry =
          async (parsed) => {
            const maxAttempts = 3;

            for (
              let attempt = 1;
              attempt <= maxAttempts;
              attempt++
            ) {
              try {
                return await resolveMedia(
                  parsed,
                  env
                );
              } catch (error) {
                const message =
                  error?.message ||
                  String(error);

                const isTransient =
                  /TMDB HTTP (502|503|504)\b/i.test(
                    message
                  );

                // Không phải lỗi tạm thời
                // thì không retry
                if (!isTransient) {
                  throw error;
                }

                // Đã hết số lần thử
                if (
                  attempt === maxAttempts
                ) {
                  throw error;
                }

                // Chờ tăng dần:
                // lần 1 -> 1 giây
                // lần 2 -> 2 giây
                await new Promise(
                  (resolve) =>
                    setTimeout(
                      resolve,
                      attempt * 1000
                    )
                );
              }
            }

            return null;
          };

        // -----------------------------------------------------
        // 6. Xử lý từng file
        // -----------------------------------------------------
	const batchFiles =
  videoFiles.slice(
    offset,
    offset + batchSize
  );

for (const file of batchFiles) {
          try {
            // -------------------------------------------------
            // Kiểm tra file đã tồn tại trong D1 chưa
            // -------------------------------------------------
            const existing =
              await env.tm_lt_db
                .prepare(
                  `SELECT
                     id,
                     drive_name,
                     drive_modified_time,
                     is_active
                   FROM movies
                   WHERE drive_file_id = ?
                   LIMIT 1`
                )
                .bind(file.id)
                .first();

            // -------------------------------------------------
            // Nếu file đã tồn tại và không thay đổi:
            // BỎ QUA, không gọi Parser, không gọi TMDB
            // -------------------------------------------------
            if (
              existing &&
              existing.drive_name === file.name &&
              (existing.drive_modified_time ?? null) ===
                (file.modifiedTime ?? null)
            ) {
              // Nếu trước đó bị inactive nhưng hiện đã quay lại
              // thì chỉ cần kích hoạt lại.
              if (existing.is_active !== 1) {
                await env.tm_lt_db
                  .prepare(
                    `UPDATE movies
                     SET is_active = 1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`
                  )
                  .bind(existing.id)
                  .run();
              }

              filesSkipped++;
              continue;
            }

            // -------------------------------------------------
            // File mới hoặc file đã thay đổi
            // -------------------------------------------------
            const parsed =
              parseFilename(file.name);

            const tmdb =
              await resolveMediaWithRetry(
                parsed
              );

            // -------------------------------------------------
            // Không tìm thấy TMDB
            // -------------------------------------------------
            if (!tmdb) {
              filesFailed++;

              errors.push({
                driveFileId: file.id,
                fileName: file.name,
                error:
                  "Không tìm thấy thông tin TMDB"
              });

              continue;
            }

            const title =
              tmdb.title ||
              parsed.title;

            const year =
              tmdb.year ??
              parsed.year ??
              null;

            const tmdbId =
              tmdb.tmdbId ??
              parsed.tmdbId ??
              null;

            const tmdbType =
              tmdb.type ??
              parsed.tmdbType ??
              "movie";

            const posterUrl =
              tmdb.posterPath
                ? getPosterUrl(
                    tmdb.posterPath
                  )
                : null;

            const backdropUrl =
              tmdb.backdropPath
                ? getBackdropUrl(
                    tmdb.backdropPath,
                    "w1280"
                  )
                : null;

            const overview =
              tmdb.overview || "";

            const genres =
              Array.isArray(tmdb.genres)
                ? JSON.stringify(
                    tmdb.genres
                  )
                : "[]";

            // -------------------------------------------------
            // Upsert movie
            // -------------------------------------------------
            await env.tm_lt_db
              .prepare(
                `INSERT INTO movies (
  library_id,
  drive_file_id,
  drive_parent_id,
  drive_name,
  drive_mime_type,
  drive_size,
  drive_modified_time,
  title,
  year,
  tmdb_id,
  tmdb_type,
  poster_url,
  backdrop_url,
  overview,
  genres,
  vote_average,
  is_active
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(drive_file_id)
DO UPDATE SET
  library_id = excluded.library_id,
  drive_parent_id = excluded.drive_parent_id,
  drive_name = excluded.drive_name,
  drive_mime_type = excluded.drive_mime_type,
  drive_size = excluded.drive_size,
  drive_modified_time = excluded.drive_modified_time,
  title = excluded.title,
  year = excluded.year,
  tmdb_id = excluded.tmdb_id,
  tmdb_type = excluded.tmdb_type,
  poster_url = excluded.poster_url,
  backdrop_url = excluded.backdrop_url,
  overview = excluded.overview,
  genres = excluded.genres,
   vote_average = excluded.vote_average,
  is_active = 1,
  updated_at = CURRENT_TIMESTAMP
`
              )
              .bind(
  library.id,
  file.id,
  file.parents?.[0] ?? null,
  file.name,
  file.mimeType ?? null,
  file.size
    ? Number(file.size)
    : null,
  file.modifiedTime ?? null,
  title,
  year,
  tmdbId,
  tmdbType,
  posterUrl,
  backdropUrl,
  overview,
  genres,
  tmdb?.voteAverage ?? 0
)
.run();

            // -------------------------------------------------
            // Đếm thêm / cập nhật
            // -------------------------------------------------
            if (existing) {
              filesUpdated++;
            } else {
              filesAdded++;
            }

            // -------------------------------------------------
            // Tạo stream nếu chưa có
            // -------------------------------------------------
            await env.tm_lt_db
              .prepare(
                `INSERT INTO streams (
                  movie_id,
                  stream_type,
                  drive_file_id
                )
                SELECT
                  id,
                  'google_drive',
                  ?
                FROM movies
                WHERE drive_file_id = ?
                AND NOT EXISTS (
                  SELECT 1
                  FROM streams
                  WHERE drive_file_id = ?
                )`
              )
              .bind(
                file.id,
                file.id,
                file.id
              )
              .run();

          } catch (fileError) {
            // -------------------------------------------------
            // Lỗi một file không làm dừng toàn bộ Reindex
            // -------------------------------------------------
            filesFailed++;

            errors.push({
              driveFileId: file.id,
              fileName: file.name,
              error:
                fileError?.message ||
                String(fileError)
            });
          }
        }

 // -----------------------------------------------------
// 7. Đánh dấu movie không còn trên Drive là inactive
// Chỉ thực hiện khi đã xử lý batch cuối cùng
// -----------------------------------------------------
let filesRemoved = 0;

const isLastBatch =
  offset + batchSize >= videoFiles.length;

if (isLastBatch) {
  const activeMovies =
    await env.tm_lt_db
      .prepare(
        `SELECT
           id,
           drive_file_id
         FROM movies
         WHERE library_id = ?`
      )
      .bind(library.id)
      .all();

  for (
    const movie
    of activeMovies.results || []
  ) {
    if (
      !currentDriveIds.has(
        movie.drive_file_id
      )
    ) {
      await env.tm_lt_db
        .prepare(
          `UPDATE movies
           SET is_active = 0,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(movie.id)
        .run();

      filesRemoved++;
    }
  }
}

// -----------------------------------------------------
// 9. Cập nhật reindex job
// -----------------------------------------------------
const finalStatus =
  isLastBatch
    ? (
        filesFailed > 0
          ? "completed_with_errors"
          : "completed"
      )
    : "running";

const errorMessage =
  errors.length > 0
    ? JSON.stringify(errors)
    : null;

await env.tm_lt_db
  .prepare(
    `UPDATE reindex_jobs
     SET
       status = ?,
       finished_at = ?,
       files_found = ?,
       files_added = ?,
       files_updated = ?,
       files_removed = ?,
       error_message = ?
     WHERE id = ?`
  )
  .bind(
    finalStatus,
    isLastBatch
      ? new Date().toISOString()
      : null,
    videoFiles.length,
    filesAdded,
    filesUpdated,
    filesRemoved,
    errorMessage,
    jobId
  )
  .run();

        // -----------------------------------------------------
        // 10. Kết quả
        // -----------------------------------------------------
        return new Response(
          JSON.stringify(
            {
              status: "ok",
              reindex: finalStatus,

              jobId,
 		nextOffset:
  isLastBatch
    ? null
    : offset + batchSize,

nextBatchUrl:
  isLastBatch
    ? null
    : `${url.origin}/test/reindex?offset=${offset + batchSize}&limit=${batchSize}&jobId=${jobId}`,
              library: {
                id: library.id,
                name: library.name,
                folderId:
                  library.folder_id
              },

              filesFound:
                videoFiles.length,

              filesAdded,

              filesUpdated,

              filesSkipped,

              filesRemoved,

              filesFailed,

              errors
            },
            null,
            2
          ),
          {
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );

      } catch (error) {

        // -----------------------------------------------------
        // Lỗi toàn bộ Reindex
        // -----------------------------------------------------
        if (jobId !== null) {
          try {
            await env.tm_lt_db
              .prepare(
                `UPDATE reindex_jobs
                 SET
                   status = ?,
                   finished_at = CURRENT_TIMESTAMP,
                   error_message = ?
                 WHERE id = ?`
              )
              .bind(
                "failed",
                error?.message ||
                  String(error),
                jobId
              )
              .run();
          } catch {
            // Không che mất lỗi gốc
          }
        }

        return new Response(
          JSON.stringify(
            {
              status: "error",
              reindex: "failed",
              jobId,
              message:
                error?.message ||
                String(error),
              stack:
                error?.stack || null
            },
            null,
            2
          ),
          {
            status: 500,
            headers: {
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
        }

    // ---------------------------------------------------------
        // ---------------------------------------------------------
    // Stremio Catalog - Kho Phim Gia Đình
    // ---------------------------------------------------------
    // ---------------------------------------------------------
// Stremio Catalogs
// 4 danh mục:
// 1. Tất cả phim
// 2. A -> Z
// 3. Mới nhất
// 4. Điểm cao
// ---------------------------------------------------------
const catalogMatch =
  url.pathname.match(
    /^\/catalog\/movie\/([^/]+)\.json$/
  );

if (catalogMatch) {
  const catalogId =
    catalogMatch[1];

  const catalogOrders = {
    "kho-phim-gia-dinh":
      "title COLLATE NOCASE ASC",

    "phim-a-z":
      "title COLLATE NOCASE ASC",

    "phim-moi-nhat":
      "year DESC, title COLLATE NOCASE ASC",

    "phim-diem-cao":
      "vote_average DESC, title COLLATE NOCASE ASC"
  };

  const orderBy =
    catalogOrders[catalogId];

  if (orderBy) {
    try {
      const result =
        await env.tm_lt_db
          .prepare(
            `SELECT
               tmdb_id,
               tmdb_type,
               title,
               year,
               poster_url,
               backdrop_url,
               overview,
               vote_average
             FROM movies
             WHERE id IN (
  SELECT MIN(id)
  FROM movies
  WHERE is_active = 1
    AND tmdb_id IS NOT NULL
  GROUP BY tmdb_id
)
             ORDER BY ${orderBy}`
          )
          .all();

      const metas =
        (result.results || [])
          .map(
            (movie) => ({
              id:
                `${movie.tmdb_type || "movie"}:${movie.tmdb_id}`,

              type:
                movie.tmdb_type || "movie",

              name:
                movie.title ||
                "Không có tên",

              releaseInfo:
                movie.year
                  ? String(movie.year)
                  : undefined,

              poster:
                movie.poster_url ||
                undefined,

              background:
                movie.backdrop_url ||
                undefined,

              description:
                movie.overview ||
                undefined
            })
          );

      return new Response(
        JSON.stringify(
          {
            metas
          },
          null,
          2
        ),
        {
          headers: {
            ...CORS_HEADERS,
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    } catch (error) {
      return new Response(
        JSON.stringify(
          {
            metas: [],
            error:
              error?.message ||
              String(error)
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            ...CORS_HEADERS,
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }
  }
}
    // ---------------------------------------------------------
    // Stremio Meta - Chi tiết phim
    // ---------------------------------------------------------
    if (url.pathname.startsWith("/meta/movie/")) {
      try {
        const metaId =
          decodeURIComponent(
            url.pathname
              .replace("/meta/movie/", "")
              .replace(".json", "")
          );

        const tmdbId =
          metaId.startsWith("movie:")
            ? metaId.replace("movie:", "")
            : metaId;

        const movie =
          await env.tm_lt_db
            .prepare(
              `SELECT
                 tmdb_id,
                 tmdb_type,
                 title,
                 year,
                 poster_url,
                 backdrop_url,
                 overview,
                 genres
               FROM movies
               WHERE tmdb_id = ?
                 AND is_active = 1
               LIMIT 1`
            )
            .bind(Number(tmdbId))
            .first();

        if (!movie) {
          return new Response(
            JSON.stringify({
              meta: null
            }),
            {
              status: 404,
              headers: {
...CORS_HEADERS,
                "content-type":
                  "application/json; charset=UTF-8"
              }
            }
          );
        }

        let genres = [];

        try {
          genres =
            movie.genres
              ? JSON.parse(movie.genres)
              : [];
        } catch {
          genres = [];
        }

        return new Response(
          JSON.stringify(
            {
              meta: {
                id:
                  `movie:${movie.tmdb_id}`,
                type: "movie",
                name:
                  movie.title ||
                  "Không có tên",
                releaseInfo:
                  movie.year
                    ? String(movie.year)
                    : undefined,
                poster:
                  movie.poster_url ||
                  undefined,
                background:
                  movie.backdrop_url ||
                  undefined,
                description:
                  movie.overview ||
                  undefined,
                genres
              }
            },
            null,
            2
          ),
          {
            headers: {
...CORS_HEADERS,
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify(
            {
              meta: null,
              error:
                error?.message ||
                String(error)
            },
            null,
            2
          ),
          {
            status: 500,
            headers: {
...CORS_HEADERS,
              "content-type":
                "application/json; charset=UTF-8"
            }
          }
        );
      }
    }
// ---------------------------------------------------------
// Stremio Stream - Google Drive Proxy
// ---------------------------------------------------------
if (url.pathname.startsWith("/stream/movie/")) {
  try {
    const streamId =
      decodeURIComponent(
        url.pathname
          .replace("/stream/movie/", "")
          .replace(".json", "")
      );

    const tmdbId =
      streamId.startsWith("movie:")
        ? streamId.replace("movie:", "")
        : streamId;

    const result =
      await env.tm_lt_db
        .prepare(
          `SELECT
             m.id,
             m.tmdb_id,
             m.title,
             m.drive_name,
             s.drive_file_id
           FROM movies m
           INNER JOIN streams s
             ON s.movie_id = m.id
           WHERE m.tmdb_id = ?
             AND m.is_active = 1
             AND s.stream_type = 'google_drive'
           ORDER BY m.id ASC`
        )
        .bind(Number(tmdbId))
        .all();

    const movies =
      result.results || [];

    if (movies.length === 0) {
      return new Response(
        JSON.stringify({
          streams: []
        }),
        {
          status: 404,
          headers: {
            ...CORS_HEADERS,
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    const streams =
      movies.map((movie) => {
        const fileName =
          movie.drive_name ||
          "";

// ---------------------------------------------------------
// Nhận diện phiên bản + chất lượng từ tên file
// ---------------------------------------------------------

let languageLabel =
  "🎧 Âm thanh gốc";

// Thuyết minh
if (
  /thuyet[\s._-]*minh/i.test(fileName) ||
  /thuyết[\s._-]*minh/i.test(fileName)
) {
  languageLabel =
    "🇻🇳 Thuyết minh";

// Phụ đề Việt
} else if (
  /viet[\s._-]*sub/i.test(fileName) ||
  /vietsub/i.test(fileName) ||
  /phu[\s._-]*de/i.test(fileName) ||
  /phụ[\s._-]*đề/i.test(fileName)
) {
  languageLabel =
    "🇻🇳 Phụ đề Việt";

// English Sub
} else if (
  /eng[\s._-]*sub/i.test(fileName) ||
  /english[\s._-]*sub/i.test(fileName)
) {
  languageLabel =
    "🇬🇧 English Sub";
}


// ---------------------------------------------------------
// Nhận diện chất lượng
// ---------------------------------------------------------

let qualityLabel = "";

if (/\b2160p\b/i.test(fileName)) {
  qualityLabel = "4K";
} else if (/\b1440p\b/i.test(fileName)) {
  qualityLabel = "1440p";
} else if (/\b1080p\b/i.test(fileName)) {
  qualityLabel = "1080p";
} else if (/\b720p\b/i.test(fileName)) {
  qualityLabel = "720p";
} else if (/\b576p\b/i.test(fileName)) {
  qualityLabel = "576p";
} else if (/\b480p\b/i.test(fileName)) {
  qualityLabel = "480p";
}


// ---------------------------------------------------------
// Tạo tên Stream hoàn chỉnh
// ---------------------------------------------------------

const streamTitle =
  qualityLabel
    ? `${languageLabel} • ${qualityLabel}`
    : languageLabel;

        const streamUrl =
          `${url.origin}/file/${encodeURIComponent(
            movie.drive_file_id
          )}`;

        return {
          name:
            "Kho Phim Gia Đình",
          title:
            streamTitle,
          url:
            streamUrl
        };
      });

    return new Response(
      JSON.stringify(
        {
          streams
        },
        null,
        2
      ),
      {
        headers: {
          ...CORS_HEADERS,
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify(
        {
          streams: [],
          error:
            error?.message ||
            String(error)
        },
        null,
        2
      ),
      {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}

// ---------------------------------------------------------
// Google Drive File Proxy
// ---------------------------------------------------------
if (url.pathname.startsWith("/file/")) {
  try {
    const fileId =
      decodeURIComponent(
        url.pathname
          .replace("/file/", "")
      );

    if (!fileId) {
      return new Response(
        "Missing file ID",
        {
          status: 400
        }
      );
    }

    const driveResponse =
      await getDriveFileStream(
        env,
        fileId,
        request
      );

    const responseHeaders =
      new Headers();

    const contentType =
      driveResponse.headers.get(
        "content-type"
      );

    const contentLength =
      driveResponse.headers.get(
        "content-length"
      );

    const contentRange =
      driveResponse.headers.get(
        "content-range"
      );

    const acceptRanges =
      driveResponse.headers.get(
        "accept-ranges"
      );

    if (contentType) {
      responseHeaders.set(
        "content-type",
        contentType
      );
    }

    if (contentLength) {
      responseHeaders.set(
        "content-length",
        contentLength
      );
    }

    if (contentRange) {
      responseHeaders.set(
        "content-range",
        contentRange
      );
    }

    if (acceptRanges) {
      responseHeaders.set(
        "accept-ranges",
        acceptRanges
      );
    }
responseHeaders.set(
  "Access-Control-Allow-Origin",
  "*"
);
    return new Response(
      driveResponse.body,
      {
        status: driveResponse.status,
        headers: responseHeaders
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify(
        {
          status: "error",
          file: "download_failed",
          message:
            error?.message ||
            String(error)
        },
        null,
        2
      ),
      {
        status: 500,
        headers: {
...CORS_HEADERS,
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );
  }
}
    // Stremio Manifest
    // ---------------------------------------------------------
    if (url.pathname === "/manifest.json") {
      return new Response(
        JSON.stringify({
          id: "tm-lt-stremio",
          version: "1.0.0",
          name: "Kho Phim Gia Đình",
          description:
            "Kho phim gia đình từ Google Drive",
          resources: [
            "catalog",
            "meta",
            "stream"
          ],
          types: [
            "movie",
            "series"
          ],
catalogs: [
  {
    type: "movie",
    id: "kho-phim-gia-dinh",
    name: "🎬 Tất cả phim"
  },
  {
    type: "movie",
    id: "phim-a-z",
    name: "🔤 Phim A → Z"
  },
  {
    type: "movie",
    id: "phim-moi-nhat",
    name: "📅 Phim mới nhất"
  },
  {
    type: "movie",
    id: "phim-diem-cao",
    name: "⭐ Phim điểm cao"
  }
]
        }, null, 2),
        {
          headers: {
  ...CORS_HEADERS,
  "content-type":
    "application/json; charset=UTF-8"
          }
        }
      );
    }

           return new Response(
      "TM-LT: Not Found",
      { status: 404 }
    );
  },
async queue(batch, env) {
  console.log(
    `TM-LT Queue: nhận ${batch.messages.length} message(s)`
  );

  for (const message of batch.messages) {
    try {
      const job = message.body;

      console.log(
        "TM-LT Queue message:",
        JSON.stringify(job)
      );

      const result = await runReindexWorker(env, {
        libraryId: job.libraryId,
        offset: job.offset || 0,
        batchSize: job.batchSize || 5,
        existingJobId: job.existingJobId || null,
        origin: "queue"
      });

      const resultText = await result.clone().text();

      console.log(
        "TM-LT Queue result:",
        resultText
      );

      const data = JSON.parse(resultText);

      // Nếu vẫn còn batch tiếp theo → tự đưa vào Queue
      if (
        data.status === "ok" &&
        data.nextOffset !== null &&
        data.nextOffset !== undefined &&
        data.nextOffset < data.filesFound
      ) {
        const nextJob = {
          libraryId: job.libraryId,
          offset: data.nextOffset,
          batchSize: job.batchSize || 5,
          existingJobId: data.jobId
        };

        console.log(
          "TM-LT Queue: gửi batch tiếp theo:",
          JSON.stringify(nextJob)
        );

        await env.tm_lt_reindex.send(nextJob);
      } else {
        console.log(
          "TM-LT Queue: Reindex đã hoàn tất."
        );
      }

      message.ack();

    } catch (error) {
      console.error(
        "TM-LT Queue error:",
        error
      );

      message.retry();
    }
  }
}
};