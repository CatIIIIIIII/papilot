import { useState } from 'react';
import type { TimelineItem } from '../../shared.ts';
import { Icon } from '../icons.tsx';
import { useLanguage } from '../i18n.ts';
import { playgroundApi } from './api.ts';

export function PlaygroundProgress({ item }: { item: TimelineItem }) {
  const zh = useLanguage().language.startsWith('zh');
  const [resuming, setResuming] = useState(false);
  const complete = item.status === 'completed', paused = item.status === 'paused';
  const labels: Record<string, string> = { Thinking: '思考中', 'Preparing the edit': '准备修改', 'Comparing the PDF': '对比 PDF', 'Writing the response': '整理回复', 'Process complete': '处理完成', Paused: '已暂停' };
  async function resume() {
    setResuming(true);
    try { await playgroundApi(`/tasks/${item.taskId}/publish`, {}); window.dispatchEvent(new Event('papilot:playground-change')); }
    finally { setResuming(false); }
  }
  return <details className="demo-thinking" data-status={item.status} open={!complete}>
    <summary>{complete ? <Icon name="check" size={14}/> : paused ? <Icon name="pause" size={14}/> : <span className="spinner"/>}<strong>{zh ? labels[item.text] : item.text}</strong><span>{zh ? '演示回放' : 'Demo replay'}</span></summary>
    <p>{item.detail}</p>
    {paused && <button className="button secondary compact" disabled={resuming} onClick={() => void resume()}>{zh ? '继续演示' : 'Resume demo'}</button>}
  </details>;
}
