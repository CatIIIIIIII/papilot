// Browser-local choices only. This file never loads a provider or sends data.
(() => {
  const configured = document.currentScript.dataset.enabled === 'true';
  const key = 'papilot-statistics-disabled', legacyKey = 'papilot-statistics-consent';
  let writeFailed = false, memoryChoice = null;
  let channel;
  try { channel = new BroadcastChannel('papilot-statistics-preferences'); } catch {}
  const state = () => {
    const browserOptOut = navigator.globalPrivacyControl === true || [navigator.doNotTrack, window.doNotTrack].includes('1');
    try {
      const choice = localStorage.getItem(key);
      let legacyDenied = false;
      try { legacyDenied = JSON.parse(localStorage.getItem(legacyKey))?.choice === 'denied'; } catch {}
      // A previous refusal is preserved, even after its old consent expiry.
      const providerOptOut = !!localStorage.getItem('umami.disabled');
      const optedOut = (memoryChoice ?? (choice === 'true' || (choice !== 'false' && legacyDenied))) || providerOptOut;
      return { enabled: configured && !optedOut && !browserOptOut && !writeFailed, optedOut, browserOptOut: browserOptOut || providerOptOut, unavailable: writeFailed };
    } catch { return { enabled: false, optedOut: true, browserOptOut, unavailable: true }; }
  };
  const controls = document.getElementById('statistics-privacy-controls');
  const render = () => {
    if (!controls || !configured) return;
    const current = state();
    controls.hidden = false;
    document.getElementById('statistics-status').textContent = current.unavailable
      ? 'Statistics are off because this browser cannot save your choice. / 无法保存浏览器偏好，统计已关闭。'
      : current.browserOptOut
        ? 'Statistics are off because of your browser privacy setting. / 统计已按浏览器隐私设置关闭。'
        : current.enabled
          ? 'Statistics are on for this browser. / 当前浏览器已开启网站统计。'
          : 'Statistics are off for this browser. / 当前浏览器已关闭网站统计。';
    const disable = document.getElementById('statistics-disable');
    const enable = document.getElementById('statistics-enable');
    disable.hidden = !current.enabled;
    enable.hidden = current.enabled;
    enable.disabled = current.browserOptOut || current.unavailable;
  };
  const notify = () => { render(); window.dispatchEvent(new Event('papilot:statistics-change')); };
  const choose = disabled => {
    memoryChoice = disabled;
    try {
      localStorage.setItem(key, String(disabled));
      writeFailed = false;
      try { localStorage.removeItem(legacyKey); } catch {}
    } catch { writeFailed = true; memoryChoice = true; }
    channel?.postMessage({ disabled: memoryChoice });
    notify();
  };
  window.papilotStatistics = Object.freeze({ enabled: () => state().enabled });
  document.getElementById('statistics-disable')?.addEventListener('click', () => choose(true));
  document.getElementById('statistics-enable')?.addEventListener('click', () => choose(false));
  window.addEventListener('storage', event => {
    if ([null, key, legacyKey, 'umami.disabled'].includes(event.key)) { memoryChoice = null; notify(); }
  });
  if (channel) channel.onmessage = event => {
    if (typeof event.data?.disabled === 'boolean') { memoryChoice = event.data.disabled; notify(); }
  };
  document.addEventListener('visibilitychange', notify);
  render();
})();
