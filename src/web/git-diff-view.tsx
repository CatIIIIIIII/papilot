import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GitDiff } from '../shared.ts';
import { parseGitDiff } from './git-diff.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './git-diff.css';

const ROW_HEIGHT = 24;
// Tab stops and wide characters need room even when their row is off screen.
const columns = (text: string) => Array.from(text).reduce((n, char) => n + (char === '\t' ? 4 - n % 4 : char.codePointAt(0)! > 255 ? 2 : 1), 0);

export function GitDiffView({ path, scopeLabel, revision, load, onClose, closeLabel, lead, tools }: {
  path: string; scopeLabel: string; revision: string; load: (path: string, signal: AbortSignal) => Promise<GitDiff>;
  onClose: () => void; closeLabel: string; lead?: ReactNode; tools?: ReactNode;
}) {
  const [diff, setDiff] = useState<GitDiff | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [activeChange, setActiveChange] = useState(0);
  const jumpTarget = useRef<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    load(path, controller.signal).then(result => { if (!controller.signal.aborted) setDiff(result); }, error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, load, retry]);
  useEffect(() => {
    const box = scroll.current!;
    box.focus({ preventScroll: true });
    const resize = new ResizeObserver(() => setViewport({ top: box.scrollTop, height: box.clientHeight }));
    resize.observe(box);
    return () => resize.disconnect();
  }, []);
  const parsed = useMemo(() => parseGitDiff(diff?.diff || ''), [diff]);
  const width = useMemo(() => parsed.lines.reduce((max, line) => Math.max(max, columns(line.text)), 0), [parsed]);
  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 20), end = Math.min(parsed.lines.length, start + Math.ceil(viewport.height / ROW_HEIGHT) + 40);
  const current = Math.min(activeChange, Math.max(0, parsed.changes.length - 1));
  const jump = (index: number) => {
    const box = scroll.current;
    if (!box || index < 0 || index >= parsed.changes.length) return;
    const top = Math.min(parsed.changes[index] * ROW_HEIGHT, Math.max(0, box.scrollHeight - box.clientHeight));
    jumpTarget.current = top === box.scrollTop ? null : top;
    setActiveChange(index);
    box.scrollTo({ top, behavior: 'instant' });
    box.focus({ preventScroll: true });
  };
  const slash = path.lastIndexOf('/');
  return <section className="manuscript-pages git-diff-view" aria-label={t('Changes in {path}', { path })} aria-busy={loading} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="git-diff-toolbar">
      {lead}
      <button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><Icon name="chevronLeft" size={18}/></button>
      <div className="git-diff-title" title={path}><Icon name="diff" size={16}/><strong>{path.slice(slash + 1)}</strong>{slash > 0 && <span>{path.slice(0, slash)}</span>}</div>
      <span className="git-diff-scope" title={scopeLabel}>{scopeLabel}</span>
      {diff && <span className="git-diff-totals" aria-label={t('{added} lines added, {deleted} lines removed', { added: parsed.added, deleted: parsed.deleted })}><span className="add">+{parsed.added}</span><span className="del">−{parsed.deleted}</span></span>}
      <div className="git-diff-navigation">
        <span className="git-diff-position">{parsed.changes.length ? `${current + 1} / ${parsed.changes.length}` : ''}</span>
        <button type="button" className="icon-button" aria-label={t('Previous change')} title={t('Previous change')} disabled={!parsed.changes.length || current === 0} onClick={() => jump(current - 1)}><Icon name="arrowUp" size={16}/></button>
        <button type="button" className="icon-button" aria-label={t('Next change')} title={t('Next change')} disabled={!parsed.changes.length || current === parsed.changes.length - 1} onClick={() => jump(current + 1)}><Icon name="arrowDown" size={16}/></button>
      </div>
      {tools}
    </div>
    <div className="git-diff-columns" aria-hidden="true"><span>{t('Before')}</span><span>{t('After')}</span></div>
    <div ref={scroll} className="git-source-scroll" tabIndex={0} onScroll={event => {
      const box = event.currentTarget;
      if (box.scrollTop !== viewport.top) {
        if (jumpTarget.current === null || Math.abs(box.scrollTop - jumpTarget.current) > 1) setActiveChange(Math.max(0, parsed.changes.findLastIndex(row => row * ROW_HEIGHT <= box.scrollTop + ROW_HEIGHT)));
        jumpTarget.current = null;
      }
      setViewport({ top: box.scrollTop, height: box.clientHeight });
    }}>
      {error ? <div className="git-diff-error"><p className="inline-error" role="alert">{error}</p><button type="button" className="button secondary compact" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></div>
        : !diff ? <p className="git-diff-note" role="status">{t('Loading the diff…')}</p>
        : !parsed.lines.length ? <p className="git-diff-note">{t('No textual changes.')}</p>
        : <div className="git-source-lines" style={{ height: parsed.lines.length * ROW_HEIGHT, width: `calc(${width + 2}ch + 128px)` }}>
          {parsed.lines.slice(start, end).map((line, index) => <div key={start + index} className={'git-source-line ' + line.kind + (start + index === parsed.changes[current] ? ' current-change' : '')} style={{ top: (start + index) * ROW_HEIGHT }} data-diff-row={start + index}>
            <span className="git-source-number" aria-hidden="true">{line.before}</span><span className="git-source-number" aria-hidden="true">{line.after}</span>
            <span className="git-source-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'hunk' ? '⋯' : ''}</span>
            <code title={line.kind === 'hunk' ? t('Unchanged lines omitted') : undefined}>{line.text || ' '}</code>
          </div>)}
        </div>}
    </div>
    {diff?.truncated && <p className="git-diff-note git-diff-truncated">{t('The diff is too long to show in full.')}</p>}
  </section>;
}
