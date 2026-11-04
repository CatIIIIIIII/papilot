import { createHash } from 'node:crypto';

// Public Umami configuration, supplied only by the production Pages build.
export function siteAnalytics(env = process.env) {
  const script = env.PAPILOT_UMAMI_SCRIPT_URL?.trim() || '';
  const website = env.PAPILOT_UMAMI_WEBSITE_ID?.trim() || '';
  const privacy = env.PAPILOT_ANALYTICS_PRIVACY_URL?.trim() || '';
  if (!script && !website && !privacy) return '';
  if (!script || !website || !privacy) throw new Error('Set PAPILOT_UMAMI_SCRIPT_URL, PAPILOT_UMAMI_WEBSITE_ID and PAPILOT_ANALYTICS_PRIVACY_URL together, or leave all unset.');
  let url;
  try { url = new URL(script); } catch { throw new Error('PAPILOT_UMAMI_SCRIPT_URL must be an absolute HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('PAPILOT_UMAMI_SCRIPT_URL must use HTTPS without credentials or a fragment.');
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(website)) throw new Error('PAPILOT_UMAMI_WEBSITE_ID must be a UUID.');
  let notice;
  try { notice = new URL(privacy); } catch { throw new Error('PAPILOT_ANALYTICS_PRIVACY_URL must be an absolute HTTPS URL.'); }
  if (notice.protocol !== 'https:' || notice.username || notice.password) throw new Error('PAPILOT_ANALYTICS_PRIVACY_URL must use HTTPS without credentials.');
  const attribute = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  // Increase the leading version if the purposes or consent wording change.
  const consentVersion = '1-' + createHash('sha256').update(JSON.stringify([url.href, website, notice.href])).digest('hex').slice(0, 16);
  return `<meta name="referrer" content="strict-origin"><script defer src="analytics.js" data-script-url="${attribute(url.href)}" data-website-id="${attribute(website)}" data-privacy-url="${attribute(notice.href)}" data-consent-version="${consentVersion}"></script>`;
}
