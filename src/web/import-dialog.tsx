import { useEffect, useRef, useState } from 'react';
import type { AgentId, PaperImport, Project } from '../shared.ts';
import { Icon } from './icons.tsx';
import { keepDialogFocus } from './focus.ts';
import { t } from './i18n.ts';
import { browserStorage } from './storage.ts';
import { checkUpload, droppedFolder, ignoredImportPath, type ImportFile } from './import-files.ts';
import './import-dialog.css';

type Api = <T = any>(route: string, body?: unknown, signal?: AbortSignal, wait?: number) => Promise<T>;
const memoryKey = 'papilot:paper-import';
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(t('Could not read the selected file.'))); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
}
export function ImportDialog({ api, agent, canRepair, onDone, onClose }: { api: Api; agent: AgentId; canRepair: boolean; onDone: (project: Project) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), folder = useRef<HTMLInputElement>(null), zip = useRef<HTMLInputElement>(null), pending = useRef(false);
  const [draft, setDraft] = useState<PaperImport | null>(null), [form, setForm] = useState({ name: '', path: '', main: '', engine: 'pdflatex' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const desktop = window.papilotDesktop;
  const nativeFolders = Boolean(desktop?.chooseDirectory && desktop?.pathForFile);
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
    await start(await api<PaperImport>('/imports', body, undefined, 120000));
  }
  const upload = (list: File[], archive: boolean) => run(() => uploadFiles(list.map(file => ({ file, path: file.webkitRelativePath || file.name })), archive));
  const openFolder = async (path: string) => start(await api<PaperImport>('/imports', { path }, undefined, 120000));
  function chooseFolder() {
    if (!nativeFolders) { folder.current?.click(); return; }
    void run(async () => { const path = await desktop!.chooseDirectory!(); if (path) await openFolder(path); });
  }
  function drop(transfer: DataTransfer) {
    // Capture entries while the drop event still owns access to the data store.
    const files = Array.from(transfer.files), entries = Array.from(transfer.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
    void run(async () => {
      if (files.length !== 1 || entries.length > 1) throw new Error(t('Drop one folder or LaTeX ZIP file.'));
      const entry = entries[0];
      if (nativeFolders && (entry?.isDirectory || !/\.zip$/i.test(files[0].name))) {
        const path = desktop!.pathForFile!(files[0]);
        if (!path) throw new Error(t('Could not read the selected folder. Please use Choose folder.'));
        await openFolder(path);
      } else if (entry?.isDirectory) await uploadFiles(await droppedFolder(entry as FileSystemDirectoryEntry), false);
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
  function close() { if (!busy) onClose(); }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="import-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal import-dialog">
      <button className="modal-close icon-button" aria-label={t('Close')} disabled={busy} onClick={close}><Icon name="close"/></button>
      <h2 id="import-title">{t('Add a paper')}</h2>
      <p className="modal-description">{t('Choose a folder or ZIP, or drag it here.')}</p>
      {!draft ? <>
        <div className={'import-drop' + (dragging ? ' dragging' : '')} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (!locked) drop(event.dataTransfer); }}>
          <div className="import-options">
            <div className="import-option"><Icon name="folder" size={28}/><strong>{t('Open a folder')}</strong>
              <p>{nativeFolders ? t('Work with the original files. Nothing is uploaded or copied.') : t('Choose a folder to upload a copy. To use original files, open it in the desktop app.')}</p>
              <button data-choose-folder className="button secondary" disabled={locked} onClick={chooseFolder}>{t('Choose folder')}</button>
            </div>
            <div className="import-option"><Icon name="file" size={28}/><strong>{t('Import a ZIP')}</strong>
              <p>{t('Import a separate copy from Overleaf or a ZIP archive.')}</p>
              <button className="button secondary" disabled={locked} onClick={() => zip.current?.click()}>{t('Choose ZIP')}</button>
            </div>
          </div>
          <span>{t('Or drop a folder or ZIP here')}</span>
        </div>
        <input hidden {...{ webkitdirectory: '' }} ref={folder} type="file" multiple aria-label={t('Choose folder')} onChange={event => { void upload(Array.from(event.target.files || []), false); event.target.value = ''; }}/>
        <input hidden ref={zip} type="file" accept=".zip,application/zip" aria-label={t('Choose ZIP')} onChange={event => { void upload(Array.from(event.target.files || []), true); event.target.value = ''; }}/>
        <details className="import-path"><summary>{t('Enter a folder path')}</summary><form onSubmit={event => { event.preventDefault(); void run(() => openFolder(form.path)); }}>
          <label>{t('Folder path')}<input value={form.path} required disabled={locked} maxLength={4000} onChange={event => setForm({ ...form, path: event.target.value })} placeholder={t('/Users/you/papers/my-paper')} spellCheck={false}/></label>
          <button className="button secondary" disabled={locked}>{t('Read folder')}</button>
        </form></details>
        {busy && <p role="status">{t('Reading paper files…')}</p>}
      </> : <>
        <ol className="import-steps" aria-label={t('Import progress')}><li className="done">{t('Files received')}</li><li className={draft.versioned ? 'done' : ''}>{t('Version history')}</li><li className={draft.phase === 'ready' ? 'done' : ''}>{t('PDF compilation')}</li></ol>
        <p className="import-location">{t('Saved folder')}<br/><code>{draft.path}</code></p>
        <form onSubmit={event => { event.preventDefault(); void build(); }}>
          <label>{t('Paper name')}<input required maxLength={120} value={form.name} disabled={locked} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
          <div className="import-settings"><label>{t('Main TeX file')}<input aria-label={t('Main TeX file')} list="import-main-files" value={form.main} disabled={locked} onChange={event => setForm({ ...form, main: event.target.value })} placeholder="main.tex" spellCheck={false}/><datalist id="import-main-files">{draft.candidates.map(file => <option key={file} value={file}/>)}</datalist></label>
          <label>{t('LaTeX engine')}<select aria-label={t('LaTeX engine')} value={form.engine} disabled={locked} onChange={event => setForm({ ...form, engine: event.target.value })}><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></label></div>
          {!draft.candidates.length && <p role="alert">{t('Could not detect a main file. Enter its path relative to the paper folder.')}</p>}
          {draft.candidates.length > 1 && draft.phase === 'choose' && <p>{t('Several TeX files were found. Check the selected main document before continuing.')}</p>}
          {working && <p className="import-status" role="status"><span className="spinner"/>{draft.phase === 'repairing' ? t('The assistant is fixing compilation…') : t('Preparing version history and compiling the PDF…')}</p>}
          {draft.phase === 'ready' && <p className="import-success" role="status">{t('Your paper compiled successfully. It is ready for editing.')}</p>}
          {(failure || draft.phase === 'failed') && <div className="import-problem" role="alert"><strong>{preparationFailure ? t('Could not prepare the paper') : t('The paper needs a little help')}</strong><p>{hint}</p><details><summary>{t('Compilation details')}</summary><pre>{failure}</pre></details></div>}
          {draft.summary && <div className="import-summary"><strong>{t('Repair summary')}</strong><p>{draft.summary}</p><p>{t('Repairs are saved as uncommitted changes. Review them in the paper’s file changes.')}</p></div>}
          <div className="button-row import-actions">
            {draft.phase === 'failed' && !preparationFailure && <button type="button" className="button secondary" disabled={locked || !canRepair || !form.main} onClick={() => void build(true)}>{t('Help fix compilation')}</button>}
            <button className="button secondary" disabled={locked || !form.main || !form.name.trim()} type="submit">{draft.phase === 'choose' ? t('Prepare and compile') : t('Retry compilation')}</button>
            {draft.versioned && !working && <button type="button" className="button primary" disabled={busy || form.main !== draft.main || form.engine !== draft.engine || form.name !== draft.name} onClick={() => void finish()}>{draft.phase === 'ready' ? t('Open paper') : t('Add and fix later')}</button>}
          </div>
          {draft.phase === 'failed' && !preparationFailure && !canRepair && <p className="modal-description">{t('Connect an assistant in Settings to help repair this paper.')}</p>}
        </form>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="button-row import-footer">{draft && !working && <button type="button" className="button ghost" disabled={busy} onClick={() => { browserStorage.removeItem(memoryKey); setDraft(null); setError(''); }}>{t('Choose different files')}</button>}<button className="button secondary" disabled={busy} onClick={close}>{draft ? t('Continue later') : t('Cancel')}</button></div>
    </section>
  </dialog>;
}
