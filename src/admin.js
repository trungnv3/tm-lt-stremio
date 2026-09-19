// src/admin.js

// =========================================================
// Kiểm tra REINDEX_SECRET
// =========================================================

function checkAdminSecret(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return false;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return false;
  }

  const providedSecret = match[1].trim();

  return (
    providedSecret &&
    env.REINDEX_SECRET &&
    providedSecret === env.REINDEX_SECRET
  );
}

// =========================================================
// Lấy Google Drive Folder ID
//
// Chấp nhận:
//
// 14r5XofFHgMxPtxrFXLP6Rwt5dWRpeP9b
//
// hoặc:
//
// https://drive.google.com/drive/folders/14r5Xof...
// =========================================================

function extractFolderId(value) {
  const input = String(value || "").trim();

  if (!input) {
    return null;
  }

  // Nếu người dùng nhập trực tiếp Folder ID
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) {
    return input;
  }

  // Nếu nhập URL Google Drive
  const match = input.match(
    /drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/i
  );

  if (match) {
    return match[1];
  }

  return null;
}

// =========================================================
// GET /admin/libraries
// =========================================================

export async function getLibraries(request, env) {
  if (!checkAdminSecret(request, env)) {
    return json(
      {
        status: "error",
        message: "Unauthorized"
      },
      401
    );
  }

  const result = await env.tm_lt_db
    .prepare(
      `
      SELECT
        id,
        name,
        folder_id,
        folder_url,
        enabled,
        created_at,
        updated_at
      FROM libraries
      ORDER BY id ASC
      `
    )
    .all();

  return json({
    status: "ok",
    count: result.results.length,
    libraries: result.results
  });
}

// =========================================================
// POST /admin/libraries
// =========================================================

export async function addLibrary(request, env) {
  if (!checkAdminSecret(request, env)) {
    return json(
      {
        status: "error",
        message: "Unauthorized"
      },
      401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        status: "error",
        message: "JSON không hợp lệ"
      },
      400
    );
  }

  const name = String(body.name || "").trim();

  const folderInput = String(
    body.folder_id ||
    body.folder_url ||
    body.folder ||
    ""
  ).trim();

  if (!name) {
    return json(
      {
        status: "error",
        message: "Thiếu tên thư viện"
      },
      400
    );
  }

  const folderId = extractFolderId(folderInput);

  if (!folderId) {
    return json(
      {
        status: "error",
        message:
          "Google Drive Folder ID hoặc URL không hợp lệ"
      },
      400
    );
  }

  const folderUrl =
    `https://drive.google.com/drive/folders/${folderId}`;

  // Kiểm tra thư viện đã tồn tại chưa
  const existing = await env.tm_lt_db
    .prepare(
      `
      SELECT id, name
      FROM libraries
      WHERE folder_id = ?
      LIMIT 1
      `
    )
    .bind(folderId)
    .first();

  if (existing) {
    return json(
      {
        status: "error",
        message: "Thư viện này đã tồn tại",
        library: existing
      },
      409
    );
  }

  const result = await env.tm_lt_db
    .prepare(
      `
      INSERT INTO libraries
        (name, folder_id, folder_url, enabled)
      VALUES
        (?, ?, ?, 1)
      `
    )
    .bind(
      name,
      folderId,
      folderUrl
    )
    .run();

  return json(
    {
      status: "ok",
      message: "Đã thêm thư viện",
      library: {
        id: result.meta.last_row_id,
        name,
        folder_id: folderId,
        folder_url: folderUrl,
        enabled: 1
      }
    },
    201
  );
}

// =========================================================
// DELETE /admin/libraries/:id
// =========================================================

export async function deleteLibrary(request, env, libraryId) {
  if (!checkAdminSecret(request, env)) {
    return json(
      {
        status: "error",
        message: "Unauthorized"
      },
      401
    );
  }

  const id = Number(libraryId);

  if (!Number.isInteger(id) || id <= 0) {
    return json(
      {
        status: "error",
        message: "Library ID không hợp lệ"
      },
      400
    );
  }

  const library = await env.tm_lt_db
    .prepare(
      `
      SELECT id, name
      FROM libraries
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(id)
    .first();

  if (!library) {
    return json(
      {
        status: "error",
        message: "Không tìm thấy thư viện"
      },
      404
    );
  }

  // Xóa streams trước
  await env.tm_lt_db
    .prepare(
      `
      DELETE FROM streams
      WHERE movie_id IN (
        SELECT id
        FROM movies
        WHERE library_id = ?
      )
      `
    )
    .bind(id)
    .run();

  // Xóa movies
  await env.tm_lt_db
    .prepare(
      `
      DELETE FROM movies
      WHERE library_id = ?
      `
    )
    .bind(id)
    .run();

  // Xóa lịch sử reindex của library
  await env.tm_lt_db
    .prepare(
      `
      DELETE FROM reindex_jobs
      WHERE library_id = ?
      `
    )
    .bind(id)
    .run();

  // Cuối cùng xóa library
  await env.tm_lt_db
    .prepare(
      `
      DELETE FROM libraries
      WHERE id = ?
      `
    )
    .bind(id)
    .run();

  return json({
    status: "ok",
    message: "Đã xóa thư viện",
    library: {
      id: library.id,
      name: library.name
    }
  });
}

// =========================================================
// JSON Response
// =========================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8"
      }
    }
  );
}