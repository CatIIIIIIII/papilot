// Cookieless statistics start by default; privacy-page opt-outs and browser signals are respected.
(() => {
  if (location.protocol !== 'https:' || !['papilot.ai', 'www.papilot.ai'].includes(location.hostname) || document.documentElement.dataset.languageRedirect) return;
  const config = document.currentScript;
  const locale = document.documentElement.lang;
  const pagePath = new URL(document.querySelector('link[rel=canonical]').href).pathname;
  const placement = element => element.closest('.topbar') ? 'header' : element.closest('.hero') ? 'hero' : element.closest('.footer') ? 'footer' : 'download';
  const languages = ['en', 'zh-CN', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'sv'];
  const sections = ['hero', 'agents', 'why', 'features', 'download', 'feature_notes', 'feature_revise', 'feature_record'];
  const schema = {
    download_click: { placement: ['hero', 'download'], platform: ['mac', 'linux', 'windows'], arch: ['arm64', 'x64'], format: ['dmg', 'AppImage', 'deb', 'exe', 'portable-exe'] },
    copy_install: { placement: ['hero', 'download'] },
    copy_install_failed: { placement: ['hero', 'download'] },
    navigation: { target: ['hero', 'agents', 'why', 'features', 'download'], placement: ['header', 'hero', 'footer'] },
    outbound_click: { destination: ['github', 'releases', 'npm', 'readme', 'guide', 'changelog', 'license', 'discussions', 'mactex', 'texlive'], placement: ['header', 'hero', 'download', 'footer'] },
    menu_open: { menu: ['download', 'language'], placement: ['header', 'hero', 'download'] },
    language_change: { language: languages },
    theme_change: { theme: ['light', 'dark'] },
    demo_interaction: { action: ['accept', 'reject', 'reopen', 'source_open', 'source_close'] },
    section_view: { section: sections },
    scroll_depth: { percent: [25, 50, 75, 100] },
    engaged_time: { seconds: [15, 30, 60, 120] },
  };
  const eventData = (name, data) => {
    if (!Object.hasOwn(schema, name)) return null;
    const clean = { locale };
    for (const [field, values] of Object.entries(schema[name])) {
      if (!values.includes(data?.[field])) return null;
      clean[field] = data[field];
    }
    return clean;
  };
  let loaded = false, loading = false;
  let measurement, collectionStartedAt = Infinity;
  const stopMeasuring = () => { measurement?.(); measurement = null; collectionStartedAt = Infinity; };
  const enabled = () => window.papilotStatistics?.enabled() === true;

  // Whitelist each outgoing field. URLs, query strings, click IDs, screen sizes
  // and arbitrary event data from the tracker never reach the collector.
  window.papilotAnalyticsBeforeSend = (type, payload) => {
    if (!enabled() || type !== 'event') return false;
    let referrer = '';
    try { const url = new URL(document.referrer); if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin) referrer = url.origin; } catch {}
    const clean = { website: config.dataset.websiteId, hostname: location.hostname, url: pagePath, title: 'Papilot', language: locale, referrer };
    if (payload.name) {
      const data = eventData(payload.name, payload.data);
      if (!data) return false;
      clean.name = payload.name;
      clean.data = data;
    }
    return clean;
  };
  const track = (name, data) => {
    if (!enabled() || !loaded) return;
    if (name) { data = eventData(name, data); if (!data) return; }
    try { Promise.resolve(window.umami?.track(name, data)).catch(() => {}); } catch {}
  };
  const startMeasuring = () => {
    if (measurement || !enabled() || !loaded) return;
    collectionStartedAt = performance.now();
    const targets = sections.map(name => [name, document.querySelector(name === 'hero' ? '.hero' : name.startsWith('feature_') ? `[data-scene="${name.slice(8)}"]` : `#${name}`)]);
    const seen = new Set(), visibleSince = new Map(), times = new Set();
    const depth = () => Math.min(100, Math.floor((scrollY + innerHeight) / document.documentElement.scrollHeight * 100 + .1));
    // Already-passed thresholds are a baseline, never a backlog to replay.
    const depths = new Set(schema.scroll_depth.percent.filter(value => value <= depth()));
    let visibleTime = 0, visibleAt = document.hidden ? null : performance.now(), scrollTimer;
    const measure = () => {
      if (!enabled()) { stopMeasuring(); return; }
      const now = performance.now();
      if (visibleAt !== null) visibleTime += now - visibleAt;
      visibleAt = document.hidden ? null : now;
      if (document.hidden) { visibleSince.clear(); return; }
      for (const seconds of schema.engaged_time.seconds) if (!times.has(seconds) && visibleTime >= seconds * 1000) {
        times.add(seconds); track('engaged_time', { seconds });
      }
      for (const percent of schema.scroll_depth.percent) if (!depths.has(percent) && depth() >= percent) {
        depths.add(percent); track('scroll_depth', { percent });
      }
      for (const [section, element] of targets) {
        if (!element || seen.has(section)) continue;
        const rect = element.getBoundingClientRect();
        const visible = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        if (visible < Math.min(rect.height, innerHeight) / 2) { visibleSince.delete(section); continue; }
        if (!visibleSince.has(section)) visibleSince.set(section, now);
        if (now - visibleSince.get(section) >= 1000) { seen.add(section); track('section_view', { section }); }
      }
    };
    const scroll = () => { if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = null; measure(); }, 250); };
    const timer = setInterval(measure, 1000);
    addEventListener('scroll', scroll, { passive: true });
    document.addEventListener('visibilitychange', measure);
    measurement = () => { clearInterval(timer); clearTimeout(scrollTimer); removeEventListener('scroll', scroll); document.removeEventListener('visibilitychange', measure); };
    measure();
  };
  const start = () => {
    if (!enabled()) return;
    if (loaded) { track(); startMeasuring(); return; }
    if (loading) return;
    loading = true;
    const script = document.createElement('script');
    script.async = true;
    script.src = config.dataset.scriptUrl;
    script.referrerPolicy = 'no-referrer';
    script.dataset.websiteId = config.dataset.websiteId;
    script.dataset.domains = 'papilot.ai,www.papilot.ai';
    script.dataset.autoTrack = 'false';
    script.dataset.doNotTrack = 'true';
    script.dataset.excludeSearch = 'true';
    script.dataset.excludeHash = 'true';
    script.dataset.beforeSend = 'papilotAnalyticsBeforeSend';
    script.addEventListener('load', () => { loading = false; loaded = true; track(); startMeasuring(); });
    script.addEventListener('error', () => { loading = false; script.remove(); });
    document.head.append(script);
  };
  const destinations = new Map([
    ['https://github.com/PapilotAI/papilot', 'github'], ['https://github.com/cu1ch3n/papilot', 'github'],
    ['https://github.com/PapilotAI/papilot/releases/latest', 'releases'], ['https://www.npmjs.com/package/papilot', 'npm'],
    ['https://github.com/PapilotAI/papilot/discussions', 'discussions'], ['https://github.com/PapilotAI/papilot/blob/main/LICENSE', 'license'],
    ['https://github.com/PapilotAI/papilot/blob/main/docs/guide.md', 'guide'], ['https://github.com/PapilotAI/papilot/blob/main/docs/guide.md#agents', 'guide'],
    ['https://github.com/PapilotAI/papilot/blob/main/CHANGELOG.md', 'changelog'], ['https://www.tug.org/mactex/', 'mactex'], ['https://www.tug.org/texlive/', 'texlive'],
    ['https://github.com/cu1ch3n/papilot#readme', 'readme'],
    ...languages.filter(language => language !== 'en').map(language => [`https://github.com/cu1ch3n/papilot/blob/main/docs/readme/README.${language}.md`, 'readme']),
  ]);
  const click = event => {
    if (!enabled() || !event.isTrusted || event.defaultPrevented || (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0)) return;
    const link = event.target.closest?.('a');
    if (!link) return;
    if (link.matches('[data-download-format]')) {
      const { downloadPlatform: platform, downloadArch: arch, downloadFormat: format } = link.dataset;
      track('download_click', { platform, arch, format, placement: placement(link) });
    } else if (link.matches('.brand, .nav a, .scroll-cue')) {
      track('navigation', { target: link.matches('.brand') ? 'hero' : link.hash.slice(1), placement: placement(link) });
    } else if (destinations.has(link.href)) track('outbound_click', { destination: destinations.get(link.href), placement: placement(link) });
  };
  document.addEventListener('click', click);
  document.addEventListener('auxclick', click);
  document.addEventListener('papilot:site-action', event => {
    const { name, data, at } = event.detail || {};
    if (Object.hasOwn(schema, name) && Number.isFinite(at) && at >= collectionStartedAt && at <= performance.now()) track(name, data);
  });
  let wasEnabled = false;
  const sync = () => {
    const active = enabled();
    if (!active) stopMeasuring();
    else if (!wasEnabled) start();
    wasEnabled = active;
  };
  window.addEventListener('papilot:statistics-change', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
})();
