import { useEffect, useRef, useState } from 'react';
import type { AgentId, PaperImport, Project } from '../shared.ts';
import { Icon } from './icons.tsx';
import { ChipSelect } from './chip-select.tsx';
import { keepDialogFocus } from './focus.ts';
import { t } from './i18n.ts';
import { browserStorage } from './storage.ts';
import { checkUpload, droppedFolder, ignoredImportPath, type ImportFile } from './import-files.ts';
import './import-dialog.css';

type Api = <T = any>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
const memoryKey = 'papilot:paper-import';
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(t('Could not read the selected file.'))); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
}
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
// What a long compilation is doing, so it never looks stuck: latexmk's step,
// the LaTeX pass with the pages typeset in it, and the time since it started.
function BuildStatus({ draft }: { draft: PaperImport }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const progress = draft.phase === 'repairing' ? undefined : draft.progress;
  const typesetting = progress?.step === 'tex' && progress.pass > 0 ? progress : undefined;
  const label = draft.phase === 'repairing' ? t('The assistant is fixing compilation…')
    : progress?.step === 'bibliography' ? t('Processing the bibliography…')
      : progress?.step === 'pdf' ? t('Writing the PDF…')
        : typesetting ? t('Typesetting with LaTeX, pass {n}…', { n: typesetting.pass })
          : t('Preparing version history and compiling the PDF…');
  const total = typesetting?.total ? Math.max(typesetting.total, typesetting.pages) : null;
  return <div className="import-status">
    <span className="spinner"/>
    <div className="import-status-body">
      <div className="import-status-line"><span role="status">{label}</span>{draft.startedAt ? <span className="import-elapsed">{clock(now - draft.startedAt)}</span> : null}</div>
      {typesetting && <div className="import-progress">
        <div className="import-progress-track" role="progressbar" aria-label={t('Pages typeset')} aria-valuemin={0} aria-valuenow={typesetting.pages} {...(total ? { 'aria-valuemax': total } : {})}>
          <span className={total ? '' : 'indeterminate'} style={total ? { width: `${(100 * typesetting.pages) / total}%` } : undefined}/>
        </div>
        <span className="import-pages">{total ? t('Page {pages} of {total}', { pages: typesetting.pages, total }) : t('Page {pages}', { pages: typesetting.pages })}</span>
      </div>}
    </div>
  </div>;
}
export function ImportDialog({ api, agent, canRepair, onDone, onClose }: { api: Api; agent: AgentId; canRepair: boolean; onDone: (project: Project) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), folder = useRef<HTMLInputElement>(null), zip = useRef<HTMLInputElement>(null), pending = useRef(false);
  const [draft, setDraft] = useState<PaperImport | null>(null), [form, setForm] = useState({ name: '', path: '', main: '', engine: 'pdflatex' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const working = draft?.phase === 'building' || draft?.phase === 'repairing', locked = busy || working;
  function receive(value: PaperImport) { setDraft(value); setForm(current => ({ ...current, name: value.name, main: value.main, engine: value.engine })); browserStorage.setItem(memoryKey, value.id); }
  useEffect(() => {
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null;
    element.showModal(); folder.current?.setAttribute('webkitdirectory', ''); element.querySelector<HTMLButtonElement>('[data-choose-folder]')?.focus();
    const saved = browserStorage.getItem(memoryKey);
    let live = true;
    if (saved) { setBusy(true); api<PaperImport>('/imports/' + saved).then(value => { if (live) receive(value); }, () => browserStorage.removeItem(memoryKey)).finally(() => { if (live) setBusy(false); }); }
    return () => { live = false; element.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (!draft || !working) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await api<PaperImport>('/imports/' + draft!.id); if (live) { receive(value); setError(''); } }
      catch (failure) { if (live) setError((failure as Error).message); }
      if (live) timer = setTimeout(poll, 1000);
    }
    timer = setTimeout(poll, 500); return () => { live = false; clearTimeout(timer); };
  }, [draft?.id, working]);
  async function run(work: () => Promise<void>) {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function start(value: PaperImport) {
    receive(value);
    if (value.copied && value.main && !value.error && value.phase === 'choose') receive(await api<PaperImport>(`/imports/${value.id}/build`, { main: value.main, engine: value.engine, name: value.name }));
  }
  async function uploadFiles(list: ImportFile[], archive: boolean) {
    const files = list.filter(item => !ignoredImportPath(item.path));
    if (!files.length) throw new Error(t('No files found in this folder.'));
    checkUpload(files.length, files.reduce((total, item) => total + item.file.size, 0));
    if (archive && (files.length !== 1 || !/\.zip$/i.test(files[0].file.name))) throw new Error(t('Drop one folder or LaTeX ZIP file.'));
    const name = archive ? files[0].file.name.replace(/\.zip$/i, '') : files[0].path.split('/')[0];
    const body = archive ? { zip: await base64(files[0].file), name: name.slice(0, 120) } : { files: await Promise.all(files.map(async item => ({ path: item.path, data: await base64(item.file) }))), name: name.slice(0, 120) };
    await start(await api<PaperImport>('/imports', body));
  }
  const upload = (list: File[], archive: boolean) => run(() => uploadFiles(list.map(file => ({ file, path: file.webkitRelativePath || file.name })), archive));
  const openFolder = async (path: string) => start(await api<PaperImport>('/imports', { path }));
  function drop(transfer: DataTransfer) {
    // Capture entries while the drop event still owns access to the data store.
    const files = Array.from(transfer.files), entries = Array.from(transfer.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
    void run(async () => {
      if (files.length !== 1 || entries.length > 1) throw new Error(t('Drop one folder or LaTeX ZIP file.'));
      const entry = entries[0];
      if (entry?.isDirectory) await uploadFiles(await droppedFolder(entry as FileSystemDirectoryEntry), false);
      else await uploadFiles(files.map(file => ({ file, path: file.name })), true);
    });
  }
  const build = (repair = false) => run(async () => receive(await api<PaperImport>(`/imports/${draft!.id}/${repair ? 'repair' : 'build'}`, { name: form.name, main: form.main, engine: form.engine, agent })));
  const finish = () => run(async () => { const project = await api<Project>(`/imports/${draft!.id}/finish`, {}); browserStorage.removeItem(memoryKey); await onDone(project); });
  const failure = draft?.error || '';
  const preparationFailure = /ENOBUFS|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|Git snapshot export/i.test(failure);
  const hint = preparationFailure ? t('Papilot could not prepare the files for compilation. This is an application error, not a LaTeX error.')
    : /not found|ENOENT|not installed/i.test(failure) && /latexmk|pdflatex|xelatex|lualatex/i.test(failure) ? t('Install TeX Live or MacTeX with latexmk on the computer running Papilot, then retry.')
    : /fontspec|Unicode character|xeCJK/i.test(failure) ? t('This paper may need XeLaTeX. Change the engine below and retry.')
    : /not found|missing|cannot find/i.test(failure) ? t('A package, font or source file may be missing. Check the details below, restore the missing file or ask for help.')
    : t('Check the main file and engine, or ask the assistant to fix compilation. You can also edit the saved files and retry.');
  const canFinish = Boolean(draft?.versioned && !working);
  const dirty = Boolean(draft && (form.main !== draft.main || form.engine !== draft.engine || form.name !== draft.name));
  const submitPrimary = !working && (!canFinish || dirty);
  const folderAt = draft ? Math.max(0, draft.path.replace(/[\\/]+$/, '').replaceAll('\\', '/').lastIndexOf('/')) : 0;
  const step2 = draft?.versioned ? 'done' : working ? 'active' : draft?.phase === 'failed' ? 'failed' : '';
  const step3 = draft?.phase === 'ready' ? 'done' : draft?.versioned && working ? 'active' : draft?.versioned && draft?.phase === 'failed' ? 'failed' : '';
  function close() { if (!busy) onClose(); }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="import-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal import-dialog">
      <button type="button" className="modal-close icon-button" aria-label={t('Close')} disabled={busy} onClick={close}><Icon name="close"/></button>
      <h2 id="import-title">{t('Add a paper')}</h2>
      {!draft ? <>
        <p className="modal-description">{t('Choose a folder or ZIP, or drag it here.')}</p>
        <div className={'import-drop' + (dragging ? ' dragging' : '')} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (!locked) drop(event.dataTransfer); }}>
          <div className="import-options">
            <div className="import-option">
              <div className="import-option-head"><Icon name="folder" size={17}/><strong>{t('Open a folder')}</strong></div>
              <p>{t('Choose a folder to upload a copy. To use original files, open it in the desktop app.')}</p>
              <button type="button" data-choose-folder className="button secondary compact" disabled={locked} onClick={() => folder.current?.click()}>{t('Choose folder')}</button>
            </div>
            <div className="import-option">
              <div className="import-option-head"><Icon name="archive" size={17}/><strong>{t('Import a ZIP')}</strong></div>
              <p>{t('Import a separate copy from Overleaf or a ZIP archive.')}</p>
              <button type="button" className="button secondary compact" disabled={locked} onClick={() => zip.current?.click()}>{t('Choose ZIP')}</button>
            </div>
          </div>
          <span className="import-drop-hint">{t('Or drop a folder or ZIP here')}</span>
        </div>
        <input hidden {...{ webkitdirectory: '' }} ref={folder} type="file" multiple aria-label={t('Choose folder')} onChange={event => { void upload(Array.from(event.target.files || []), false); event.target.value = ''; }}/>
        <input hidden ref={zip} type="file" accept=".zip,application/zip" aria-label={t('Choose ZIP')} onChange={event => { void upload(Array.from(event.target.files || []), true); event.target.value = ''; }}/>
        <form className="import-path" onSubmit={event => { event.preventDefault(); void run(() => openFolder(form.path)); }}>
          <label htmlFor="import-folder-path">{t('Folder path')}</label>
          <div className="import-path-row">
            <input id="import-folder-path" value={form.path} required disabled={locked} maxLength={4000} onChange={event => setForm({ ...form, path: event.target.value })} placeholder={t('/Users/you/papers/my-paper')} spellCheck={false}/>
            <button className={'button compact ' + (form.path.trim() ? 'primary' : 'secondary')} disabled={locked}>{t('Read folder')}</button>
          </div>
        </form>
        {busy && <p className="import-reading" role="status"><span className="spinner"/>{t('Reading paper files…')}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="button-row import-footer">
          <button type="button" className="button secondary compact" disabled={busy} onClick={close}>{t('Cancel')}</button>
        </div>
      </> : <>
        <ol className="import-steps" aria-label={t('Import progress')}>
          <li className="done"><span className="import-step-badge"><Icon name="check" size={11}/></span><span>{t('Files received')}</span></li>
          <li className={step2}><span className="import-step-badge">{step2 === 'done' ? <Icon name="check" size={11}/> : step2 === 'active' ? <span className="spinner"/> : step2 === 'failed' ? '!' : '2'}</span><span>{t('Version history')}</span></li>
          <li className={step3}><span className="import-step-badge">{step3 === 'done' ? <Icon name="check" size={11}/> : step3 === 'active' ? <span className="spinner"/> : step3 === 'failed' ? '!' : '3'}</span><span>{t('PDF compilation')}</span></li>
        </ol>
        <div className="import-location" title={draft.path}>
          <Icon name="folder" size={16}/>
          <div className="import-location-body">
            <span className="import-location-label">{t('Saved folder')}</span>
            <code className="import-location-path"><span className="paper-location-parent">{draft.path.slice(0, folderAt)}</span><span className="paper-location-name">{draft.path.slice(folderAt)}</span></code>
          </div>
          {!working && <button type="button" className="button ghost compact" disabled={busy} onClick={() => { browserStorage.removeItem(memoryKey); setDraft(null); setError(''); }}>{t('Choose different files')}</button>}
        </div>
        <form onSubmit={event => { event.preventDefault(); void build(); }}>
          <label>{t('Paper name')}<input required maxLength={120} value={form.name} disabled={locked} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
          <div className="import-settings"><label>{t('Main TeX file')}<input aria-label={t('Main TeX file')} list="import-main-files" value={form.main} disabled={locked} onChange={event => setForm({ ...form, main: event.target.value })} placeholder="main.tex" spellCheck={false}/><datalist id="import-main-files">{draft.candidates.map(file => <option key={file} value={file}/>)}</datalist></label>
          <label>{t('LaTeX engine')}<ChipSelect className="field-select" label={t('LaTeX engine')} value={form.engine} disabled={locked} onChange={engine => setForm({ ...form, engine })} options={[{ value: 'pdflatex', label: 'pdfLaTeX' }, { value: 'xelatex', label: 'XeLaTeX' }, { value: 'lualatex', label: 'LuaLaTeX' }]}/></label></div>
          {!draft.candidates.length && <p className="import-notice warn" role="alert"><Icon name="alert" size={15}/><span>{t('Could not detect a main file. Enter its path relative to the paper folder.')}</span></p>}
          {draft.candidates.length > 1 && draft.phase === 'choose' && <p className="import-notice"><Icon name="info" size={15}/><span>{t('Several TeX files were found. Check the selected main document before continuing.')}</span></p>}
          {working && <BuildStatus draft={draft}/>}
          {draft.phase === 'ready' && <p className="import-success" role="status"><Icon name="check" size={16}/><span>{t('Your paper compiled successfully. It is ready for editing.')}</span></p>}
          {(failure || draft.phase === 'failed') && <div className={'import-problem' + (preparationFailure ? ' danger-card' : '')} role="alert">
            <div className="import-problem-head"><Icon name="alert" size={16}/><strong>{preparationFailure ? t('Could not prepare the paper') : t('The paper needs a little help')}</strong></div>
            <p>{hint}</p>
            {draft.phase === 'failed' && !preparationFailure && <div className="import-problem-actions">
              <button type="button" className="button secondary compact" disabled={locked || !canRepair || !form.main} onClick={() => void build(true)}><Icon name="spark" size={14}/>{t('Help fix compilation')}</button>
              {!canRepair && <span>{t('Connect an assistant in Settings to help repair this paper.')}</span>}
            </div>}
            <details><summary><Icon name="chevronRight" size={13}/>{t('Compilation details')}</summary><pre>{failure}</pre></details>
          </div>}
          {draft.summary && <div className="import-summary"><div className="import-summary-head"><Icon name="spark" size={15}/><strong>{t('Repair summary')}</strong></div><p>{draft.summary}</p><p className="import-summary-note">{t('Repairs are saved as uncommitted changes. Review them in the paper’s file changes.')}</p></div>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="button-row import-footer">
            <button type="button" className="button ghost compact import-later" disabled={busy} onClick={close}>{t('Continue later')}</button>
            <button className={'button compact ' + (submitPrimary ? 'primary' : 'secondary')} disabled={locked || !form.main || !form.name.trim()} type="submit">{draft.phase === 'choose' ? t('Prepare and compile') : t('Retry compilation')}</button>
            {canFinish && <button type="button" className={'button compact ' + (dirty ? 'secondary' : 'primary')} disabled={busy || dirty} onClick={() => void finish()}>{draft.phase === 'ready' ? t('Open paper') : t('Add and fix later')}</button>}
          </div>
        </form>
      </>}
    </section>
  </dialog>;
}
