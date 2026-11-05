import { useEffect, useId, useRef, useState } from 'react';
import { SKILL_ICONS, type SkillIcon } from '../skill-icons.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

export function SkillIconPicker({ value, onChange, disabled }: { value: SkillIcon; onChange: (value: SkillIcon) => void; disabled: boolean }) {
  return <IconPicker value={value} onChange={onChange} disabled={disabled} icons={SKILL_ICONS.map(icon => ({ id: icon.id, label: t(icon.label) }))} name={t('Skill icon')}/>;
}

// A grid of icons to choose from, opened from a large tile; skills and quick
// notes each offer their own set.
export function IconPicker<T extends string>({ value, onChange, disabled, icons, name }: { value: T; onChange: (value: T) => void; disabled: boolean; icons: readonly { id: T; label: string }[]; name: string }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = icons.find(icon => icon.id === value) || icons[0];
  function close(focus = false) { panel.current?.hidePopover(); if (focus) trigger.current?.focus(); }
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => close();
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger.current) && !panel.current?.contains(event.target)) close(); };
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  function show() {
    const element = panel.current!, rect = trigger.current!.getBoundingClientRect();
    element.showPopover(); setOpen(true);
    element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - element.offsetWidth - 12))}px`;
    const below = rect.bottom + 8, above = rect.top - element.offsetHeight - 8;
    element.style.top = `${Math.max(12, Math.min(below + element.offsetHeight > window.innerHeight - 12 && above >= 12 ? above : below, window.innerHeight - element.offsetHeight - 12))}px`;
    element.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }
  return <>
    <button ref={trigger} type="button" className="skill-icon-trigger" aria-label={t('Choose an icon')} title={`${t('Choose an icon')} · ${selected.label}`} aria-haspopup="dialog" aria-expanded={open} popoverTarget={id} disabled={disabled} onClick={event => { event.preventDefault(); if (panel.current?.matches(':popover-open')) close(); else show(); }}>
      <Icon name={value} size={25}/><span><Icon name="chevronDown" size={10}/></span>
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t('Choose an icon')} className="skill-icon-popover" onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') { close(true); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowDown' ? 4 : event.key === 'ArrowUp' ? -4 : event.key === 'ArrowRight' ? 1 : -1;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + step + items.length) % items.length;
        items[index]?.focus();
        if (!disabled && icons[index]) onChange(icons[index].id);
      }
    }}>
      <p>{t('Choose an icon')}</p>
      <div className="skill-icon-grid" role="radiogroup" aria-label={name}>
        {icons.map(icon => <button key={icon.id} type="button" role="radio" aria-label={icon.label} title={icon.label} aria-checked={icon.id === value} tabIndex={icon.id === value ? 0 : -1} disabled={disabled} onClick={() => { onChange(icon.id); close(true); }}><Icon name={icon.id} size={21}/></button>)}
      </div>
    </div>
  </>;
}
