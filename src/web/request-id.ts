import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Persist only a digest: duplicating a long draft here can exhaust browser
// storage and lose the retry ID on reload. JS hashing also works over LAN HTTP.
export function requestId(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, content: string, newId: () => string): string {
  const signature = 'sha256:' + bytesToHex(sha256(content));
  let previous: { signature?: unknown; id?: unknown } | null = null;
  try { previous = JSON.parse(storage.getItem(key) || 'null'); } catch { /* Invalid saved request. */ }
  // Migrate older records without changing the ID of a pending submission.
  const matches = previous?.signature === signature || previous?.signature === content;
  const id = matches && typeof previous?.id === 'string' && previous.id ? previous.id : newId();
  storage.setItem(key, JSON.stringify({ signature, id }));
  return id;
}
