import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { NoteGroup } from '../note-groups.ts';
import { GroupPicker } from './note-groups.tsx';
import { StampMenu } from './stamp-menu.tsx';
import { loadStamps, slotKey, type Stamp } from './stamps.ts';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { browserStorage } from './storage.ts';
import './pdf-tools.css';

// The tool rail, after an image editor's: each tool stays chosen until another
// is picked or Escape returns to Select.
export type PdfTool = 'select' | 'note' | 'magic' | 'region' | 'point' | 'delete' | 'source' | 'hand';
export const TOOL_KEYS: Record<string, PdfTool> = { v: 'select', t: 'note', q: 'magic', m: 'region', p: 'point', d: 'delete', e: 'source', h: 'hand' };

// Tooltips use the top layer so scrolling a short rail cannot clip them.
function hideRailTips(rail: HTMLElement | null, except?: HTMLElement) {
  rail?.querySelectorAll<HTMLElement>('.rail-tip:popover-open').forEach(tip => { if (tip !== except) tip.hidePopover(); });
}
function showRailTip(button: Element | null) {
  if (!button?.isConnected) return;
  const rail = button.closest<HTMLElement>('.pdf-rail');
  const menu = button.getAttribute('popovertarget');
  if (menu && document.getElementById(menu)?.matches(':popover-open')) { hideRailTips(rail); return; }
  const tip = button.querySelector<HTMLElement>('.rail-tip');
  if (!tip) { hideRailTips(rail); return; }
  const rect = button.getBoundingClientRect(), viewport = button.closest('.rail-tools')?.getBoundingClientRect();
  if (viewport && (rect.bottom <= viewport.top || rect.top >= viewport.bottom)) { hideRailTips(rail); return; }
  hideRailTips(rail, tip);
  if (!tip.matches(':popover-open')) tip.showPopover();
  tip.style.left = `${Math.max(8, Math.min(rect.right + 12, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${Math.max(8, Math.min(rect.top + (rect.height - tip.offsetHeight) / 2, window.innerHeight - tip.offsetHeight - 8))}px`;
}

// Shared by the manuscript and the embedded review; gestures stay with each viewer.
export function PdfToolRail({ tool, onTool, group, onGroup, disabled, suspended, editing, stamps, locked, onLock, history, sourceTool }: {
  tool: PdfTool; onTool: (tool: PdfTool) => void;
  /** Offer the tool that opens a passage's LaTeX for editing by hand. */
  sourceTool?: boolean;
  group: NoteGroup | null; onGroup?: (group: NoteGroup | null) => void;
  disabled?: boolean; suspended?: boolean; editing?: boolean;
  stamps: Stamp[]; locked: number | null; onLock: (slot: number | null) => void;
  history?: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
}) {
  const suspendedRef = useRef(suspended); suspendedRef.current = suspended;
  const railId = useId(), [collapsed, setCollapsed] = useState(() => browserStorage.getItem('papilot:pdf-tools-collapsed') === 'true');
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 680px)').matches);
  const mobileRef = useRef(mobile); mobileRef.current = mobile;
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const railTipFrame = useRef<number | null>(null);
  const railTipTarget = useRef<Element | null>(null);
  function toggleCollapse(next = !collapsed) {
    setCollapsed(next);
    browserStorage.setItem('papilot:pdf-tools-collapsed', String(next));
    if (mobile && next && tool !== 'select') onTool('select');
  }
  // Menu dismissal restores focus synchronously. Defer all tooltip operations
  // until that native popover operation has finished, and coalesce focus/scroll.
  function queueRailTip(button: Element | null = railTipTarget.current) {
    // Preserve the last deliberate hover/focus through scrolling, which can
    // move unrelated buttons under a stationary pointer.
    railTipTarget.current = button;
    if (railTipFrame.current !== null) return;
    railTipFrame.current = requestAnimationFrame(() => {
      railTipFrame.current = null;
      const owner = rail.current, target = railTipTarget.current;
      if (mobileRef.current || !target || !owner?.contains(target) || !target.matches(':hover, :focus-visible') || suspendedRef.current) hideRailTips(owner);
      else showRailTip(target);
    });
  }
  useEffect(() => {
    const media = window.matchMedia('(max-width: 680px)');
    const sync = () => { setMobile(media.matches); if (media.matches) queueRailTip(null); };
    const hide = () => queueRailTip(null);
    sync();
    media.addEventListener('change', sync);
    window.addEventListener('resize', hide);
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener('resize', hide);
      if (railTipFrame.current !== null) cancelAnimationFrame(railTipFrame.current);
      railTipFrame.current = null;
      railTipTarget.current = null;
      hideRailTips(rail.current);
    };
  }, []);
  const railTools: { id: PdfTool; icon: string; label: string; key: string; hint: string }[] = [
    { id: 'magic', icon: 'toolMagic', label: t('Magic pen'), key: 'Q', hint: t('Drag over text or click a spot, then pick a quick note. Click again, or press a number key, to keep one on the pen.') },
    { id: 'note', icon: 'toolNote', label: t('Note'), key: 'T', hint: t('Drag over text and write a note straight away. Click again to pick a color, and marks join that color group.') },
    { id: 'region', icon: 'toolRegion', label: t('Region'), key: 'M', hint: t('Draw a box around a figure, table or equation.') },
    { id: 'point', icon: 'toolSticky', label: t('Sticky note'), key: 'P', hint: t('Click anywhere on the page to leave a note there.') },
    { id: 'delete', icon: 'toolStrike', label: t('Delete'), key: 'D', hint: t('Strike out text to ask for it to be removed. Open the mark to give a replacement.') },
    ...(sourceTool ? [{ id: 'source' as const, icon: 'toolSource', label: t('Edit source'), key: 'E', hint: t('Click a passage or drag over text to edit its LaTeX directly. Saving updates the PDF without an agent.') }] : []),
    { id: 'select', icon: 'toolSelect', label: t('Select'), key: 'V', hint: t('Select text to copy it or add a note from the button beside it.') },
    { id: 'hand', icon: 'toolHand', label: t('Hand'), key: 'H', hint: t('Drag to move around the page. Hold Space to use it with any tool.') },
  ];
  const visibleTools = mobile ? railTools.filter(item => item.id !== 'hand') : railTools;
  return <div ref={rail} className="pdf-rail" data-collapsed={collapsed} data-suspended={suspended || editing || undefined} role="toolbar" aria-orientation={mobile ? 'horizontal' : 'vertical'} aria-label={t('Marking tools')}
      onTouchStart={event => {
        if (!mobile || event.touches.length !== 1) { swipeStart.current = null; return; }
        swipeStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }} onTouchEnd={event => {
        const start = swipeStart.current; swipeStart.current = null;
        if (!mobile || !start || !event.changedTouches.length) return;
        const dx = event.changedTouches[0].clientX - start.x, dy = event.changedTouches[0].clientY - start.y;
        if (Math.abs(dy) <= Math.abs(dx) * 1.5) return;
        if (!collapsed && dy > 28) toggleCollapse(true);
        else if (collapsed && dy < -20) toggleCollapse(false);
      }} onTouchCancel={() => { swipeStart.current = null; }}
      onPointerMove={event => {
        if (mobile || event.pointerType === 'touch') return;
        const button = (event.target as Element).closest('.rail-tool');
        if (button !== railTipTarget.current) queueRailTip(button);
      }} onPointerOut={event => {
        const button = (event.target as Element).closest('.rail-tool');
        if (button === railTipTarget.current && !button?.contains(event.relatedTarget as Node | null) && !button?.matches(':focus-visible')) queueRailTip(null);
      }} onFocus={event => { if (!mobile && event.target.matches(':focus-visible')) queueRailTip(event.target.closest('.rail-tool')); }}
      onBlur={() => queueRailTip(null)} onPointerDownCapture={() => queueRailTip(null)}
      onKeyDownCapture={() => queueRailTip(null)} onScrollCapture={() => queueRailTip()}>
      <button type="button" className="rail-tool rail-toggle" aria-expanded={!collapsed} aria-controls={railId}
        aria-label={collapsed ? t('Expand marking tools') : t('Collapse marking tools')} title={collapsed ? t('Expand marking tools') : t('Collapse marking tools')}
        onClick={() => toggleCollapse()}>
        {mobile
          ? collapsed ? <><Icon name="toolNote" size={14}/><Icon name="chevronUp" size={14}/></> : <Icon name="chevronDown" size={16}/>
          : <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16}/>}
      </button>
      {mobile && !collapsed && <span className="rail-separator rail-collapse-separator" aria-hidden="true"/>}
      <div id={railId} className="rail-items" hidden={collapsed}>
      <div className="rail-tools">
      {!collapsed && visibleTools.map(item => {
        const content = <><Icon name={item.icon} size={item.id === 'magic' ? 22 : 18}/>
          {item.id === 'magic' && locked !== null && <span className="rail-badge" aria-hidden="true">{slotKey(locked)}</span>}
          <span className="rail-tip" popover="manual" aria-hidden="true"><span className="rail-tip-title">{item.label}<kbd>{item.key}</kbd></span><span>{item.hint}</span></span></>;
        return <Fragment key={item.id}>
          {(item.id === 'note' || item.id === 'select') && <span className="rail-separator" aria-hidden="true"/>}
          {/* The note tool doubles as its color picker: its underline shows the color. */}
          {item.id === 'note' && onGroup ? <GroupPicker value={group || null} disabled={disabled} onChange={group => onGroup!(group)}
            tool={{ label: item.label, pressed: tool === 'note', keys: item.key, content, onPress: () => { if (tool !== 'note') { onTool('note'); return false; } return !editing; } }}/>
            : item.id === 'magic' ? <StampMenu label={item.label} keys={item.key} pressed={tool === 'magic'} disabled={disabled} content={content} stamps={stamps} locked={locked}
              onPress={() => { if (tool !== 'magic') { onTool('magic'); return false; } loadStamps(); return !editing; }} onLock={onLock}/>
            : <button type="button" className="rail-tool" aria-label={item.label} aria-pressed={tool === item.id} aria-keyshortcuts={item.key} disabled={item.id !== 'select' && item.id !== 'hand' && item.id !== 'source' && disabled} onClick={() => onTool(item.id)}>{content}</button>}
        </Fragment>;
      })}
      </div>
      {!collapsed && history && <div className="rail-history">
        <span className="rail-separator" aria-hidden="true"/>
        {(['undo', 'redo'] as const).map(action => {
          const label = action === 'undo' ? t('Undo') : t('Redo');
          const mac = /Mac|iPhone|iPad/.test(navigator.platform);
          const keys = (mac ? '⌘' : 'Ctrl+') + (action === 'redo' ? mac ? '⇧Z' : 'Shift+Z' : 'Z');
          return <button key={action} type="button" className="rail-tool" aria-label={label}
            aria-keyshortcuts={`${mac ? 'Meta' : 'Control'}+${action === 'redo' ? 'Shift+' : ''}Z`}
            disabled={!(action === 'undo' ? history!.canUndo : history!.canRedo)} onClick={history![action]}>
            <Icon name={action} size={18}/>
            <span className="rail-tip" popover="manual" aria-hidden="true"><span className="rail-tip-title">{label}<kbd>{keys}</kbd></span></span>
          </button>;
        })}
      </div>}
      </div>
    </div>;
}
