import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../engine/node_modules/@playwright/test/index.mjs';
import { selectOption } from './select.mjs';

// Skills in the composers, review feedback and skills in the chat, and the
// feedback bar after a review, against simulated workspace data.
const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const skills = [
  { id: 'polish', name: 'Polish', description: 'Improve clarity and flow, keeping the meaning', hint: 'Which part?', source: 'builtin' },
  { id: 'proofread', name: 'Proofread', description: 'Fix typos, grammar and punctuation without rewording', hint: 'Which part? Leave empty for the whole paper', source: 'builtin' },
  { id: 'venue', name: 'Venue style', description: 'Follow the venue style guide', hint: '', icon: 'book', source: 'paper' },
];
const task = { id: 'skill-fixture-0001', projectId: 'paper', name: 'p-skill', title: 'Polish: the introduction', instructions: 'x', worktree: '/tmp/paper-tasks/p-skill', threadId: 't', turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null,
  review: { state: 'done', round: 2, counts: { pending: 0, accepted: 2, rejected: 1, commented: 0 }, unsent: 3, comments: 0, files: ['sections/intro.tex'] } };
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper', createdAt: 1 }], tasks: [task], requests: [], runtime: { connected: true, authenticated: true, account: null, error: null, models: [] } };
const git = { remote: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, head: { hash: 'abc1234', subject: 'Draft', date: 1 }, files: [{ path: 'sections/intro.tex', status: 'M', staged: false, lines: [3, 2] }] };
const items = [
  { id: 'u1', taskId: task.id, type: 'user', text: 'the introduction', meta: { skill: { id: 'polish', name: 'Polish', icon: 'pen' } }, createdAt: 1 },
  { id: 'a1', taskId: task.id, type: 'assistant', text: 'Rewrote the opening so that $f(x) = \\sum_i x_i$ is defined first.', createdAt: 2 },
  { id: 'u2', taskId: task.id, type: 'user', text: '', meta: { sendsFeedback: true, feedback: { round: 1, accepted: 2, rejected: 1, undone: 0, comments: [{ where: 'sections/intro.tex:12', text: 'Keep the citation here.' }] } }, createdAt: 3 },
  { id: 'u3', taskId: task.id, type: 'user', text: 'Address the comments from this review round. Preserve accepted changes and do not reintroduce rejected edits.', createdAt: 4 },
];
const creates = [], messages = [];
let annotations = [], failCreate = false;
const taskItems = new Map();
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/updates') return route.fulfill({ json: { currentVersion: snapshot.version, latestVersion: null, phase: 'idle', checkedAt: 1, error: null, canUpdate: true } });
  if (url.pathname === '/api/state') return json(snapshot);
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (url.pathname.endsWith('/skills')) return json({ skills });
  if (url.pathname.endsWith('/archive')) {
    const saved = snapshot.tasks.find(task => task.id === url.pathname.split('/')[3]);
    if (saved) saved.archivedAt = route.request().postDataJSON().archived ? Date.now() : null;
    return json(saved);
  }
  if (url.pathname.endsWith('/items')) return json({ items: taskItems.get(url.pathname.split('/')[3]) || items });
  if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
  if (url.pathname.endsWith('/git')) return json(git);
  // A finished review writes its commit message as soon as it opens.
  if (url.pathname.endsWith('/git/message') || url.pathname.endsWith('/commit-message')) return json({ message: 'Polish the introduction', agent: 'codex' });
  if (url.pathname.endsWith('/manuscript')) return json({ git, build: { status: 'ready', key: 'fixture', pages: [[612, 792], [612, 792]], builtAt: 1 }, annotations });
  if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
  if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
  if (url.pathname === '/api/tasks') {
    const body = route.request().postDataJSON(); creates.push(body);
    if (failCreate) return route.fulfill({ status: 503, json: { error: 'Connection lost. Try again.' } });
    const created = { ...task, id: body.id, title: body.title, review: null, status: 'queued', archivedAt: null };
    const attached = annotations.filter(note => body.annotations?.includes(note.id));
    if (attached.length) {
      taskItems.set(body.id, [{ id: 'combined', taskId: body.id, type: 'user', text: body.instructions, createdAt: 1, meta: { skill: skills.find(skill => skill.id === body.skill), notes: attached.map(note => ({ where: `Page ${note.page + 1}`, quote: note.quote, comment: note.comment })) } }]);
      annotations = annotations.filter(note => !body.annotations.includes(note.id));
    }
    snapshot.tasks.push(created); return json(created);
  }
  if (url.pathname.endsWith('/messages')) { messages.push(route.request().postDataJSON()); return json({ ok: true }); }
  if (url.pathname.endsWith('/archive')) {
    const target = snapshot.tasks.find(item => item.id === url.pathname.split('/')[3]);
    target.archivedAt = route.request().postDataJSON().archived ? Date.now() : null;
    return json(target);
  }
  throw new Error(`Unexpected app request ${url.pathname}`);
});
await page.route('**/review/**', route => route.fulfill({ contentType: 'text/html', body: '<html lang="en"><head></head><body><div class="bar">Review round 2</div><main id="paper"><p>PDF review fixture</p></main></body></html>' }));
const sync = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
try {
  await page.goto(origin);
  // The chat shows the skill, typeset mathematics and feedback, never the prompts.
  const chat = page.locator('.thread');
  await expect(chat.locator('.message.user').first().locator('.skill-chip')).toHaveText('Polish');
  await expect(chat.locator('.message.user').first().locator('.skill-chip')).toHaveAttribute('data-skill-icon', 'pen');
  await expect(chat.locator('.katex').first()).toBeVisible();
  await expect(chat.getByText('Review feedback', { exact: true }).first()).toBeVisible();
  await expect(chat.locator('.feedback-counts').first()).toHaveText('2 accepted1 rejected1 comment');
  await expect(chat.getByText('Keep the citation here.')).toBeVisible();
  await expect(chat.getByText(/Address the comments/)).toHaveCount(0);
  await expect(chat.locator('.notes-message')).toHaveCount(2);

  // A finished review that accepted changes needs nothing more: they are in
  // the manuscript, and the decisions reach the agent with the next message.
  await expect(page.locator('.task-row.active .status')).toHaveText('Review complete');
  await expect(page.getByRole('button', { name: 'Send feedback', exact: true })).toHaveCount(0);
  await expect(page.locator('.review-feedback')).toHaveCount(0);
  // Comments go back to the agent; in the chat-only view the bar ends the conversation.
  task.review = { ...task.review, unsent: 4, comments: 1 }; await sync();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.thread .review-feedback.card:not(.commit-card)')).toContainText('4 review updates not sent yet');
  // The accepted change is in the manuscript; committing it is offered, not required.
  const commitCard = page.locator('.thread .commit-card');
  await expect(commitCard.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue('Polish the introduction');
  await expect(commitCard.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect.poll(() => messages.length).toBe(1);
  assert.equal(messages[0].feedback, true);
  task.review = { ...task.review, unsent: 0, comments: 0 }; await sync();

  // "/" lists skills in the follow-up composer; the chosen one runs without text.
  const followUp = page.getByRole('textbox', { name: 'Instructions for Codex' });
  await expect(page.getByRole('button', { name: 'Add files or skills', exact: true })).toBeVisible();
  await followUp.fill('/');
  await expect(page.getByRole('option')).toHaveCount(3);
  await followUp.press('ArrowDown');
  await expect(page.getByRole('option', { name: /Proofread/ })).toHaveAttribute('aria-selected', 'true');
  await followUp.press('Enter');
  await expect(page.locator('.composer-skill .skill-chip')).toContainText('Proofread');
  await expect(followUp).toHaveValue('');
  await expect(followUp).toHaveAttribute('placeholder', 'Details (optional)');
  await followUp.press('Backspace');
  await expect(page.locator('.composer-skill')).toHaveCount(0);
  await followUp.fill('/ven');
  await expect(page.getByRole('option')).toHaveText([/Venue style.*This paper/]);
  await expect(page.getByRole('option').locator('.skill-name')).toHaveAttribute('data-skill-icon', 'book');
  await followUp.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await followUp.fill('/venue');
  await followUp.press('Tab');
  await expect(page.locator('.composer-skill .skill-chip')).toHaveAttribute('data-skill-icon', 'book');
  await page.getByRole('button', { name: 'Send instructions' }).click();
  await expect.poll(() => messages.length).toBe(2);
  assert.equal(messages[1].skill, 'venue'); assert.equal(messages[1].text, '');
  await expect(page.locator('.composer-skill')).toHaveCount(0);

  // The new-task panel beside the PDF starts from a suggested skill.
  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  await page.getByRole('button', { name: 'Add files or skills', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Proofread', exact: true }).click();
  await expect(page.locator('.composer-skill .skill-chip')).toContainText('Proofread');
  await page.keyboard.type('Section 2 only.');
  await page.screenshot({ path: 'test-results/skill-new-task.png' });
  await page.keyboard.press('Enter');
  await expect.poll(() => creates.length).toBe(1);
  assert.equal(creates[0].skill, 'proofread'); assert.equal(creates[0].instructions, 'Section 2 only.'); assert.equal(creates[0].title, 'Proofread: Section 2 only');
  const firstCreated = page.locator(`[data-task="${creates[0].id}"]`);
  await expect(firstCreated).toBeVisible();
  await expect(firstCreated).toHaveClass(/task-added/);
  assert.match(await firstCreated.evaluate(el => getComputedStyle(el).animationName), /task-land/);
  await expect(page.getByRole('heading', { name: 'Manuscript', exact: true })).toHaveCount(1);
  await expect(page.locator('.task-link.active')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Describe the revision', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Describe the revision', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/task-added-desktop.png' });

  // Notes, a skill and the overall request share one draft and survive a failure.
  annotations = [
    { id: 'draft-note-1', projectId: 'paper', key: 'fixture', page: 0, rect: [0.1, 0.1, 0.4, 0.2], quote: 'The introduction.', comment: 'Make this clearer.', source: null, createdAt: 1 },
    { id: 'draft-note-2', projectId: 'paper', key: 'fixture', page: 1, rect: [0.1, 0.1, 0.4, 0.2], quote: '', comment: 'Explain this diagram.', source: null, createdAt: 2 },
  ];
  await page.locator('.manuscript-link').click();
  await page.getByRole('tab', { name: 'New task', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('region', { name: 'Notes in this task', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('button', { name: 'Select all notes for this task', exact: true }).click();
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toHaveCount(0);
  const draft = page.getByRole('textbox', { name: 'Describe the revision', exact: true });
  await expect(draft).toHaveAttribute('placeholder', 'Add overall instructions (optional)');
  await page.getByRole('button', { name: 'Show note 2 on the page' }).click();
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await draft.fill('/pol'); await draft.press('Enter');
  await draft.fill('Keep all technical terms.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await selectOption(page.getByRole('dialog', { name: 'Settings' }).getByRole('combobox', { name: 'Language' }), 'zh-Hans');
  await page.keyboard.press('Escape');
  await expect(page.getByText('已加入任务：2 条', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/merged-task-notes.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await expect(page.getByText('已加入任务：2 条', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始任务', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/merged-task-notes-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await selectOption(page.getByRole('dialog', { name: '设置' }).getByRole('combobox', { name: '语言' }), 'en');
  await page.keyboard.press('Escape');
  failCreate = true;
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.getByText('Connection lost. Try again.', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('Keep all technical terms.');
  await expect(page.locator('.composer-skill .skill-chip')).toHaveText('Polish');
  await expect(page.getByText('Added to task: 2', { exact: true })).toBeVisible();
  failCreate = false;
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => creates.length).toBe(3);
  assert.equal(creates[1].id, creates[2].id);
  assert.deepEqual(creates[2].annotations, ['draft-note-1', 'draft-note-2']);
  assert.equal(creates[2].skill, 'polish');
  assert.equal(creates[2].instructions, 'Keep all technical terms.');
  await expect(draft).toHaveValue('');
  await expect(draft).toBeFocused();
  await expect(page.locator('.note-list li')).toHaveCount(0);
  await expect(page.locator('.composer-skill')).toHaveCount(0);
  await expect(page.locator('.review-frame')).toHaveCount(0);
  await page.locator(`[data-task="${creates[2].id}"] .task-link`).click();
  await expect(page.locator('.thread .notes-request')).toHaveText('Keep all technical terms.');
  await expect(page.locator('.thread .notes-message .skill-chip')).toHaveText('Polish');
  await expect(page.locator('.thread .sent-notes li')).toHaveCount(2);
  await page.locator('.manuscript-link').click();
  await expect(page.locator('.note-list li')).toHaveCount(0);
  await expect(draft).toHaveValue('');
  await expect(page.locator('.composer-skill')).toHaveCount(0);
  // Consecutive mobile submissions keep the composer and drawer in place.
  await page.setViewportSize({ width: 390, height: 844 });
  await draft.fill('Check notation.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => creates.length).toBe(4);
  await expect(draft).toHaveValue('');
  await expect(draft).toBeFocused();
  await expect(page.locator('.task-added-dot')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await page.locator('.main').evaluate(el => el.inert), false);
  await expect(page.locator('.sidebar')).not.toHaveClass(/is-open/);
  await expect(page.locator('.review-frame')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/task-added-mobile.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await draft.fill('Check citations.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => creates.length).toBe(5);
  await expect(draft).toHaveValue('');
  await expect(draft).toBeFocused();
  assert.notEqual(creates[3].id, creates[4].id);
  const lastCreated = page.locator(`[data-task="${creates[4].id}"]`);
  await expect(lastCreated).toHaveClass(/task-added/);
  assert.equal(await lastCreated.evaluate(el => getComputedStyle(el).animationName), 'none');
  await expect(page.locator('.task-link.active')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show task list', exact: true }).click();
  await expect(lastCreated).toBeInViewport();
  await lastCreated.locator('.task-link').click();
  await expect(page.getByRole('heading', { name: 'Check citations', exact: true })).toHaveCount(1);
  assert.deepEqual(errors, []);
  console.log('PASS: Skills, feedback and math; merged notes/skill/request draft on desktop and mobile, failure/retry, and combined chat history');
} finally { await browser.close(); await server.close(); }
