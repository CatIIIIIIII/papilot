import type { IncomingHttpHeaders } from 'node:http';
export function authorize(headers: IncomingHttpHeaders, remoteAddress: string | undefined, port: number, publicOrigin: string, owner: string): string | null {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress || '')) return 'Papilot only accepts local or Tailscale Serve connections.';
  const local = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const host = headers.host || '';
  const remoteHost = publicOrigin ? new URL(publicOrigin).host : '';
  if ((headers['x-forwarded-for'] || headers['tailscale-user-login']) && (!owner || headers['tailscale-user-login'] !== owner)) return 'This Tailscale account does not have access.';
  if (local.has(host)) {
    if (headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(headers.origin)) return 'The request origin does not match.';
    return null;
  }
  if (host !== remoteHost || !owner || headers['tailscale-user-login'] !== owner) return 'Use your authorized Tailscale account to access Papilot.';
  if (headers.origin && headers.origin !== publicOrigin) return 'The request origin does not match.';
  return null;
}
