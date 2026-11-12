const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

const ROOT_FOLDER_ID = "14r5XofFHgMxPtxrFXLP6Rwt5dWRpeP9b";

function base64UrlEncode(data) {
  let bytes;

  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = new Uint8Array(data);
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemToArrayBuffer(pem) {
const normalizedPem = pem.replace(/\\n/g, "\n");

const base64 = normalizedPem
  .replace("-----BEGIN PRIVATE KEY-----", "")
  .replace("-----END PRIVATE KEY-----", "")
  .replace(/\s/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createServiceAccountJwt(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const claim = {
    iss: env.GDRIVE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64UrlEncode(
    JSON.stringify(header)
  );

  const encodedClaim = base64UrlEncode(
    JSON.stringify(claim)
  );

  const unsignedToken =
    `${encodedHeader}.${encodedClaim}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GDRIVE_PRIVATE_KEY),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function getAccessToken(env) {
  const jwt = await createServiceAccountJwt(env);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type":
        "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type:
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Google OAuth failed: ${response.status} ${text}`
    );
  }

  const data = await response.json();

  return data.access_token;
}

async function listChildren(
  accessToken,
  parentId
) {
  const results = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q:
        `'${parentId}' in parents ` +
        `and trashed = false`,
      fields:
        "nextPageToken,files(" +
        "id,name,mimeType,size,modifiedTime,parents," +
        "webContentLink,createdTime" +
        ")",
      pageSize: "1000",
      orderBy: "name"
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await fetch(
      `${DRIVE_API}?${params}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `Drive API failed: ${response.status} ${text}`
      );
    }

    const data = await response.json();

    if (data.files) {
      results.push(...data.files);
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return results;
}

function isFolder(file) {
  return (
    file.mimeType ===
    "application/vnd.google-apps.folder"
  );
}

function isVideo(file) {
  if (!file.mimeType) {
    return false;
  }

  return file.mimeType.startsWith("video/");
}

async function scanFolder(
  accessToken,
  folderId,
  visitedFolders,
  output
) {
  if (visitedFolders.has(folderId)) {
    return;
  }

  visitedFolders.add(folderId);

  const files = await listChildren(
    accessToken,
    folderId
  );

  for (const file of files) {
    if (isFolder(file)) {
      await scanFolder(
        accessToken,
        file.id,
        visitedFolders,
        output
      );

      continue;
    }

    if (isVideo(file)) {
      output.push(file);
    }
  }
}

export async function scanDriveLibrary(
  env,
  rootFolderId = ROOT_FOLDER_ID
) {
  const accessToken =
    await getAccessToken(env);

  const files = [];

  await scanFolder(
    accessToken,
    rootFolderId,
    new Set(),
    files
  );

  return files;
}

export async function testDriveConnection(env) {
  const accessToken =
    await getAccessToken(env);

  const files =
    await listChildren(
      accessToken,
      ROOT_FOLDER_ID
    );

  return {
    rootFolderId: ROOT_FOLDER_ID,
    itemCount: files.length,
    items: files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType
    }))
  };
}
export function parseOpenEndedByteRange(range) {
  if (!range) {
    return null;
  }

  const match = /^bytes=(\d+)-$/i.exec(range.trim());

  if (!match) {
    return null;
  }

  const start = Number(match[1]);

  if (!Number.isSafeInteger(start) || start < 0) {
    throw new Error("Invalid byte range");
  }

  return start;
}

export function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(
    value || ""
  );

  if (!match) {
    throw new Error("Drive did not return a valid Content-Range");
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    throw new Error("Drive returned an invalid Content-Range");
  }

  return { start, end, total };
}

function createAbortError() {
  const error = new Error("Video stream was cancelled");
  error.name = "AbortError";
  return error;
}

async function fetchDriveRange(
  fileUrl,
  accessToken,
  start,
  end,
  signal
) {
  const response = await fetch(fileUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Range: `bytes=${start}-${end}`
    },
    signal
  });

  // 416 is a valid answer to an unsatisfied Range request and must be
  // relayed to the player instead of being turned into a misleading 500.
  if (!response.ok && response.status !== 416) {
    const text = (await response.text()).slice(0, 1000);
    throw new Error(
      `Drive download failed: ${response.status} ${text}`
    );
  }

  return response;
}

async function cancelReader(reader, reason) {
  if (!reader) {
    return;
  }

  try {
    await reader.cancel(reason);
  } catch {
    // The upstream body may already be closed or aborted.
  }

  try {
    reader.releaseLock();
  } catch {
    // A released reader has no further cleanup work.
  }
}

export function makeChunkedBody({
  firstResponse,
  start,
  end,
  total,
  requestSignal,
  fetchChunk
}) {
  let nextByte = start;
  let pendingResponse = firstResponse;
  let activeReader = null;
  let remainingInChunk = 0;
  let finished = false;

  const abortController = new AbortController();
  const abortFromClient = () => {
    abortController.abort(requestSignal?.reason);
  };

  if (requestSignal) {
    if (requestSignal.aborted) {
      abortFromClient();
    } else {
      requestSignal.addEventListener("abort", abortFromClient, {
        once: true
      });
    }
  }

  const cleanup = () => {
    requestSignal?.removeEventListener("abort", abortFromClient);
  };

  const discardActiveReader = async reason => {
    const reader = activeReader;
    activeReader = null;
    remainingInChunk = 0;
    await cancelReader(reader, reason);
  };

  const discardPendingResponse = async reason => {
    const response = pendingResponse;
    pendingResponse = null;

    try {
      await response?.body?.cancel(reason);
    } catch {
      // The response may already have been consumed or aborted.
    }
  };

  const openNextChunk = async () => {
    let response = pendingResponse;
    pendingResponse = null;

    if (!response) {
      const chunkEnd = Math.min(
        nextByte + DRIVE_STREAM_CHUNK_BYTES - 1,
        end
      );

      response = await fetchChunk(
        nextByte,
        chunkEnd,
        abortController.signal
      );
    }

    if (abortController.signal.aborted) {
      throw createAbortError();
    }

    if (response.status !== 206) {
      throw new Error(
        `Drive returned ${response.status} for a video chunk`
      );
    }

    const range = parseContentRange(
      response.headers.get("content-range")
    );

    if (
      range.start !== nextByte ||
      range.end > end ||
      range.total !== total
    ) {
      throw new Error("Drive returned a chunk outside the requested range");
    }

    const advertisedLength = response.headers.get("content-length");
    const expectedLength = range.end - range.start + 1;

    if (
      advertisedLength &&
      Number(advertisedLength) !== expectedLength
    ) {
      throw new Error("Drive returned a mismatched Content-Length");
    }

    if (!response.body) {
      throw new Error("Drive returned an empty video chunk");
    }

    activeReader = response.body.getReader();
    remainingInChunk = expectedLength;
  };

  return new ReadableStream({
    async pull(controller) {
      if (finished) {
        return;
      }

      try {
        if (abortController.signal.aborted) {
          throw createAbortError();
        }

        while (true) {
          if (!activeReader) {
            if (nextByte > end) {
              finished = true;
              cleanup();
              controller.close();
              return;
            }

            await openNextChunk();
          }

          const { done, value } = await activeReader.read();

          if (done) {
            if (remainingInChunk !== 0) {
              throw new Error("Drive video chunk ended before its range");
            }

            await discardActiveReader("chunk complete");
            continue;
          }

          if (!value || value.byteLength === 0) {
            continue;
          }

          if (value.byteLength > remainingInChunk) {
            throw new Error("Drive video chunk exceeded its range");
          }

          remainingInChunk -= value.byteLength;
          nextByte += value.byteLength;
          controller.enqueue(value);

          if (remainingInChunk === 0) {
            await discardActiveReader("chunk complete");
          }

          // Enqueue one source packet at a time so the consumer's
          // backpressure controls the next Drive read/request.
          return;
        }
      } catch (error) {
        finished = true;
        abortController.abort(error);
        await discardActiveReader(error);
        await discardPendingResponse(error);
        cleanup();
        controller.error(error);
      }
    },

    async cancel(reason) {
      finished = true;
      abortController.abort(reason);
      await discardActiveReader(reason);
      await discardPendingResponse(reason);
      cleanup();
    }
  });
}

function createChunkedResponse({
  firstResponse,
  start,
  end,
  total,
  hasRangeHeader,
  request,
  fetchChunk
}) {
  const headers = new Headers();
  const contentType = firstResponse.headers.get("content-type");

  if (contentType) {
    headers.set("content-type", contentType);
  }

  headers.set("accept-ranges", "bytes");
  headers.set("content-length", String(end - start + 1));

  if (hasRangeHeader) {
    headers.set(
      "content-range",
      `bytes ${start}-${end}/${total}`
    );
  }

  for (const name of ["etag", "last-modified", "cache-control"]) {
    const value = firstResponse.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  if (request.method === "HEAD") {
    if (firstResponse.body) {
      firstResponse.body.cancel("HEAD request").catch(() => {});
    }

    return new Response(null, {
      status: hasRangeHeader ? 206 : 200,
      headers
    });
  }

  return new Response(
    makeChunkedBody({
      firstResponse,
      start,
      end,
      total,
      requestSignal: request.signal,
      fetchChunk
    }),
    {
      status: hasRangeHeader ? 206 : 200,
      headers
    }
  );
}

export async function getDriveFileStream(env, fileId, request) {
  const accessToken = await getAccessToken(env);
  const fileUrl =
    `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`;
  const rangeHeader = request.headers.get("Range");
  const openRangeStart = parseOpenEndedByteRange(rangeHeader);

  // Preserve explicit bounded, suffix, and multi-range requests. The chunked
  // path is only for a whole file or the open form `bytes=N-` that Drive
  // rejects when it tries to deliver the entire remainder in one response.
  if (rangeHeader && openRangeStart === null) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Range: rangeHeader
    };

    const response = await fetch(fileUrl, {
      method: "GET",
      headers,
      signal: request.signal
    });

    if (!response.ok && response.status !== 416) {
      const text = (await response.text()).slice(0, 1000);
      throw new Error(
        `Drive download failed: ${response.status} ${text}`
      );
    }

    return response;
  }

  const start = openRangeStart ?? 0;
  const firstEnd = Math.min(
    start + DRIVE_STREAM_CHUNK_BYTES - 1,
    Number.MAX_SAFE_INTEGER
  );
  const firstResponse = await fetchDriveRange(
    fileUrl,
    accessToken,
    start,
    firstEnd,
    request.signal
  );

  if (firstResponse.status === 416) {
    return firstResponse;
  }

  const firstRange = parseContentRange(
    firstResponse.headers.get("content-range")
  );

  if (firstRange.start !== start) {
    throw new Error("Drive returned a range starting at the wrong byte");
  }

  return createChunkedResponse({
    firstResponse,
    start,
    end: firstRange.total - 1,
    total: firstRange.total,
    hasRangeHeader: Boolean(rangeHeader),
    request,
    fetchChunk: (chunkStart, chunkEnd, signal) =>
      fetchDriveRange(
        fileUrl,
        accessToken,
        chunkStart,
        chunkEnd,
        signal
      )
  });
}
