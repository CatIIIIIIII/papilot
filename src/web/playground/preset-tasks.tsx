import { useState } from 'react';
import type { Annotation } from '../../shared.ts';
import { Icon } from '../icons.tsx';
import { useLanguage } from '../i18n.ts';
import plans from '../../../examples/playground-paper/edits.json';
import notes from '../../../examples/playground-paper/preview/notes.json';

export function PlaygroundPresets({ selected, open, disabled }: { selected: Annotation[]; open: (id: string) => Promise<void>; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const zh = useLanguage().language.startsWith('zh');
  const presets = plans.filter(plan => plan.preset && (!selected.length || selected.some(note => plan.notes.includes(note.id))));
  const shown = expanded || selected.length ? presets : presets.filter(plan => ['example-note-opening', 'example-note-filler', 'example-note-math'].includes(plan.id));
  if (!shown.length) return null;
  return <section className="demo-presets" aria-label={zh ? '预设任务' : 'Prepared tasks'}>
    <div className="demo-presets-heading"><span>{zh ? '试试预设任务' : 'Try a prepared task'}</span><span>{zh ? '固定修改' : 'Fixed edits'}</span></div>
    {shown.map(plan => <button className="demo-preset" key={plan.id} disabled={disabled} aria-label={`Open prepared task: ${plan.title}`} onClick={() => void open(plan.id)}>
      <span className="demo-preset-number">{plan.notes.map(id => notes.findIndex(note => note.id === id) + 1).join('·')}</span>
      <span className="demo-preset-copy"><strong>{plan.title}</strong><span>{plan.notes.map(id => notes.find(note => note.id === id)!.quote).join(' · ')}</span></span>
      <Icon name="arrowRight" size={14}/>
    </button>)}
    {!selected.length && presets.length > shown.length && <button className="demo-presets-more" onClick={() => setExpanded(true)}>{zh ? '更多预设任务' : 'More prepared tasks'}<Icon name="chevronDown" size={13}/></button>}
  </section>;
}
