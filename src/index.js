import {
  testDriveConnection,
  scanDriveLibrary,
  getDriveFileStream
} from "./drive.js";
import {
  getMovieById,
  getTvById,
  getTvEpisodeById,
   searchMovie,
   searchTv,
   pickBestMovieResult,
   pickBestTvResult,
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
             status,
             started_at,
             finished_at,
             files_found,
             files_added,
             files_updated,
             files_removed,
             error_message
           )
           VALUES (
             ?,
             ?,
             CURRENT_TIMESTAMP,
             NULL,
             0,
             0,
             0,
             0,
             NULL
           )`
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
              season,
              episode,
              is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
              season = excluded.season,
              episode = excluded.episode,
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
            tmdb?.voteAverage ?? 0,
            parsed.season ?? null,
            parsed.episode ?? null
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

  .admin-nav {
    display: none;
    position: sticky;
    top: 10px;
    z-index: 5;
    gap: 6px;
    overflow-x: auto;
    padding: 8px;
    margin-bottom: 12px;
    background: rgba(11, 15, 20, 0.92);
    border: 1px solid #202733;
    border-radius: 12px;
    backdrop-filter: blur(12px);
  }

  .admin-nav.is-ready {
    display: flex;
  }

  .admin-nav button {
    flex: 0 0 auto;
    background: transparent;
    border-color: transparent;
    color: #aab3c2;
  }

  .admin-nav button.is-active {
    background: #1d4ed8;
    color: #fff;
  }

  .admin-panel {
    display: none;
  }

  .admin-panel.is-active {
    display: block;
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 10px 0 14px;
  }

  .dashboard-stat {
    padding: 12px;
    border: 1px solid #253141;
    border-radius: 10px;
    background: #0c1117;
  }

  .dashboard-stat-label {
    color: #8b95a5;
    font-size: 11px;
  }

  .dashboard-stat-value {
    margin-top: 5px;
    color: #f8fafc;
    font-size: 22px;
    font-weight: 750;
  }

  .dashboard-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .job-list {
    display: grid;
    gap: 8px;
  }

  .job-item {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 10px;
    border-radius: 9px;
    background: #0c1117;
    border: 1px solid #202733;
  }

  .job-meta {
    color: #8b95a5;
    font-size: 11px;
    margin-top: 3px;
  }

  .status-pill {
    align-self: flex-start;
    padding: 3px 7px;
    border-radius: 999px;
    background: #263244;
    color: #dbeafe;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }

  .status-pill.completed {
    background: #143321;
    color: #86efac;
  }

  .status-pill.failed {
    background: #3a1d22;
    color: #fca5a5;
  }

  .status-pill.running,
  .status-pill.queued {
    background: #3b2c13;
    color: #fde68a;
  }

  #toastContainer {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 10;
    display: grid;
    gap: 8px;
    max-width: min(360px, calc(100vw - 32px));
  }

  .toast {
    padding: 11px 13px;
    border-radius: 10px;
    background: #172033;
    border: 1px solid #334155;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
    color: #e5e7eb;
    font-size: 13px;
  }

  .toast.success { border-color: #166534; }
  .toast.error { border-color: #991b1b; }

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

    .dashboard-grid {
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

  <nav id="adminNav" class="admin-nav" aria-label="Điều hướng quản trị">
    <button type="button" data-admin-tab="overview" onclick="showAdminTab('overview')">Tổng quan</button>
    <button type="button" data-admin-tab="libraries" onclick="showAdminTab('libraries')">Thư viện</button>
    <button type="button" data-admin-tab="movies" onclick="showAdminTab('movies')">Phim</button>
    <button type="button" data-admin-tab="duplicates" onclick="showAdminTab('duplicates')">Phim trùng</button>
  </nav>

  <section id="panel-overview" class="card admin-panel" data-panel="overview">
    <div class="section-title">
      <div>
        <h2>📊 Tổng quan vận hành</h2>
        <div class="count">Số liệu chỉ đọc từ thư viện hiện tại</div>
      </div>
      <button class="secondary" type="button" onclick="loadDashboard()">↻ Làm mới</button>
    </div>

    <div id="dashboardStats" class="dashboard-grid">
      <div class="dashboard-stat"><div class="dashboard-stat-label">Đang tải</div><div class="dashboard-stat-value">…</div></div>
    </div>

    <div class="dashboard-actions">
      <button type="button" onclick="showAdminTab('libraries')">📚 Quản lý thư viện</button>
      <button class="secondary" type="button" onclick="showAdminTab('movies')">🎬 Quản lý phim</button>
      <button class="secondary" type="button" onclick="showAdminTab('duplicates')">🧹 Kiểm tra phim trùng</button>
    </div>

    <div class="section-title" style="margin-top:18px;">
      <h2>Hoạt động Reindex gần đây</h2>
    </div>
    <div id="recentJobs" class="job-list status">Chưa tải hoạt động.</div>
  </section>

  <div id="toastContainer" aria-live="polite"></div>


  <!-- CHECK MOVIE -->
  <div class="card admin-panel" data-panel="movies">

    <div class="section-title">
      <h2>🔎 Kiểm tra phim trong kho</h2>
    </div>

    <div style="margin-bottom:10px;">
      <label>Tên file phim</label>

      <input
        id="checkMovieFilename"
        type="text"
        placeholder="Ví dụ: Bao 2018 1080p Blu-ray DTSHD-MA 7.1 HEVC- DDR[EtHD].mkv"
        style="width:100%;"
      >
    </div>

    <button onclick="checkMovie()">
      🔍 Kiểm tra
    </button>

    <div
      id="checkMovieResult"
      class="status"
      style="margin-top:15px;"
    >
      Nhập tên file rồi bấm "Kiểm tra".
    </div>

  </div>


  <!-- DUPLICATE MOVIES -->
  <div class="card admin-panel" data-panel="duplicates">

    <div class="section-title">
      <h2>🧹 Kiểm tra phim trùng trong kho</h2>
    </div>

    <div style="margin-bottom:10px;color:#8b95a5;font-size:13px;">
      Tìm các phim movie có nhiều bản trong các thư viện Google Drive, kèm dung lượng và vị trí kho.
    </div>

    <button onclick="loadDuplicateMovies()">
      🔄 Quét lại danh sách phim trùng
    </button>

    <div
      id="duplicateMovieResult"
      class="status"
      style="margin-top:15px;"
    >
      Chưa quét danh sách phim trùng.
    </div>


  </div>

  <!-- MOVIE VISIBILITY -->
  <div class="card admin-panel" data-panel="movies">

    <div class="section-title">
      <h2>👁️ Ẩn / hiện phim trong kho</h2>
    </div>

    <div style="margin-bottom:12px;color:#8b95a5;font-size:13px;">
      Tìm phim trong thư viện, sau đó ẩn khỏi danh mục Stremio
      hoặc hiện lại mà không xóa phim khỏi Google Drive.
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">

      <input
        id="visibilitySearch"
        placeholder="Nhập tên phim..."
        style="flex:1;min-width:200px;"
      >

      <select id="visibilityStatus" style="min-width:150px;">
        <option value="all">Tất cả trạng thái</option>
        <option value="visible">Đang hiển thị</option>
        <option value="hidden">Đang bị ẩn</option>
      </select>

      <button onclick="loadMoviesVisibility()">
        🔍 Tìm phim
      </button>

    </div>


<div
  id="movieVisibilityResult"
  class="status"
  style="margin-top:12px; max-height:420px; overflow-y:auto; overflow-x:hidden; padding-right:8px;"
>

      Nhập tên phim hoặc bấm "Tìm phim" để tải danh sách.
    </div>

  </div>

  <!-- ADD LIBRARY -->
<div class="card admin-panel" data-panel="libraries">


  <div class="section-title">
    <h2>➕ Thêm thư viện Google Drive</h2>
  </div>

  <div style="margin-bottom:10px;">
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


<!-- LIBRARIES -->
<div class="card admin-panel" data-panel="libraries">

  <div class="section-title library-section-title">

    <div>
      <h2>📚 Thư viện Google Drive</h2>
      <span
        id="library-count"
        class="library-count"
      ></span>
    </div>

    <button
      class="btn btn-primary"
      onclick="reindexAllLibraries()"
    >
      🔄 Reindex tất cả
    </button>

  </div>

  <div
    id="reindex-all-status"
    class="reindex-all-status"
    style="display:none;"
  ></div>

  <div id="libraries">
    Chưa tải danh sách.
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

function showToast(message, type) {
    const container = document.getElementById("toastContainer");

    if (!container) {
        return;
    }

    const toast = document.createElement("div");
    toast.className = "toast " + (type || "");
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
}

function showAdminTab(tab) {
    if (!adminSecret) {
        showToast("Hãy xác thực trước khi quản lý kho phim.", "error");
        return;
    }

    document.querySelectorAll(".admin-panel").forEach(panel => {
        panel.classList.toggle(
            "is-active",
            panel.dataset.panel === tab
        );
    });

    document.querySelectorAll("[data-admin-tab]").forEach(button => {
        button.classList.toggle(
            "is-active",
            button.dataset.adminTab === tab
        );
    });

    if (tab === "overview") {
        loadDashboard();
    }

    if (tab === "movies") {
        loadMoviesVisibility();
    }
}

function setAdminReady() {
    const nav = document.getElementById("adminNav");

    if (nav) {
        nav.classList.add("is-ready");
    }

    showAdminTab("overview");
}

function dashboardStat(label, value) {
    return '<div class="dashboard-stat">' +
        '<div class="dashboard-stat-label">' +
        escapeHtml(label) +
        '</div>' +
        '<div class="dashboard-stat-value">' +
        escapeHtml(String(value ?? 0)) +
        '</div>' +
        '</div>';
}

function formatJobStatus(status) {
    const labels = {
        queued: "Đang chờ",
        running: "Đang chạy",
        completed: "Hoàn tất",
        completed_with_errors: "Hoàn tất có lỗi",
        failed: "Thất bại"
    };

    return labels[status] || status || "Không rõ";
}

function renderDashboard(data) {
    const stats = data.stats || {};
    const statsElement = document.getElementById("dashboardStats");
    const jobsElement = document.getElementById("recentJobs");

    if (statsElement) {
        statsElement.innerHTML = [
            dashboardStat("Thư viện", stats.libraries),
            dashboardStat("Phim đang hiển thị", stats.visibleMovies),
            dashboardStat("Phim đã ẩn", stats.hiddenMovies),
            dashboardStat("Nhóm phim trùng", stats.duplicateMovies)
        ].join("");
    }

    if (!jobsElement) {
        return;
    }

    const jobs = data.recentJobs || [];

    if (!jobs.length) {
        jobsElement.textContent = "Chưa có lịch sử Reindex.";
        return;
    }

    jobsElement.innerHTML = jobs.map(job => {
        const status = String(job.status || "unknown");
        const summary = [
            "Tìm thấy: " + Number(job.files_found || 0),
            "Thêm: " + Number(job.files_added || 0),
            "Cập nhật: " + Number(job.files_updated || 0)
        ].join(" · ");

        return '<div class="job-item">' +
            '<div>' +
            '<strong>' + escapeHtml(job.library_name || "Thư viện đã xóa") + '</strong>' +
            '<div class="job-meta">' +
            escapeHtml(summary) +
            (job.error_message
                ? " · " + escapeHtml(job.error_message)
                : "") +
            '</div>' +
            '</div>' +
            '<span class="status-pill ' + escapeHtml(status) + '">' +
            escapeHtml(formatJobStatus(status)) +
            '</span>' +
            '</div>';
    }).join("");
}

async function loadDashboard() {
    const statsElement = document.getElementById("dashboardStats");
    const jobsElement = document.getElementById("recentJobs");

    if (!adminSecret || !statsElement || !jobsElement) {
        return;
    }

    statsElement.innerHTML = dashboardStat("Đang tải", "…");
    jobsElement.textContent = "Đang tải hoạt động…";

    try {
        const response = await fetch("/admin/dashboard", {
            method: "GET",
            headers: getHeaders()
        });
        const data = await response.json();

        if (!response.ok || data.status !== "ok") {
            throw new Error(data.message || "Không thể tải tổng quan.");
        }

        renderDashboard(data);
    } catch (error) {
        statsElement.innerHTML = dashboardStat("Không tải được", "!");
        jobsElement.innerHTML =
            '<span class="error">' +
            escapeHtml(error.message || "Đã xảy ra lỗi.") +
            '</span>';
    }
}

function toggleAddForm(force) {
    const form = document.getElementById("addForm");
    const open = typeof force === "boolean" ? force : !form.classList.contains("open");
    form.classList.toggle("open", open);
}

function getHeaders() {
    return { "Authorization": "Bearer " + adminSecret };
}
function formatFileSize(bytes) {
    const value = Number(bytes);

    if (!Number.isFinite(value) || value < 0) {
        return "Không rõ";
    }

    if (value < 1024) {
        return value + " B";
    }

    const units = ["KB", "MB", "GB", "TB"];
    let size = value;
    let unitIndex = -1;

    do {
        size /= 1024;
        unitIndex++;
    } while (size >= 1024 && unitIndex < units.length - 1);

    return size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2) + " " + units[unitIndex];
}

async function loadDuplicateMovies() {
    const result = document.getElementById("duplicateMovieResult");

    if (!adminSecret) {
        result.innerHTML =
            '<span style="color:#f87171">' +
            'Vui lòng nhập REINDEX_SECRET và xác thực trước.' +
            '</span>';
        return;
    }

    result.innerHTML =
        '<span style="color:#fbbf24">' +
        '⏳ Đang quét danh sách phim trùng trong D1...' +
        '</span>';

    try {
        const response = await fetch(
            "/admin/duplicate-movies",
            {
                method: "GET",
                headers: getHeaders()
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.message ||
                "Không thể quét phim trùng."
            );
        }

        const duplicateMovies =
            data.duplicateMovies || [];

        if (duplicateMovies.length === 0) {
            result.innerHTML =
                '<div style="color:#4ade80;font-size:18px;font-weight:700;">' +
                '✅ KHÔNG CÓ PHIM TRÙNG' +
                '</div>' +
                '<div style="margin-top:8px;">' +
                'Không có movie nào xuất hiện từ 2 bản trở lên trong các thư viện đang hoạt động.' +
                '</div>';
            return;
        }

        let html =
            '<div style="color:#fbbf24;font-size:18px;font-weight:700;">' +
            '⚠️ PHÁT HIỆN ' +
            escapeHtml(String(data.duplicateMovieCount)) +
            ' PHIM TRÙNG' +
            '</div>';

        html +=
            '<div style="margin-top:8px;line-height:1.7;">' +
            '📄 Tổng số bản: <strong>' +
            escapeHtml(String(data.duplicateCopyCount)) +
            '</strong><br>' +
            '💾 Tổng dung lượng các bản trùng: <strong>' +
            escapeHtml(formatFileSize(data.totalDuplicateBytes)) +
            '</strong>' +
            '</div>';

        html += '<div style="margin-top:15px;">';

        for (const movie of duplicateMovies) {
            html +=
                '<div style="' +
                'padding:14px;' +
                'margin-bottom:12px;' +
                'border-radius:10px;' +
                'background:rgba(255,255,255,0.05);' +
                'border:1px solid rgba(255,255,255,0.08);' +
                '">' +

                '<div style="font-size:17px;font-weight:700;">' +
                '🎬 ' +
                escapeHtml(movie.title || "Không có tên") +
                '</div>' +

                '<div style="margin-top:4px;color:#9ca3af;">' +
                'TMDB: ' +
                escapeHtml(String(movie.tmdbId)) +
                (movie.year ? ' • ' + escapeHtml(String(movie.year)) : '') +
                ' • ' +
                escapeHtml(String(movie.copyCount)) +
                ' bản' +
                '</div>' +

                '<div style="margin-top:4px;">' +
                '💾 Tổng: <strong>' +
                escapeHtml(formatFileSize(movie.totalBytes)) +
                '</strong>' +
                '</div>' +

                '<div style="margin-top:12px;">';

            for (const item of movie.copies || []) {
                const fileUrl =
                    item.driveFileId
                        ? 'https://drive.google.com/file/d/' + encodeURIComponent(item.driveFileId) + '/view'
                        : '';

                const folderUrl =
                    item.folderId
                        ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(item.folderId)
                        : '';

                html +=
                    '<div style="' +
                    'padding:10px;' +
                    'margin-bottom:8px;' +
                    'border-radius:8px;' +
                    'background:rgba(0,0,0,0.16);' +
                    '">' +

                    '<div>' +
                    '<strong>📚 Thư viện:</strong> ' +
                    escapeHtml(item.libraryName || "Không xác định") +
                    '</div>' +

                    '<div style="margin-top:4px;word-break:break-word;">' +
                    '<strong>📄 File:</strong> ' +
                    escapeHtml(item.driveName || "") +
                    '</div>' +

                    '<div style="margin-top:4px;">' +
                    '<strong>💾 Dung lượng:</strong> ' +
                    escapeHtml(formatFileSize(item.driveSize)) +
                    '</div>' +

                    '<div style="margin-top:4px;color:#9ca3af;font-size:12px;word-break:break-all;">' +
                    '<strong>📂 Folder ID:</strong> ' +
                    escapeHtml(item.folderId || "Không rõ") +
                    '</div>';

                if (fileUrl || folderUrl) {
                    html += '<div style="margin-top:8px;">';

                    if (fileUrl) {
                        html +=
                            '<a href="' + fileUrl + '" target="_blank" rel="noopener noreferrer" style="margin-right:12px;">📄 Mở file</a>';
                    }

                    if (folderUrl) {
                        html +=
                            '<a href="' + folderUrl + '" target="_blank" rel="noopener noreferrer">📂 Mở thư viện</a>';
                    }

                    html += '</div>';
                }

                html += '</div>';
            }

            html +=
                '</div>' +
                '</div>';
        }

        html += '</div>';
        result.innerHTML = html;

    } catch (error) {
        result.innerHTML =
            '<span style="color:#f87171">❌ ' +
            escapeHtml(error.message) +
            '</span>';
    }
}

async function loadMoviesVisibility() {
  const result =
      document.getElementById("movieVisibilityResult");

  const search =
      document.getElementById("visibilitySearch").value.trim();

  const status =
      document.getElementById("visibilityStatus").value;

  if (!adminSecret) {
      result.innerHTML =
          '<span style="color:#f87171">' +
          'Vui lòng nhập REINDEX_SECRET và xác thực trước.' +
          '</span>';
      return;
  }

  result.innerHTML =
      '<span style="color:#fbbf24">Đang tải danh sách phim...</span>';

  try {
      const params = new URLSearchParams();
      params.set("q", search);
      params.set("status", status);

      const response = await fetch(
          "/admin/movies-visibility?" + params.toString(),
          {
              method: "GET",
              headers: getHeaders()
          }
      );

      const data = await response.json();

      if (!response.ok || data.status !== "ok") {
          throw new Error(
              data.message || "Không thể tải danh sách phim."
          );
      }

      const movies = data.movies || [];

      if (movies.length === 0) {
          result.innerHTML =
              '<div style="color:#9ca3af;">Không tìm thấy phim phù hợp.</div>';
          return;
      }

      let html =
          '<div style="margin-bottom:12px;color:#9ca3af;">' +
          'Tìm thấy ' + movies.length + ' phim (tối đa 100 kết quả).' +
          '</div>';

      for (const movie of movies) {
          const hidden = movie.is_hidden === true ||
              Number(movie.is_hidden) === 1;

          const title = escapeHtml(
              movie.title || movie.drive_name || "Không có tên"
          );

          const year = movie.year
              ? ' (' + escapeHtml(String(movie.year)) + ')'
              : "";

          const library = escapeHtml(
              movie.library_name || "Không rõ thư viện"
          );

          html +=
              '<div style="' +
                  'display:flex;' +
                  'justify-content:space-between;' +
                  'align-items:center;' +
                  'gap:12px;' +
                  'flex-wrap:wrap;' +
                  'padding:12px;' +
                  'margin-bottom:8px;' +
                  'border:1px solid rgba(148,163,184,0.2);' +
                  'border-radius:8px;' +
              '">' +

                  '<div style="flex:1;min-width:200px;">' +
                      '<div style="font-weight:600;">' +
                          title + year +
                      '</div>' +
                      '<div style="font-size:12px;color:#9ca3af;margin-top:4px;">' +
                          'Thư viện: ' + library +
                      '</div>' +
                      '<div style="font-size:12px;color:' +
                          (hidden ? '#fbbf24' : '#34d399') +
                          ';margin-top:4px;">' +
                          (hidden ? 'Đang bị ẩn khỏi danh mục' : 'Đang hiển thị trong danh mục') +
                      '</div>' +
                  '</div>' +

                  '<button ' +
                      'class="' + (hidden ? 'secondary' : '') + '" ' +
                      'onclick="setMovieVisibility(' +
                          Number(movie.id) + ',' + (!hidden) +
                      ')">' +
                      (hidden ? 'Hiện phim' : 'Ẩn phim') +
                  '</button>' +

              '</div>';
      }

      result.innerHTML = html;

  } catch (error) {
      result.innerHTML =
          '<span style="color:#f87171">' +
          escapeHtml(error.message || "Đã xảy ra lỗi.") +
          '</span>';
  }
}

async function setMovieVisibility(movieId, isHidden) {
  const result =
      document.getElementById("movieVisibilityResult");

  if (!adminSecret) {
      result.innerHTML =
          '<span style="color:#f87171">' +
          'Vui lòng nhập REINDEX_SECRET và xác thực trước.' +
          '</span>';
      return;
  }

  const action = isHidden ? "ẩn" : "hiện";

  if (!confirm("Bạn có chắc muốn " + action + " phim này khỏi danh mục Stremio?")) {
      return;
  }

  try {
      result.innerHTML =
          '<span style="color:#fbbf24">Đang cập nhật trạng thái phim...</span>';

      const response = await fetch("/admin/movie-visibility", {
          method: "POST",
          headers: {
              ...getHeaders(),
              "Content-Type": "application/json"
          },
          body: JSON.stringify({
              movieId: movieId,
              isHidden: isHidden
          })
      });

      const data = await response.json();

      if (!response.ok || data.status !== "ok") {
          throw new Error(
              data.message || "Không thể cập nhật trạng thái phim."
          );
      }

      await loadMoviesVisibility();
      loadDashboard();

      alert(data.message || "Đã cập nhật trạng thái phim.");

  } catch (error) {
      result.innerHTML =
          '<span style="color:#f87171">' +
          escapeHtml(error.message || "Đã xảy ra lỗi.") +
          '</span>';
  }
}

async function checkMovie() {
    const input =
        document.getElementById("checkMovieFilename");

    const result =
        document.getElementById("checkMovieResult");

    const filename =
        input.value.trim();

    if (!adminSecret) {
        result.innerHTML =
            '<span style="color:#f87171">' +
            'Vui lòng nhập REINDEX_SECRET và xác thực trước.' +
            '</span>';

        return;
    }

    if (!filename) {
        result.innerHTML =
            '<span style="color:#f87171">' +
            'Vui lòng nhập tên file phim.' +
            '</span>';

        return;
    }

    result.innerHTML =
        '<span style="color:#fbbf24">' +
        '⏳ Đang phân tích tên file và kiểm tra TMDB...' +
        '</span>';

    try {
        const response =
            await fetch(
                "/admin/check-movie",
                {
                    method: "POST",

                    headers: {
                        ...getHeaders(),
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        filename: filename
                    })
                }
            );

        const data =
            await response.json();

        if (!response.ok) {
            throw new Error(
                data.message ||
                "Không thể kiểm tra phim."
            );
        }

        // -------------------------------------------------
        // Không tìm thấy TMDB
        // -------------------------------------------------

        if (!data.tmdb) {

            result.innerHTML =
                '<div style="color:#f87171;font-weight:600;">' +
                '❌ Không xác định được phim trên TMDB' +
                '</div>' +

                '<div style="margin-top:8px;">' +
                '<strong>Tên file:</strong><br>' +
                escapeHtml(filename) +
                '</div>' +

                '<div style="margin-top:8px;">' +
                '<strong>Tên nhận diện:</strong> ' +
                escapeHtml(
                    data.parsed?.title ||
                    "Không xác định"
                ) +
                '</div>';

            return;
        }

        const tmdb =
            data.tmdb;

        const matches =
            data.matches || [];

        // -------------------------------------------------
        // ĐÃ CÓ
        // -------------------------------------------------

        if (data.found) {

            let html =
                '<div style="color:#4ade80;font-size:18px;font-weight:700;">' +
                '✅ ĐÃ CÓ TRONG KHO' +
                '</div>';

            html +=
                '<div style="margin-top:12px;">' +
                '<strong>🎬 Phim:</strong> ' +
                escapeHtml(
                    tmdb.title ||
                    data.parsed?.title ||
                    ""
                ) +
                '</div>';

            if (tmdb.originalTitle) {
                html +=
                    '<div>' +
                    '<strong>Tên gốc:</strong> ' +
                    escapeHtml(
                        tmdb.originalTitle
                    ) +
                    '</div>';
            }

            html +=
                '<div>' +
                '<strong>📅 Năm:</strong> ' +
                escapeHtml(
                    String(
                        tmdb.year ||
                        data.parsed?.year ||
                        ""
                    )
                ) +
                '</div>';

            html +=
                '<div>' +
                '<strong>🆔 TMDB:</strong> ' +
                escapeHtml(
                    String(tmdb.tmdbId)
                ) +
                '</div>';

            html +=
                '<div style="margin-top:15px;font-weight:600;">' +
                '📁 File đang có trong kho:' +
                '</div>';

            html +=
                '<div style="margin-top:8px;">';

            for (const item of matches) {

                html +=
                    '<div style="' +
                    'padding:10px;' +
                    'margin-bottom:8px;' +
                    'border-radius:8px;' +
                    'background:rgba(255,255,255,0.05);' +
                    '">' +

                    '<div>' +
                    '<strong>📚 Thư viện:</strong> ' +
                    escapeHtml(
                        item.library_name ||
                        "Không xác định"
                    ) +
                    '</div>' +

                    '<div style="margin-top:4px;">' +
                    '<strong>📄 File:</strong> ' +
                    escapeHtml(
                        item.drive_name ||
                        ""
                    ) +
                    '</div>' +

                    '</div>';
            }

            html += '</div>';

            result.innerHTML = html;

            return;
        }

        // -------------------------------------------------
        // CHƯA CÓ
        // -------------------------------------------------

        result.innerHTML =
            '<div style="color:#fbbf24;font-size:18px;font-weight:700;">' +
            '🆕 CHƯA CÓ TRONG KHO' +
            '</div>' +

            '<div style="margin-top:12px;">' +
            '<strong>🎬 Phim:</strong> ' +
            escapeHtml(
                tmdb.title ||
                data.parsed?.title ||
                ""
            ) +
            '</div>' +

            '<div>' +
            '<strong>📅 Năm:</strong> ' +
            escapeHtml(
                String(
                    tmdb.year ||
                    data.parsed?.year ||
                    ""
                )
            ) +
            '</div>' +

            '<div>' +
            '<strong>🆔 TMDB:</strong> ' +
            escapeHtml(
                String(tmdb.tmdbId)
            ) +
            '</div>' +

            '<div style="margin-top:10px;">' +
            'Phim này chưa được tìm thấy trong các thư viện hiện tại.' +
            '</div>';

    } catch (error) {

        result.innerHTML =
            '<span style="color:#f87171">' +
            '❌ ' +
            escapeHtml(
                error.message
            ) +
            '</span>';
    }
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
        setAdminReady();
    } catch (error) {
        authStatus.innerHTML = '<span style="color:#f87171">✕ ' + escapeHtml(error.message) + '</span>';
    }
}

function renderLibraries(libraries) {
    const container = document.getElementById("libraries");
    const count = document.getElementById("library-count");

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

        loadDashboard();
    } catch (error) {
        statusElement.innerHTML = '<strong>✕ ' + escapeHtml(error.message) + '</strong>';
    }
}
// ---------------------------------------------------------
// Reindex tất cả thư viện
// ---------------------------------------------------------
async function reindexAllLibraries() {
    const statusElement =
        document.getElementById("reindex-all-status");

    if (!statusElement) {
        return;
    }

    // Hiển thị trạng thái
    statusElement.style.display = "block";

    statusElement.innerHTML =
        '<strong>⏳ Đang bắt đầu Reindex tất cả thư viện...</strong>';

    try {
        const response =
            await fetch(
                "/admin/reindex-all",
                {
                    method: "POST",
                    headers: getHeaders()
                }
            );

        const data =
            await response.json();

        if (!response.ok) {
            throw new Error(
                data.message ||
                "Không thể bắt đầu Reindex tất cả"
            );
        }

        statusElement.innerHTML =
            "<strong>✓ Đã đưa Reindex tất cả vào Queue.</strong>" +
            "<br>" +
            "Đang xử lý thư viện đầu tiên...";

        // Bắt đầu theo dõi tiến độ
        if (
            data.totalLibraries &&
            data.totalLibraries > 0
        ) {
            startPollingReindexAll(
                data.totalLibraries,
                data.jobId
            );
        }

        loadDashboard();

    } catch (error) {

        statusElement.innerHTML =
            "<strong>✕ " +
            escapeHtml(
                error.message
            ) +
            "</strong>";
    }
}
async function startPollingReindexAll(totalLibraries, firstJobId) {
    const statusElement =
        document.getElementById("reindex-all-status");

    if (!statusElement) return;

    const librariesResponse =
        await fetch("/admin/libraries", {
            method: "GET",
            headers: getHeaders()
        });

    const librariesData =
        await librariesResponse.json();

    if (!librariesResponse.ok) {
        throw new Error(
            librariesData.message ||
            "Không lấy được danh sách thư viện"
        );
    }

    const libraries =
        librariesData.libraries || [];

    let currentIndex = 0;
    let currentJobId = firstJobId;

    function showError(message) {
        statusElement.innerHTML =
            "<strong style='color:#f87171'>✕ " +
            escapeHtml(message) +
            "</strong>";
    }

    async function pollCurrentJob() {
        try {
            const response =
                await fetch(
                    "/admin/reindex/status/" +
                    currentJobId,
                    {
                        method: "GET",
                        headers: getHeaders()
                    }
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                    "Không lấy được trạng thái Reindex"
                );
            }

            const job = data.job;

            const library =
                libraries.find(
                    item =>
                        Number(item.id) ===
                        Number(job.library_id)
                );

            const libraryName =
                library?.name ||
                ("Thư viện " +
                    (currentIndex + 1));

            if (
                job.status === "queued" ||
                job.status === "running"
            ) {
                statusElement.innerHTML =
                    "<strong>⟳ Đang Reindex...</strong>" +
                    "<br>" +
                    "Thư viện " +
                    (currentIndex + 1) +
                    "/" +
                    totalLibraries +
                    ": " +
                    escapeHtml(libraryName) +
                    "<br>" +
                    "Job ID: " +
                    job.id +
                    "<br>" +
                    "Files tìm thấy: " +
                    (job.files_found ?? 0);

                setTimeout(
                    pollCurrentJob,
                    3000
                );

                return;
            }

            if (
                job.status === "completed" ||
                job.status === "completed_with_errors"
            ) {
                statusElement.innerHTML =
                    "<strong style='color:#4ade80'>✓ " +
                    escapeHtml(libraryName) +
                    " đã hoàn tất</strong>" +
                    "<br>" +
                    "Thư viện " +
                    (currentIndex + 1) +
                    "/" +
                    totalLibraries +
                    "<br>" +
                    "Files tìm thấy: " +
                    (job.files_found ?? 0) +
                    "<br>" +
                    "Thêm mới: " +
                    (job.files_added ?? 0) +
                    "<br>" +
                    "Cập nhật: " +
                    (job.files_updated ?? 0) +
                    "<br>" +
                    "Xóa/ngừng hoạt động: " +
                    (job.files_removed ?? 0);

                currentIndex++;

                if (
                    currentIndex >=
                    totalLibraries
                ) {
                    statusElement.innerHTML +=
                        "<br><br><strong style='color:#4ade80'>" +
                        "✓ Reindex tất cả thư viện đã hoàn tất" +
                        "</strong>";

                    return;
                }

                setTimeout(
                    findNextJob,
                    2000
                );

                return;
            }

            if (job.status === "failed") {
                showError(
                    "Reindex thất bại tại " +
                    libraryName +
                    ". Job ID: " +
                    job.id +
                    (job.error_message
                        ? " - " +
                          job.error_message
                        : "")
                );

                return;
            }

            setTimeout(
                pollCurrentJob,
                3000
            );

        } catch (error) {
            showError(error.message);
        }
    }

    async function findNextJob() {
        try {
            const nextLibrary =
                libraries[currentIndex];

            if (!nextLibrary) {
                showError(
                    "Không tìm thấy thư viện tiếp theo"
                );

                return;
            }

            statusElement.innerHTML =
                "<strong>⏳ Đang chờ Queue tạo Job tiếp theo...</strong>" +
                "<br>" +
                "Thư viện " +
                (currentIndex + 1) +
                "/" +
                totalLibraries +
                ": " +
                escapeHtml(
                    nextLibrary.name ||
                    ("Thư viện " +
                        (currentIndex + 1))
                );

            const response =
                await fetch(
                    "/admin/reindex/latest/" +
                    nextLibrary.id,
                    {
                        method: "GET",
                        headers: getHeaders()
                    }
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.message ||
                    "Không tìm được Job tiếp theo"
                );
            }

            if (!data.job) {
                setTimeout(
                    findNextJob,
                    2000
                );

                return;
            }

            currentJobId =
                data.job.id;

            pollCurrentJob();

        } catch (error) {
            showError(error.message);
        }
    }

    pollCurrentJob();
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

// ---------------------------------------------------------
// Admin - Tổng quan vận hành (chỉ đọc)
// GET /admin/dashboard
// ---------------------------------------------------------
if (
  url.pathname === "/admin/dashboard" &&
  request.method === "GET"
) {
  const authorization =
    request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

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
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }

  try {
    const [libraryCount, movieStats, duplicateCount, recentJobs] =
      await Promise.all([
        env.tm_lt_db
          .prepare("SELECT COUNT(*) AS count FROM libraries")
          .first(),
        env.tm_lt_db
          .prepare(`
            SELECT
              COUNT(*) AS total_movies,
              COALESCE(SUM(CASE
                WHEN is_active = 1 AND is_hidden = 0 THEN 1
                ELSE 0
              END), 0) AS visible_movies,
              COALESCE(SUM(CASE
                WHEN is_active = 1 AND is_hidden = 1 THEN 1
                ELSE 0
              END), 0) AS hidden_movies
            FROM movies
          `)
          .first(),
        env.tm_lt_db
          .prepare(`
            SELECT COUNT(*) AS count
            FROM (
              SELECT tmdb_id
              FROM movies
              WHERE
                is_active = 1
                AND tmdb_type = 'movie'
                AND tmdb_id IS NOT NULL
              GROUP BY tmdb_id
              HAVING COUNT(*) > 1
            )
          `)
          .first(),
        env.tm_lt_db
          .prepare(`
            SELECT
              r.id,
              r.status,
              r.files_found,
              r.files_added,
              r.files_updated,
              r.files_removed,
              r.started_at,
              r.finished_at,
              r.error_message,
              l.name AS library_name
            FROM reindex_jobs r
            LEFT JOIN libraries l
              ON l.id = r.library_id
            ORDER BY r.id DESC
            LIMIT 5
          `)
          .all()
      ]);

    return new Response(
      JSON.stringify({
        status: "ok",
        stats: {
          libraries: Number(libraryCount?.count || 0),
          totalMovies: Number(movieStats?.total_movies || 0),
          visibleMovies: Number(movieStats?.visible_movies || 0),
          hiddenMovies: Number(movieStats?.hidden_movies || 0),
          duplicateMovies: Number(duplicateCount?.count || 0)
        },
        recentJobs: recentJobs?.results || []
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  } catch (error) {
    const migrationNeeded = /no such column: is_hidden/i.test(
      error?.message || ""
    );

    return new Response(
      JSON.stringify({
        status: "error",
        message: migrationNeeded
          ? "Cần áp dụng migration 0003_add_movie_visibility.sql trước."
          : "Không thể tải tổng quan quản trị."
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }
}
// ---------------------------------------------------------
// Admin - Trạng thái Reindex tất cả
// GET /admin/reindex-all/status?libraries=1,2,3
// ---------------------------------------------------------
if (
  url.pathname === "/admin/reindex-all/status" &&
  request.method === "GET"
) {
  // -------------------------------------------------------
  // Kiểm tra secret
  // -------------------------------------------------------
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

  // -------------------------------------------------------
  // Lấy danh sách library ID
  // -------------------------------------------------------
  const librariesParam =
    url.searchParams.get("libraries") || "";

  const libraryIds =
    librariesParam
      .split(",")
      .map(id => Number(id.trim()))
      .filter(
        id =>
          Number.isInteger(id) &&
          id > 0
      );

  if (libraryIds.length === 0) {
    return new Response(
      JSON.stringify({
        status: "error",
        message:
          "Thiếu danh sách library ID"
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

  // -------------------------------------------------------
  // Lấy thông tin thư viện
  // -------------------------------------------------------
  const placeholders =
    libraryIds
      .map(() => "?")
      .join(",");

  const librariesResult =
    await env.tm_lt_db
      .prepare(`
        SELECT
          id,
          name,
          folder_id,
          enabled
        FROM libraries
        WHERE id IN (${placeholders})
        ORDER BY id ASC
      `)
      .bind(...libraryIds)
      .all();

  const libraries =
    librariesResult.results || [];

  // -------------------------------------------------------
  // Lấy Job mới nhất của từng thư viện
  // -------------------------------------------------------
  const items = [];

  for (const library of libraries) {
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
          WHERE library_id = ?
          ORDER BY id DESC
          LIMIT 1
        `)
        .bind(library.id)
        .first();

    items.push({
      libraryId:
        library.id,

      name:
        library.name,

      enabled:
        library.enabled,

      job:
        job || null
    });
  }

  // -------------------------------------------------------
  // Tính tiến độ
  // -------------------------------------------------------
  const total =
    items.length;

  let completed = 0;
  let currentIndex = -1;
  let current = null;
  let failed = 0;

  for (
    let i = 0;
    i < items.length;
    i++
  ) {
    const item =
      items[i];

    const job =
      item.job;

    if (!job) {
      if (currentIndex === -1) {
        currentIndex = i;
        current = item;
      }

      continue;
    }

    if (
      job.status === "completed" ||
      job.status === "completed_with_errors"
    ) {
      completed++;

      if (
        job.status ===
        "completed_with_errors"
      ) {
        failed++;
      }

    } else if (
      job.status === "failed"
    ) {
      failed++;

      if (currentIndex === -1) {
        currentIndex = i;
        current = item;
      }

    } else if (
      job.status === "running" ||
      job.status === "queued"
    ) {
      if (currentIndex === -1) {
        currentIndex = i;
        current = item;
      }
    }
  }

  // -------------------------------------------------------
  // Nếu tất cả đã hoàn tất
  // -------------------------------------------------------
  if (
    completed === total &&
    total > 0
  ) {
    currentIndex = total - 1;
    current =
      items[total - 1];
  }

  // -------------------------------------------------------
  // Trả kết quả
  // -------------------------------------------------------
  return new Response(
    JSON.stringify({
      status: "ok",

      total,

      completed,

      failed,

      currentIndex,

      currentLibrary:
        current
          ? {
              libraryId:
                current.libraryId,

              name:
                current.name,

              job:
                current.job
            }
          : null,

      libraries:
        items
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
// ---------------------------------------------------------
// Admin - Lấy Reindex Job mới nhất của thư viện
// GET /admin/reindex/latest/:libraryId
// ---------------------------------------------------------
if (
  url.pathname.startsWith("/admin/reindex/latest/") &&
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

  const libraryId = Number(
    url.pathname.replace(
      "/admin/reindex/latest/",
      ""
    )
  );

  if (
    !Number.isInteger(libraryId) ||
    libraryId <= 0
  ) {
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
        WHERE library_id = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .bind(libraryId)
      .first();

  return new Response(
    JSON.stringify({
      status: "ok",
      job: job || null
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
// ---------------------------------------------------------
// Admin - Reindex tất cả thư viện
// POST /admin/reindex-all
// ---------------------------------------------------------
if (
  url.pathname === "/admin/reindex-all" &&
  request.method === "POST"
) {
  // -------------------------------------------------------
  // Kiểm tra secret
  // -------------------------------------------------------
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

  // -------------------------------------------------------
  // Lấy toàn bộ thư viện đang được bật
  // -------------------------------------------------------
  const libraries =
    await env.tm_lt_db
      .prepare(`
        SELECT
          id,
          name,
          folder_id
        FROM libraries
        WHERE enabled = 1
        ORDER BY id ASC
      `)
      .all();

  const libraryList =
    libraries.results || [];

  if (libraryList.length === 0) {
    return new Response(
      JSON.stringify({
        status: "error",
        message:
          "Không có thư viện nào đang được bật"
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

  // -------------------------------------------------------
  // Lấy thư viện đầu tiên
  // -------------------------------------------------------
  const firstLibrary =
    libraryList[0];

  // -------------------------------------------------------
  // Tạo Reindex Job cho thư viện đầu tiên
  // -------------------------------------------------------
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
        VALUES (
          ?,
          'queued',
          CURRENT_TIMESTAMP,
          0,
          0,
          0,
          0
        )
        RETURNING id
      `)
      .bind(firstLibrary.id)
      .first();

  const jobId =
    jobResult?.id || null;

  if (!jobId) {
    return new Response(
      JSON.stringify({
        status: "error",
        message:
          "Không tạo được Reindex Job"
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

  // -------------------------------------------------------
  // Đưa thư viện đầu tiên vào Queue
  // -------------------------------------------------------
  await env.tm_lt_reindex.send({
    reindexAll: true,

    libraryIds:
      libraryList.map(
        library => library.id
      ),

    libraryIndex: 0,

    libraryId:
      firstLibrary.id,

    offset: 0,

    batchSize: 5,

    existingJobId: jobId
  });

  // -------------------------------------------------------
  // Trả kết quả
  // -------------------------------------------------------
  return new Response(
    JSON.stringify({
      status: "queued",
      message:
        "Đã bắt đầu Reindex tất cả thư viện",
      totalLibraries:
        libraryList.length,
      currentLibrary: {
        index: 0,
        id: firstLibrary.id,
        name: firstLibrary.name
      },
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
// ---------------------------------------------------------
// Admin - Kiểm tra phim đã có trong kho hay chưa
// POST /admin/check-movie
// ---------------------------------------------------------
if (
  url.pathname === "/admin/check-movie" &&
  request.method === "POST"
) {
  // -------------------------------------------------------
  // Kiểm tra REINDEX_SECRET
  // -------------------------------------------------------
  const authorization =
    request.headers.get("Authorization") || "";

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

  try {
    // -----------------------------------------------------
    // Nhận tên file
    // -----------------------------------------------------
    const body = await request.json();

    let filename =
      typeof body?.filename === "string"
        ? body.filename.trim()
        : "";

    if (!filename) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Vui lòng nhập tên file phim."
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

    // -----------------------------------------------------
    // Chuẩn hóa tên file
    // -----------------------------------------------------
    filename =
      filename
        .replace(/\\\[/g, "[")
        .replace(/\\\]/g, "]")
        .trim();

    console.log(
      "TM-LT Check Movie:",
      filename
    );

    // -----------------------------------------------------
    // Parser
    // -----------------------------------------------------
    const parsed =
      parseFilename(filename);

    console.log(
      "TM-LT Check Movie parsed:",
      JSON.stringify(parsed)
    );

    // -----------------------------------------------------
    // Nếu parser xác định đây là TV series
    // thì không kiểm tra vào kho movie
    // -----------------------------------------------------
    if (
      parsed.tmdbType === "tv" ||
      parsed.season != null ||
      parsed.episode != null
    ) {
      return new Response(
        JSON.stringify({
          status: "ok",
          found: false,
          type: "tv",
          parsed,
          tmdb: null,
          matches: [],
          message:
            "Tên file này được nhận diện là TV series, không phải phim movie."
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    // -----------------------------------------------------
    // Resolve TMDB
    // -----------------------------------------------------
    const tmdb =
      await resolveMedia(
        {
          ...parsed,
          tmdbType: "movie"
        },
        env
      );

    // -----------------------------------------------------
    // Không tìm được TMDB
    // -----------------------------------------------------
    if (
      !tmdb ||
      !tmdb.tmdbId
    ) {
      return new Response(
        JSON.stringify({
          status: "ok",
          found: false,
          parsed,
          tmdb: null,
          matches: [],
          message:
            "Không tìm thấy phim tương ứng trên TMDB."
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    console.log(
      "TM-LT Check Movie TMDB:",
      JSON.stringify(tmdb)
    );

    // -----------------------------------------------------
    // Tìm trong D1
    //
    // Quan trọng:
    // Không tìm theo tên file.
    // Tìm theo TMDB ID để các bản release khác nhau
    // vẫn được nhận diện là cùng một phim.
    // -----------------------------------------------------
    const result =
      await env.tm_lt_db
        .prepare(`
          SELECT
            m.id,
            m.drive_file_id,
            m.drive_name,
            m.title,
            m.year,
            m.tmdb_id,
            m.tmdb_type,
            m.is_active,
            m.library_id,
            l.name AS library_name
          FROM movies m
          LEFT JOIN libraries l
            ON l.id = m.library_id
          WHERE
            m.tmdb_id = ?
            AND m.tmdb_type = 'movie'
            AND m.is_active = 1
          ORDER BY
            l.name ASC,
            m.drive_name ASC
        `)
        .bind(Number(tmdb.tmdbId))
        .all();

    const matches =
      result?.results || [];

    // -----------------------------------------------------
    // Kết quả
    // -----------------------------------------------------
    return new Response(
      JSON.stringify({
        status: "ok",
        found: matches.length > 0,
        type: "movie",

        parsed,

        tmdb: {
          tmdbId: tmdb.tmdbId,
          title:
            tmdb.title ||
            parsed.title ||
            "",
          originalTitle:
            tmdb.originalTitle ||
            null,
          year:
            tmdb.year ||
            parsed.year ||
            null
        },

        matches,

        message:
          matches.length > 0
            ? "Phim đã có trong kho."
            : "Phim chưa có trong kho."
      }),
      {
        status: 200,
        headers: {
          "content-type":
            "application/json; charset=UTF-8"
        }
      }
    );

  } catch (error) {

    console.error(
      "TM-LT Check Movie error:",
      error
    );

    return new Response(
      JSON.stringify({
        status: "error",
        message:
          error?.message ||
          "Lỗi khi kiểm tra phim."
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
}
// ---------------------------------------------------------
// Admin - Kiểm tra phim trùng trong kho
// GET /admin/duplicate-movies
// Không cần sửa schema D1. Dữ liệu lấy từ movies + libraries.
// ---------------------------------------------------------
if (
  url.pathname === "/admin/duplicate-movies" &&
  request.method === "GET"
) {
  const authorization =
    request.headers.get("Authorization") || "";

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

  try {
    // Chỉ lấy movie đang active và có TMDB ID.
    // GROUP BY trong subquery xác định những TMDB ID xuất hiện
    // từ 2 bản trở lên trong các thư viện hiện tại.
    const result =
      await env.tm_lt_db
        .prepare(`
          SELECT
            m.id,
            m.drive_file_id,
            m.drive_name,
            m.drive_size,
            m.title,
            m.year,
            m.tmdb_id,
            m.tmdb_type,
            m.library_id,
            l.name AS library_name,
            l.folder_id
          FROM movies m
          LEFT JOIN libraries l
            ON l.id = m.library_id
          WHERE
            m.is_active = 1
            AND m.tmdb_type = 'movie'
            AND m.tmdb_id IS NOT NULL
            AND m.tmdb_id IN (
              SELECT tmdb_id
              FROM movies
              WHERE
                is_active = 1
                AND tmdb_type = 'movie'
                AND tmdb_id IS NOT NULL
              GROUP BY tmdb_id
              HAVING COUNT(*) > 1
            )
          ORDER BY
            m.title COLLATE NOCASE ASC,
            l.name COLLATE NOCASE ASC,
            m.drive_name COLLATE NOCASE ASC
        `)
        .all();

    const rows = result?.results || [];
    const duplicateMap = new Map();

    for (const row of rows) {
      const tmdbId = Number(row.tmdb_id);

      if (!duplicateMap.has(tmdbId)) {
        duplicateMap.set(tmdbId, {
          tmdbId,
          title: row.title || "Không có tên",
          year: row.year || null,
          copies: [],
          totalBytes: 0
        });
      }

      const movie = duplicateMap.get(tmdbId);
      const driveSize =
        row.drive_size == null
          ? null
          : Number(row.drive_size);

      movie.copies.push({
        movieId: row.id,
        libraryId: row.library_id,
        libraryName:
          row.library_name || "Không xác định",
        folderId: row.folder_id || null,
        driveFileId: row.drive_file_id,
        driveName: row.drive_name || "",
        driveSize
      });

      if (Number.isFinite(driveSize) && driveSize > 0) {
        movie.totalBytes += driveSize;
      }
    }

    const duplicateMovies =
      Array.from(duplicateMap.values())
        .map(movie => ({
          ...movie,
          copyCount: movie.copies.length
        }))
        .sort((a, b) =>
          a.title.localeCompare(
            b.title,
            "vi",
            { sensitivity: "base" }
          )
        );

    const duplicateCopyCount =
      duplicateMovies.reduce(
        (sum, movie) =>
          sum + movie.copyCount,
        0
      );

    const totalDuplicateBytes =
      duplicateMovies.reduce(
        (sum, movie) =>
          sum + movie.totalBytes,
        0
      );

    return new Response(
      JSON.stringify({
        status: "ok",
        duplicateMovieCount:
          duplicateMovies.length,
        duplicateCopyCount,
        totalDuplicateBytes,
        duplicateMovies
      }, null, 2),
      {
        status: 200,
        headers: {
          "content-type":
            "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );

  } catch (error) {
    console.error(
      "TM-LT Duplicate Movies error:",
      error
    );

    return new Response(
      JSON.stringify({
        status: "error",
        message:
          error?.message ||
          "Lỗi khi quét phim trùng."
      }),
      {
        status: 500,
        headers: {
          "content-type":
            "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }
}

 // ---------------------------------------------------------
 // Admin - Ẩn / hiện phim trong thư viện
 // POST /admin/movie-visibility
 // Body: { "movieId": 123, "isHidden": true }
 // ---------------------------------------------------------
 if (
  url.pathname === "/admin/movie-visibility" &&
  request.method === "POST"
) {
  const authorization =
    request.headers.get("Authorization") || "";

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
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }

  try {
    const body = await request.json();
    const movieId = Number(body.movieId);
    const isHidden = body.isHidden;

    if (
      !Number.isSafeInteger(movieId) ||
      movieId < 1 ||
      typeof isHidden !== "boolean"
    ) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "movieId hoặc isHidden không hợp lệ."
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            ...CORS_HEADERS
          }
        }
      );
    }

    const result = await env.tm_lt_db
      .prepare(`
        UPDATE movies
        SET
          is_hidden = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(isHidden ? 1 : 0, movieId)
      .run();

    if (!result.meta?.changes) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Không tìm thấy phim có ID này."
        }),
        {
          status: 404,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            ...CORS_HEADERS
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        movieId,
        isHidden,
        message: isHidden
          ? "Đã ẩn phim khỏi danh mục."
          : "Đã hiện phim trong danh mục."
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  } catch (error) {
    console.error("TM-LT Movie Visibility error:", error);

    return new Response(
      JSON.stringify({
        status: "error",
        message: "Không thể cập nhật trạng thái hiển thị phim."
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }
}

 // ---------------------------------------------------------
 // Admin - Danh sách phim để quản lý ẩn / hiện
 // GET /admin/movies-visibility?q=ten-phim&status=all
 // ---------------------------------------------------------
 if (
  url.pathname === "/admin/movies-visibility" &&
  request.method === "GET"
) {
  const authorization =
    request.headers.get("Authorization") || "";

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
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }

  try {
    const q = (
      url.searchParams.get("q") || ""
    ).trim();

    const status = (
      url.searchParams.get("status") || "all"
    ).toLowerCase();

    const limit = Math.max(
      1,
      Number(url.searchParams.get("limit") || 10000)
    );

    if (!["all", "visible", "hidden"].includes(status)) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Trạng thái lọc không hợp lệ."
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            ...CORS_HEADERS
          }
        }
      );
    }

    const conditions = [
      "m.is_active = 1",
      "m.tmdb_id IS NOT NULL"
    ];

    const params = [];

    if (q) {
      conditions.push(
        "(m.title LIKE ? OR m.drive_name LIKE ?)"
      );
      const keyword = `%${q}%`;
      params.push(keyword, keyword);
    }

    if (status === "visible") {
      conditions.push("m.is_hidden = 0");
    } else if (status === "hidden") {
      conditions.push("m.is_hidden = 1");
    }


    const result = await env.tm_lt_db
      .prepare(`
        SELECT
          m.id,
          m.title,
          m.year,
          m.tmdb_id,
          m.tmdb_type,
          m.drive_name,
          m.is_hidden,
          m.library_id,
          l.name AS library_name
        FROM movies m
        LEFT JOIN libraries l
          ON l.id = m.library_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY
          m.title COLLATE NOCASE ASC,
          m.year DESC
      `)
      .bind(...params)
      .all();

    return new Response(
      JSON.stringify({
        status: "ok",
        count: (result.results || []).length,
        movies: (result.results || []).map(movie => ({
          ...movie,
          is_hidden: Number(movie.is_hidden) === 1
        }))
      }, null, 2),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  } catch (error) {
    console.error(
      "TM-LT Movies Visibility List error:",
      error
    );

    return new Response(
      JSON.stringify({
        status: "error",
        message: "Không thể tải danh sách phim."
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          ...CORS_HEADERS
        }
      }
    );
  }
}

// ---------------------------------------------------------
// POST /admin/reindex/:id
// ---------------------------------------------------------
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
        const folderId =
  url.searchParams.get("folderId");

const files =
  await scanDriveLibrary(
    env,
    folderId || undefined
  );

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
    const filename = url.searchParams.get("filename");

const results = filename
  ? testParser([filename])
  : testParser();

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
// GET /test/tmdb/movie?id=672
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/movie") {
  try {
    const idParam =
      url.searchParams.get("id");

    const tmdbId =
      Number(idParam);

    if (
      !Number.isInteger(tmdbId) ||
      tmdbId <= 0
    ) {
      return new Response(
        JSON.stringify({
          status: "error",
          message:
            "Vui lòng truyền TMDB movie ID hợp lệ. Ví dụ: ?id=672"
        }, null, 2),
        {
          status: 400,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    const data = await getMovieById(
      tmdbId,
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
  const type =
  url.searchParams.get("type") || "movie";
const yearParam =
  url.searchParams.get("year");

const year =
  yearParam
    ? Number(yearParam)
    : 2022;

    let data;
    let best;

    if (type === "tv") {
      data = await searchTv(
        query,
        env,
        year
      );

      best = pickBestTvResult(
        data,
        year,
        query
      );
    } else {
      data = await searchMovie(
        query,
        env,
        year
      );

      best = pickBestTvResult(
        data,
        year,
        query
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        type,
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
// Test TMDB TV Episode
// GET /test/tmdb/episode?tvId=276501&season=1&episode=1
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/episode") {
  try {
    const tvId = Number(
      url.searchParams.get("tvId")
    );

    const season = Number(
      url.searchParams.get("season")
    );

    const episode = Number(
      url.searchParams.get("episode")
    );

    if (
      !Number.isInteger(tvId) ||
      tvId <= 0 ||
      !Number.isInteger(season) ||
      season < 0 ||
      !Number.isInteger(episode) ||
      episode <= 0
    ) {
      return new Response(
        JSON.stringify({
          status: "error",
          message:
            "Tham số không hợp lệ. Ví dụ: ?tvId=276501&season=1&episode=1"
        }, null, 2),
        {
          status: 400,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    const data = await getTvEpisodeById(
      tvId,
      season,
      episode,
      env
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        type: "tv_episode",
        tvId,
        season,
        episode,
        id: data.id,
        name: data.name,
        overview: data.overview,
        airDate: data.air_date,
        episodeNumber: data.episode_number,
        seasonNumber: data.season_number,
        stillPath: data.still_path,
        stillUrl: data.still_path
          ? `https://image.tmdb.org/t/p/w780${data.still_path}`
          : null,
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
        tmdb: "episode_failed",
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
// Test TMDB TV Episode
// GET /test/tmdb/episode?tvId=276501&season=1&episode=1
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/episode") {
  try {
    const tvId = Number(
      url.searchParams.get("tvId")
    );

    const season = Number(
      url.searchParams.get("season")
    );

    const episode = Number(
      url.searchParams.get("episode")
    );

    if (
      !Number.isInteger(tvId) ||
      tvId <= 0 ||
      !Number.isInteger(season) ||
      season < 0 ||
      !Number.isInteger(episode) ||
      episode <= 0
    ) {
      return new Response(
        JSON.stringify({
          status: "error",
          message:
            "Tham số không hợp lệ. Ví dụ: ?tvId=276501&season=1&episode=1"
        }, null, 2),
        {
          status: 400,
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    const data = await getTvEpisodeById(
      tvId,
      season,
      episode,
      env
    );

    return new Response(
      JSON.stringify({
        status: "ok",
        type: "tv_episode",
        tvId,
        season,
        episode,
        id: data.id,
        name: data.name,
        overview: data.overview,
        airDate: data.air_date,
        episodeNumber: data.episode_number,
        seasonNumber: data.season_number,
        stillPath: data.still_path,
        stillUrl: data.still_path
          ? `https://image.tmdb.org/t/p/w780${data.still_path}`
          : null,
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
        tmdb: "episode_failed",
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
// Test TMDB Resolve
// ---------------------------------------------------------
if (url.pathname === "/test/tmdb/resolve") {
  try {
    const testType = url.searchParams.get("type");
    const testId = url.searchParams.get("id");
    const testTitle = url.searchParams.get("title");
    const testYear = url.searchParams.get("year");

    // -----------------------------------------------------
    // 1. Test TV theo TMDB ID
    // Ví dụ:
    // /test/tmdb/resolve?type=tv&id=276501
    // -----------------------------------------------------
    if (testType === "tv" && testId) {
      const tv = await resolveTv(
        {
          tmdbId: Number(testId),
          tmdbType: "tv",
          title: ""
        },
        env
      );

      return new Response(
        JSON.stringify({
          status: "ok",
          type: "tv",
          mode: "id",
          tv: {
            ...tv,
            posterUrl: getPosterUrl(tv?.posterPath),
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
    }

    // -----------------------------------------------------
    // 2. Test Movie theo TMDB ID
    // Ví dụ:
    // /test/tmdb/resolve?type=movie&id=315162
    // -----------------------------------------------------
    if (testType === "movie" && testId) {
      const movie = await resolveMovie(
        {
          tmdbId: Number(testId),
          tmdbType: "movie",
          title: ""
        },
        env
      );

      return new Response(
        JSON.stringify({
          status: "ok",
          type: "movie",
          mode: "id",
          movie: {
            ...movie,
            posterUrl: getPosterUrl(movie?.posterPath),
            backdropUrl: getPosterUrl(
              movie?.backdropPath,
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
    }

    // -----------------------------------------------------
    // 3. Test TV theo TITLE + YEAR
    // Ví dụ:
    // /test/tmdb/resolve?type=tv&title=The%20Secret%20Lives%20of%20Animals&year=2024
    // -----------------------------------------------------
    if (
      testType === "tv" &&
      testTitle
    ) {
      const tv = await resolveTv(
        {
          tmdbId: null,
          tmdbType: "tv",
          title: testTitle,
          year: testYear
            ? Number(testYear)
            : null
        },
        env
      );

      return new Response(
        JSON.stringify({
          status: "ok",
          type: "tv",
          mode: "search",
          query: {
            title: testTitle,
            year: testYear
              ? Number(testYear)
              : null
          },
          tv: tv
            ? {
                ...tv,
                posterUrl: getPosterUrl(
                  tv.posterPath
                ),
                backdropUrl: getPosterUrl(
                  tv.backdropPath,
                  "w1280"
                )
              }
            : null
        }, null, 2),
        {
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    // -----------------------------------------------------
    // 4. Test Movie theo TITLE + YEAR
    // -----------------------------------------------------
    if (
      testType === "movie" &&
      testTitle
    ) {
      const movie = await resolveMovie(
        {
          tmdbId: null,
          tmdbType: "movie",
          title: testTitle,
          year: testYear
            ? Number(testYear)
            : null
        },
        env
      );

      return new Response(
        JSON.stringify({
          status: "ok",
          type: "movie",
          mode: "search",
          query: {
            title: testTitle,
            year: testYear
              ? Number(testYear)
              : null
          },
          movie: movie
            ? {
                ...movie,
                posterUrl: getPosterUrl(
                  movie.posterPath
                ),
                backdropUrl: getPosterUrl(
                  movie.backdropPath,
                  "w1280"
                )
              }
            : null
        }, null, 2),
        {
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    // -----------------------------------------------------
    // 5. Không truyền tham số → giữ test mẫu
    // -----------------------------------------------------
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
        const folderId =
          url.searchParams.get("folderId");

        // 1. Scan Google Drive
        const driveResult =
          await scanDriveLibrary(
            env,
            folderId || undefined
          );

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
        const testFiles = videoFiles;

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
                tmdb?.tmdbId ??
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
    AND is_hidden = 0
    AND tmdb_id IS NOT NULL
    AND tmdb_type = 'movie'
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
// Stremio Series Catalogs
// ---------------------------------------------------------
const seriesCatalogMatch =
  url.pathname.match(
    /^\/catalog\/series\/([^/]+)\.json$/
  );

if (seriesCatalogMatch) {
  const catalogId =
    seriesCatalogMatch[1];

  const catalogOrders = {
    "kho-series":
      "title COLLATE NOCASE ASC",

    "series-a-z":
      "title COLLATE NOCASE ASC",

    "series-moi-nhat":
      "year DESC, title COLLATE NOCASE ASC",

    "series-diem-cao":
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
             WHERE is_active = 1
              AND is_hidden = 0
               AND tmdb_id IS NOT NULL
               AND tmdb_type = 'tv'
               AND id IN (
                 SELECT MIN(id)
                 FROM movies
                 WHERE is_active = 1
                 AND is_hidden = 0
                   AND tmdb_id IS NOT NULL
                   AND tmdb_type = 'tv'
                 GROUP BY tmdb_id
               )
             ORDER BY ${orderBy}`
          )
          .all();

      const metas =
        (result.results || [])
          .map(
            (series) => ({
              id:
                `series:${series.tmdb_id}`,

              type:
                "series",

              name:
                series.title ||
                "Không có tên",

              releaseInfo:
                series.year
                  ? String(series.year)
                  : undefined,

              poster:
                series.poster_url ||
                undefined,

              background:
                series.backdrop_url ||
                undefined,

              description:
                series.overview ||
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
// Stremio Meta - Chi tiết Series
// ---------------------------------------------------------
if (url.pathname.startsWith("/meta/series/")) {
  try {
    const metaId =
      decodeURIComponent(
        url.pathname
          .replace("/meta/series/", "")
          .replace(".json", "")
      );

    const tmdbId =
      metaId.startsWith("series:")
        ? metaId.replace("series:", "")
        : metaId;

    const series =
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
             AND tmdb_type = 'tv'
             AND is_active = 1
           LIMIT 1`
        )
        .bind(Number(tmdbId))
        .first();

    if (!series) {
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
        series.genres
          ? JSON.parse(series.genres)
          : [];
    } catch {
      genres = [];
    }

    const episodeResult =
      await env.tm_lt_db
        .prepare(
          `SELECT
             tmdb_id,
             title,
             year,
             season,
             episode,
             drive_name
           FROM movies
           WHERE tmdb_id = ?
             AND tmdb_type = 'tv'
             AND is_active = 1
             AND season IS NOT NULL
             AND episode IS NOT NULL
           ORDER BY season ASC, episode ASC`
        )
        .bind(Number(tmdbId))
        .all();

    const videos =
      (episodeResult.results || [])
        .map(
          (item) => ({
            id:
              `${item.tmdb_id}:${item.season}:${item.episode}`,

            title:
              item.drive_name ||
              item.title ||
              `Tập ${item.episode}`,

            season:
              Number(item.season),

            episode:
              Number(item.episode)
          })
        );

    return new Response(
      JSON.stringify(
        {
          meta: {
            id:
              `series:${series.tmdb_id}`,

            type:
              "series",

            name:
              series.title ||
              "Không có tên",

            releaseInfo:
              series.year
                ? String(series.year)
                : undefined,

            poster:
              series.poster_url ||
              undefined,

            background:
              series.backdrop_url ||
              undefined,

            description:
              series.overview ||
              undefined,

            genres,

            videos
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
// Stremio Stream - Series Episode
// ---------------------------------------------------------
if (url.pathname.startsWith("/stream/series/")) {
  try {
    const streamId =
      decodeURIComponent(
        url.pathname
          .replace("/stream/series/", "")
          .replace(".json", "")
      );

    const parts =
      streamId.split(":");

    if (parts.length !== 3) {
      return new Response(
        JSON.stringify({
          streams: []
        }),
        {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    const tmdbId =
      Number(parts[0]);

    const season =
      Number(parts[1]);

    const episode =
      Number(parts[2]);

    if (
      !Number.isInteger(tmdbId) ||
      !Number.isInteger(season) ||
      !Number.isInteger(episode)
    ) {
      return new Response(
        JSON.stringify({
          streams: []
        }),
        {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    const result =
      await env.tm_lt_db
        .prepare(
          `SELECT
             m.id,
             m.tmdb_id,
             m.title,
             m.drive_name,
             m.season,
             m.episode,
             s.drive_file_id
           FROM movies m
           INNER JOIN streams s
             ON s.movie_id = m.id
           WHERE m.tmdb_id = ?
             AND m.season = ?
             AND m.episode = ?
             AND m.tmdb_type = 'tv'
             AND m.is_active = 1
             AND s.stream_type = 'google_drive'
           ORDER BY m.id ASC`
        )
        .bind(
          tmdbId,
          season,
          episode
        )
        .all();

    const episodes =
      result.results || [];

    if (episodes.length === 0) {
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
      episodes.map(
        (movie) => {

          const fileName =
            movie.drive_name ||
            "";

          // ---------------------------------------------------------
          // Nhận diện phiên bản + chất lượng
          // ---------------------------------------------------------

          let languageLabel =
            "🎧 Âm thanh gốc";

          if (
            /thuyet[\s._-]*minh/i.test(fileName) ||
            /thuyết[\s._-]*minh/i.test(fileName)
          ) {
            languageLabel =
              "🇻🇳 Thuyết minh";

          } else if (
            /viet[\s._-]*sub/i.test(fileName) ||
            /vietsub/i.test(fileName) ||
            /phu[\s._-]*de/i.test(fileName) ||
            /phụ[\s._-]*đề/i.test(fileName)
          ) {
            languageLabel =
              "🇻🇳 Phụ đề Việt";

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
        }
      );

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
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Access-Control-Expose-Headers":
          "Accept-Ranges, Content-Length, Content-Range"
      }
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        ...CORS_HEADERS,
        Allow: "GET, HEAD, OPTIONS"
      }
    });
  }

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

    const responseHeaders = new Headers(CORS_HEADERS);

    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
      "cache-control"
    ]) {
      const value = driveResponse.headers.get(name);

      if (value) {
        responseHeaders.set(name, value);
      }
    }

    responseHeaders.set(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range"
    );

    if (request.method === "HEAD" && driveResponse.body) {
      await driveResponse.body.cancel("HEAD request");
    }

    return new Response(
      request.method === "HEAD" ? null : driveResponse.body,
      {
        status: driveResponse.status,
        headers: responseHeaders
      }
    );

  } catch (error) {
    const errorStatus =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 500;
    const errorHeaders = new Headers(CORS_HEADERS);

    errorHeaders.set(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, Retry-After"
    );
    errorHeaders.set("content-type", "application/json; charset=UTF-8");

    for (const name of ["content-range", "retry-after"]) {
      const value = error?.headers?.get(name);

      if (value) {
        errorHeaders.set(name, value);
      }
    }

    return new Response(
      JSON.stringify(
        {
          status: "error",
          file:
            error?.code ||
            "download_failed",
          message:
            error?.message ||
            String(error)
        },
        null,
        2
      ),
      {
        status: errorStatus,
        headers: errorHeaders
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
            // ---------------------------------------------------------
            // MOVIE
            // ---------------------------------------------------------
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
            },

            // ---------------------------------------------------------
            // SERIES
            // ---------------------------------------------------------
            {
              type: "series",
              id: "kho-series",
              name: "📺 Tất cả series"
            },
            {
              type: "series",
              id: "series-a-z",
              name: "🔤 Series A → Z"
            },
            {
              type: "series",
              id: "series-moi-nhat",
              name: "📅 Series mới nhất"
            },
            {
              type: "series",
              id: "series-diem-cao",
              name: "⭐ Series điểm cao"
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

  // ---------------------------------------------------------
  // Cloudflare Cron
  // Chạy tự động lúc 06:00 sáng giờ Việt Nam
  // ---------------------------------------------------------
  async scheduled(controller, env, ctx) {
    console.log(
      "TM-LT Cron: bắt đầu Reindex tất cả thư viện."
    );

    try {
      // Lấy danh sách tất cả thư viện
      const libraryResult =
        await env.tm_lt_db
          .prepare(`
            SELECT id
            FROM libraries
            ORDER BY id ASC
          `)
          .all();

      const libraryList =
        libraryResult?.results || [];

      if (libraryList.length === 0) {
        console.log(
          "TM-LT Cron: không có thư viện để Reindex."
        );
        return;
      }

      const libraryIds =
        libraryList.map(
          library => library.id
        );

      const firstLibrary =
        libraryList[0];

      // Tạo Job đầu tiên
      const firstJobResult =
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
            VALUES (
              ?,
              'queued',
              CURRENT_TIMESTAMP,
              0,
              0,
              0,
              0
            )
            RETURNING id
          `)
          .bind(firstLibrary.id)
          .first();

      const firstJobId =
        firstJobResult?.id || null;

      if (!firstJobId) {
        throw new Error(
          "Không tạo được Reindex Job đầu tiên."
        );
      }

      // Đưa thư viện đầu tiên vào Queue
      await env.tm_lt_reindex.send({
        reindexAll: true,

        libraryIds,

        libraryIndex: 0,

        libraryId:
          firstLibrary.id,

        offset: 0,

        batchSize: 5,

        existingJobId:
          firstJobId,

        origin: "cron"
      });

      console.log(
        `TM-LT Cron: đã đưa ${libraryIds.length} thư viện vào chuỗi Reindex.`
      );

    } catch (error) {
      console.error(
        "TM-LT Cron error:",
        error
      );
    }
  },

  // ---------------------------------------------------------
  // Cloudflare Queue
  // ---------------------------------------------------------
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

      // -----------------------------------------------------
      // Chạy batch hiện tại
      // -----------------------------------------------------

      const result =
        await runReindexWorker(env, {
          libraryId: job.libraryId,
          offset: job.offset || 0,
          batchSize: job.batchSize || 5,
          existingJobId:
            job.existingJobId || null,
          origin: "queue"
        });

      const resultText =
        await result.clone().text();

      console.log(
        "TM-LT Queue result:",
        resultText
      );

      const data =
        JSON.parse(resultText);

      // -----------------------------------------------------
      // 1. Vẫn còn batch của thư viện hiện tại
      // -----------------------------------------------------

      if (
        data.status === "ok" &&
        data.nextOffset !== null &&
        data.nextOffset !== undefined &&
        data.nextOffset < data.filesFound
      ) {
        const nextJob = {
          ...job,

          libraryId:
            job.libraryId,

          offset:
            data.nextOffset,

          batchSize:
            job.batchSize || 5,

          existingJobId:
            data.jobId
        };

        console.log(
          "TM-LT Queue: gửi batch tiếp theo:",
          JSON.stringify(nextJob)
        );

        await env.tm_lt_reindex.send(
          nextJob
        );

      } else {

        // ---------------------------------------------------
        // 2. Thư viện hiện tại đã hoàn tất
        // ---------------------------------------------------

        console.log(
          `TM-LT Queue: thư viện ${job.libraryId} đã hoàn tất.`
        );

        // ---------------------------------------------------
        // Nếu đây là Reindex tất cả
        // ---------------------------------------------------

        if (
          job.reindexAll === true &&
          Array.isArray(job.libraryIds)
        ) {
          const currentIndex =
            Number(job.libraryIndex || 0);

          const nextIndex =
            currentIndex + 1;

          // -------------------------------------------------
          // Còn thư viện tiếp theo
          // -------------------------------------------------

          if (
            nextIndex <
            job.libraryIds.length
          ) {
            const nextLibraryId =
              job.libraryIds[nextIndex];

            console.log(
              `TM-LT Queue: chuyển sang thư viện ${nextIndex + 1}/${job.libraryIds.length}: ${nextLibraryId}`
            );

            // -----------------------------------------------
            // Tạo Job mới cho thư viện tiếp theo
            // -----------------------------------------------

            const nextJobResult =
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
                  VALUES (
                    ?,
                    'queued',
                    CURRENT_TIMESTAMP,
                    0,
                    0,
                    0,
                    0
                  )
                  RETURNING id
                `)
                .bind(nextLibraryId)
                .first();

            const nextJobId =
              nextJobResult?.id || null;

            if (!nextJobId) {
              throw new Error(
                `Không tạo được Reindex Job cho library ${nextLibraryId}`
              );
            }

            // -----------------------------------------------
            // Đưa thư viện tiếp theo vào Queue
            // -----------------------------------------------

            const nextJob = {
              reindexAll: true,

              libraryIds:
                job.libraryIds,

              libraryIndex:
                nextIndex,

              libraryId:
                nextLibraryId,

              offset: 0,

              batchSize:
                job.batchSize || 5,

              existingJobId:
                nextJobId
            };

            console.log(
              "TM-LT Queue: gửi thư viện tiếp theo:",
              JSON.stringify(nextJob)
            );

            await env.tm_lt_reindex.send(
              nextJob
            );

          } else {

            // -----------------------------------------------
            // Đã hoàn tất toàn bộ thư viện
            // -----------------------------------------------

            console.log(
              "TM-LT Queue: Reindex tất cả thư viện đã hoàn tất."
            );
          }
        } else {

          // -------------------------------------------------
          // Reindex một thư viện bình thường
          // -------------------------------------------------

          console.log(
            "TM-LT Queue: Reindex thư viện đã hoàn tất."
          );
        }
      }

      // -----------------------------------------------------
      // Xác nhận message đã xử lý
      // -----------------------------------------------------

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


