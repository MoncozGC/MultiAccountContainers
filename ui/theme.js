(function () {
  'use strict';
  const key = 'ui_theme';
  const root = document.documentElement;
  let revision = 0;
  let writes = Promise.resolve();

  function apply(value) {
    const theme = value === 'light' ? 'light' : 'dark';
    root.dataset.theme = theme;
    try { localStorage.setItem(key, theme); } catch {}
    const button = document.getElementById('theme-toggle');
    if (button) {
      const label = theme === 'dark' ? '切换浅色' : '切换深色';
      button.querySelector('.theme-toggle-label').textContent = label;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  // The extension-origin cache applies the saved palette before first paint.
  let cached;
  try { cached = localStorage.getItem(key); } catch {}
  apply(cached);
  document.addEventListener('DOMContentLoaded', () => apply(root.dataset.theme));
  document.addEventListener('click', event => {
    if (!event.target.closest('#theme-toggle')) return;
    revision++;
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(theme);
    writes = writes.then(() => chrome.storage.local.set({ [key]: theme }))
      .catch(error => console.error('[Theme] Could not save preference:', error));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[key]) {
      revision++;
      apply(changes[key].newValue);
    }
  });
  const initialRevision = revision;
  chrome.storage.local.get(key).then(saved => {
    if (revision === initialRevision) apply(saved[key]);
  }).catch(error => console.error('[Theme] Could not load preference:', error));
})();
