import assert from "node:assert/strict";
import test from "node:test";

import {
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
