import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { responseSchema } from './translate.ts';

export function decodeAgyResponse(stdout: string): unknown {
  const result = JSON.parse(stdout);
  if (result.status !== 'SUCCESS') throw new Error(result.error || `agy returned ${result.status || 'no status'}`);
  if (result.denied_actions?.length) throw new Error('agy attempted a tool action instead of translating.');
  const response = result.response;
  if (typeof response === 'object' && response !== null) return response;
  if (typeof response !== 'string') throw new Error('agy returned no translation response.');
  // Accept a single JSON code fence, but never try to salvage surrounding prose.
  return JSON.parse(response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
}

export async function translateWithAgy(prompt: string, count: number, model: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-i18n-'));
  const proxy = process.env.PAPILOT_AGY_PROXY;
  const env = proxy ? { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost' } : process.env;
  try {
    const { stdout } = await promisify(execFile)(process.env.PAPILOT_AGY_BIN || 'agy', [
      '-p', prompt, '--model', model, '--mode', 'plan', '--output-format', 'json',
      '--json-schema', JSON.stringify(responseSchema(count)), '--print-timeout', '300s',
    ], { cwd, env, timeout: 315_000, maxBuffer: 4 * 1024 * 1024 });
    return decodeAgyResponse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid translation JSON: ${error.message}`);
    const failure = error as Error & { stdout?: string; stderr?: string };
    let detail = failure.stderr?.trim().split('\n').find(line => line.startsWith('error:')) || failure.message.split('\n')[0];
    if (failure.stdout) {
      try { const result = JSON.parse(failure.stdout); if (typeof result.error === 'string' && result.error) detail = result.error; } catch { /* Keep the process error. */ }
    }
    if (detail.includes('location is not supported')) detail += ' Set PAPILOT_AGY_PROXY to your configured HTTP proxy and retry.';
    // execFile's default error includes its full prompt; avoid dumping that into logs.
    if (detail.startsWith('Command failed:')) detail = 'agy failed to return translations. Check agy authentication, model access, and network connectivity.';
    throw new Error(detail);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
