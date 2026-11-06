// Detached before the old server stops. This file stays in the old release,
// so a broken download cannot remove the code needed to roll back.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { devRevision, readJson, releaseVersion, writeJson } from '../../bin/installation.mjs';
import { importLoader } from '../../bin/agent-paths.mjs';
import { health, loaderFor, sleep } from './update-install.ts';

export async function restartRelease(job: { id: string; root: string; version: string; channel?: 'stable' | 'dev'; previousRoot: string; previousVersion: string; data: string; port: number; parent: number; service: boolean }, ready = () => process.send?.('ready'), attempts = 100) {
  const folder = path.join(job.data, 'updates'), activeFile = path.join(folder, 'active.json'), statusFile = path.join(folder, 'status.json'), lock = path.join(folder, 'install.lock');
  const previous = readJson(activeFile), status = readJson(statusFile) || {};
  const database = path.join(job.data, 'papilot.sqlite'), backup = path.join(folder, 'before-update.sqlite');
  const service = `gui/${process.getuid?.()}/local.papilot`, domain = `gui/${process.getuid?.()}`;
  const plist = path.join(os.homedir(), 'Library/LaunchAgents/local.papilot.plist');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const launchctl = (...args: string[]) => spawnSync('launchctl', args, { stdio: 'ignore', timeout: 15000 });
  let child: ChildProcess | undefined, parentStopped = false, backedUp = false;
  const launch = (root: string) => {
    if (job.service) { if (launchctl('bootstrap', domain, plist).status !== 0) throw new Error('Could not restart the background service.'); return; }
    const log = fs.openSync(path.join(folder, 'server.log'), 'a', 0o600);
    child = spawn(process.execPath, ['--import', importLoader(loaderFor(root)), path.join(root, 'src/server/main.ts')], { cwd: root, detached: true, env: { ...process.env, PAPILOT_DATA: job.data, PAPILOT_PORT: String(job.port) }, stdio: ['ignore', log, log] });
    child.on('error', () => {}); child.unref(); fs.closeSync(log);
  };
  const stopCandidate = async () => {
    if (job.service) launchctl('bootout', service);
    else if (child?.pid) {
      child.kill('SIGTERM');
      for (let i = 0; i < 40 && alive(child.pid); i++) await sleep(100);
      if (alive(child.pid)) child.kill('SIGKILL');
    }
  };
  try {
    if (!releaseVersion(job.version) || (job.channel && (job.channel === 'dev') !== Boolean(devRevision(job.version))) || !fs.realpathSync(job.root).startsWith(fs.realpathSync(path.join(folder, 'releases')) + path.sep) || readJson(path.join(job.root, 'package.json'))?.version !== job.version) throw new Error('Invalid update activation.');
    writeJson(lock, { pid: process.pid });
    writeJson(statusFile, { ...status, phase: 'restarting', pid: process.pid });
    writeJson(activeFile, { root: job.root, version: job.version, channel: job.channel, id: job.id, phase: 'pending', pid: process.pid, previous });
    ready();
    for (let i = 0; i < 150 && alive(job.parent); i++) await sleep(100);
    if (alive(job.parent)) throw new Error('Papilot did not finish shutting down.');
    parentStopped = true;
    if (job.service) launchctl('bootout', service);
    if (fs.existsSync(database)) {
      fs.copyFileSync(database, backup); backedUp = true;
      // Forced shutdown may leave committed SQLite pages in the WAL.
      if (fs.existsSync(database + '-wal')) fs.copyFileSync(database + '-wal', backup + '-wal');
      else fs.rmSync(backup + '-wal', { force: true });
    }
    writeJson(activeFile, { root: job.root, version: job.version, channel: job.channel, id: job.id, phase: 'starting', pid: process.pid, previous });
    launch(job.root);
    for (let i = 0; i < attempts; i++) {
      if (await health(job.port, job.version, job.id)) {
        writeJson(activeFile, { root: job.root, version: job.version, channel: job.channel, id: job.id, phase: 'active' });
        writeJson(statusFile, { ...status, phase: 'updated', currentVersion: job.version, error: null, pid: process.pid });
        return;
      }
      await sleep(300);
    }
    throw new Error('The new version did not restart successfully.');
  } catch (error) {
    if (parentStopped) await stopCandidate();
    if (previous) writeJson(activeFile, previous); else fs.rmSync(activeFile, { force: true });
    if (parentStopped && backedUp) {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(database + suffix, { force: true });
      fs.copyFileSync(backup, database);
      if (fs.existsSync(backup + '-wal')) fs.copyFileSync(backup + '-wal', database + '-wal');
    }
    writeJson(statusFile, { ...status, phase: 'failed', checkedAt: Date.now(), error: `${error instanceof Error ? error.message : 'The update failed.'} The previous version has been restored.`, pid: process.pid });
    if (parentStopped) launch(job.previousRoot);
  } finally { fs.rmSync(lock, { force: true }); }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const job = readJson(process.argv[2]);
  if (!job) throw new Error('Missing update restart job.');
  await restartRelease(job);
}
