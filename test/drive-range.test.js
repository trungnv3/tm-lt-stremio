import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessTokenCache,
  createChunkedResponse,
  createDriveDownloadError,
  makeChunkedBody,
  parseContentRange,
  parseOpenEndedByteRange
} from "../src/drive.js";

function responseForRange(start, end, total, body) {
  return new Response(body, {
    status: 206,
    headers: {
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${total}`
    }
  });
}

async function readText(stream) {
  return new Response(stream).text();
}

test("parses an open-ended single byte range", () => {
  assert.equal(parseOpenEndedByteRange("bytes=123-"), 123);
  assert.equal(parseOpenEndedByteRange("bytes=123-456"), null);
  assert.equal(parseOpenEndedByteRange("bytes=-456"), null);
  assert.deepEqual(
    parseContentRange("bytes 123-456/1000"),
    { start: 123, end: 456, total: 1000 }
  );
});

test("rejects malformed and unsafe byte ranges with 416", () => {
  for (const range of [
    "items=0-1",
    "bytes=-",
    "bytes=4-3",
    "bytes=9007199254740992-"
  ]) {
    assert.throws(
      () => parseOpenEndedByteRange(range),
      (error) => error?.status === 416
    );
  }
});

test("maps Drive quota errors to a retryable status", () => {
  const error = createDriveDownloadError(
    new Response(null, {
      status: 403,
      headers: {
        "retry-after": "120"
      }
    }),
    JSON.stringify({
      error: {
        errors: [
          {
            reason: "downloadQuotaExceeded"
          }
        ]
      }
    })
  );

  assert.equal(error.status, 503);
  assert.equal(error.code, "drive_temporarily_unavailable");
  assert.equal(error.headers.get("retry-after"), "120");
});

test("returns Range headers without a body for HEAD", () => {
  const response = createChunkedResponse({
    firstResponse: responseForRange(10, 12, 100, "abc"),
    start: 10,
    end: 99,
    total: 100,
    hasRangeHeader: true,
    request: new Request("https://example.test/file/id", {
      method: "HEAD"
    }),
    fetchChunk: async () => {
      throw new Error("HEAD must not fetch another chunk");
    }
  });

  assert.equal(response.status, 206);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "90");
  assert.equal(response.headers.get("content-range"), "bytes 10-99/100");
});

test("reuses a token and refreshes it before expiration", async () => {
  let currentTime = 0;
  let requests = 0;
  const getToken = createAccessTokenCache({
    now: () => currentTime,
    refreshSkewMs: 60_000
  });
  const requestToken = async () => {
    requests += 1;

    return {
      accessToken: `token-${requests}`,
      expiresInSeconds: 3600
    };
  };

  assert.equal(await getToken(requestToken), "token-1");
  assert.equal(await getToken(requestToken), "token-1");
  assert.equal(requests, 1);

  currentTime = 3_540_000;

  assert.equal(await getToken(requestToken), "token-2");
  assert.equal(requests, 2);
});

test("coalesces concurrent token requests", async () => {
  let requests = 0;
  let resolveToken;
  const getToken = createAccessTokenCache();
  const requestToken = () => {
    requests += 1;

    return new Promise((resolve) => {
      resolveToken = resolve;
    });
  };

  const first = getToken(requestToken);
  const second = getToken(requestToken);

  await Promise.resolve();
  assert.equal(requests, 1);

  resolveToken({
    accessToken: "shared-token",
    expiresInSeconds: 3600
  });

  assert.deepEqual(
    await Promise.all([first, second]),
    ["shared-token", "shared-token"]
  );
});

test("does not retain a failed token request", async () => {
  let requests = 0;
  const getToken = createAccessTokenCache();
  const requestToken = async () => {
    requests += 1;

    if (requests === 1) {
      throw new Error("OAuth temporarily unavailable");
    }

    return {
      accessToken: "recovered-token",
      expiresInSeconds: 3600
    };
  };

  await assert.rejects(
    () => getToken(requestToken),
    /OAuth temporarily unavailable/
  );
  assert.equal(await getToken(requestToken), "recovered-token");
  assert.equal(requests, 2);
});

test("concatenates bounded Drive chunks in byte order", async () => {
  const requestedChunks = [];
  const stream = makeChunkedBody({
    firstResponse: responseForRange(0, 2, 7, "abc"),
    start: 0,
    end: 6,
    total: 7,
    fetchChunk: async (start, end) => {
      requestedChunks.push([start, end]);
      return responseForRange(start, end, 7, "defg");
    }
  });

  assert.equal(await readText(stream), "abcdefg");
  assert.deepEqual(requestedChunks, [[3, 6]]);
});

test("terminates the response when a later Drive chunk fails", async () => {
  const stream = makeChunkedBody({
    firstResponse: responseForRange(0, 2, 7, "abc"),
    start: 0,
    end: 6,
    total: 7,
    fetchChunk: async () => new Response("quota", { status: 403 })
  });

  await assert.rejects(
    () => readText(stream),
    /Drive returned 403 for a video chunk/
  );
});

test("cancels the active Drive reader when the client stops playback", async () => {
  let upstreamCancelled = false;
  const stalledBody = new ReadableStream({
    pull() {
      // Keep the upstream response pending until the downstream reader cancels.
    },
    cancel() {
      upstreamCancelled = true;
    }
  });
  const stream = makeChunkedBody({
    firstResponse: new Response(stalledBody, {
      status: 206,
      headers: {
        "content-length": "1",
        "content-range": "bytes 0-0/1"
      }
    }),
    start: 0,
    end: 0,
    total: 1,
    fetchChunk: async () => {
      throw new Error("A second chunk must not be requested");
    }
  });
  const reader = stream.getReader();
  const pendingRead = reader.read();

  await reader.cancel("client disconnected");
  await pendingRead;

  assert.equal(upstreamCancelled, true);
});
