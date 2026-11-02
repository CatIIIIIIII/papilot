import { useEffect, useId, useRef, useState } from 'react';
import type { Project } from '../shared.ts';
import { Icon } from './icons.tsx';
import { keepDialogFocus } from './focus.ts';
import { t } from './i18n.ts';
import { chooseDirectory, nativeFolders } from './desktop-chrome.tsx';

export function PaperDialog({ paper, canManage, save, remove, onClose }: { paper: Project; canManage: boolean; save: (form: { name: string; path: string }) => Promise<unknown>; remove: () => Promise<unknown>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const [form, setForm] = useState({ name: paper.name, path: paper.path }), [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  // The folder's name stays visible, with its slash, while a long parent path is cut short.
  const locationId = useId(), folderAt = Math.max(0, form.path.replace(/\/+$/, '').lastIndexOf('/'));
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const input = element.querySelector<HTMLInputElement>('[name="name"]'); input?.focus(); input?.select();
    return () => { element.close(); document.querySelector<HTMLElement>('.project-switcher, .add-project, .sidebar-toggle')?.focus(); };
  }, []);
  useEffect(() => { if (confirming) dialog.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus(); }, [confirming]);
  function cancel() {
    if (busy) return;
    if (confirming) { setConfirming(false); setError(''); requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>('[data-remove]')?.focus()); }
    else onClose();
  }
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (confirming) await remove();
      else await save({ name: form.name.trim().replace(/\s+/g, ' '), path: form.path.trim() });
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="paper-dialog-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); cancel(); }} onClick={event => { if (event.target === event.currentTarget) cancel(); }}>
    <section className="modal paper-dialog">
      <button className="modal-close icon-button" aria-label={t('Close')} disabled={busy} onClick={onClose}><Icon name="close"/></button>
      <h2 id="paper-dialog-title">{confirming ? t('Remove paper?') : t('Edit paper')}</h2>
      {confirming ? <><p className="paper-dialog-name">{paper.name}</p><p>{t('Remove this paper and its tasks, conversations and notes from Papilot?')}</p><p>{t('Files on disk, Git history and task worktrees will stay in place.')}</p></> : !nativeFolders && <p className="modal-description">{t('LaTeX Git repository · Requires a commit and latexmk')}</p>}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        {!confirming && (nativeFolders ? <>
          <label>{t('Paper name')}<input name="name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required maxLength={120} disabled={busy} autoComplete="off"/></label>
          {/* The desktop app shows where the paper is and moves it with the
              system folder picker, the way an editor shows a project's folder. */}
          <div className="modal-field" role="group" aria-labelledby={locationId}>
            <span id={locationId}>{
              // i18n: Label for the folder on this computer that holds the paper's files.
              t('Location')
            }</span>
            <div className="paper-location" title={form.path}>
              <Icon name="folder" size={16}/>
              <span className="paper-location-path"><span className="paper-location-parent">{form.path.slice(0, folderAt)}</span><span className="paper-location-name">{form.path.slice(folderAt)}</span></span>
              <button type="button" className="button ghost compact" disabled={busy || !canManage} onClick={() => void chooseDirectory().then(path => { if (path) setForm(current => ({ ...current, path })); })}>{
                // i18n: Opens the system folder picker to point the paper at another folder.
                t('Change…')
              }</button>
            </div>
          </div>
        </> : <>
          <label>{t('Repository path')}<input name="path" value={form.path} onChange={event => setForm({ ...form, path: event.target.value })} required maxLength={4000} disabled={busy || !canManage} spellCheck={false} autoComplete="off"/></label>
          <label>{t('Paper name')}<input name="name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required maxLength={120} disabled={busy} autoComplete="off"/></label>
        </>)}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="button-row paper-dialog-actions">
          {!confirming && canManage && <button type="button" data-remove className="button ghost danger-text paper-remove" disabled={busy} onClick={() => { setError(''); setConfirming(true); }}><Icon name="trash" size={15}/>{t('Remove paper')}</button>}
          <button type="button" data-cancel className="button secondary" disabled={busy} onClick={cancel}>{t('Cancel')}</button>
          <button className={'button ' + (confirming ? 'danger' : 'primary')} type="submit" disabled={busy || (!confirming && (!form.name.trim() || !form.path.trim()))}>{busy ? confirming ? t('Removing…') : t('Saving…') : confirming ? t('Remove from Papilot') : t('Save')}</button>
        </div>
      </form>
    </section>
  </dialog>;
}
