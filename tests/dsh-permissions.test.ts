import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Match the adapter's published method shape, but use no Harness, credentials or agent process.
const source = `
const inject = ["sessions"];
const invalidParams$1 = message => new Error(message);
export { inject };
export class Session {
  constructor(ctx) {
    this.ctx = ctx;
    this.agent = { session: { permission: 'workspace-write' } };
    this.model = 'initial';
    this.modelControl = {
      options: async () => [{ id: 'model', currentValue: this.model }],
      set: async (id, value) => { if (id !== 'model') throw new Error('Unexpected config'); this.model = value; },
    };
  }
  assertActive() { if (this.inactive) throw new Error('Inactive session'); }
\tconfigOptions(signal) {
\t\tthis.assertActive();
\t\treturn this.modelControl.options(signal);
\t}
\tsetConfig(configId, value, signal) {
\t\tthis.assertActive();
\t\treturn this.modelControl.set(configId, value, signal);
\t}
}
`;

function runFixture(moduleSource: string, assertions: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-dsh-permissions-'));
  try {
    const module = path.join(dir, '@deepseek-ai', 'dsh-acp', 'lib', 'index.js');
    fs.mkdirSync(path.dirname(module), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(module, moduleSource);
    const result = spawnSync(process.execPath, ['--import', new URL('../bin/dsh-permissions.mjs', import.meta.url).href,
      '--input-type=module', '--eval', `import assert from 'node:assert/strict';\nimport { Session, inject } from ${JSON.stringify(pathToFileURL(module).href)};\n${assertions}`],
    { cwd: dir, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('DeepSeek loader applies native presets, persists them and preserves model configuration', () => {
  const result = runFixture(source, `
    assert.deepEqual(inject, ['permissionPresets', 'approval', 'sessions']);
    const calls = [];
    const ctx = {
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access', 'custom'],
        current: session => session.permission,
        optionOf: value => ({ value, name: value }),
        apply(session, value, setPolicy) { session.permission = value; calls.push(['apply', value]); setPolicy(value); },
      },
      approval: { setPolicy(agent, policy) { assert.equal(agent, session.agent); calls.push(['policy', policy]); } },
      sessions: { async flush(saved) { assert.equal(saved, session.agent.session); calls.push(['flush', saved.permission]); } },
    };
    const session = new Session(ctx);
    let options = await session.configOptions();
    assert.equal(options[0].currentValue, 'initial');
    assert.equal(options[1].id, 'permission_mode');
    assert.equal(options[1].currentValue, 'workspace-write');
    assert.deepEqual(options[1].options.map(option => option.value), ['read-only', 'workspace-write', 'danger-full-access']);
    for (const value of ['danger-full-access', 'workspace-write', 'read-only']) {
      options = await session.setConfig('permission_mode', value);
      assert.equal(options[1].currentValue, value);
    }
    assert.deepEqual(calls, ['danger-full-access', 'workspace-write', 'read-only'].flatMap(value => [['apply', value], ['policy', value], ['flush', value]]));
    options = await session.setConfig('model', 'selected');
    assert.equal(options[0].currentValue, 'selected');
    assert.equal(options[1].currentValue, 'read-only');
    await assert.rejects(session.setConfig('permission_mode', 'custom'), /Unsupported permission mode/);
    session.inflight = {};
    await assert.rejects(session.setConfig('permission_mode', 'danger-full-access'), /Pause the current turn/);
    assert.equal(calls.length, 9, 'rejected changes must not apply or flush a policy');
    session.inflight = undefined;
    session.inactive = true;
    await assert.rejects(session.configOptions(), /Inactive session/);
    await assert.rejects(session.setConfig('permission_mode', 'workspace-write'), /Inactive session/);
    delete ctx.permissionPresets;
    session.inactive = false;
    await assert.rejects(session.configOptions(), /requires native dsh permission presets/);
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const method of ['configOptions(signal)', 'setConfig(configId, value, signal)']) {
  test(`DeepSeek loader rejects an incompatible ${method} layout before running it`, () => {
    const result = runFixture(source.replace(method, method.replace('signal', 'changed')), "assert.fail('An incompatible adapter must not execute');");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /This dsh version needs an updated Papilot permission adapter/);
    assert.doesNotMatch(result.stderr, /An incompatible adapter must not execute/);
  });
}

for (const layout of ['missing', 'ambiguous']) {
  test(`DeepSeek loader rejects ${layout} dependency injection before running it`, () => {
    const changed = layout === 'missing' ? source.replace('const inject = [', 'const inject=[')
      : `${source}\nfunction unrelated() { const inject = []; return inject; }`;
    const result = runFixture(changed, "assert.fail('An incompatible adapter must not execute');");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /This dsh version needs an updated Papilot permission adapter/);
    assert.doesNotMatch(result.stderr, /An incompatible adapter must not execute/);
  });
}
