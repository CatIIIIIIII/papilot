import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedNode, wslReport } from '../desktop/environment-check.ts';

test('WSL setup requires supported Linux Node and npm even with an existing runtime', () => {
  for (const version of ['22.22.0', 'v24.22.2', '26.0.0']) assert.equal(supportedNode(version), true);
  for (const version of ['', '22.21.9', '20.20.0', 'not installed', '24']) assert.equal(supportedNode(version), false);
  const report = wslReport('shell banner\nPAPILOT_CHECK:node=24.22.2\nPAPILOT_CHECK:npm=\nPAPILOT_CHECK:git=yes\nPAPILOT_CHECK:tex= latexmk synctex\nPAPILOT_CHECK:prepared=yes\n');
  assert.equal(report.canPrepare, false);
  assert.equal(report.prepared, true);
  assert.deepEqual(report.checks.map(check => check.ready), [false, true, false]);
  assert.equal(report.checks[2].detail, 'latexmk synctex');
});

test('a complete probe distinguishes tool readiness from Papilot preparation', () => {
  const output = 'PAPILOT_CHECK:node=24.22.2\r\nPAPILOT_CHECK:npm=yes\r\nPAPILOT_CHECK:git=yes\r\nPAPILOT_CHECK:tex=\r\n';
  const report = wslReport(output);
  assert.equal(report.canPrepare, true);
  assert.equal(report.prepared, false);
  assert.ok(report.checks.every(check => check.ready));
  assert.equal(wslReport(output + 'PAPILOT_CHECK:prepared=yes').prepared, true);
  assert.throws(() => wslReport('Could not start distro'), /did not finish/);
  assert.throws(() => wslReport('PAPILOT_CHECK:node=24.22.2'), /did not finish/);
});
