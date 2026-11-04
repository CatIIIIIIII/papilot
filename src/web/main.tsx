import { canonicalGroup, groupsWithoutInstructions, noteGroups, type NoteGroup } from '../note-groups.ts';
import { GroupCard, GroupInstruction } from './note-groups.tsx';
import { useNoteSelection } from './note-selection.tsx';
import { useGroupInstructions } from './group-instructions.ts';
import { NoteQuote } from './note-content.tsx';
import { NoteAttachButton, PdfNoteCard } from './pdf-suggestion.tsx';
import { StrictMode, Suspense, createContext, lazy, memo, useCallback, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { readNotesInstructions, type NoteSummary } from '../notes.ts';
import { aiReviewSummary, isFeedbackPrompt } from '../conversation.ts';
import { ignorePattern } from '../commit.ts';
import { AGENT_IDS, AGENT_NAMES, isAgentId, taskFinished } from '../shared.ts';
import type { TaskCommitReview, LatexInstallation, AgentId, Annotation, Author, FeedbackSummary, GitDiff, GitFile, GitOverview, GitStatus, Manuscript, ManuscriptProblems, PendingRequest, Project, RuntimeStatus, Skill, Snapshot, Task, TimelineItem, Viewer } from '../shared.ts';
import { SkillChip, SkillMenu, SkillPicker, matchSkills, skillName, skillQuery } from './skills.tsx';
import { ComposerDraft, sendsMessage, taskTitle, unsentReviewFeedback } from './composer.ts';
import { DraftAttachments, MessageAttachments, useAttachmentDraft } from './attachments.tsx';
import { type AttachmentDraft, type UploadAttachment } from './attachment-draft.ts';
import type { Attachment } from '../shared.ts';
import { noteLocation } from './note-location.ts';
import { ReadRequest, canStreamUpdates, mergeTimeline } from './refresh.ts';
import { browserStorage } from './storage.ts';
import { readPlace, savePlace } from './places.ts';
import { ModeSwitch, type PdfMode } from './mode-switch.tsx';
import { ReviewFrame, reviewUrl } from './review-frame.tsx';
import { AiReviewView } from './ai-review.tsx';
import { keepDialogFocus } from './focus.ts';
import { DeleteTaskDialog } from './task-dialog.tsx';
import { ActionMenu } from './action-menu.tsx';
import { Icon } from './icons.tsx';
import { UpdateNotice, versionLabel } from './update-notice.tsx';
import { chooseDirectory, DesktopWindowChrome, nativeFolders } from './desktop-chrome.tsx';
import { MainFileDialog } from './main-file-dialog.tsx';
import { PaperDialog } from './paper-dialog.tsx';
import { ImportDialog } from './import-dialog.tsx';
import { CompileButton } from './compile-button.tsx';
import { ProblemsButton, fixRequest, type ProblemsHandle } from './build-problems.tsx';
import { useTheme } from './theme.tsx';
import { SettingsDialog } from './settings.tsx';
import type { DiagnosticReport } from '../shared.ts';
import { CommitDialog } from './commit-dialog.tsx';
import { TaskCommit } from './task-commit.tsx';
import { TaskCommitDraft } from './task-commit-draft.ts';
import { TaskConflict } from './task-conflict.tsx';
import { TaskApply } from './task-apply.tsx';
import { TaskApplyState } from './task-apply-state.ts';
import { taskSaveStatus } from './task-save-status.ts';
import { TaskSaved } from './task-saved.tsx';
import { GitPane, GitRepository, usePane } from './git-overview.tsx';
import { problemCount, ReferencesPanel, useBibliography } from './references-panel.tsx';
import { Invite, SignIn } from './sign-in.tsx';
import { forgetBrowserState, isSignedOut, setSignedOut, useSignedOut } from './session.ts';
import { errorText, locale, t, tn, useLanguage } from './i18n.ts';
import { notificationState, notify, notifying, subscribeNotifications, taskAlerts } from './notifications.ts';
import { Markdown } from './markdown.tsx';
import logo from './logo.svg';
import { AgentConnectionNotice, AgentPicker } from './agent-picker.tsx';
import { taskEffort } from './task-effort.ts';
import { TaskModelPicker } from './task-model-picker.tsx';
import { TaskFlight, type TaskFlightData } from './task-flight.tsx';
import { returnNotes } from './note-flight.ts';
import { UsageSummary } from './usage.tsx';
import { useNoteUndo } from './use-note-undo.ts';
import { NoteResultsProvider, NoteResultLinks, useNoteResults } from './note-results.tsx';
import { usePanelWidth } from './panel-width.tsx';
import type { OutlineItem, PdfHandle, Rect } from './pdf-view.tsx';
// pdf.js is large, so the PDF view loads the first time it opens.
const PdfView = lazy(() => import('./pdf-view.tsx').then(module => ({ default: module.PdfView })));
import './style.css';
import './note-controls.css';

let token = '';
const uuid = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2, '0')).join('');
async function api<T = any>(route: string, body?: unknown, signal?: AbortSignal, wait = body === undefined ? 15000 : 30000): Promise<T> {
  const timeout = AbortSignal.timeout(wait);
  try { const response = await fetch('/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': body instanceof File ? 'application/octet-stream' : 'application/json', 'X-Papilot-Token': token, ...(body instanceof File ? { 'X-Papilot-Filename': encodeURIComponent(body.name) } : {}) }, ...(body === undefined ? {} : { body: body instanceof File ? body : JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    // At the public URL, a lapsed or revoked session shows the sign-in page.
    if (response.status === 401 && (!route.startsWith('/auth/') || route === '/auth/logout')) { setSignedOut(true); throw new Error(t('Sign in to continue.')); }
    const value = await response.json(); if (!response.ok) throw new Error(value.error ? errorText(value.error) : t('Request failed. Please try again.')); return value;
  }
  catch (error) {
    if (timeout.aborted) throw new Error(body === undefined ? t('The connection is taking too long. Check your network and try again.') : t('The request timed out and may still be processing. Check the task status before retrying.'));
    throw error;
  }
}
const uploadAttachment = (projectId: string, file: File, signal: AbortSignal) => api<Attachment>(`/projects/${projectId}/attachments`, file, signal, 120000);
const detectLatexInstallation = (signal: AbortSignal) => api<LatexInstallation | null>('/runtime/latex', undefined, signal, 30000);
const checkDiagnostics = (projectId: string | undefined, signal: AbortSignal) => api<DiagnosticReport>('/diagnostics', { projectId }, signal, 60000);
const AGENT_LABELS = AGENT_NAMES;
const agentName = (task: Task) => AGENT_LABELS[task.agent || 'codex'] || 'Codex';
// A finished publication with no round is a valid answer-only result. Keep
// earlier comparisons available when a follow-up answer makes no new edits.
const noManuscriptChanges = (task: Task) => task.status === 'reviewing' && task.review?.round === null && task.review.state !== 'build_failed' && !task.review.counts.pending;
const statusNames = (): Record<string, string> => ({ idle: t('Ready'), queued: t('Queued'), waiting_input: t('Needs your reply'), building: t('Preparing task results'), reviewing: t('Ready for review'), interrupted: t('Paused'), failed: t('Needs attention'), uncertain: t('Check task status'), deleting: t('Deleting task') });
const ACTIVE = ['running', 'waiting_input', 'queued'];
function Status({ task }: { task: Task }) {
  const answered = noManuscriptChanges(task), done = task.status === 'reviewing' && task.review?.state === 'done';
  const saved = taskSaveStatus(task);
  return <span className={`status ${task.status}${done || answered ? ' done' : ''}`}><i/>{saved === 'pushed' ? t('Committed and pushed') : saved === 'committed' ? t('Committed') : saved === 'applied' ? t('Applied to manuscript') : answered ? t('Completed') : done ? t('Review complete') : task.status === 'running' ? t('{agent} is working', { agent: agentName(task) }) : statusNames()[task.status] || task.status}</span>;
}
function time(timestamp: number) { return new Date(timestamp).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); }
function ago(timestamp: number) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return t('now'); if (minutes < 60) return t('{n}m', { n: minutes });
  if (minutes < 1440) return t('{n}h', { n: Math.floor(minutes / 60) }); if (minutes < 10080) return t('{n}d', { n: Math.floor(minutes / 1440) });
  return new Date(timestamp).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}
// "5m ago", or "just now".
const agoText = (timestamp: number) => Date.now() - timestamp < 60000 ? t('just now') : t('{time} ago', { time: ago(timestamp) });
const touch = () => window.matchMedia('(pointer: coarse)').matches;
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query), change = () => setMatches(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, [query]);
  return matches;
}

// One composer for new tasks and follow-ups: grows with its text, sends on
// Enter (see sendsMessage), and keeps its actions inside the same surface.
// With skills, "/" opens the skill menu; the chosen skill sits above the text
// as a chip, the text becomes optional, and Backspace in an empty box removes it.
function Composer({ label, value, placeholder, onChange, onSubmit, readOnly, autoFocus, inputRef, footer, action, large, skills, skill, onSkill, attachments, upload, filesDisabled, imageHint }: { label: string; value: string; placeholder: string; onChange: (value: string) => void; onSubmit: () => void; readOnly?: boolean; autoFocus?: boolean; inputRef?: React.RefObject<HTMLTextAreaElement | null>; footer: React.ReactNode | ((attach: () => void) => React.ReactNode); action: React.ReactNode; attachments?: AttachmentDraft; upload?: UploadAttachment; filesDisabled?: boolean; imageHint?: boolean; large?: boolean; skills?: Skill[]; skill?: Skill | null; onSkill?: (skill: Skill | null) => void }) {
  const fallback = useRef<HTMLTextAreaElement>(null), input = inputRef || fallback;
  const fileInput = useRef<HTMLInputElement>(null), dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const canAttach = Boolean(attachments && upload && !readOnly && !filesDisabled);
  function addFiles(files: File[]) { if (canAttach && files.length) { void attachments!.add(files, upload!); input.current?.focus(); } }
  const menuId = useId(), [dismissed, setDismissed] = useState<string | null>(null), [active, setActive] = useState(0);
  const query = skills?.length && onSkill && !readOnly ? skillQuery(value) : null;
  const open = query !== null && dismissed !== value, matches = open ? matchSkills(skills!, query) : [];
  useEffect(() => setActive(0), [query]);
  // Escape closes the menu until the text changes.
  useEffect(() => { if (dismissed !== null && value !== dismissed) setDismissed(null); }, [value, dismissed]);
  useLayoutEffect(() => { const element = input.current; if (!element) return; element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`; }, [input, value]);
  useEffect(() => { if (autoFocus && !touch()) input.current?.focus(); }, [autoFocus, input]);
  function pick(chosen: Skill) { onSkill?.(chosen); onChange(''); input.current?.focus(); }
  function keyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length) { e.preventDefault(); setActive(index => (index + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && matches.length) { e.preventDefault(); pick(matches[Math.min(active, matches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(value); return; }
    }
    if (e.key === 'Backspace' && skill && onSkill && !value && !readOnly) { e.preventDefault(); onSkill(null); return; }
    if (sendsMessage(e.nativeEvent, touch())) { e.preventDefault(); onSubmit(); }
  }
  return <form className={'composer' + (large ? ' large' : '') + (dragging ? ' dragging' : '')}
    onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); if (canAttach && ++dragDepth.current === 1) setDragging(true); }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'; } }}
    onDragLeave={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}
    onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); addFiles(files); const text = event.clipboardData.getData('text/plain'); if (canAttach && text && input.current) { const area = input.current; onChange(value.slice(0, area.selectionStart) + text + value.slice(area.selectionEnd)); } } }}
    onSubmit={e => { e.preventDefault(); onSubmit(); }} onPointerDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
    {attachments && upload && <><input ref={fileInput} type="file" multiple hidden aria-label={t('Choose attachments')} disabled={!canAttach} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }}/><DraftAttachments draft={attachments} upload={upload} discard={file => { void api(`/projects/${file.projectId}/attachments/${file.id}/discard`, {}).catch(() => {}); }} disabled={readOnly || filesDisabled}/></>}
    {dragging && <div className="attachment-drop-hint">{t('Drop files to attach')}</div>}
    {imageHint && <p className="attachment-agent-hint">{t('Antigravity opens images through its file tools. For direct image input, choose Codex or Claude.')}</p>}
    {open && <SkillMenu id={menuId} skills={matches} active={active} onActive={setActive} onPick={pick}/>}
    {skill && <div className="composer-skill"><SkillChip skill={skill} onRemove={onSkill && !readOnly ? () => { onSkill(null); input.current?.focus(); } : undefined}/></div>}
    <textarea ref={input} rows={1} aria-label={label} maxLength={20000} placeholder={skill ? (skill.source !== 'builtin' && skill.hint) || t('Details (optional)') : placeholder} value={value} readOnly={readOnly} onChange={e => onChange(e.target.value)} onKeyDown={keyDown}
      {...(onSkill && skills?.length ? { 'aria-autocomplete': 'list' as const, 'aria-controls': open ? menuId : undefined, 'aria-activedescendant': open && matches.length ? `${menuId}-${Math.min(active, matches.length - 1)}` : undefined } : {})}/>
    <div className="composer-footer">{typeof footer === 'function' ? footer(() => fileInput.current?.click()) : footer}{action}</div>
  </form>;
}

function RequestCard({ request, agent, answerDrafts, onDone }: { request: PendingRequest; agent: string; answerDrafts: Map<string, Record<string, string>>; onDone: () => void }) {
  const [answers, updateAnswers] = useState<Record<string, string>>(() => answerDrafts.get(request.id) || {});
  function setAnswers(next: Record<string, string>) { answerDrafts.set(request.id, next); updateAnswers(next); }
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const questions = request.method.endsWith('requestUserInput') ? request.params.questions || [] : [];
  async function respond(decision?: string) { setBusy(true); setError(''); try { await api('/requests/' + request.id, { decision, answers }); answerDrafts.delete(request.id); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="request-card"><h3><Icon name={questions.length ? 'chat' : 'alert'} size={16}/>{questions.length ? t('{agent} needs your input', { agent }) : t('Approve this action')}</h3>
    {questions.map((q: any) => <fieldset className="question" key={q.id}><legend>{q.question || q.header}</legend>{q.options?.length > 0 && <div className="answer-options">{q.options.map((option: any) => <button type="button" disabled={busy} aria-pressed={answers[q.id] === option.label} className={answers[q.id] === option.label ? 'selected' : ''} key={option.label} onClick={() => setAnswers({ ...answers, [q.id]: option.label })}>{option.label}{option.description && <small>{option.description}</small>}</button>)}</div>}{!(q.isOther === false && q.options?.length > 0) && <input disabled={busy} aria-label={q.question || q.header} placeholder={t('Or type your own answer')} value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}/>}</fieldset>)}
    {!questions.length && <><p>{request.params.reason || t('{agent} is requesting permission for this action.', { agent })}</p><pre>{request.params.command || (request.params.permissions ? JSON.stringify(request.params.permissions, null, 2) : request.params.grantRoot || t('Apply file changes'))}</pre></>}
    {error && <p className="inline-error" role="alert">{error}</p>}<div className="button-row">{!questions.length && <button disabled={busy} className="button secondary" onClick={() => void respond('decline')}>{t('Decline')}</button>}<button disabled={busy || questions.some((q: any) => !answers[q.id]?.trim())} className="button primary" onClick={() => void respond(questions.length ? undefined : 'accept')}>{busy ? t('Submitting…') : questions.length ? t('Reply to {agent}', { agent }) : t('Allow this action')}</button></div>
  </div>;
}

// Clipboard access needs a secure context; Tailscale HTTP falls back to a hidden selection.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = document.createElement('textarea'); area.value = text; area.readOnly = true; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
    }
    setCopied(true);
  }
  return <button type="button" className="message-action" aria-label={copied ? t('Copied') : t('Copy message')} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={14}/><span>{copied ? t('Copied') : t('Copy')}</span></button>;
}

// Commands arrive wrapped in the login shell that ran them, and files with
// absolute paths; the chat shows the command itself and paths in the task.
const shellCommand = (text: string) => text.match(/^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/)?.[2] ?? text;
const taskPath = (file: string, root: string) => root && file.startsWith(root + '/') ? file.slice(root.length + 1) : file;
const editedFiles = (item: TimelineItem, root: string) => item.text.split('\n').filter(Boolean).map(file => taskPath(file, root));
const toolState = (item: TimelineItem) => item.status === 'inProgress' ? 'running' : item.status && item.status !== 'completed' ? 'failed' : '';

// Who is looking, so messages and notes from other people show their names.
const ViewerContext = createContext<Viewer | null>(null);
// A message's sender: the viewer, or someone else by name. A message without
// an author is the owner's.
function useSender(author: Author | undefined) {
  const viewer = useContext(ViewerContext);
  const mine = !viewer || (author ? author.id === viewer.id : viewer.role === 'owner');
  return { mine, name: mine ? '' : author?.name || viewer?.owner || '' };
}
const senderLabel = (sender: { mine: boolean; name: string }, at: number) => sender.mine ? t('You, {time}', { time: time(at) }) : t('{name}, {time}', { name: sender.name, time: time(at) });
const SenderName = ({ sender }: { sender: { mine: boolean; name: string } }) => sender.mine ? null : <div className="message-author">{sender.name}</div>;

// A first message built from PDF notes shows the notes, not the instructions around them.
function NotesMessage({ item, notes }: { item: TimelineItem; notes: NoteSummary[] }) {
  const sender = useSender(item.meta?.author);
  const results = useNoteResults();
  const renderNote = (note: NoteSummary, index: number) => <li key={index} data-note-result={`${item.id}:${index}`} tabIndex={-1} className={results?.selected === `${item.id}:${index}` ? 'linked-note-selected' : ''}>
      <span className="sent-note-where"><span className="sent-note-number" aria-hidden="true">{index + 1}</span><span className="sent-note-location">{noteLocation(note.where)}</span></span>
      {note.quote ? <blockquote>{note.quote}</blockquote> : <span className="sent-note-region">{t('Marked region')}</span>}
      {note.comment && <p>{note.comment}</p>}
      <NoteResultLinks noteKey={`${item.id}:${index}`}/>
    </li>;
  return <article className="message user notes-message" aria-label={senderLabel(sender, item.createdAt)}><SenderName sender={sender}/><div className="message-body" title={time(item.createdAt)}>
    {item.meta?.skill && <SkillChip skill={item.meta.skill}/>}
    {item.meta?.notes && item.text && <p className="notes-request">{item.text}</p>}
    <div className="sent-notes-head"><Icon name="notes" size={14}/>{notes.some(note => note.group) ? t('PDF annotations') : tn(notes.length, 'Note on the PDF', '{n} notes on the PDF')}</div>
    {noteGroups(notes).map(({ group, entries }) => <GroupCard key={group} group={group} count={entries.length} active={entries.some(({ index }) => results?.selected === `${item.id}:${index}`)}>
      {item.meta?.groupInstructions?.[group] && <p className="group-instruction-sent">{item.meta.groupInstructions[group]}</p>}
      <ol className="sent-notes">{entries.map(({ note, index }) => renderNote(note, index))}</ol>
    </GroupCard>)}
    <ol className="sent-notes">{notes.map((note, index) => !note.group && renderNote(note, index))}</ol>
    <MessageAttachments files={item.meta?.attachments}/>
  </div></article>;
}

// Review feedback as the author gave it: decisions as counts, comments as written.
function FeedbackDetails({ feedback }: { feedback: FeedbackSummary }) {
  const counts = [feedback.accepted && ['accepted', t('{n} accepted', { n: feedback.accepted })], feedback.rejected && ['rejected', t('{n} rejected', { n: feedback.rejected })], feedback.comments.length && ['commented', tn(feedback.comments.length, '{n} comment', '{n} comments')], feedback.undone && ['undone', t('{n} undone', { n: feedback.undone })], feedback.buildError && ['failed', t('build error')]].filter(Boolean) as string[][];
  return <>
    {counts.length > 0 && <div className="feedback-counts">{counts.map(([kind, text]) => <span key={kind} className={kind}>{text}</span>)}</div>}
    {feedback.comments.length > 0 && <ol className="sent-notes">{feedback.comments.map((comment, index) => <li key={index}><span className="sent-note-where">{noteLocation(comment.where)}</span><p>{comment.text}</p></li>)}</ol>}
  </>;
}

function UserMessage({ item, agent }: { item: TimelineItem; agent: string }) {
  const sender = useSender(item.meta?.author);
  const notes = item.meta?.notes || readNotesInstructions(item.text);
  if (notes) return <NotesMessage item={item} notes={notes}/>;
  const { skill, feedback, sendsFeedback, build } = item.meta || {};
  // Papilot sent the agent a build its own edits broke.
  if (build) return <article className="message user notes-message build-message" aria-label={t('Papilot sent the build error to {agent}, {time}', { agent, time: time(item.createdAt) })}><div className="message-body" title={time(item.createdAt)}>
    <div className="sent-notes-head"><Icon name="alert" size={14}/>{t('Build failed · sent to {agent}', { agent })}</div>
    <p className="build-error">{[build.error, ...build.details].join('\n')}</p>
  </div></article>;
  if (sendsFeedback || isFeedbackPrompt(item.text)) return <article className="message user notes-message" aria-label={sender.mine ? t('You sent review feedback, {time}', { time: time(item.createdAt) }) : t('{name} sent review feedback, {time}', { name: sender.name, time: time(item.createdAt) })}><SenderName sender={sender}/><div className="message-body" title={time(item.createdAt)}>
    <div className="sent-notes-head"><Icon name="paper" size={14}/>{t('Review feedback')}</div>
    {feedback && <FeedbackDetails feedback={feedback}/>}
  </div></article>;
  return <article className="message user" aria-label={senderLabel(sender, item.createdAt)}><SenderName sender={sender}/><div className="message-body" title={time(item.createdAt)}>
    {skill && <SkillChip skill={skill}/>}{skill && item.text ? '\n' : ''}{item.text}
    <MessageAttachments files={item.meta?.attachments}/>
    {feedback && <details className="feedback-attachment"><summary><Icon name="paper" size={13}/>{t('With review feedback')}</summary><FeedbackDetails feedback={feedback}/></details>}
  </div></article>;
}

// Memoized: polling and typing re-render the thread, and unchanged items can skip it.
const TimelineEntry = memo(function TimelineEntry({ item, agent, root }: { item: TimelineItem; agent: string; root: string }) {
  // Memoized, so it follows a language change itself rather than through App.
  useLanguage();
  if (item.type === 'user') return <UserMessage item={item} agent={agent}/>;
  if (item.type === 'assistant') return <article className="message assistant" aria-label={`${agent}, ${time(item.createdAt)}`}><div className="message-body markdown"><Markdown text={item.text}/></div><div className="message-actions"><CopyButton text={item.text}/><time dateTime={new Date(item.createdAt).toISOString()}>{time(item.createdAt)}</time></div></article>;
  const files = item.type === 'files' ? editedFiles(item, root) : [];
  const label = item.type === 'command' ? shellCommand(item.text) || t('Run command') : item.type === 'files' ? (files.length === 1 ? t('Edited {file}', { file: files[0] }) : t('Edited {n} files', { n: files.length })) : item.type === 'pdf' ? (item.text ? t('Viewed the PDF: {places}', { places: item.text }) : t('Viewed the PDF')) : item.text || t('Run tool');
  const detail = item.type === 'files' ? files.join('\n') : item.detail;
  const state = toolState(item);
  return <details className={'tool-item ' + state}><summary><Icon name={item.type === 'command' ? 'terminal' : item.type === 'files' ? 'diff' : item.type === 'pdf' ? 'pdf' : 'tool'} size={14}/><span className="tool-label">{label}</span>{state === 'running' ? <span className="spinner" aria-label={t('Running')}/> : state && <span className="tool-status">{item.status === 'declined' ? t('Declined') : t('Failed')}</span>}</summary>{detail && <pre>{detail}</pre>}</details>;
});

// Consecutive commands, edits and tool calls fold into one line that opens to the list.
function ToolGroup({ items, agent, root }: { items: TimelineItem[]; agent: string; root: string }) {
  // The thread reuses its elements, so the summary follows a language change itself.
  useLanguage();
  const commands = items.filter(item => item.type === 'command').length, edits = items.filter(item => item.type === 'files');
  const pdfs = items.filter(item => item.type === 'pdf').length;
  const files = [...new Set(edits.flatMap(item => editedFiles(item, root)))], tools = items.length - commands - edits.length - pdfs;
  const running = items.some(item => toolState(item) === 'running'), failed = items.filter(item => toolState(item) === 'failed').length;
  const parts = [commands ? tn(commands, 'ran {n} command', 'ran {n} commands') : '', files.length ? (files.length === 1 ? t('edited {file}', { file: files[0] }) : t('edited {n} files', { n: files.length })) : '', pdfs ? t('viewed the PDF') : '', tools ? tn(tools, 'used {n} tool', 'used {n} tools') : ''].filter(Boolean).join(t(', '));
  return <details className="tool-group"><summary><Icon name={commands ? 'terminal' : files.length ? 'diff' : 'tool'} size={14}/><span className="tool-group-label">{parts[0].toUpperCase() + parts.slice(1)}</span>{running ? <span className="spinner" aria-label={t('Running')}/> : failed ? <span className="tool-status">{t('{n} failed', { n: failed })}</span> : null}<Icon name="chevronDown" size={13}/></summary>
    <div className="tool-group-items">{items.map(item => <TimelineEntry key={item.id} item={item} agent={agent} root={root}/>)}</div>
  </details>;
}

function timelineEntries(items: TimelineItem[]) {
  const entries: TimelineItem[][] = [];
  for (const item of items) {
    const tool = item.type !== 'user' && item.type !== 'assistant', last = entries[entries.length - 1];
    if (tool && last && last[0].type !== 'user' && last[0].type !== 'assistant') last.push(item); else entries.push([item]);
  }
  return entries;
}

function Activity({ task, runtime, reconnecting, onReconnect, skills, composer, answerDrafts, items, loading, loadError, retry, requests, refresh, reportError, pause, pausing, openReview, feedback, connection, tools, lead }: { tools?: React.ReactNode; lead?: React.ReactNode; task: Task; runtime?: RuntimeStatus; reconnecting: boolean; onReconnect: () => void; skills: Skill[]; composer: ComposerDraft; answerDrafts: Map<string, Record<string, string>>; items: TimelineItem[]; loading: boolean; loadError: string; retry: () => void; requests: PendingRequest[]; refresh: () => void; reportError: (e: unknown) => void; pause: () => void; pausing: boolean; openReview?: () => void; feedback?: React.ReactNode; connection?: React.ReactNode }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [savingModel, setSavingModel] = useState(false);
  const { text: draft, sending, sendingSource } = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const viewer = useContext(ViewerContext);
  const files = useAttachmentDraft(`papilot:files:${viewer?.id || 'owner'}:task:${task.id}`);
  const [skill, setSkill] = useState<Skill | null>(null);
  useEffect(() => setSkill(current => current ? skills.find(item => item.id === current.id) || null : null), [skills]);
  const scroller = useRef<HTMLDivElement>(null);
  // A chat the author scrolled back through opens at the same place; one that
  // was following the latest messages opens at the end, as before.
  const place = 'chat:' + task.id, back = useRef(readPlace<number>(place));
  const shouldFollow = useRef(back.current === undefined);
  const [following, setFollowing] = useState(back.current === undefined);
  // A hidden chat (the Review tab on a phone) has no size yet; it goes back when shown.
  const settled = useRef(false); settled.current = !loading && items.length > 0;
  function goBack() {
    const box = scroller.current, top = back.current;
    if (!box || top === undefined || !box.clientHeight) return;
    box.scrollTop = top;
    if (Math.abs(box.scrollTop - top) < 2 || settled.current) back.current = undefined;
  }
  useLayoutEffect(goBack, [items, requests, loading]);
  const noteResults = useNoteResults();
  useLayoutEffect(() => { if (noteResults?.selected) { back.current = undefined; shouldFollow.current = false; setFollowing(false); } }, [noteResults?.selected, noteResults?.reveal]);
  function latest() { back.current = undefined; shouldFollow.current = true; setFollowing(true); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }
  useEffect(() => { if (shouldFollow.current) latest(); }, [items, requests]);
  useEffect(() => {
    if (!scroller.current) return;
    const observer = new ResizeObserver(() => { if (back.current !== undefined) goBack(); else if (shouldFollow.current) latest(); });
    observer.observe(scroller.current); return () => observer.disconnect();
  }, []);
  async function submit(source: 'draft' | 'feedback') {
    if (savingModel || composer.sending || ['uncertain', 'deleting'].includes(task.status) || (source === 'draft' && files.draft.getSnapshot().blocked)) return;
    const chosen = source === 'draft' ? skill : null;
    const attached = source === 'draft' ? files.draft.getSnapshot().files : [];
    const pending = composer.submit(source, message => api('/tasks/' + task.id + '/messages', message), chosen?.id, attached.map(file => file.id));
    try { if (await pending) { files.draft.clear(attached); shouldFollow.current = true; if (chosen) setSkill(current => current === chosen ? null : current); refresh(); } }
    catch (e) { reportError(e); }
  }
  const active = ACTIVE.includes(task.status), blocked = ['uncertain', 'deleting'].includes(task.status);
  // The draft re-renders this panel on every keystroke; the same elements let
  // React skip the conversation until its items change.
  const agent = agentName(task), review = task.mode === 'review', root = task.worktree;
  const thread = useMemo(() => timelineEntries(items.filter(item => item.type !== 'reviewOutput').map(item => review && item.type === 'assistant' ? { ...item, text: aiReviewSummary(item.text) } : item))
    .map(entry => entry.length > 1 ? <ToolGroup key={entry[0].id} items={entry} agent={agent} root={root}/> : <TimelineEntry key={entry[0].id} item={entry[0]} agent={agent} root={root}/>), [items, review, agent, root]);
  const unsent = unsentReviewFeedback(task.review);
  const hint = task.status === 'deleting' ? t('This task is being deleted') : task.status === 'uncertain' ? t('Check task status before sending') : sendingSource === 'feedback' ? t('Sending feedback…') : sending ? t('Sending…')
    : unsent ? tn(unsent, '{n} review update will be sent with this message', '{n} review updates will be sent with this message') : active ? t('{agent} is working · new instructions run next', { agent: agentName(task) }) : '';
  return <section id="conversation-panel" className="activity-panel" aria-label={t('{agent} conversation', { agent: agentName(task) })}><div className="panel-heading">{lead}{tools && <div className="panel-tools">{tools}</div>}</div>
    <div className="conversation-history"><div className="messages" ref={scroller} onScroll={() => { if (scroller.current && back.current === undefined) { const el = scroller.current; shouldFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setFollowing(shouldFollow.current); savePlace(place, shouldFollow.current ? undefined : Math.round(el.scrollTop)); } }}><div className="thread">
      {loading && <p className="muted" role="status">{t('Loading conversation…')}</p>}
      {loadError && <div className="conversation-error" role="alert"><p>{loadError}</p><button className="button secondary compact" onClick={retry}>{t('Retry conversation')}</button></div>}
      {thread}
      {requests.map(r => <RequestCard key={r.id} request={r} agent={agentName(task)} answerDrafts={answerDrafts} onDone={refresh}/>)}
      {task.status === 'running' && <div className="working"><span className="working-dots"><i/><i/><i/></span>{t('{agent} is working on this task', { agent: agentName(task) })}</div>}
      {task.status === 'queued' && <p className="muted">{t('Task saved. Waiting for an available {agent} session.', { agent: agentName(task) })}</p>}
      {openReview && task.status === 'reviewing' && task.review?.counts?.pending ? <div className="review-ready"><Icon name="paper" size={16}/><span>{tn(task.review.counts.pending, '{n} change to review', '{n} changes to review')}</span><button className="button secondary compact" onClick={openReview}>{t('Open review')}</button></div> : null}
      {feedback}
      {task.error && <div className="task-error"><Icon name="alert" size={16}/><div><strong>{t('This step needs attention')}</strong><p>{errorText(task.error)}</p></div></div>}
    </div></div>{!following && <button className="jump-latest" onClick={latest}><Icon name="arrowDown" size={14}/>{t('Latest messages')}</button>}</div>
    <div className="composer-wrap">
      {connection}
      <Composer attachments={task.mode === 'review' ? undefined : files.draft} upload={(file, signal) => uploadAttachment(task.projectId, file, signal)} filesDisabled={sending || blocked} imageHint={task.agent === 'antigravity' && files.files.some(file => file.mime.startsWith('image/'))} inputRef={input} label={t('Instructions for {agent}', { agent: agentName(task) })} value={draft} onChange={value => composer.edit(value)} onSubmit={() => void submit('draft')} placeholder={task.mode === 'review' ? t('Ask for another review of this PDF version…') : active ? t('Queue instructions for the next turn…') : t('Ask a question or request changes…')} skills={task.mode === 'review' ? [] : skills.filter(skill => skill.output !== 'annotations')} skill={skill} onSkill={setSkill}
        footer={attach => <div className="composer-options">{task.mode !== 'review' && <SkillPicker onAttach={attach} skills={skills.filter(skill => skill.output !== 'annotations')} selected={skill} disabled={sending || blocked} onPick={value => { setSkill(value); input.current?.focus(); }}/>}<TaskModelPicker task={task} runtime={runtime} disabled={sending || blocked} reconnecting={reconnecting} onReconnect={onReconnect} save={settings => api<Task>(`/tasks/${task.id}/model`, settings)} onSaving={setSavingModel} refresh={refresh} reportError={reportError}/></div>}
        action={<div className="composer-actions">
          {active && <button type="button" className="send-button stop" aria-label={t('Pause task')} title={t('Pause {agent}', { agent: agentName(task) })} disabled={pausing} aria-busy={pausing} onClick={pause}><Icon name="stop" size={18}/></button>}
          {(!active || draft.trim() || skill || files.entries.length || sending) && <button aria-label={t('Send instructions')} title={t('Send (Enter) · New line (Shift+Enter)')} disabled={(!draft.trim() && !skill && !files.files.length) || files.blocked || sending || savingModel || blocked} className="send-button" type="submit"><Icon name="arrowUp" size={18}/></button>}
        </div>}/>
      {hint && <p className="composer-hint" role="status">{hint}</p>}
    </div>
  </section>;
}

// Comments go back to the agent for another round; so does a round that
// rejected everything. Accepted changes are already in the manuscript, and
// decisions alone reach the agent with the next message. Shown under the
// review, or at the end of the chat when the review is hidden.
function ReviewFeedback({ task, composer, refresh, reportError, onSent, card }: { task: Task; composer: ComposerDraft; refresh: () => void; reportError: (error: unknown) => void; onSent: () => void; card?: boolean }) {
  const { sending, sendingSource } = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const unsent = unsentReviewFeedback(task.review), comments = task.review?.comments ?? unsent;
  const done = task.status === 'reviewing' && !task.review?.counts?.pending;
  const count = unsent || comments;
  if (!(comments > 0 || (done && unsent > 0 && !task.review?.counts?.accepted)) || task.status === 'deleting') return null;
  async function send() {
    if (task.status === 'uncertain') return;
    try { if (await composer.submit('feedback', message => api('/tasks/' + task.id + '/messages', message))) { refresh(); onSent(); } }
    catch (error) { reportError(error); }
  }
  return <div className={'review-feedback' + (card ? ' card' : '')}>
    <span><Icon name="chat" size={15}/>{tn(count, '{n} review update not sent yet', '{n} review updates not sent yet')}</span>
    <button className="button primary compact" title={t('Send your review decisions and comments to the agent')} disabled={sending || task.status === 'uncertain'} onClick={() => void send()}>{sendingSource === 'feedback' ? t('Sending feedback…') : t('Send feedback')}<Icon name="arrowRight" size={14}/></button>
  </div>;
}


// Shorten an absolute repository path to its last folders for menus.
function shortPath(value: string) { const parts = value.split('/').filter(Boolean); return (parts.length > 2 ? '…/' : '/') + parts.slice(-2).join('/'); }
function gitSummary(git: GitStatus | null) {
  if (!Array.isArray(git?.files)) return '';
  const sync = [git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : ''].filter(Boolean).join(' ');
  return [git.branch || t('detached'), git.files.length ? t('{n} changed', { n: git.files.length }) : t('clean'), sync].filter(Boolean).join(' · ');
}

// A source-control style summary: where the manuscript is, its last commit,
// and what is not committed yet (accepted review changes land here).
// Untracked build output is left out of a commit unless chosen, and can go
// into .gitignore. An agent can write the commit message.
type CommitWriter = { agent: AgentId; model?: string };
const ignorable = (file: GitFile) => file.status === '?' && Boolean(ignorePattern(file.path));
const gitNames = (): Record<string, string> => ({ M: t('Modified'), A: t('Added'), D: t('Deleted'), R: t('Renamed'), C: t('Copied'), U: t('Conflict'), '?': t('Untracked'), T: t('Type changed') });

function DiffView({ diff }: { diff: GitDiff }) {
  const all = diff.diff.split('\n'), start = all.findIndex(line => line.startsWith('@@'));
  const lines = start < 0 ? all.filter(line => line.startsWith('Binary')) : all.slice(start, start + 3000);
  if (!lines.length) return <p className="git-diff-note">{t('No textual changes.')}</p>;
  // A context line's leading space is non-breaking, so a long first word wraps in place.
  return <><pre className="git-diff">{lines.map((line, index) => <span key={index} className={line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line.startsWith('\\') ? 'note' : undefined}>{line.startsWith(' ') ? '\u00a0' + line.slice(1) : line || ' '}{'\n'}</span>)}</pre>
    {(diff.truncated || all.length - start > 3000) && <p className="git-diff-note">{t('The diff is too long to show in full.')}</p>}</>;
}

// A source-control panel in the shape of Cursor's. Changes: the commit
// message, Commit, and the staged and unstaged files, each with a diff and
// stage, unstage and discard actions. Commit takes what is staged, or with
// nothing staged, every file but build output as it is on disk. Then the
// commit graph, whose header fetches, pulls and pushes with the host's Git
// credentials, and the tasks' worktrees.
function DiscardDialog({ files, onCancel, onConfirm }: { files: GitFile[]; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null;
    element.showModal(); element.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => { element.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const one = files.length === 1, untracked = files.filter(file => file.status === '?').length, name = files[0].path.slice(files[0].path.lastIndexOf('/') + 1);
  const deleting = one && untracked === 1;
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="git-discard-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); onCancel(); }} onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="modal delete-dialog">
      <h2 id="git-discard-title">{deleting ? t('Delete {name}?', { name }) : one ? t('Discard changes in {name}?', { name }) : tn(files.length, 'Discard changes in {n} file?', 'Discard changes in {n} files?')}</h2>
      <p>{deleting ? t('This file is not tracked by Git, so it cannot be recovered.') : untracked ? t('Unstaged changes are lost for good and untracked files are deleted. Staged changes stay.') : t('Unstaged changes are lost for good. Staged changes stay.')}</p>
      <div className="button-row">
        <button type="button" data-cancel className="button secondary" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="button danger" onClick={onConfirm}>{deleting ? t('Delete file') : t('Discard changes')}</button>
      </div>
    </section>
  </dialog>;
}

function GitPanel({ projectId, git, onStatus, writer, tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (id: string) => void; projectId: string; git: GitStatus | null; onStatus: (status: GitStatus) => void; writer: CommitWriter }) {
  const loadOverview = useCallback((signal: AbortSignal) => api<GitOverview>(`/projects/${projectId}/git/overview`, undefined, signal, 60000), [projectId]);
  const draftKey = `papilot:commit:${projectId}`;
  const [message, setMessage] = useState(() => browserStorage.getItem(draftKey) || '');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [resolution, setResolution] = useState<{ agent: string; summary: string } | null>(null);
  const [discarding, setDiscarding] = useState<GitFile[] | null>(null);
  const [changesOpen, toggleChanges] = usePane('changes', true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // A file can be in both lists, so the open diff is its list and its path.
  const [open, setOpen] = useState(''), [diff, setDiff] = useState<{ path: string; result: GitDiff | null; error: string } | null>(null);
  const files = git?.files || [];
  const openPath = open.slice(open.indexOf(':') + 1), openFile = open ? files.find(file => file.path === openPath) : undefined;
  useEffect(() => {
    if (!openFile) { setDiff(null); return; }
    let live = true;
    setDiff(current => current?.path === openPath ? current : { path: openPath, result: null, error: '' });
    api<GitDiff>(`/projects/${projectId}/git/diff?path=${encodeURIComponent(openPath)}`).then(result => { if (live) setDiff({ path: openPath, result, error: '' }); }, e => { if (live) setDiff({ path: openPath, result: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [projectId, openPath, openFile?.status, openFile?.lines?.join()]);
  if (!git || !Array.isArray(git.files)) return <section className="git-panel" aria-label={t('Git status')}><p className="git-clean">{t('Reading Git status…')}</p></section>;
  const staged = files.filter(file => file.staged), unstaged = files.filter(file => file.unstaged), chosen = staged.length ? staged : files.filter(file => !ignorable(file));
  const stage = (paths: string[], on: boolean) => { if (paths.length) void run('stage', () => api<{ git: GitStatus }>(`/projects/${projectId}/git/stage`, { paths, stage: on }), () => ''); };
  const saveMessage = (value: string) => { setMessage(value); if (value) browserStorage.setItem(draftKey, value); else browserStorage.removeItem(draftKey); };
  async function run<R extends { git: GitStatus }>(action: string, work: () => Promise<R>, done: (result: R) => string) {
    if (busy) return;
    setBusy(action); setError(''); setNotice('');
    try { const result = await work(); onStatus(result.git); setNotice(done(result)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }
  const merging = git.merging, publish = !git.upstream && git.remote && git.branch;
  const canPush = Boolean(git.remote && (git.upstream || publish) && !merging);
  // Commit and push pushes once the commit is made; a failed push leaves the commit.
  const commit = (push = false) => {
    const text = message.trim();
    if (!text || !chosen.length) return;
    void run('commit', async () => {
      const result = await api<{ git: GitStatus; commit: string }>(`/projects/${projectId}/git/commit`, staged.length ? { message: text, staged: true } : { message: text, paths: chosen.map(file => file.path) });
      saveMessage('');
      if (!push) return { ...result, pushed: false };
      onStatus(result.git);
      return { ...await api<{ git: GitStatus }>(`/projects/${projectId}/git/push`, {}, undefined, 130000), commit: result.commit, pushed: true };
    }, result => result.pushed ? t('Committed {hash} and pushed.', { hash: result.commit }) : t('Committed {hash}.', { hash: result.commit ?? '' }));
  };
  // Like Cursor's generate button: the chosen agent reads the chosen files' changes.
  // An empty box takes a message already written for them; a full one asks for a new one.
  async function generate() {
    if (busy || !chosen.length) return;
    setBusy('message'); setError(''); setNotice('');
    try { saveMessage((await api<{ message: string }>(`/projects/${projectId}/git/message`, { paths: chosen.map(file => file.path), staged: staged.length > 0, agent: writer.agent, fresh: Boolean(message.trim()) }, undefined, 130000)).message); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }
  const discard = (list: GitFile[]) => { setDiscarding(null); void run('discard', () => api<{ git: GitStatus }>(`/projects/${projectId}/git/discard`, { paths: list.map(file => file.path) }), () => tn(list.length, 'Discarded changes in {n} file.', 'Discarded changes in {n} files.')); };
  const reload = () => void run('reload', async () => ({ git: await api<GitStatus>(`/projects/${projectId}/git`) }), () => '');
  const ignored = files.filter(ignorable), patterns = [...new Set(ignored.map(file => ignorePattern(file.path)))];
  const ignore = () => void run('ignore', () => api(`/projects/${projectId}/git/ignore`, { paths: ignored.map(file => file.path) }), () => tn(patterns.length, 'Added {n} pattern to .gitignore.', 'Added {n} patterns to .gitignore.'));
  const remote = (action: 'fetch' | 'pull' | 'merge' | 'push') => void run(action, () => api<{ git: GitStatus }>(`/projects/${projectId}/git/${action}`, {}, undefined, 130000),
    result => action === 'fetch' ? (result.git.behind ? tn(result.git.behind, '{n} new commit on {upstream}.', '{n} new commits on {upstream}.', { upstream: result.git.upstream ?? '' }) : t('Up to date with the remote.'))
      : action === 'pull' ? t('Pulled the latest commits.')
      : action === 'merge' ? (result.git.merging ? t('The merge stopped at conflicts.') : t('Merged {upstream}.', { upstream: git.upstream ?? '' }))
      : result.git.upstream ? t('Pushed to {upstream}.', { upstream: result.git.upstream }) : t('Pushed to the remote.'));
  // A branch and its upstream that have both moved on are merged; conflicts
  // go to an agent, then the author reads the diffs and commits the merge.
  const diverged = Boolean(git.upstream && git.ahead > 0 && git.behind > 0 && !merging);
  const resolve = () => void run('resolve', () => api<{ git: GitStatus; summary: string; remaining: string[]; agent: AgentId }>(`/projects/${projectId}/git/resolve`, { agent: writer.agent, model: writer.model || undefined }, undefined, 620000),
    result => { setResolution({ agent: AGENT_LABELS[result.agent], summary: result.summary }); return result.remaining.length ? tn(result.remaining.length, '{n} file still has conflicts.', '{n} files still have conflicts.') : t('Conflicts resolved. Read the diffs, then commit the merge.'); });
  const finish = () => void run('finish', () => api<{ git: GitStatus; commit: string }>(`/projects/${projectId}/git/finish`, {}), result => { setResolution(null); return t('Committed {hash}.', { hash: result.commit }); });
  const abort = () => void run('abort', () => api<{ git: GitStatus }>(`/projects/${projectId}/git/abort`, {}), () => { setResolution(null); return t('The merge was abandoned.'); });
  const commitTitle = staged.length ? tn(staged.length, 'Commit staged changes in 1 file', 'Commit staged changes in {n} files') : chosen.length === files.length ? tn(files.length, 'Commit 1 file', 'Commit all {n} files') : t('Commit {chosen} of {n} files', { chosen: chosen.length, n: files.length });
  const commitDisabled = Boolean(busy) || !message.trim() || !chosen.length;
  const placeholder = busy === 'message' ? t('{agent} is writing a commit message…', { agent: AGENT_LABELS[writer.agent] })
    : git.branch && !touch() ? t('Message ({key} to commit on “{branch}”)', { key: '↵', branch: git.branch }) : t('Commit message');
  // One row per file and list. The staged list shows the index's status.
  const row = (file: GitFile, list: 'staged' | 'changes') => {
    const status = file.status === 'U' && merging && !merging.conflicts.includes(file.path) ? 'M' : list === 'staged' ? file.index || file.status : file.status;
    const slash = file.path.lastIndexOf('/'), code = status === '?' ? 'U' : status === 'U' ? '!' : status, key = list + ':' + file.path, expanded = open === key;
    return <li key={key} className={expanded ? 'open' : undefined}>
      <div className="git-row">
        <button type="button" className="git-file" aria-expanded={expanded} title={`${gitNames()[status] || status}: ${file.from ? `${file.from} → ` : ''}${file.path}`} onClick={() => setOpen(expanded ? '' : key)}>
          <Icon name="paper" size={14}/><span className="git-name">{file.path.slice(slash + 1)}</span>{slash > 0 && <span className="git-dir">{file.path.slice(0, slash)}</span>}
        </button>
        {!merging && <span className="git-row-actions">
          {list === 'changes' && <button type="button" className="icon-button" aria-label={t('Discard changes in {path}', { path: file.path })} title={t('Discard changes')} disabled={Boolean(busy)} onClick={() => setDiscarding([file])}><Icon name="undo" size={14}/></button>}
          {list === 'changes'
            ? <button type="button" className="icon-button" aria-label={t('Stage {path}', { path: file.path })} title={t('Stage changes')} disabled={Boolean(busy)} onClick={() => stage([file.path], true)}><Icon name="plus" size={14}/></button>
            : <button type="button" className="icon-button" aria-label={t('Unstage {path}', { path: file.path })} title={t('Unstage changes')} disabled={Boolean(busy)} onClick={() => stage([file.path], false)}><Icon name="minus" size={14}/></button>}
        </span>}
        <span className={'git-code s-' + (status === '?' ? 'u' : status === 'U' ? 'conflict' : status.toLowerCase())} aria-label={gitNames()[status] || status}>{code}</span>
      </div>
      {expanded && <div className="git-diff-wrap" aria-label={t('Changes in {path}', { path: file.path })} role="region">
        {diff?.path === file.path && diff.result ? <DiffView diff={diff.result}/> : diff?.error ? <p className="inline-error">{diff.error}</p> : <p className="git-diff-note">{t('Loading the diff…')}</p>}
      </div>}
    </li>;
  };
  const group = (list: 'staged' | 'changes', items: GitFile[]) => {
    const name = list === 'staged' ? t('Staged changes') : t('Changes'), shut = collapsed[list];
    return <div className="git-group" role="group" aria-label={name}>
      <div className="git-group-header">
        <button type="button" className="git-group-toggle" aria-expanded={!shut} onClick={() => setCollapsed(current => ({ ...current, [list]: !shut }))}><Icon name={shut ? 'chevronRight' : 'chevronDown'} size={12}/><span>{name}</span></button>
        {!merging && <span className="git-row-actions">
          {list === 'changes' && <button type="button" className="icon-button" aria-label={t('Discard all changes')} title={t('Discard all changes')} disabled={Boolean(busy)} onClick={() => setDiscarding(items)}><Icon name="undo" size={14}/></button>}
          {list === 'changes'
            ? <button type="button" className="icon-button" aria-label={t('Stage all changes')} title={t('Stage all changes')} disabled={Boolean(busy)} onClick={() => stage(items.filter(file => !ignorable(file)).map(file => file.path), true)}><Icon name="plus" size={14}/></button>
            : <button type="button" className="icon-button" aria-label={t('Unstage all changes')} title={t('Unstage all changes')} disabled={Boolean(busy)} onClick={() => stage(items.map(file => file.path), false)}><Icon name="minus" size={14}/></button>}
        </span>}
        <span className="git-count">{items.length}</span>
      </div>
      {!shut && <ul className="git-files">{items.map(file => row(file, list))}</ul>}
    </div>;
  };
  const sync = git.upstream && (git.ahead > 0 || git.behind > 0) ? <span className="git-sync">{git.ahead > 0 && <span>↑{git.ahead}</span>}{git.behind > 0 && <span>↓{git.behind}</span>}</span> : null;
  const remoteActions = <>
    {git.branch ? <span className="git-branch" title={git.upstream ? `${t('Tracking')} ${git.upstream}` : t('No upstream branch')}><Icon name="branch" size={13}/><code>{git.branch}</code>{sync}</span> : <span className="git-branch"><code>{t('detached HEAD')}</code></span>}
    {git.remote && <>
      <button type="button" className="icon-button" aria-label={t('Fetch from the remote')} title={t('Fetch from the remote')} disabled={Boolean(busy)} onClick={() => remote('fetch')}>{busy === 'fetch' ? <span className="spinner"/> : <Icon name="fetch" size={15}/>}</button>
      {git.upstream && <button type="button" className="icon-button" aria-label={diverged ? t('Merge') : t('Pull')} title={diverged ? t('{branch} and {upstream} have both changed. Merge brings in the remote commits.', { branch: git.branch ?? '', upstream: git.upstream }) : t('Pull')} disabled={Boolean(busy) || Boolean(merging) || !git.behind} onClick={() => remote(diverged ? 'merge' : 'pull')}>{busy === 'pull' || busy === 'merge' ? <span className="spinner"/> : <Icon name="pull" size={15}/>}</button>}
      {(git.upstream || publish) && <button type="button" className="icon-button" aria-label={git.upstream ? t('Push') : t('Publish branch')} title={git.upstream ? t('Push') : t('Publish branch')} disabled={Boolean(busy) || Boolean(merging) || Boolean(git.upstream && !git.ahead)} onClick={() => remote('push')}>{busy === 'push' ? <span className="spinner"/> : <Icon name="push" size={15}/>}</button>}
    </>}
  </>;
  return <section className="git-panel" aria-label={t('Git status')} aria-busy={Boolean(busy)}>
    <GitPane className="git-changes" title={t('Changes')} open={changesOpen} onToggle={() => toggleChanges()} actions={<>
      <button type="button" className="icon-button" aria-label={t('Refresh changes')} title={t('Refresh changes')} disabled={Boolean(busy)} onClick={reload}>{busy === 'reload' ? <span className="spinner"/> : <Icon name="refresh" size={14}/>}</button>
      <ActionMenu label={t('More Git actions')} disabled={Boolean(busy) || Boolean(merging)} actions={[
        ...(ignored.length ? [{ label: t('Add to .gitignore'), detail: tn(ignored.length, '{n} build file', '{n} build files'), title: t('Untracked build output. Add to .gitignore adds:') + '\n' + patterns.join('\n'), icon: 'archive', select: ignore }] : []),
        { label: t('Stage all changes'), icon: 'plus', disabled: !unstaged.length, select: () => stage(unstaged.filter(file => !ignorable(file)).map(file => file.path), true) },
        { label: t('Unstage all changes'), icon: 'minus', disabled: !staged.length, select: () => stage(staged.map(file => file.path), false) },
        { label: t('Discard all changes'), icon: 'undo', danger: true, disabled: !unstaged.length, select: () => setDiscarding(unstaged) },
      ]}><Icon name="more" size={15}/></ActionMenu>
    </>}>
      {error && <p className="inline-error git-message" role="alert">{error}</p>}
      {notice && !error && <p className="git-message git-notice" role="status"><Icon name="check" size={14}/>{notice}</p>}
      {merging && <div className={'git-merge' + (merging.conflicts.length ? '' : ' resolved')} role="group" aria-label={t('Merge in progress')}>
        <p><strong>{merging.conflicts.length ? tn(merging.conflicts.length, 'Merging: {n} file has conflicts', 'Merging: {n} files have conflicts') : t('Merging: no conflicts left')}</strong><span>{merging.message}</span></p>
        {resolution && <div className="git-merge-summary markdown" aria-label={t('{agent} on the merge', { agent: resolution.agent })}><Markdown text={resolution.summary}/></div>}
        <div className="button-row">
          <button type="button" className="button secondary compact" disabled={Boolean(busy)} onClick={abort}>{busy === 'abort' ? t('Aborting…') : t('Abort merge')}</button>
          {merging.conflicts.length
            ? <button type="button" className="button primary compact" disabled={Boolean(busy)} onClick={resolve}>{busy === 'resolve' ? <><span className="spinner"/>{t('{agent} is resolving…', { agent: AGENT_LABELS[writer.agent] })}</> : <><Icon name="spark" size={14}/>{t('Resolve with {agent}', { agent: AGENT_LABELS[writer.agent] })}</>}</button>
            : <button type="button" className="button primary compact" disabled={Boolean(busy)} onClick={finish}>{busy === 'finish' ? t('Committing…') : t('Commit merge')}</button>}
        </div>
      </div>}
      {!merging && <form className="git-commit-form" onSubmit={event => { event.preventDefault(); commit(); }}>
        <div className="git-message-box">
          <textarea aria-label={t('Commit message')} placeholder={placeholder} rows={1} value={message} readOnly={busy === 'commit' || busy === 'message'} onChange={event => saveMessage(event.target.value)} onKeyDown={event => { if (sendsMessage(event.nativeEvent, touch())) { event.preventDefault(); commit(); } }}/>
          <button type="button" className="icon-button git-generate" aria-label={t('Generate commit message')} title={t('Write a commit message for the chosen files with {agent}', { agent: AGENT_LABELS[writer.agent] })} disabled={Boolean(busy) || !chosen.length} onClick={() => void generate()}>{busy === 'message' ? <span className="spinner"/> : <Icon name="spark" size={15}/>}</button>
        </div>
        <div className={'git-commit-split' + (canPush ? ' has-menu' : '')}>
          <button className="button primary git-commit-button" title={commitTitle} disabled={commitDisabled}>{busy === 'commit' ? <span className="spinner"/> : <Icon name="check" size={15}/>}{busy === 'commit' ? t('Committing…') : t('Commit')}</button>
          {canPush && <ActionMenu label={t('More commit actions')} className="button primary git-commit-more" disabled={commitDisabled} actions={[
            { label: t('Commit'), icon: 'check', select: () => commit(false) },
            { label: t('Commit and push'), icon: 'push', select: () => commit(true) },
          ]}><Icon name="chevronDown" size={14}/></ActionMenu>}
        </div>
      </form>}
      {merging ? files.length > 0 && group('changes', files) : <>
        {staged.length > 0 && group('staged', staged)}
        {unstaged.length > 0 && group('changes', unstaged)}
      </>}
      {!files.length && <p className="git-clean">{t('No uncommitted changes')}</p>}
    </GitPane>
    <GitRepository git={git} load={loadOverview} tasks={tasks} onOpenTask={onOpenTask} taskStatus={task => <Status task={task}/>} actions={remoteActions}/>
    {discarding && <DiscardDialog files={discarding} onCancel={() => setDiscarding(null)} onConfirm={() => discard(discarding)}/>}
  </section>;
}

function noteWhere(note: Annotation) { return t('Page {n}', { n: note.page + 1 }) + (note.source ? ` · ${note.source.file}:${note.source.lines[0]}${note.source.lines[1] !== note.source.lines[0] ? `–${note.source.lines[1]}` : ''}` : ''); }

function NotePlacementWarning() {
  return <small className="note-placement-warning" title={t('The position in the new PDF could not be confirmed. The original text and note are kept.')}><Icon name="alert" size={12}/>{t('Position needs confirmation')}</small>;
}

interface NoteActions {
  selection: ReturnType<typeof useNoteSelection>;
  instructions: ReturnType<typeof useGroupInstructions>;
  group: NoteGroup | null;
  setGroup: (group: NoteGroup | null) => void;
  add: (page: number, rect: Rect, rects: Rect[], quote: string, comment: string, group?: NoteGroup, options?: { reveal?: boolean; quote?: boolean }) => Promise<void>;
  edit: (note: Annotation, comment: string) => Promise<void>;
  remove: (note: Annotation) => Promise<void>;
  restore: (note: Annotation) => Promise<void>;
  onEditing: (editing: boolean) => void;
  onReviewBusy: (busy: boolean) => void;
  sending: boolean;
}

interface NotesHandle { save: () => Promise<boolean> }
function NotesPanel({ notes, currentKey, active, actions, onShow, onAnnotate, controller }: { notes: Annotation[]; currentKey?: string; active: string; actions: NoteActions; onShow: (note: Annotation) => void; onAnnotate: (region: boolean) => void; controller: React.Ref<NotesHandle> }) {
  const list = useRef<HTMLElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftValues = useRef(drafts);
  const [dismissed, setDismissed] = useState<Annotation | null>(null);
  const pending = useRef(new Map<string, Promise<boolean>>());
  const [busyIds, setBusyIds] = useState<string[]>([]), [errors, setErrors] = useState<Record<string, string>>({});
  const editing = Object.keys(drafts).length > 0, busy = busyIds.length > 0, locked = busy || actions.sending;
  const onEditing = actions.onEditing;
  useEffect(() => { onEditing(editing || busy); return () => onEditing(false); }, [editing, busy, onEditing]);
  useEffect(() => { if (active) list.current?.querySelector(`[data-note="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  useEffect(() => { if (dismissed && notes.some(note => note.id === dismissed.id)) setDismissed(null); }, [notes, dismissed]);
  useEffect(() => { for (const id of Object.keys(draftValues.current)) if (!notes.some(note => note.id === id)) draft(id, null); }, [notes]);
  const clearError = (id: string) => setErrors(current => { const next = { ...current }; delete next[id]; return next; });
  function draft(id: string, value: string | null) {
    const next = { ...draftValues.current };
    if (value === null) delete next[id]; else next[id] = value;
    draftValues.current = next; setDrafts(next);
  }
  function change(id: string, work: () => Promise<void>): Promise<boolean> {
    if (pending.current.has(id) || actions.sending) return Promise.resolve(false);
    clearError(id);
    const operation = Promise.resolve().then(work).then(() => true, e => { setErrors(current => ({ ...current, [id]: e instanceof Error ? e.message : String(e) })); return false; })
      .finally(() => { pending.current.delete(id); setBusyIds([...pending.current.keys()]); });
    pending.current.set(id, operation); setBusyIds([...pending.current.keys()]);
    return operation;
  }
  const saveNote = (note: Annotation, comment: string, quote = false) => change(note.id, async () => {
    await actions.edit(note, comment); draft(note.id, null);
    if (quote) toggle(note);
  });
  useImperativeHandle(controller, () => ({ save: async () => {
    if (actions.sending || (await Promise.all([...pending.current.values()])).some(saved => !saved)) return false;
    for (const [id, value] of Object.entries(draftValues.current)) {
      const note = notes.find(note => note.id === id), comment = value.trim();
      if (note && comment && comment !== note.comment) { if (!await saveNote(note, comment)) return false; }
      else draft(id, null);
    }
    return true;
  } }));
  const selectionLocked = locked || editing;
  const toggle = (note: Annotation) => actions.selection.set([note.id], !actions.selection.has(note.id));
  const selectCard = (note: Annotation, index: number) => <NoteAttachButton number={index + 1} ai={Boolean(note.aiReview)} selected={actions.selection.has(note.id)} disabled={selectionLocked} onClick={() => toggle(note)}/>;
  const ownNotes = notes.filter(note => !note.aiReview), ownSelected = ownNotes.filter(note => actions.selection.has(note.id)).length;
  const unplacedSuggestions = notes.filter(note => note.aiReview && note.key !== currentKey);
  const renderNote = (note: Annotation, index: number) => <li key={note.id} data-note={note.id} data-selected={actions.selection.has(note.id)} className={(note.aiReview ? 'review-suggestion ' : '') + (active === note.id ? 'active ' : '') + (note.key !== currentKey ? 'stale' : '')}>
    <PdfNoteCard inline note={note} number={index + 1} index={0} total={1} selected={actions.selection.has(note.id)} busy={actions.sending || busyIds.includes(note.id)} error={errors[note.id] || ''}
      draft={drafts[note.id] ?? null} onDraftChange={value => { draft(note.id, value); if (value !== null && drafts[note.id] === undefined) clearError(note.id); }}
      header={<div className="note-card-context"><div className="note-head"><button type="button" className="note-number" aria-label={note.aiReview ? t('Show suggestion {n} on the page', { n: index + 1 }) : t('Show note {n} on the page', { n: index + 1 })} disabled={note.key !== currentKey} onClick={() => onShow(note)}>{index + 1}</button><span className="note-where">{noteWhere(note)}{note.aiReview ? ' · ' + AGENT_LABELS[note.aiReview.agent] : note.author ? ' · ' + t('from {name}', { name: note.author.name }) : ''}</span></div><NoteQuote text={note.quote}/></div>}
      onToggle={() => toggle(note)} onDismiss={() => void change(note.id, async () => { await actions.remove(note); draft(note.id, null); if (note.aiReview) setDismissed(note); })}
      onSave={(comment, action) => saveNote(note, comment, action === 'quote')}>
      {note.key !== currentKey && <NotePlacementWarning/>}
    </PdfNoteCard>
  </li>;
  return <section ref={list} className="notes-panel" aria-label={t('PDF notes')}>
    <div className="draft-notes-head">
      <div className="note-entry-actions">
        <button type="button" className="button ghost compact" disabled={!currentKey || locked || Boolean(editing)} onClick={() => onAnnotate(true)}><Icon name="region" size={14}/>{t('Region note')}</button>
        <span className="note-entry-hint">{t('or select text to annotate')}</span>
      </div>
      {ownNotes.length > 0 && <button type="button" className="note-select-all" aria-label={t('Select all notes for this task')} aria-pressed={ownSelected === ownNotes.length ? true : ownSelected ? 'mixed' : false} disabled={selectionLocked} onClick={() => actions.selection.set(ownNotes.map(note => note.id), ownSelected !== ownNotes.length)}>{ownSelected === ownNotes.length ? t('Remove all from task') : t('Add all to task')}</button>}
    </div>
    <p className="note-selection-hint">{t('Notes stay here unless you add them to a task.')}</p>
    {currentKey && notes.some(note => note.key !== currentKey) && <p className="note-placement-summary" role="status">{t('Some note positions need confirmation. Their original text and comments are kept.')}</p>}
    {ownNotes.length > 0 && <section className="note-section" aria-label={t('My notes')}>
    {noteGroups(notes).map(({ group, entries }) => {
      const count = entries.filter(({ note }) => actions.selection.has(note.id)).length;
      return <GroupCard key={group} group={group} count={entries.length} active={actions.group === group || entries.some(({ note }) => note.id === active)} selection={{ count, disabled: selectionLocked, toggle: () => actions.selection.set(entries.map(({ note }) => note.id), count !== entries.length) }}>
      <div className="group-references">{entries.map(({ note, index }) => <div className={'group-location note-card' + (note.id === active ? ' active' : '')} key={note.id} data-note={note.id} data-selected={actions.selection.has(note.id)}>
        <button type="button" className="note-number" aria-label={t('Show note {n} on the page', { n: index + 1 })} disabled={note.key !== currentKey} onClick={() => onShow(note)}>{index + 1}</button>
        <div className="group-location-target"><blockquote>{note.quote || t('Marked region')}</blockquote><span>{noteWhere(note)}</span>{note.key !== currentKey && <NotePlacementWarning/>}</div>
        <button type="button" className="icon-button group-location-remove" aria-label={t('Delete note {n}', { n: index + 1 })} disabled={locked} onClick={() => void change(note.id, () => actions.remove(note))}><Icon name="trash" size={14}/></button>
        {selectCard(note, index)}
      </div>)}</div>
    </GroupCard>; })}
    <ol className="note-list">{notes.map((note, index) => !note.aiReview && !note.group && renderNote(note, index))}</ol>
    </section>}
    {unplacedSuggestions.length > 0 && <section className="note-section" aria-label={t('Unplaced suggestions')}><h3>{t('Unplaced suggestions')}</h3><ol className="note-list">{notes.map((note, index) => note.aiReview && note.key !== currentKey && renderNote(note, index))}</ol></section>}
    {dismissed && <div className="note-dismissed" role="status">{t('Suggestion ignored.')} <button type="button" disabled={selectionLocked} onClick={() => void change(dismissed.id, async () => { await actions.restore(dismissed); setDismissed(null); })}>{t('Undo')}</button></div>}
    {Object.entries(errors).filter(([id]) => !notes.some(note => note.id === id && !note.group)).map(([id, error]) => <p key={id} className="inline-error" role="alert">{error}</p>)}
  </section>;
}

// The composer receives only attachments the author explicitly chose in the PDF.
function TaskNotes({ notes, currentKey, actions, onShow }: { notes: Annotation[]; currentKey?: string; actions: NoteActions; onShow: (note: Annotation) => void }) {
  const panel = useRef<HTMLElement>(null);
  const chosen = notes.filter(note => actions.selection.has(note.id));
  if (!chosen.length) return null;
  // Notes listed in My notes fly back there; placed AI suggestions stay on the page.
  const putBack = (list: Annotation[]) => {
    returnNotes(list.filter(note => !note.aiReview || note.key !== currentKey).flatMap(note => panel.current?.querySelector<HTMLElement>(`[data-note="${CSS.escape(note.id)}"]`) || []));
    actions.selection.set(list.map(note => note.id), false);
  };
  const remove = (note: Annotation, index: number) => {
    const label = note.aiReview ? t('Remove suggestion {n} from task', { n: index + 1 }) : t('Remove note {n} from task', { n: index + 1 });
    return <button type="button" className="note-send included" aria-label={label} title={label} disabled={actions.sending} onClick={() => putBack([note])}>{t('Included')}<Icon name="close" size={12}/></button>;
  };
  const reference = (note: Annotation, index: number) => <li key={note.id} data-note={note.id} className="task-note-reference">
    <div className="note-head"><button type="button" className="note-number" aria-label={note.aiReview ? t('Show suggestion {n} on the page', { n: index + 1 }) : t('Show note {n} on the page', { n: index + 1 })} disabled={note.key !== currentKey} onClick={() => onShow(note)}>{index + 1}</button><span className="note-where">{noteWhere(note)}</span></div>
    <NoteQuote text={note.quote}/>
    {/* Same control and place as the PDF popover: bottom right, "Included ×". It
        floats at the end of the comment, so only the last line makes room. */}
    <p className="task-note-comment">{note.comment}{remove(note, index)}</p>
    {note.key !== currentKey && <NotePlacementWarning/>}
  </li>;
  return <section ref={panel} className="task-notes-panel" aria-label={t('Notes in this task')}>
    <div className="note-selection-head"><span>{t('Added to task: {n}', { n: chosen.length })}</span><button type="button" className="note-select-all" disabled={actions.sending} onClick={() => putBack(chosen)}>{t('Remove all from task')}</button></div>
    {noteGroups(notes).map(({ group, entries }) => {
      const selected = entries.filter(({ note }) => actions.selection.has(note.id));
      return selected.length > 0 && <GroupCard key={group} group={group} count={selected.length}>
        <GroupInstruction group={group} value={actions.instructions.get(group)} disabled={actions.sending} onChange={value => actions.instructions.set(group, value)}/>
        <ol className="task-note-list">{selected.map(({ note, index }) => reference(note, index))}</ol>
      </GroupCard>;
    })}
    <ol className="task-note-list">{notes.map((note, index) => !note.group && actions.selection.has(note.id) && reference(note, index))}</ol>
  </section>;
}

function PendingComparison({ task, busy, onBuild }: { task: Task; busy: boolean; onBuild: () => void }) {
  const answered = noManuscriptChanges(task);
  let title = answered ? t('No manuscript changes') : t('PDF comparison');
  let detail = answered ? t('This task did not change the manuscript. Read the answer in the chat.') : t('Only manuscript changes need a PDF comparison. Answers to questions are in the chat.');
  if (task.status === 'building') {
    title = t('Preparing task results…');
    detail = t('Checking for manuscript changes. A PDF comparison is generated only when needed.');
  } else if (task.status === 'running' || task.status === 'queued') {
    title = task.status === 'running' ? t('{agent} is working', { agent: agentName(task) }) : t('Queued');
    detail = t('If the task changes the manuscript, a PDF comparison will appear here. Otherwise, read the answer in the chat.');
  } else if (task.status === 'waiting_input') {
    title = t('Needs your reply');
    detail = t('Reply in the chat to continue. A PDF comparison is needed only if the manuscript changes.');
  } else if (task.status === 'uncertain') {
    title = t('Check task status');
    detail = t('Confirm whether the task is still running before generating a PDF comparison.');
  }
  return <div className="review-placeholder">
    <div className="placeholder-icon">{task.status === 'building' ? <span className="spinner large"/> : <Icon name={answered ? 'chat' : 'diff'} size={22}/>}</div>
    <h2>{title}</h2><p>{detail}</p>
    {!answered && ['idle', 'interrupted', 'failed', 'reviewing'].includes(task.status) && <button type="button" className="button secondary" disabled={busy} onClick={onBuild}>{t('Generate PDF comparison')}</button>}
  </div>;
}


type ManuscriptPanel = 'pdf' | 'task' | 'contents' | 'git';
function ManuscriptView({ project, data, error, view, setView, region, setRegion, active, setActive, actions, newTask, tools, share, navigation, onGit, writer, reportError, tasks, onOpenTask, onFixProblems }: { onFixProblems?: (request: string) => void; tasks: Task[]; onOpenTask: (id: string) => void; navigation?: React.ReactNode; newTask: (notes: React.ReactNode) => React.ReactNode; tools?: React.ReactNode; share?: React.ReactNode; onGit: (status: GitStatus) => void; writer: CommitWriter; reportError: (error: unknown) => void; project: Project; data: Manuscript | null; error: string; view: ManuscriptPanel; setView: (view: ManuscriptPanel) => void; region: boolean; setRegion: (on: boolean) => void; active: string; setActive: (id: string) => void; actions: NoteActions }) {
  const build = data?.build, notes = data?.annotations || [], git = data?.git;
  const pdf = useRef<PdfHandle>(null);
  const [readingNotes, setReadingNotes] = useState(false);
  const notesPanel = useRef<NotesHandle>(null);
  async function closeReadingNotes() {
    if (readingNotes && notesPanel.current && !await notesPanel.current.save()) return false;
    setReadingNotes(false); return true;
  }
  const [collapsed, setCollapsed] = useState(() => browserStorage.getItem('papilot:manuscript-panel') === 'hidden');
  const canCollapse = useMedia('(min-width: 681px)'), hidden = canCollapse && collapsed;
  const sideBySide = useMedia('(min-width: 901px)');
  const panelId = useId(), panelToggle = useRef<HTMLButtonElement>(null);
  const panel = usePanelWidth('papilot:manuscript-width', '--manuscript-width', '.manuscript-side', t('Resize manuscript panel'), sideBySide && !hidden, () => pdf.current?.fitWidth());
  useEffect(() => { browserStorage.setItem('papilot:manuscript-panel', collapsed ? 'hidden' : 'visible'); }, [collapsed]);
  const togglePanel = canCollapse && <button ref={panelToggle} type="button" className="icon-button manuscript-panel-toggle" aria-label={hidden ? t('Expand manuscript panel') : t('Collapse manuscript panel')} title={hidden ? t('Expand manuscript panel') : t('Collapse manuscript panel')} aria-expanded={!hidden} aria-controls={panelId} onClick={() => {
    setCollapsed(value => !value); pdf.current?.fitWidth();
    requestAnimationFrame(() => panelToggle.current?.focus());
  }}><Icon name={hidden ? 'panelExpand' : 'panelCollapse'} size={18}/></button>;
  const pageTools = <>{tools}{!hidden && !sideBySide && share}{hidden && togglePanel}</>;
  // PDF or Changes stays as the author left it when they come back to the paper.
  const [mode, showMode] = useState<PdfMode>(() => readPlace('mode:' + project.id) === 'changes' ? 'changes' : 'pdf'), [committing, setCommitting] = useState(false);
  const setMode = (value: PdfMode) => { showMode(value); savePlace('mode:' + project.id, value); };
  // The last build's problems sit beside Recompile and open only when asked.
  const problems = useRef<ProblemsHandle>(null);
  const problemsButton = <ProblemsButton ref={problems} counts={build?.problems} status={build?.status} pdfKey={build?.key} logUrl={`/api/projects/${project.id}/manuscript/log`}
    load={() => api<ManuscriptProblems>(`/projects/${project.id}/manuscript/problems`, undefined, undefined, 60000)}
    onJump={problem => { if (problem.page === undefined || !problem.rect) return; if (phone()) setView('pdf'); const { page, rect } = problem; requestAnimationFrame(() => pdf.current?.showPlace(page, rect)); }}
    onFix={onFixProblems && (list => { onFixProblems(fixRequest(list)); setView('task'); setCollapsed(false); })}/>;
  const pdfTools = <>{tools}{problemsButton}<button type="button" data-notes-home="library" className={'icon-button' + (readingNotes ? ' active' : '')} aria-label={t('My notes')} title={t('My notes')} aria-pressed={readingNotes} onClick={() => { if (readingNotes) void closeReadingNotes(); else { setActive(''); setReadingNotes(true); } }}><Icon name="notes" size={16}/></button>{!hidden && !sideBySide && share}{hidden && togglePanel}</>;
  const switcher = <>{navigation}<ModeSwitch mode={mode} onMode={async value => { if (await closeReadingNotes()) setMode(value); }}/></>;
  const staged = Array.isArray(git?.files) && !git.merging ? git.files.filter(file => file.staged).map(file => file.path) : [];
  const reloadGit = () => void api<GitStatus>(`/projects/${project.id}/git`).then(onGit, () => undefined);
  const commitButton = (inFrame: boolean) => staged.length > 0 && (inFrame
    ? <><span className="commit-state">{tn(staged.length, '{n} file staged', '{n} files staged')}</span><button type="button" className="commit-button" onClick={() => setCommitting(true)}>{t('Commit…')}</button></>
    : <button type="button" className="button ghost compact commit-staged" title={t('Commit what is staged')} onClick={() => setCommitting(true)}><Icon name="commit" size={14}/><span>{t('Commit…')}</span></button>);
  const [outline, setOutline] = useState<OutlineItem[]>([]), [section, setSection] = useState(-1);
  const numbered = notes.map((note, index) => ({ note, number: index + 1 }));
  const phone = () => window.matchMedia('(max-width: 680px)').matches;
  const side = view === 'pdf' ? 'task' : view;
  function goTo(item: OutlineItem) {
    if (phone()) setView('pdf');
    requestAnimationFrame(() => pdf.current?.goTo(item));
  }
  async function show(note: Annotation) {
    if (note.key !== build?.key || !await closeReadingNotes()) return;
    setMode('pdf');
    setActive(note.id);
    if (phone()) setView('pdf');
    requestAnimationFrame(() => pdf.current?.goToNote(note));
  }
  async function annotate(region: boolean) {
    if (!await closeReadingNotes()) return;
    setMode('pdf'); setRegion(region); setActive('');
    if (phone()) setView('pdf');
    if (!phone() && mode === 'pdf') pdf.current?.focus();
    else requestAnimationFrame(() => pdf.current?.focus());
  }
  return <div className={'manuscript show-' + view + (hidden ? ' panel-collapsed' : '')} style={panel.style}>
    {panel.resizer}
    {mode === 'changes' ? <section className="manuscript-pages" aria-label={t('Uncommitted changes in the PDF')}>
      <ReviewFrame key={'changes:' + project.id} changesOf={project.id} lead={switcher} tools={<>{commitButton(false)}{pageTools}</>} completion={commitButton(true)} onDecided={reloadGit}/>
    </section> : <section className="manuscript-pages" aria-label={t('PDF preview')} aria-busy={!build || build.status === 'building'}>
      {!build?.key && <div className="pdf-toolbar manuscript-lead" role="toolbar" aria-label={t('PDF controls')}>{switcher}<div className="pdf-section"/>{pdfTools}</div>}
      {error && <div className="manuscript-note error" role="alert">{error}</div>}
      {build?.status === 'failed' && (build.key
        // The previous PDF stays readable; the details wait in the problem list.
        ? <div className="manuscript-note error brief" role="alert"><span>{t('The latest changes did not compile. This is the last PDF that did.')}</span><button type="button" className="note-link" onClick={() => problems.current?.open()}>{t('Show problems')}</button></div>
        : <div className="manuscript-note error" role="alert"><strong>{t('The manuscript did not compile.')}</strong><pre>{build.error}</pre></div>)}
      {build?.key ? <Suspense fallback={<div className="review-loading"><p role="status">{t('Opening the PDF…')}</p></div>}><PdfView ref={pdf} place={'pdf:' + project.id} url={`/api/projects/${project.id}/manuscript.pdf?key=${build.key}`} words={`/api/projects/${project.id}/manuscript/words?key=${build.key}`} notes={numbered.filter(item => item.note.key === build.key)} active={active} region={region} setRegion={setRegion} group={actions.group} onGroupChange={actions.setGroup} markingDisabled={actions.sending}
          noteActions={{ has: actions.selection.has, toggle: note => actions.selection.set([note.id], !actions.selection.has(note.id)), remove: actions.remove, restore: actions.restore, edit: actions.edit, onEditing: actions.onEditing, onBusy: actions.onReviewBusy, disabled: actions.sending }} onDeselect={() => setActive('')}
          onCreate={actions.add} onSelect={async note => { if (await closeReadingNotes()) setActive(note.id); }} outline={outline} section={section} onOutline={setOutline} onSection={setSection} lead={switcher} tools={pdfTools}/></Suspense>
        : !error && build?.status !== 'failed' && <div className="review-placeholder"><div className="placeholder-icon"><span className="spinner large"/></div><h2>{t('Compiling the PDF…')}</h2></div>}
      {readingNotes && <aside className="pdf-reading-notes" aria-label={t('PDF note library')}><div className="pdf-reading-notes-head"><strong>{t('My notes')}</strong><button type="button" className="icon-button" aria-label={t('Close notes')} onClick={() => void closeReadingNotes()}><Icon name="close" size={16}/></button></div><NotesPanel key={project.id} controller={notesPanel} notes={notes} currentKey={build?.key} active={active} actions={actions} onShow={show} onAnnotate={annotate}/></aside>}
    </section>}
    <aside id={panelId} className="manuscript-side" aria-label={t('Manuscript panels')} hidden={hidden}>
      <div className="manuscript-side-header">
        {!hidden && togglePanel}
        <div className="side-tabs" role="tablist" aria-label={t('Manuscript panels')}>
          <button role="tab" data-task-home aria-selected={side === 'task'} title={t('New task')} onClick={() => setView('task')}><Icon name="compose" size={14}/><span className="tab-label">{t('New task')}</span>{actions.selection.selected.length > 0 && <span className="count" aria-hidden="true">{actions.selection.selected.length}</span>}</button>
          <button role="tab" aria-selected={side === 'contents'} title={t('Contents')} onClick={() => setView('contents')}><Icon name="list" size={14}/><span className="tab-label">{t('Contents')}</span></button>
          <button role="tab" aria-selected={side === 'git'} title="Git" onClick={() => setView('git')}><Icon name="branch" size={14}/><span className="tab-label">Git</span>{data?.git?.files?.length ? <span className="count">{data.git.files.length}</span> : null}</button>
        </div>
        {!hidden && sideBySide && share}
      </div>
      {side === 'task' ? newTask(<TaskNotes notes={notes} currentKey={build?.key} actions={actions} onShow={show}/>) : side === 'contents' ? <nav className="contents-panel" aria-label={t('PDF contents')}>
        {outline.length ? <ol>{outline.map((item, index) => <li key={index}>
          <button type="button" aria-current={index === section ? 'location' : undefined} style={{ paddingLeft: 12 + Math.min(item.level, 4) * 14 }} onClick={() => goTo(item)}>
            <span>{item.title}</span><span className="contents-page">{item.page}</span>
          </button>
        </li>)}</ol> : <p className="muted">{build?.key ? t('This PDF has no bookmarks.') : t('Contents will appear when the PDF is ready.')}</p>}
      </nav> : <GitPanel key={project.id + project.path} projectId={project.id} git={data?.git || null} onStatus={onGit} writer={writer} tasks={tasks} onOpenTask={onOpenTask}/>}
    </aside>
    {committing && <CommitDialog branch={git?.branch ?? null} files={staged} staged remote={Boolean(git?.remote)} agent={AGENT_LABELS[writer.agent]} onClose={() => setCommitting(false)}
      generate={fresh => api<{ message: string }>(`/projects/${project.id}/git/message`, { paths: staged, staged: true, agent: writer.agent, fresh }, undefined, 130000).then(result => result.message)}
      commit={async (message, push) => {
        const result = await api<{ commit: string; git: GitStatus; pushError?: string }>(`/projects/${project.id}/git/commit`, { message, staged: true, push }, undefined, 130000);
        onGit(result.git); setCommitting(false);
        // The commit stands even when the push fails; the author can push again.
        if (result.pushError) reportError(result.pushError);
      }}/>}
  </div>;
}

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [savedTask] = useState(() => browserStorage.getItem('papilot:task'));
  const [selected, setSelected] = useState(savedTask || '');
  const [projectId, setProjectId] = useState(() => browserStorage.getItem('papilot:project') || '');
  const [timeline, setTimeline] = useState<{ taskId: string; items: TimelineItem[] }>({ taskId: '', items: [] });
  const [itemsLoading, setItemsLoading] = useState(false);
  const [timelineError, setTimelineError] = useState({ taskId: '', message: '' });
  const snapshotRef = useRef<Snapshot | null>(null);
  const timelineCache = useRef(new Map<string, TimelineItem[]>());
  const timelineRevisions = useRef(new Map<string, string>());
  const snapshotText = useRef('');
  const composers = useRef(new Map<string, ComposerDraft>());
  const answerDrafts = useRef(new Map<string, Record<string, string>>());
  const [snapshotRequest] = useState(() => new ReadRequest<Snapshot & { csrf: string }>());
  const [timelineRequest] = useState(() => new ReadRequest<{ items: TimelineItem[]; revision?: string; partial?: boolean }>());
  const [online, setOnline] = useState(true), [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const sidebarRef = useRef<HTMLElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [modal, setModal] = useState<'project' | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false), [mainChoice, setMainChoice] = useState<{ path: string; name: string; candidates: string[] } | null>(null);
  const folderRequest = useRef(false);
  // Commit drafts survive switching tasks or moving between review and chat.
  const applyStates = useRef(new Map<string, TaskApplyState>());
  const commitDrafts = useRef(new Map<string, TaskCommitDraft>());
  const formTaskId = useRef<string>(uuid());
  const newTaskInput = useRef<HTMLTextAreaElement>(null);
  const [newDraft, setNewDraft] = useState(() => browserStorage.getItem('papilot:new-task') || '');
  const [newSkill, setNewSkill] = useState<Skill | null>(null);
  const [skills, setSkills] = useState<{ projectId: string; list: Skill[] }>({ projectId: '', list: [] });
  const [skillsRevision, setSkillsRevision] = useState(0);
  // The agent, and each agent's model and reasoning effort, are remembered for
  // every new task, whether it starts from the composer or from PDF notes.
  const [savedAgent, setAgentChoice] = useState<AgentId>(() => { const saved = browserStorage.getItem('papilot:agent'); return isAgentId(saved) ? saved : 'codex'; });
  const [agentPrefs, setAgentPrefs] = useState(() => Object.fromEntries(AGENT_IDS.map(id => [id, {
    model: browserStorage.getItem(`papilot:model:${id}`) ?? (id === 'codex' ? browserStorage.getItem('papilot:model') : null) ?? '',
    // null until an effort is chosen; '' is an explicit choice of the model's default.
    effort: browserStorage.getItem(`papilot:effort:${id}`) ?? (id === 'codex' ? browserStorage.getItem('papilot:effort') : null),
    fast: browserStorage.getItem(`papilot:fast:${id}`) === 'true',
  }])) as Record<AgentId, { model: string; effort: string | null; fast: boolean }>);
  const [creating, setCreating] = useState(false), [createError, setCreateError] = useState('');
  const [addedTask, setAddedTask] = useState<Pick<Task, 'id' | 'title'> | null>(null);
  const [flyingTask, setFlyingTask] = useState<TaskFlightData | null>(null);
  const taskArrived = useCallback((task: TaskFlightData) => {
    setFlyingTask(null); setAddedTask({ id: task.id, title: task.title });
  }, []);
  useEffect(() => {
    if (!addedTask) return;
    const timer = setTimeout(() => setAddedTask(null), 3600);
    return () => clearTimeout(timer);
  }, [addedTask]);
  const [sidebar, setSidebar] = useState(false);
  const actionRequests = useRef(new Set<string>());
  const [pendingActions, setPendingActions] = useState(new Set<string>());
  const [sidebarVisible, setSidebarVisible] = useState(() => browserStorage.getItem('papilot:sidebar') !== 'hidden');
  const [layout, setLayout] = useState<'split' | 'review' | 'conversation'>(() => {
    const saved = browserStorage.getItem('papilot:layout');
    return saved === 'review' || saved === 'conversation' ? saved : 'split';
  });
  const narrow = useMedia('(max-width: 900px)'), mobile = useMedia('(max-width: 680px)');
  const [mobileTab, setMobileTab] = useState('review');
  const layoutTransition = useRef<ViewTransition | null>(null);
  const [renaming, setRenaming] = useState('');
  const [taskSearch, setTaskSearch] = useState(''), [showArchived, setShowArchived] = useState(false);
  // Enter and Escape return focus to the renamed task; clicking elsewhere keeps that focus.
  const refocus = useRef('');
  useEffect(() => {
    if (renaming || !refocus.current) return;
    document.querySelector<HTMLElement>(`.task-row[data-task="${refocus.current}"] .task-link`)?.focus();
    refocus.current = '';
  }, [renaming]);
  const [editingPaper, setEditingPaper] = useState<Project | null>(null);
  const [manuscriptView, setManuscriptView] = useState<ManuscriptPanel>(() => window.matchMedia('(max-width: 680px)').matches ? 'pdf' : 'task');
  // Without a task, the main area shows the manuscript or a tool from the
  // sidebar's Tools menu, such as the reference check.
  const [page, setPage] = useState<'manuscript' | 'references'>('manuscript');
  const [region, setRegion] = useState(false);
  const [activeNote, setActiveNote] = useState('');
  const [noteGroup, setNoteGroup] = useState<NoteGroup | null>(null);
  const [marking, setMarking] = useState(0);
  const annotationUndo = useRef<{ kind: 'add' | 'remove'; note: Annotation }[]>([]);
  const undoingAnnotation = useRef(false);
  useEffect(() => { setNoteGroup(null); annotationUndo.current = []; }, [projectId]);
  const [noteEditing, setNoteEditing] = useState(false);
  const [reviewNoteBusy, setReviewNoteBusy] = useState(false);
  const [manuscript, setManuscript] = useState<{ projectId: string; data: Manuscript | null; error: string }>({ projectId: '', data: null, error: '' });
  const manuscriptRequest = useRef(0);
  const manuscriptBuildRequests = useRef(new Set<string>());
  const [pendingManuscriptBuilds, setPendingManuscriptBuilds] = useState(new Set<string>());
  const [git, setGit] = useState<{ projectId: string; status: GitStatus | null }>({ projectId: '', status: null });
  const [chatWidth, setChatWidth] = useState(() => Number(browserStorage.getItem('papilot:chat-width')) || 0);
  // Appearance, language and notifications live in Settings; a new language re-renders everything.
  const theme = useTheme(); useLanguage();
  const [settings, setSettings] = useState<false | 'general' | 'shortcuts'>(false);
  useEffect(() => {
    const open = () => setSettings('shortcuts');
    window.addEventListener('papilot:open-shortcuts', open);
    return () => window.removeEventListener('papilot:open-shortcuts', open);
  }, []);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const loaded = useRef(false);
  useEffect(() => {
    if (!narrow || !sidebar) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = sidebarRef.current;
    (panel?.querySelector<HTMLElement>('[aria-current="page"]') || panel?.querySelector<HTMLElement>('button'))?.focus();
    return () => { if (opener?.isConnected && opener.getClientRects().length) opener.focus(); };
  }, [narrow, sidebar]);
  useEffect(() => { setSidebar(false); }, [narrow]);
  useEffect(() => { browserStorage.setItem('papilot:sidebar', sidebarVisible ? 'visible' : 'hidden'); }, [sidebarVisible]);
  useEffect(() => { browserStorage.setItem('papilot:layout', layout); }, [layout]);
  useEffect(() => { if (chatWidth) browserStorage.setItem('papilot:chat-width', String(chatWidth)); else browserStorage.removeItem('papilot:chat-width'); }, [chatWidth]);
  useEffect(() => { if (newDraft) browserStorage.setItem('papilot:new-task', newDraft); else browserStorage.removeItem('papilot:new-task'); }, [newDraft]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const sync = () => {
      const style = document.documentElement.style;
      if (viewport && window.matchMedia('(max-width: 680px)').matches && viewport.scale === 1) {
        style.setProperty('--viewport-height', `${viewport.height}px`);
        style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
      } else { style.removeProperty('--viewport-height'); style.removeProperty('--viewport-top'); }
    };
    sync(); viewport?.addEventListener('resize', sync); viewport?.addEventListener('scroll', sync); window.addEventListener('resize', sync);
    return () => { viewport?.removeEventListener('resize', sync); viewport?.removeEventListener('scroll', sync); window.removeEventListener('resize', sync); document.documentElement.style.removeProperty('--viewport-height'); document.documentElement.style.removeProperty('--viewport-top'); };
  }, []);
  const reportError = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const refreshTimeline = useCallback(async (selection: string) => {
    if (selectedRef.current === selection && !timelineCache.current.has(selection)) setItemsLoading(true);
    try {
      // A cached timeline asks only for what changed since it was read.
      const cached = timelineCache.current.get(selection), since = cached && timelineRevisions.current.get(selection);
      await timelineRequest.run(selection, signal => api<{ items: TimelineItem[]; revision?: string; partial?: boolean }>('/tasks/' + selection + '/items' + (since ? '?since=' + encodeURIComponent(since) : ''), undefined, signal), timeline => {
        const current = timelineCache.current.get(selection);
        const items = timeline.partial && current ? mergeTimeline(current, timeline.items) : timeline.items;
        if (timeline.revision) timelineRevisions.current.set(selection, timeline.revision); else timelineRevisions.current.delete(selection);
        timelineCache.current.delete(selection);
        timelineCache.current.set(selection, items);
        // Bound the in-memory history cache while retaining quick back-and-forth navigation.
        if (timelineCache.current.size > 8) timelineCache.current.delete(timelineCache.current.keys().next().value!);
        if (selectedRef.current === selection) { if (items !== current) setTimeline({ taskId: selection, items }); setTimelineError(error => error.taskId === selection && !error.message ? error : { taskId: selection, message: '' }); }
      });
    } catch (e) { if (selectedRef.current === selection) setTimelineError({ taskId: selection, message: e instanceof Error ? e.message : String(e) }); }
    finally { if (selectedRef.current === selection) setItemsLoading(false); }
  }, [timelineRequest]);
  const refresh = useCallback(async (fresh = false) => {
    try {
      if (fresh) snapshotRequest.cancel();
      await snapshotRequest.run('state', signal => api('/state', undefined, signal), next => {
        // Most polls find nothing new; an identical snapshot leaves the app as it is.
        const text = JSON.stringify(next);
        if (text === snapshotText.current && snapshotRef.current) { setOnline(true); setConnectionError(''); return; }
        snapshotText.current = text;
        const selection = selectedRef.current, previous = snapshotRef.current;
        const removed = previous?.tasks.find(t => t.id === selection && !next.tasks.some(nextTask => nextTask.id === selection));
        if (removed) setProjectId(removed.projectId);
        token = next.csrf; snapshotRef.current = next; setState(next); setOnline(true); setConnectionError('');
        // Tell the author what changed while they were in another tab or app.
        if (previous && notifying() && (document.hidden || !document.hasFocus())) for (const alert of taskAlerts(previous, next, notificationState().events)) notify(alert, id => { setSelected(id); setSidebar(false); });
        for (const id of composers.current.keys()) if (!next.tasks.some(t => t.id === id)) { composers.current.delete(id); timelineCache.current.delete(id); browserStorage.removeItem('papilot:draft:' + id); }
        setDeleteTarget(current => current && !next.tasks.some(t => t.id === current.id) ? null : current);
        setEditingPaper(current => current && !next.projects.some(p => p.id === current.id) ? null : current);
        for (const id of answerDrafts.current.keys()) if (!next.requests.some(r => r.id === id)) answerDrafts.current.delete(id);
        if (selection && !next.tasks.some(t => t.id === selection)) setSelected('');
        // An empty saved task is the manuscript, not a missing preference.
        if (!loaded.current) { loaded.current = true; if (savedTask === null && !selection) setSelected(next.tasks.filter(task => !task.archivedAt).at(-1)?.id || ''); }
      });
      const selection = selectedRef.current;
      if (!document.hidden && selection && snapshotRef.current?.tasks.some(t => t.id === selection)) await refreshTimeline(selection);
    } catch (e) { setOnline(false); setConnectionError(e instanceof Error ? e.message : String(e)); }
  }, [snapshotRequest, refreshTimeline, savedTask]);
  useEffect(() => {
    let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let events: EventSource | undefined;
    const protocol = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.nextHopProtocol || '';
    function start() {
      const cycle = ++generation;
      clearTimeout(timer); events?.close(); events = undefined;
      // A hidden tab stops reading the host, unless it has notifications to give.
      if ((document.hidden && !notifying()) || !navigator.onLine) { snapshotRequest.cancel(); timelineRequest.cancel(); if (!navigator.onLine) { setOnline(false); setConnectionError(t('You are offline. Your draft is kept in this browser.')); } return; }
      if (canStreamUpdates(protocol)) {
        events = new EventSource('/api/events');
        events.addEventListener('change', () => { if (cycle === generation) void refresh(); });
        // A manuscript build started or ended: the open PDF view reloads now.
        events.addEventListener('manuscript', () => { if (cycle === generation) window.dispatchEvent(new Event('papilot:manuscript')); });
      }
      async function poll() {
        await refresh();
        if (cycle !== generation) return;
        const busy = snapshotRef.current?.tasks.some(t => ['running', 'waiting_input', 'queued', 'building'].includes(t.status));
        timer = setTimeout(() => void poll(), events?.readyState === EventSource.OPEN ? 10000 : document.hidden ? 5000 : busy ? 1000 : 2500);
      }
      void poll();
    }
    start();
    document.addEventListener('visibilitychange', start);
    window.addEventListener('online', start);
    window.addEventListener('offline', start);
    const unsubscribe = subscribeNotifications(start);
    return () => { generation++; clearTimeout(timer); events?.close(); snapshotRequest.cancel(); timelineRequest.cancel(); unsubscribe(); document.removeEventListener('visibilitychange', start); window.removeEventListener('online', start); window.removeEventListener('offline', start); };
  }, [refresh, snapshotRequest, timelineRequest]);
  useEffect(() => {
    browserStorage.setItem('papilot:task', selected);
    setTimeline({ taskId: selected, items: timelineCache.current.get(selected) || [] });
    setItemsLoading(Boolean(selected && !timelineCache.current.has(selected)));
    if (selected && snapshotRef.current?.tasks.some(t => t.id === selected)) void refreshTimeline(selected);
    return () => timelineRequest.cancel();
  }, [selected, refreshTimeline, timelineRequest]);
  const task = state?.tasks.find(t => t.id === selected);
  // A new list on every render would scroll the chat to its end each time.
  const taskRequests = useMemo(() => state?.requests.filter(r => r.taskId === selected) || [], [state?.requests, selected]);
  if (task && !composers.current.has(task.id)) composers.current.set(task.id, new ComposerDraft('papilot:draft:' + task.id, browserStorage, uuid));
  const fullPdfUrl = task?.status !== 'deleting' && task?.review?.round ? `/api/tasks/${task.id}/pdf?round=${task.review.round}` : '';
  const project = state?.projects.find(p => p.id === (task?.projectId || projectId)) || state?.projects[0];
  // Remember the paper even when its manuscript is open, and replace stale
  // paper IDs only after the host has returned the accessible papers.
  useEffect(() => {
    if (!state) return;
    const id = project?.id || '';
    setProjectId(id);
    browserStorage.setItem('papilot:project', id);
  }, [project?.id, Boolean(state)]);
  useEffect(() => { setTaskSearch(''); setShowArchived(false); }, [project?.id]);
  useEffect(() => { if (task) setShowArchived(Boolean(task.archivedAt)); }, [task?.id, Boolean(task?.archivedAt)]);
  // Older servers send no viewer: whoever is looking is the owner.
  const viewer = state?.viewer, owner = !viewer || viewer.role === 'owner';
  const newFiles = useAttachmentDraft(`papilot:files:${viewer?.id || 'owner'}:new:${project?.id || projectId}`);
  // A session that already ended signs out too.
  async function signOut() {
    try { await api('/auth/logout', {}); } catch (e) { if (!isSignedOut()) { reportError(e); return; } }
    forgetBrowserState(); setSignedOut(true);
  }
  const tasks = state?.tasks.filter(t => !project || t.projectId === project.id) || [];
  const listedTasks = tasks.filter(task => Boolean(task.archivedAt) === showArchived);
  const searchTerms = taskSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visibleTasks = listedTasks.filter(task => {
    const text = `${task.title}\n${task.instructions}`.toLocaleLowerCase();
    return searchTerms.every(term => text.includes(term));
  });
  const running = state?.tasks.filter(t => ['running', 'waiting_input', 'building'].includes(t.status)).length || 0;
  // The desktop app opens a folder the way an editor does: the system picker,
  // then the paper itself. The browser imports a folder or ZIP in a dialog.
  function openProject() { if (nativeFolders) void openFolder(); else setModal('project'); }
  async function openFolder(folder?: string, main?: string) {
    if (folderRequest.current) return;
    folderRequest.current = true;
    try {
      const path = folder ?? await chooseDirectory();
      if (!path) return;
      setOpeningFolder(true); setError('');
      const opened = await api<{ project: Project } | { name: string; candidates: string[] }>('/projects/open', { path, ...(main ? { main } : {}) }, undefined, 120000);
      if ('candidates' in opened) { setMainChoice({ path, ...opened }); return; }
      // Select the paper once the state lists it; an unknown ID falls back to the first paper.
      await refresh(true);
      setMainChoice(null); setProjectId(opened.project.id); setSelected(''); setSidebar(false);
    } catch (failure) { if (main) throw failure; setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { folderRequest.current = false; setOpeningFolder(false); }
  }
  // File › Open Folder… in the desktop app's menu picks the folder natively.
  const openFolderRef = useRef(openFolder); openFolderRef.current = openFolder;
  useEffect(() => window.papilotDesktop?.onOpenFolder?.(folder => void openFolderRef.current(folder)), []);
  // A remembered choice the host no longer offers falls back to its default;
  // the preference is kept in case another model offers it again.
  const runtimes: Partial<Record<AgentId, RuntimeStatus>> = state?.runtimes || (state ? { codex: state.runtime } : {});
  // Only agents found on the host are offered. A remembered agent that is not
  // found falls back to Codex without forgetting the choice.
  const offered = AGENT_IDS.filter(id => id === 'codex' || Boolean(runtimes[id] && runtimes[id]!.installed !== false));
  const agentChoice = offered.includes(savedAgent) ? savedAgent : 'codex';
  const models = runtimes[agentChoice]?.models || [], pref = agentPrefs[agentChoice];
  const chosenModel = models.length && !models.some(m => m.id === pref.model) ? '' : pref.model;
  const modelInfo = models.find(m => m.id === chosenModel) || models.find(m => m.isDefault);
  const agent = { agent: agentChoice, model: chosenModel, effort: taskEffort(pref.effort, modelInfo), serviceTier: agentChoice === 'codex' ? (pref.fast && modelInfo?.fastMode ? modelInfo.fastMode.serviceTier : 'default') : undefined };
  const remember = (change: Partial<{ model: string; effort: string; fast: boolean }>) => {
    setAgentPrefs(current => ({ ...current, [agentChoice]: { ...current[agentChoice], ...change } }));
    for (const [key, value] of Object.entries(change)) browserStorage.setItem(`papilot:${key}:${agentChoice}`, String(value));
  };
  // One choice in the picker sets both the agent and its model.
  const chooseModel = (id: AgentId, model: string) => {
    setAgentChoice(id); browserStorage.setItem('papilot:agent', id);
    setAgentPrefs(current => ({ ...current, [id]: { ...current[id], model } })); browserStorage.setItem(`papilot:model:${id}`, model);
  };
  const agentOptions = (disabled: boolean) => <AgentPicker disabled={disabled} agent={agentChoice} model={agent.model} effort={agent.effort} fast={pref.fast}
    agents={offered.map(id => ({ value: id, label: AGENT_LABELS[id], runtime: runtimes[id] }))}
    reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')} onSelect={chooseModel} onChange={remember}/>;
  async function createTask() {
    const text = newDraft.trim(), target = project?.id || projectId, skill = newSkill;
    const reviewing = skill?.output === 'annotations';
    const attached = reviewing ? [] : noteSelection.selected, files = reviewing ? [] : newFiles.draft.getSnapshot().files;
    const groupInstructions = groupDrafts.forNotes(attached);
    if ((!text && !skill && !files.length && !attached.some(note => note.comment.trim()) && !Object.keys(groupInstructions).length) || (!text && !skill && groupsWithoutInstructions(attached, groupInstructions).length > 0) || (!reviewing && newFiles.draft.getSnapshot().blocked) || creating || marking || noteEditing || reviewNoteBusy || !target) return;
    const input = newTaskInput.current, submittedNotes = new Set(attached.map(note => note.id));
    const restoreFocus = input?.closest('form')?.contains(document.activeElement);
    setCreating(true); setCreateError('');
    try {
      // The ID is kept until creation succeeds, so a retried request cannot create a second task.
      const title = skill ? (text ? `${skillName(skill)}: ${taskTitle(text)}` : skillName(skill)).slice(0, 120) : text ? taskTitle(text) : attached.length === 1 ? taskTitle(attached[0].comment || (attached[0].group && groupInstructions[canonicalGroup(attached[0].group)]) || '') : attached.length ? t('Address {n} PDF notes', { n: attached.length }) : files[0].name.slice(0, 120);
      const body = { projectId: target, title, instructions: text, ...(skill ? { skill: skill.id } : {}), ...(attached.length ? { annotations: [...submittedNotes] } : {}), ...(Object.keys(groupInstructions).length ? { groupInstructions } : {}), ...(files.length ? { attachments: files.map(file => file.id) } : {}), agent: agent.agent, model: agent.model, effort: agent.effort, serviceTier: agent.serviceTier };
      const signature = JSON.stringify([target, text, skill?.id || '', [...submittedNotes], groupInstructions, files.map(file => file.id)]);
      let previous: { signature?: string; id?: string } = {};
      try { previous = JSON.parse(browserStorage.getItem('papilot:new-task-request') || '{}'); } catch { /* Invalid saved request. */ }
      formTaskId.current = previous?.signature === signature && previous.id ? previous.id : uuid();
      browserStorage.setItem('papilot:new-task-request', JSON.stringify({ signature, id: formTaskId.current }));
      // AI review compiles the task's manuscript copy before it answers.
      const created = await api<Task>('/tasks', { ...body, id: formTaskId.current }, undefined, reviewing ? 600000 : 30000);
      const source = input?.getBoundingClientRect();
      browserStorage.removeItem('papilot:new-task-request');
      newFiles.draft.clear(files); formTaskId.current = uuid(); setNewDraft(''); setNewSkill(null); setTaskSearch(''); setShowArchived(false);
      // Add the confirmed task without moving the author away from their draft.
      // Cancel older snapshots before inserting it, so they cannot erase the row.
      snapshotRequest.cancel();
      if (snapshotRef.current) {
        const next = { ...snapshotRef.current, tasks: [...snapshotRef.current.tasks.filter(task => task.id !== created.id), created] };
        snapshotRef.current = next; snapshotText.current = ''; setState(next);
      }
      setAddedTask(null);
      if (source?.width) setFlyingTask({ id: created.id, title: created.title, source });
      else setAddedTask({ id: created.id, title: created.title });
      ++manuscriptRequest.current;
      setManuscript(current => current.projectId === target && current.data ? { ...current, data: { ...current.data, annotations: (current.data.annotations || []).filter(note => !submittedNotes.has(note.id)) } } : current);
      if (!reviewing) noteSelection.reset(target);
      groupDrafts.sent(target, attached, notes);
      setActiveNote(id => submittedNotes.has(id) ? '' : id);
      setNoteGroup(null); annotationUndo.current = annotationUndo.current.filter(entry => !submittedNotes.has(entry.note.id));
      if (restoreFocus && input?.isConnected && (document.activeElement === document.body || input.closest('form')?.contains(document.activeElement))) input.focus({ preventScroll: true });
      // Reload pending notes from the server: a retry may have returned an
      // earlier successful task, while newer notes still belong to the draft.
      if (notes.length) void loadManuscript(target);
      await refresh(true);
    } catch (e) { setCreateError(e instanceof Error ? e.message : String(e)); } finally { setCreating(false); }
  }
  async function action(route: string, body: Record<string, unknown> = {}, refreshAfter = true) {
    const key = route.startsWith('/tasks/') ? route.split('/').slice(0, 3).join('/') : route;
    if (actionRequests.current.has(key)) return;
    actionRequests.current.add(key); setPendingActions(new Set(actionRequests.current));
    try { await api(route, body); if (refreshAfter) await refresh(true); return true; } catch (e) { reportError(e); }
    finally { actionRequests.current.delete(key); setPendingActions(new Set(actionRequests.current)); }
  }
  const taskActionBusy = Boolean(task && pendingActions.has('/tasks/' + task.id));
  // A task whose result is already in the manuscript is deleted without asking.
  async function deleteSavedTask(target: Task) {
    if (await action('/tasks/' + target.id + '/delete', { confirm: true }, false)) taskDeleted(target.id);
  }
  async function archiveTask(target: Task) {
    const archived = !target.archivedAt;
    if (!await action('/tasks/' + target.id + '/archive', { archived })) return;
    if (archived && selectedRef.current === target.id) { setProjectId(target.projectId); setSelected(''); }
    setShowArchived(false);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.task-search input')?.focus());
  }
  const sidebarShown = narrow ? sidebar : sidebarVisible;
  useLayoutEffect(() => {
    if (addedTask && sidebarShown) sidebarRef.current?.querySelector('.task-list')?.scrollTo({ top: 0 });
  }, [addedTask, sidebarShown]);
  function taskDeleted(id: string) {
    const removed = snapshotRef.current?.tasks.find(t => t.id === id); if (removed) setProjectId(removed.projectId);
    browserStorage.removeItem('papilot:draft:' + id); composers.current.delete(id); timelineCache.current.delete(id);
    setDeleteTarget(null);
    if (selectedRef.current === id) setSelected('');
    snapshotText.current = '';
    setState(previous => previous ? { ...previous, tasks: previous.tasks.filter(t => t.id !== id), requests: previous.requests.filter(r => r.taskId !== id) } : previous);
    void refresh(true);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(sidebarShown ? '.sidebar .manuscript-link' : '.main .sidebar-toggle')?.focus());
  }
  function hideSidebar() {
    if (narrow) { setSidebar(false); return; }
    setSidebarVisible(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.main .sidebar-toggle')?.focus());
  }

  async function rename(target: Task, value: string) {
    const title = value.trim().replace(/\s+/g, ' ').slice(0, 120);
    setRenaming('');
    if (!title || title === target.title) return;
    snapshotText.current = '';
    setState(previous => previous ? { ...previous, tasks: previous.tasks.map(t => t.id === target.id ? { ...t, title } : t) } : previous);
    try { await api('/tasks/' + target.id + '/rename', { title }); } catch (e) { reportError(e); }
    await refresh(true);
  }
  // The divider sets the chat width; CSS keeps both panels usable when the window narrows.
  function resizeChat(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget, grid = handle.parentElement!.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
    const move = (e: PointerEvent) => setChatWidth(Math.round(Math.min(Math.max(grid.right - e.clientX, 300), grid.width - 360)));
    const stop = () => { document.body.classList.remove('resizing'); handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', stop); };
    handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', stop);
  }
  function nudgeChat(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = event.currentTarget.parentElement!.querySelector<HTMLElement>('.activity-panel')?.offsetWidth || 400;
    const max = event.currentTarget.parentElement!.offsetWidth - 360;
    const next = event.key === 'ArrowLeft' ? current + 24 : event.key === 'ArrowRight' ? current - 24 : event.key === 'Home' ? max : event.key === 'End' ? 300 : null;
    if (event.key === 'Enter') { event.preventDefault(); setChatWidth(0); return; }
    if (next === null) return;
    event.preventDefault(); setChatWidth(Math.min(Math.max(next, 300), max));
  }
  const manuscriptOpen = !task && Boolean(project) && page === 'manuscript';
  const referencesOpen = !task && Boolean(project) && page === 'references';
  const loadManuscript = useCallback(async (projectId: string, rebuild = false) => {
    // A background read must not replace the result of an in-flight compile.
    if (manuscriptBuildRequests.current.has(projectId)) return;
    const request = ++manuscriptRequest.current;
    if (rebuild) { manuscriptBuildRequests.current.add(projectId); setPendingManuscriptBuilds(new Set(manuscriptBuildRequests.current)); }
    try {
      const data = await api<Manuscript>(`/projects/${projectId}/manuscript`, rebuild ? {} : undefined);
      if (request !== manuscriptRequest.current) return;
      setManuscript({ projectId, data, error: '' }); setGit({ projectId, status: data.git });
    } catch (e) { if (request === manuscriptRequest.current) setManuscript(current => ({ projectId, data: current.projectId === projectId ? current.data : null, error: e instanceof Error ? e.message : String(e) })); }
    finally { if (rebuild) { manuscriptBuildRequests.current.delete(projectId); setPendingManuscriptBuilds(new Set(manuscriptBuildRequests.current)); } }
  }, []);
  const manuscriptBuilding = manuscript.projectId === project?.id && manuscript.data?.build.status === 'building';
  useEffect(() => {
    if (!manuscriptOpen || !project) return;
    void loadManuscript(project.id);
    const focus = () => void loadManuscript(project.id);
    window.addEventListener('focus', focus);
    window.addEventListener('papilot:manuscript', focus);
    return () => { ++manuscriptRequest.current; window.removeEventListener('focus', focus); window.removeEventListener('papilot:manuscript', focus); };
  }, [manuscriptOpen, project?.id, project?.path, loadManuscript]);
  // Starting a compile switches to fast polling immediately, including a
  // manual retry made between the regular working-tree refreshes.
  useEffect(() => {
    if (!manuscriptOpen || !project) return;
    // Papilot compiles after its own writes and tells the view; this notices
    // edits saved by another editor.
    const delay = manuscriptBuilding ? 1500 : 5000;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await loadManuscript(project.id); if (!stopped) timer = setTimeout(() => void tick(), delay); };
    timer = setTimeout(() => void tick(), delay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [manuscriptOpen, project?.id, manuscriptBuilding, loadManuscript]);
  // Accepting a change updates the working tree, so the status reloads with
  // the tasks' reviews as well as every 20 seconds.
  const reviewKey = (state?.tasks || []).filter(t => t.projectId === project?.id).map(t => `${t.review?.files?.join()}:${t.review?.counts?.accepted}`).join('|');
  useEffect(() => {
    if (!project || manuscriptOpen) return;
    const load = () => void api<GitStatus>(`/projects/${project.id}/git`).then(status => setGit({ projectId: project.id, status })).catch(() => undefined);
    load(); const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [project?.id, project?.path, manuscriptOpen, reviewKey]);
  // A skill chosen for one paper may not exist on another.
  useEffect(() => setNewSkill(null), [project?.id, project?.path]);
  // Skills come from Papilot, ~/.papilot/skills and the paper's .papilot/skills,
  // read again on return to the window so a new skill file appears.
  useEffect(() => {
    if (!project) return;
    let live = true;
    const load = () => void api<{ skills?: Skill[] }>(`/projects/${project.id}/skills`).then(result => {
      if (!live) return;
      const list = Array.isArray(result.skills) ? result.skills : [];
      setSkills({ projectId: project.id, list });
      setNewSkill(current => current ? list.find(skill => skill.id === current.id) || null : null);
    }, () => undefined);
    load(); window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [project?.id, project?.path, skillsRevision]);
  const projectGit = git.projectId === project?.id ? git.status : null;
  const projectSkills = skills.projectId === project?.id ? skills.list : [];
  // "Fix with an agent…" fills the new-task composer; nothing starts until it is sent.
  function fixProblems(request: string) {
    const skill = projectSkills.find(item => item.id === 'latex-warnings');
    if (skill) setNewSkill(skill);
    setNewDraft(draft => draft.trim() ? `${draft.trimEnd()}\n\n${request}` : request);
    setTimeout(() => newTaskInput.current?.focus(), 0);
  }
  const updateGit = (projectId: string, status: GitStatus) => { setGit({ projectId, status }); setManuscript(current => current.projectId === projectId && current.data ? { ...current, data: { ...current.data, git: status } } : current); };
  const manuscriptData = manuscript.projectId === project?.id ? manuscript : { data: null, error: '' };
  // The reference check reads the bibliography while it is open, again when
  // the working tree changes; the sidebar keeps its last count.
  const bibliography = useBibliography(project?.id || '', JSON.stringify(projectGit?.files?.map(file => [file.path, file.lines]) || []), api, referencesOpen);
  const problems = problemCount(bibliography.report);
  // An agent looks into the problems as a new task the author can edit first.
  const draftInvestigation = (text: string) => {
    setNewDraft(current => current.trim() ? current.trimEnd() + '\n\n' + text : text);
    setSelected(''); setPage('manuscript'); setManuscriptView('task'); setRegion(false);
  };
  const notes = manuscriptData.data?.annotations || [];

  const noteSelection = useNoteSelection(project?.id || '', notes);
  const groupDrafts = useGroupInstructions(project?.id || '');
  const groupDirections = groupDrafts.forNotes(noteSelection.selected);
  const missingGroupDirections = !newDraft.trim() && !newSkill && groupsWithoutInstructions(noteSelection.selected, groupDirections).length > 0;
  const withNotes = (update: (list: Annotation[]) => Annotation[]) => {
    // A poll started before this write must not put an old comment or a deleted note back.
    ++manuscriptRequest.current;
    setManuscript(current => current.projectId === project?.id && current.data ? { ...current, data: { ...current.data, annotations: update(current.data.annotations || []) } } : current);
  };
  const noteActions: NoteActions = {
    selection: noteSelection,
    instructions: groupDrafts,
    group: noteGroup, setGroup: setNoteGroup,
    async add(page, rect, rects, quote, comment, group, options) {
      if (!project || !manuscriptData.data?.build.key) throw new Error(t('Wait for the PDF to compile.'));
      setMarking(value => value + 1);
      try {
        const note = await api<Annotation>(`/projects/${project.id}/annotations`, { key: manuscriptData.data.build.key, page, rect, ...(rects.length ? { rects, quote } : {}), comment, ...(group ? { group } : {}) });
        withNotes(list => [...list, note]);
        if (group) setActiveNote(''); else if (options?.reveal !== false) setActiveNote(note.id);
        if (options?.quote) noteSelection.set([note.id], true);
        if (group) annotationUndo.current.push({ kind: 'add', note });
        else setRegion(false);
      } finally { setMarking(value => value - 1); }
    },
    async edit(note, comment) {
      const saved = await api<Annotation>(`/projects/${note.projectId}/annotations/${note.id}`, { comment });
      withNotes(list => list.map(item => item.id === note.id ? saved : item));
    },
    async remove(note) {
      await api(`/projects/${note.projectId}/annotations/${note.id}/delete`, {});
      noteSelection.set([note.id], false);
      withNotes(list => list.filter(item => item.id !== note.id));
      annotationUndo.current.push({ kind: 'remove', note });
    },
    async restore(note) {
      const restored = await api<{ annotations: Annotation[] }>(`/projects/${note.projectId}/annotations/${note.id}/restore`, {});
      withNotes(() => restored.annotations); setActiveNote(note.id);
    },
    onEditing: setNoteEditing,
    onReviewBusy: setReviewNoteBusy,
    sending: creating || reviewNoteBusy,
  };
  useNoteUndo(() => {
    const entry = annotationUndo.current.at(-1);
    if (!manuscriptOpen || !entry) return false;
    if (creating || marking || noteEditing || reviewNoteBusy || undoingAnnotation.current) return true;
    undoingAnnotation.current = true;
    setError('');
    const { note } = entry;
    void (async () => {
      try {
        if (entry.kind === 'add') {
          await api(`/projects/${note.projectId}/annotations/${note.id}/delete`, {});
          withNotes(list => list.filter(item => item.id !== note.id));
        } else {
          await noteActions.restore(note);
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-note="${note.id}"] .note-edit-trigger`)?.focus());
        }
        annotationUndo.current = annotationUndo.current.filter(item => item !== entry);
      } catch (error) { reportError(error); }
      finally { undoingAnnotation.current = false; }
    })();
    return true;
  });

  const waiting = state?.tasks.filter(t => t.status === 'waiting_input').length || 0;
  useEffect(() => { document.title = (waiting ? `(${waiting}) ` : '') + (task ? `${task.title} · Papilot` : manuscriptOpen && project ? `${project.name} · Papilot` : 'Papilot'); }, [waiting, task?.title, manuscriptOpen, project?.name]);
  const replyNeeded = Boolean(task && state?.requests.some(r => r.taskId === task.id));
  const pending = task?.review?.counts?.pending || 0;
  const active = Boolean(task && ACTIVE.includes(task.status));
  const answerOnly = Boolean(task && task.mode !== 'review' && (noManuscriptChanges(task) || (active && task.review?.round === null)));
  // Do not save this as the author's layout preference: switching back to a
  // task with manuscript changes should restore their chosen review layout.
  const taskLayout = answerOnly ? 'conversation' : layout, taskTab = answerOnly ? 'conversation' : mobileTab;
  const conversationVisible = mobile ? taskTab === 'conversation' : taskLayout !== 'review';
  const pause = () => { if (task) void action('/tasks/' + task.id + '/interrupt'); };
  // With only the chat in view, the feedback bar moves to the end of the conversation.
  const chatOnly = mobile ? taskTab === 'conversation' : taskLayout === 'conversation';
  const saved = task ? taskSaveStatus(task) : null;
  const savedResult = (message: string) => <TaskSaved message={message} disabled={taskActionBusy} onArchive={task && saved && !task.archivedAt && taskFinished(task) ? () => void archiveTask(task) : undefined}
    onDelete={task && saved && taskFinished(task) ? () => void deleteSavedTask(task) : undefined}/>;
  const merging = task?.reconciliation;
  const mergeWaiting = Boolean(merging && (!merging.ready || (task?.review?.round ?? 0) <= merging.round));
  const deliveryReady = task?.deferred && task.status === 'reviewing' && !task.pendingReview && task.review?.state === 'done' && !task.review.counts.pending
    && (Boolean(task.review.files?.length) || task.delivery?.mode === 'branch' || task.delivery?.pending || merging);
  const applyKey = task?.id || '';
  if (deliveryReady && !applyStates.current.has(applyKey)) applyStates.current.set(applyKey, new TaskApplyState(merging?.intent?.message || task!.title));
  const saveTask = async (mode: 'workspace' | 'commit', message?: string, confirmation?: string) => {
    if (!task) return;
    const result = await api<{ git?: GitStatus; commitReview?: TaskCommitReview }>(`/tasks/${task.id}/apply`, { mode, message, confirmation, keepCurrent: mergeWaiting && merging?.ready }, undefined, 130000);
    if (result.git) updateGit(task.projectId, result.git);
    await refresh(true);
    return result;
  };
  // Older tasks accepted directly into the manuscript; retain their existing
  // commit form while new isolated tasks save only their reviewed delta.
  const legacyFiles = task && !task.deferred && !projectGit?.merging && task.status === 'reviewing' && !task.pendingReview && !pending
    ? (task.review?.files || []).filter(file => projectGit?.files.some(item => item.path === file)) : [];
  const legacyKey = JSON.stringify([task?.id, legacyFiles, task?.committed?.accepted, projectGit?.branch]);
  if (legacyFiles.length && !commitDrafts.current.has(legacyKey)) commitDrafts.current.set(legacyKey, new TaskCommitDraft());
  const legacySave = task && legacyFiles.length ? <TaskCommit draft={commitDrafts.current.get(legacyKey)!} branch={projectGit?.branch ?? null} isolated={false} remote={Boolean(projectGit?.remote)} agent={agentName(task)} disabled={taskActionBusy}
    generate={fresh => api<{ message: string }>(`/projects/${task.projectId}/git/message`, { paths: legacyFiles, agent: task.agent || 'codex', fresh }, undefined, 130000).then(result => result.message)}
    commit={async (message, push) => {
      const result = await api<{ commit: string; git: GitStatus; pushError?: string }>(`/tasks/${task.id}/commit`, { message, push }, undefined, 130000);
      updateGit(task.projectId, result.git);
      if (result.pushError) reportError(result.pushError);
      await refresh(true);
      return push && !result.pushError ? t('Committed {hash} and pushed.', { hash: result.commit }) : t('Committed {hash}.', { hash: result.commit });
    }}/> : task?.committed && saved ? savedResult(saved === 'pushed' ? t('Committed {hash} and pushed.', { hash: task.committed.hash }) : t('Committed {hash}.', { hash: task.committed.hash })) : null;
  const applicationStep = task && (deliveryReady ? <TaskApply key={applyKey} draft={applyStates.current.get(applyKey)!} merging={Boolean(merging)} keepCurrent={mergeWaiting && merging?.ready} disabled={taskActionBusy}
    branch={projectGit?.branch ?? null} canCommit={Boolean(task.review?.files?.length || task.delivery?.mode === 'branch' || task.delivery?.pending)} preferred={merging?.intent?.mode}
    pending={task.delivery?.pending && task.delivery.mode !== 'branch' ? task.delivery.mode : undefined}
    apply={() => saveTask('workspace')} commit={(message, confirmation) => saveTask('commit', message, confirmation)}
    generate={() => api<{ message: string }>(`/tasks/${task.id}/commit-message`, { fresh: true }, undefined, 130000).then(result => result.message)}/>
    : merging ? <TaskConflict status={task.status} waiting={mergeWaiting} onChat={() => selectLayout('conversation')}/>
    : saved === 'committed' && task.delivery ? savedResult(t('Committed {hash} to {branch}', { hash: task.delivery.commit?.slice(0, 7) || '', branch: task.delivery.branch || '' }))
    : !task.deferred ? legacySave : saved === 'applied' ? savedResult(t('Applied to manuscript')) : null);
  const reviewFeedback = (card: boolean) => task?.mode === 'review' ? (card && task.aiReview?.notes ? <button type="button" className="ai-review-link" onClick={() => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); }}><Icon name="notes" size={14}/>{tn(task.aiReview.notes, 'View {n} review suggestion', 'View {n} review suggestions')}<Icon name="arrowRight" size={13}/></button> : null) : task && <ReviewFeedback key={'review-feedback:' + task.id} card={card} task={task} composer={composers.current.get(task.id)!} refresh={() => void refresh(true)} reportError={reportError}
    onSent={() => { if (selectedRef.current !== task.id) return; setMobileTab('conversation'); setLayout(current => current === 'review' ? 'split' : current); }}/>;
  const sidebarToggle = (narrow || !sidebarVisible) && <button className="icon-button sidebar-toggle" aria-label={t('Show task list')} title={t('Show task list')} aria-expanded={sidebarShown} aria-controls="task-sidebar" onClick={() => narrow ? setSidebar(true) : setSidebarVisible(true)}><Icon name={narrow ? 'menu' : 'sidebar'} size={20}/>{addedTask && !sidebarShown && <span key={addedTask.id} className="task-added-dot" aria-hidden="true"/>}</button>;
  function selectLayout(next: typeof layout) {
    if (next === (mobile ? mobileTab : layout) && !layoutTransition.current) return;
    layoutTransition.current?.skipTransition();
    layoutTransition.current = null;
    const update = () => {
      flushSync(() => {
        if (!mobile) setLayout(next);
        if (next !== 'split') setMobileTab(next);
      });
      // Keep keyboard focus with the switcher as it moves between toolbars.
      document.querySelector<HTMLElement>('.workspace-view-selector [aria-pressed="true"]')?.focus({ preventScroll: true });
    };
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.classList.remove('switching-workspace');
      update();
      return;
    }
    document.documentElement.classList.add('switching-workspace');
    const transition = document.startViewTransition(() => {
      // A newer click wins even if the previous snapshot is still being taken.
      if (layoutTransition.current === transition) update();
    });
    layoutTransition.current = transition;
    const finish = () => {
      if (layoutTransition.current !== transition) return;
      layoutTransition.current = null;
      document.documentElement.classList.remove('switching-workspace');
    };
    void transition.finished.then(finish, finish);
  }
  const taskStateActions = task && (
        <div className="task-state-actions">
          {task.status === 'deleting' ? <button className="button secondary compact" onClick={() => setDeleteTarget(task)}>{t('Retry deletion')}</button> : task.status === 'uncertain' ? <button className="button secondary compact" disabled={taskActionBusy} aria-busy={taskActionBusy} onClick={() => void action('/tasks/' + task.id + '/reconcile')}><Icon name="refresh" size={14}/>{t('Check status')}</button> : active && !conversationVisible ? <button className="button secondary compact" aria-label={t('Pause task')} title={t('Pause {agent}', { agent: agentName(task) })} disabled={taskActionBusy} aria-busy={taskActionBusy} onClick={pause}><Icon name="pause" size={14}/><span className="button-label">{t('Pause')}</span></button> : task.error ? <button className="button secondary compact" onClick={() => { setMobileTab('conversation'); setLayout('conversation'); }}>{t('View details')}</button> : null}
        </div>
  );
  const workspaceViews = task && <div className={'view-selector workspace-view-selector' + (answerOnly ? ' single-view' : '')} role="group" aria-label={t('Workspace view')}>{answerOnly ?
          <button type="button" aria-label={replyNeeded ? t('Chat (reply needed)') : t('Chat')} title={noManuscriptChanges(task) ? t('This conversation has no manuscript changes.') : t('Chat only')} aria-pressed="true"><Icon name="chat" size={16}/><span>{t('Chat')}</span>{replyNeeded && <i className="attention-dot" aria-hidden="true"/>}</button>
        : mobile ? <>
          <button aria-label={pending ? t('Review, {n} to decide', { n: pending }) : t('Review')} aria-pressed={mobileTab === 'review'} onClick={() => selectLayout('review')}><Icon name="paper" size={16}/><span>{t('Review')}</span>{pending > 0 && <b className="view-count" aria-hidden="true">{pending}</b>}</button>
          <button aria-label={replyNeeded ? t('Chat (reply needed)') : t('Chat')} aria-pressed={mobileTab === 'conversation'} onClick={() => selectLayout('conversation')}><Icon name="chat" size={16}/><span>{t('Chat')}</span>{replyNeeded && <i className="attention-dot" aria-hidden="true"/>}</button>
        </> : <>
          <button aria-label={t('Review')} title={t('PDF review only')} aria-pressed={layout === 'review'} onClick={() => selectLayout('review')}><Icon name="paper" size={16}/><span>{t('Review')}</span></button>
          <button aria-label={t('Split')} title={t('Review and chat side by side')} aria-pressed={layout === 'split'} onClick={() => selectLayout('split')}><Icon name="split" size={16}/><span>{t('Split')}</span></button>
          <button aria-label={replyNeeded ? t('Chat (reply needed)') : t('Chat')} title={t('Chat only')} aria-pressed={layout === 'conversation'} onClick={() => selectLayout('conversation')}><Icon name="chat" size={16}/><span>{t('Chat')}</span>{replyNeeded && <i className="attention-dot" aria-hidden="true"/>}</button>
        </>}</div>;
  const taskControls = task && <>{taskStateActions}{workspaceViews}</>;
  const reviewOpen = task && fullPdfUrl ? <a className="icon-button review-open" href={reviewUrl(task)} target="_blank" rel="noreferrer" aria-label={t('Open review in new tab')} title={t('Open review in new tab')}><Icon name="external" size={16}/></a> : null;
  const reviewTools = task && fullPdfUrl ? <>
    <a className="icon-button full-pdf-link" href={fullPdfUrl} target="_blank" rel="noreferrer" aria-label={t('Full PDF')} title={t('Open the full PDF')}><Icon name="pdf" size={16}/></a>
    <CompileButton key={task.id} className="review-rebuild" label={t('Regenerate PDF comparison')} status={task.status === 'building' ? 'building' : task.review?.job?.status === 'failed' || task.review?.state === 'build_failed' ? 'failed' : 'ready'} disabled={['running', 'waiting_input', 'queued', 'building', 'uncertain', 'deleting'].includes(task.status) || taskActionBusy} onCompile={() => action('/tasks/' + task.id + '/publish')}/>
  </> : null;

  // Open or save the compiled PDF, or save it with the notes drawn on it.
  const pdfKey = manuscriptData.data?.build.key, hasNotes = Boolean(pdfKey && manuscriptData.data?.annotations.some(note => note.key === pdfKey));
  // i18n: menu button, shown as a share icon, for opening or exporting the compiled PDF
  const manuscriptShare = project && pdfKey && <ActionMenu label={t('Share')} className="icon-button" actions={[
    { label: t('Open PDF'), icon: 'external', href: `/api/projects/${project.id}/manuscript.pdf?key=${pdfKey}` },
    { label: t('Export PDF'), icon: 'download', href: `/api/projects/${project.id}/manuscript.pdf?key=${pdfKey}&download=1`, download: true },
    { label: t('Export PDF with notes'), icon: 'notes', href: `/api/projects/${project.id}/manuscript/annotated.pdf?key=${pdfKey}`, download: true, disabled: !hasNotes, title: hasNotes ? undefined : t('No notes on this PDF yet') },
  ]}><Icon name="share" size={16}/></ActionMenu>;
  const manuscriptTools = project && <>
    <CompileButton key={project.id} label={t('Recompile PDF')} status={pendingManuscriptBuilds.has(project.id) ? 'building' : manuscriptData.error ? 'unknown' : manuscriptData.data?.build.status || 'unknown'} disabled={!manuscriptData.data && !manuscriptData.error} onCompile={() => loadManuscript(project.id, true)}/>
  </>;
  const manuscriptNavigation = manuscriptOpen && project && <>
    {manuscriptTools}
    <div className="view-selector manuscript-view-selector" role="group" aria-label={t('Manuscript view')}>
          <button aria-label="PDF" data-notes-home="pdf" aria-pressed={manuscriptView === 'pdf'} onClick={() => setManuscriptView('pdf')}><Icon name="pdf" size={16}/><span>PDF</span></button>
          <button aria-label={t('New task')} data-task-home aria-pressed={manuscriptView === 'task'} onClick={() => { setManuscriptView('task'); setRegion(false); }}><Icon name="compose" size={16}/><span>{t('New task')}</span>{noteSelection.selected.length > 0 && <b className="view-count" aria-hidden="true">{noteSelection.selected.length}</b>}</button>
          <button aria-label={t('Contents')} aria-pressed={manuscriptView === 'contents'} onClick={() => { setManuscriptView('contents'); setRegion(false); }}><Icon name="list" size={16}/><span>{t('Contents')}</span></button>
          <button aria-label={projectGit?.files?.length ? t('Git, {n} changed', { n: projectGit.files.length }) : 'Git'} aria-pressed={manuscriptView === 'git'} onClick={() => { setManuscriptView('git'); setRegion(false); }}><Icon name="diff" size={16}/><span>Git</span>{projectGit?.files?.length ? <b className="view-count" aria-hidden="true">{projectGit.files.length}</b> : null}</button>
        </div>
    {manuscriptShare}
  </>;
  const newTaskPanel = (attachments: React.ReactNode) => <section className={'new-task-panel' + (noteSelection.selected.length ? ' has-notes' : '')} aria-label={t('New task')}>
    <div className="new-task-start">
    {!noteSelection.selected.length && <div className="new-task-welcome"><img src={logo} alt=""/><h2>{t('What are we revising next?')}</h2></div>}
    {newSkill?.output !== 'annotations' && attachments}
    <Composer attachments={newSkill?.output === 'annotations' ? undefined : newFiles.draft} upload={(file, signal) => uploadAttachment(project!.id, file, signal)} imageHint={agentChoice === 'antigravity' && newFiles.files.some(file => file.mime.startsWith('image/'))} autoFocus inputRef={newTaskInput} label={t('Describe the revision')} value={newDraft} onChange={setNewDraft} readOnly={creating} onSubmit={() => void createTask()} placeholder={noteSelection.selected.length ? t('Add overall instructions (optional)') : t('Describe the revision')}
      skills={projectSkills} skill={newSkill} onSkill={setNewSkill}
      footer={attach => <div className="composer-options">
        <SkillPicker onAttach={newSkill?.output === 'annotations' ? undefined : attach} skills={projectSkills} selected={newSkill} disabled={creating} onPick={skill => { setNewSkill(skill); newTaskInput.current?.focus(); }}/>
        {agentOptions(creating)}
      </div>}
      action={<button className="send-button" type="submit" aria-label={t('Start task')} title={missingGroupDirections ? t('Add instructions to the selected color groups above.') : t('Start task (Enter)')} disabled={creating || reviewNoteBusy || (newSkill?.output !== 'annotations' && (newFiles.blocked || marking > 0 || noteEditing || missingGroupDirections)) || (!newDraft.trim() && !newSkill && !newFiles.files.length && !noteSelection.selected.some(note => note.comment.trim()) && !Object.keys(groupDirections).length)} aria-busy={creating}>{creating ? <span className="spinner light"/> : <Icon name="arrowUp" size={18}/>}</button>}/>
    {createError && <p className="inline-error" role="alert">{createError}</p>}
    {runtimes[agentChoice]?.usage && <UsageSummary agent={AGENT_LABELS[agentChoice]} usage={runtimes[agentChoice]!.usage!}/>}
    </div>
  </section>;

  return <ViewerContext.Provider value={viewer || null}><NoteResultsProvider task={task} items={task ? timeline.taskId === task.id ? timeline.items : timelineCache.current.get(task.id) || [] : []} read={id => api(`/tasks/${id}/note-results`)} openReview={() => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); }} openChat={() => { setMobileTab('conversation'); setLayout(current => current === 'review' ? 'split' : current); }}><div className={'app-shell' + (sidebarVisible ? '' : ' sidebar-collapsed')}>
    <DesktopWindowChrome/>
    <aside ref={sidebarRef} role={narrow && sidebar ? 'dialog' : undefined} aria-modal={narrow && sidebar ? true : undefined} onKeyDown={e => { if (!narrow || !sidebar || modal || editingPaper) return; if (e.key === 'Escape') { e.preventDefault(); setSidebar(false); } else keepDialogFocus(e); }} id="task-sidebar" className={'sidebar ' + (sidebar ? 'is-open' : '')} aria-label={t('Papers and tasks')}>
      <div className="sidebar-header">
        {state?.projects.length && project ? <ActionMenu label={t('Paper: {name}', { name: project.name })} className="project-switcher" menuClassName="paper-menu" align="start" actions={[
          ...state.projects.map(p => ({ id: p.id, label: p.name, detail: shortPath(p.path), title: p.path, checked: p.id === project.id, select: p.id === project.id ? undefined : () => { setProjectId(p.id); setSelected(''); }, edit: { label: t('Edit {name}', { name: p.name }), select: () => setEditingPaper(p) } })),
          ...(owner ? [{ label: nativeFolders ? t('Open a folder') : t('Add paper…'), icon: nativeFolders ? 'folder' : 'plus', divider: true, select: () => openProject() }] : []),
        ]}><span className="project-switcher-name">{project.name}</span><Icon name="chevronDown" size={13}/></ActionMenu>
          : owner && <button className="add-project" disabled={!state} onClick={() => openProject()}><Icon name={nativeFolders ? 'folder' : 'plus'} size={16}/>{nativeFolders ? t('Open a folder') : t('Add paper')}</button>}
        <button className="icon-button" aria-label={t('Hide task list')} title={t('Hide task list')} onClick={hideSidebar}><Icon name={narrow ? 'close' : 'sidebar'} size={18}/></button>
      </div>
      <div className="sidebar-actions">
        {project && <>
          <button className={'nav-link manuscript-link' + (manuscriptOpen ? ' active' : '')} aria-current={manuscriptOpen ? 'page' : undefined} onClick={() => { setSelected(''); setPage('manuscript'); if (mobile) setManuscriptView('pdf'); setSidebar(false); }}><Icon name="pdf" size={16}/><span className="nav-label">{t('Manuscript')}</span>{gitSummary(projectGit) && <span className="nav-meta" title={t('Git status of the manuscript')}>{gitSummary(projectGit)}</span>}</button>
          <ActionMenu label={t('Paper tools')} className="nav-link paper-tools" menuClassName="paper-tools-menu" align="side" actions={[
            { id: 'references', label: t('Reference check'), icon: 'checklist', detail: t('Citations, entries and their records'), hint: problems ? String(problems) : undefined, checked: referencesOpen || undefined, select: () => { setSelected(''); setPage('references'); setSidebar(false); } },
          ]}><Icon name="tool" size={16}/><span className="nav-label">{t('Tools')}</span><Icon name="more" size={16}/></ActionMenu>
        </>}
      </div>
      <div className="task-list-tools" role="group" aria-label={showArchived ? t('Archived tasks') : t('Tasks')}>
        <div className="task-search"><Icon name="search" size={14}/><input type="search" aria-label={t('Search tasks')} placeholder={showArchived ? t('Search archived tasks…') : t('Search tasks…')} title={t('Search task titles and instructions')} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && taskSearch) { event.preventDefault(); event.stopPropagation(); setTaskSearch(''); } }}/>{taskSearch && <button type="button" className="icon-button" aria-label={t('Clear task search')} onClick={() => { setTaskSearch(''); document.querySelector<HTMLInputElement>('.task-search input')?.focus(); }}><Icon name="close" size={13}/></button>}</div>
        <button type="button" className="icon-button archive-toggle" aria-pressed={showArchived} aria-label={showArchived ? t('Show current tasks') : t('Show archived tasks')} title={showArchived ? t('Show current tasks') : t('Show archived tasks')} onClick={() => setShowArchived(value => !value)}><Icon name="archive" size={15}/></button>
      </div>
      <nav className="task-list" aria-label={t('Task list')}>{visibleTasks.length ? [...visibleTasks].reverse().map(row => <div key={row.id} data-task={row.id} className={'task-row ' + (row.id === selected ? 'active' : '') + (row.id === flyingTask?.id ? ' task-arriving' : '') + (row.id === addedTask?.id ? ' task-added' : '')}>
        {renaming === row.id ? <form className="task-rename" onSubmit={e => { e.preventDefault(); refocus.current = row.id; e.currentTarget.querySelector('input')?.blur(); }}>
          <input name="title" aria-label={t('Rename {name}', { name: row.title })} defaultValue={row.title} maxLength={120} autoFocus onFocus={e => e.currentTarget.select()} onBlur={e => void rename(row, e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); refocus.current = row.id; e.currentTarget.value = row.title; e.currentTarget.blur(); } }}/>
        </form>
        : <button aria-current={row.id === selected ? 'page' : undefined} className={'task-link ' + (row.id === selected ? 'active' : '')} onClick={() => { setSelected(row.id); setSidebar(false); }} onDoubleClick={() => { if (row.status !== 'deleting') setRenaming(row.id); }}><span className="task-title" title={row.title}>{row.title}</span><span className="task-meta"><Status task={row}/><span className="task-time">{ago(row.updatedAt)}</span></span></button>}
        <div className="task-row-actions">
          {row.review?.counts?.pending ? <span className="task-badge" title={tn(row.review.counts.pending, '{n} change to decide', '{n} changes to decide')}>{row.review.counts.pending}</span> : null}
          <ActionMenu label={t('Task actions for {title}', { title: row.title })} actions={[
            ...(row.status === 'deleting' ? [] : [{ label: t('Rename…'), icon: 'pencil', select: () => setRenaming(row.id) }]),
            ...(row.status === 'deleting' ? [] : [{ label: row.titleGeneration === 'pending' ? t('Generating task title…') : row.titleGeneration === 'failed' ? t('Retry title generation') : t('Generate task title'), icon: 'spark', disabled: row.titleGeneration === 'pending' || pendingActions.has('/tasks/' + row.id), select: () => void action('/tasks/' + row.id + '/title') }]),
            ...(row.status === 'deleting' ? [] : [{ label: row.archivedAt ? t('Restore task') : t('Archive task'), icon: row.archivedAt ? 'restore' : 'archive', disabled: pendingActions.has('/tasks/' + row.id), select: () => void archiveTask(row) }]),
            ...(ACTIVE.includes(row.status) ? [{ label: t('Pause task'), icon: 'pause', disabled: pendingActions.has('/tasks/' + row.id), select: () => void action('/tasks/' + row.id + '/interrupt') }] : []),
            ...(row.status === 'uncertain' ? [{ label: t('Check status'), icon: 'refresh', disabled: pendingActions.has('/tasks/' + row.id), select: () => void action('/tasks/' + row.id + '/reconcile') }] : []),
            { label: row.status === 'deleting' ? t('Retry deletion…') : t('Delete task…'), icon: 'trash', danger: true, select: () => setDeleteTarget(row) },
          ]}/>
        </div>
      </div>) : <div className="task-list-empty" role="status">{searchTerms.length ? t('No matching tasks') : showArchived ? t('No archived tasks') : t('No tasks yet')}</div>}</nav>
      <div className="sidebar-footer">
        <div className="sidebar-status">
          {state && (!online || running > 0) && <div className={'host-status' + (online ? '' : ' reconnecting')} role="status" title={online ? t('Connected') : t('Reconnecting')}>
            <span className={'connection-dot' + (online ? ' connected' : '')} aria-hidden="true"/>
            <span className="host-state">{!online ? t('Reconnecting') : tn(running, '{n} active task', '{n} active tasks')}</span>
          </div>}
        </div>
        <div className="brand">
          <a href="/" className="brand-home" aria-label="Papilot" onClick={e => { e.preventDefault(); setSelected(''); setPage('manuscript'); if (mobile) setManuscriptView('pdf'); setSidebar(false); }}><img className="brand-mark" src={logo} alt=""/><span>Papilot</span></a>
          {state && (owner ? <UpdateNotice api={api} version={state.version}/> : <span className="brand-version" title={t('Papilot {version}', { version: state.version })}>v{versionLabel(state.version)}</span>)}
        </div>
        <button type="button" className="icon-button settings-link" aria-label={t('Settings')} title={t('Settings')} aria-haspopup="dialog" onClick={() => setSettings('general')}><Icon name="settings" size={18}/></button>
      </div>
    </aside>
    {sidebar && narrow && <button tabIndex={-1} className="sidebar-scrim" aria-label={t('Close task list')} onClick={() => setSidebar(false)}/>}
    <main className="main" inert={narrow && sidebar}>
      <h1 className="sr-only">{task ? task.title : manuscriptOpen ? t('Manuscript') : referencesOpen ? t('Reference check') : 'Papilot'}</h1>
      {flyingTask && <TaskFlight task={flyingTask} sidebarShown={sidebarShown} onArrive={taskArrived}/>}
      <span className="sr-only" role="status" aria-atomic="true">{addedTask ? t('Task added: {title}', { title: addedTask.title }) : ''}</span>
      {(mobile || (!task && !manuscriptOpen)) && (sidebarToggle || task || manuscriptOpen) && <div className="workspace-navigation">
        {sidebarToggle}{taskControls}{manuscriptNavigation}{reviewOpen}
      </div>}
      {state && !online && <div className="connection-banner" role="status"><Icon name="alert" size={15}/><span>{t('Connection lost. Showing the last update; your draft is kept.')}</span><button onClick={() => void refresh(true)}>{t('Retry connection')}</button></div>}
      {task ? <div className={`task-grid layout-${taskLayout} show-${taskTab}`} style={chatWidth ? { '--chat-width': `${chatWidth}px` } as React.CSSProperties : undefined}>
          {!mobile && taskLayout === 'split' && <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label={t('Resize chat panel')} aria-valuenow={chatWidth || undefined} aria-valuemin={300} tabIndex={0} title={t('Drag to resize · Double-click to reset')} onPointerDown={resizeChat} onDoubleClick={() => setChatWidth(0)} onKeyDown={nudgeChat}/>}
          <section id="review-panel" className="review-panel" aria-label={t('PDF review')}>
          {!mobile && !chatOnly && task.mode !== 'review' && (!task.review?.round || task.status === 'deleting') && (sidebarToggle || !conversationVisible) && <div className="review-placeholder-toolbar">{sidebarToggle}{!conversationVisible && workspaceViews}<div className="panel-tools">{!conversationVisible && taskStateActions}</div></div>}
          {task.status === 'failed' && task.review?.job?.status === 'failed' && <div className="review-build-error" role="status"><Icon name="alert" size={15}/><span>{t('Could not generate the PDF comparison.')}</span><button className="button secondary compact" disabled={taskActionBusy} onClick={() => void action('/tasks/' + task.id + '/publish')}>{t('Retry build')}</button></div>}
          {task.status === 'deleting' ? <div className="review-placeholder"><div className="placeholder-icon"><Icon name="trash" size={22}/></div><h2>{t('Deletion is in progress')}</h2><p>{t('This task is reserved until its worktree cleanup is confirmed. Use Retry deletion if the connection was interrupted.')}</p></div> : task.mode === 'review' ? <AiReviewView key={task.id} task={task} api={api} onCopied={() => void loadManuscript(task.projectId)} lead={!mobile && !chatOnly && (sidebarToggle || !conversationVisible) ? <>{sidebarToggle}{!conversationVisible && workspaceViews}</> : null} tools={!mobile && !conversationVisible ? taskStateActions : null}/> : task.review?.round ? <ReviewFrame key={task.id} task={task} lead={!mobile && !chatOnly && (sidebarToggle || !conversationVisible) ? <>{sidebarToggle}{!conversationVisible && workspaceViews}</> : null} tools={<>{reviewTools}{!mobile && !conversationVisible && <>{taskStateActions}{reviewOpen}</>}</>} completion={chatOnly ? null : applicationStep} onSendNotes={async message => { await api('/tasks/' + task.id + '/messages', message); void refresh(true); }}/> : <PendingComparison task={task} busy={taskActionBusy} onBuild={() => void action('/tasks/' + task.id + '/publish')}/>}
          {!chatOnly && reviewFeedback(false)}
        </section><Activity key={task.id} task={task} lead={!mobile && chatOnly ? sidebarToggle : null} tools={!mobile && conversationVisible ? <>{taskControls}{reviewOpen}</> : null} connection={<AgentConnectionNotice name={agentName(task)} runtime={runtimes[task.agent || 'codex']} reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')}/>} runtime={runtimes[task.agent || 'codex']} reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')} composer={composers.current.get(task.id)!} answerDrafts={answerDrafts.current} items={timeline.taskId === task.id ? timeline.items : timelineCache.current.get(task.id) || []} loading={timeline.taskId === task.id ? itemsLoading : !timelineCache.current.has(task.id)} loadError={timelineError.taskId === task.id ? timelineError.message : ''} retry={() => void refreshTimeline(task.id)} requests={taskRequests} refresh={() => void refresh(true)} reportError={reportError} pause={pause} pausing={taskActionBusy} skills={projectSkills} feedback={chatOnly ? <>{reviewFeedback(true)}{applicationStep && <div className="review-feedback card commit-card task-delivery">{applicationStep}</div>}</> : null} openReview={chatOnly ? () => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); } : undefined}/></div>
      : manuscriptOpen && project ? <ManuscriptView key={project.id + project.path} tasks={state?.tasks.filter(task => task.projectId === project.id) || []} onOpenTask={id => { setSelected(id); setSidebar(false); }} navigation={!mobile ? sidebarToggle : null} project={project} data={manuscriptData.data} error={manuscriptData.error} view={manuscriptView} setView={setManuscriptView} region={region} setRegion={setRegion} active={activeNote} setActive={setActiveNote} actions={noteActions} newTask={newTaskPanel} tools={!mobile ? manuscriptTools : null} share={!mobile ? manuscriptShare : null} onFixProblems={fixProblems} onGit={status => updateGit(project.id, status)} writer={{ agent: agent.agent, model: agent.model }} reportError={reportError}/>
      : referencesOpen && project ? <section className="references-page" aria-label={t('Reference check')}>
          <header className="references-page-head"><h2>{t('Reference check')}</h2><span>{project.name}</span></header>
          <ReferencesPanel key={project.id} place={'references:' + project.id} data={bibliography} onInvestigate={draftInvestigation}/>
        </section>
      : !state ? <div className="home"><div className="home-inner"><div className="home-mark"><span className="spinner"/></div><h1>{t('Opening your workspace')}</h1><p className="home-copy" role="status">{connectionError || t('Connecting to your papers and tasks…')}</p>{connectionError && <button className="button secondary" onClick={() => void refresh(true)}>{t('Retry connection')}</button>}</div></div>
      : !owner ? <div className="home"><div className="home-inner"><img className="home-logo" src={logo} alt=""/><h1>{t('No papers yet')}</h1><p className="home-copy">{t('No papers have been shared with you yet. Papers appear here as soon as {name} shares them.', { name: viewer?.owner || '' })}</p></div></div>
      : <div className="home"><div className="home-inner"><img className="home-logo" src={logo} alt=""/><h1>{t('Add your first paper')}</h1><button className="button primary" onClick={() => openProject()}><Icon name={nativeFolders ? 'folder' : 'plus'} size={16}/>{nativeFolders ? t('Open a folder') : t('Add paper')}</button></div></div>}
    </main>
    {error && !modal && <div role="alert" className="toast"><Icon name="alert" size={16}/><span>{error}</span><button className="icon-button" aria-label={t('Dismiss error')} onClick={() => setError('')}><Icon name="close" size={14}/></button></div>}
    {settings && <SettingsDialog modelDefaults={{ agents: offered.map(id => ({ value: id, label: AGENT_LABELS[id], runtime: runtimes[id] })), agent: agentChoice, model: agent.model, effort: agent.effort, onSelect: chooseModel, onEffort: effort => remember({ effort }) }} updates={owner ? api : undefined} initialPage={settings} theme={theme.theme} onTheme={theme.setTheme} resolved={theme.resolved} appearance={theme.appearance} onAppearance={theme.setAppearance} onClose={() => setSettings(false)} people={owner ? { api, projects: state?.projects || [], ago: agoText } : undefined} onSignOut={viewer?.listener === 'account' ? () => { setSettings(false); void signOut(); } : undefined} accountName={viewer?.name} diagnostics={owner ? { online, runtimes, project, check: checkDiagnostics, latex: detectLatexInstallation, reconnect: async () => { await api('/reconnect', {}); await refresh(true); } } : undefined} skills={owner ? { project, api, onChanged: () => setSkillsRevision(value => value + 1) } : undefined}/>}
    {deleteTarget && <DeleteTaskDialog task={state?.tasks.find(t => t.id === deleteTarget.id) || deleteTarget} submit={() => api('/tasks/' + deleteTarget.id + '/delete', { confirm: true })} onClose={() => setDeleteTarget(null)} onDeleted={() => taskDeleted(deleteTarget.id)} refresh={() => void refresh(true)}/>}
    {editingPaper && <PaperDialog key={editingPaper.id} paper={editingPaper} canManage={owner} onClose={() => setEditingPaper(null)} save={async form => {
      const paper = editingPaper, pathChanged = owner && form.path !== paper.path;
      await api(`/projects/${paper.id}/${pathChanged ? 'path' : 'rename'}`, pathChanged ? form : { name: form.name });
      if (pathChanged) { ++manuscriptRequest.current; setManuscript({ projectId: '', data: null, error: '' }); setGit({ projectId: '', status: null }); }
      await refresh(true);
      if (pathChanged && project?.id === paper.id && manuscriptOpen) await loadManuscript(paper.id);
    }} remove={async () => {
      const paper = editingPaper;
      await api(`/projects/${paper.id}/remove`, {});
      if (task?.projectId === paper.id) setSelected('');
      snapshotText.current = '';
      setState(previous => previous ? { ...previous, projects: previous.projects.filter(p => p.id !== paper.id), tasks: previous.tasks.filter(t => t.projectId !== paper.id) } : previous);
      await refresh(true);
    }}/>}
    {mainChoice && <MainFileDialog key={mainChoice.path} name={mainChoice.name} candidates={mainChoice.candidates} open={main => openFolder(mainChoice.path, main)} onClose={() => setMainChoice(null)}/>}
    {openingFolder && !mainChoice && <div role="status" className="toast toast-status"><span className="spinner"/><span>{t('Reading paper files…')}</span></div>}
    {modal && <ImportDialog api={api} agent={agentChoice} canRepair={Object.values(runtimes).some(runtime => runtime?.connected && runtime.authenticated)} onClose={() => setModal(null)} onDone={async paper => {
      await refresh(true);
      setProjectId(paper.id); setSelected(''); setModal(null); setSidebar(false);
    }}/>}

  </div></NoteResultsProvider></ViewerContext.Provider>;
}

// The public URL shows the sign-in page to anyone without a session, and an
// invite link its own page; the workspace mounts only once signed in.
function Root() {
  const signedOut = useSignedOut();
  const [inviting, setInviting] = useState(location.pathname === '/invite');
  const signedIn = () => { setInviting(false); setSignedOut(false); };
  if (inviting) return <Invite api={api} onDone={signedIn}/>;
  return signedOut ? <SignIn api={api} onSignedIn={signedIn}/> : <App/>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root/></StrictMode>);
