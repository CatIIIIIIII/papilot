import { useEffect, useRef, useState } from 'react';
import { keepDialogFocus } from '../focus.ts';
import { useLanguage } from '../i18n.ts';
import './style.css';
import { Icon } from '../icons.tsx';
import { browserStorage } from '../storage.ts';
import { DemoDownloads } from './downloads.tsx';
import { playgroundApi } from './api.ts';

export function PlaygroundNotice() {
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [dismissed, setDismissed] = useState(() => browserStorage.getItem('papilot:demo-notice-dismissed') === 'true');
  const dialog = useRef<HTMLDialogElement>(null);
  const { language } = useLanguage();
  const zh = language.startsWith('zh');
  const reset = async () => {
    setResetting(true);
    await playgroundApi('/playground/reset', {});
    window.location.reload();
  };
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('papilot:playground-download', show);
    return () => window.removeEventListener('papilot:playground-download', show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); opener?.focus(); };
  }, [open]);
  const download = <a className="button secondary compact demo-download" href="https://papilot.ai/#download" target="_blank" rel="noreferrer"><Icon name="download" size={14}/><span>{zh ? '下载 Papilot' : 'Download Papilot'}</span></a>;
  return <>
    {!dismissed && <div className="playground-notice" role="region" aria-label="Demo">
      <div className="demo-heading">{zh ? '这是一个' : 'This is a '}<strong>{zh ? '静态演示' : 'static demo'}</strong>{zh ? '，没有 LaTeX 和 LLM 智能体后端。要体验完整工作流程，请' : ' without LaTeX or LLM agent backends. To experience the full workflow, please '}<a className="demo-download-link" aria-label={zh ? '下载 Papilot' : 'Download Papilot'} href="https://papilot.ai/#download" target="_blank" rel="noreferrer">{zh ? '下载 Papilot' : 'download Papilot'}</a>{zh ? '。' : '.'}</div>
      <DemoDownloads zh={zh}/>
      <div className="demo-actions">
        <button type="button" className="button compact demo-reset" aria-label={zh ? '重置演示' : 'Reset demo'} title={zh ? '重置演示' : 'Reset demo'} disabled={resetting} onClick={() => void reset()}><Icon name="refresh" size={15}/><span>{zh ? '重置演示' : 'Reset demo'}</span></button>
        <button className="icon-button" aria-label={zh ? '关闭演示提示' : 'Dismiss demo notice'} title={zh ? '关闭演示提示' : 'Dismiss demo notice'} onClick={() => { browserStorage.setItem('papilot:demo-notice-dismissed', 'true'); setDismissed(true); }}><Icon name="close" size={14}/></button>
      </div>
    </div>}
    {open && <dialog ref={dialog} className="modal-backdrop" aria-labelledby="playground-download-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); setOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="modal playground-dialog">
        <h2 id="playground-download-title">{zh ? '下载 Papilot，开始修改你的论文' : 'Make it your paper with Papilot'}</h2>
        <p>{zh ? '这里的任务是固定示例。下载 Papilot 后，即可打开自己的论文、连接智能体并运行任务。' : 'These tasks are fixed examples. Download Papilot to open your own paper, connect an agent, and run tasks.'}</p>
        <p>{zh ? '没有任务被运行。你的输入和笔记会留在此浏览器中。' : 'No task was run. Your draft and notes are kept in this browser.'}</p>
        <div className="button-row"><button autoFocus className="button secondary" onClick={() => setOpen(false)}>{zh ? '关闭' : 'Close'}</button>{download}</div>
      </section>
    </dialog>}
  </>;
}
