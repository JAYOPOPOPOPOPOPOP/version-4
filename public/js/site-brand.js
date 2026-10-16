/* Site branding: uploaded logo + favicon on EVERY page (nav, login/register, admin sidebar, tab icon) */
(function () {
  function setFavicon(url) {
    if (!url) return;
    document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']").forEach(function (l) { l.parentNode.removeChild(l); });
    var type = /\.svg(\?|$)/i.test(url) ? 'image/svg+xml' : /\.ico(\?|$)/i.test(url) ? 'image/x-icon' : 'image/png';
    ['icon', 'apple-touch-icon'].forEach(function (rel) {
      var l = document.createElement('link');
      l.rel = rel; l.type = type; l.href = url;
      document.head.appendChild(l);
    });
  }

  function makeImg(url, size, extraStyle) {
    var img = document.createElement('img');
    img.className = 'site-brand-logo';
    img.src = url;
    img.alt = '';
    img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px;flex-shrink:0;' + (extraStyle || '');
    img.onerror = function () { img.style.display = 'none'; };
    return img;
  }

  // Replace the leading pickaxe emoji of a link with the logo image
  function swapEmoji(a, url, size) {
    if (!a || a.querySelector('.site-brand-logo') || a.querySelector('#nav-logo-img')) return;
    for (var i = 0; i < a.childNodes.length; i++) {
      var n = a.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.indexOf('⛏') !== -1) {
        n.nodeValue = n.nodeValue.replace(/⛏️?\s*/, '');
        a.insertBefore(makeImg(url, size), n);
        return;
      }
      if (n.nodeType === 1 && n.textContent.trim() === '⛏️') { // emoji in its own span
        a.insertBefore(makeImg(url, size), n);
        n.style.display = 'none';
        return;
      }
    }
  }

  function applyLogo(url) {
    // top navbars (cart, category, product, my-orders, support, page ...)
    document.querySelectorAll('nav > a[href="/"]').forEach(function (a) { swapEmoji(a, url, 28); });
    // admin sidebar brand
    document.querySelectorAll('.sidebar .brand').forEach(function (a) { swapEmoji(a, url, 30); });
    // login / register card
    var card = document.querySelector('body > .card');
    if (card && !card.querySelector('.site-brand-logo')) {
      var h = card.querySelector('h1');
      if (h) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'text-align:center;margin:0 0 1rem;';
        wrap.appendChild(makeImg(url, 64, 'margin-right:0;border-radius:12px;'));
        h.parentNode.insertBefore(wrap, h);
      }
    }
  }

  function run() {
    fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.success || !d.settings) return;
      var s = d.settings;
      setFavicon(s.favicon || s.logo);
      if (s.logo) applyLogo(s.logo);
    }).catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
