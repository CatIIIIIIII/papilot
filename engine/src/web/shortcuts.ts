// Shared by the standalone review and its host's shortcut settings.
export const SHORTCUT_STORAGE = 'latex-review:shortcuts';
export const SHORTCUT_EVENT = 'latex-review:shortcuts-changed';
export const defaults = {
  accept: ['a'], reject: ['r'], comment: ['c'], next: ['j', 'ArrowRight'],
  previous: ['k', 'ArrowLeft'], pending: ['n'], source: ['s'], undo: ['u'], help: ['?'],
};
export type ShortcutAction = keyof typeof defaults;
export type Shortcuts = Record<ShortcutAction, string[]>;
export const shortcutActions = Object.keys(defaults) as ShortcutAction[];
type KeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>;

export function keyBinding(event: KeyEvent): string | null {
  if (event.isComposing || ['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  // Punctuation already carries Shift in event.key (for example, '?').
  return [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && (/^[a-z]$/.test(key) || key.length > 1) && 'Shift', key].filter(Boolean).join('+');
}

export function validBinding(binding: string): boolean {
  return /^(?:(?:Ctrl|Meta|Alt|Shift)\+)*(?:[a-z0-9?/,.;'\[\]`=\-]|Arrow(?:Left|Right|Up|Down))$/.test(binding);
}

// Leave text editing, browser navigation and dialog keys with the browser.
export function reservedBinding(binding: string): boolean {
  return !validBinding(binding) || /^(?:Ctrl|Meta)\+(?:Shift\+)?[acflnpqrstuvwxz=\-]$/.test(binding)
    || /^(?:Alt|Meta)\+Arrow(?:Left|Right)$/.test(binding);
}

export function resolveShortcuts(value: unknown): Shortcuts {
  const saved = value && typeof value === 'object' ? value as Partial<Shortcuts> : {};
  return Object.fromEntries(shortcutActions.map(action => {
    const keys = saved[action];
    return [action, Array.isArray(keys) && keys.length <= 4 && keys.every(key => typeof key === 'string' && !reservedBinding(key)) ? [...new Set(keys)] : [...defaults[action]]];
  })) as Shortcuts;
}

export function parseShortcuts(value: string | null): Shortcuts {
  try { return resolveShortcuts(JSON.parse(value || '{}')); } catch { return resolveShortcuts({}); }
}

export function readShortcuts(): Shortcuts {
  try { return parseShortcuts(localStorage.getItem(SHORTCUT_STORAGE)); } catch { return resolveShortcuts({}); }
}

export function shortcutAction(event: KeyEvent, shortcuts: Shortcuts): ShortcutAction | undefined {
  const binding = keyBinding(event);
  return binding ? shortcutActions.find(action => shortcuts[action].includes(binding)) : undefined;
}

export function bindingLabel(binding: string): string {
  return binding.split('+').map(key => ({ Meta: '⌘', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓' })[key] || key.toUpperCase()).join('+');
}
