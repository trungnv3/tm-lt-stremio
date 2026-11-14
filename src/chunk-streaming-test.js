import { getDriveFileStream } from "./drive.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

const EXPOSED_HEADERS =
  "Accept-Ranges, Content-Length, Content-Range, Retry-After";

function createErrorResponse(error) {
  const status =
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 500;
  const headers = new Headers(CORS_HEADERS);

  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);

  for (const name of ["content-range", "retry-after"]) {
    const value = error?.headers?.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  return new Response(
    JSON.stringify(
      {
        status: "error",
        file: error?.code || "download_failed",
        message: error?.message || String(error)
      },
      null,
      2
    ),
    {
      status,
      headers
    }
  );
}

function createResponseHeaders(driveResponse) {
  const headers = new Headers(CORS_HEADERS);

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
      headers.set(name, value);
    }
  }

  headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/file/")) {
      return new Response("Not Found", {
        status: 404,
        headers: CORS_HEADERS
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "Access-Control-Expose-Headers": EXPOSED_HEADERS
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

    let fileId;

    try {
      fileId = decodeURIComponent(url.pathname.slice("/file/".length));
    } catch {
      return new Response("Invalid file ID", {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    if (!fileId) {
      return new Response("Missing file ID", {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    try {
      const driveResponse = await getDriveFileStream(env, fileId, request);

      if (request.method === "HEAD" && driveResponse.body) {
        await driveResponse.body.cancel("HEAD request");
      }

      return new Response(
        request.method === "HEAD" ? null : driveResponse.body,
        {
          status: driveResponse.status,
          headers: createResponseHeaders(driveResponse)
        }
      );
    } catch (error) {
      return createErrorResponse(error);
    }
  }
};
