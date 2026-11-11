import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { canonicalGroup, GROUP_COLORS, GROUP_NAMES, NOTE_GROUPS, type NoteGroup } from '../note-groups.ts';
import { Icon } from './icons.tsx';
import { t, tn } from './i18n.ts';
import './note-groups.css';

export const groupName = (group: NoteGroup) => t(GROUP_NAMES[group]);
export const groupStyle = (group?: NoteGroup): CSSProperties => group ? { '--note-color': GROUP_COLORS[group], '--note-ink': canonicalGroup(group) === 'yellow' ? '#422f00' : '#fff' } as CSSProperties : {};
export function GroupAction({ group }: { group?: NoteGroup | null }) {
  return group ? <><span className="group-dot" style={groupStyle(group)} aria-hidden="true"/>{t('Add to group')}</> : t('Add note');
}
// The color of new marks. In the PDF's tool rail the note tool itself is the
// picker, like an image editor's brush: its icon shows the color, the first
// click picks the tool and a click on the chosen tool opens the colors beside it.
export interface PickerTool { label: string; pressed: boolean; keys: string; content: ReactNode; onPress: () => boolean }
export function GroupPicker({ value, onChange, disabled, tool }: { value: NoteGroup | null; onChange: (value: NoteGroup | null) => void; disabled?: boolean; tool?: PickerTool }) {
  const rail = Boolean(tool);
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) menu.current?.hidePopover(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => menu.current?.hidePopover();
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger.current)) dismiss(); };
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  function choices() { return Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')); }
  function show() {
    const panel = menu.current!, rect = trigger.current!.getBoundingClientRect();
    const horizontal = rail && Boolean(trigger.current?.closest('[aria-orientation="horizontal"]'));
    panel.showPopover();
    panel.style.left = `${Math.max(8, Math.min(horizontal ? rect.left + (rect.width - panel.offsetWidth) / 2 : rail ? rect.right + 8 : rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(horizontal ? rect.top - panel.offsetHeight - 10 : rail ? rect.top - 8 : rect.bottom + 6, window.innerHeight - panel.offsetHeight - 8))}px`;
    (choices().find(item => item.getAttribute('aria-checked') === 'true') || choices()[0])?.focus();
  }
  function choose(next: NoteGroup | null) {
    menu.current?.hidePopover(); trigger.current?.focus(); onChange(next);
  }
  return <div className={'group-picker' + (rail ? ' rail' : '')} style={groupStyle(value || undefined)}>
    <button ref={trigger} type="button" className={tool ? 'rail-tool group-select has-menu' : 'icon-button group-select'} data-group={value || undefined} aria-label={tool ? tool.label : t('Annotation group color')} title={tool ? undefined : t('Annotation groups')}
      aria-pressed={tool?.pressed} aria-keyshortcuts={tool?.keys} aria-haspopup="menu" aria-expanded={open} popoverTarget={id} disabled={disabled} onClick={event => {
      event.preventDefault();
      if (menu.current?.matches(':popover-open')) menu.current.hidePopover(); else if (!tool || tool.onPress()) show();
    }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
    }}>
      {tool ? tool.content : <span className="group-highlight" aria-hidden="true"><Icon name="pen" size={18}/></span>}
    </button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label={t('Annotation group color')} className="group-palette" onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')} onKeyDown={event => {
      if (event.key === 'Tab') { menu.current?.hidePopover(); trigger.current?.focus(); return; }
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); menu.current?.hidePopover(); trigger.current?.focus(); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const items = choices(), index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <div className="group-palette-label">{t('Color')}</div>
      <div className="group-swatches">
        {NOTE_GROUPS.map(group => <button key={group} type="button" className="group-swatch" role="menuitemradio" aria-label={groupName(group)} aria-checked={Boolean(value && canonicalGroup(value) === group)} style={groupStyle(group)} onClick={() => choose(group)}><span aria-hidden="true"/></button>)}
      </div>
      <button type="button" className="group-individual" role="menuitemradio" aria-checked={!value} onClick={() => choose(null)}><Icon name="notes" size={16}/><span>{t('Individual notes')}</span>{!value && <Icon name="check" size={14}/>}</button>
    </div>
  </div>;
}
export function GroupInstruction({ group, value, disabled, onChange }: { group: NoteGroup; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const element = input.current;
    if (!element || !element.clientWidth) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight + element.offsetHeight - element.clientHeight, 160)}px`;
  };
  useLayoutEffect(resize, [value]);
  useEffect(() => {
    const element = input.current!;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="group-instruction-input">
    <textarea ref={input} rows={1} aria-label={t('Instructions for {group} notes', { group: groupName(group) })} placeholder={t('What should change in this group?')} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}/>
    <Icon name="pencil" size={13}/>
  </div>;
}

export function GroupCard({ group, count, active, selection, children }: { group: NoteGroup; count: number; active?: boolean; selection?: { count: number; disabled: boolean; toggle: () => void }; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const selectionId = useId(), locationsId = useId();
  const pressed = selection ? selection.count === count ? true : selection.count ? 'mixed' : false : undefined;
  const label = selection ? t('{selected} / {total} locations selected', { selected: selection.count, total: count }) : tn(count, '{n} location', '{n} locations');
  useEffect(() => { if (active) setOpen(true); }, [active]);
  return <div className={'annotation-group' + (active ? ' active' : '')} role="group" aria-label={`${groupName(group)} · ${label}`} data-selected={pressed} style={groupStyle(group)}>
    <div className="group-header">
      {selection ? <button type="button" className="group-selection-toggle" aria-label={t('Select all {group} notes for this task', { group: groupName(group) })} aria-describedby={selectionId} aria-pressed={pressed} disabled={selection.disabled} onClick={selection.toggle}><span className="group-dot" aria-hidden="true"/><strong id={selectionId}>{label}</strong></button> : <div className="group-heading"><span className="group-dot" aria-hidden="true"/><strong>{label}</strong></div>}
      <button type="button" className="group-disclosure" aria-label={open ? t('Collapse {group} notes', { group: groupName(group) }) : t('Expand {group} notes', { group: groupName(group) })} aria-expanded={open} aria-controls={locationsId} onClick={() => setOpen(value => !value)}><Icon name="chevronDown" size={12}/></button>
    </div>
    <div id={locationsId} className="group-locations" hidden={!open}>{children}</div>
  </div>;
}
