// The document and language links work without JavaScript; only the theme toggle needs it.
const button = document.querySelector('.blog-theme');
const system = matchMedia('(prefers-color-scheme: dark)');
const render = () => button?.setAttribute('aria-pressed', String((document.documentElement.dataset.theme || (system.matches ? 'dark' : 'light')) === 'dark'));
if (button) {
  button.hidden = false;
  render();
  button.addEventListener('click', () => {
    const theme = button.getAttribute('aria-pressed') === 'true' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('papilot-theme', theme); } catch {}
    render();
  });
  system.addEventListener('change', render);
  window.addEventListener('storage', event => {
    if (event.key !== 'papilot-theme' && event.key !== null) return;
    if (event.newValue === 'dark' || event.newValue === 'light') document.documentElement.dataset.theme = event.newValue;
    else delete document.documentElement.dataset.theme;
    render();
  });
}

const languages = document.querySelector('.blog-languages');
languages?.addEventListener('keydown', event => {
  if (event.key === 'Escape') { languages.open = false; languages.querySelector('summary').focus(); }
});
document.addEventListener('click', event => {
  if (languages?.open && !languages.contains(event.target)) languages.open = false;
});
for (const link of document.querySelectorAll('.blog-language')) link.addEventListener('click', () => {
  try { localStorage.setItem('papilot-lang', link.hreflang); } catch {}
});
