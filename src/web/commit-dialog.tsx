import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { keepDialogFocus } from './focus.ts';
import { t, tn } from './i18n.ts';

// The manuscript's staged-change commit dialog. Task reviews save through
// the inline TaskApply form instead.
export function CommitDialog({ branch, files, staged, remote, agent, generate, commit, onClose }: { branch: string | null; files: string[]; staged?: boolean; remote: boolean; agent: string; generate: (fresh: boolean) => Promise<string>; commit: (message: string, push: boolean) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState<'' | 'writing' | 'commit' | 'push'>(''), [error, setError] = useState('');
  const typed = useRef(false);
  // The first message may already be written; the generate button asks for a new one.
  async function write(fresh: boolean) {
    setBusy('writing'); setError('');
    try { const text = await generate(fresh); if (!typed.current) setMessage(text); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(current => current === 'writing' ? '' : current); }
  }
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal(); element.querySelector('textarea')?.focus();
    void write(false);
    return () => { element.close(); if (opener?.isConnected && opener.getClientRects().length) opener.focus(); };
  }, []);
  async function submit(push: boolean) {
    if (busy || !message.trim()) return;
    setBusy(push ? 'push' : 'commit'); setError('');
    try { await commit(message.trim(), push); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(''); }
  }
  const close = () => { if (busy !== 'commit' && busy !== 'push') onClose(); };
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="commit-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal commit-dialog">
      <button className="modal-close icon-button" aria-label={t('Close')} onClick={close}><Icon name="close"/></button>
      <h2 id="commit-title">{branch ? t('Commit to {branch}', { branch }) : t('Commit')}</h2>
      <p className="modal-description">{staged ? tn(files.length, 'What is staged, in {n} file:', 'What is staged, in {n} files:') : tn(files.length, 'What this task accepted, in {n} file:', 'What this task accepted, in {n} files:')}</p>
      <ul className="commit-files">{files.map(file => <li key={file}><code>{file}</code></li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void submit(false); }}>
        <div className="git-message-box">
          <textarea aria-label={t('Commit message')} rows={3} value={message} readOnly={busy === 'commit' || busy === 'push'} placeholder={busy === 'writing' ? t('{agent} is writing a commit message…', { agent }) : t('Commit message')}
            onChange={event => { typed.current = true; setMessage(event.target.value); }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(false); } }}/>
          <button type="button" className="icon-button git-generate" aria-label={t('Generate commit message')} title={t('Write a commit message for the chosen files with {agent}', { agent })} disabled={Boolean(busy)} onClick={() => { typed.current = false; void write(true); }}>{busy === 'writing' ? <span className="spinner"/> : <Icon name="spark" size={15}/>}</button>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="button-row">
          <button type="button" className="button secondary" disabled={busy === 'commit' || busy === 'push'} onClick={close}>{t('Cancel')}</button>
          {remote && <button type="button" className="button secondary" disabled={Boolean(busy) || !message.trim()} onClick={() => void submit(true)}>{busy === 'push' ? t('Committing and pushing…') : t('Commit and push')}</button>}
          <button className="button primary" disabled={Boolean(busy) || !message.trim()}>{busy === 'commit' ? t('Committing…') : t('Commit')}</button>
        </div>
      </form>
    </section>
  </dialog>;
}
