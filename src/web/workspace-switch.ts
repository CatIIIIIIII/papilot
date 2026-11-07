// Keep an MRU order while dropping destinations that no longer exist.
export function workspaceOrder(ids: string[], recent: string[], active: string | null): string[] {
  const available = new Set(ids);
  return [...new Set([...(active === null ? [] : [active]), ...recent, ...ids])].filter(id => available.has(id));
}

// Command+Backquote is macOS's window switcher. Native shortcut interception
// happens before DOM events, which browser-injected key tests cannot reproduce.
export const workspaceModifier = 'Control';
export const workspaceModifierLabel = 'Ctrl';
export const workspaceShortcutLabel = workspaceModifierLabel + ' + `';

export function workspaceSwitchKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'keyCode'>): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && event.keyCode !== 229
    && (event.code === 'Backquote' || event.key === '`' || event.key === '~');
}

export const WORKSPACE_KEY_EVENT = 'papilot:workspace-key';

// Keyboard events do not bubble out of the embedded review document. Forward
// the original event synchronously so the host can consume just its shortcut.
export function connectWorkspaceKeys(document: Document): () => void {
  const forward = (event: KeyboardEvent) => window.dispatchEvent(new CustomEvent(WORKSPACE_KEY_EVENT, { detail: event }));
  document.addEventListener('keydown', forward, true);
  document.addEventListener('keyup', forward, true);
  return () => {
    document.removeEventListener('keydown', forward, true);
    document.removeEventListener('keyup', forward, true);
  };
}
