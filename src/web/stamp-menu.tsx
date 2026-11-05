import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { slotKey, type Stamp } from './stamps.ts';

// The magic pen on the tool rail. Once it is the tool, clicking it again
// opens its quick notes: one can stay on the pen, as a number key keeps it,
// and the list itself is edited in settings.
export function StampMenu({ label, keys, pressed, disabled, content, stamps, locked, onPress, onLock }: {
  label: string; keys: string; pressed: boolean; disabled?: boolean; content: ReactNode; stamps: Stamp[]; locked: number | null;
  onPress: () => boolean; onLock: (slot: number | null) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) menu.current?.hidePopover(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => menu.current?.hidePopover();
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [open]);
  const items = () => Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
  function show() {
    const panel = menu.current!, rect = trigger.current!.getBoundingClientRect();
    panel.showPopover();
    panel.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.top - 8, window.innerHeight - panel.offsetHeight - 8))}px`;
    (items().find(item => item.getAttribute('aria-checked') === 'true') || items()[0])?.focus();
  }
  function pick(slot: number | null) { menu.current?.hidePopover(); trigger.current?.focus(); onLock(slot); }
  return <>
    <button ref={trigger} type="button" className="rail-tool has-menu" aria-label={label} aria-pressed={pressed} aria-keyshortcuts={keys} aria-haspopup="menu" aria-expanded={open} popoverTarget={id} disabled={disabled}
      onClick={event => { event.preventDefault(); if (menu.current?.matches(':popover-open')) menu.current.hidePopover(); else if (onPress()) show(); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>{content}</button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label={t('Quick notes')} className="stamp-menu" onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')} onKeyDown={event => {
      if (event.key === 'Tab') { menu.current?.hidePopover(); trigger.current?.focus(); return; }
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); menu.current?.hidePopover(); trigger.current?.focus(); }
      else if (/^[0-9]$/.test(event.key)) { const slot = (Number(event.key) + 9) % 10; if (event.key === '0') { event.preventDefault(); pick(null); } else if (stamps[slot]) { event.preventDefault(); pick(slot); } }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const list = items(), index = list.indexOf(document.activeElement as HTMLButtonElement);
        list[event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      }
    }}>
      <div className="stamp-menu-label">{t('Keep on the pen')}</div>
      <button type="button" role="menuitemradio" aria-checked={locked === null} onClick={() => pick(null)}><span className="stamp-menu-icon"><Icon name="toolMagic" size={16}/></span><span>{t('Choose on the wheel')}</span><kbd>0</kbd></button>
      {stamps.map((stamp, index) => <button key={stamp.id} type="button" role="menuitemradio" aria-checked={locked === index} title={stamp.instruction} onClick={() => pick(index)}>
        <span className="stamp-menu-icon"><Icon name={stamp.icon} size={16}/></span><span>{stamp.label}</span><kbd>{slotKey(index)}</kbd>
      </button>)}
      <hr/>
      <button type="button" role="menuitem" onClick={() => { menu.current?.hidePopover(); window.dispatchEvent(new Event('papilot:open-quick-notes')); }}><span className="stamp-menu-icon"><Icon name="settings" size={16}/></span><span>{t('Edit quick notes…')}</span></button>
    </div>
  </>;
}
