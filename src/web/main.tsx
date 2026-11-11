import { TaskDocument } from './task-document.tsx';
import { requestApi, requestState } from './api.ts';
import { agentsSettled, chosenAgent, noAgent, offeredAgents } from './agent-choice.ts';
import { isPlayground, pdfAsset, wordAsset, requestPlaygroundDownload } from './playground-mode.ts';
import { canonicalGroup, groupsWithoutInstructions, noteGroups, type NoteGroup } from '../note-groups.ts';
import { GroupCard, GroupInstruction } from './note-groups.tsx';
import { useNoteSelection } from './note-selection.tsx';
import { useGroupInstructions } from './group-instructions.ts';
import { markText, NoteQuote } from './note-content.tsx';
import { NoteAttachButton, PdfNoteCard, TaskRemoveButton } from './pdf-suggestion.tsx';
import { StrictMode, Suspense, lazy, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { readNotesInstructions, type NoteSummary } from '../notes.ts';
import { aiReviewSummary, isFeedbackPrompt } from '../conversation.ts';
import { ignorePattern } from '../commit.ts';
import { AGENT_IDS, AGENT_NAMES, isAgentId, taskFinished } from '../shared.ts';
import type { TaskCommitReview, LatexInstallation, AgentId, Annotation, MarkKind, Author, FeedbackSummary, GitDiff, GitFile, GitOverview, GitStatus, Manuscript, ManuscriptProblems, PendingRequest, Project, RuntimeStatus, Skill, Snapshot, Task, TimelineItem } from '../shared.ts';
import { SkillChip, SkillMenu, SkillPicker, matchSkills, skillName, skillQuery } from './skills.tsx';
import { reviewDraft, useReviewDraft, reviewNoteSummary, reviewSubmission } from './review-draft.ts';
import { ReviewDraftCards } from './review-draft-cards.tsx';
import { ComposerDraft, sendsMessage, taskTitle, pendingReviewFeedback } from './composer.ts';
import { DraftAttachments, MessageAttachments, useAttachmentDraft } from './attachments.tsx';
import { type AttachmentDraft, type UploadAttachment } from './attachment-draft.ts';
import type { Attachment } from '../shared.ts';
import { noteLocation } from './note-location.ts';
import { ReadRequest, canStreamUpdates, mergeTimeline, visibleTimeline } from './refresh.ts';
import { browserStorage } from './storage.ts';
import { requestId } from './request-id.ts';
import { readPlace, savePlace } from './places.ts';
import { ModeSwitch, type PdfMode } from './mode-switch.tsx';
import { ReviewFrame, reviewUrl, type ReviewSources } from './review-frame.tsx';
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
import { useSourceEdit } from './source-panel.tsx';
import { useTheme } from './theme.tsx';
import { SettingsDialog, type SettingsInitialPage } from './settings.tsx';
import { WorkspaceSwitcher } from './workspace-switcher.tsx';
import { workspaceModifier, workspaceShortcutLabel } from './workspace-switch.ts';
import { useSystemRequirements, missingTools, RequirementsBanner } from './system-requirements.tsx';
import { connectStamps } from './stamps.ts';
import { connectIndirectChanges } from './effect-preferences.ts';
import { connectNoteAlternatives } from './note-option-preferences.ts';
import { connectNoteLocation } from './review-notes.tsx';
import type { DiagnosticReport, SystemRequirements } from '../shared.ts';
import { CommitDialog } from './commit-dialog.tsx';
import { TaskCommit } from './task-commit.tsx';
import { TaskCommitDraft } from './task-commit-draft.ts';
import { TaskConflict } from './task-conflict.tsx';
import { TaskApply } from './task-apply.tsx';
import { TaskApplyState } from './task-apply-state.ts';
import { taskSaveStatus } from './task-save-status.ts';
import { TaskSaved } from './task-saved.tsx';
import { GitRepository } from './git-overview.tsx';
import { useAdvancedGit } from './git-preferences.ts';
import { GitDiffView } from './git-diff-view.tsx';
import { VersionHistory, type HistorySelection } from './git-history.tsx';
import type { GitHistory, GitVersionDetail } from '../shared.ts';
import { problemCount, ReferencesPanel, useBibliography } from './references-panel.tsx';
import { errorText, locale, t, tn, useLanguage } from './i18n.ts';
import { notificationState, notify, notifying, subscribeNotifications, taskAlerts } from './notifications.ts';
import { Markdown } from './markdown.tsx';
import { ComparisonProgress } from './comparison-progress.tsx';
import logo from './logo.svg';
import { AgentConnectionNotice, AgentPicker, NoAgentNotice } from './agent-picker.tsx';
import { taskEffort } from './task-effort.ts';
import { PermissionOptions, TaskPermissionOptions } from './task-permissions.tsx';
import { type TaskPermissions } from '../shared.ts';
import { TaskModelPicker } from './task-model-picker.tsx';
import { TaskFlight, type TaskFlightData } from './task-flight.tsx';
import { returnNotes } from './note-flight.ts';
import { UsageSummary } from './usage.tsx';
import { useNoteUndo } from './use-note-undo.ts';
import { NoteResultsProvider, useNoteResults } from './note-results.tsx';
import { usePanelWidth } from './panel-width.tsx';
import type { OutlineItem, PdfHandle, PdfHistoryActions, Rect } from './pdf-view.tsx';
// pdf.js is large, so the PDF view loads the first time it opens.
const PlaygroundNotice = import.meta.env.MODE === 'playground' ? lazy(() => import('./playground/notice.tsx').then(module => ({ default: module.PlaygroundNotice }))) : null;
const PlaygroundPresets = import.meta.env.MODE === 'playground' ? lazy(() => import('./playground/preset-tasks.tsx').then(module => ({ default: module.PlaygroundPresets }))) : null;
const PlaygroundProgress = import.meta.env.MODE === 'playground' ? lazy(() => import('./playground/progress.tsx').then(module => ({ default: module.PlaygroundProgress }))) : null;
const PdfView = lazy(() => import('./pdf-view.tsx').then(module => ({ default: module.PdfView })));
import './style.css';
import './note-controls.css';

let token = '';
const uuid = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2, '0')).join('');
async function api<T = any>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (import.meta.env.MODE === 'playground') return (await import('./playground/api.ts')).playgroundApi<T>(route, body, signal);
  return requestApi<T>(route, token, body, signal);
}
connectStamps(api);
connectIndirectChanges(api);
connectNoteAlternatives(api);
connectNoteLocation(api);
const uploadAttachment = (projectId: string, file: File, signal: AbortSignal) => api<Attachment>(`/projects/${projectId}/attachments`, file, signal);
const detectLatexInstallation = (signal: AbortSignal) => api<LatexInstallation | null>('/runtime/latex', undefined, signal);
const loadRequirements = (signal: AbortSignal) => api<SystemRequirements>('/runtime/requirements', undefined, signal);
const checkDiagnostics = (projectId: string | undefined, signal: AbortSignal) => api<DiagnosticReport>('/diagnostics', { projectId }, signal);
const AGENT_LABELS = AGENT_NAMES;
const agentName = (task: Task) => AGENT_LABELS[task.agent || 'codex'] || 'Codex';
// A finished publication with no round is a valid answer-only result. Keep
// earlier comparisons available when a follow-up answer makes no new edits.
const noManuscriptChanges = (task: Task) => task.status === 'reviewing' && task.review?.round === null && task.review.state !== 'build_failed' && !task.review.counts.pending;
const statusNames = (): Record<string, string> => ({ preparing: t('Preparing…'), idle: t('Ready'), queued: t('Queued'), waiting_input: t('Needs your reply'), building: t('Preparing task results'), reviewing: t('Ready for review'), interrupted: t('Paused'), failed: t('Needs attention'), uncertain: t('Check task status'), deleting: t('Deleting task') });
const ACTIVE = ['running', 'waiting_input', 'queued'];
// A new task is saved at once and gets its manuscript copy in the background.
const preparingLabel = (task: Task) => task.mode === 'review' ? t('Preparing the review PDF…') : t('Preparing…');
function Status({ task }: { task: Task }) {
  const answered = noManuscriptChanges(task), done = task.status === 'reviewing' && task.review?.state === 'done';
  const saved = taskSaveStatus(task);
  return <span className={`status ${task.status}${done || answered ? ' done' : ''}`}><i/>{saved === 'pushed' ? t('Committed and pushed') : saved === 'committed' ? t('Committed') : saved === 'applied' ? t('Applied to manuscript') : answered ? t('Completed') : done ? t('Review complete') : task.status === 'running' ? t('{agent} is working', { agent: agentName(task) }) : task.status === 'preparing' ? preparingLabel(task) : task.status === 'building' && task.review?.ready ? t('Ready for review') : statusNames()[task.status] || task.status}</span>;
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
function Composer({ label, value, placeholder, onChange, onSubmit, readOnly, autoFocus, inputRef, footer, action, large, skills, skill, onSkill, attachments, upload, filesDisabled, imageHint, reviewContent }: { reviewContent?: React.ReactNode; label: string; value: string; placeholder: string; onChange: (value: string) => void; onSubmit: () => void; readOnly?: boolean; autoFocus?: boolean; inputRef?: React.RefObject<HTMLTextAreaElement | null>; footer: React.ReactNode | ((attach: () => void) => React.ReactNode); action: React.ReactNode; attachments?: AttachmentDraft; upload?: UploadAttachment; filesDisabled?: boolean; imageHint?: boolean; large?: boolean; skills?: Skill[]; skill?: Skill | null; onSkill?: (skill: Skill | null) => void }) {
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
    {reviewContent}
    {attachments && upload && <><input ref={fileInput} type="file" multiple hidden aria-label={t('Choose attachments')} disabled={!canAttach} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }}/><DraftAttachments draft={attachments} upload={upload} discard={file => { void api(`/projects/${file.projectId}/attachments/${file.id}/discard`, {}).catch(() => {}); }} disabled={readOnly || filesDisabled}/></>}
    {dragging && <div className="attachment-drop-hint">{t('Drop files to attach')}</div>}
    {imageHint && <p className="attachment-agent-hint">{t('Antigravity opens images through its file tools. For direct image input, choose Codex or Claude.')}</p>}
    {open && <SkillMenu id={menuId} skills={matches} active={active} onActive={setActive} onPick={pick}/>}
    {skill && <div className="composer-skill"><SkillChip skill={skill} onRemove={onSkill && !readOnly ? () => { onSkill(null); input.current?.focus(); } : undefined}/></div>}
    <textarea ref={input} rows={1} aria-label={label} placeholder={skill ? (skill.source !== 'builtin' && skill.hint) || t('Details (optional)') : placeholder} value={value} readOnly={readOnly} onChange={e => onChange(e.target.value)} onKeyDown={keyDown}
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

// Preserve names on historical messages from formerly shared workspaces.
const senderOf = (author: Author | undefined) => ({ mine: !author, name: author?.name || '' });

const senderLabel = (sender: { mine: boolean; name: string }, at: number) => sender.mine ? t('You, {time}', { time: time(at) }) : t('{name}, {time}', { name: sender.name, time: time(at) });
const SenderName = ({ sender }: { sender: { mine: boolean; name: string } }) => sender.mine ? null : <div className="message-author">{sender.name}</div>;

// A first message built from PDF notes shows the notes, not the instructions around them.
function NotesMessage({ item, notes }: { item: TimelineItem; notes: NoteSummary[] }) {
  const sender = senderOf(item.meta?.author);
  const results = useNoteResults();
  const renderNote = (note: NoteSummary, index: number) => <li key={index} data-note-result={`${item.id}:${index}`} tabIndex={0}
    onClick={event => { if (!(event.target as Element).closest('button, input, textarea, a, [role="radiogroup"]')) results?.focusNote(`${item.id}:${index}`); }}
    onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); results?.focusNote(`${item.id}:${index}`); } }} className={results?.selected === `${item.id}:${index}` ? 'linked-note-selected' : ''}>
      <span className="sent-note-where"><span className="sent-note-number" aria-hidden="true">{index + 1}</span><span className="sent-note-location">{noteLocation(note.where)}</span></span>
      {note.quote ? <blockquote data-kind={note.kind}>{note.quote}</blockquote> : <span className="sent-note-region">{t('Marked region')}</span>}
      {(note.comment || note.kind === 'delete') && <p>{note.stamp && <span className="pdf-note-stamp"><Icon name="spark" size={12}/>{note.stamp}</span>}{markText(note)}</p>}
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
    {item.meta?.feedback && <details className="feedback-attachment"><summary><Icon name="paper" size={13}/>{t('With review feedback')}</summary><FeedbackDetails feedback={item.meta.feedback}/></details>}
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
  const sender = senderOf(item.meta?.author);
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
  if (PlaygroundProgress && item.type === 'demo-progress') return <Suspense fallback={null}><PlaygroundProgress item={item}/></Suspense>;
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
  const message = (item: TimelineItem) => item.type === 'user' || item.type === 'assistant' || (isPlayground && item.type === 'demo-progress');
  for (const item of items) {
    const last = entries[entries.length - 1];
    if (!message(item) && last && !message(last[0])) last.push(item); else entries.push([item]);
  }
  return entries;
}

function Activity({ onRevealQuote, task, runtime, reconnecting, onReconnect, skills, composer, answerDrafts, items, loading, loadError, retry, requests, refresh, onTaskSaved, reportError, pause, pausing, openReview, feedback, connection, tools, lead, errorActions }: { errorActions?: React.ReactNode; tools?: React.ReactNode; lead?: React.ReactNode; onRevealQuote: () => void; task: Task; runtime?: RuntimeStatus; reconnecting: boolean; onReconnect: () => void; skills: Skill[]; composer: ComposerDraft; answerDrafts: Map<string, Record<string, string>>; items: TimelineItem[]; loading: boolean; loadError: string; retry: () => void; requests: PendingRequest[]; refresh: () => void; onTaskSaved: (task: Task) => void; reportError: (e: unknown) => void; pause: () => void; pausing: boolean; openReview?: () => void; feedback?: React.ReactNode; connection?: React.ReactNode }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const reviewNotes = reviewDraft(task.id), notes = useReviewDraft(task.id);
  const [savingModel, setSavingModel] = useState(false);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const { text: draft, sending } = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const files = useAttachmentDraft(`papilot:files:task:${task.id}`);
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
  const feedbackCount = task.mode === 'review' ? 0 : pendingReviewFeedback(task.review);
  const readyReview = reviewSubmission(notes, draft, skill?.id);
  const emptyNotes = notes.notes.length - readyReview.notes.length;
  const canSend = Boolean(draft.trim() || skill || files.files.length || readyReview.notes.length || readyReview.instructions.trim() || feedbackCount);
  async function submit() {
    if (savingPermissions || savingModel || composer.sending || ['uncertain', 'deleting'].includes(task.status) || task.preparation || files.draft.getSnapshot().blocked) return;
    if (isPlayground && canSend) { requestPlaygroundDownload(); return; }
    const submitted = reviewSubmission(reviewNotes.getSnapshot(), composer.text, skill?.id), attached = files.draft.getSnapshot().files;
    const source = !composer.text.trim() && !skill && !attached.length && !submitted.notes.length && !submitted.instructions.trim() && feedbackCount ? 'feedback' : 'draft';
    reviewNotes.setBusy(true);
    try {
      if (await composer.submit(source, message => api('/tasks/' + task.id + '/messages', message), skill?.id, attached.map(file => file.id), submitted.notes.map(reviewNoteSummary), submitted.instructions)) {
        reviewNotes.clear(submitted); files.draft.clear(attached); shouldFollow.current = true;
        if (skill) setSkill(current => current === skill ? null : current);
        refresh();
      }
    } catch (e) { reportError(e); }
    finally { reviewNotes.setBusy(false); }
  }
  const active = ACTIVE.includes(task.status), blocked = ['uncertain', 'deleting'].includes(task.status);
  // The draft re-renders this panel on every keystroke; the same elements let
  // React skip the conversation until its items change.
  const agent = agentName(task), review = task.mode === 'review', root = task.worktree;
  const thread = useMemo(() => timelineEntries(visibleTimeline(items).filter(item => item.type !== 'reviewOutput').map(item => review && item.type === 'assistant' ? { ...item, text: aiReviewSummary(item.text) } : item))
    .map(entry => entry.length > 1 ? <ToolGroup key={entry[0].id} items={entry} agent={agent} root={root}/> : <TimelineEntry key={entry[0].id} item={entry[0]} agent={agent} root={root}/>), [items, review, agent, root]);
  const hint = task.status === 'deleting' ? t('This task is being deleted') : task.status === 'uncertain' ? t('Check task status before sending') : task.preparation ? t('Send more instructions once the task has started.') : sending ? t('Sending…')
    : emptyNotes ? canSend ? tn(emptyNotes, '{n} empty comment will stay in drafts', '{n} empty comments will stay in drafts') : t('Write a comment or message to send.') : active ? t('{agent} is working · new instructions run next', { agent: agentName(task) }) : '';
  return <section id="conversation-panel" className="activity-panel" aria-label={t('{agent} conversation', { agent: agentName(task) })}><div className="panel-heading">{lead}{tools && <div className="panel-tools">{tools}</div>}</div>
    <div className="conversation-history"><div className="messages" ref={scroller} onScroll={() => { if (scroller.current && back.current === undefined) { const el = scroller.current; shouldFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setFollowing(shouldFollow.current); savePlace(place, shouldFollow.current ? undefined : Math.round(el.scrollTop)); } }}><div className="thread">
      {loading && <p className="muted" role="status">{t('Loading conversation…')}</p>}
      {loadError && <div className="conversation-error" role="alert"><p>{loadError}</p><button className="button secondary compact" onClick={retry}>{t('Retry conversation')}</button></div>}
      {thread}
      {requests.map(r => <RequestCard key={r.id} request={r} agent={agentName(task)} answerDrafts={answerDrafts} onDone={refresh}/>)}
      {task.status === 'running' && <div className="working"><span className="working-dots"><i/><i/><i/></span>{t('{agent} is working on this task', { agent: agentName(task) })}</div>}
      {task.status === 'queued' && <p className="muted">{t('Task saved. Waiting for an available {agent} session.', { agent: agentName(task) })}</p>}
      {task.status === 'preparing' && <p className="muted" role="status">{preparingLabel(task)}</p>}
      {openReview && task.status === 'reviewing' && task.review?.counts?.pending ? <div className="review-ready"><Icon name="paper" size={16}/><span>{tn(task.review.counts.pending, '{n} change to review', '{n} changes to review')}</span><button className="button secondary compact" onClick={openReview}>{t('Open review')}</button></div> : null}
      {feedback}
      {task.error && <div className="task-error"><Icon name="alert" size={16}/><div><strong>{t('This step needs attention')}</strong><p>{errorText(task.error)}</p>{errorActions}</div></div>}
    </div></div>{!following && <button className="jump-latest" onClick={latest}><Icon name="arrowDown" size={14}/>{t('Latest messages')}</button>}</div>
    <div className="composer-wrap">
      {connection}
      <Composer reviewContent={<ReviewDraftCards task={task} feedbackCount={feedbackCount} onReveal={onRevealQuote}/>} attachments={task.mode === 'review' ? undefined : files.draft} upload={(file, signal) => uploadAttachment(task.projectId, file, signal)} filesDisabled={sending || blocked} imageHint={task.agent === 'antigravity' && files.files.some(file => file.mime.startsWith('image/'))} inputRef={input} label={t('Instructions for {agent}', { agent: agentName(task) })} value={draft} onChange={value => composer.edit(value)} onSubmit={() => void submit()} placeholder={task.mode === 'review' ? t('Ask for another review of this PDF version…') : active ? t('Queue instructions for the next turn…') : notes.notes.length || feedbackCount ? t('Add overall instructions (optional)') : t('Ask a question or request changes…')} skills={task.mode === 'review' ? [] : skills.filter(skill => skill.output !== 'annotations')} skill={skill} onSkill={setSkill}
        footer={attach => <div className="composer-options">
          {task.mode !== 'review' && <SkillPicker onAttach={attach} skills={skills.filter(skill => skill.output !== 'annotations')} selected={skill} disabled={sending || blocked} onPick={value => { setSkill(value); input.current?.focus(); }}/>}
          <TaskModelPicker task={task} runtime={runtime} disabled={sending || blocked || savingPermissions} reconnecting={reconnecting} onReconnect={onReconnect} save={settings => api<Task>(`/tasks/${task.id}/model`, settings)} onSaving={setSavingModel} refresh={refresh} reportError={reportError}
            permissions={<TaskPermissionOptions task={task} runtime={runtime} disabled={sending || blocked || savingModel} save={permissions => api<Task>(`/tasks/${task.id}/permissions`, { permissions })} onSaved={onTaskSaved} onSaving={setSavingPermissions} refresh={refresh} reportError={reportError}/>}/>
        </div>}
        action={<div className="composer-actions">
          {active && <button type="button" className="send-button stop" aria-label={t('Pause task')} title={t('Pause {agent}', { agent: agentName(task) })} disabled={pausing} aria-busy={pausing} onClick={pause}><Icon name="stop" size={18}/></button>}
          {(!active || draft.trim() || skill || files.entries.length || notes.notes.length || feedbackCount || sending) && <button aria-label={t('Send instructions')} title={t('Send (Enter) · New line (Shift+Enter)')} disabled={!canSend || files.blocked || sending || savingModel || savingPermissions || blocked || Boolean(task.preparation)} className="send-button" type="submit"><Icon name="arrowUp" size={18}/></button>}
        </div>}/>
      {hint && <p className="composer-hint" role="status">{hint}</p>}
    </div>
  </section>;
}

// Shorten an absolute repository path to its last folders for menus.
function shortPath(value: string) {
  const normalized = value.replaceAll('\\', '/'), parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : normalized;
}
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
type GitSelection = { path: string; list: 'staged' | 'changes' } | HistorySelection;
const gitNames = (): Record<string, string> => ({ M: t('Modified'), A: t('Added'), D: t('Deleted'), R: t('Renamed'), C: t('Copied'), U: t('Conflict'), '?': t('Untracked'), T: t('Type changed') });

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

function GitWorkspace({ projectId, navigation, git, onStatus, writer, tasks, onOpenTask }: { navigation?: React.ReactNode; tasks: Task[]; onOpenTask: (id: string) => void; projectId: string; git: GitStatus | null; onStatus: (status: GitStatus) => void; writer: CommitWriter }) {
  const advanced = useAdvancedGit();
  const loadOverview = useCallback((signal: AbortSignal) => api<GitOverview>(`/projects/${projectId}/git/overview`, undefined, signal), [projectId]);
  const loadHistory = useCallback((before: string | null, signal: AbortSignal) => api<GitHistory>(`/projects/${projectId}/git/history${before ? '?before=' + before : ''}`, undefined, signal), [projectId]);
  const loadVersion = useCallback((hash: string, signal: AbortSignal) => api<GitVersionDetail>(`/projects/${projectId}/git/history/${hash}`, undefined, signal), [projectId]);
  const draftKey = `papilot:commit:${projectId}`;
  const [message, setMessage] = useState(() => browserStorage.getItem(draftKey) || '');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [resolution, setResolution] = useState<{ agent: string; summary: string } | null>(null);
  const [discarding, setDiscarding] = useState<GitFile[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<'changes' | 'history'>(() => readPlace('git-view:' + projectId) === 'history' ? 'history' : 'changes');
  const showDetail = (value: 'changes' | 'history') => { setDetail(value); savePlace('git-view:' + projectId, value); };
  const [source, setSource] = useState<GitSelection | null>(() => readPlace<GitSelection>('git-selection:' + projectId) || { path: '', list: 'changes' });
  const [diffRefresh, setDiffRefresh] = useState(0), [historyRefresh, setHistoryRefresh] = useState(0);
  const sourceOpener = useRef<HTMLElement | null>(null);
  const selectSource = (value: GitSelection | null) => { setSource(value); savePlace('git-selection:' + projectId, value); };
  const onOpenDiff = (value: GitSelection) => { sourceOpener.current = document.activeElement as HTMLElement | null; selectSource(value); showDetail('changes'); setDiffRefresh(value => value + 1); };
  const closeSource = () => { if (source?.list === 'history') { showDetail('history'); selectSource({ path: '', list: 'changes' }); } requestAnimationFrame(() => { if (sourceOpener.current?.isConnected) sourceOpener.current.focus({ preventScroll: true }); }); };
  const historyHash = source?.list === 'history' ? source.hash : null;
  const loadDiff = useCallback((path: string, signal: AbortSignal) => api<GitDiff>(historyHash ? `/projects/${projectId}/git/history/${historyHash}/diff?path=${encodeURIComponent(path)}` : `/projects/${projectId}/git/diff?path=${encodeURIComponent(path)}&scope=${source?.list === 'staged' ? 'staged' : 'unstaged'}`, undefined, signal), [projectId, historyHash, source?.list]);
  useEffect(() => {
    if (!git || source?.list === 'history') return;
    const file = git.files.find(file => file.path === source?.path) || git.files[0];
    if (!file) { if (source) selectSource(null); }
    else {
      const list = !git.merging && file.staged && (!file.unstaged || source?.list === 'staged') ? 'staged' : 'changes';
      if (source?.path !== file.path || source?.list !== list) selectSource({ path: file.path, list });
    }
  }, [git, source]);
  const selection = source;
  const latest = useRef({ busy, onStatus });
  latest.current = { busy, onStatus };
  // Discover incoming commits while this panel is visible; status alone only
  // sees the last fetched tracking ref. Fetch never changes manuscript files.
  useEffect(() => {
    if (!git?.remote) return;
    const controller = new AbortController();
    let fetching = false, checkedAt = 0;
    const check = async () => {
      if (document.hidden || latest.current.busy || fetching || Date.now() - checkedAt < 60_000) return;
      fetching = true; checkedAt = Date.now();
      try {
        const result = await api<{ git: GitStatus }>(`/projects/${projectId}/git/fetch`, {}, controller.signal);
        if (!controller.signal.aborted && !latest.current.busy) latest.current.onStatus(result.git);
      } catch { /* A manual sync reports network or authentication failures. */ }
      finally { fetching = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [projectId, git?.remote]);
  const files = git?.files || [];
  if (!git || !Array.isArray(git.files)) return <section className="git-workspace" aria-label={t('Version Management')}><div className="git-toolbar">{navigation}</div><p className="git-clean" role="status">{t('Loading version management…')}</p></section>;
  const staged = files.filter(file => file.staged), unstaged = files.filter(file => file.unstaged), chosen = staged.length ? staged : files.filter(file => !ignorable(file));
  const stage = (paths: string[], on: boolean) => { if (paths.length) void run('stage', () => api<{ git: GitStatus }>(`/projects/${projectId}/git/stage`, { paths, stage: on }), () => ''); };
  const saveMessage = (value: string) => { setMessage(value); if (value) browserStorage.setItem(draftKey, value); else browserStorage.removeItem(draftKey); };
  async function run<R extends { git: GitStatus }>(action: string, work: () => Promise<R>, done: (result: R) => string) {
    if (busy) return;
    setBusy(action); setError(''); setNotice('');
    try { const result = await work(); onStatus(result.git); setNotice(done(result)); setDiffRefresh(value => value + 1); }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A remote operation can fetch or commit before failing. Keep the
      // current counts, pending edits and conflict controls available.
      try { onStatus(await api<GitStatus>(`/projects/${projectId}/git`)); } catch { /* Keep the original failure. */ }
    }
    finally { setBusy(''); }
  }
  const merging = git.merging, publish = !git.upstream && git.remote && git.branch;
  const canPush = Boolean(git.remote && (git.upstream || publish) && !merging);
  const canSync = Boolean(canPush && git.branch);
  const synchronize = () => api<{ git: GitStatus }>(`/projects/${projectId}/git/sync`, {});
  const syncNotice = (status: GitStatus) => status.merging ? t('The merge stopped at conflicts.') : t('Synced with the remote. Uncommitted changes are kept.');
  const syncRemote = () => void run('sync', synchronize, result => syncNotice(result.git));
  // A failed sync or push leaves the successful local commit in place.
  const commit = (action: 'commit' | 'sync' | 'push' | 'amend' = 'commit') => {
    const text = message.trim();
    if (!text || !chosen.length) return;
    void run('commit', async () => {
      const result = await api<{ git: GitStatus; commit: string }>(`/projects/${projectId}/git/commit`, { ...(staged.length ? { message: text, staged: true } : { message: text, paths: chosen.map(file => file.path) }), ...(action === 'amend' ? { amend: true } : {}) });
      saveMessage('');
      if (action !== 'push' && action !== 'sync') return result;
      onStatus(result.git);
      setBusy(action);
      return { ...await (action === 'sync' ? synchronize() : api<{ git: GitStatus }>(`/projects/${projectId}/git/push`, {})), commit: result.commit };
    }, result => action === 'sync' ? (result.git.merging ? t('Committed {hash}.', { hash: result.commit }) + ' ' + t('The merge stopped at conflicts.') : t('Committed {hash} and synced.', { hash: result.commit }))
      : action === 'push' ? t('Committed {hash} and pushed.', { hash: result.commit }) : t('Committed {hash}.', { hash: result.commit }));
  };
  // Like Cursor's generate button: the chosen agent reads the chosen files' changes.
  // An empty box takes a message already written for them; a full one asks for a new one.
  async function generate() {
    if (busy || !chosen.length) return;
    setBusy('message'); setError(''); setNotice('');
    try { saveMessage((await api<{ message: string }>(`/projects/${projectId}/git/message`, { paths: chosen.map(file => file.path), staged: staged.length > 0, agent: writer.agent, fresh: Boolean(message.trim()) })).message); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }
  const discard = (list: GitFile[]) => { setDiscarding(null); void run('discard', () => api<{ git: GitStatus }>(`/projects/${projectId}/git/discard`, { paths: list.map(file => file.path) }), () => tn(list.length, 'Discarded changes in {n} file.', 'Discarded changes in {n} files.')); };
  const reload = () => void run('reload', async () => ({ git: await api<GitStatus>(`/projects/${projectId}/git`) }), () => '');
  const ignored = files.filter(ignorable), patterns = [...new Set(ignored.map(file => ignorePattern(file.path)))];
  const ignore = () => void run('ignore', () => api(`/projects/${projectId}/git/ignore`, { paths: ignored.map(file => file.path) }), () => tn(patterns.length, 'Added {n} pattern to .gitignore.', 'Added {n} patterns to .gitignore.'));
  const remote = (action: 'fetch' | 'pull' | 'merge' | 'push') => void run(action, () => api<{ git: GitStatus }>(`/projects/${projectId}/git/${action}`, {}),
    result => action === 'fetch' ? (result.git.behind ? tn(result.git.behind, '{n} new commit on {upstream}.', '{n} new commits on {upstream}.', { upstream: result.git.upstream ?? '' }) : t('Up to date with the remote.'))
      : action === 'pull' ? t('Pulled the latest commits.')
      : action === 'merge' ? (result.git.merging ? t('The merge stopped at conflicts.') : t('Merged {upstream}.', { upstream: git.upstream ?? '' }))
      : result.git.upstream ? t('Pushed to {upstream}.', { upstream: result.git.upstream }) : t('Pushed to the remote.'));
  // A branch and its upstream that have both moved on are merged; conflicts
  // go to an agent, then the author reads the diffs and commits the merge.
  const diverged = Boolean(git.upstream && git.ahead > 0 && git.behind > 0 && !merging);
  const resolve = () => void run('resolve', () => api<{ git: GitStatus; summary: string; remaining: string[]; agent: AgentId }>(`/projects/${projectId}/git/resolve`, { agent: writer.agent, model: writer.model || undefined }),
    result => { setResolution({ agent: AGENT_LABELS[result.agent], summary: result.summary }); return result.remaining.length ? tn(result.remaining.length, '{n} file still has conflicts.', '{n} files still have conflicts.') : t('Conflicts resolved. Read the diffs, then commit the merge.'); });
  const finish = () => void run('finish', () => api<{ git: GitStatus; commit: string }>(`/projects/${projectId}/git/finish`, {}), result => { setResolution(null); return t('Committed {hash}.', { hash: result.commit }); });
  const abort = () => void run('abort', () => api<{ git: GitStatus }>(`/projects/${projectId}/git/abort`, {}), () => { setResolution(null); return t('The merge was abandoned.'); });
  const commitTitle = staged.length ? tn(staged.length, 'Commit staged changes in 1 file', 'Commit staged changes in {n} files') : chosen.length === files.length ? tn(files.length, 'Commit 1 file', 'Commit all {n} files') : t('Commit {chosen} of {n} files', { chosen: chosen.length, n: files.length });
  const commitDisabled = Boolean(busy) || !message.trim() || !chosen.length;
  const syncPrimary = !chosen.length && canSync;
  const needsSync = Boolean(git.ahead || git.behind || publish);
  const syncing = busy === 'sync' || busy === 'push';
  const primaryLabel = busy === 'commit' ? t('Committing…') : syncing ? t('Syncing…') : syncPrimary ? (needsSync ? t('Sync') : t('Synced')) : t('Commit');
  const syncTitle = !git.remote ? t('This repository has no remote.') : !git.branch ? t('Check out a branch before syncing.') : t('Sync committed changes with the remote. Uncommitted changes are kept.');
  const primaryDisabled = syncPrimary ? Boolean(busy) || !needsSync : commitDisabled;
  const submitPrimary = () => { if (!primaryDisabled) { if (syncPrimary) syncRemote(); else commit(); } };
  const placeholder = busy === 'message' ? t('{agent} is writing a commit message…', { agent: AGENT_LABELS[writer.agent] })
    : git.branch && !touch() ? t('Message ({key} to commit on “{branch}”)', { key: '↵', branch: git.branch }) : t('Commit message');
  // One row per file and list. The staged list shows the index's status.
  const row = (file: GitFile, list: 'staged' | 'changes') => {
    const status = file.status === 'U' && merging && !merging.conflicts.includes(file.path) ? 'M' : list === 'staged' ? file.index || file.status : file.status;
    const slash = file.path.lastIndexOf('/'), code = status === '?' ? 'U' : status === 'U' ? '!' : status, key = list + ':' + file.path, selected = selection?.path === file.path && selection.list === list;
    const statusName = gitNames()[status] || status;
    const decorationLabel = file.incoming ? `${t('Incoming: {status}', { status: gitNames()[file.incoming] || file.incoming })} · ${t('Local: {status}', { status: statusName })}` : statusName;
    return <li key={key} className={selected ? 'selected' : undefined}>
      <div className="git-row">
        <button type="button" className="git-file" aria-pressed={selected} title={`${statusName}: ${file.from ? `${file.from} → ` : ''}${file.path}`} onClick={() => onOpenDiff({ path: file.path, list })}>
          <Icon name="paper" size={14}/><span className="git-name">{file.path.slice(slash + 1)}</span>{slash > 0 && <span className="git-dir">{file.path.slice(0, slash)}</span>}
        </button>
        {!merging && <span className="git-row-actions">
          {list === 'changes' && <button type="button" className="icon-button git-discard-action" aria-label={t('Discard changes in {path}', { path: file.path })} title={t('Discard changes')} disabled={Boolean(busy)} onClick={() => setDiscarding([file])}><Icon name="undo" size={16}/></button>}
          {list === 'changes'
            ? <button type="button" className="icon-button" aria-label={t('Stage {path}', { path: file.path })} title={t('Stage changes')} disabled={Boolean(busy)} onClick={() => stage([file.path], true)}><Icon name="plus" size={16}/></button>
            : <button type="button" className="icon-button" aria-label={t('Unstage {path}', { path: file.path })} title={t('Unstage changes')} disabled={Boolean(busy)} onClick={() => stage([file.path], false)}><Icon name="minus" size={16}/></button>}
        </span>}
        <span className={'git-code s-' + (status === '?' ? 'u' : status === 'U' ? 'conflict' : status.toLowerCase())} aria-label={decorationLabel} title={decorationLabel + (file.lines && !(file.staged && file.unstaged) ? ' · ' + t('{added} lines added, {deleted} lines removed', { added: file.lines[0], deleted: file.lines[1] }) : '')}>{file.incoming && <><span className={'git-incoming s-' + file.incoming.toLowerCase()}>↓{file.incoming}</span>, </>}{code}</span>
      </div>
    </li>;
  };
  const group = (list: 'staged' | 'changes', items: GitFile[]) => {
    const name = list === 'staged' ? t('Staged changes') : t('Changes'), shut = collapsed[list];
    const stageable = list === 'changes' ? items.filter(file => !ignorable(file)) : items;
    return <div className="git-group" role="group" aria-label={name}>
      <div className="git-group-header">
        <button type="button" className="git-group-toggle" aria-expanded={!shut} onClick={() => setCollapsed(current => ({ ...current, [list]: !shut }))}><Icon name={shut ? 'chevronRight' : 'chevronDown'} size={12}/><span>{name}</span><span className="git-count" aria-hidden="true">{items.length}</span></button>
        {!merging && <span className="git-row-actions">
          {list === 'changes' && <button type="button" className="icon-button git-discard-action" aria-label={t('Discard all changes')} title={t('Discard all changes')} disabled={Boolean(busy)} onClick={() => setDiscarding(items)}><Icon name="undo" size={15}/></button>}
          {list === 'changes'
            ? <button type="button" className="icon-button" aria-label={t('Stage all changes')} title={t('Stage all changes')} disabled={Boolean(busy) || !stageable.length} onClick={() => stage(stageable.map(file => file.path), true)}><Icon name="plus" size={15}/></button>
            : <button type="button" className="icon-button" aria-label={t('Unstage all changes')} title={t('Unstage all changes')} disabled={Boolean(busy)} onClick={() => stage(items.map(file => file.path), false)}><Icon name="minus" size={15}/></button>}
        </span>}
      </div>
      {!shut && <ul className="git-files">{items.map(file => row(file, list))}</ul>}
    </div>;
  };
  const sync = git.upstream && (git.ahead > 0 || git.behind > 0) ? <span className="git-sync">{git.ahead > 0 && <span>↑{git.ahead}</span>}{git.behind > 0 && <span>↓{git.behind}</span>}</span> : null;
  const switcher = <div className="git-detail-switcher view-selector" role="group" aria-label={t('Workspace view')}>
    <button type="button" aria-pressed={detail === 'changes'} onClick={() => { if (source?.list === 'history') selectSource({ path: '', list: 'changes' }); showDetail('changes'); }}><Icon name="diff" size={16}/><span>{t('Changes')}</span></button>
    <button type="button" aria-pressed={detail === 'history'} onClick={() => showDetail('history')}><Icon name="restore" size={16}/><span>{t('Version history')}</span></button>
  </div>;
  const diffOpen = detail === 'changes' && Boolean(source?.path);
  return <section className="git-workspace" data-git-detail={detail} aria-label={t('Version Management')} aria-busy={Boolean(busy)}>
    <div className="git-workspace-body">
    <section className={'git-panel' + (advanced ? ' git-advanced' : '')} aria-label={t('Changes')}>
    <div className="git-toolbar" role="group" aria-label={t('Version Management')}>
      {navigation}
      <span className="git-branch" title={git.upstream ? `${t('Tracking')} ${git.upstream}` : t('No upstream branch')}><Icon name="branch" size={14}/><code>{git.branch || t('detached HEAD')}</code>{sync}</span>
      <div className="git-toolbar-tools">
        {advanced && git.remote && <>
          <button type="button" className="icon-button" aria-label={t('Fetch from the remote')} title={t('Fetch from the remote')} disabled={Boolean(busy)} onClick={() => remote('fetch')}>{busy === 'fetch' ? <span className="spinner"/> : <Icon name="fetch" size={15}/>}</button>
          {git.upstream && <button type="button" className={'git-remote-action' + (git.behind > 0 ? ' has-count' : '')} aria-label={diverged ? t('Merge') : t('Pull')} title={diverged ? t('{branch} and {upstream} have both changed. Merge brings in the remote commits.', { branch: git.branch ?? '', upstream: git.upstream }) : t('Pull')} disabled={Boolean(busy) || Boolean(merging) || !git.behind} onClick={() => remote(diverged ? 'merge' : 'pull')}>{busy === 'pull' || busy === 'merge' ? <span className="spinner"/> : <Icon name="pull" size={14}/>}{git.behind > 0 && <span className="git-action-count" aria-hidden="true">{git.behind}</span>}</button>}
          {(git.upstream || publish) && <button type="button" className={'git-remote-action' + ((git.upstream && git.ahead > 0) || publish ? ' has-count' : '')} aria-label={git.upstream ? t('Push') : t('Publish branch')} title={git.upstream ? t('Push') : t('Publish branch')} disabled={Boolean(busy) || Boolean(merging) || Boolean(git.upstream && !git.ahead)} onClick={() => remote('push')}>{busy === 'push' ? <span className="spinner"/> : <Icon name="push" size={14}/>}{git.upstream && git.ahead > 0 && <span className="git-action-count" aria-hidden="true">{git.ahead}</span>}</button>}
        </>}
        <button type="button" className="icon-button" aria-label={t('Refresh changes')} title={t('Refresh changes')} disabled={Boolean(busy)} onClick={reload}>{busy === 'reload' ? <span className="spinner"/> : <Icon name="refresh" size={14}/>}</button>
      </div>
    </div>
    {error && <p className="inline-error git-message" role="alert">{error}</p>}
    {notice && !error && <p className={'git-message git-notice' + (merging ? ' git-warning' : '')} role="status"><Icon name={merging ? 'alert' : 'check'} size={14}/><span>{notice}</span></p>}
    <div className="git-panel-content">
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
      {!merging && <form className="git-commit-form" onSubmit={event => { event.preventDefault(); submitPrimary(); }}>
        <div className="git-message-box">
          <textarea aria-label={t('Commit message')} placeholder={placeholder} rows={1} value={message} readOnly={busy === 'commit' || busy === 'message'} onChange={event => saveMessage(event.target.value)} onKeyDown={event => { if (sendsMessage(event.nativeEvent, touch())) { event.preventDefault(); commit(); } }}/>
          <div className="git-compose-bar">
            <button type="button" className="icon-button git-generate" aria-label={t('Generate commit message')} title={t('Write a commit message for the chosen files with {agent}', { agent: AGENT_LABELS[writer.agent] })} disabled={Boolean(busy) || !chosen.length} onClick={() => void generate()}>{busy === 'message' ? <span className="spinner"/> : <Icon name="spark" size={15}/>}</button>
            <div className={'git-commit-split has-menu' + (busy === 'commit' || syncing ? ' is-busy' : '')}>
              <button className="button primary git-commit-button" aria-label={primaryLabel} title={syncPrimary ? needsSync ? syncTitle : t('Up to date with the remote.') : commitTitle} disabled={primaryDisabled}>{busy === 'commit' || syncing ? <span className="spinner light"/> : <Icon name={syncPrimary && needsSync ? 'refresh' : 'check'} size={14}/>}<span>{primaryLabel}</span>{syncPrimary && needsSync && sync}</button>
              <ActionMenu label={t('More commit actions')} className="button primary git-commit-more" disabled={Boolean(busy)} actions={[
                { label: t('Commit'), icon: 'check', disabled: commitDisabled, select: () => commit() },
                { label: t('Commit and sync'), icon: 'refresh', disabled: commitDisabled || !canSync, select: () => commit('sync') },
                { label: t('Sync'), icon: 'refresh', divider: true, disabled: !canSync, title: syncTitle, select: syncRemote },
                ...(advanced ? [{ label: t('Commit (Amend)'), icon: 'undo', disabled: commitDisabled || !git.head, divider: true, select: () => commit('amend') },
                  ...(canPush ? [{ label: t('Commit and push'), icon: 'push', disabled: commitDisabled, select: () => commit('push') }] : [])] : []),
              ]}><Icon name="chevronDown" size={13}/></ActionMenu>
            </div>
          </div>
        </div>
      </form>}
      <div className="git-file-lists">
      {ignored.length > 0 && !merging && <button type="button" className="git-ignore-banner" title={t('Untracked build output. Add to .gitignore adds:') + '\n' + patterns.join('\n')} disabled={Boolean(busy)} onClick={ignore}><Icon name="archive" size={14}/><span>{t('Add to .gitignore')}</span><small>{tn(ignored.length, '{n} build file', '{n} build files')}</small></button>}
      {merging ? files.length > 0 && group('changes', files) : <>
        {staged.length > 0 && group('staged', staged)}
        {unstaged.length > 0 && group('changes', unstaged)}
      </>}
      {!files.length && <p className="git-clean"><Icon name="check" size={14}/><span>{t('No uncommitted changes')}</span></p>}
      </div>
    </div>
    </section>
    <section className="git-details" aria-label={t('Workspace view')}>
      {!diffOpen && <div className="git-details-toolbar">
        {switcher}
        {detail === 'history' && !advanced && <button type="button" className="icon-button git-details-refresh" aria-label={t('Refresh version history')} title={t('Refresh version history')} disabled={Boolean(busy)} onClick={() => setHistoryRefresh(value => value + 1)}><Icon name="refresh" size={14}/></button>}
      </div>}
      <div className="git-file-preview" hidden={detail !== 'changes'}>
        {diffOpen && source ? <GitDiffView key={projectId + ':' + source.list + ':' + historyHash + ':' + source.path} lead={switcher} path={source.path} scopeLabel={source.list === 'history' ? source.subject : source.list === 'staged' ? t('Staged changes') : ''} revision={historyHash || JSON.stringify([git.head?.hash, git.files, diffRefresh])} live={source.list !== 'history'} load={loadDiff} onClose={closeSource}/>
          : <p className="git-empty-diff"><Icon name={files.length ? 'diff' : 'check'} size={18}/><span>{files.length ? t('Changes') : t('No uncommitted changes')}</span></p>}
      </div>
      <div className="git-repository-view" hidden={detail !== 'history'}>
    <VersionHistory git={git} busy={Boolean(busy)} collapsible={advanced} refreshKey={historyRefresh} load={loadHistory} loadVersion={loadVersion} selection={selection?.list === 'history' ? selection : null} onOpenDiff={onOpenDiff} restore={async (hash, head) => {
      if (busy) return;
      setBusy('restore'); setError(''); setNotice('');
      try {
        const result = await api<{ git: GitStatus }>(`/projects/${projectId}/git/restore`, { hash, head });
        onStatus(result.git); selectSource(null); showDetail('history'); setNotice(t('Version restored. Previous versions are kept in history.'));
      } catch (error) {
        try { onStatus(await api<GitStatus>(`/projects/${projectId}/git`)); } catch { /* Preserve the restoration error. */ }
        throw error;
      } finally { setBusy(''); }
    }}/>
    {advanced && <GitRepository git={git} load={loadOverview} tasks={tasks} onOpenTask={onOpenTask} taskStatus={task => <Status task={task}/>}/>}
      </div>
    </section>
    </div>
    {discarding && <DiscardDialog files={discarding} onCancel={() => setDiscarding(null)} onConfirm={() => discard(discarding)}/>}
  </section>;
}

// A note that asks for something by itself: a comment, or a deletion.
const actionable = (note: Annotation) => Boolean(note.comment.trim()) || note.kind === 'delete';
function noteWhere(note: Annotation) { return t('Page {n}', { n: note.page + 1 }) + (note.source ? ` · ${note.source.file}:${note.source.lines[0]}${note.source.lines[1] !== note.source.lines[0] ? `–${note.source.lines[1]}` : ''}` : ''); }

function NotePlacementWarning() {
  return <small className="note-placement-warning" title={t('The position in the new PDF could not be confirmed. The original text and note are kept.')}><Icon name="alert" size={12}/>{t('Position needs confirmation')}</small>;
}

type AnnotationChange = { note: Annotation; selected?: boolean } & ({ kind: 'add' | 'remove' } | { kind: 'edit'; comment: string });
interface NoteActions {
  history?: PdfHistoryActions;
  selection: ReturnType<typeof useNoteSelection>;
  instructions: ReturnType<typeof useGroupInstructions>;
  group: NoteGroup | null;
  setGroup: (group: NoteGroup | null) => void;
  add: (page: number, rect: Rect, rects: Rect[], quote: string, comment: string, group?: NoteGroup, options?: { reveal?: boolean; quote?: boolean; kind?: MarkKind; stamp?: string; key?: string }) => Promise<void>;
  edit: (note: Annotation, comment: string) => Promise<void>;
  remove: (note: Annotation) => Promise<void>;
  restore: (note: Annotation) => Promise<void>;
  onEditing: (editing: boolean) => void;
  onReviewBusy: (busy: boolean) => void;
  sending: boolean;
}

// My notes and the task's notes edit in place the same way: one draft per
// note, saved with Enter, Escape or a click elsewhere; errors stay beside it.
function useNoteCards(notes: Annotation[] | undefined, actions: NoteActions, onEditing?: (editing: boolean) => void, projectId?: string) {
  const [drafts, setDrafts] = useState<Record<string, { note: Annotation; value: string }>>({});
  const draftValues = useRef(drafts);
  const [lastDismissed, setDismissed] = useState<Annotation | null>(null);
  const pending = useRef(new Map<string, { note: Annotation; promise: Promise<boolean> }>());
  const [busyNotes, setBusyNotes] = useState<Annotation[]>([]), [failures, setErrors] = useState<Record<string, { note: Annotation; message: string }>>({});
  const inProject = (note: Annotation) => projectId === undefined || note.projectId === projectId;
  const dismissed = lastDismissed && inProject(lastDismissed) ? lastDismissed : null;
  const errors = Object.fromEntries(Object.entries(failures).filter(([, failure]) => inProject(failure.note)).map(([id, failure]) => [id, failure.message]));
  const editing = Object.values(drafts).some(entry => inProject(entry.note)), busy = busyNotes.some(inProject);
  useEffect(() => { onEditing?.(editing || busy); return () => onEditing?.(false); }, [editing, busy, onEditing]);
  useEffect(() => { if (dismissed && notes?.some(note => note.id === dismissed.id)) setDismissed(null); }, [notes, dismissed]);
  // Prune only annotations actually removed from a loaded paper, never notes
  // merely deselected, hidden by a skill, or belonging to another paper.
  useEffect(() => {
    if (!notes) return;
    for (const [id, entry] of Object.entries(draftValues.current)) if (inProject(entry.note) && !notes.some(note => note.id === id)) draft(id, null);
  }, [notes, projectId]);
  const clearError = (id: string) => setErrors(current => { const next = { ...current }; delete next[id]; return next; });
  function draft(id: string, value: string | null) {
    const next = { ...draftValues.current };
    if (value === null) delete next[id];
    else {
      const note = notes?.find(note => note.id === id) || next[id]?.note;
      if (!note) return;
      next[id] = { note, value };
    }
    draftValues.current = next; setDrafts(next);
  }
  function change(note: Annotation, work: () => Promise<void>): Promise<boolean> {
    const id = note.id;
    if (pending.current.has(id) || actions.sending) return Promise.resolve(false);
    clearError(id);
    const operation = Promise.resolve().then(work).then(() => true, e => { setErrors(current => ({ ...current, [id]: { note, message: e instanceof Error ? e.message : String(e) } })); return false; })
      .finally(() => { pending.current.delete(id); setBusyNotes([...pending.current.values()].map(entry => entry.note)); });
    pending.current.set(id, { note, promise: operation }); setBusyNotes([...pending.current.values()].map(entry => entry.note));
    return operation;
  }
  const save = (note: Annotation, comment: string, then?: () => void) => change(note, async () => {
    await actions.edit(note, comment); draft(note.id, null); then?.();
  });
  async function saveAll(ids?: string[]) {
    const included = (note: Annotation) => inProject(note) && (!ids || ids.includes(note.id));
    if (actions.sending || (await Promise.all([...pending.current.values()].filter(entry => included(entry.note)).map(entry => entry.promise))).some(saved => !saved)) return false;
    for (const [id, entry] of Object.entries(draftValues.current)) {
      if (!included(entry.note)) continue;
      const note = notes?.find(note => note.id === id) || entry.note, comment = entry.value.trim();
      if (comment && comment !== note.comment) { if (!await save(note, comment)) return false; }
      else draft(id, null);
    }
    return true;
  }
  // Deleting shows Undo right there, as in the PDF; phones have no ⌘Z.
  const remove = (note: Annotation) => change(note, async () => { await actions.remove(note); draft(note.id, null); setDismissed(note); });
  const undo = (disabled: boolean) => dismissed && <div className="note-dismissed" role="status">{dismissed.aiReview ? t('Suggestion ignored.') : t('Note deleted.')} <button type="button" disabled={disabled} onClick={() => void change(dismissed, async () => { await actions.restore(dismissed); setDismissed(null); })}>{t('Undo')}</button></div>;
  // The same card in both lists; `onToggle` adds the note to the task or takes it out.
  const card = (note: Annotation, index: number, { currentKey, active, inTask, onShow, onToggle }: { currentKey?: string; active?: string; inTask?: boolean; onShow: (note: Annotation) => void; onToggle: () => void }) => <li key={note.id} data-note={note.id} data-selected={actions.selection.has(note.id)} className={(note.aiReview ? 'review-suggestion ' : '') + (active === note.id ? 'active ' : '') + (note.key !== currentKey ? 'stale' : '')}>
    <PdfNoteCard inline inTask={inTask} note={note} number={index + 1} index={0} total={1} selected={actions.selection.has(note.id)} busy={actions.sending || busyNotes.some(item => item.id === note.id)} error={errors[note.id] || ''}
      draft={drafts[note.id]?.value ?? null} onDraftChange={value => { draft(note.id, value); if (value !== null && drafts[note.id] === undefined) clearError(note.id); }}
      header={<div className="note-card-context"><div className="note-head"><button type="button" className="note-number" aria-label={note.aiReview ? t('Show suggestion {n} on the page', { n: index + 1 }) : t('Show note {n} on the page', { n: index + 1 })} disabled={note.key !== currentKey} onClick={() => onShow(note)}>{index + 1}</button><span className="note-where">{noteWhere(note)}{note.aiReview ? ' · ' + AGENT_LABELS[note.aiReview.agent] : note.author ? ' · ' + t('from {name}', { name: note.author.name }) : ''}</span></div><NoteQuote text={note.quote} kind={note.kind}/></div>}
      onToggle={onToggle} onDismiss={() => void remove(note)}
      onSave={(comment, action) => save(note, comment, action === 'quote' ? onToggle : undefined)}>
      {note.key !== currentKey && <NotePlacementWarning/>}
    </PdfNoteCard>
  </li>;
  return { editing, busy, errors, dismissed, saveAll, remove, undo, forget: () => setDismissed(current => current && inProject(current) ? null : current), card };
}

function useSaveNotesOnLeave(save: () => Promise<boolean>) {
  const saveOnLeave = useRef(save); saveOnLeave.current = save;
  useEffect(() => () => { void saveOnLeave.current(); }, []);
}

interface NotesHandle { save: () => Promise<boolean> }
function NotesPanel({ notes, currentKey, active, actions, onShow, onAnnotate, controller }: { notes: Annotation[]; currentKey?: string; active: string; actions: NoteActions; onShow: (note: Annotation) => void; onAnnotate: (region: boolean) => void; controller: React.Ref<NotesHandle> }) {
  const list = useRef<HTMLElement>(null);
  const cards = useNoteCards(notes, actions, actions.onEditing);
  useSaveNotesOnLeave(cards.saveAll);
  const { editing, errors } = cards, locked = cards.busy || actions.sending;
  useEffect(() => { if (active) list.current?.querySelector(`[data-note="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  useImperativeHandle(controller, () => ({ save: cards.saveAll }));
  const selectionLocked = locked || editing;
  const toggle = (note: Annotation) => actions.selection.set([note.id], !actions.selection.has(note.id));
  const selectCard = (note: Annotation, index: number) => <NoteAttachButton number={index + 1} ai={Boolean(note.aiReview)} selected={actions.selection.has(note.id)} disabled={selectionLocked} onClick={() => toggle(note)}/>;
  const ownNotes = notes.filter(note => !note.aiReview), ownSelected = ownNotes.filter(note => actions.selection.has(note.id)).length;
  const unplacedSuggestions = notes.filter(note => note.aiReview && note.key !== currentKey);
  const renderNote = (note: Annotation, index: number) => cards.card(note, index, { currentKey, active, onShow, onToggle: () => toggle(note) });
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
        <button type="button" className="icon-button group-location-remove" aria-label={t('Delete note {n}', { n: index + 1 })} disabled={locked} onClick={() => void cards.remove(note)}><Icon name="trash" size={14}/></button>
        {selectCard(note, index)}
      </div>)}</div>
    </GroupCard>; })}
    <ol className="note-list">{notes.map((note, index) => !note.aiReview && !note.group && renderNote(note, index))}</ol>
    </section>}
    {unplacedSuggestions.length > 0 && <section className="note-section" aria-label={t('Unplaced suggestions')}><h3>{t('Unplaced suggestions')}</h3><ol className="note-list">{notes.map((note, index) => note.aiReview && note.key !== currentKey && renderNote(note, index))}</ol></section>}
    {cards.undo(selectionLocked)}
    {Object.entries(errors).filter(([id]) => !notes.some(note => note.id === id && !note.group)).map(([id, error]) => <p key={id} className="inline-error" role="alert">{error}</p>)}
  </section>;
}

// The composer receives only attachments the author explicitly chose in the PDF.
// Each one is the same card as in My notes: click the text or ✏️ to edit it,
// 🗑 deletes it (⌘Z brings it back), and × takes it out of the task.
function TaskNotes({ notes, currentKey, actions, onShow, controller, cards }: { notes: Annotation[]; currentKey?: string; actions: NoteActions; onShow: (note: Annotation) => void; controller: React.Ref<NotesHandle>; cards: ReturnType<typeof useNoteCards> }) {
  const panel = useRef<HTMLElement>(null);
  const chosen = notes.filter(note => actions.selection.has(note.id));
  // Saving can outlive this view; drafts, failures and busy state live in App.
  useSaveNotesOnLeave(cards.saveAll);
  useImperativeHandle(controller, () => ({ save: cards.saveAll }));
  const locked = cards.busy || actions.sending, selectionLocked = locked || cards.editing;
  // A note that left the task while its save failed still reports it here.
  const orphanErrors = Object.entries(cards.errors).filter(([id]) => !chosen.some(note => note.id === id && !note.group));
  if (!chosen.length && !cards.dismissed && !orphanErrors.length) return null;
  // Notes listed in My notes fly back there; placed AI suggestions stay on the page.
  const putBack = (list: Annotation[]) => {
    returnNotes(list.filter(note => !note.aiReview || note.key !== currentKey).flatMap(note => panel.current?.querySelector<HTMLElement>(`[data-note="${CSS.escape(note.id)}"]`) || []));
    actions.selection.set(list.map(note => note.id), false);
  };
  // A location in a color group carries the group's instruction, not its own;
  // × sits top right, as on the cards below.
  const reference = (note: Annotation, index: number) => <li key={note.id} data-note={note.id} className="task-note-reference">
    <div className="note-head"><button type="button" className="note-number" aria-label={note.aiReview ? t('Show suggestion {n} on the page', { n: index + 1 }) : t('Show note {n} on the page', { n: index + 1 })} disabled={note.key !== currentKey} onClick={() => onShow(note)}>{index + 1}</button><span className="note-where">{noteWhere(note)}</span><TaskRemoveButton number={index + 1} ai={Boolean(note.aiReview)} disabled={selectionLocked} onClick={() => putBack([note])}/></div>
    <NoteQuote text={note.quote} kind={note.kind}/>
    {(note.comment || note.kind === 'delete' || note.stamp) && <p className="task-note-comment">{note.stamp && <span className="pdf-note-stamp"><Icon name="spark" size={12}/>{note.stamp}</span>}{markText(note)}</p>}
    {note.key !== currentKey && <NotePlacementWarning/>}
  </li>;
  return <section ref={panel} className="task-notes-panel" aria-label={t('Notes in this task')}>
    {chosen.length > 0 && <div className="note-selection-head"><span>{t('Added to task: {n}', { n: chosen.length })}</span><button type="button" className="note-select-all" disabled={selectionLocked} onClick={() => putBack(chosen)}>{t('Remove all from task')}</button></div>}
    {noteGroups(notes).map(({ group, entries }) => {
      const selected = entries.filter(({ note }) => actions.selection.has(note.id));
      return selected.length > 0 && <GroupCard key={group} group={group} count={selected.length}>
        <GroupInstruction group={group} value={actions.instructions.get(group)} disabled={actions.sending} onChange={value => actions.instructions.set(group, value)}/>
        <ol className="task-note-list">{selected.map(({ note, index }) => reference(note, index))}</ol>
      </GroupCard>;
    })}
    <ol className="task-note-list task-note-cards">{notes.map((note, index) => !note.group && actions.selection.has(note.id) && cards.card(note, index, { currentKey, inTask: true, onShow, onToggle: () => putBack([note]) }))}</ol>
    {cards.undo(selectionLocked)}
    {orphanErrors.map(([id, error]) => <p key={id} className="inline-error" role="alert">{error}</p>)}
  </section>;
}

function PendingComparison({ task, busy, onBuild }: { task: Task; busy: boolean; onBuild: () => void }) {
  const answered = noManuscriptChanges(task);
  // A new publication may still have the previous round's job until its
  // first poll. Never display that job's progress or elapsed time.
  const job = task.review?.job && ['queued', 'running'].includes(task.review.job.status)
    && (!task.pendingBuild || task.pendingBuild.job === task.review.job.id) ? task.review.job : null;
  let title = answered ? t('No manuscript changes') : t('PDF comparison');
  let detail = answered ? t('This task did not change the manuscript. Read the answer in the chat.') : t('Only manuscript changes need a PDF comparison. Answers to questions are in the chat.');
  if (task.status === 'building') {
    title = t('Preparing task results…');
    detail = t('Checking for manuscript changes. A PDF comparison is generated only when needed.');
    if (job?.status === 'queued') title = t('Queued');
    else if (job?.phase === 'build') {
      title = t('Compiling the PDF…');
      detail = t('Preparing both versions for comparison. Large documents can take several minutes.');
    } else if (job?.phase === 'options') {
      title = t('Preparing option comparisons…');
      detail = job.options ? t('{current} of {total}', { current: job.options.completed, total: job.options.total }) : '';
    } else if (job?.phase === 'render') {
      title = t('PDF comparison');
      detail = t('Comparing the typeset pages…');
    }
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
    {task.status === 'building' && <ComparisonProgress job={job}/>}
    {!answered && ['idle', 'interrupted', 'failed', 'reviewing'].includes(task.status) && <button type="button" className="button secondary" disabled={busy} onClick={onBuild}>{t('Generate PDF comparison')}</button>}
  </div>;
}

// A task has no copy of the manuscript until it is prepared. When that fails,
// the chat shows the error with Retry and Delete.
function PreparingTask({ task }: { task: Task }) {
  const failed = task.status !== 'preparing';
  return <div className="review-placeholder">
    <div className="placeholder-icon">{failed ? <Icon name="alert" size={22}/> : <span className="spinner large"/>}</div>
    <h2>{failed ? t('Could not prepare this task') : preparingLabel(task)}</h2>
    {failed && task.error && <p>{errorText(task.error)}</p>}
  </div>;
}

type ManuscriptPanel = 'pdf' | 'task' | 'source';
function ManuscriptView({ notesRequest, taskCards, navigationGuard, collapsed, setCollapsed, project, data, error, view, setView, region, setRegion, active, setActive, actions, newTask, tools, share, navigation, onGit, writer, reportError, onFixProblems }: { notesRequest?: number; navigationGuard: React.Ref<NotesHandle>; collapsed: boolean; setCollapsed: React.Dispatch<React.SetStateAction<boolean>>; taskCards: ReturnType<typeof useNoteCards>; onFixProblems?: (request: string) => void; navigation?: React.ReactNode; newTask: (notes: React.ReactNode) => React.ReactNode; tools?: React.ReactNode; share?: React.ReactNode; onGit: (status: GitStatus) => void; writer: CommitWriter; reportError: (error: unknown) => void; project: Project; data: Manuscript | null; error: string; view: ManuscriptPanel; setView: (view: ManuscriptPanel) => void; region: boolean; setRegion: (on: boolean) => void; active: string; setActive: (id: string) => void; actions: NoteActions }) {
  const build = data?.build, notes = data?.annotations || [], git = data?.git;
  const pdf = useRef<PdfHandle>(null);
  const [readingNotes, setReadingNotes] = useState(false);
  useEffect(() => { if (notesRequest) setReadingNotes(true); }, [notesRequest]);
  const notesPanel = useRef<NotesHandle>(null);
  const taskNotes = useRef<NotesHandle>(null);
  useImperativeHandle(navigationGuard, () => ({ save: async () => {
    if (taskNotes.current && !await taskNotes.current.save()) return false;
    if (notesPanel.current && !await notesPanel.current.save()) return false;
    return true;
  } }));
  async function closeReadingNotes() {
    if (readingNotes && notesPanel.current && !await notesPanel.current.save()) return false;
    setReadingNotes(false); return true;
  }
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
  const [mode, showMode] = useState<PdfMode>(() => !isPlayground && readPlace('mode:' + project.id) === 'changes' ? 'changes' : 'pdf'), [committing, setCommitting] = useState(false);
  const setMode = (value: PdfMode) => {
    if (isPlayground && value === 'changes') { window.dispatchEvent(new CustomEvent('papilot:playground-open', { detail: 'example-clarity' })); return; }
    showMode(value); savePlace('mode:' + project.id, value); };
  // The last build's problems sit beside Recompile and open only when asked.
  const problems = useRef<ProblemsHandle>(null);
  // Editing a passage's LaTeX by hand, from a click on the PDF, in a tab
  // beside New task that exists while a passage is open.
  const review = useRef<ReviewSources>(null), modeRef = useRef<PdfMode>('pdf');
  // In Changes, moving to a changed line in the editor shows its change.
  const source = useSourceEdit({ api, projectId: project.id, build, head: git?.head?.hash ?? null, pdf, onProblems: () => problems.current?.open(),
    onLine: (file, line) => { if (modeRef.current === 'changes') review.current?.select(file, line); } });
  modeRef.current = mode;
  useEffect(() => { if (view === 'source' && !source.editing) setView(window.matchMedia('(max-width: 680px)').matches ? 'pdf' : 'task'); }, [source.editing, view]);
  const problemsButton = <ProblemsButton ref={problems} counts={build?.problems} status={build?.status} pdfKey={build?.key} logUrl={`/api/projects/${project.id}/manuscript/log`}
    load={() => api<ManuscriptProblems>(`/projects/${project.id}/manuscript/problems`)}
    onJump={problem => { if (problem.page === undefined || !problem.rect) return; if (phone()) setView('pdf'); const { page, rect } = problem; requestAnimationFrame(() => pdf.current?.showPlace(page, rect)); }}
    onFix={onFixProblems && (list => { onFixProblems(fixRequest(list)); setView('task'); setCollapsed(false); })}/>;
  // The button always says how many notes are saved, and pops as more arrive.
  const notesLabel = notes.length ? `${t('My notes')} · ${tn(notes.length, 'Note on the PDF', '{n} notes on the PDF')}` : t('My notes');
  const pdfTools = <>{tools}{problemsButton}<button type="button" data-notes-home="library" className={'icon-button' + (readingNotes ? ' active' : '')} aria-label={notesLabel} title={notesLabel} aria-pressed={readingNotes} onClick={() => { if (readingNotes) void closeReadingNotes(); else { setActive(''); setReadingNotes(true); } }}><Icon name="notes" size={16}/>{notes.length > 0 && <span className="notes-count" aria-hidden="true">{notes.length}</span>}</button>{!hidden && !sideBySide && share}{hidden && togglePanel}</>;
  const staged = Array.isArray(git?.files) && !git.merging ? git.files.filter(file => file.staged).map(file => file.path) : [];
  const reloadGit = () => void api<GitStatus>(`/projects/${project.id}/git`).then(onGit, () => undefined);
  const commitButton = (inFrame: boolean) => staged.length > 0 && (inFrame
    ? <><span className="commit-state">{tn(staged.length, '{n} file staged', '{n} files staged')}</span><button type="button" className="commit-button" onClick={() => setCommitting(true)}>{t('Commit…')}</button></>
    : <button type="button" className="button ghost compact commit-staged" title={t('Commit what is staged')} onClick={() => setCommitting(true)}><Icon name="commit" size={14}/><span>{t('Commit…')}</span></button>);
  const [outline, setOutline] = useState<OutlineItem[]>([]), [section, setSection] = useState(-1);
  const switcher = <>{navigation}<ModeSwitch mode={mode} onMode={async value => { if (await closeReadingNotes()) setMode(value); }}/>
  </>;
  const numbered = notes.map((note, index) => ({ note, number: index + 1 }));
  const phone = () => window.matchMedia('(max-width: 680px)').matches;
  const side = view === 'source' && source.panel ? 'source' : 'task';
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
      <ReviewFrame key={'changes:' + project.id} changesOf={project.id} lead={switcher} tools={<>{commitButton(false)}{pageTools}</>} completion={commitButton(true)} onDecided={reloadGit}
        sources={review} onCurrentChange={change => void source.follow(change, () => { setView('source'); setCollapsed(false); })}/>
    </section> : <section className="manuscript-pages" aria-label={t('PDF preview')} aria-busy={!build || build.status === 'building'}>
      {!build?.key && <div className="pdf-toolbar manuscript-lead" role="toolbar" aria-label={t('PDF controls')}>{switcher}<div className="pdf-toolbar-spacer"/>{pdfTools}</div>}
      {error && <div className="manuscript-note error" role="alert">{error}</div>}
      {build?.status === 'failed' && (build.key
        // The previous PDF stays readable; the details wait in the problem list.
        ? <div className="manuscript-note error brief" role="alert"><span>{t('The latest changes did not compile. This is the last PDF that did.')}</span><button type="button" className="note-link" onClick={() => problems.current?.open()}>{t('Show problems')}</button></div>
        : <div className="manuscript-note error" role="alert"><strong>{t('The manuscript did not compile.')}</strong><pre>{build.error}</pre></div>)}
      {build?.key ? <Suspense fallback={<div className="review-loading"><p role="status">{t('Opening the PDF…')}</p></div>}><PdfView ref={pdf} place={'pdf:' + project.id} pdfKey={build.key} url={pdfAsset(`/api/projects/${project.id}/manuscript.pdf?key=${build.key}`)} words={wordAsset(`/api/projects/${project.id}/manuscript/words?key=${build.key}`)} notes={numbered.filter(item => item.note.key === build.key)} active={active} region={region} setRegion={setRegion} group={actions.group} onGroupChange={actions.setGroup} markingDisabled={actions.sending}
          history={actions.history} noteActions={{ has: actions.selection.has, toggle: note => actions.selection.set([note.id], !actions.selection.has(note.id)), remove: actions.remove, restore: actions.restore, edit: actions.edit, onEditing: actions.onEditing, onBusy: actions.onReviewBusy, disabled: actions.sending }} onDeselect={() => setActive('')}
          onCreate={actions.add} onSelect={async note => { if (await closeReadingNotes()) setActive(note.id); }} outline={outline} section={section} onOutline={setOutline} onSection={setSection} lead={switcher} tools={pdfTools}
          onSource={async (target, key) => { if (!await closeReadingNotes()) return; setActive(''); setView('source'); setCollapsed(false); void source.open(target, key); }} passage={source.passage}/></Suspense>
        : !error && build?.status !== 'failed' && <div className="review-placeholder"><div className="placeholder-icon"><span className="spinner large"/></div><h2>{t('Compiling the PDF…')}</h2></div>}
      {readingNotes && <><div aria-hidden="true" className="pdf-reading-notes-scrim" onClick={() => void closeReadingNotes()}/><aside className="pdf-reading-notes" aria-label={t('PDF note library')}><div className="pdf-reading-notes-head"><strong>{t('My notes')}</strong><button type="button" className="icon-button" aria-label={t('Close notes')} onClick={() => void closeReadingNotes()}><Icon name="close" size={16}/></button></div><NotesPanel key={project.id} controller={notesPanel} notes={notes} currentKey={build?.key} active={active} actions={actions} onShow={show} onAnnotate={annotate}/></aside></>}
    </section>}
    <aside id={panelId} className="manuscript-side" aria-label={t('Manuscript panels')} hidden={hidden}>
      <div className="manuscript-side-header">
        {!hidden && togglePanel}
        <div className="side-tabs" role="tablist" aria-label={t('Manuscript panels')}>
          <button role="tab" data-task-home aria-selected={side === 'task'} title={t('New task')} onClick={() => setView('task')}><Icon name="compose" size={14}/><span className="tab-label">{t('New task')}</span>{actions.selection.selected.length > 0 && <span className="count" aria-hidden="true">{actions.selection.selected.length}</span>}</button>
          {/* The source tab closes itself, like an editor's: a dot while unsaved, a cross under the pointer. */}
          {source.tab && <span className="side-tab-closable" role="presentation" data-selected={side === 'source'}>
            <button role="tab" aria-selected={side === 'source'} title={source.tab.file || t('Edit source')} onClick={() => setView('source')}><Icon name="toolSource" size={14}/><span className="tab-label">{source.tab.name}</span></button>
            <button type="button" className="side-tab-close" data-dirty={source.tab.dirty || source.tab.saving || undefined}
              aria-label={source.tab.dirty ? `${t('Unsaved')} · ${t('Close (the draft is kept)')}` : t('Close')} title={source.tab.dirty ? `${t('Unsaved')} · ${t('Close (the draft is kept)')}` : t('Close')} onClick={source.close}><Icon name="close" size={12}/></button>
          </span>}
        </div>
        {!hidden && sideBySide && share}
      </div>
      <div className="side-pane" hidden={side !== 'task'}>{newTask(<TaskNotes cards={taskCards} controller={taskNotes} notes={notes} currentKey={build?.key} actions={actions} onShow={show}/>)}</div>
      {source.panel && <div className="side-pane" hidden={side !== 'source'}>{source.panel}</div>}
    </aside>
    {committing && <CommitDialog branch={git?.branch ?? null} files={staged} staged remote={Boolean(git?.remote)} agent={AGENT_LABELS[writer.agent]} onClose={() => setCommitting(false)}
      generate={fresh => api<{ message: string }>(`/projects/${project.id}/git/message`, { paths: staged, staged: true, agent: writer.agent, fresh }).then(result => result.message)}
      commit={async (message, push) => {
        const result = await api<{ commit: string; git: GitStatus; pushError?: string }>(`/projects/${project.id}/git/commit`, { message, staged: true, push });
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
  // A tag (or untagged JSON); empty while the app shows a locally changed snapshot.
  const snapshotText = useRef('');
  const composers = useRef(new Map<string, ComposerDraft>());
  const answerDrafts = useRef(new Map<string, Record<string, string>>());
  const [snapshotRequest] = useState(() => new ReadRequest<{ value: (Snapshot & { csrf: string }) | null; tag: string }>());
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
  const newTaskInput = useRef<HTMLTextAreaElement>(null);
  const [newDraft, setNewDraft] = useState(() => browserStorage.getItem('papilot:new-task') || '');
  const [newSkill, setNewSkill] = useState<Skill | null>(null);
  const [skills, setSkills] = useState<{ projectId: string; list: Skill[] }>({ projectId: '', list: [] });
  const [skillsRevision, setSkillsRevision] = useState(0);
  // The agent, and each agent's model and reasoning effort, are remembered for
  // every new task, whether it starts from the composer or from PDF notes.
  const [newPermissions, setNewPermissions] = useState<TaskPermissions>('workspace');
  const [savedAgent, setAgentChoice] = useState<AgentId | null>(() => { const saved = browserStorage.getItem('papilot:agent'); return isAgentId(saved) ? saved : null; });
  const [agentPrefs, setAgentPrefs] = useState(() => Object.fromEntries(AGENT_IDS.map(id => [id, {
    model: browserStorage.getItem(`papilot:model:${id}`) ?? '',
    // null until an effort is chosen; '' is an explicit choice of the model's default.
    effort: browserStorage.getItem(`papilot:effort:${id}`) ?? (isPlayground && id === 'codex' ? 'xhigh' : null),
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
  const manuscriptNavigationGuard = useRef<NotesHandle>(null);
  const [playgroundNotes, setPlaygroundNotes] = useState(0);
  const [manuscriptCollapsed, setManuscriptCollapsed] = useState(() => browserStorage.getItem('papilot:manuscript-panel') === 'hidden');
  // Without a task, the main area shows the manuscript or a tool from the
  // sidebar's Tools menu, such as the reference check.
  const [page, setPage] = useState<'manuscript' | 'references' | 'git'>(() => browserStorage.getItem('papilot:page') === 'git' ? 'git' : 'manuscript');
  useEffect(() => { browserStorage.setItem('papilot:page', page); }, [page]);
  const [region, setRegion] = useState(false);
  const [activeNote, setActiveNote] = useState('');
  const [noteGroup, setNoteGroup] = useState<NoteGroup | null>(null);
  const [marking, setMarking] = useState(0);
  // History belongs to this paper session. A restored note also returns to
  // the task draft it was in; late requests cannot populate another session.
  const annotationHistory = useRef({ projectId, undo: [] as AnnotationChange[], redo: [] as AnnotationChange[], busy: false });
  if (annotationHistory.current.projectId !== projectId) annotationHistory.current = { projectId, undo: [], redo: [], busy: false };
  const history = annotationHistory.current;
  const [, refreshHistory] = useState(0);
  const historyChanged = () => { if (annotationHistory.current === history) refreshHistory(value => value + 1); };
  const recordAnnotation = (entry: AnnotationChange) => {
    if (annotationHistory.current !== history || entry.note.projectId !== history.projectId) return;
    history.undo.push(entry); history.redo = []; historyChanged();
  };
  const noteEditVersion = useRef(0), noteWrites = useRef(new Map<string, { saved: Annotation; tail: Promise<void> }>());
  useEffect(() => { setNoteGroup(null); }, [projectId]);
  const [pdfNoteEditing, setNoteEditing] = useState(false);
  const [reviewNoteBusy, setReviewNoteBusy] = useState(false);
  const [manuscript, setManuscript] = useState<{ projectId: string; data: Manuscript | null; error: string }>({ projectId: '', data: null, error: '' });
  const manuscriptRequest = useRef(0);
  const manuscriptBuildRequests = useRef(new Set<string>());
  const [pendingManuscriptBuilds, setPendingManuscriptBuilds] = useState(new Set<string>());
  const [git, setGit] = useState<{ projectId: string; status: GitStatus | null }>({ projectId: '', status: null });
  const [chatWidth, setChatWidth] = useState(() => Number(browserStorage.getItem('papilot:chat-width')) || 0);
  // Appearance, language and notifications live in Settings; a new language re-renders everything.
  const theme = useTheme(); const { language: uiLanguage } = useLanguage();
  const [settings, setSettings] = useState<false | SettingsInitialPage>(false);
  useEffect(() => {
    const shortcuts = () => setSettings('shortcuts'), quickNotes = () => setSettings('quickNotes');
    window.addEventListener('papilot:open-shortcuts', shortcuts); window.addEventListener('papilot:open-quick-notes', quickNotes);
    return () => { window.removeEventListener('papilot:open-shortcuts', shortcuts); window.removeEventListener('papilot:open-quick-notes', quickNotes); };
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
  useEffect(() => {
    if (!isPlayground) return;
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!['', 'example-clarity', 'example-math', 'example-review'].includes(id)) return;
      setSelected(id); setPage('manuscript'); setMobileTab('review'); setManuscriptView('pdf'); setSidebar(false);
      if (!id) setPlaygroundNotes(value => value + 1);
    };
    window.addEventListener('papilot:playground-open', open);
    return () => window.removeEventListener('papilot:playground-open', open);
  }, []);
  const reportError = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const acceptSavedTask = useCallback((saved: Task) => {
    // A snapshot requested before the save must not restore the old permissions.
    snapshotRequest.cancel();
    const previous = snapshotRef.current;
    if (!previous) return;
    const next = { ...previous, tasks: previous.tasks.map(current => current.id === saved.id && current.updatedAt <= saved.updatedAt ? saved : current) };
    snapshotRef.current = next; snapshotText.current = ''; setState(next);
  }, [snapshotRequest]);
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
      const load = (signal: AbortSignal) => import.meta.env.MODE === 'playground' ? api<Snapshot & { csrf: string }>('/state', undefined, signal).then(value => ({ value, tag: '' }))
        : requestState<Snapshot & { csrf: string }>(token, snapshotRef.current && /^(W\/)?"/.test(snapshotText.current) ? snapshotText.current : '', signal);
      await snapshotRequest.run('state', load, ({ value: next, tag }) => {
        // Most polls find nothing new; an identical snapshot leaves the app as it is.
        if (!next) { setOnline(true); setConnectionError(''); return; }
        const text = tag || JSON.stringify(next);
        if (text === snapshotText.current && snapshotRef.current) { setOnline(true); setConnectionError(''); return; }
        snapshotText.current = text;
        const selection = selectedRef.current, previous = snapshotRef.current;
        const removed = previous?.tasks.find(t => t.id === selection && !next.tasks.some(nextTask => nextTask.id === selection));
        if (removed) setProjectId(removed.projectId);
        token = next.csrf; snapshotRef.current = next; setState(next); setOnline(true); setConnectionError('');
        // Tell the author what changed while they were in another tab or app.
        if (previous && notifying() && (document.hidden || !document.hasFocus())) for (const alert of taskAlerts(previous, next, notificationState().events)) void notify(alert, id => { setSelected(id); setSidebar(false); setSettings(false); });
        for (const id of composers.current.keys()) if (!next.tasks.some(t => t.id === id)) { composers.current.delete(id); timelineCache.current.delete(id); browserStorage.removeItem('papilot:draft:' + id); }
        setDeleteTarget(current => current && !next.tasks.some(t => t.id === current.id) ? null : current);
        setEditingPaper(current => current && !next.projects.some(p => p.id === current.id) ? null : current);
        for (const id of answerDrafts.current.keys()) if (!next.requests.some(r => r.id === id)) answerDrafts.current.delete(id);
        if (selection && !next.tasks.some(t => t.id === selection)) setSelected('');
        // An empty saved task is the manuscript, not a missing preference.
        if (!loaded.current) { loaded.current = true; if (!isPlayground && savedTask === null && !selection) setSelected(next.tasks.filter(task => !task.archivedAt).at(-1)?.id || ''); }
      });
      const selection = selectedRef.current;
      if (!document.hidden && selection && snapshotRef.current?.tasks.some(t => t.id === selection)) await refreshTimeline(selection);
    } catch (e) { setOnline(false); setConnectionError(e instanceof Error ? e.message : String(e)); }
  }, [snapshotRequest, refreshTimeline, savedTask]);
  useEffect(() => {
    if (isPlayground) {
      const update = () => { if (!document.hidden) void refresh(); };
      void refresh();
      window.addEventListener('papilot:playground-change', update);
      document.addEventListener('visibilitychange', update);
      return () => { window.removeEventListener('papilot:playground-change', update); document.removeEventListener('visibilitychange', update); };
    }
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
        const busy = snapshotRef.current?.tasks.some(t => ['preparing', 'running', 'waiting_input', 'queued', 'building'].includes(t.status));
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
  const demoRunning = isPlayground && state?.tasks.some(task => task.status === 'running' || task.status === 'building');
  useEffect(() => {
    if (!demoRunning) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 150);
    return () => clearInterval(timer);
  }, [demoRunning, refresh]);
  // A new list on every render would scroll the chat to its end each time.
  const taskRequests = useMemo(() => state?.requests.filter(r => r.taskId === selected) || [], [state?.requests, selected]);
  if (task && !composers.current.has(task.id)) composers.current.set(task.id, new ComposerDraft('papilot:draft:' + task.id, browserStorage, uuid));
  const fullPdfUrl = task?.status !== 'deleting' && task?.review?.round ? pdfAsset(`/api/tasks/${task.id}/pdf?round=${task.review.round}`) : '';
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
  const requirements = useSystemRequirements(!isPlayground && Boolean(state) && online, loadRequirements);
  const setupPrompted = useRef(false);
  const firstSetupVisit = useRef(!browserStorage.getItem('papilot:setup-seen') && !browserStorage.getItem('papilot:project'));
  useEffect(() => {
    if (!requirements.report || setupPrompted.current) return;
    setupPrompted.current = true;
    browserStorage.setItem('papilot:setup-seen', '1');
    const tool = missingTools(requirements)[0];
    if (firstSetupVisit.current && tool && !document.querySelector('dialog[open]')) setSettings(tool);
  }, [requirements.report]);
  const newFiles = useAttachmentDraft(`papilot:files:new:${project?.id || projectId}`);
  const tasks = state?.tasks.filter(t => !project || t.projectId === project.id) || [];
  const listedTasks = tasks.filter(task => Boolean(task.archivedAt) === showArchived);
  const searchTerms = taskSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visibleTasks = listedTasks.filter(task => {
    const text = `${task.title}\n${task.instructions}`.toLocaleLowerCase();
    return searchTerms.every(term => text.includes(term));
  });
  const running = state?.tasks.filter(t => ['preparing', 'running', 'waiting_input', 'building'].includes(t.status)).length || 0;
  // The desktop app opens a folder the way an editor does: the system picker,
  // then the paper itself. The browser imports a folder or ZIP in a dialog.
  function openProject() { if (isPlayground) { requestPlaygroundDownload(); return; } if (nativeFolders) void openFolder(); else setModal('project'); }
  async function openFolder(folder?: string, main?: string) {
    if (folderRequest.current) return;
    folderRequest.current = true;
    try {
      const path = folder ?? await chooseDirectory();
      if (!path) return;
      setOpeningFolder(true); setError('');
      const opened = await api<{ project: Project } | { name: string; candidates: string[] }>('/projects/open', { path, ...(main ? { main } : {}) });
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
  useEffect(() => window.papilotDesktop?.onOpenTask?.(id => {
    if (!snapshotRef.current?.tasks.some(task => task.id === id && task.status !== 'deleting')) return;
    setSelected(id); setSidebar(false); setSettings(false);
  }), []);
  // Fallbacks keep saved preferences intact in case they become available again.
  const runtimes: Partial<Record<AgentId, RuntimeStatus>> = state?.runtimes || (state ? { codex: state.runtime } : {});
  const offered = offeredAgents(runtimes), agentChoice = chosenAgent(savedAgent, offered, runtimes), missingAgent = noAgent(runtimes);
  const settled = agentsSettled(runtimes);
  useEffect(() => {
    // A later disconnect must keep the chosen agent and show its notice.
    // Nothing offered is not a choice: Codex is only the empty-state fallback.
    if (savedAgent === null && settled && offered.includes(agentChoice)) {
      setAgentChoice(agentChoice); browserStorage.setItem('papilot:agent', agentChoice);
    }
  }, [savedAgent, settled, agentChoice, offered]);
  const effectivePermissions = runtimes[agentChoice]?.permissionOptions?.some(option => option.value === newPermissions) ? newPermissions : 'workspace';
  const models = runtimes[agentChoice]?.models || [], pref = agentPrefs[agentChoice];
  const chosenModel = models.length && !models.some(m => m.id === pref.model) ? '' : pref.model;
  const modelInfo = models.find(m => m.id === chosenModel) || models.find(m => m.isDefault);
  const agent = { agent: agentChoice, model: modelInfo?.id || chosenModel, effort: taskEffort(pref.effort, modelInfo), serviceTier: agentChoice === 'codex' ? (pref.fast && modelInfo?.fastMode ? modelInfo.fastMode.serviceTier : 'default') : undefined };
  const remember = (change: Partial<{ model: string; effort: string; fast: boolean }>) => {
    setAgentPrefs(current => ({ ...current, [agentChoice]: { ...current[agentChoice], ...change } }));
    for (const [key, value] of Object.entries(change)) browserStorage.setItem(`papilot:${key}:${agentChoice}`, String(value));
  };
  // One choice in the picker sets both the agent and its model.
  const chooseModel = (id: AgentId, model: string) => {
    setAgentChoice(id); browserStorage.setItem('papilot:agent', id);
    setAgentPrefs(current => ({ ...current, [id]: { ...current[id], model } })); browserStorage.setItem(`papilot:model:${id}`, model);
  };
  const agentOptions = (disabled: boolean) => <AgentPicker disabled={disabled} noAgent={missingAgent} agent={agentChoice} model={agent.model} effort={agent.effort} fast={pref.fast}
    agents={offered.map(id => ({ value: id, label: AGENT_LABELS[id], runtime: runtimes[id] }))}
    permissionMode={newSkill?.output !== 'annotations' ? effectivePermissions : undefined}
    permissions={newSkill?.output !== 'annotations' && <PermissionOptions runtime={runtimes[agentChoice]} value={effectivePermissions} disabled={disabled} onChange={setNewPermissions}/>}
    reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')} onSelect={chooseModel} onChange={remember}/>;
  async function openPreparedTask(preset?: string, annotations?: string[]) {
    if (creating) return;
    setCreating(true); setCreateError('');
    try {
      const created = await api<Task>('/playground/tasks', { preset, annotations });
      timelineCache.current.delete(created.id); timelineRevisions.current.delete(created.id);
      await refresh(true);
      setTaskSearch(''); setShowArchived(false); setSelected(created.id); setPage('manuscript');
      setMobileTab(created.status === 'reviewing' ? 'review' : 'conversation'); setLayout('split'); setSidebar(false);
    } catch (e) { if (!(e instanceof Error && e.name === 'PlaygroundDownloadRequired')) setCreateError(e instanceof Error ? e.message : String(e)); }
    finally { setCreating(false); }
  }
  async function createTask() {
    if (missingAgent) return;
    const text = newDraft.trim(), target = project?.id || projectId, skill = newSkill;
    const reviewing = skill?.output === 'annotations';
    const attached = reviewing ? [] : noteSelection.selected, files = reviewing ? [] : newFiles.draft.getSnapshot().files;
    const groupInstructions = groupDrafts.forNotes(attached);
    if ((!text && !skill && !files.length && !attached.some(actionable) && !Object.keys(groupInstructions).length) || (!text && !skill && groupsWithoutInstructions(attached, groupInstructions).length > 0) || (!reviewing && newFiles.draft.getSnapshot().blocked) || creating || marking || noteEditing || reviewNoteBusy || history.busy || !target) return;
    if (isPlayground) {
      if (!text && !skill && !files.length && !Object.keys(groupInstructions).length && attached.length) await openPreparedTask(undefined, attached.map(note => note.id));
      else requestPlaygroundDownload();
      return;
    }
    const input = newTaskInput.current, submittedNotes = new Set(attached.map(note => note.id));
    const restoreFocus = input?.closest('form')?.contains(document.activeElement);
    setCreating(true); setCreateError('');
    try {
      // The ID is kept until creation succeeds, so a retried request cannot create a second task.
      const title = skill ? (text ? `${skillName(skill)}: ${taskTitle(text)}` : skillName(skill)).slice(0, 120) : text ? taskTitle(text) : attached.length === 1 ? taskTitle(attached[0].comment || (attached[0].group && groupInstructions[canonicalGroup(attached[0].group)]) || '') : attached.length ? t('Address {n} PDF notes', { n: attached.length }) : files[0].name.slice(0, 120);
      const body = { projectId: target, title, instructions: text, ...(skill ? { skill: skill.id } : {}), ...(attached.length ? { annotations: [...submittedNotes] } : {}), ...(Object.keys(groupInstructions).length ? { groupInstructions } : {}), ...(files.length ? { attachments: files.map(file => file.id) } : {}), agent: agent.agent, model: agent.model, effort: agent.effort, serviceTier: agent.serviceTier, permissions: !reviewing && runtimes[agent.agent]?.permissionOptions?.some(option => option.value === newPermissions) ? newPermissions : 'workspace' };
      const id = requestId(browserStorage, 'papilot:new-task-request', JSON.stringify([target, text, skill?.id || '', [...submittedNotes], groupInstructions, files.map(file => file.id)]), uuid);
      // The task answers at once and gets its manuscript copy in the background.
      const created = await api<Task>('/tasks', { ...body, id });
      const source = input?.getBoundingClientRect();
      browserStorage.removeItem('papilot:new-task-request');
      newFiles.draft.clear(files); setNewDraft(''); setNewSkill(null); setTaskSearch(''); setShowArchived(false);
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
      if (!reviewing) { noteSelection.reset(target); taskCards.forget(); }
      groupDrafts.sent(target, attached, notes);
      setActiveNote(id => submittedNotes.has(id) ? '' : id);
      setNoteGroup(null);
      // A later Undo may restore a deleted annotation, but its inclusion belonged
      // to the submitted draft. It must not attach itself to the next task.
      for (const direction of ['undo', 'redo'] as const) history[direction] = history[direction]
        .filter(entry => !submittedNotes.has(entry.note.id))
        .map(entry => !reviewing && entry.note.projectId === target ? { ...entry, selected: false } : entry);
      historyChanged();
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
  // Older backends do not report this capability. A current backend always
  // supplies it; never restore a saved Git page when Git is missing there.
  const gitAvailable = Boolean(state) && state?.gitAvailable !== false;
  useEffect(() => { if (state?.gitAvailable === false) setPage(current => current === 'git' ? 'manuscript' : current); }, [state?.gitAvailable]);
  const manuscriptOpen = !task && Boolean(project) && (page === 'manuscript' || page === 'git' && !gitAvailable);
  const referencesOpen = !task && Boolean(project) && page === 'references';
  const gitOpen = !task && Boolean(project) && page === 'git' && gitAvailable;
  const switchContext = useRef({ project: project?.id, path: project?.path, task: task?.id, page });
  if (switchContext.current.project !== project?.id || switchContext.current.path !== project?.path || switchContext.current.task !== task?.id || switchContext.current.page !== page) {
    switchContext.current = { project: project?.id, path: project?.path, task: task?.id, page };
  }
  const switchRequest = useRef(0);
  async function switchWorkspace(id: string) {
    try {
      const request = ++switchRequest.current, context = switchContext.current;
      if (id === (task?.id ?? (manuscriptOpen ? '' : null))) return;
      if (manuscriptNavigationGuard.current && !await manuscriptNavigationGuard.current.save()) return;
      // A later shortcut or mouse navigation supersedes a slow note save.
      if (request !== switchRequest.current || context !== switchContext.current) return;
      // Saving a note can take time; recheck the destination before navigating.
      if (id && !snapshotRef.current?.tasks.some(next => next.id === id && next.projectId === project?.id && next.status !== 'deleting' && !next.archivedAt)) return;
      setSelected(id); setPage('manuscript'); setRegion(false); setSidebar(false); setTaskSearch('');
      if (!id && mobile) setManuscriptView('pdf');
    } catch (error) { reportError(error); }
  }
  async function openGit() {
    if (!gitAvailable) return;
    if (manuscriptNavigationGuard.current && !await manuscriptNavigationGuard.current.save()) return;
    if (snapshotRef.current?.gitAvailable === false) return;
    if (mobile && project) savePlace('git-view:' + project.id, 'changes');
    setSelected(''); setPage('git'); setRegion(false); setSidebar(false);
  }
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
  const needsManuscript = manuscriptOpen || Boolean(task && (task.mode !== 'review' || task.preparation));
  const manuscriptBuilding = manuscript.projectId === project?.id && manuscript.data?.build.status === 'building';
  const holdingLegacyManuscript = Boolean(task && !manuscriptOpen && !task.deferred && (task.review?.counts?.pending ?? 0) > 0 && manuscript.projectId === project?.id && manuscript.data);
  useEffect(() => {
    if (!needsManuscript || !project || holdingLegacyManuscript) return;
    void loadManuscript(project.id);
    const focus = () => void loadManuscript(project.id);
    window.addEventListener('focus', focus);
    window.addEventListener('papilot:manuscript', focus);
    return () => { ++manuscriptRequest.current; window.removeEventListener('focus', focus); window.removeEventListener('papilot:manuscript', focus); };
  }, [needsManuscript, holdingLegacyManuscript, project?.id, project?.path, loadManuscript]);
  // Starting a compile switches to fast polling immediately, including a
  // manual retry made between the regular working-tree refreshes.
  useEffect(() => {
    if ((!manuscriptOpen && !manuscriptBuilding) || !needsManuscript || !project) return;
    // Papilot compiles after its own writes and tells the view; this notices
    // edits saved by another editor.
    const delay = manuscriptBuilding ? 1500 : 5000;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await loadManuscript(project.id); if (!stopped) timer = setTimeout(() => void tick(), delay); };
    timer = setTimeout(() => void tick(), delay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [manuscriptOpen, needsManuscript, project?.id, manuscriptBuilding, loadManuscript]);
  // Accepting a change updates the working tree, so the status reloads with
  // the tasks' reviews as well as every 20 seconds.
  const reviewKey = (state?.tasks || []).filter(t => t.projectId === project?.id).map(t => `${t.review?.files?.join()}:${t.review?.counts?.accepted}`).join('|');
  useEffect(() => {
    if (!project || manuscriptOpen || !gitAvailable) return;
    let live = true;
    const load = () => void api<GitStatus>(`/projects/${project.id}/git`).then(status => { if (live) setGit({ projectId: project.id, status }); }).catch(() => undefined);
    load(); const timer = setInterval(load, gitOpen ? 5000 : 20000);
    window.addEventListener('focus', load);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', load); };
  }, [project?.id, project?.path, manuscriptOpen, gitOpen, gitAvailable, reviewKey]);
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
  // A note being saved shows its new text everywhere at once, over the saved
  // notes, so the same note opened in another list starts from it. A failed
  // save just uncovers the saved text again.
  const [pendingComments, setPendingComments] = useState<Record<string, { comment: string; version: number }>>({});
  const savedNotes = manuscriptData.data?.annotations;
  const notes = useMemo(() => (savedNotes || []).map(note => pendingComments[note.id] ? { ...note, comment: pendingComments[note.id].comment } : note), [savedNotes, pendingComments]);
  const shownManuscript = useMemo(() => manuscriptData.data && { ...manuscriptData.data, annotations: notes }, [manuscriptData.data, notes]);

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
    selection: { ...noteSelection, set(ids, checked) {
      // Every deselection entry point (PDF, library and task) waits for the
      // task draft to save. A failed save leaves it attached and recoverable.
      if (checked) noteSelection.set(ids, true);
      else void taskCards.saveAll(ids).then(saved => { if (saved) noteSelection.set(ids, false); });
    } },
    instructions: groupDrafts,
    group: noteGroup, setGroup: setNoteGroup,
    async add(page, rect, rects, quote, comment, group, options) {
      if (!project || !manuscriptData.data?.build.key) throw new Error(t('Wait for the PDF to compile.'));
      setMarking(value => value + 1);
      try {
        // The pages that were marked, which a newer pass may have replaced since.
        const kind = options?.kind, stamp = options?.stamp, key = options?.key || manuscriptData.data.build.key;
        const note = await api<Annotation>(`/projects/${project.id}/annotations`, { key, page, rect, ...(rects.length ? { rects, quote } : kind === 'point' ? { quote } : {}), comment, ...(group ? { group } : {}), ...(kind ? { kind } : {}), ...(stamp ? { stamp } : {}) });
        if (annotationHistory.current !== history) return;
        withNotes(list => [...list, note]);
        // A note made on earlier pages appears on the current ones once placed there.
        if (note.key !== manuscriptData.data.build.key) window.dispatchEvent(new Event('papilot:manuscript'));
        // Quick marks stay on the page without opening a card.
        const quick = Boolean(group || stamp || kind === 'delete');
        if (quick) setActiveNote(''); else if (options?.reveal !== false) setActiveNote(note.id);
        if (options?.quote) noteSelection.set([note.id], true);
        recordAnnotation({ kind: 'add', note });
      } finally { setMarking(value => value - 1); }
    },
    // Each queue retains the last successful server value, independently of
    // optimistic text. Failed writes must never become an Undo destination.
    async edit(note, comment) {
      const version = ++noteEditVersion.current;
      setPendingComments(current => ({ ...current, [note.id]: { comment, version } }));
      const queue = noteWrites.current.get(note.id) || { saved: savedNotes?.find(item => item.id === note.id) || note, tail: Promise.resolve() };
      const write = queue.tail.then(async () => {
        const before = queue.saved;
        const saved = await api<Annotation>(`/projects/${note.projectId}/annotations/${note.id}`, { comment });
        queue.saved = saved;
        if (annotationHistory.current !== history) return;
        withNotes(list => list.map(item => item.id === note.id ? saved : item));
        if (before.comment !== saved.comment) recordAnnotation({ kind: 'edit', note: before, comment: saved.comment });
      });
      // Later writes may proceed after a failure; this caller still receives it.
      const tail = write.catch(() => undefined);
      queue.tail = tail; noteWrites.current.set(note.id, queue);
      try { await write; }
      finally {
        if (noteWrites.current.get(note.id) === queue && queue.tail === tail) noteWrites.current.delete(note.id);
        setPendingComments(current => {
          if (current[note.id]?.version !== version) return current;
          const next = { ...current }; delete next[note.id]; return next;
        });
      }
    },
    async remove(note) {
      const selected = noteSelection.has(note.id);
      await api(`/projects/${note.projectId}/annotations/${note.id}/delete`, {});
      if (annotationHistory.current !== history) return;
      noteSelection.set([note.id], false);
      withNotes(list => list.filter(item => item.id !== note.id));
      setActiveNote(id => id === note.id ? '' : id);
      recordAnnotation({ kind: 'remove', note, selected });
    },
    // The deletion toast shares history with the rail and keyboard shortcuts.
    async restore(note) {
      const restored = await api<{ annotations: Annotation[] }>(`/projects/${note.projectId}/annotations/${note.id}/restore`, {});
      if (annotationHistory.current !== history) return;
      const deletion = history.undo.filter(entry => entry.kind === 'remove' && entry.note.id === note.id).at(-1);
      history.undo = history.undo.filter(entry => !(entry.kind === 'remove' && entry.note.id === note.id));
      if (deletion) history.redo.push(deletion);
      historyChanged();
      withNotes(() => restored.annotations); setActiveNote(note.id);
      if (deletion?.selected) noteSelection.set([note.id], true);
    },
    onEditing: setNoteEditing,
    onReviewBusy: setReviewNoteBusy,
    sending: creating || reviewNoteBusy || history.busy,
  };
  // Keep task editors alive across tabs, skills and paper switches. Undefined
  // notes mean the paper is still loading, so its drafts must not be pruned.
  const taskCards = useNoteCards(manuscriptData.data ? notes : undefined, noteActions, undefined, project?.id || projectId);
  const noteEditing = pdfNoteEditing || taskCards.editing || taskCards.busy;
  const replayAnnotation = (direction: 'undo' | 'redo') => {
    const entry = history[direction].at(-1);
    if (!manuscriptOpen || !entry) return false;
    if (creating || marking || noteEditing || reviewNoteBusy || noteWrites.current.size || history.busy) return true;
    history.busy = true; historyChanged();
    setError('');
    const { note } = entry;
    void (async () => {
      try {
        if (entry.kind === 'edit') {
          const saved = await api<Annotation>(`/projects/${note.projectId}/annotations/${note.id}`, { comment: direction === 'undo' ? note.comment : entry.comment });
          if (annotationHistory.current !== history) return;
          withNotes(list => list.map(item => item.id === note.id ? saved : item));
        } else if ((entry.kind === 'add') === (direction === 'undo')) {
          const selected = noteSelection.has(note.id);
          await api(`/projects/${note.projectId}/annotations/${note.id}/delete`, {});
          if (annotationHistory.current !== history) return;
          withNotes(list => list.filter(item => item.id !== note.id));
          entry.selected = selected; noteSelection.set([note.id], false); setActiveNote(id => id === note.id ? '' : id);
        } else {
          const restored = await api<{ annotations: Annotation[] }>(`/projects/${note.projectId}/annotations/${note.id}/restore`, {});
          if (annotationHistory.current !== history) return;
          withNotes(() => restored.annotations);
          if (entry.selected) noteSelection.set([note.id], true);
          if (entry.kind === 'remove') setActiveNote(note.id);
        }
        history[direction] = history[direction].filter(item => item !== entry);
        history[direction === 'undo' ? 'redo' : 'undo'].push(entry);
      } catch (error) { reportError(error); }
      finally { history.busy = false; historyChanged(); }
    })();
    return true;
  };
  const historyDisabled = creating || Boolean(marking) || noteEditing || reviewNoteBusy || history.busy || noteWrites.current.size > 0;
  noteActions.history = {
    canUndo: Boolean(history.undo.length) && !historyDisabled,
    canRedo: Boolean(history.redo.length) && !historyDisabled,
    undo: () => { replayAnnotation('undo'); }, redo: () => { replayAnnotation('redo'); },
  };
  useNoteUndo(() => replayAnnotation('undo'), undefined, () => replayAnnotation('redo'));

  const waiting = state?.tasks.filter(t => t.status === 'waiting_input').length || 0;
  useEffect(() => { document.title = isPlayground ? 'Papilot Demo' : (waiting ? `(${waiting}) ` : '') + (task ? `${task.title} · Papilot` : gitOpen && project ? `${t('Version Management')} · ${project.name} · Papilot` : manuscriptOpen && project ? `${project.name} · Papilot` : 'Papilot'); }, [waiting, task?.title, manuscriptOpen, gitOpen, project?.name, uiLanguage]);
  const replyNeeded = Boolean(task && state?.requests.some(r => r.taskId === task.id));
  const pending = task?.review?.counts?.pending || 0;
  const localReview = useReviewDraft(task?.id || '');
  const hasReviewFeedback = Boolean(reviewSubmission(localReview).notes.length || pendingReviewFeedback(task?.review || null));
  // Notes and comments ask the agent for a revision, so saving waits for them.
  // Rejections are decisions: the rejected edits are simply left out, and
  // telling the agent about them stays optional.
  const asksRevision = Boolean(reviewSubmission(localReview).notes.length || (pendingReviewFeedback(task?.review || null) && (task?.review?.comments ?? task?.review?.counts?.commented ?? 0) > 0));
  const active = Boolean(task && ACTIVE.includes(task.status));
  const taskLayout = layout, taskTab = mobileTab;
  const conversationVisible = mobile ? taskTab === 'conversation' : taskLayout !== 'review';
  const pause = () => { if (task) void action('/tasks/' + task.id + '/interrupt'); };
  // With only the chat in view, the feedback bar moves to the end of the conversation.
  const chatOnly = mobile ? taskTab === 'conversation' : taskLayout === 'conversation';
  const saved = task ? taskSaveStatus(task) : null;
  const savedResult = (message: string) => <TaskSaved message={message} disabled={taskActionBusy} onArchive={task && saved && !task.archivedAt && taskFinished(task) ? () => void archiveTask(task) : undefined}
    onDelete={task && saved && taskFinished(task) ? () => void deleteSavedTask(task) : undefined}/>;
  const merging = task?.reconciliation;
  const mergeWaiting = Boolean(merging && (!merging.ready || (task?.review?.round ?? 0) <= merging.round));
  const deliveryReady = !asksRevision && task?.deferred && task.status === 'reviewing' && !task.pendingReview && task.review?.state === 'done' && !task.review.counts.pending
    && (Boolean(task.review.files?.length) || task.delivery?.mode === 'branch' || task.delivery?.pending || merging);
  const applyKey = task?.id || '';
  if (deliveryReady && !applyStates.current.has(applyKey)) applyStates.current.set(applyKey, new TaskApplyState(merging?.intent?.message || task!.title));
  const saveTask = async (mode: 'workspace' | 'commit', message?: string, confirmation?: string) => {
    if (!task) return;
    const result = await api<{ git?: GitStatus; commitReview?: TaskCommitReview }>(`/tasks/${task.id}/apply`, { mode, message, confirmation, keepCurrent: mergeWaiting && merging?.ready });
    if (result.git) updateGit(task.projectId, result.git);
    await refresh(true);
    return result;
  };
  // Older tasks accepted directly into the manuscript; retain their existing
  // commit form while new isolated tasks save only their reviewed delta.
  const legacyFiles = task && !hasReviewFeedback && !task.deferred && !projectGit?.merging && task.status === 'reviewing' && !task.pendingReview && !pending
    ? (task.review?.files || []).filter(file => projectGit?.files.some(item => item.path === file)) : [];
  const legacyKey = JSON.stringify([task?.id, legacyFiles, task?.committed?.accepted, projectGit?.branch]);
  if (legacyFiles.length && !commitDrafts.current.has(legacyKey)) commitDrafts.current.set(legacyKey, new TaskCommitDraft());
  const legacySave = task && legacyFiles.length ? <TaskCommit draft={commitDrafts.current.get(legacyKey)!} branch={projectGit?.branch ?? null} remote={Boolean(projectGit?.remote)} agent={agentName(task)} disabled={taskActionBusy}
    generate={fresh => api<{ message: string }>(`/projects/${task.projectId}/git/message`, { paths: legacyFiles, agent: task.agent || 'codex', fresh }).then(result => result.message)}
    commit={async (message, push) => {
      const result = await api<{ commit: string; git: GitStatus; pushError?: string }>(`/tasks/${task.id}/commit`, { message, push });
      updateGit(task.projectId, result.git);
      if (result.pushError) reportError(result.pushError);
      await refresh(true);
      return push && !result.pushError ? t('Committed {hash} and pushed.', { hash: result.commit }) : t('Committed {hash}.', { hash: result.commit });
    }}/> : task?.committed && saved ? savedResult(saved === 'pushed' ? t('Committed {hash} and pushed.', { hash: task.committed.hash }) : t('Committed {hash}.', { hash: task.committed.hash })) : null;
  const applicationStep = task && (deliveryReady ? <TaskApply key={applyKey} draft={applyStates.current.get(applyKey)!} merging={Boolean(merging)} keepCurrent={mergeWaiting && merging?.ready} disabled={taskActionBusy}
    branch={projectGit?.branch ?? null} canCommit={Boolean(task.review?.files?.length || task.delivery?.mode === 'branch' || task.delivery?.pending)} preferred={merging?.intent?.mode}
    pending={task.delivery?.pending && task.delivery.mode !== 'branch' ? task.delivery.mode : undefined}
    apply={() => saveTask('workspace')} commit={(message, confirmation) => saveTask('commit', message, confirmation)}
    generate={() => api<{ message: string }>(`/tasks/${task.id}/commit-message`, { fresh: true }).then(result => result.message)}
    shown={isPlayground ? undefined : () => void api(`/tasks/${task.id}/predict`, {}).catch(() => undefined)}/>
    : merging ? <TaskConflict status={task.status} waiting={mergeWaiting} onChat={() => selectLayout('conversation')}/>
    : saved === 'committed' && task.delivery ? savedResult(t('Committed {hash} to {branch}', { hash: task.delivery.commit?.slice(0, 7) || '', branch: task.delivery.branch || '' }))
    : !task.deferred ? legacySave : saved === 'applied' ? savedResult(t('Applied to manuscript')) : null);
  const reviewFeedback = (card: boolean) => task?.mode === 'review' ? (card && task.aiReview?.notes ? <button type="button" className="ai-review-link" onClick={() => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); }}><Icon name="notes" size={14}/>{tn(task.aiReview.notes, 'View {n} review suggestion', 'View {n} review suggestions')}<Icon name="arrowRight" size={13}/></button> : null) : null;
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
    // A skipped or timed-out animation can reject ready independently of
    // finished. Observe every promise; the layout update still takes effect.
    void transition.ready.catch(() => {});
    void transition.updateCallbackDone.catch(() => {});
    void transition.finished.then(finish, finish);
  }
  const taskStateActions = task && (
        <div className="task-state-actions">
          {task.status === 'deleting' ? <button className="button secondary compact" onClick={() => setDeleteTarget(task)}>{t('Retry deletion')}</button> : task.status === 'uncertain' ? <button className="button secondary compact" disabled={taskActionBusy} aria-busy={taskActionBusy} onClick={() => void action('/tasks/' + task.id + '/reconcile')}><Icon name="refresh" size={14}/>{t('Check status')}</button> : active && !conversationVisible ? <button className="button secondary compact" aria-label={t('Pause task')} title={t('Pause {agent}', { agent: agentName(task) })} disabled={taskActionBusy} aria-busy={taskActionBusy} onClick={pause}><Icon name="pause" size={14}/><span className="button-label">{t('Pause')}</span></button> : task.error ? <button className="button secondary compact" onClick={() => { setMobileTab('conversation'); setLayout('conversation'); }}>{t('View details')}</button> : null}
        </div>
  );
  const workspaceViews = task && <div className="view-selector workspace-view-selector" role="group" aria-label={t('Workspace view')}>{mobile ? <>
          <button aria-label={pending ? t('Review, {n} to decide', { n: pending }) : t('Review')} aria-pressed={mobileTab === 'review'} onClick={() => selectLayout('review')}><Icon name="paper" size={16}/><span>{t('Review')}</span>{pending > 0 && <b className="view-count" aria-hidden="true">{pending}</b>}</button>
          <button aria-label={replyNeeded ? t('Chat (reply needed)') : t('Chat')} aria-pressed={mobileTab === 'conversation'} onClick={() => selectLayout('conversation')}><Icon name="chat" size={16}/><span>{t('Chat')}</span>{replyNeeded && <i className="attention-dot" aria-hidden="true"/>}</button>
        </> : <>
          <button aria-label={t('Review')} title={t('PDF review only')} aria-pressed={layout === 'review'} onClick={() => selectLayout('review')}><Icon name="paper" size={16}/><span>{t('Review')}</span></button>
          <button aria-label={t('Split')} title={t('Review and chat side by side')} aria-pressed={layout === 'split'} onClick={() => selectLayout('split')}><Icon name="split" size={16}/><span>{t('Split')}</span></button>
          <button aria-label={replyNeeded ? t('Chat (reply needed)') : t('Chat')} title={noManuscriptChanges(task) ? t('This conversation has no manuscript changes.') : t('Chat only')} aria-pressed={layout === 'conversation'} onClick={() => selectLayout('conversation')}><Icon name="chat" size={16}/><span>{t('Chat')}</span>{replyNeeded && <i className="attention-dot" aria-hidden="true"/>}</button>
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
    { label: t('Open PDF'), icon: 'external', href: pdfAsset(`/api/projects/${project.id}/manuscript.pdf?key=${pdfKey}`) },
    { label: t('Export PDF'), icon: 'download', href: pdfAsset(`/api/projects/${project.id}/manuscript.pdf?key=${pdfKey}&download=1`), download: true },
    { label: t('Export PDF with notes'), icon: 'notes', ...(isPlayground ? { select: requestPlaygroundDownload } : { href: `/api/projects/${project.id}/manuscript/annotated.pdf?key=${pdfKey}`, download: true }), disabled: !hasNotes, title: hasNotes ? undefined : t('No notes on this PDF yet') },
  ]}><Icon name="share" size={16}/></ActionMenu>;
  const manuscriptTools = project && <>
    <CompileButton key={project.id} label={t('Recompile PDF')} status={pendingManuscriptBuilds.has(project.id) ? 'building' : manuscriptData.error ? 'unknown' : manuscriptData.data?.build.status || 'unknown'} disabled={!manuscriptData.data && !manuscriptData.error} onCompile={async () => isPlayground ? requestPlaygroundDownload() : loadManuscript(project.id, true)}/>
  </>;
  const manuscriptNavigation = manuscriptOpen && project && <>
    <div className="view-selector manuscript-view-selector" role="group" aria-label={t('Manuscript view')}>
          <button aria-label="PDF" data-notes-home="pdf" aria-pressed={manuscriptView === 'pdf'} onClick={() => setManuscriptView('pdf')}><Icon name="pdf" size={16}/><span>PDF</span></button>
          <button aria-label={t('New task')} data-task-home aria-pressed={manuscriptView === 'task'} onClick={() => { setManuscriptView('task'); setRegion(false); }}><Icon name="compose" size={16}/><span>{t('New task')}</span>{noteSelection.selected.length > 0 && <b className="view-count" aria-hidden="true">{noteSelection.selected.length}</b>}</button>
        </div>
    {manuscriptView === 'pdf' && <div className="workspace-nav-end">{manuscriptTools}{manuscriptShare}</div>}
  </>;
  const newTaskPanel = (attachments: React.ReactNode) => <section className={'new-task-panel' + (noteSelection.selected.length ? ' has-notes' : '')} aria-label={t('New task')}>
    <div className="new-task-start">
    {!noteSelection.selected.length && <div className="new-task-welcome"><img src={logo} alt=""/><h2>{t('What are we revising next?')}</h2></div>}
    {newSkill?.output !== 'annotations' && attachments}
    {missingAgent && <NoAgentNotice reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')} onAdd={() => setSettings('agents')}/>}
    <Composer attachments={newSkill?.output === 'annotations' ? undefined : newFiles.draft} upload={(file, signal) => uploadAttachment(project!.id, file, signal)} imageHint={agentChoice === 'antigravity' && newFiles.files.some(file => file.mime.startsWith('image/'))} autoFocus inputRef={newTaskInput} label={t('Describe the revision')} value={newDraft} onChange={setNewDraft} readOnly={creating} onSubmit={() => void createTask()} placeholder={noteSelection.selected.length ? t('Add overall instructions (optional)') : t('Describe the revision')}
      skills={projectSkills} skill={newSkill} onSkill={setNewSkill}
      footer={attach => <div className="composer-options">
        <SkillPicker onAttach={newSkill?.output === 'annotations' ? undefined : attach} skills={projectSkills} selected={newSkill} disabled={creating} onPick={skill => { setNewSkill(skill); newTaskInput.current?.focus(); }}/>
        {agentOptions(creating)}
      </div>}
      action={<button className="send-button" type="submit" aria-label={t('Start task')} title={missingGroupDirections ? t('Add instructions to the selected color groups above.') : t('Start task (Enter)')} disabled={missingAgent || creating || reviewNoteBusy || noteEditing || history.busy || (newSkill?.output !== 'annotations' && (newFiles.blocked || marking > 0 || missingGroupDirections)) || (!newDraft.trim() && !newSkill && !newFiles.files.length && !noteSelection.selected.some(actionable) && !Object.keys(groupDirections).length)} aria-busy={creating}>{creating ? <span className="spinner light"/> : <Icon name="arrowUp" size={18}/>}</button>}/>
    {createError && <p className="inline-error" role="alert">{createError}</p>}
    {PlaygroundPresets && <Suspense fallback={null}><PlaygroundPresets selected={noteSelection.selected} open={id => openPreparedTask(id)} disabled={creating}/></Suspense>}
    {runtimes[agentChoice]?.usage && <UsageSummary agent={AGENT_LABELS[agentChoice]} usage={runtimes[agentChoice]!.usage!}/>}
    </div>
  </section>;

  return <NoteResultsProvider task={task} items={task ? timeline.taskId === task.id ? timeline.items : timelineCache.current.get(task.id) || [] : []} read={id => api(`/tasks/${id}/note-results`)} optionsRequest={(id, key, body) => body ? api(`/tasks/${id}/note-options`, { key, ...body }) : api(`/tasks/${id}/note-options?key=${encodeURIComponent(key)}`)} previewRequest={(id, key, round, option, retry, version) => api(`/tasks/${id}/note-options/preview?key=${encodeURIComponent(key)}&round=${round}&option=${encodeURIComponent(option)}${retry ? '&retry=1' : ''}${version ? '&comparison=' + encodeURIComponent(version) : ''}`)} openReview={() => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); }} openChat={() => { setMobileTab('conversation'); setLayout(current => current === 'review' ? 'split' : current); }}><div className={'app-shell' + (sidebarVisible ? '' : ' sidebar-collapsed')}>
    <DesktopWindowChrome/>
    {project && <WorkspaceSwitcher key={project.id} active={task?.id ?? (manuscriptOpen ? '' : null)}
      items={[{ id: '', title: t('Manuscript') }, ...[...tasks].reverse().filter(item => item.status !== 'deleting' && (!item.archivedAt || item.id === task?.id)).map(item => ({ id: item.id, title: item.title }))]}
      onSelect={id => void switchWorkspace(id)}/>}
    <aside ref={sidebarRef} role={narrow && sidebar ? 'dialog' : undefined} aria-modal={narrow && sidebar ? true : undefined} onKeyDown={e => { if (!narrow || !sidebar || modal || editingPaper) return; if (e.key === 'Escape') { e.preventDefault(); setSidebar(false); } else keepDialogFocus(e); }} id="task-sidebar" className={'sidebar ' + (sidebar ? 'is-open' : '')} aria-label={t('Papers and tasks')}>
      <div className="sidebar-header">
        {state?.projects.length && project ? <ActionMenu label={t('Paper: {name}', { name: project.name })} className="project-switcher" menuClassName="paper-menu" align="start" actions={[
          ...state.projects.map(p => ({ id: p.id, label: p.name, detail: shortPath(p.path), title: p.path, checked: p.id === project.id, select: p.id === project.id ? undefined : () => { setProjectId(p.id); setSelected(''); }, edit: { label: t('Edit {name}', { name: p.name }), select: () => setEditingPaper(p) } })),
          { label: nativeFolders ? t('Open a folder') : t('Add paper…'), icon: nativeFolders ? 'folder' : 'plus', divider: true, select: () => openProject() },
        ]}><span className="project-switcher-name">{project.name}</span><Icon name="chevronDown" size={13}/></ActionMenu>
          : <button className="add-project" disabled={!state} onClick={() => openProject()}><Icon name={nativeFolders ? 'folder' : 'plus'} size={16}/>{nativeFolders ? t('Open a folder') : t('Add paper')}</button>}
        <button className="icon-button" aria-label={t('Hide task list')} title={t('Hide task list')} onClick={hideSidebar}><Icon name={narrow ? 'close' : 'sidebar'} size={18}/></button>
      </div>
      <div className="sidebar-actions">
        {project && <>
          <button className={'nav-link manuscript-link' + (manuscriptOpen ? ' active' : '')} aria-current={manuscriptOpen ? 'page' : undefined} title={t('Switch tasks and manuscript') + ' (' + workspaceShortcutLabel + ')'} aria-keyshortcuts={workspaceModifier + '+`'} onClick={() => { setSelected(''); setPage('manuscript'); if (mobile) setManuscriptView('pdf'); setSidebar(false); }}><Icon name="pdf" size={16}/><span className="nav-label">{t('Manuscript')}</span></button>
          <button className={'nav-link git-link' + (gitOpen ? ' active' : '')} disabled={!gitAvailable} aria-describedby={!gitAvailable ? 'git-install-hint' : undefined} aria-label={gitAvailable && projectGit?.files?.length ? t('Version Management, {n} changed', { n: projectGit.files.length }) : t('Version Management')} aria-current={gitOpen ? 'page' : undefined} title={gitAvailable ? t('Version management of the manuscript') + '\n' + gitSummary(projectGit) : t('Install Git in this environment to use version management.')} onClick={openGit}><Icon name="restore" size={16}/><span className="nav-label">{t('Version Management')}</span><span className="nav-meta">{gitAvailable && projectGit?.files?.length ? <span className="count">{projectGit.files.length}</span> : null}</span></button>
          {!gitAvailable && <p className="git-install-hint" id="git-install-hint"><a href="https://git-scm.com/install/" target="_blank" rel="noreferrer">{t('Install Git in this environment to use version management.')}</a></p>}
          <ActionMenu label={t('Research Tools')} className="nav-link paper-tools" menuClassName="paper-tools-menu" align="side" actions={[
            { id: 'references', label: t('Reference check'), icon: 'checklist', detail: t('Citations, entries and their records'), hint: problems ? String(problems) : undefined, checked: referencesOpen || undefined, select: () => { if (isPlayground) { requestPlaygroundDownload(); return; } setSelected(''); setPage('references'); setSidebar(false); } },
          ]}><Icon name="tool" size={16}/><span className="nav-label">{t('Research Tools')}</span><Icon name="more" size={16}/></ActionMenu>
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
          {state && (!isPlayground ? <UpdateNotice api={api} version={state.version}/> : <span className="brand-version" title={t('Papilot {version}', { version: state.version })}>v{versionLabel(state.version)}</span>)}
        </div>
        <button type="button" className="icon-button settings-link" aria-label={t('Settings')} title={t('Settings')} aria-haspopup="dialog" onClick={() => setSettings('general')}><Icon name="settings" size={18}/></button>
      </div>
    </aside>
    {sidebar && narrow && <button tabIndex={-1} className="sidebar-scrim" aria-label={t('Close task list')} onClick={() => setSidebar(false)}/>}
    <main className="main" inert={narrow && sidebar}>
      <h1 className="sr-only">{task ? task.title : manuscriptOpen ? t('Manuscript') : referencesOpen ? t('Reference check') : gitOpen ? t('Version Management') : 'Papilot'}</h1>
      {flyingTask && <TaskFlight task={flyingTask} sidebarShown={sidebarShown} onArrive={taskArrived}/>}
      <span className="sr-only" role="status" aria-atomic="true">{addedTask ? t('Task added: {title}', { title: addedTask.title }) : ''}</span>
      {!gitOpen && (mobile || (!task && !manuscriptOpen)) && (sidebarToggle || task || manuscriptOpen) && <div className="workspace-navigation">
        {sidebarToggle}{taskControls}{manuscriptNavigation}{reviewOpen}
      </div>}
      {state && <RequirementsBanner state={requirements} onOpen={setSettings}/>}
      {state && !online && <div className="connection-banner" role="status"><Icon name="alert" size={15}/><span>{t('Connection lost. Showing the last update; your draft is kept.')}</span><button onClick={() => void refresh(true)}>{t('Retry connection')}</button></div>}
      {task ? <div className={`task-grid layout-${taskLayout} show-${taskTab}`} style={chatWidth ? { '--chat-width': `${chatWidth}px` } as React.CSSProperties : undefined}>
          {!mobile && taskLayout === 'split' && <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label={t('Resize chat panel')} aria-valuenow={chatWidth || undefined} aria-valuemin={300} tabIndex={0} title={t('Drag to resize · Double-click to reset')} onPointerDown={resizeChat} onDoubleClick={() => setChatWidth(0)} onKeyDown={nudgeChat}/>}
          <section id="review-panel" className="review-panel" aria-label={t('PDF review')}>
          {!mobile && !chatOnly && task.status === 'deleting' && (sidebarToggle || !conversationVisible) && <div className="review-placeholder-toolbar">{sidebarToggle}{!conversationVisible && workspaceViews}<div className="panel-tools">{!conversationVisible && taskStateActions}</div></div>}
          {(task.review?.state === 'build_failed' || task.status === 'failed' && task.review?.job?.status === 'failed') && <div className="review-build-error" role="status"><Icon name="alert" size={15}/><span>{t('Could not generate the PDF comparison.')}</span><button className="button secondary compact" disabled={taskActionBusy} onClick={() => void action('/tasks/' + task.id + '/publish')}>{t('Retry build')}</button></div>}
          {task.status === 'deleting' ? <div className="review-placeholder"><div className="placeholder-icon"><Icon name="trash" size={22}/></div><h2>{t('Deletion is in progress')}</h2><p>{t('This task is reserved until its worktree cleanup is confirmed. Use Retry deletion if the connection was interrupted.')}</p></div> : !task.preparation && task.mode === 'review' ? <AiReviewView key={task.id} task={task} api={api} onCopied={() => void loadManuscript(task.projectId)} lead={!mobile && !chatOnly && (sidebarToggle || !conversationVisible) ? <>{sidebarToggle}{!conversationVisible && workspaceViews}</> : null} tools={!mobile && !conversationVisible ? taskStateActions : null}/> : <TaskDocument key={task.id} projectId={task.projectId} manuscript={manuscriptData.data} placeholder={task.preparation ? <PreparingTask task={task}/> : <PendingComparison task={task} busy={taskActionBusy} onBuild={() => void action('/tasks/' + task.id + '/publish')}/>} task={task} onDecided={() => void refresh(true)} lead={!mobile && !chatOnly && (sidebarToggle || !conversationVisible) ? <>{sidebarToggle}{!conversationVisible && workspaceViews}</> : null} tools={<>{reviewTools}{!mobile && !conversationVisible && <>{taskStateActions}{reviewOpen}</>}</>} completion={chatOnly ? null : applicationStep} onComment={() => { setMobileTab('conversation'); setLayout(current => current === 'review' ? 'split' : current); }}/>}
        </section><Activity key={task.id} onRevealQuote={() => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); }} task={task} lead={!mobile && chatOnly ? sidebarToggle : null} tools={!mobile && conversationVisible ? <>{taskControls}{reviewOpen}</> : null} connection={<AgentConnectionNotice name={agentName(task)} runtime={runtimes[task.agent || 'codex']} reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')}/>} runtime={runtimes[task.agent || 'codex']} reconnecting={pendingActions.has('/reconnect')} onReconnect={() => void action('/reconnect')} composer={composers.current.get(task.id)!} answerDrafts={answerDrafts.current} items={timeline.taskId === task.id ? timeline.items : timelineCache.current.get(task.id) || []} loading={timeline.taskId === task.id ? itemsLoading : !timelineCache.current.has(task.id)} loadError={timelineError.taskId === task.id ? timelineError.message : ''} retry={() => void refreshTimeline(task.id)} requests={taskRequests} refresh={() => void refresh(true)} errorActions={task.preparation && task.status === 'failed' ? <div className="task-error-actions">
            <button type="button" className="button secondary compact" disabled={taskActionBusy} aria-busy={taskActionBusy} onClick={() => void action('/tasks/' + task.id + '/prepare')}><Icon name="refresh" size={14}/>{t('Retry')}</button>
            <button type="button" className="button secondary compact" onClick={() => setDeleteTarget(task)}><Icon name="trash" size={14}/>{t('Delete task…')}</button>
          </div> : null} onTaskSaved={acceptSavedTask} reportError={reportError} pause={pause} pausing={taskActionBusy} skills={projectSkills} feedback={chatOnly ? <>{reviewFeedback(true)}{applicationStep && <div className="review-feedback card commit-card task-delivery">{applicationStep}</div>}</> : null} openReview={chatOnly ? () => { setMobileTab('review'); setLayout(current => current === 'conversation' ? 'split' : current); } : undefined}/></div>
      : manuscriptOpen && project ? <ManuscriptView notesRequest={playgroundNotes} taskCards={taskCards} key={project.id + project.path} navigationGuard={manuscriptNavigationGuard} collapsed={manuscriptCollapsed} setCollapsed={setManuscriptCollapsed} navigation={!mobile ? sidebarToggle : null} project={project} data={shownManuscript} error={manuscriptData.error} view={manuscriptView} setView={setManuscriptView} region={region} setRegion={setRegion} active={activeNote} setActive={setActiveNote} actions={noteActions} newTask={newTaskPanel} tools={!mobile ? manuscriptTools : null} share={!mobile ? manuscriptShare : null} onFixProblems={fixProblems} onGit={status => updateGit(project.id, status)} writer={{ agent: agent.agent, model: agent.model }} reportError={reportError}/>
      : gitOpen && project ? <GitWorkspace key={project.id + project.path} projectId={project.id} navigation={sidebarToggle} git={projectGit} onStatus={status => updateGit(project.id, status)} writer={{ agent: agent.agent, model: agent.model }} tasks={state?.tasks.filter(task => task.projectId === project.id) || []} onOpenTask={id => { setSelected(id); setSidebar(false); }}/>
      : referencesOpen && project ? <section className="references-page" aria-label={t('Reference check')}>
          <header className="references-page-head"><h2>{t('Reference check')}</h2><span>{project.name}</span></header>
          <ReferencesPanel key={project.id} place={'references:' + project.id} data={bibliography} onInvestigate={draftInvestigation}/>
        </section>
      : !state ? <div className="home"><div className="home-inner"><div className="home-mark"><span className="spinner"/></div><h1>{t('Opening your workspace')}</h1><p className="home-copy" role="status">{connectionError || t('Connecting to your papers and tasks…')}</p>{connectionError && <button className="button secondary" onClick={() => void refresh(true)}>{t('Retry connection')}</button>}</div></div>
      : <div className="home"><div className="home-inner"><img className="home-logo" src={logo} alt=""/><h1>{t('Add your first paper')}</h1><button className="button primary" onClick={() => openProject()}><Icon name={nativeFolders ? 'folder' : 'plus'} size={16}/>{nativeFolders ? t('Open a folder') : t('Add paper')}</button></div></div>}
    </main>
    {error && !modal && <div role="alert" className="toast"><Icon name="alert" size={16}/><span>{error}</span><button className="icon-button" aria-label={t('Dismiss error')} onClick={() => setError('')}><Icon name="close" size={14}/></button></div>}
    {settings && <SettingsDialog requirements={isPlayground ? undefined : { state: requirements, online }} modelDefaults={{ agents: offered.map(id => ({ value: id, label: AGENT_LABELS[id], runtime: runtimes[id] })), agent: agentChoice, model: chosenModel, effort: agent.effort, onSelect: chooseModel, onEffort: effort => remember({ effort }) }} updates={!isPlayground ? api : undefined} initialPage={settings} theme={theme.theme} onTheme={theme.setTheme} resolved={theme.resolved} appearance={theme.appearance} onAppearance={theme.setAppearance} onClose={() => setSettings(false)} diagnostics={!isPlayground ? { online, runtimes, project, check: checkDiagnostics, latex: detectLatexInstallation, reconnect: async () => { await api('/reconnect', {}); await refresh(true); } } : undefined} skills={!isPlayground ? { project, api, onChanged: () => setSkillsRevision(value => value + 1) } : undefined}/>}
    {deleteTarget && <DeleteTaskDialog task={state?.tasks.find(t => t.id === deleteTarget.id) || deleteTarget} submit={() => api('/tasks/' + deleteTarget.id + '/delete', { confirm: true })} onClose={() => setDeleteTarget(null)} onDeleted={() => taskDeleted(deleteTarget.id)} refresh={() => void refresh(true)}/>}
    {editingPaper && <PaperDialog key={editingPaper.id} paper={editingPaper} onClose={() => setEditingPaper(null)} save={async form => {
      const paper = editingPaper, pathChanged = form.path !== paper.path;
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

  </div></NoteResultsProvider>;
}

function Root() {
  if (PlaygroundNotice) return <Suspense fallback={null}><div className="playground-root"><PlaygroundNotice/><App/></div></Suspense>;
  return <App/>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root/></StrictMode>);
