// 1) Company form: add / remove contact rows.
// 2) Audit page: paste a screenshot straight from the clipboard.
(function () {
  // ---------- contact rows ----------
  function addContactRow() {
    var tpl = document.getElementById('contact-row-template');
    var wrap = document.getElementById('contact-rows');
    if (!tpl || !wrap) return null;
    wrap.appendChild(tpl.content.cloneNode(true));
    return wrap.lastElementChild;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-add-contact]')) {
      var row = addContactRow();
      if (row) { var first = row.querySelector('input[type="text"]'); if (first) first.focus(); }
      return;
    }
    var remove = e.target.closest('[data-remove-contact]');
    if (remove) {
      var wrap = document.getElementById('contact-rows');
      remove.closest('.contact-row').remove();
      if (wrap && !wrap.querySelector('.contact-row')) addContactRow(); // always keep one row
    }
  });

  // ---------- paste screenshots ----------
  var activeZone = null;
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  function setStatus(zone, text, isError) {
    var el = zone.querySelector('.paste-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('text-danger', !!isError);
  }

  function upload(zone, file) {
    var fd = new FormData();
    fd.append('screenshot', file, file.name || 'screenshot.png');
    var targetId = zone.getAttribute('data-target');
    var kind = zone.getAttribute('data-kind');
    zone.classList.add('is-uploading');
    setStatus(zone, 'Uploading\u2026');

    fetch(zone.getAttribute('data-url'), {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrf, 'HX-Request': 'true' },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Upload failed (' + r.status + ')');
        return r.text();
      })
      .then(function (html) {
        var old = document.getElementById(targetId);
        if (!old) return;
        old.outerHTML = html; // the server sends back the refreshed device card
        var fresh = document.getElementById(targetId);
        if (window.htmx) window.htmx.process(fresh);
        var again = fresh.querySelector('.paste-zone[data-kind="' + kind + '"]');
        if (again) { activeZone = again; again.focus(); } // ready for the next paste
      })
      .catch(function (err) {
        zone.classList.remove('is-uploading');
        setStatus(zone, err.message, true);
      });
  }

  document.addEventListener('focusin', function (e) {
    var zone = e.target.closest && e.target.closest('.paste-zone');
    if (zone) activeZone = zone;
  });

  document.addEventListener('click', function (e) {
    var zone = e.target.closest('.paste-zone');
    if (!zone) return;
    activeZone = zone;
    if (e.target.closest('[data-choose-file]')) {
      zone.querySelector('.paste-file').click();
    } else {
      zone.focus();
    }
  });

  document.addEventListener('change', function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('.paste-file')) return;
    var zone = input.closest('.paste-zone');
    if (zone && input.files && input.files[0]) upload(zone, input.files[0]);
    input.value = '';
  });

  document.addEventListener('paste', function (e) {
    if (!activeZone || !document.body.contains(activeZone)) return;
    // Don't hijack pasting into ordinary text boxes.
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.closest('.paste-zone')) return;

    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        var file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          upload(activeZone, file);
          return;
        }
      }
    }
    setStatus(activeZone, 'There is no image on the clipboard. Copy a screenshot first.', true);
  });
})();
