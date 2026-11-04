import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons.tsx';

// A swatch is any CSS background: a color, or a gradient for a two-tone theme.
export interface SelectOption { value: string; label: string; detail?: string; swatch?: string; group?: string; disabled?: boolean }

// A compact chip that opens a managed list instead of the native picker, so the
// list matches the app's menus in every theme, can show swatches, details and
// groups, and becomes a sheet on a phone. It follows the select-only combobox
// pattern: focus stays on the chip while the arrow keys, Home, End, Page Up,
// Page Down and typed letters move through the options, Enter, Space or Tab
// picks one, and Escape closes the list without a change.
export function ChipSelect({ label, value, options, onChange, disabled, icon, className = '', display }: { label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; icon?: string; className?: string; display?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const typed = useRef({ text: '', at: 0 });
  const selected = options.findIndex(option => option.value === value), current = options[selected];
  const enabled = (index: number) => index >= 0 && index < options.length && !options[index].disabled;
  // A field disabled while its list is open, such as during a save, closes it.
  useEffect(() => { if (disabled && shown()) close(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => list.current?.hidePopover();
    // Close when a scrolling ancestor moves the chip, but not when the list scrolls.
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger.current) && !list.current?.contains(event.target)) dismiss(); };
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  // Only the list scrolls to the option: scrollIntoView would also scroll the
  // page under the chip, and a page that moves closes the list.
  useEffect(() => {
    const panel = list.current, item = panel?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !panel || !item) return;
    const top = item.offsetTop - 5, bottom = item.offsetTop + item.offsetHeight + 5;
    if (top < panel.scrollTop) panel.scrollTop = top;
    else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight;
  }, [open, active]);
  // Below the chip and at least as wide, above it when the space below is short.
  // A chip on the right of the window lines the list up with its right edge.
  function position() {
    const panel = list.current!, rect = trigger.current!.getBoundingClientRect();
    panel.style.minWidth = `${rect.width}px`;
    const below = window.innerHeight - rect.bottom - 14, above = rect.top - 14, up = below < Math.min(panel.scrollHeight, 240) && above > below;
    panel.style.maxHeight = `${Math.max(120, Math.min(360, up ? above : below))}px`;
    const left = rect.left + rect.width / 2 > window.innerWidth / 2 ? rect.right - panel.offsetWidth : rect.left;
    panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${up ? rect.top - panel.offsetHeight - 6 : rect.bottom + 6}px`;
  }
  function show(start = selected) {
    if (disabled || !list.current) return;
    // Safari leaves focus where it was when a button is clicked, and the list's
    // keys are handled on the chip.
    trigger.current?.focus({ preventScroll: true });
    list.current.showPopover(); position(); setOpen(true);
    setActive(enabled(start) ? start : options.findIndex((_, index) => enabled(index)));
  }
  // The list's own state, not React's: its toggle event arrives a moment later,
  // and a key pressed in between must reach the dialog around the chip.
  const shown = () => Boolean(list.current?.matches(':popover-open'));
  // Closing also ends a typed search, so the next one starts fresh.
  function close() { list.current?.hidePopover(); setOpen(false); typed.current = { text: '', at: 0 }; }
  function pick(index: number) {
    if (disabled || !enabled(index)) return;
    close(); trigger.current?.focus();
    if (options[index].value !== value) onChange(options[index].value);
  }
  // The next enabled option from index in a direction, staying in the list.
  function step(from: number, by: number) {
    let index = from;
    for (let left = options.length; left > 0; left--) {
      const next = Math.max(0, Math.min(options.length - 1, index + by));
      if (next === index) break;
      index = next;
      if (enabled(index)) return index;
      by = Math.sign(by);
    }
    return enabled(from) ? from : -1;
  }
  // Typing moves to the first option that starts with what was typed;
  // repeating one letter cycles through the options that start with it.
  function typeahead(key: string) {
    const now = Date.now(), text = (now - typed.current.at < 600 ? typed.current.text : '') + key.toLowerCase();
    typed.current = { text, at: now };
    const repeated = [...text].every(char => char === text[0]), search = repeated ? text[0] : text;
    const from = Math.max(0, shown() ? active : selected), skip = repeated ? 1 : 0;
    for (let offset = skip; offset < options.length + skip; offset++) {
      const index = (from + offset) % options.length;
      if (enabled(index) && options[index].label.toLowerCase().startsWith(search)) return index;
    }
    return -1;
  }
  function keyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const open = shown();
    if (event.altKey && event.key === 'ArrowUp' && open) { event.preventDefault(); pick(active); return; }
    // A space while typing is part of the search; otherwise it opens or picks.
    if (event.key.length === 1 && (event.key !== ' ' || Date.now() - typed.current.at < 600) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // The key is part of the search even without a match, so a space never
      // reaches the chip as a click that would close the list.
      event.preventDefault();
      const index = typeahead(event.key);
      if (index >= 0) { if (open) setActive(index); else show(index); }
      return;
    }
    if (!open) {
      const start = event.key === 'Home' ? step(-1, 1) : event.key === 'End' ? step(options.length, -1) : selected;
      if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(event.key)) { event.preventDefault(); show(start); }
      return;
    }
    const moves: Record<string, () => number> = { ArrowDown: () => step(active, 1), ArrowUp: () => step(active, -1), Home: () => step(-1, 1), End: () => step(options.length, -1), PageDown: () => step(active, 10), PageUp: () => step(active, -10) };
    if (moves[event.key]) { event.preventDefault(); setActive(moves[event.key]()); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(active); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    // Tab accepts the highlighted option and moves on; Escape is the way to cancel.
    else if (event.key === 'Tab') { close(); if (enabled(active) && options[active].value !== value) onChange(options[active].value); }
  }
  const option = (item: SelectOption, index: number) => <div key={item.value} id={`${id}-${index}`} data-index={index} data-value={item.value} role="option" aria-selected={index === selected} aria-disabled={item.disabled || undefined}
    className={'select-option' + (index === active ? ' active' : '')} onPointerMove={() => { if (enabled(index) && index !== active) setActive(index); }} onClick={() => pick(index)}>
    <span className="menu-check">{index === selected && <Icon name="check" size={16}/>}</span>
    {item.swatch && <i className="select-swatch" style={{ background: item.swatch }}/>}
    <span className="menu-label">{item.label}{item.detail && <small className="select-detail">{item.detail}</small>}</span>
  </div>;
  const groups = options.some(item => item.group) ? [...new Set(options.map(item => item.group || ''))] : null;
  // The anchor takes no box, so layouts size and place the chip itself.
  return <span className="select-anchor">
    <button ref={trigger} type="button" role="combobox" className={'chip-select ' + className} title={label} aria-label={label} disabled={disabled} data-value={value}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined} popoverTarget={id}
      onClick={event => { event.preventDefault(); if (shown()) close(); else show(); }} onKeyDown={keyDown}>
      {icon && <Icon name={icon} size={14}/>}
      {current?.swatch && <i className="select-swatch" style={{ background: current.swatch }}/>}
      <span className="chip-value">{display ?? current?.label ?? value}</span>
      <Icon name="chevronDown" size={13}/>
    </button>
    {/* Clicks pick an option without taking focus from the chip, and are
        cancelled so a label around the chip does not click it open again. */}
    <div ref={list} id={id} popover="auto" role="listbox" aria-label={label} className="action-menu select-list" onMouseDown={event => event.preventDefault()} onClick={event => event.preventDefault()}
      onToggle={event => { const shown = (event.nativeEvent as ToggleEvent).newState === 'open'; setOpen(shown); if (!shown) { setActive(-1); typed.current = { text: '', at: 0 }; } }}>
      {groups ? groups.map(group => <div key={group} role="group" aria-label={group || undefined} className="select-group">
        {group && <div className="select-group-label" aria-hidden="true">{group}</div>}
        {options.map((item, index) => (item.group || '') === group && option(item, index))}
      </div>) : options.map(option)}
    </div>
  </span>;
}
