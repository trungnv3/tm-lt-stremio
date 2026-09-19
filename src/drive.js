const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

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
export async function getDriveFileStream(
  env,
  fileId,
  request
) {
  const accessToken =
    await getAccessToken(env);

  const headers = {
    Authorization:
      `Bearer ${accessToken}`
  };

  // Chuyển Range từ Stremio xuống Google Drive
  const range =
    request.headers.get("Range");

  if (range) {
    headers.Range = range;
  }

  const response =
    await fetch(
      `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`,
      {
        method: "GET",
        headers
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Drive download failed: ${response.status} ${text}`
    );
  }

  return response;
}