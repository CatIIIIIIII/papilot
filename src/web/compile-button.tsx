import { useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

export function CompileButton({ status, label, disabled, className = '', onCompile }: {
  // idle: nothing compiled yet, so there is no result to report.
  status: 'idle' | 'ready' | 'building' | 'failed' | 'unknown';
  label: string;
  disabled?: boolean;
  className?: string;
  onCompile: () => Promise<unknown>;
}) {
  const request = useRef(false);
  const [starting, setStarting] = useState(false);
  const state = starting ? 'building' : status;
  const detail = state === 'building' ? t('Compiling the PDF…') : state === 'failed' ? t('Compilation failed. Click to retry.') : state === 'ready' ? t('PDF compiled successfully.') : state === 'idle' ? '' : t('Compilation status unavailable.');
  async function compile() {
    if (request.current || disabled || state === 'building') return;
    request.current = true; setStarting(true);
    try { await onCompile(); } finally { request.current = false; setStarting(false); }
  }
  return <button type="button" className={`icon-button compile-button ${className}`} data-state={state} aria-label={label} aria-description={detail || undefined} title={detail ? `${label} · ${detail}` : label} aria-busy={state === 'building'} disabled={disabled || state === 'building'} onClick={() => void compile()}>{state === 'building' ? <span className="spinner" aria-hidden="true"/> : <Icon name="compile" size={24}/>}</button>;
}
