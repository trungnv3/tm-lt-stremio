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
    // 1. Láº¥y thÆ° viá»‡n Ä‘Æ°á»£c yÃªu cáº§u
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
              "KhÃ´ng tÃ¬m tháº¥y thÆ° viá»‡n Google Drive Ä‘ang Ä‘Æ°á»£c báº­t"
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
    // 2. Táº¡o job má»›i hoáº·c tiáº¿p tá»¥c job hiá»‡n táº¡i
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
                "KhÃ´ng tÃ¬m tháº¥y Reindex job hoáº·c job khÃ´ng thuá»™c thÆ° viá»‡n nÃ y"
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
    // 3. Scan toÃ n bá»™ Google Drive
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
    // 4. Ghi tá»•ng sá»‘ file tÃ¬m tháº¥y
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
    // 5. Danh sÃ¡ch Drive ID hiá»‡n táº¡i
    // -----------------------------------------------------
    const currentDriveIds =
      new Set(
        videoFiles.map(
          (file) => file.id
        )
      );

    // -----------------------------------------------------
    // 6. Bá»™ Ä‘áº¿m
    // -----------------------------------------------------
    let filesAdded = 0;
    let filesUpdated = 0;
    let filesSkipped = 0;
    let filesFailed = 0;

    let errors = [];

    // -----------------------------------------------------
    // Náº¿u tiáº¿p tá»¥c job cÅ© thÃ¬ láº¥y sá»‘ liá»‡u Ä‘Ã£ tÃ­ch lÅ©y
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
    // 7. Retry TMDB khi gáº·p lá»—i táº¡m thá»i
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
    // 8. Láº¥y batch hiá»‡n táº¡i
    // -----------------------------------------------------
    const batchFiles =
      videoFiles.slice(
        offset,
        offset + batchSize
      );

    for (const file of batchFiles) {
      try {
        // -------------------------------------------------
        // Kiá»ƒm tra file Ä‘Ã£ tá»“n táº¡i trong D1 chÆ°a
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
// File khÃ´ng thay Ä‘á»•i -> bá» qua
// Trá»« khi cáº§n refresh metadata
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
        // File má»›i hoáº·c Ä‘Ã£ thay Ä‘á»•i
        // -------------------------------------------------
        const parsed =
          parseFilename(file.name);

        const tmdb =
          await resolveMediaWithRetry(
            parsed
          );

        // -------------------------------------------------
        // KhÃ´ng tÃ¬m tháº¥y TMDB
        // -------------------------------------------------
        if (!tmdb) {
          filesFailed++;

          errors.push({
            driveFileId: file.id,
            fileName: file.name,
            error:
              "KhÃ´ng tÃ¬m tháº¥y thÃ´ng tin TMDB"
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
        // Äáº¿m thÃªm / cáº­p nháº­t
        // -------------------------------------------------
        if (existing) {
          filesUpdated++;
        } else {
          filesAdded++;
        }

        // -------------------------------------------------
        // Táº¡o stream náº¿u chÆ°a cÃ³
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
    // 9. ÄÃ¡nh dáº¥u movie khÃ´ng cÃ²n trÃªn Drive lÃ  inactive
    // Chá»‰ thá»±c hiá»‡n á»Ÿ batch cuá»‘i
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
    // 10. Cáº­p nháº­t reindex job
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
    // 11. Káº¿t quáº£
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
    // Lá»—i toÃ n bá»™ Reindex
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
        // KhÃ´ng che máº¥t lá»—i gá»‘c
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
    Quáº£n lÃ½ cÃ¡c thÆ° viá»‡n Google Drive vÃ  cáº­p nháº­t catalog.
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
        placeholder="Nháº­p REINDEX_SECRET"
        autocomplete="off"
      >

      <button onclick="loadLibraries()">
        Táº£i danh sÃ¡ch thÆ° viá»‡n
      </button>

    </div>

    <div id="authStatus" class="status auth-status">
      ChÆ°a xÃ¡c thá»±c
    </div>

  </div>


  <!-- LIBRARIES -->
  <div class="card">

    <div class="section-title library-section-title">
    <div>
        <h2>ThÆ° viá»‡n Google Drive</h2>
        <span id="library-count" class="library-count"></span>
    </div>

    <button
        class="btn btn-primary"
        onclick="reindexAllLibraries()"
    >
        ðŸ”„ Reindex táº¥t cáº£
    </button>
</div>

<div
    id="reindex-all-status"
    class="reindex-all-status"
    style="display:none;"
></div>

    <div id="libraries">
      ChÆ°a táº£i danh sÃ¡ch.
    </div>


    <div style="margin-top:10px;">

      <button
        class="secondary"
        onclick="toggleAddForm()"
      >
        + ThÃªm thÆ° viá»‡n
      </button>

    </div>


    <!-- ADD LIBRARY FORM -->

    <div id="addForm" class="add-form">

      <label>TÃªn thÆ° viá»‡n</label>

      <input
        id="libraryName"
        placeholder="VÃ­ dá»¥: Phim Hoáº¡t HÃ¬nh"
      >

      <label>
        Google Drive Folder ID hoáº·c URL
      </label>

      <input
        id="folderInput"
        placeholder="Folder ID hoáº·c URL thÆ° má»¥c Drive"
      >

      <div class="add-actions">

        <button onclick="addLibrary()">
          LÆ°u danh sÃ¡ch
        </button>

        <button
          class="secondary"
          onclick="toggleAddForm(false)"
        >
          Há»§y
        </button>

      </div>

    </div>

  </div>


  <div class="footer-note">

    Secret chá»‰ Ä‘Æ°á»£c gá»­i qua HTTPS trong header
    Authorization vÃ  khÃ´ng lÆ°u trÃªn trÃ¬nh duyá»‡t.
    CÃ³ thá»ƒ dÃ¡n folder ID hoáº·c URL thÆ° má»¥c Drive.

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
        authStatus.innerHTML = '<span style="color:#f87171">Vui lÃ²ng nháº­p REINDEX_SECRET</span>';
        return;
    }

    authStatus.innerHTML = 'â³ Äang xÃ¡c thá»±c...';

    try {
        const response = await fetch("/admin/libraries", { method: "GET", headers: getHeaders() });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "KhÃ´ng thá»ƒ táº£i thÆ° viá»‡n");
        }

        authStatus.innerHTML = '<span style="color:#4ade80">âœ“ ÄÃ£ xÃ¡c thá»±c thÃ nh cÃ´ng</span>';
        renderLibraries(data.libraries || []);
    } catch (error) {
        authStatus.innerHTML = '<span style="color:#f87171">âœ• ' + escapeHtml(error.message) + '</span>';
    }
}

function renderLibraries(libraries) {
    const container = document.getElementById("libraries");
    const count = document.getElementById("libraryCount");

    count.textContent = libraries.length + " thÆ° viá»‡n";

    if (!libraries.length) {
        container.innerHTML = '<div class="empty-state">ChÆ°a cÃ³ thÆ° viá»‡n.</div>';
        return;
    }

    // Sá»­ dá»¥ng ká»¹ thuáº­t dataset Ä‘á»ƒ KHÃ”NG cáº§n escape dáº¥u nhÃ¡y trong JavaScript
    container.innerHTML = libraries.map(function(library) {
        const id = escapeHtml(library.id);
        const name = escapeHtml(library.name);
        const folder = escapeHtml(library.folder_id);

        return '<div class="library-card">' +
                 '<div class="library-header">ðŸŽ¬ ' + name + '</div>' +
                 '<div class="library-folder">Folder: ' + folder + '</div>' +
                 '<div class="library-actions">' +
                   '<button onclick="reindexLibrary(this.dataset.id)" data-id="' + id + '">Reindex</button>' +
                   '<button class="danger" onclick="deleteLibrary(this.dataset.id)" data-id="' + id + '">XÃ³a</button>' +
                 '</div>' +
                 '<div class="library-status" id="status-' + id + '">ChÆ°a Reindex trong phiÃªn nÃ y.</div>' +
               '</div>';
    }).join("");
}

async function addLibrary() {
    const name = document.getElementById("libraryName").value.trim();
    const folder = document.getElementById("folderInput").value.trim();

    if (!name || !folder) {
        alert("Vui lÃ²ng nháº­p tÃªn thÆ° viá»‡n vÃ  Folder ID/URL.");
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
            throw new Error(data.message || "KhÃ´ng thá»ƒ thÃªm thÆ° viá»‡n");
        }

        alert("ÄÃ£ thÃªm thÆ° viá»‡n.");
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
    statusElement.innerHTML = '<strong>â³ Äang Ä‘Æ°a Reindex vÃ o Queue...</strong>';

    try {
        const response = await fetch("/admin/reindex/" + libraryId, { method: "POST", headers: getHeaders() });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "KhÃ´ng thá»ƒ Reindex");
        }

        statusElement.innerHTML = '<strong>âœ“ ÄÃ£ Ä‘Æ°a vÃ o Queue...</strong>';
        if (data.jobId) {
            startPolling(libraryId, data.jobId);
        }
    } catch (error) {
        statusElement.innerHTML = '<strong>âœ• ' + escapeHtml(error.message) + '</strong>';
    }
}
// ---------------------------------------------------------
// Reindex táº¥t cáº£ thÆ° viá»‡n
// ---------------------------------------------------------
async function reindexAllLibraries() {
    const statusElement =
        document.getElementById("reindex-all-status");

    if (!statusElement) {
        return;
    }

    // Hiá»ƒn thá»‹ tráº¡ng thÃ¡i
    statusElement.style.display = "block";

    statusElement.innerHTML =
        '<strong>â³ Äang báº¯t Ä‘áº§u Reindex táº¥t cáº£ thÆ° viá»‡n...</strong>';

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
                "KhÃ´ng thá»ƒ báº¯t Ä‘áº§u Reindex táº¥t cáº£"
            );
        }

        statusElement.innerHTML =
            "<strong>âœ“ ÄÃ£ Ä‘Æ°a Reindex táº¥t cáº£ vÃ o Queue.</strong>" +
            "<br>" +
            "Äang xá»­ lÃ½ thÆ° viá»‡n Ä‘áº§u tiÃªn...";

        // Báº¯t Ä‘áº§u theo dÃµi tiáº¿n Ä‘á»™
        if (
            data.totalLibraries &&
            data.totalLibraries > 0
        ) {
            startPollingReindexAll(
                data.totalLibraries,
                data.jobId
            );
        }

    } catch (error) {

        statusElement.innerHTML =
            "<strong>âœ• " +
            escapeHtml(
                error.message
            ) +
            "</strong>";
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
            throw new Error(data.message || "KhÃ´ng láº¥y Ä‘Æ°á»£c tráº¡ng thÃ¡i");
        }

        const job = data.job;
        let html = "";

        if (job.status === "running") {
            html += '<strong>âŸ³ Äang Reindex...</strong>';
        } else if (job.status === "completed") {
            html += '<strong style="color:#4ade80">âœ“ HoÃ n táº¥t</strong>';
        } else if (job.status === "completed_with_errors") {
            html += '<strong style="color:#fbbf24">âš  HoÃ n táº¥t nhÆ°ng cÃ³ lá»—i</strong>';
        } else if (job.status === "failed") {
            html += '<strong style="color:#f87171">âœ• Tháº¥t báº¡i</strong>';
        } else {
            html += '<strong>' + escapeHtml(job.status) + '</strong>';
        }

        html += "<br>Job ID: " + job.id + "<br>";
        html += "Files tÃ¬m tháº¥y: " + (job.files_found ?? 0) + "<br>";
        html += "ThÃªm má»›i: " + (job.files_added ?? 0) + "<br>";
        html += "Cáº­p nháº­t: " + (job.files_updated ?? 0) + "<br>";
        html += "XÃ³a/ngá»«ng hoáº¡t Ä‘á»™ng: " + (job.files_removed ?? 0);

        if (job.error_message) {
            html += "<br><span style='color:#f87171'>" + escapeHtml(job.error_message) + "</span>";
        }

        statusElement.innerHTML = html;

        if (job.status === "completed" || job.status === "completed_with_errors" || job.status === "failed") {
            clearInterval(pollTimers[libraryId]);
            delete pollTimers[libraryId];
        }
    } catch (error) {
        statusElement.innerHTML = '<strong>âœ• ' + escapeHtml(error.message) + '</strong>';
    }
}

async function deleteLibrary(libraryId) {
    if (!confirm("Báº¡n cÃ³ cháº¯c muá»‘n xÃ³a thÆ° viá»‡n nÃ y?")) {
        return;
    }

    try {
        const response = await fetch("/admin/libraries/" + libraryId, { method: "DELETE", headers: getHeaders() });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "KhÃ´ng thá»ƒ xÃ³a thÆ° viá»‡n");
        }

        alert("ÄÃ£ xÃ³a thÆ° viá»‡n.");
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
    // Admin - Quáº£n lÃ½ thÆ° viá»‡n
    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // Admin - Quáº£n lÃ½ thÆ° viá»‡n
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
// Admin - Tráº¡ng thÃ¡i Reindex táº¥t cáº£
// GET /admin/reindex-all/status?libraries=1,2,3
// ---------------------------------------------------------
if (
  url.pathname === "/admin/reindex-all/status" &&
  request.method === "GET"
) {
  // -------------------------------------------------------
  // Kiá»ƒm tra secret
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
  // Láº¥y danh sÃ¡ch library ID
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
          "Thiáº¿u danh sÃ¡ch library ID"
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
  // Láº¥y thÃ´ng tin thÆ° viá»‡n
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
  // Láº¥y Job má»›i nháº¥t cá»§a tá»«ng thÆ° viá»‡n
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
  // TÃ­nh tiáº¿n Ä‘á»™
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
  // Náº¿u táº¥t cáº£ Ä‘Ã£ hoÃ n táº¥t
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
  // Tráº£ káº¿t quáº£
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
    // Admin - Reindex thÆ° viá»‡n
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
        message: "Job ID khÃ´ng há»£p lá»‡"
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
        message: "KhÃ´ng tÃ¬m tháº¥y Reindex job"
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
// Admin - Reindex táº¥t cáº£ thÆ° viá»‡n
// POST /admin/reindex-all
// ---------------------------------------------------------
if (
  url.pathname === "/admin/reindex-all" &&
  request.method === "POST"
) {
  // -------------------------------------------------------
  // Kiá»ƒm tra secret
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
  // Láº¥y toÃ n bá»™ thÆ° viá»‡n Ä‘ang Ä‘Æ°á»£c báº­t
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
          "KhÃ´ng cÃ³ thÆ° viá»‡n nÃ o Ä‘ang Ä‘Æ°á»£c báº­t"
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
  // Láº¥y thÆ° viá»‡n Ä‘áº§u tiÃªn
  // -------------------------------------------------------
  const firstLibrary =
    libraryList[0];

  // -------------------------------------------------------
  // Táº¡o Reindex Job cho thÆ° viá»‡n Ä‘áº§u tiÃªn
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
          "KhÃ´ng táº¡o Ä‘Æ°á»£c Reindex Job"
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
  // ÄÆ°a thÆ° viá»‡n Ä‘áº§u tiÃªn vÃ o Queue
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
  // Tráº£ káº¿t quáº£
  // -------------------------------------------------------
  return new Response(
    JSON.stringify({
      status: "queued",
      message:
        "ÄÃ£ báº¯t Ä‘áº§u Reindex táº¥t cáº£ thÆ° viá»‡n",
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

      // Kiá»ƒm tra secret
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
            message: "Library ID khÃ´ng há»£p lá»‡"
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
              "KhÃ´ng tÃ¬m tháº¥y thÆ° viá»‡n hoáº·c thÆ° viá»‡n Ä‘ang táº¯t"
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
      // Táº¡o Reindex Job trÆ°á»›c khi Ä‘Æ°a vÃ o Queue
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
            message: "KhÃ´ng táº¡o Ä‘Æ°á»£c Reindex Job"
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
      // ÄÆ°a Job vÃ o Queue
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
          message: "ÄÃ£ Ä‘Æ°a yÃªu cáº§u Reindex vÃ o Queue",
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
          name: "Kho Phim Gia ÄÃ¬nh",
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
              message: "TMDB_API_KEY chÆ°a Ä‘Æ°á»£c khai bÃ¡o"
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
            "Vui lÃ²ng truyá»n TMDB movie ID há»£p lá»‡. VÃ­ dá»¥: ?id=672"
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
            "Tham sá»‘ khÃ´ng há»£p lá»‡. VÃ­ dá»¥: ?tvId=276501&season=1&episode=1"
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
            "Tham sá»‘ khÃ´ng há»£p lá»‡. VÃ­ dá»¥: ?tvId=276501&season=1&episode=1"
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
    // VÃ­ dá»¥:
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
    // VÃ­ dá»¥:
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
    // VÃ­ dá»¥:
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
    // 5. KhÃ´ng truyá»n tham sá»‘ â†’ giá»¯ test máº«u
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
    // Chá»‰ test 10 file Ä‘áº§u tiÃªn
    // KhÃ´ng ghi vÃ o D1
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

        // 2. Lá»c file video
        const videoFiles = files.filter((file) => {
          return (
            file?.mimeType?.startsWith("video/") ||
            /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(
              file?.name || ""
            )
          );
        });

        // 3. Chá»‰ test 10 file Ä‘áº§u tiÃªn
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

        // 5. Tá»•ng káº¿t
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
// Tá»± Ä‘á»™ng refresh rating toÃ n bá»™ phim
// TrÃ¬nh duyá»‡t tá»± cháº¡y tá»«ng batch 5 phim
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

<h1>TM-LT - Cáº­p nháº­t Rating</h1>

<div id="status">
Äang chuáº©n bá»‹...
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
        "Äang xá»­ lÃ½...\\\\n" +
        "Offset: " + offset + "\\\\n" +
        "ÄÃ£ xá»­ lÃ½: " + totalProcessed + " phim\\\\n" +
        "ÄÃ£ cáº­p nháº­t: " + totalUpdated + " phim\\\\n" +
        "Lá»—i: " + totalFailed;

      writeLog(
        "â†’ Äang xá»­ lÃ½ offset " +
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
          data.message || "Batch tháº¥t báº¡i"
        );
      }

      totalProcessed += data.processed || 0;
      totalUpdated += data.updated || 0;
      totalFailed += data.failed || 0;

      writeLog(
        "âœ“ Offset " +
        offset +
        ": " +
        data.updated +
        "/" +
        data.processed +
        " cáº­p nháº­t, lá»—i " +
        data.failed
      );

      if (
        data.errors &&
        data.errors.length > 0
      ) {
        for (const error of data.errors) {
          writeLog(
            "  âœ— " +
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

      // Nghá»‰ 300ms giá»¯a cÃ¡c batch
      await new Promise(
        resolve => setTimeout(resolve, 300)
      );
    }

    status.textContent =
      "HOÃ€N Táº¤T!\\\\n\\\\n" +
      "ÄÃ£ xá»­ lÃ½: " +
      totalProcessed +
      " phim\\\\n" +
      "ÄÃ£ cáº­p nháº­t: " +
      totalUpdated +
      " phim\\\\n" +
      "Lá»—i: " +
      totalFailed +
      " phim";

    writeLog("");
    writeLog("================================");
    writeLog("HOÃ€N Táº¤T");
    writeLog(
      "Tá»•ng xá»­ lÃ½: " +
      totalProcessed
    );
    writeLog(
      "Tá»•ng cáº­p nháº­t: " +
      totalUpdated
    );
    writeLog(
      "Tá»•ng lá»—i: " +
      totalFailed
    );
    writeLog("================================");

  } catch (error) {
    status.textContent =
      "CÃ“ Lá»–I: " +
      error.message;

    writeLog(
      "âœ— Lá»–I: " +
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
// Má»—i láº§n cáº­p nháº­t tá»‘i Ä‘a 5 phim
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
            error: "KhÃ´ng láº¥y Ä‘Æ°á»£c voteAverage tá»« TMDB"
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
// Chá»‰ xá»­ lÃ½ file má»›i hoáº·c file Ä‘Ã£ thay Ä‘á»•i
// ---------------------------------------------------------
if (url.pathname === "/test/reindex") {
  let jobId = null;

  try {
    // -----------------------------------------------------
    // Batch Reindex
    // Máº·c Ä‘á»‹nh má»—i láº§n xá»­ lÃ½ 5 file
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
        // 1. Láº¥y thÆ° viá»‡n Ä‘ang báº­t
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
                  "KhÃ´ng tÃ¬m tháº¥y thÆ° viá»‡n Google Drive Ä‘ang Ä‘Æ°á»£c báº­t"
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
// 2. Táº¡o job má»›i hoáº·c tiáº¿p tá»¥c job hiá»‡n táº¡i
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
        // 3. Scan toÃ n bá»™ Google Drive
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
        // 4. Danh sÃ¡ch Drive ID hiá»‡n táº¡i
        // -----------------------------------------------------
        const currentDriveIds =
          new Set(
            videoFiles.map(
              (file) => file.id
            )
          );

        // -----------------------------------------------------
// 5. Bá»™ Ä‘áº¿m
// -----------------------------------------------------
let filesAdded = 0;
let filesUpdated = 0;
let filesSkipped = 0;
let filesFailed = 0;

let errors = [];

// -----------------------------------------------------
// Náº¿u tiáº¿p tá»¥c job cÅ© thÃ¬ láº¥y sá»‘ liá»‡u Ä‘Ã£ tÃ­ch lÅ©y
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
        // 6. Xá»­ lÃ½ tá»«ng file
        // -----------------------------------------------------
                // -----------------------------------------------------
        // Retry TMDB khi gáº·p lá»—i táº¡m thá»i
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

                // KhÃ´ng pháº£i lá»—i táº¡m thá»i
                // thÃ¬ khÃ´ng retry
                if (!isTransient) {
                  throw error;
                }

                // ÄÃ£ háº¿t sá»‘ láº§n thá»­
                if (
                  attempt === maxAttempts
                ) {
                  throw error;
                }

                // Chá» tÄƒng dáº§n:
                // láº§n 1 -> 1 giÃ¢y
                // láº§n 2 -> 2 giÃ¢y
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
        // 6. Xá»­ lÃ½ tá»«ng file
        // -----------------------------------------------------
	const batchFiles =
  videoFiles.slice(
    offset,
    offset + batchSize
  );

for (const file of batchFiles) {
          try {
            // -------------------------------------------------
            // Kiá»ƒm tra file Ä‘Ã£ tá»“n táº¡i trong D1 chÆ°a
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
            // Náº¿u file Ä‘Ã£ tá»“n táº¡i vÃ  khÃ´ng thay Ä‘á»•i:
            // Bá»Ž QUA, khÃ´ng gá»i Parser, khÃ´ng gá»i TMDB
            // -------------------------------------------------
            if (
              existing &&
              existing.drive_name === file.name &&
              (existing.drive_modified_time ?? null) ===
                (file.modifiedTime ?? null)
            ) {
              // Náº¿u trÆ°á»›c Ä‘Ã³ bá»‹ inactive nhÆ°ng hiá»‡n Ä‘Ã£ quay láº¡i
              // thÃ¬ chá»‰ cáº§n kÃ­ch hoáº¡t láº¡i.
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
            // File má»›i hoáº·c file Ä‘Ã£ thay Ä‘á»•i
            // -------------------------------------------------
            const parsed =
              parseFilename(file.name);

            const tmdb =
              await resolveMediaWithRetry(
                parsed
              );

            // -------------------------------------------------
            // KhÃ´ng tÃ¬m tháº¥y TMDB
            // -------------------------------------------------
            if (!tmdb) {
              filesFailed++;

              errors.push({
                driveFileId: file.id,
                fileName: file.name,
                error:
                  "KhÃ´ng tÃ¬m tháº¥y thÃ´ng tin TMDB"
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
            // Äáº¿m thÃªm / cáº­p nháº­t
            // -------------------------------------------------
            if (existing) {
              filesUpdated++;
            } else {
              filesAdded++;
            }

            // -------------------------------------------------
            // Táº¡o stream náº¿u chÆ°a cÃ³
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
            // Lá»—i má»™t file khÃ´ng lÃ m dá»«ng toÃ n bá»™ Reindex
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
// 7. ÄÃ¡nh dáº¥u movie khÃ´ng cÃ²n trÃªn Drive lÃ  inactive
// Chá»‰ thá»±c hiá»‡n khi Ä‘Ã£ xá»­ lÃ½ batch cuá»‘i cÃ¹ng
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
// 9. Cáº­p nháº­t reindex job
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
        // 10. Káº¿t quáº£
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
        // Lá»—i toÃ n bá»™ Reindex
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
            // KhÃ´ng che máº¥t lá»—i gá»‘c
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
    // Stremio Catalog - Kho Phim Gia ÄÃ¬nh
    // ---------------------------------------------------------
    // ---------------------------------------------------------
// Stremio Catalogs
// 4 danh má»¥c:
// 1. Táº¥t cáº£ phim
// 2. A -> Z
// 3. Má»›i nháº¥t
// 4. Äiá»ƒm cao
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
                "KhÃ´ng cÃ³ tÃªn",

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
               AND tmdb_id IS NOT NULL
               AND tmdb_type = 'tv'
               AND id IN (
                 SELECT MIN(id)
                 FROM movies
                 WHERE is_active = 1
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
    // Stremio Meta - Chi tiáº¿t phim
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
                  "KhÃ´ng cÃ³ tÃªn",
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
// Nháº­n diá»‡n phiÃªn báº£n + cháº¥t lÆ°á»£ng tá»« tÃªn file
// ---------------------------------------------------------

let languageLabel =
  "ðŸŽ§ Ã‚m thanh gá»‘c";

// Thuyáº¿t minh
if (
  /thuyet[\s._-]*minh/i.test(fileName) ||
  /thuyáº¿t[\s._-]*minh/i.test(fileName)
) {
  languageLabel =
    "ðŸ‡»ðŸ‡³ Thuyáº¿t minh";

// Phá»¥ Ä‘á» Viá»‡t
} else if (
  /viet[\s._-]*sub/i.test(fileName) ||
  /vietsub/i.test(fileName) ||
  /phu[\s._-]*de/i.test(fileName) ||
  /phá»¥[\s._-]*Ä‘á»/i.test(fileName)
) {
  languageLabel =
    "ðŸ‡»ðŸ‡³ Phá»¥ Ä‘á» Viá»‡t";

// English Sub
} else if (
  /eng[\s._-]*sub/i.test(fileName) ||
  /english[\s._-]*sub/i.test(fileName)
) {
  languageLabel =
    "ðŸ‡¬ðŸ‡§ English Sub";
}


// ---------------------------------------------------------
// Nháº­n diá»‡n cháº¥t lÆ°á»£ng
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
// Táº¡o tÃªn Stream hoÃ n chá»‰nh
// ---------------------------------------------------------

const streamTitle =
  qualityLabel
    ? `${languageLabel} â€¢ ${qualityLabel}`
    : languageLabel;

        const streamUrl =
          `${url.origin}/file/${encodeURIComponent(
            movie.drive_file_id
          )}`;

        return {
          name:
            "Kho Phim Gia ÄÃ¬nh",
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
          name: "Kho Phim Gia ÄÃ¬nh",
          description:
            "Kho phim gia Ä‘Ã¬nh tá»« Google Drive",
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
async queue(batch, env) {
  console.log(
    `TM-LT Queue: nháº­n ${batch.messages.length} message(s)`
  );

  for (const message of batch.messages) {
    try {
      const job = message.body;

      console.log(
        "TM-LT Queue message:",
        JSON.stringify(job)
      );

      // -----------------------------------------------------
      // Cháº¡y batch hiá»‡n táº¡i
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
      // 1. Váº«n cÃ²n batch cá»§a thÆ° viá»‡n hiá»‡n táº¡i
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
          "TM-LT Queue: gá»­i batch tiáº¿p theo:",
          JSON.stringify(nextJob)
        );

        await env.tm_lt_reindex.send(
          nextJob
        );

      } else {

        // ---------------------------------------------------
        // 2. ThÆ° viá»‡n hiá»‡n táº¡i Ä‘Ã£ hoÃ n táº¥t
        // ---------------------------------------------------

        console.log(
          `TM-LT Queue: thÆ° viá»‡n ${job.libraryId} Ä‘Ã£ hoÃ n táº¥t.`
        );

        // ---------------------------------------------------
        // Náº¿u Ä‘Ã¢y lÃ  Reindex táº¥t cáº£
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
          // CÃ²n thÆ° viá»‡n tiáº¿p theo
          // -------------------------------------------------

          if (
            nextIndex <
            job.libraryIds.length
          ) {
            const nextLibraryId =
              job.libraryIds[nextIndex];

            console.log(
              `TM-LT Queue: chuyá»ƒn sang thÆ° viá»‡n ${nextIndex + 1}/${job.libraryIds.length}: ${nextLibraryId}`
            );

            // -----------------------------------------------
            // Táº¡o Job má»›i cho thÆ° viá»‡n tiáº¿p theo
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
                `KhÃ´ng táº¡o Ä‘Æ°á»£c Reindex Job cho library ${nextLibraryId}`
              );
            }

            // -----------------------------------------------
            // ÄÆ°a thÆ° viá»‡n tiáº¿p theo vÃ o Queue
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
              "TM-LT Queue: gá»­i thÆ° viá»‡n tiáº¿p theo:",
              JSON.stringify(nextJob)
            );

            await env.tm_lt_reindex.send(
              nextJob
            );

          } else {

            // -----------------------------------------------
            // ÄÃ£ hoÃ n táº¥t toÃ n bá»™ thÆ° viá»‡n
            // -----------------------------------------------

            console.log(
              "TM-LT Queue: Reindex táº¥t cáº£ thÆ° viá»‡n Ä‘Ã£ hoÃ n táº¥t."
            );
          }
        } else {

          // -------------------------------------------------
          // Reindex má»™t thÆ° viá»‡n bÃ¬nh thÆ°á»ng
          // -------------------------------------------------

          console.log(
            "TM-LT Queue: Reindex thÆ° viá»‡n Ä‘Ã£ hoÃ n táº¥t."
          );
        }
      }

      // -----------------------------------------------------
      // XÃ¡c nháº­n message Ä‘Ã£ xá»­ lÃ½
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
