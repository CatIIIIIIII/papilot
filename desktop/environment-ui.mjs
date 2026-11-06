const api = window.papilotEnvironment, $ = id => document.getElementById(id);
const zh = navigator.language.startsWith('zh'), text = (en, cn) => zh ? cn : en;
document.documentElement.lang = zh ? 'zh-CN' : 'en';
for (const element of document.querySelectorAll('[data-en]')) element.textContent = zh ? element.dataset.zh : element.dataset.en;
let discovering = true, checking = false, preparing = false, opening = false, report = null, generation = 0;
let startupError = '', failedEnvironment = null, discoveryError = '';
const choice = () => document.querySelector('input[name=environment]:checked').value;
const value = () => choice() === 'wsl' ? { kind: 'wsl', distribution: $('distribution').value } : { kind: 'native' };
const status = (message = '', error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
const startupFailure = (selected = value()) => !failedEnvironment || selected.kind === failedEnvironment.kind
  && (selected.kind === 'native' || !selected.distribution || selected.distribution === failedEnvironment.distribution) ? startupError : '';
function render() {
  const linux = choice() === 'wsl', available = Boolean($('distribution').value), busy = discovering || preparing || opening;
  $('wsl').hidden = !linux;
  $('distribution-row').hidden = !available;
  $('install-wsl').hidden = !linux || available || discovering;
  $('checks').hidden = linux && !available;
  $('checks').setAttribute('aria-busy', String(checking || discovering));
  $('agent-note').hidden = !report;
  $('refresh').disabled = busy;
  $('distribution').disabled = busy;
  for (const radio of document.querySelectorAll('input[name=environment]')) radio.disabled = busy;
  $('cancel').hidden = !preparing;
  $('prepare').hidden = !linux || Boolean(report?.prepared);
  $('prepare').disabled = busy || checking || !available || !report?.canPrepare;
  $('prepare').textContent = preparing ? text('Preparing…', '正在准备…') : text('Prepare WSL', '准备 WSL 环境');
  $('continue').hidden = linux && !report?.prepared;
  $('continue').disabled = busy || checking || !report || linux && !report.canPrepare;
  const missing = report?.checks.some(check => !check.ready);
  $('continue').textContent = opening ? text('Opening…', '正在打开…') : startupFailure() ? text('Retry Papilot', '重试启动') : missing ? text('Explore the demo', '先体验示例论文') : text('Open Papilot', '打开 Papilot');
  $('footer-note').textContent = linux && report && !report.canPrepare
    ? text('Install Linux Node.js and npm to prepare this environment.', '先安装 Linux 版 Node.js 与 npm，才能准备此环境。')
    : startupFailure()
    ? text('Retry after fixing the startup error, or choose another environment.', '解决启动问题后重试，或选择其他环境。')
    : missing
    ? text('Git and TeX are needed to edit and compile. You can still explore the demo.', '编辑和编译需要 Git 与 TeX。你仍可先查看示例论文。')
    : text('You can switch later in Settings. Papers and sign-ins stay separate.', '之后可在设置中切换。论文与登录状态各自保留。');
}
function showChecks() {
  $('checks').replaceChildren();
  const linux = choice() === 'wsl';
  const labels = { node: text('Node.js & npm', 'Node.js 与 npm'), git: 'Git', tex: 'LaTeX' };
  const guidance = {
    node: text('Install Linux Node.js LTS (22.22+) with npm in this distribution.', '在该发行版中安装 Linux 版 Node.js LTS（22.22+，含 npm）。'),
    git: linux ? text('Install Git inside this Linux distribution.', '在该 Linux 发行版内安装 Git。') : text('Install Git for Windows, then check again.', '安装 Git for Windows，然后重新检测。'),
    tex: linux ? text('Install TeX Live, including latexmk and SyncTeX.', '安装 TeX Live，并包含 latexmk 与 SyncTeX。') : text('Recommended: TeX Live for Windows, including latexmk.', '推荐 TeX Live Windows 版，包含 latexmk。'),
  };
  for (const check of report?.checks || ['node', 'git', 'tex'].map(id => ({ id, ready: false }))) {
    const row = document.createElement('div'); row.className = 'check ' + (!report ? 'loading' : check.ready ? 'ready' : 'missing'); row.dataset.check = check.id;
    const symbol = document.createElement('span'); symbol.className = 'check-symbol'; symbol.setAttribute('aria-hidden', 'true'); symbol.textContent = !report ? '·' : check.ready ? '✓' : '↓';
    const content = document.createElement('div'); content.className = 'check-content';
    const title = document.createElement('div'); title.className = 'check-title'; title.textContent = labels[check.id];
    const detail = document.createElement('div'); detail.className = 'check-detail';
    detail.textContent = !report ? checking || discovering ? text('Checking…', '正在检测…') : text('Not checked. Try checking again.', '尚未完成检测，请重试。') : check.ready
      ? check.detail === 'bundled' ? text('Included with Papilot', 'Papilot 已随附') : check.detail || text('Tools found', '已检测到所需工具')
      : guidance[check.id] + (check.id === 'tex' && check.detail ? text(' Missing: ', ' 缺少：') + check.detail : '');
    content.append(title, detail); row.append(symbol, content);
    if (report && !check.ready) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
      button.textContent = text('Install guide ↗', '安装指南 ↗'); button.setAttribute('aria-label', text('Install ', '安装 ') + labels[check.id]);
      button.onclick = () => openHelp(check.id === 'node' ? 'node' : check.id === 'git' ? linux ? 'gitLinux' : 'gitWindows' : linux ? 'texLinux' : 'texWindows');
      row.append(button);
    } else { const state = document.createElement('span'); state.className = 'check-state'; state.textContent = report ? text('Ready', '就绪') : ''; row.append(state); }
    $('checks').append(row);
  }
}
async function check() {
  const ticket = ++generation, selected = value(), failure = startupFailure(selected);
  report = null; checking = true;
  // Missing WSL uses the install card; a failed backend must retain its reason.
  const message = failure || (selected.kind === 'wsl' && selected.distribution ? discoveryError : '');
  status(message, Boolean(message));
  showChecks(); render();
  $('check-summary').textContent = text('Checking your tools…', '正在检查所需工具…');
  if (selected.kind === 'wsl' && !selected.distribution) {
    checking = false; $('check-summary').textContent = text('No Linux distribution detected.', '尚未检测到 Linux 发行版。'); render(); return;
  }
  try {
    const result = await api.inspect(selected);
    if (ticket !== generation) return;
    report = result;
    const missing = report.checks.filter(item => !item.ready).length;
    $('check-summary').textContent = failure ? text('Papilot could not start in this environment.', 'Papilot 未能在此环境中启动。') : missing
      ? text(`${missing} ${missing === 1 ? 'tool needs' : 'tools need'} attention. Follow the guides below.`, `还需准备 ${missing} 项工具，请按下方指引安装。`)
      : report.prepared ? text('Everything is ready for your workspace.', '环境已就绪，可以打开工作区。') : text('Tools are ready. Prepare Papilot to continue.', '所需工具已就绪，准备 Papilot 后即可继续。');
  } catch (error) {
    if (ticket !== generation) return;
    $('check-summary').textContent = text('Could not finish the check.', '暂时无法完成检测。'); status([failure, error.message].filter(Boolean).join('\n'), true);
  } finally { if (ticket === generation) { checking = false; showChecks(); render(); } }
}
async function refresh(first = false) {
  ++generation; discovering = true; report = null; render(); showChecks(); status();
  $('check-summary').textContent = text('Looking for available environments…', '正在查找可用环境…');
  const previous = $('distribution').value;
  try {
    const info = await api.info();
    startupError = info.startupError || ''; failedEnvironment = info.current; discoveryError = info.discoveryError || '';
    $('distribution').replaceChildren(...info.distributions.map(name => new Option(name, name)));
    const preferred = first && info.current?.kind === 'wsl' ? info.current.distribution : previous;
    if (info.distributions.includes(preferred)) $('distribution').value = preferred;
    else $('distribution').value = info.distributions.find(name => /ubuntu/i.test(name)) || info.distributions[0] || '';
    if (first && info.current) document.querySelector(`input[value=${info.current.kind}]`).checked = true;
    discovering = false; await check();
  } catch (error) { discovering = false; checking = false; $('check-summary').textContent = text('Could not check this computer.', '暂时无法检测此电脑。'); status(error.message, true); }
  finally { render(); }
}
async function openHelp(key) { try { await api.help(key); } catch (error) { status(error.message, true); } }
for (const radio of document.querySelectorAll('input[name=environment]')) radio.addEventListener('change', () => { $('output').hidden = true; void check(); });
$('distribution').addEventListener('change', () => { $('output').hidden = true; void check(); });
$('refresh').onclick = () => refresh();
$('help').onclick = () => openHelp('wsl');
$('copy-install').onclick = async () => { try { await api.copyInstall(); $('copy-install').textContent = text('Copied', '已复制'); } catch (error) { status(error.message, true); } };
$('cancel').onclick = async () => { try { await api.cancel(); } catch (error) { status(error.message, true); } };
api.onProgress(chunk => { $('log').textContent = ($('log').textContent + chunk).slice(-12000); $('log').scrollTop = $('log').scrollHeight; });
$('prepare').onclick = async () => {
  preparing = true; $('output').hidden = false; $('output').open = false; $('log').textContent = ''; render();
  status(text('Preparing Papilot in Linux. The first download may take a few minutes.', '正在 Linux 中准备 Papilot，首次下载可能需要几分钟。'));
  try { await api.prepare($('distribution').value); preparing = false; await check(); }
  catch (error) { status(error.message, true); $('output').open = true; }
  finally { preparing = false; render(); }
};
$('form').onsubmit = async event => {
  event.preventDefault(); if ($('continue').hidden || $('continue').disabled) return;
  opening = true; render(); status();
  try { await api.apply(value()); }
  catch (error) { status(error.message, true); opening = false; render(); }
};
void refresh(true);
