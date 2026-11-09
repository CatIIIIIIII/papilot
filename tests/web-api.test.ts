import test from 'node:test';
import assert from 'node:assert/strict';
import { requestApi } from '../src/web/api.ts';
import { ReadRequest } from '../src/web/refresh.ts';
import { setLanguage } from '../src/web/i18n.ts';

for (const body of [undefined, { text: 'Continue the revision.' }, new File(['paper'], '论文.tex')]) {
  test(`a slow ${body === undefined ? 'read' : body instanceof File ? 'upload' : 'write'} waits for its complete response`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Native AbortSignal timers bypass the test clock; make any deadline
    // introduced by the transport observable under the same clock.
    t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    let respond!: (response: Response) => void;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, '/api/slow');
      assert.equal(init.method, body === undefined ? 'GET' : 'POST');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('X-Papilot-Token'), 'token');
      assert.equal(headers.get('Content-Type'), body instanceof File ? 'application/octet-stream' : 'application/json');
      assert.equal(init.body, body instanceof File ? body : JSON.stringify(body));
      if (body instanceof File) assert.equal(headers.get('X-Papilot-Filename'), encodeURIComponent(body.name));
      return new Promise<Response>((resolve, reject) => {
        respond = resolve;
        init.signal?.addEventListener('abort', () => { reject(init.signal!.reason); stream?.error(init.signal!.reason); }, { once: true });
      });
    });
    let settled = false;
    const pending = requestApi('/slow', 'token', body);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(60 * 60 * 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Elapsed time must not fail a pending request');
    respond(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(60 * 60 * 1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Elapsed time must not interrupt a response body');
    stream.enqueue(new TextEncoder().encode('{"ok":true}')); stream.close();
    assert.deepEqual(await pending, { ok: true });
  });
}

test('switching views still cancels an obsolete API request and accepts the next response', async t => {
  const reads = new ReadRequest<{ name: string }>();
  let oldSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/new') return Response.json({ name: 'new' });
    oldSignal = init.signal!;
    return new Promise<Response>((_resolve, reject) => oldSignal!.addEventListener('abort', () => reject(oldSignal!.reason), { once: true }));
  });
  const values: string[] = [];
  const old = reads.run('old', signal => requestApi('/old', '', undefined, signal), value => values.push(value.name));
  await Promise.resolve();
  await reads.run('new', signal => requestApi('/new', '', undefined, signal), value => values.push(value.name));
  await old;
  assert.equal(oldSignal?.aborted, true);
  assert.deepEqual(values, ['new']);
});

test('server and network errors remain visible without a timeout wrapper', async t => {
  setLanguage('zh-Hans'); t.after(() => setLanguage('system'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 500 }));
  await assert.rejects(requestApi('/failed', ''), /请求失败，请重试。/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Backend rejected fixture.' }, { status: 404 }));
  await assert.rejects(requestApi('/missing', ''), { message: 'Backend rejected fixture.' });
  const failure = new TypeError('Network connection lost');
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(requestApi('/offline', ''), error => error === failure);
});
