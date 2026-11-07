import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { WORKSPACE_KEY_EVENT, workspaceModifier, workspaceModifierLabel, workspaceOrder, workspaceShortcutLabel, workspaceSwitchKey } from './workspace-switch.ts';
import './workspace-switcher.css';

type Destination = { id: string; title: string };
type Session = { items: Destination[]; index: number };

export function WorkspaceSwitcher({ items, active, onSelect }: {
  items: Destination[]; active: string | null; onSelect: (id: string) => void;
}) {
  const recent = useRef<string[]>([]);
  const latest = useRef({ items, active, onSelect }); latest.current = { items, active, onSelect };
  const session = useRef<Session | null>(null);
  const latestActive = useRef(active);
  const [shown, setShown] = useState<Session | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), list = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    recent.current = workspaceOrder(items.map(item => item.id), recent.current, active);
  }, [items, active]);

  function show(value: Session | null) { session.current = value; setShown(value); }
  function finish(commit: boolean, id = session.current?.items[session.current.index]?.id) {
    if (!session.current) return;
    show(null); dialog.current?.close();
    // Native dialogs restore the outer iframe, but not its focused editor.
    if (document.hasFocus() && opener.current?.isConnected && opener.current.checkVisibility()) opener.current.focus({ preventScroll: true });
    if (commit && id !== undefined && latest.current.items.some(item => item.id === id)) latest.current.onSelect(id);
  }
  useLayoutEffect(() => {
    if (!shown) return;
    if (!dialog.current?.open) { dialog.current?.showModal(); list.current?.focus(); }
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [shown]);
  useEffect(() => {
    // A deleted/archived task or external navigation must not leave a stale chooser.
    if (session.current && (active !== latestActive.current || session.current.items.some(item => !items.some(next => next.id === item.id)))) finish(false);
    latestActive.current = active;
  }, [items, active]);

  useEffect(() => {
    const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const hasDialog = (doc: Document) => [...doc.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"], :popover-open')]
      .some(element => element.checkVisibility({ visibilityProperty: true }));
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.type === 'keyup') {
        if (session.current && event.key === workspaceModifier) { consume(event); finish(true); }
        return;
      }
      const cycle = workspaceSwitchKey(event);
      if (!session.current) {
        const source = (event.target as Node | null)?.ownerDocument;
        // Nonmodal PDF note editors keep their drafts in the mounted viewer.
        // Leave both host and iframe dialogs in place until saved or dismissed.
        if (!cycle || event.repeat || hasDialog(document) || source && source !== document && hasDialog(source)) return;
        const { items, active } = latest.current;
        if (items.length < 2) return;
        consume(event);
        const target = event.target as HTMLElement | null;
        opener.current = typeof target?.focus === 'function' ? target : null;
        const ids = workspaceOrder(items.map(item => item.id), recent.current, active);
        const current = active === null ? -1 : ids.indexOf(active);
        const index = current < 0 ? (event.shiftKey ? ids.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + ids.length) % ids.length;
        show({ items: ids.map(id => items.find(item => item.id === id)!), index });
        return;
      }
      if (event.key === 'Escape') { consume(event); finish(false); return; }
      if (event.key === 'Enter') { consume(event); finish(true); return; }
      const direction = cycle || event.key === 'Tab' ? (event.shiftKey ? -1 : 1)
        : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0;
      if (direction) {
        consume(event);
        const value = session.current;
        show({ ...value, index: (value.index + direction + value.items.length) % value.items.length });
      }
    };
    const forwarded = (event: Event) => key((event as CustomEvent<KeyboardEvent>).detail);
    const blur = () => { if (!document.hasFocus()) finish(false); };
    const hidden = () => { if (document.hidden) finish(false); };
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true);
    window.addEventListener(WORKSPACE_KEY_EVENT, forwarded);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true);
      window.removeEventListener(WORKSPACE_KEY_EVENT, forwarded);
      window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  if (!shown) return null;
  return <dialog ref={dialog} className="workspace-switcher" aria-labelledby="workspace-switcher-title" onCancel={event => { event.preventDefault(); finish(false); }} onClick={event => { if (event.target === event.currentTarget) finish(false); }}>
    <header><h2 id="workspace-switcher-title">{t('Switch tasks and manuscript')}</h2><kbd>{workspaceShortcutLabel}</kbd></header>
    <div ref={list} className="workspace-switcher-list" role="listbox" tabIndex={-1} aria-label={t('Switch tasks and manuscript')} aria-activedescendant={`workspace-destination-${shown.index}`}>
      {shown.items.map((item, index) => <div key={item.id} id={`workspace-destination-${index}`} role="option" aria-selected={index === shown.index} aria-current={item.id === active ? 'page' : undefined} className="workspace-destination" onClick={() => finish(true, item.id)}>
        <Icon name={item.id ? 'chat' : 'pdf'} size={20}/><span>{item.title}</span>{item.id === active && <Icon name="check" size={14}/>}
      </div>)}
    </div>
    <footer>{t('Hold {key} and press ` to cycle. Shift reverses; release {key} to switch. Esc cancels.', { key: workspaceModifierLabel })}</footer>
  </dialog>;
}
