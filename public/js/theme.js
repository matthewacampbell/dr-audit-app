// Runs before the page paints so there's no flash of the wrong theme.
(function () {
  try {
    document.documentElement.setAttribute('data-bs-theme', localStorage.getItem('theme') || 'dark');
  } catch (e) {}
})();
