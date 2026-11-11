import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const run = (env: Record<string, string>) => spawnSync('bash', ['scripts/ci-passed.sh'], { env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/main', CHECK_RESULT: 'success', REVIEW_RESULT: 'success', INTERFACE_RESULT: 'success', WINDOWS_RESULT: 'success', CHANGES_RESULT: 'success', DESKTOP_SCOPE: 'quick', DESKTOP_RESULT: 'success', DESKTOP_VERIFIED: 'success', ...env } }).status;
test('CI requires explicit desktop success, including reusable workflow output', () => {
  assert.equal(run({}), 0);
  assert.equal(run({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0', CHANGES_RESULT: 'skipped', DESKTOP_RESULT: 'skipped', DESKTOP_VERIFIED: '' }), 0);
  for (const key of ['CHECK_RESULT', 'REVIEW_RESULT', 'INTERFACE_RESULT', 'WINDOWS_RESULT', 'CHANGES_RESULT', 'DESKTOP_RESULT', 'DESKTOP_VERIFIED'])
    for (const value of ['', 'skipped', 'cancelled', 'failure']) assert.notEqual(run({ [key]: value }), 0, `${key}=${value}`);
  assert.notEqual(run({ DESKTOP_SCOPE: '' }), 0);
  assert.equal(run({ DESKTOP_SCOPE: 'none', DESKTOP_RESULT: 'skipped', DESKTOP_VERIFIED: '' }), 0);
  assert.equal(run({ GITHUB_EVENT_NAME: 'workflow_dispatch', CHANGES_RESULT: 'skipped', DESKTOP_RESULT: 'skipped', DESKTOP_VERIFIED: '' }), 0);
});
