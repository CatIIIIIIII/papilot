import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { commandSpec } from './platform.mjs';
const require = createRequire(import.meta.url);
// `papilot doctor` and --help also work before dependencies are installed.
let windowsSpawn;
const crossSpawn = () => windowsSpawn ??= require('cross-spawn');

export function spawn(command, args = [], options = {}) {
  if (process.platform !== 'win32') return nativeSpawn(command, args, options);
  const spec = commandSpec(command, args, options.env);
  return crossSpawn()(spec.command, spec.args, { windowsHide: true, ...options });
}
export function spawnSync(command, args = [], options = {}) {
  if (process.platform !== 'win32') return nativeSpawnSync(command, args, options);
  const spec = commandSpec(command, args, options.env);
  return crossSpawn().sync(spec.command, spec.args, { windowsHide: true, ...options });
}
