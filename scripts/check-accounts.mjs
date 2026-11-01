// End-to-end check of accounts and sharing against a real Papilot server: the
// owner invites someone from the host, who joins at the public URL with a
// passkey (Chrome's virtual authenticator), sees only the shared paper, signs
// out and back in, and loses access when unshared and removed.
// Run with: node --import tsx scripts/check-accounts.mjs (after npm run build).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '../vendor/latex-review/node_modules/@playwright/test/index.mjs';
import { stop } from '../vendor/latex-review/src/client.ts';

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const [port, accountPort] = [await freePort(), await freePort()];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-accounts-'));
const local = `http://127.0.0.1:${port}`, publicOrigin = `http://localhost:${accountPort}`;
const papers = ['Thesis', 'Grant'].map(name => {
  const folder = path.join(root, name.toLowerCase());
  fs.mkdirSync(folder);
  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) git('config', key, value);
  fs.writeFileSync(path.join(folder, 'main.tex'), `\\documentclass{article}\\begin{document}${name}\\end{document}\n`);
  git('add', '.'); git('commit', '-qm', 'Start');
  return { name, folder };
});

// No agent can run here, so tasks stay queued and nothing edits the papers.
const env = { ...process.env, PAPILOT_DATA: path.join(root, 'data'), PAPILOT_PORT: String(port), PAPILOT_ACCOUNT_PORT: String(accountPort), PAPILOT_ACCOUNT_ORIGIN: publicOrigin, PAPILOT_CODEX_BIN: path.join(root, 'no-codex'), PAPILOT_AGY_BIN: path.join(root, 'no-agy'), PAPILOT_KIMI_BIN: path.join(root, 'no-kimi'), PAPILOT_COPILOT_BIN: path.join(root, 'no-copilot'), PAPILOT_GROK_BIN: path.join(root, 'no-grok'), PAPILOT_QWEN_BIN: path.join(root, 'no-qwen'), PAPILOT_DSH_BIN: path.join(root, 'no-dsh'), PAPILOT_OPENCODE_BIN: path.join(root, 'no-opencode'), CURSOR_API_KEY: '', ZHIPU_API_KEY: '', ZAI_API_KEY: '', PAPILOT_PUBLIC_ORIGIN: '', PAPILOT_TAILSCALE_LOGIN: '' };
for (const key of Object.keys(env)) if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) delete env[key];
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
for (let i = 0; !output.includes('Papilot is running'); i++) { if (i > 300 || server.exitCode !== null) throw new Error('Papilot did not start:\n' + output); await new Promise(r => setTimeout(r, 100)); }

const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const errors = [];
const pass = label => console.log('PASS: ' + label);
try {
  // The owner, on the host, adds both papers and opens Sharing.
  const ownerContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const owner = await ownerContext.newPage(); owner.on('pageerror', e => errors.push('owner: ' + e.message));
  await owner.goto(local);
  const csrf = (await (await fetch(local + '/api/state')).json()).csrf;
  const ids = [];
  for (const paper of papers) {
    const response = await fetch(local + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Papilot-Token': csrf }, body: JSON.stringify({ path: paper.folder, name: paper.name }) });
    assert.equal(response.status, 200, await response.clone().text());
    ids.push((await response.json()).id);
  }
  await owner.reload();
  await owner.getByRole('button', { name: 'Settings', exact: true }).click();
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const people = owner.getByRole('dialog', { name: 'Sharing' });
  await expect(owner.locator('.sidebar-footer button')).toHaveCount(1);
  await expect(owner.locator('dialog[open]')).toHaveCount(1);
  await people.getByRole('button', { name: 'General', exact: true }).click();
  const ownerSettings = owner.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(ownerSettings.getByRole('heading', { name: 'General', exact: true })).toBeFocused();
  await ownerSettings.getByRole('button', { name: 'Sharing', exact: true }).click();
  await expect(people.getByRole('heading', { name: 'Sharing is not sandboxed', exact: true })).toBeVisible();
  await people.getByLabel('Invite someone').fill('Ada');
  await people.getByRole('group', { name: 'Papers they can open' }).getByLabel('Thesis').check();
  await people.getByRole('button', { name: 'General', exact: true }).click();
  await ownerSettings.getByRole('button', { name: 'Sharing', exact: true }).click();
  await expect(people.getByLabel('Invite someone')).toHaveValue('Ada');
  await expect(people.getByRole('group', { name: 'Papers they can open' }).getByLabel('Thesis')).toBeChecked();
  await people.getByRole('button', { name: 'Create invite link' }).click();
  const link = await people.getByLabel('Invite link for Ada').inputValue();
  assert.match(link, new RegExp(`^${publicOrigin}/invite#[\\w-]{43}$`));
  await expect(people.getByText('Invited, not joined yet')).toBeVisible();
  await people.getByRole('button', { name: 'Appearance', exact: true }).click();
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  await expect(people.getByLabel('Invite link for Ada')).toHaveValue(link);
  await expect(owner.locator('dialog[open]')).toHaveCount(1);
  await owner.screenshot({ path: 'test-results/settings-people-desktop.png' });
  await owner.setViewportSize({ width: 390, height: 844 });
  assert.equal(await people.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await owner.screenshot({ path: 'test-results/settings-people-mobile.png' });
  await people.getByRole('button', { name: 'Settings', exact: true }).click();
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  await expect(people.getByLabel('Invite link for Ada')).toHaveValue(link);
  await owner.setViewportSize({ width: 1280, height: 900 });
  pass('Sharing stays inside Settings; invite drafts and one-time links survive category navigation on desktop and mobile');

  // Ada opens the link at the public URL and creates a passkey.
  const adaContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const ada = await adaContext.newPage(); ada.on('pageerror', e => errors.push('ada: ' + e.message));
  const cdp = await adaContext.newCDPSession(ada);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  // The link is clicked on another site, as in a web mail.
  await ada.goto(local + '/api/health');
  await ada.evaluate(href => { const a = document.createElement('a'); a.href = href; a.textContent = 'Join the paper'; document.body.append(a); }, link);
  await ada.getByRole('link', { name: 'Join the paper' }).click();
  await expect(ada.getByRole('heading', { name: 'Join Papilot' })).toBeVisible();
  await expect(ada.getByText(/invited you to work on Thesis\. You will appear as Ada\./)).toBeVisible();
  assert.equal(new URL(ada.url()).hash, '', 'the token leaves the address bar at once');
  await ada.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(ada.getByRole('button', { name: 'Paper: Thesis', exact: true })).toBeVisible();
  assert.equal(new URL(ada.url()).pathname, '/');
  const cookies = await adaContext.cookies();
  assert.ok(cookies.some(c => c.name === '__Host-papilot-session' && c.httpOnly && c.secure && c.sameSite === 'Strict'), JSON.stringify(cookies));
  pass('An invite clicked on another site creates a passkey and signs in with a Secure, HttpOnly, SameSite=Strict session');

  await ada.getByRole('button', { name: 'Paper: Thesis', exact: true }).click();
  await expect(ada.getByRole('menuitemradio')).toHaveCount(1);
  await expect(ada.getByText('Add paper…')).toHaveCount(0);
  await ada.keyboard.press('Escape');
  await expect(ada.locator('.sidebar-footer button')).toHaveCount(1);
  await ada.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(ada.getByRole('button', { name: 'Sharing' })).toHaveCount(0);
  await ada.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  const hidden = await ada.evaluate(async id => (await fetch(`/api/projects/${id}/git`)).status, ids[1]);
  assert.equal(hidden, 400, 'another paper answers like a missing one');
  const added = await ada.evaluate(async () => (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  assert.equal(added, 403);
  pass('Ada sees only Thesis, cannot add papers, and the other paper stays hidden');

  // Ada starts a task; her message carries her name for the owner.
  await ada.getByLabel('Describe the revision').fill('Tighten the abstract.');
  await ada.keyboard.press('Enter');
  await ada.getByRole('button', { name: /Tighten the abstract/ }).first().click();
  await expect(ada.getByRole('article', { name: /^You, / })).toContainText('Tighten the abstract.');
  await owner.reload();
  await owner.getByRole('button', { name: /^Paper: / }).click();
  await owner.getByRole('menuitemradio', { name: /Thesis/ }).click();
  await owner.getByRole('button', { name: /Tighten the abstract/ }).first().click();
  await expect(owner.getByRole('article', { name: /^Ada, / })).toContainText('Tighten the abstract.');
  pass('Messages show who wrote them: "You" for Ada, "Ada" for the owner');

  // Signing out clears the session; the passkey signs back in.
  await ada.getByRole('button', { name: 'Settings', exact: true }).click();
  await ada.getByRole('button', { name: /Sign out/ }).click();
  await expect(ada.getByRole('heading', { name: 'Sign in to Papilot' })).toBeVisible();
  assert.equal((await adaContext.cookies()).filter(c => c.name === '__Host-papilot-session').length, 0);
  await ada.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(ada.getByRole('button', { name: 'Paper: Thesis', exact: true })).toBeVisible();
  pass('Sign out, then sign in again with the passkey');

  // The owner unshares Thesis; Ada's open tab follows, then removal signs her out.
  await owner.getByRole('button', { name: 'Settings', exact: true }).click();
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  await people.getByRole('group', { name: 'Papers Ada can open' }).getByLabel('Thesis').uncheck();
  await expect(ada.getByRole('heading', { name: 'No papers yet' })).toBeVisible({ timeout: 15000 });
  await people.getByRole('button', { name: 'Remove…' }).click();
  await people.getByRole('button', { name: 'Remove Ada' }).click();
  await expect(people.getByText('Ada', { exact: true })).toHaveCount(0);
  await expect(ada.getByRole('heading', { name: 'Sign in to Papilot' })).toBeVisible({ timeout: 15000 });
  await ada.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(ada.getByRole('alert')).toContainText('could not sign you in');
  pass('Unsharing reaches the open tab, and a removed person is signed out and cannot sign in');

  assert.deepEqual(errors, []);
  pass('No uncaught browser errors');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  for (const paper of papers) await stop(paper.folder, true).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
