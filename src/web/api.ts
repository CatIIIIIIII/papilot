import { errorText, t } from './i18n.ts';

// Long operations wait for the server. The caller may cancel a request when
// its view closes or a newer selection replaces it.
export async function requestApi<T = any>(route: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const file = body instanceof File;
  const response = await fetch('/api' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': file ? 'application/octet-stream' : 'application/json', 'X-Papilot-Token': token,
      ...(file ? { 'X-Papilot-Filename': encodeURIComponent(body.name) } : {}) },
    ...(body === undefined ? {} : { body: file ? body : JSON.stringify(body) }),
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ? errorText(value.error) : t('Request failed. Please try again.'));
  return value;
}

// The state the app polls. Sending the tag of the state it shows lets the
// server answer an unchanged one with an empty 304, returned here as null.
export async function requestState<T>(token: string, tag: string, signal?: AbortSignal): Promise<{ value: T | null; tag: string }> {
  const response = await fetch('/api/state', { headers: { 'X-Papilot-Token': token, ...(tag ? { 'If-None-Match': tag } : {}) }, cache: 'no-store', signal });
  if (response.status === 304) return { value: null, tag };
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ? errorText(value.error) : t('Request failed. Please try again.'));
  return { value, tag: response.headers.get('ETag') || '' };
}
