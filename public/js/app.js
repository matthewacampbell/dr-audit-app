// Light/dark theme toggle (the moon/sun button in the sidebar).
(function () {
  function apply(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) {}
    document.querySelectorAll('[data-theme-toggle] i').forEach(function (icon) {
      icon.className = theme === 'dark' ? 'bi bi-moon-stars' : 'bi bi-sun';
    });
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest('[data-theme-toggle]')) return;
    var current = document.documentElement.getAttribute('data-bs-theme');
    apply(current === 'dark' ? 'light' : 'dark');
  });

  apply(document.documentElement.getAttribute('data-bs-theme') || 'dark');
})();
