import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The desktop smoke-test helper is plain JavaScript.
import { assertInstalledTools } from '../scripts/desktop-requirements.mjs';

test('desktop smoke checks exempt the macOS Git stub only when developer tools are absent', () => {
  const env = { PATH: '/usr/bin:/bin' }, report = { checks: [{ id: 'git', ok: false }] };
  const locate = (name: string) => name === 'git' ? '/usr/bin/git' : null;
  const calls: unknown[] = [];
  const missing = (file: string, args: string[]) => { calls.push([file, args]); return { status: 1 }; };
  assertInstalledTools(report, env, 'darwin', locate, missing);
  assert.deepEqual(calls, [['/usr/bin/xcode-select', ['-p']]], 'Never invoke the Git installer stub');
  assert.throws(() => assertInstalledTools(report, env, 'darwin', locate, () => ({ status: 0 })), /must detect installed git/);
  assertInstalledTools({ checks: [{ id: 'git', ok: true }] }, env, 'darwin', locate, () => ({ status: 0 }));
});

test('desktop smoke checks still require other Git installations and installed LaTeX tools', () => {
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin' };
  const noStubProbe = () => { throw new Error('Only Apple Git needs the developer-tools check'); };
  assert.throws(() => assertInstalledTools({ checks: [{ id: 'git', ok: false }] }, env, 'darwin',
    (name: string) => name === 'git' ? '/opt/homebrew/bin/git' : null, noStubProbe), /must detect installed git/);
  const report = { checks: [{ id: 'git', ok: false }, { id: 'latexmk', ok: false }] };
  const locate = (name: string) => name === 'git' ? '/usr/bin/git' : name === 'latexmk' ? '/Library/TeX/texbin/latexmk' : null;
  assert.throws(() => assertInstalledTools(report, env, 'darwin', locate, () => ({ status: 1 })), /must detect installed latexmk/);
});
