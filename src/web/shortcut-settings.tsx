import { useRef, useState } from 'react';
import { t } from './i18n.ts';
import { ShortcutKeyboard, shortcutTone } from './shortcut-keyboard.tsx';
import './shortcut-settings.css';
import { bindingLabel, defaults, keyBinding, reservedBinding, resolveShortcuts, saveShortcutBindings, saveShortcuts, shortcutActions, useShortcutBindings, useShortcuts, type ShortcutAction } from './shortcuts.ts';

export function ShortcutSettings() {
  const shortcuts = useShortcuts(), bindings = useShortcutBindings();
  const [editing, setEditing] = useState<ShortcutAction | null>(null), [error, setError] = useState('');
  const [highlighted, setHighlighted] = useState<ShortcutAction | null>(null);
  const keyButtons = useRef<Partial<Record<ShortcutAction, HTMLButtonElement>>>({});
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const keyLabel = (binding: string) => mac ? bindingLabel(binding).replace(/⌘\+/g, '⌘').replace(/Ctrl\+/g, '⌃').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧') : bindingLabel(binding);
  const labels: Record<ShortcutAction, [string, string]> = {
    accept: [t('Accept change'), t('Accept the current proposal. In Changes, stage or unstage it.')],
    reject: [t('Reject change'), t('Reject the current proposal. In Changes, revert it.')],
    comment: [t('Request a revision'), t('Write feedback on the current proposed change.')],
    next: [t('Next change'), t('Move to the next visible change.')],
    previous: [t('Previous change'), t('Move to the previous visible change.')],
    pending: [t('Next undecided change'), t('Jump to the next change that still needs a decision.')],
    source: [t('Show LaTeX source'), t('Show or hide the source for the current change.')],
    undo: [t('Undo review decision'), t('Undo the last review decision or revert.')],
    help: [t('Keyboard shortcuts'), t('Open these shortcut settings.')],
  };
  const groups: { label: string; actions: ShortcutAction[] }[] = [
    { label: t('Review decisions'), actions: ['accept', 'reject', 'comment', 'undo'] },
    { label: t('Review navigation'), actions: ['next', 'previous', 'pending'] },
    { label: t('View & help'), actions: ['source', 'help'] },
  ];
  function conflicts(action: ShortcutAction, keys: string[]) {
    const conflict = shortcutActions.find(other => other !== action && keys.some(key => shortcuts[other].includes(key)));
    if (conflict) setError(t('Already used for {action}. Choose another shortcut.', { action: labels[conflict][0] }));
    return Boolean(conflict);
  }
  function toggle(action: ShortcutAction, enabled: boolean) {
    setEditing(null); setError('');
    if (!enabled) {
      saveShortcutBindings({ ...bindings, [action]: shortcuts[action] });
      saveShortcuts({ ...shortcuts, [action]: [] });
    } else {
      const keys = bindings[action].length ? bindings[action] : defaults[action];
      if (conflicts(action, keys)) return;
      saveShortcuts({ ...shortcuts, [action]: keys });
    }
  }
  function edit(action: ShortcutAction) {
    keyButtons.current[action]?.focus();
    setEditing(action); setError('');
  }
  return <div className="shortcut-settings settings-page">
    <ShortcutKeyboard shortcuts={shortcuts} labels={labels} mac={mac} keyLabel={keyLabel} active={editing || highlighted} onHighlight={setHighlighted} onEdit={edit}/>
    <div className="shortcut-customize-header">
      <h3 className="settings-section-title">{t('Customize shortcuts')}</h3>
      <p className="settings-intro" id="shortcut-instructions">{t('Click a key to change it, then press the new shortcut. Escape cancels; Backspace clears it.')}</p>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {groups.map(group => <section className="shortcut-group" key={group.label} data-tone={shortcutTone(group.actions[0])}>
      <h3 className="settings-section-title"><span className="shortcut-dot"/>{group.label}</h3>
      <div className="shortcut-list">{group.actions.map(action => {
        const enabled = shortcuts[action].length > 0;
        const assigned = enabled ? shortcuts[action] : bindings[action];
        return <div className={'shortcut-row' + (enabled ? '' : ' disabled') + (editing === action || highlighted === action ? ' highlighted' : '')} key={action}
          onMouseEnter={() => setHighlighted(action)} onMouseLeave={() => setHighlighted(null)} onFocus={() => setHighlighted(action)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHighlighted(null); }}>
          <input id={`shortcut-toggle-${action}`} type="checkbox" role="switch" className="switch" aria-label={t('Enable shortcut: {action}', { action: labels[action][0] })} checked={enabled} onChange={event => toggle(action, event.target.checked)}/>
          <label htmlFor={`shortcut-toggle-${action}`} className="shortcut-label"><span className="settings-name">{labels[action][0]}</span><span className="shortcut-description">{labels[action][1]}</span></label>
          <button ref={element => { if (element) keyButtons.current[action] = element; else delete keyButtons.current[action]; }} type="button" className={'shortcut-key' + (editing === action ? ' recording' : '')} aria-label={t('Change shortcut: {action}', { action: labels[action][0] })} aria-describedby="shortcut-instructions"
            onClick={() => edit(action)} onBlur={() => setEditing(null)}
            onKeyDown={event => {
              if (editing !== action) return;
              if (event.key === 'Tab') { setEditing(null); return; }
              event.preventDefault(); event.stopPropagation();
              if (event.key === 'Escape') { setEditing(null); setError(''); return; }
              const binding = keyBinding(event.nativeEvent);
              if (!binding) return;
              const clear = event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
              if (!clear && reservedBinding(binding)) { setError(t('This key is reserved for the browser or text editing. Choose another shortcut.')); return; }
              if (!clear && conflicts(action, [binding])) return;
              const keys = clear ? [] : [binding];
              saveShortcutBindings({ ...bindings, [action]: keys });
              if (enabled || clear) saveShortcuts({ ...shortcuts, [action]: keys });
              setEditing(null); setError('');
            }}>{editing === action ? <span>{t('Press a key…')}</span> : assigned.length ? assigned.map(binding => <kbd key={binding}>{keyLabel(binding)}</kbd>) : <span>{t('Not assigned')}</span>}</button>
        </div>;
      })}</div>
    </section>)}
    <section className="shortcut-system">
      <h3 className="settings-section-title">{t('Standard shortcuts')}</h3>
      <p className="settings-intro">{t('These keep the usual browser and text-editing behavior.')}</p>
      <dl>
        <div><dt>{t('Copy selected PDF text')}</dt><dd><kbd>{mac ? '⌘C' : 'Ctrl+C'}</kbd></dd></div>
        <div><dt>{t('Undo typing, a deleted note, or the last review decision, depending on focus.')}</dt><dd><kbd>{mac ? '⌘Z' : 'Ctrl+Z'}</kbd></dd></div>
        <div><dt>{t('Send the review comment being written.')}</dt><dd><kbd>↵</kbd></dd></div>
        <div><dt>{t('Close the current editor or cancel region selection.')}</dt><dd><kbd>Esc</kbd></dd></div>
      </dl>
    </section>
    <footer className="shortcut-footer">
      <p className="settings-intro">{t('Review shortcuts work while the PDF review is focused. They pause while you type or select text. Changes are saved in this browser.')}</p>
      <button type="button" className="button secondary compact" disabled={JSON.stringify(shortcuts) === JSON.stringify(defaults) && JSON.stringify(bindings) === JSON.stringify(defaults)} onClick={() => { saveShortcutBindings(resolveShortcuts({})); saveShortcuts(resolveShortcuts({})); setEditing(null); setError(''); }}>{t('Restore default shortcuts')}</button>
    </footer>
  </div>;
}
