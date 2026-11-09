import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { download } from '../src/server/update-install.ts';

const url = 'https://github.com/PapilotAI/papilot/releases/download/v1.1.0/desktop.json';
const failed = /The new version could not be installed/;

function streamedResponse(init: ResponseInit = {}) {
  let chunks = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks === 64) controller.close();
      else { chunks++; controller.enqueue(new Uint8Array(1024)); }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, init), chunks: () => chunks, cancelled: () => cancelled };
}

for (const headers of [undefined, { 'Content-Length': '64' }]) {
  test(`update download stops an oversized stream with ${headers ? 'a small' : 'no'} Content-Length`, async () => {
    const source = streamedResponse({ headers });
    await assert.rejects(download(url, async () => source.response, 4096), failed);
    assert.equal(source.chunks(), 5, 'Stop on the first chunk over the limit, without reading the remainder');
    assert.equal(source.cancelled(), true);
    assert.equal(source.response.body!.locked, false);
  });
}

test('update download accepts exact-limit binary data and empty responses', async () => {
  const chunks = [new Uint8Array([0, 255]), new Uint8Array([128, 1, 2])];
  const response = new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }));
  assert.deepEqual(await download(url, async () => response, 5), Buffer.from([0, 255, 128, 1, 2]));
  assert.equal(response.body!.locked, false);
  assert.deepEqual(await download(url, async () => new Response(null, { status: 204 }), 0), Buffer.alloc(0));
});

test('update download applies the limit to decoded HTTP data', async t => {
  const compressed = gzipSync(Buffer.alloc(65536));
  assert.ok(compressed.length < 1024);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    response.end(compressed);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let decoded: Response | undefined, cancelled = false;
  const fetcher: typeof fetch = async (_input, init) => {
    decoded = await fetch(`http://127.0.0.1:${address.port}`, init);
    const body = decoded.body!, cancel = body.cancel.bind(body);
    t.mock.method(body, 'cancel', async () => { cancelled = true; await cancel(); });
    return decoded;
  };
  await assert.rejects(download(url, fetcher, 1024), failed);
  assert.equal(cancelled, true, 'Cancel the decoded body rather than waiting for its end');
  assert.equal(decoded!.body!.locked, false);
});

test('update download preserves a stream failure and releases its reader', async () => {
  const failure = new Error('download connection lost');
  const response = new Response(new ReadableStream({
    pull(controller) { controller.error(failure); },
  }));
  await assert.rejects(download(url, async () => response, 1024), error => error === failure);
  assert.equal(response.body!.locked, false);
});

for (const init of [{ status: 503 }, { headers: { 'Content-Length': '65536' } }]) {
  test(`update download cancels a rejected ${init.status ? 'HTTP status' : 'declared size'} body`, async () => {
    const source = streamedResponse(init);
    await assert.rejects(download(url, async () => source.response, 1024), failed);
    assert.equal(source.chunks(), 0);
    assert.equal(source.cancelled(), true);
  });
}

test('update download cancels missing manifests and redirect bodies', async () => {
  const missing = streamedResponse({ status: 404 });
  assert.equal(await download(url, async () => missing.response, 1024, true), null);
  assert.equal(missing.cancelled(), true);
  assert.equal(missing.chunks(), 0);
  const redirect = streamedResponse({ status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/desktop.json' } });
  const requests: string[] = [];
  const fetcher: typeof fetch = async input => {
    requests.push(String(input));
    return requests.length === 1 ? redirect.response : new Response('ok');
  };
  assert.deepEqual(await download(url, fetcher, 2), Buffer.from('ok'));
  assert.equal(redirect.cancelled(), true);
  assert.equal(redirect.chunks(), 0);
  assert.deepEqual(requests, [url, 'https://release-assets.githubusercontent.com/desktop.json']);
});
