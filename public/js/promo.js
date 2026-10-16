(function () {
  function $(id) { return document.getElementById(id); }

  function injectStyles() {
    if ($('promo-styles')) return;
    const s = document.createElement('style');
    s.id = 'promo-styles';
    s.textContent = `
      #promo-sale-bar, #promo-announce-bar {
        position: fixed;
        left: 0;
        right: 0;
        overflow: hidden;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        padding: 0.55rem 1rem;
        font-weight: 700;
        font-size: 0.9rem;
        z-index: 110;
        text-align: center;
        box-sizing: border-box;
      }
      #promo-sale-bar.show, #promo-announce-bar.show { display: flex; }
      #promo-sale-bar .promo-bar-text, #promo-announce-bar .promo-bar-text {
        position: relative; z-index: 2;
      }
      #promo-sale-bar .promo-claim {
        position: relative; z-index: 2;
        background: rgba(255,255,255,0.22);
        border: 1px solid rgba(255,255,255,0.45);
        color: inherit;
        font-weight: 800;
        font-size: 0.82rem;
        padding: 0.35rem 0.85rem;
        border-radius: 999px;
        text-decoration: none;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
      }
      #promo-sale-bar .promo-claim:hover {
        background: rgba(255,255,255,0.35);
      }
      /* Announce bar has NO claim button */
      #promo-announce-bar .promo-claim { display: none !important; }
      .promo-bar-canvas {
        position: absolute; inset: 0; width: 100%; height: 100%;
        pointer-events: none; z-index: 1;
      }
      #newuser-popup-overlay {
        display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.5);
        z-index: 2000; align-items: center; justify-content: center; padding: 1rem;
        backdrop-filter: blur(4px);
      }
      #newuser-popup-overlay.show { display: flex; }
      #newuser-popup {
        background: #fff; border-radius: 16px; padding: 1.75rem; max-width: 400px; width: 100%;
        text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.2);
      }
      #newuser-popup h2 { margin: 0 0 0.5rem; font-size: 1.35rem; }
      #newuser-popup p { color: #475569; margin: 0 0 1.25rem; }
      #newuser-popup .nu-actions { display: flex; gap: 0.6rem; justify-content: center; flex-wrap: wrap; }
      #newuser-popup button {
        border: none; border-radius: 10px; padding: 0.7rem 1.25rem; font-weight: 700;
        cursor: pointer; font-family: inherit; font-size: 0.95rem;
      }
      #newuser-popup .nu-claim { background: linear-gradient(135deg,#06b6d4,#0891b2); color: #fff; }
      #newuser-popup .nu-cancel { background: #f1f5f9; color: #334155; }
    `;
    document.head.appendChild(s);
  }

  function ensureBar(id, withClaim) {
    let el = $(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    if (withClaim) {
      el.innerHTML = '<canvas class="promo-bar-canvas"></canvas><span class="promo-bar-text"></span><a class="promo-claim" href="#">Claim Now</a>';
    } else {
      el.innerHTML = '<canvas class="promo-bar-canvas"></canvas><span class="promo-bar-text"></span>';
    }
    // Append to body so fixed positioning works cleanly
    document.body.appendChild(el);
    return el;
  }

  const animLoops = {};

  function stopBarAnim(barId) {
    if (animLoops[barId]) {
      cancelAnimationFrame(animLoops[barId]);
      delete animLoops[barId];
    }
  }

  function startBarAnim(bar, type) {
    stopBarAnim(bar.id);
    const canvas = bar.querySelector('canvas');
    if (!canvas || !type || type === 'none') {
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    const ctx = canvas.getContext('2d');
    function resize() {
      canvas.width = bar.clientWidth || 300;
      canvas.height = bar.clientHeight || 40;
    }
    resize();
    const n = 28;
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 1.5 + Math.random() * 2.5,
        vy: 0.3 + Math.random() * 1.2,
        vx: (Math.random() - 0.5) * 0.8,
        c: Math.random()
      });
    }
    function colorFor(t, p) {
      if (t === 'confetti' || t === 'rainbow' || t === 'emoji') return 'hsl(' + ((p.c * 360) | 0) + ',80%,65%)';
      const map = {
        snow: 'rgba(255,255,255,0.9)', rain: 'rgba(125,211,252,0.85)', leaves: '#f59e0b',
        hearts: '#f43f5e', stars: '#fbbf24', bubbles: '#67e8f9', sakura: '#f9a8d4',
        autumn: '#ea580c', sparkle: '#e2e8f0', fireflies: '#fde047', matrix: '#22c55e',
        ash: '#94a3b8', coins: '#eab308', gifts: '#a78bfa', petals: '#fb7185',
        aurora: '#34d399', ice: '#a5f3fc', neon: '#22d3ee', glitter: '#f5d0fe'
      };
      return map[t] || 'rgba(255,255,255,0.75)';
    }
    function draw() {
      resize();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.y += p.vy;
        p.x += p.vx;
        if (p.y > canvas.height) { p.y = -4; p.x = Math.random() * canvas.width; }
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        ctx.fillStyle = colorFor(type, p);
        if (type === 'hearts') {
          ctx.font = (p.r * 4) + 'px serif';
          ctx.fillText('❤', p.x, p.y);
        } else if (type === 'stars') {
          ctx.font = (p.r * 4) + 'px serif';
          ctx.fillText('✦', p.x, p.y);
        } else if (type === 'emoji') {
          const em = ['❄','🎁','⭐','✨'][(p.c * 4) | 0];
          ctx.font = (p.r * 5) + 'px serif';
          ctx.fillText(em, p.x, p.y);
        } else if (type === 'snow' || type === 'bubbles' || type === 'sparkle') {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      animLoops[bar.id] = requestAnimationFrame(draw);
    }
    draw();
  }

  function claimHref(settings, pageIdKey, linkKey, pages) {
    const pageId = settings[pageIdKey];
    if (pageId && pages && pages.length) {
      const p = pages.find(x => x.id === pageId);
      if (p) return '/page.html?id=' + encodeURIComponent(p.id);
    }
    const link = (settings[linkKey] || '').trim();
    if (link) return link;
    return '/';
  }

  function layoutBars() {
    const saleBar = $('promo-sale-bar');
    const annBar = $('promo-announce-bar');
    const nav = document.querySelector('nav');
    let offset = 0;

    if (saleBar && saleBar.classList.contains('show')) {
      saleBar.style.top = offset + 'px';
      offset += saleBar.offsetHeight || 40;
    }
    if (annBar && annBar.classList.contains('show')) {
      annBar.style.top = offset + 'px';
      offset += annBar.offsetHeight || 40;
    }

    // Push fixed nav down so it sits under the promo bars
    if (nav) {
      nav.style.top = offset + 'px';
    }
    // Compensate content for the promo bars height
    document.body.style.paddingTop = offset + 'px';
  }

  function renderPromo(settings, pages) {
    injectStyles();
    const s = settings || {};
    pages = pages || [];

    // SALE bar (only if enabled AND topbar not explicitly disabled)
    const saleBar = ensureBar('promo-sale-bar', true);
    const showSaleTopbar = s.saleEnabled && (s.saleShowTopbar !== false && s.saleShowTopbar !== 'false');
    if (showSaleTopbar) {
      const text = s.saleTopbarText || s.saleBannerText ||
        ((s.saleTitle || 'Sale') + (s.saleDiscountPercent ? ' — ' + s.saleDiscountPercent + '% OFF' : ''));
      saleBar.querySelector('.promo-bar-text').textContent = text;
      saleBar.style.background = s.saleTopbarBg || s.saleBannerBg || '#0891b2';
      saleBar.style.color = s.saleTopbarFontColor || s.saleFontColor || '#ffffff';
      saleBar.style.fontFamily = s.saleFont || 'inherit';
      saleBar.style.fontSize = s.saleFontSize || '0.9rem';
      const claim = saleBar.querySelector('.promo-claim');
      if (claim) {
        claim.textContent = s.saleClaimText || 'Claim Now';
        claim.href = claimHref(s, 'saleClaimPageId', 'saleClaimLink', pages);
        claim.style.display = '';
      }
      saleBar.classList.add('show');
      startBarAnim(saleBar, s.saleAnimation || 'none');
    } else {
      saleBar.classList.remove('show');
      stopBarAnim('promo-sale-bar');
    }

    // ANNOUNCE bar — no Claim Now button
    const annBar = ensureBar('promo-announce-bar', false);
    // Respect schedule if set
    let announceOk = s.announceEnabled && s.announceText;
    if (announceOk) {
      const now = Date.now();
      if (s.announceStartAt) {
        const st = new Date(s.announceStartAt).getTime();
        if (!isNaN(st) && now < st) announceOk = false;
      }
      if (s.announceEndAt) {
        const en = new Date(s.announceEndAt).getTime();
        if (!isNaN(en) && now > en) announceOk = false;
      }
    }
    if (announceOk) {
      annBar.querySelector('.promo-bar-text').textContent = s.announceText;
      annBar.style.background = s.announceBg || '#0e7490';
      annBar.style.color = s.announceFontColor || '#ffffff';
      annBar.style.fontFamily = s.announceFont || 'inherit';
      annBar.style.fontSize = s.announceFontSize || '0.9rem';
      // Ensure no claim button exists
      const oldClaim = annBar.querySelector('.promo-claim');
      if (oldClaim) oldClaim.remove();
      annBar.classList.add('show');
      startBarAnim(annBar, s.announceAnimation || 'none');
    } else {
      annBar.classList.remove('show');
      stopBarAnim('promo-announce-bar');
    }

    // Position bars + push nav/content down
    requestAnimationFrame(function () {
      layoutBars();
      setTimeout(layoutBars, 50);
    });
  }

  function showNewUserPopup(settings, firstPageUrl) {
    if (!settings || !settings.newUserEnabled) return;
    if (sessionStorage.getItem('nu_popup_seen')) return;
    injectStyles();
    let ov = $('newuser-popup-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'newuser-popup-overlay';
      ov.innerHTML = '<div id="newuser-popup"><h2 id="nu-title"></h2><p id="nu-text"></p><div class="nu-actions">' +
        '<button type="button" class="nu-claim" id="nu-claim">Claim Now</button>' +
        '<button type="button" class="nu-cancel" id="nu-cancel">Cancel</button></div></div>';
      document.body.appendChild(ov);
    }
    $('nu-title').textContent = settings.newUserPopupTitle || 'Claim your new user discount!';
    $('nu-text').textContent = settings.newUserPopupText ||
      ('Get ' + (settings.newUserPercent || 0) + '% off on your first order.');
    ov.classList.add('show');
    sessionStorage.setItem('nu_popup_seen', '1');
    $('nu-cancel').onclick = function () { ov.classList.remove('show'); };
    ov.onclick = function (e) { if (e.target === ov) ov.classList.remove('show'); };
    $('nu-claim').onclick = function () {
      ov.classList.remove('show');
      location.href = firstPageUrl || '/';
    };
  }

  window.StorePromo = { apply: renderPromo, showNewUser: showNewUserPopup };

  async function boot() {
    try {
      const r = await fetch('/api/settings');
      const d = await r.json();
      if (!d.success) return;
      let pages = [];
      try {
        const pr = await fetch('/api/pages');
        const pd = await pr.json();
        if (pd.success) pages = pd.pages || [];
      } catch (e) {}
      renderPromo(d.settings, pages);
      if (sessionStorage.getItem('just_registered') === '1') {
        sessionStorage.removeItem('just_registered');
        let firstPage = '/';
        if (pages[0]) firstPage = '/page.html?id=' + encodeURIComponent(pages[0].id);
        showNewUserPopup(d.settings, firstPage);
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Re-layout on resize
  window.addEventListener('resize', function () {
    if ($('promo-sale-bar') || $('promo-announce-bar')) layoutBars();
  });
})();
