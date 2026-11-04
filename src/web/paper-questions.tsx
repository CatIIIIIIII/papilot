import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_NAMES, DEFAULT_QUESTION_SESSION, QUESTION_AGENTS, type AgentId, type PaperQuestion, type PaperQuestionSession, type RuntimeStatus } from '../shared.ts';
import { browserStorage } from './storage.ts';
import { sendsMessage } from './composer.ts';
import { Markdown } from './markdown.tsx';
import { Icon } from './icons.tsx';
import { t, errorText, locale } from './i18n.ts';
import './paper-questions.css';
import { AgentPicker } from './agent-picker.tsx';
import logo from './logo.svg';
import { ActionMenu } from './action-menu.tsx';
import { DeleteQuestionSessionDialog } from './question-session-dialog.tsx';

export function QuestionSplit({ children, questions }: { children: ReactNode; questions?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => Math.max(35, Math.min(65, Number(browserStorage.getItem('papilot:question-split')) || 50)));
  const resize = (value: number) => { const next = Math.max(35, Math.min(65, value)); setRatio(next); browserStorage.setItem('papilot:question-split', String(next)); };
  if (!questions) return <>{children}</>;
  return <div className="question-split" ref={root} style={{ gridTemplateRows: `minmax(0,${ratio}fr) 8px minmax(0,${100 - ratio}fr)` }}>
    <div className="question-top">{children}</div>
    <div className="question-resizer" role="separator" aria-orientation="horizontal" aria-label={t('Resize question panel')} aria-valuenow={Math.round(ratio)} aria-valuemin={35} aria-valuemax={65} tabIndex={0}
      onPointerDown={event => { if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); } }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && root.current) { const box = root.current.getBoundingClientRect(); resize((event.clientY - box.top) / box.height * 100); } }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onDoubleClick={() => resize(50)} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) { event.preventDefault(); resize(event.key === 'Home' ? 50 : ratio + (event.key === 'ArrowUp' ? -5 : 5)); } }}/>
    {questions}
  </div>;
}

type Api = <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
function saved<T>(key: string, fallback: T): T { try { return JSON.parse(browserStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
type QuestionProps = {
  projectId: string; userId: string; initialAgent: AgentId; agents: { value: AgentId; runtime?: RuntimeStatus }[]; api: Api; onReconnect: () => void;
};
const questionId = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => byte.toString(16).padStart(2, '0')).join('');

export function PaperQuestions(props: QuestionProps) {
  const { projectId, userId, api } = props;
  const key = `papilot:questions:${userId}:${projectId}`, route = `/projects/${encodeURIComponent(projectId)}/question-sessions`;
  const [removing, setRemoving] = useState<PaperQuestionSession | null>(null);
  const [sessions, setSessions] = useState<PaperQuestionSession[]>([]);
  const [selected, setSelected] = useState(() => browserStorage.getItem(key + ':session') || '');
  const [error, setError] = useState(''), [creating, setCreating] = useState(false), [reload, setReload] = useState(0);
  const revision = useRef(0), pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choose = (id: string) => { browserStorage.setItem(key + ':session', id); setSelected(id); };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const version = revision.current;
      try {
        const result = await api<{ sessions: PaperQuestionSession[] }>(route, undefined, controller.signal);
        if (!controller.signal.aborted && version === revision.current) {
          setSessions(result.sessions); setError('');
          setSelected(current => {
            const id = result.sessions.some(item => item.id === current) ? current : result.sessions[0]?.id || '';
            if (id) browserStorage.setItem(key + ':session', id);
            return id;
          });
        }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 2000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, route, reload, key]);
  async function create() {
    if (pending.current) return;
    const id = browserStorage.getItem(key + ':new-session') || questionId();
    browserStorage.setItem(key + ':new-session', id);
    pending.current = true; setCreating(true); setError(''); revision.current++;
    try {
      const session = await api<PaperQuestionSession>(route, { id });
      if (browserStorage.getItem(key + ':new-session') === id) browserStorage.removeItem(key + ':new-session');
      browserStorage.setItem(key + ':session', session.id);
      if (mounted.current) {
        revision.current++;
        setSessions(current => [session, ...current.filter(item => item.id !== session.id)]);
        setSelected(session.id);
      }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; if (mounted.current) setCreating(false); }
  }
  async function remove(id: string) {
    if (pending.current) throw new Error('Wait for the current operation to finish.');
    pending.current = true; setCreating(true); revision.current++;
    try {
      const result = await api<{ sessions: PaperQuestionSession[] }>(`${route}/${encodeURIComponent(id)}/delete`, {});
      const storage = id === DEFAULT_QUESTION_SESSION ? key : `${key}:thread:${id}`;
      for (const suffix of [':draft', ':agent', ':request']) browserStorage.removeItem(storage + suffix);
      if (mounted.current) {
        revision.current++; setSessions(result.sessions);
        if (selected === id) choose(result.sessions[0]?.id || '');
        setRemoving(null); setError('');
      }
    } finally { pending.current = false; if (mounted.current) setCreating(false); }
  }
  const session = sessions.find(item => item.id === selected);
  return <section className="paper-questions" aria-label={t('Paper Q&A')}>
    <header className="paper-questions-heading"><Icon name="chat" size={15}/><strong>{t('Paper Q&A')}</strong><small className="question-access" title={t('Can run commands and modify files')}>{t('Full access')}</small>
      <span className="question-session-tools">
        <ActionMenu label={t('Q&A sessions')} className="icon-button" menuClassName="question-session-menu" disabled={!sessions.length || creating} actions={sessions.map(item => ({
          id: item.id, label: item.title || t('New conversation'), checked: item.id === selected,
          detail: new Date(item.createdAt).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + (item.running ? ' · ' + t('Thinking…') : ''),
          select: () => choose(item.id),
          auxiliary: { label: t('Delete conversation: {title}', { title: item.title || t('New conversation') }), icon: 'trash', disabled: item.running, select: () => setRemoving(item) },
        }))}><Icon name="restore" size={17}/></ActionMenu>
        <button type="button" className="icon-button" aria-label={t('New conversation')} title={t('New conversation')} disabled={creating || !sessions.length} onClick={() => void create()}>{creating ? <span className="spinner"/> : <Icon name="plus" size={17}/>}</button>
      </span>
    </header>
    {error && <div className="question-session-error inline-error" role="alert">{errorText(error)} <button type="button" onClick={() => setReload(value => value + 1)}>{t('Retry')}</button></div>}
    {removing && <DeleteQuestionSessionDialog title={removing.title || t('New conversation')} submit={() => remove(removing.id)} onClose={() => setRemoving(null)}/>}
    {session ? <QuestionConversation key={session.id} {...props} sessionId={session.id}/> : <p className="question-empty">{t('Loading conversation…')}</p>}
  </section>;
}

function QuestionConversation({ projectId, userId, initialAgent, agents, api, onReconnect, sessionId }: QuestionProps & { sessionId: string }) {
  const base = `papilot:questions:${userId}:${projectId}`, key = sessionId === DEFAULT_QUESTION_SESSION ? base : `${base}:thread:${sessionId}`;
  const route = `/projects/${encodeURIComponent(projectId)}/questions`;
  const available = agents.filter(item => QUESTION_AGENTS.includes(item.value));
  const [draft, setDraft] = useState(() => browserStorage.getItem(key + ':draft') || '');
  const [choice, setChoice] = useState(() => {
    const agent = QUESTION_AGENTS.includes(initialAgent) ? initialAgent : available.find(item => item.runtime?.connected && item.runtime.authenticated)?.value || 'codex';
    const value = saved<{ agent: AgentId; model: string; effort?: string }>(key + ':agent', { agent, model: '' });
    return QUESTION_AGENTS.includes(value.agent) && typeof value.model === 'string' ? { ...value, effort: typeof value.effort === 'string' ? value.effort : '' } : { agent, model: '', effort: '' };
  });
  const [questions, setQuestions] = useState<PaperQuestion[]>([]), [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(''), [sendError, setSendError] = useState(''), [sending, setSending] = useState(false), [reload, setReload] = useState(0);
  const revision = useRef(0), submitting = useRef(false), mounted = useRef(true), history = useRef<HTMLDivElement>(null), follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${input.current.scrollHeight}px`; } }, [draft]);
  const runtime = agents.find(item => item.value === choice.agent)?.runtime;
  const selectedModel = runtime?.models.find(model => choice.model ? model.id === choice.model : model.isDefault);
  const effort = selectedModel?.efforts.includes(choice.effort) ? choice.effort : '';
  const busy = sending || questions.some(item => item.status === 'running');
  const ready = Boolean(runtime?.connected && runtime.authenticated);
  const edit = (text: string) => { setDraft(text); browserStorage.setItem(key + ':draft', text); };
  const setEffort = (effort: string) => { const value = { ...choice, effort }; setChoice(value); browserStorage.setItem(key + ':agent', JSON.stringify(value)); };
  const choose = (agent: AgentId, model: string) => { const value = { agent, model, effort: agent === choice.agent && model === choice.model ? effort : '' }; setChoice(value); browserStorage.setItem(key + ':agent', JSON.stringify(value)); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const version = revision.current;
      try {
        const result = await api<{ questions: PaperQuestion[] }>(`${route}?sessionId=${encodeURIComponent(sessionId)}`, undefined, controller.signal);
        if (!controller.signal.aborted && version === revision.current) {
          setQuestions(result.questions); setLoaded(true); setLoadError('');
          // A request can be accepted while this session is off-screen.
          const request = saved<{ id: string; question: string } | null>(key + ':request', null);
          if (request && result.questions.some(item => item.id === request.id && item.question === request.question)) {
            browserStorage.removeItem(key + ':request');
            if (browserStorage.getItem(key + ':draft')?.trim() === request.question) browserStorage.removeItem(key + ':draft');
            setDraft(current => current.trim() === request.question ? '' : current);
          }
        }
      } catch (error) { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 2000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, route, sessionId, key, reload]);
  useEffect(() => { if (follow.current && history.current) history.current.scrollTop = history.current.scrollHeight; }, [questions]);
  async function submit(retry?: PaperQuestion) {
    if (submitting.current || busy || !loaded || (!retry && (!draft.trim() || !ready))) return;
    const text = retry?.question || draft.trim(), selected = retry ? { agent: retry.agent, model: retry.model, effort: retry.effort || '' } : { ...choice, effort };
    const previous = saved<{ id: string; question: string; agent: AgentId; model: string; effort?: string } | null>(key + ':request', null);
    const id = retry?.id || (previous?.question === text && previous.agent === selected.agent && previous.model === selected.model && (previous.effort || '') === selected.effort ? previous.id : questionId());
    const body = { id, sessionId, question: text, ...selected, ...(retry ? { retry: true } : {}) };
    if (!retry) browserStorage.setItem(key + ':request', JSON.stringify(body));
    submitting.current = true; setSending(true); setSendError(''); revision.current++;
    try {
      const result = await api<PaperQuestion>(route, body);
      if (!retry) {
        if (saved<{ id: string } | null>(key + ':request', null)?.id === id) browserStorage.removeItem(key + ':request');
        if (browserStorage.getItem(key + ':draft') === draft) browserStorage.removeItem(key + ':draft');
      }
      if (mounted.current) {
        revision.current++; follow.current = true;
        setQuestions(current => current.some(item => item.id === id) ? current.map(item => item.id === id ? result : item) : [...current, result]);
        if (!retry) setDraft('');
      }
    } catch (error) { if (mounted.current) setSendError(error instanceof Error ? error.message : String(error)); }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  }
  return <div className={'paper-question-conversation' + (loaded && !questions.length && !loadError ? ' is-empty' : '')}>
    <div ref={history} className="paper-question-history" role="log" aria-label={t('Question history')} aria-live="polite" onScroll={() => { const el = history.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
      {!loaded && !loadError && <p className="muted">{t('Loading conversation…')}</p>}
      {questions.map(item => <div className="paper-question-turn" key={item.id}>
        <p className="paper-question-prompt">{item.question}</p>
        <div className="paper-question-answer"><small>{AGENT_NAMES[item.agent]}</small>
          {item.answer && <div className="markdown"><Markdown text={item.answer}/></div>}
          {item.status === 'running' && <p role="status"><span className="spinner"/> {t('Thinking…')}</p>}
          {item.status === 'failed' && <div role="alert"><p>{errorText(item.error || t('Could not answer the question.'))}</p><button type="button" className="button ghost compact" disabled={busy} onClick={() => void submit(item)}>{t('Retry question')}</button></div>}
          {item.contextTruncated && <small>{t('A portion of the manuscript was used because the paper is large.')}</small>}
        </div>
      </div>)}
      {loadError && <div className="inline-error" role="alert">{errorText(loadError)} <button type="button" onClick={() => setReload(value => value + 1)}>{t('Retry')}</button></div>}
    </div>
    <div className="paper-question-compose-wrap">
      {loaded && !questions.length && !loadError && <div className="new-task-welcome question-welcome"><img src={logo} alt=""/><h2>{t('What would you like to discuss?')}</h2></div>}
      <form className="composer paper-question-form" onSubmit={event => { event.preventDefault(); void submit(); }} onPointerDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } }}>
        <textarea ref={input} aria-label={t('Ask a question')} placeholder={t('Ask a question about this paper…')} value={draft} rows={1} maxLength={20000} readOnly={busy} onChange={event => edit(event.target.value)} onKeyDown={event => { if (sendsMessage(event.nativeEvent, window.matchMedia('(pointer: coarse)').matches)) { event.preventDefault(); void submit(); } }}/>
        <div className="composer-footer">
          <div className="composer-options"><AgentPicker agents={available.map(item => ({ ...item, label: AGENT_NAMES[item.value] }))} agent={choice.agent} model={choice.model} effort={effort} fast={false} allowFast={false} reconnecting={false} onReconnect={onReconnect} onSelect={choose} onChange={change => { if (change.effort !== undefined) setEffort(change.effort); }} disabled={busy}/></div>
          <button className="send-button" type="submit" aria-label={t('Send question')} disabled={busy || !loaded || !ready || !draft.trim()}><Icon name="arrowUp" size={18}/></button>
        </div>
      </form>
      {sendError && <p className="inline-error" role="alert">{errorText(sendError)}</p>}
      {!ready && <p className="question-connection">{t('Connect an agent to ask questions.')} <button type="button" onClick={onReconnect}>{t('Reconnect')}</button></p>}
    </div>
  </div>;
}
