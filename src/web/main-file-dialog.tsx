import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { ChipSelect } from './chip-select.tsx';
import { keepDialogFocus } from './focus.ts';
import { t } from './i18n.ts';

// On the desktop app a folder opens as a paper straight away. Only a folder
// with several possible main files asks once which one to compile.
export function MainFileDialog({ name, candidates, open, onClose }: { name: string; candidates: string[]; open: (main: string) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const [main, setMain] = useState(candidates[0]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null;
    element.showModal(); element.querySelector<HTMLElement>('[role="combobox"]')?.focus();
    return () => { element.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await open(main); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  function close() { if (!busy) onClose(); }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="main-file-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal">
      <button className="modal-close icon-button" aria-label={t('Close')} disabled={busy} onClick={close}><Icon name="close"/></button>
      <h2 id="main-file-title">{name}</h2>
      <p className="modal-description">{t('Several TeX files were found. Check the selected main document before continuing.')}</p>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label>{t('Main TeX file')}<ChipSelect className="field-select" label={t('Main TeX file')} value={main} disabled={busy} onChange={setMain} options={candidates.map(file => ({ value: file, label: file }))}/></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="button-row">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>{t('Cancel')}</button>
          <button className="button primary" disabled={busy}>{t('Open paper')}</button>
        </div>
      </form>
    </section>
  </dialog>;
}
