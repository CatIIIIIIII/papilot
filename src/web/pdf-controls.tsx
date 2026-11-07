import { useEffect, useState, type Ref } from 'react';
import { ActionMenu } from './action-menu.tsx';
import { ChipSelect } from './chip-select.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { PDF_ZOOM_STEPS, type OutlineItem } from '../../engine/src/web/pdf-reader.ts';

export function PdfContents({ outline, section, ready = true, onSelect }: { outline: OutlineItem[]; section: number; ready?: boolean; onSelect: (item: OutlineItem) => void }) {
  return <ActionMenu label={t('Contents')} className="pdf-contents-trigger" menuClassName="pdf-contents-menu" align="start" actions={outline.length ? outline.map((item, index) => ({
    id: String(index), label: item.title, hint: String(item.page), indent: Math.min(item.level, 4), checked: index === section, select: () => onSelect(item),
  })) : [{ label: ready ? t('This PDF has no bookmarks.') : t('Contents will appear when the PDF is ready.'), disabled: true }]}>
    <Icon name="list" size={16}/><span>{t('Contents')}</span><Icon name="chevronDown" size={12}/>
  </ActionMenu>;
}

export function PdfPageControls({ page, pages, zoom, onPage, onZoom, onZoomBy }: {
  page: number; pages: number; zoom: { value: string; scale: number };
  onPage: (page: number) => void; onZoom: (value: string) => void; onZoomBy: (factor: number) => void;
}) {
  const [input, setInput] = useState(String(page));
  useEffect(() => setInput(String(page)), [page]);
  const presets = [{ value: 'page-width', label: t('Fit width') }, { value: 'page-fit', label: t('Fit page') }, ...PDF_ZOOM_STEPS.map(scale => ({ value: String(scale), label: `${scale * 100}%` }))];
  const value = presets.some(option => option.value === zoom.value) ? zoom.value : String(Math.round(zoom.scale * 100) / 100);
  const options = presets.some(option => option.value === value) ? presets : [...presets, { value, label: `${Math.round(zoom.scale * 100)}%` }];
  return <>
    <div className="pdf-pager">
      <button type="button" className="icon-button" aria-label={t('Previous page')} disabled={page <= 1 || !pages} onClick={() => onPage(page - 1)}><Icon name="chevronUp" size={16}/></button>
      <input aria-label={t('Page number')} inputMode="numeric" value={input} onChange={e => setInput(e.target.value.replace(/\D/g, ''))} onFocus={e => e.currentTarget.select()} onBlur={() => setInput(String(page))} onKeyDown={e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const number = Number.parseInt(input, 10);
        if (Number.isFinite(number) && pages) onPage(Math.min(pages, Math.max(1, number)));
        e.currentTarget.blur();
      }}/>
      <span className="pdf-pages">/ {pages || '–'}</span>
      <button type="button" className="icon-button" aria-label={t('Next page')} disabled={page >= pages} onClick={() => onPage(page + 1)}><Icon name="chevronDown" size={16}/></button>
    </div>
    <div className="pdf-zoom">
      <button type="button" className="icon-button" aria-label={t('Zoom out')} title={t('Zoom out (⌘−)')} onClick={() => onZoomBy(1 / 1.1)}><Icon name="minus" size={16}/></button>
      <ChipSelect className="zoom-chip" label={t('Zoom')} value={value} options={options} onChange={onZoom}/>
      <button type="button" className="icon-button" aria-label={t('Zoom in')} title={t('Zoom in (⌘+)')} onClick={() => onZoomBy(1.1)}><Icon name="plus" size={16}/></button>
    </div>
  </>;
}

export function PdfFindButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return <button type="button" className={'icon-button' + (open ? ' active' : '')} aria-label={t('Find in PDF')} aria-pressed={open} title={t('Find (⌘F)')} onClick={onClick}><Icon name="search" size={16}/></button>;
}

export function PdfFind({ inputRef, query, matches, notFound, onQuery, onNext, onClose }: {
  inputRef?: Ref<HTMLInputElement>; query: string; matches: { current: number; total: number }; notFound: boolean;
  onQuery: (query: string) => void; onNext: (previous: boolean) => void; onClose: () => void;
}) {
  return <div className="pdf-find">
    <Icon name="search" size={15}/>
    <input ref={inputRef} autoFocus aria-label={t('Search the PDF')} placeholder={t('Find in PDF')} value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onNext(e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}/>
    <span className="pdf-find-count" aria-live="polite">{query ? notFound ? t('No matches') : matches.total ? t('{current} of {total}', { current: matches.current, total: matches.total }) : '' : ''}</span>
    <button type="button" className="icon-button" aria-label={t('Previous match')} disabled={!matches.total} onClick={() => onNext(true)}><Icon name="chevronUp" size={16}/></button>
    <button type="button" className="icon-button" aria-label={t('Next match')} disabled={!matches.total} onClick={() => onNext(false)}><Icon name="chevronDown" size={16}/></button>
    <button type="button" className="icon-button" aria-label={t('Close search')} onClick={onClose}><Icon name="close" size={15}/></button>
  </div>;
}
