// Applies the saved theme before the page paints, so there is no flash of the wrong colours.
(function () {
  try {
    var t = localStorage.getItem('ledgerly.theme') || 'system';
    if (t === 'system') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) { /* storage disabled — fall back to the light theme */ }
})();
