import { useEffect, useId, useRef, useState } from 'react';
import { keepDialogFocus } from './focus.ts';
import { t, errorText } from './i18n.ts';

export function DeleteQuestionSessionDialog({ title, submit, onClose }: { title: string; submit: () => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const id = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, element = dialog.current!;
    element.showModal(); element.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  async function remove() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await submit(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby={id} onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <section className="modal delete-dialog">
      <h2 id={id}>{t('Delete conversation?')}</h2>
      <p className="delete-task-name">{title}</p>
      <p>{t('This permanently deletes this conversation and its saved questions, answers and draft. Changes already made to the manuscript stay in place.')}</p>
      {error && <p className="inline-error" role="alert">{errorText(error)}</p>}
      <div className="button-row"><button data-cancel className="button secondary" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? t('Deleting…') : t('Delete conversation')}</button></div>
    </section>
  </dialog>;
}
