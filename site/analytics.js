// Optional statistics: no provider code or event is sent before an explicit opt-in.
(() => {
  if (location.protocol !== 'https:' || !['papilot.ai', 'www.papilot.ai'].includes(location.hostname) || document.documentElement.dataset.languageRedirect) return;
  const config = document.currentScript;
  const notice = document.getElementById('statistics-notice');
  const preferences = document.getElementById('statistics-preferences');
  const allow = document.getElementById('statistics-allow');
  const decline = document.getElementById('statistics-decline');
  const withdraw = document.getElementById('statistics-withdraw');
  const close = document.getElementById('statistics-close');
  const key = 'papilot-statistics-consent', duration = 180 * 24 * 60 * 60 * 1000;
  const locale = document.documentElement.lang;
  const pagePath = new URL(document.querySelector('link[rel=canonical]').href).pathname;
  const placement = element => element.closest('.hero') ? 'hero' : 'download';
  let preference = null, loaded = false, loading = false, expiryTimer;
  const valid = value => value?.version === config.dataset.consentVersion && ['granted', 'denied'].includes(value.choice) && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + duration;
  const read = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (valid(saved)) return saved;
      localStorage.removeItem(key);
    } catch {}
    return null;
  };
  const granted = () => valid(preference) && preference.choice === 'granted';
  const show = () => {
    notice.hidden = false;
    allow.hidden = granted(); decline.hidden = granted(); withdraw.hidden = !granted();
    close.hidden = !valid(preference);
  };
  const expire = () => {
    clearTimeout(expiryTimer);
    if (!valid(preference)) {
      if (preference) { try { localStorage.removeItem(key); } catch {} }
      preference = null;
      show();
    } else expiryTimer = setTimeout(expire, Math.min(preference.expiresAt - Date.now() + 1, 2147483647));
  };

  // Whitelist each outgoing field. URLs, query strings, click IDs, screen sizes
  // and arbitrary event data from the tracker never reach the collector.
  window.papilotAnalyticsBeforeSend = (type, payload) => {
    if (!granted() || type !== 'event') return false;
    let referrer = '';
    try { const url = new URL(document.referrer); if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin) referrer = url.origin; } catch {}
    const clean = { website: config.dataset.websiteId, hostname: location.hostname, url: pagePath, title: 'Papilot', language: locale, referrer };
    if (payload.name) {
      if (!['download_click', 'copy_install'].includes(payload.name)) return false;
      clean.name = payload.name;
      clean.data = { locale };
      const values = { placement: ['hero', 'download'], platform: ['mac', 'linux'], arch: ['arm64', 'x64'], format: ['dmg', 'AppImage', 'deb'] };
      for (const [name, allowed] of Object.entries(values)) {
        if ((name === 'placement' || payload.name === 'download_click') && allowed.includes(payload.data?.[name])) clean.data[name] = payload.data[name];
      }
    }
    return clean;
  };
  const track = (name, data) => {
    if (!granted() || !loaded) return;
    try { Promise.resolve(window.umami?.track(name, data)).catch(() => {}); } catch {}
  };
  const start = () => {
    if (!granted()) return;
    if (loaded) { track(); return; }
    if (loading) return;
    loading = true;
    const script = document.createElement('script');
    script.async = true;
    script.src = config.dataset.scriptUrl;
    script.referrerPolicy = 'no-referrer';
    script.dataset.websiteId = config.dataset.websiteId;
    script.dataset.domains = 'papilot.ai,www.papilot.ai';
    script.dataset.autoTrack = 'false';
    script.dataset.excludeSearch = 'true';
    script.dataset.excludeHash = 'true';
    script.dataset.beforeSend = 'papilotAnalyticsBeforeSend';
    script.addEventListener('load', () => { loading = false; loaded = true; track(); });
    script.addEventListener('error', () => { loading = false; script.remove(); });
    document.head.append(script);
  };
  const choose = choice => {
    preference = { version: config.dataset.consentVersion, choice, expiresAt: Date.now() + duration };
    try { localStorage.setItem(key, JSON.stringify(preference)); }
    catch { try { localStorage.removeItem(key); } catch {} }
    notice.hidden = true;
    preferences.focus({ preventScroll: true });
    expire();
    if (choice === 'granted') start();
  };
  allow.addEventListener('click', () => choose('granted'));
  decline.addEventListener('click', () => choose('denied'));
  withdraw.addEventListener('click', () => choose('denied'));
  close.addEventListener('click', () => { notice.hidden = true; preferences.focus({ preventScroll: true }); });
  preferences.addEventListener('click', () => { show(); notice.scrollIntoView({ block: 'start' }); notice.focus({ preventScroll: true }); });
  document.getElementById('statistics-privacy').href = config.dataset.privacyUrl;
  preferences.hidden = false;

  const click = event => {
    if (!granted() || event.defaultPrevented || (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0)) return;
    const link = event.target.closest?.('a[data-download-format]');
    if (!link) return;
    const { downloadPlatform: platform, downloadArch: arch, downloadFormat: format } = link.dataset;
    track('download_click', { platform, arch, format, placement: placement(link) });
  };
  document.addEventListener('click', click);
  document.addEventListener('auxclick', click);
  document.addEventListener('papilot:install-copied', event => track('copy_install', { placement: placement(event.target) }));
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    const wasGranted = granted();
    preference = read();
    expire();
    if (valid(preference)) notice.hidden = true;
    if (!wasGranted && granted()) start();
  });
  document.addEventListener('visibilitychange', expire);
  preference = read();
  expire();
  if (granted()) start();
})();
