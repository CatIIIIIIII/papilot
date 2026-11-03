import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { Project, Skill } from '../shared.ts';
import type { LibrarySkill, SkillCatalog, SkillDocument } from '../skill-library.ts';
import { Icon } from './icons.tsx';
import { ChipSelect } from './chip-select.tsx';
import { Markdown } from './markdown.tsx';
import { skillDescription, skillIcon, skillName } from './skills.tsx';
import { skillMetadata, skillInstructions, setSkillMetadata, setSkillInstructions } from '../skill-metadata.ts';
import { SkillIconPicker } from './skill-icon-picker.tsx';
import { t } from './i18n.ts';
import './skill-library.css';

type API = <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface SkillLibraryOptions { project?: Project; api: API; onChanged: () => void }
export interface SkillLibraryControls { cancel: () => void; navigate: (proceed: () => void) => void }
type Editor = { id: string; source: Skill['source']; content: string; saved?: SkillDocument };
const key = (skill: Pick<Skill, 'source' | 'id'>) => `${skill.source}/${skill.id}`;
const sourceName = (source: Skill['source']) => source === 'builtin' ? t('Built-in') : source === 'user' ? t('Global') : t('This paper');
function skillError(failure: unknown) {
  const message = failure instanceof Error ? failure.message : String(failure);
  switch (message) {
    case 'This skill changed on disk. Reload it before saving.': return t('This skill changed on disk. Reload it before saving.');
    case 'This skill changed on disk. Reload it before deleting.': return t('This skill changed on disk. Reload it before deleting.');
    case 'A skill with this ID already exists in this location.': return t('A skill with this ID already exists in this location.');
    case 'This skill no longer exists. Refresh the list.': return t('This skill no longer exists. Refresh the list.');
    case 'This skill was removed on disk. Reload the list before saving.': return t('This skill was removed on disk. Reload the list before saving.');
    case 'The skill must contain instructions.': return t('The skill must contain instructions.');
    case 'Skill content must contain 1–20,000 characters.': return t('Skill content must contain 1–20,000 characters.');
    default: return message;
  }
}

export function SkillLibraryPanel({ project, api, onChanged, onClose, controls }: SkillLibraryOptions & { onClose: () => void; controls: Ref<SkillLibraryControls> }) {
  const panel = useRef<HTMLDivElement>(null), sequence = useRef(0), mounted = useRef(true), pending = useRef(false);
  const listOpener = useRef<HTMLButtonElement | null>(null);
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null), [editor, setEditor] = useState<Editor | null>(null);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<Skill['source'] | 'all'>('all');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [view, setView] = useState<'edit' | 'preview' | 'source'>('edit'), [confirmDelete, setConfirmDelete] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [leaving, setLeaving] = useState<{ proceed: () => void } | null>(null);
  const suffix = project ? `?projectId=${encodeURIComponent(project.id)}` : '';
  const dirty = Boolean(editor && (!editor.saved || editor.content !== editor.saved.content));
  const readonly = editor?.source === 'builtin';

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  useEffect(() => { if (leaving || confirmDelete) panel.current?.querySelector<HTMLButtonElement>('[data-keep-editing]')?.focus(); }, [leaving, confirmDelete]);
  useImperativeHandle(controls, () => ({ cancel, navigate }));

  function navigate(proceed: () => void) {
    if (busy) return;
    if (dirty) setLeaving({ proceed }); else { setConfirmDelete(false); proceed(); }
  }
  async function choose(skill: LibrarySkill) {
    const request = ++sequence.current;
    setDetailOpen(true); setLoading(true); setError(''); setSaved(false); setConfirmDelete(false); setEditor(null);
    try {
      const document = await api<SkillDocument>(`/skills/${key(skill)}${suffix}`);
      if (mounted.current && request === sequence.current) {
        setEditor({ ...document, saved: document }); setView(document.source === 'builtin' ? 'preview' : 'edit');
        requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('.skill-library-editor-heading h3')?.focus());
      }
    } catch (failure) { if (mounted.current && request === sequence.current) setError(skillError(failure)); }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }
  async function reload() {
    const request = ++sequence.current;
    setDetailOpen(false); setLoading(true); setError(''); setEditor(null); setSaved(false); setConfirmDelete(false);
    try {
      const next = await api<SkillCatalog>(`/skills${suffix}`);
      if (!mounted.current || request !== sequence.current) return;
      setCatalog(next); setLoading(false);
    } catch (failure) { if (mounted.current && request === sequence.current) { setError(skillError(failure)); setLoading(false); } }
  }
  function create(copy?: Editor) {
    sequence.current++; setDetailOpen(true); setLoading(false); setError(''); setSaved(false); setView('edit'); setConfirmDelete(false);
    let id = copy?.id || '';
    if (copy) {
      let number = 1;
      while (catalog?.skills.some(skill => skill.source === 'user' && skill.id === id)) id = `${copy.id.slice(0, 37)}-copy${number++ > 1 ? number - 1 : ''}`;
    }
    const content = copy ? setSkillMetadata(copy.content, 'icon', skillIcon({ id: copy.id, icon: skillMetadata(copy.content).icon })) : `---\nname: ${t('New skill')}\ndescription: \nicon: spark\n---\n\n`;
    setEditor({ id, source: 'user', content });
    requestAnimationFrame(() => panel.current?.querySelector<HTMLInputElement>('[name="skill-id"]')?.focus());
  }
  function back() {
    navigate(() => {
      sequence.current++; setDetailOpen(false); setEditor(null); setLoading(false); setError('');
      requestAnimationFrame(() => {
        const opener = listOpener.current;
        if (opener?.isConnected) opener.focus();
        else panel.current?.querySelector<HTMLButtonElement>('.skill-library-new')?.focus();
      });
    });
  }
  function change(update: Partial<Editor>) { setEditor(current => current ? { ...current, ...update } : null); setSaved(false); setConfirmDelete(false); }
  async function save(remove = false) {
    if (!editor || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const document = await api<SkillDocument>(`/skills/${key(editor)}${remove ? '/remove' : ''}`, { projectId: project?.id, content: editor.content, revision: editor.saved?.revision });
      onChanged();
      if (!mounted.current) return;
      setConfirmDelete(false);
      if (remove) { setEditor(null); await reload(); requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('.skill-library-new')?.focus()); }
      else {
        setEditor({ ...document, saved: document }); setSaved(true);
        // The write has succeeded even if refreshing the catalog now fails.
        setCatalog(await api<SkillCatalog>(`/skills${suffix}`));
      }
    } catch (failure) { if (mounted.current) setError(skillError(failure)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function cancel() {
    if (busy) return;
    if (leaving) setLeaving(null);
    else if (confirmDelete) setConfirmDelete(false);
    else navigate(onClose);
  }
  const visible = (catalog?.skills || []).filter(skill => (filter === 'all' || skill.source === filter) && `${skill.id} ${skillName(skill)} ${skillDescription(skill)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const metadata = skillMetadata(editor?.content || ''), body = skillInstructions(editor?.content || '');
  const icon = skillIcon({ id: editor?.id || '', icon: metadata.icon });
  const canSave = Boolean(editor && dirty && !readonly && body.trim() && !busy && editor.content.length <= 20000 && /^[a-z0-9][a-z0-9-]{0,47}$/.test(editor.id));
  const errorMessage = error && <p className="inline-error" role="alert">{error}<button className="button secondary compact" disabled={busy} onClick={() => navigate(() => void reload())}>{t('Refresh skills')}</button></p>;
  return <div ref={panel} className={'skill-library' + (detailOpen ? ' has-editor' : '')} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (canSave && !leaving && !confirmDelete) void save(); } }}>
      <div className="skill-library-layout" inert={Boolean(leaving || confirmDelete)}>
        <div className="skill-library-browse" hidden={detailOpen}>
          <p className="settings-intro">{t('Reusable instructions for your revisions. Choose a skill from the / menu when starting a task.')}</p>
          <div className="skill-library-tools"><div className="skill-library-search"><Icon name="search" size={16}/><input type="search" aria-label={t('Search skills')} placeholder={t('Search skills')} value={query} onChange={event => setQuery(event.target.value)}/></div><button className="icon-button" aria-label={t('Refresh skills')} title={t('Refresh skills')} disabled={busy || loading} onClick={() => navigate(() => void reload())}><Icon name="refresh" size={16}/></button><button className="button secondary compact skill-library-new" disabled={!catalog || busy} onClick={event => { listOpener.current = event.currentTarget; navigate(() => create()); }}><Icon name="plus" size={16}/>{t('New skill')}</button></div>
          <div className="skill-library-filter" role="group" aria-label={t('Skill scope')}>
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('All')}</button><button aria-pressed={filter === 'user'} onClick={() => setFilter('user')}>{t('Global')}</button>{project && <button aria-pressed={filter === 'paper'} onClick={() => setFilter('paper')}>{t('This paper')}</button>}<button aria-pressed={filter === 'builtin'} onClick={() => setFilter('builtin')}>{t('Built-in')}</button>
          </div>
          <nav className="skill-library-list settings-card" aria-label={t('Skills')}>
            {visible.map(skill => <button key={key(skill)} className="skill-library-item" disabled={busy} onClick={event => { listOpener.current = event.currentTarget; navigate(() => void choose(skill)); }}><span className="skill-library-item-icon" data-skill-icon={skillIcon(skill)}><Icon name={skillIcon(skill)} size={18}/></span><span className="skill-library-item-text"><strong>{skillName(skill)}</strong><small>{!skill.active ? <><span className="skill-library-overridden">{t('Overridden')}</span> · </> : null}{skillDescription(skill) || `/${skill.id}`}</small></span><span className="skill-library-source">{sourceName(skill.source)}</span><Icon name="chevronRight" size={15}/></button>)}
            {loading && <p className="skill-library-empty" role="status">{t('Loading skills…')}</p>}
            {catalog && !loading && !visible.length && <p className="skill-library-empty">{t('No matching skills')}</p>}
          </nav>
          {!detailOpen && errorMessage}
        </div>
        <div className={'skill-library-detail' + (readonly ? ' is-readonly' : '')} hidden={!detailOpen}>
          <button className="skill-library-back settings-back" onClick={back}><Icon name="chevronLeft" size={15}/>{t('All skills')}</button>
          {loading ? <p className="skill-library-empty" role="status">{t('Loading skills…')}</p> : editor ? <>
            <div className="skill-library-editor-body">
              <div className="skill-library-editor-heading">
                <div className="skill-library-heading-identity">
                  {readonly ? <span className="skill-library-heading-icon"><Icon name={icon} size={25}/></span> : <SkillIconPicker value={icon} disabled={busy} onChange={value => change({ content: setSkillMetadata(editor.content, 'icon', value) })}/>}
                  <div><h3 tabIndex={-1}>{readonly && editor.saved ? skillName(editor.saved) : metadata.name || editor.id || t('New skill')}</h3><div className="skill-library-heading-meta"><span className="skill-library-source">{sourceName(editor.source)}</span>{editor.id && <code>/{editor.id}</code>}{editor.source === 'paper' && project && <span>{project.name}</span>}</div></div>
                </div>
                {editor.saved && <button className="button secondary compact" disabled={busy} onClick={() => navigate(() => create(editor))}><Icon name="copy" size={14}/>{t('Copy and edit')}</button>}
              </div>
              {!readonly && view !== 'source' && <div className="skill-library-metadata settings-card">
                <label>{t('Skill name')}<input name="skill-name" value={metadata.name || ''} maxLength={60} placeholder={t('Give your skill a name')} disabled={busy} onChange={event => change({ content: setSkillMetadata(editor.content, 'name', event.target.value) })}/></label>
                <label>{t('Description')}<input value={metadata.description || ''} maxLength={300} placeholder={t('What does this skill help with?')} disabled={busy} onChange={event => change({ content: setSkillMetadata(editor.content, 'description', event.target.value) })}/></label>
              </div>}
              {!editor.saved && <div className="skill-library-new-fields"><label>{t('Skill ID')}<input name="skill-id" value={editor.id} placeholder="my-skill" pattern="[a-z0-9][a-z0-9-]{0,47}" maxLength={48} disabled={busy} onChange={event => change({ id: event.target.value })} spellCheck={false}/></label><label>{t('Save to')}<ChipSelect className="field-select" label={t('Save to')} value={editor.source} disabled={busy} onChange={source => change({ source: source as Skill['source'] })} options={[{ value: 'user', label: t('Global') }, ...project ? [{ value: 'paper', label: t('This paper') }] : []]}/></label><p>{t('Use lowercase letters, numbers and hyphens. This is also the / command name.')}</p></div>}
              {readonly ? <p className="skill-library-notice">{t('Copy this built-in skill to customize it for all papers or this paper.')}</p> : <div className="skill-library-edit-tools"><span>{t('Instructions')}</span><div className="segmented" role="group" aria-label={t('Skill content view')}><button aria-pressed={view === 'edit'} onClick={() => setView('edit')}>{t('Edit')}</button><button aria-pressed={view === 'preview'} onClick={() => setView('preview')}>{t('Preview')}</button><button aria-pressed={view === 'source'} onClick={() => setView('source')}><Icon name="code" size={13}/>{t('Source')}</button></div></div>}
              {view === 'preview' ? <div className="skill-library-preview"><Markdown text={body.trim()}/></div> : <textarea className="skill-library-content" aria-label={view === 'source' ? t('Skill content (Markdown)') : t('Instructions')} value={view === 'source' ? editor.content : body} onChange={event => change({ content: view === 'source' ? event.target.value : setSkillInstructions(editor.content, event.target.value) })} disabled={busy} maxLength={view === 'source' ? 20000 : Math.max(0, 20000 - editor.content.length + body.length)} placeholder={t('Describe what the agent should do, what to preserve, and how to present the result.')} spellCheck={false}/>}
              {editor.content.length > 20000 && <p className="inline-error" role="alert">{t('Skill content must contain 1–20,000 characters.')}</p>}
              {editor.saved && !editor.saved.active && <p className="skill-library-notice">{t('A skill with the same ID takes priority here: this paper, then global, then built-in.')}</p>}
            </div>
            {!readonly && <footer className="skill-library-editor-actions">{editor.saved && <button className="button ghost danger-text compact" disabled={busy} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={14}/>{t('Delete skill')}</button>}<span role="status">{saved ? <><Icon name="check" size={13}/>{t('Saved')}</> : dirty ? t('Unsaved changes') : ''}</span><button className="button primary compact" disabled={!canSave} onClick={() => void save()}>{busy ? t('Saving…') : t('Save')}</button></footer>}
          </> : !error && <p className="skill-library-empty">{t('Select a skill or create your own.')}</p>}
          {detailOpen && errorMessage}
        </div>
      </div>
      {(leaving || confirmDelete) && <div className="skill-library-confirm" role="alert"><p>{leaving ? t('Discard unsaved skill changes?') : t('Delete this skill? Only its Markdown file is removed; supporting files stay in place.')}</p><div><button data-keep-editing className="button secondary compact" disabled={busy} onClick={() => { setLeaving(null); setConfirmDelete(false); }}>{t('Keep editing')}</button><button className="button danger compact" disabled={busy} onClick={() => { if (leaving) { const { proceed } = leaving; setLeaving(null); setConfirmDelete(false); proceed(); } else void save(true); }}>{leaving ? t('Discard changes') : t('Delete skill')}</button></div></div>}
  </div>;
}
