import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAgent } from '../src/server/acp.ts';

// No generation: inspect Kimi's own config response after each native change.
test('installed Kimi applies all advertised permission modes and revokes YOLO', { skip: !process.env.PAPILOT_KIMI_TEST_BIN, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-kimi-permissions-'));
  const agent = new KimiAgent(process.env.PAPILOT_KIMI_TEST_BIN);
  let id: string | undefined;
  try {
    await agent.start();
    assert.deepEqual(agent.permissionOptions().map(option => option.value), ['workspace', 'plan', 'auto', 'full']);
    id = (await agent.request('thread/start', { cwd: dir })).thread.id;
    for (const [selected, expected] of [['full', 'yolo'], ['workspace', 'default'], ['auto', 'auto'], ['plan', 'plan'], ['workspace', 'default']]) {
      await (agent as any).session(id, dir, null, selected);
      // session/resume resets Kimi's mode, so use an unrelated config response
      // to read it without changing the setting under test.
      const native = await (agent as any).rpc('session/set_config_option', { sessionId: id, configId: 'thinking', value: 'high' });
      assert.equal(native.configOptions.find((option: any) => option.id === 'mode')?.currentValue, expected);
    }
  } finally {
    if (id) await (agent as any).rpc('session/delete', { sessionId: id }).catch(() => {});
    agent.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
