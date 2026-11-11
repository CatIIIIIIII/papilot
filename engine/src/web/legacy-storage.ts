// Papilot 0.9.4 and earlier stored the review viewer's preferences, shortcuts
// and drafts under keys named after the review engine's former standalone
// skill. Each entry point imports this module first, so the keys move before
// anything reads them.
const OLD = /^(playground:)?latex-review:/;
export function moveLegacyStorage(storage?: Storage) {
  try {
    // Reading localStorage itself throws where the browser blocks storage.
    storage ??= globalThis.localStorage;
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && OLD.test(key)) keys.push(key);
    }
    for (const key of keys) {
      const next = key.replace(OLD, "$1papilot:review:"), value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
      storage.removeItem(key);
    }
  } catch {
    /* Blocked or full storage keeps the earlier keys for the next visit. */
  }
}
moveLegacyStorage();
