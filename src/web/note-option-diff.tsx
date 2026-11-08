import { Fragment, useEffect, useState } from 'react';
import type { Block, RoundDetail, Strip } from '../../engine/src/types.ts';
import { PdfStrip } from '../../engine/src/web/PdfStrip.tsx';
import { wordDiff } from '../../engine/src/web/model.ts';
import { t } from './i18n.ts';

// Clip only trailing blank page space. Scan the rendered image rather than
// text bounds so figures and other non-text content remain in the preview.
const contentHeights = new Map<string, number>();
function CompactContext({ image, base }: { image: Strip; base: string }) {
  const src = base + image.clean;
  const [height, setHeight] = useState(() => contentHeights.get(src) ?? image.height);
  useEffect(() => {
    if (image.height < 80 || contentHeights.has(src)) return;
    let cancelled = false;
    const bitmap = new Image();
    bitmap.onload = () => {
      if (cancelled) return;
      try {
        const scale = Math.min(1, 1000 / image.width, 4096 / image.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(image.width * scale); canvas.height = Math.ceil(image.height * scale);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let bottom = -1;
        outer: for (let y = canvas.height - 1; y >= 0; y--) for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i + 3] > 4 && Math.min(data[i], data[i + 1], data[i + 2]) < 254) { bottom = y; break outer; }
        }
        const end = Math.min(image.height, Math.max(6, (bottom + 1) / scale + 6));
        const compact = image.height - end > 24 ? end : image.height;
        if (contentHeights.size >= 256) contentHeights.delete(contentHeights.keys().next().value!);
        contentHeights.set(src, compact); setHeight(compact);
      } catch { /* Keep the complete strip if it cannot be inspected. */ }
    };
    bitmap.src = src;
    return () => { cancelled = true; bitmap.onload = null; };
  }, [src, image.width, image.height]);
  return <div className="note-comparison-context" style={{ paddingBottom: `${height / image.width * 100}%` }}>
    <div><PdfStrip image={image} base={base} label={t('Unchanged context')} clean/></div>
  </div>;
}

/** Keep the complete candidate and its native PDF context, but attribute
 * highlights only to the current note's exact edits. */
export function NoteOptionDiff({ detail, focus }: { detail: RoundDetail; focus: string[] }) {
  const strips = (images: Strip[], label: string, clean = false) => images.map((image, index) =>
    <PdfStrip key={`${image.src}:${index}`} image={image} base={detail.files} label={label} clean={clean} focus={focus}/>);
  const block = (item: Block, index: number) => {
    if (item.kind === 'gap') return <div key={index} className="note-comparison-gap" role="separator">⋯</div>;
    if (item.kind === 'context') return <CompactContext key={detail.files + item.image.clean} image={item.image} base={detail.files}/>;
    const units = detail.units.filter(unit => item.units.includes(unit.id));
    return <div key={index} className="note-comparison-change" data-units={item.units.join(' ')} data-related={item.units.some(id => focus.includes(id))}>
      <div className="note-comparison-side before">
        <span className="note-comparison-side-label">{t('Before')}</span>
        {item.before.length ? strips(item.before, t('Before')) : <pre>{units.map(unit => unit.old_text).join('\n')}</pre>}
      </div>
      <div className="note-comparison-side after">
        <span className="note-comparison-side-label">{t('After')}</span>
        {item.after.length ? strips(item.after, t('After')) : <pre>{units.map(unit => unit.new_text).join('\n')}</pre>}
      </div>
    </div>;
  };
  return <div className="note-option-comparison" role="region" aria-label={t('Complete PDF comparison')} tabIndex={0} data-revision={detail.after}>
    {detail.sections.map((section, index) => <section key={`${section.node}:${index}`} aria-label={`${section.number} ${section.title}`}>{section.blocks.map(block)}</section>)}
    {detail.loose.map(block)}
  </div>;
}

/** Read the same complete candidate as the PDF, including unrelated edits.
 * Only the focused note receives colored source marks. */
export function NoteOptionSource({ detail, focus }: { detail: RoundDetail; focus: string[] }) {
  const lines = (start: number, end: number) => end <= start ? String(start) : `${start}–${end}`;
  return <div className="note-option-comparison note-option-source" role="region" aria-label={t('LaTeX comparison')} tabIndex={0} data-revision={detail.after}>
    {detail.units.map(unit => {
      const related = focus.includes(unit.id), parts = wordDiff(unit.old_text, unit.new_text);
      return <section className="note-source-unit" key={unit.id} data-unit={unit.id} data-related={related}>
        <header><code>{unit.file}</code><span>{lines(unit.old_start, unit.old_end)} → {lines(unit.new_start, unit.new_end)}</span></header>
        {unit.kind === 'binary' ? <p>{t('Binary file changed.')}</p> : (['before', 'after'] as const).map(side => <div className={`note-source-side ${side}`} key={side}>
          <span>{side === 'before' ? t('Before') : t('After')}</span>
          <pre>{parts.filter(part => part.type !== (side === 'before' ? 'ins' : 'del')).map((part, index) => related && part.type === 'del' ? <del key={index}>{part.text}</del> : related && part.type === 'ins' ? <ins key={index}>{part.text}</ins> : <Fragment key={index}>{part.text}</Fragment>)}</pre>
        </div>)}
        {unit.truncated && <p>{t('Long change: the source is shortened.')}</p>}
      </section>;
    })}
  </div>;
}
