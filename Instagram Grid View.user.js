// ==UserScript==
// @name         Instagram Grid View
// @namespace    jorge.userscripts
// @version      1.1
// @description  Muestra los carruseles de Instagram como cuadrícula (3 por fila) con la info del post arriba
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  /* ================== CONFIG ================== */
  const COLS = 3;               // fotos/vídeos por fila
  const GAP = 8;                // separación en px
  const MAX_WIDTH = 1300;       // ancho máximo del contenido en px
  const CAPTION_MAX_HEIGHT = 80; // altura máxima del caption en px (con scroll si se pasa)
  const ONLY_CAROUSELS = true;  // true: solo posts con varias fotos/vídeos
  /* ============================================ */

  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const cache = new Map();
  const dismissed = new Set();
  let current = null;
  let currentItem = null;
  let token = 0;
  let lastNonPost = null; // última URL que no era de un post (de dónde venimos)
  let postDepth = 0;      // entradas de historial de posts desde esa URL

  /* ---------- estilos ---------- */
  const style = document.createElement('style');
  style.textContent = `
    #igg-overlay{position:fixed;inset:0;z-index:2147483000;background:#0c1014;color:#f5f5f5;
      overflow-y:auto;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    #igg-wrap{max-width:${MAX_WIDTH}px;margin:0 auto;padding:20px 16px 60px}
    #igg-head{display:flex;gap:16px;align-items:flex-start;background:#171b20;border:1px solid #2a3037;
      border-radius:12px;padding:16px 18px;margin-bottom:${GAP * 2}px}
    #igg-head .igg-av img{width:56px;height:56px;border-radius:50%;object-fit:cover;display:block}
    #igg-head .igg-info{flex:1;min-width:0}
    #igg-head .igg-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    #igg-head a{color:inherit;text-decoration:none}
    #igg-head a:hover{text-decoration:underline}
    #igg-head .igg-user{font-weight:700;font-size:16px}
    #igg-head .igg-v{color:#0095f6;font-size:13px}
    #igg-head .igg-date,#igg-head .igg-loc{color:#a8a8a8;font-size:13px}
    #igg-head .igg-cap{margin-top:8px;font-size:14px;line-height:1.45;white-space:pre-wrap;
      word-break:break-word;max-height:${CAPTION_MAX_HEIGHT}px;overflow-y:auto}
    #igg-head .igg-cap a{color:#e0f1ff}
    #igg-head .igg-bar{margin-top:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    #igg-head .igg-act{display:inline-flex;align-items:center;gap:6px;background:none;border:0;color:#f5f5f5;
      font-size:14px;font-weight:600;padding:6px 8px;border-radius:8px;cursor:pointer}
    #igg-head .igg-act:hover{background:#262c33}
    #igg-head .igg-act.static{cursor:default}
    #igg-head .igg-act.static:hover{background:none}
    #igg-head .igg-act svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;
      stroke-linecap:round;stroke-linejoin:round}
    #igg-head .igg-act.like.on{color:#ff3040}
    #igg-head .igg-act.like.on svg,#igg-head .igg-act.save.on svg{fill:currentColor}
    #igg-head .igg-count{margin-left:auto;font-size:13px;color:#a8a8a8}
    #igg-head .igg-actions{display:flex;gap:8px;align-items:center}
    #igg-head .igg-btn{background:#262c33;color:#fff;border:0;border-radius:8px;padding:7px 12px;
      font-size:13px;cursor:pointer;text-decoration:none}
    #igg-head .igg-btn:hover{background:#343c45;text-decoration:none}
    .igg-grid{display:flex;flex-direction:column;gap:${GAP}px}
    .igg-row{display:flex;gap:${GAP}px;align-items:flex-start}
    .igg-cell{position:relative;min-width:0;background:#171b20;border-radius:6px;overflow:hidden}
    .igg-cell img,.igg-cell video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
    .igg-cell a{display:block;position:absolute;inset:0}
    #igg-fab{position:fixed;right:18px;bottom:18px;z-index:2147482000;width:44px;height:44px;border-radius:50%;
      border:0;background:#0095f6;color:#fff;font-size:20px;cursor:pointer;display:none;
      box-shadow:0 2px 10px rgba(0,0,0,.5)}
  `;
  document.head.appendChild(style);

  /* ---------- utilidades ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const linkify = (text) =>
    esc(text)
      .replace(/#([\p{L}\p{N}_]+)/gu, '<a href="/explore/tags/$1/">#$1</a>')
      .replace(/@([A-Za-z0-9._]+)/g, '<a href="/$1/">@$1</a>');

  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('es-ES'));

  const shortcodeToId = (sc) => {
    let id = 0n;
    for (const c of sc) id = id * 64n + BigInt(ALPHA.indexOf(c));
    return id.toString();
  };

  const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const ICONS = {
    heart: svg('M12 21s-7.5-4.6-9.6-9.2C.9 8.3 3 4.5 6.7 4.5c2 0 3.5 1 5.3 3 1.8-2 3.3-3 5.3-3 3.7 0 5.8 3.8 4.3 7.3C19.5 16.4 12 21 12 21z'),
    comment: svg('M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z'),
    repost: svg('M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3'),
    save: svg('M6 3h12v18l-6-4.5L6 21V3z'),
  };

  // Etiquetas de los iconos nativos (español / inglés)
  const NATIVE_RE = {
    like: /^(me gusta|like)$/i,
    unlike: /^(ya no me gusta|quitar (el )?me gusta|unlike)$/i,
    save: /^(guardar|save)$/i,
    unsave: /^(suprimir|eliminar|quitar( de guardados| guardado)?|remove|unsave)$/i,
  };

  const labelsOf = (el) => {
    const out = [];
    const al = el.getAttribute('aria-label');
    if (al) out.push(al.trim());
    if (el.tagName.toLowerCase() === 'svg') {
      const t = el.querySelector('title');
      if (t && t.textContent) out.push(t.textContent.trim());
    }
    return out;
  };

  // La barra de acciones nativa es el primer ancestro del icono "Comentar" que
  // contiene a la vez el icono de like (en cualquiera de sus dos estados) y el de
  // guardar. Así se evitan los corazones de los comentarios y se conoce el estado.
  function barByDom() {
    const byLabel = (re) => [...document.querySelectorAll('svg')]
      .filter((sv) => !sv.closest('#igg-overlay') && labelsOf(sv).some((l) => re.test(l)));
    const anchors = byLabel(/^(comentar|comment)$/i);
    const anchor = anchors.find((sv) => sv.closest('[role="dialog"]')) || anchors[0];
    if (!anchor) return null;
    const isLike = (l) => NATIVE_RE.like.test(l) || NATIVE_RE.unlike.test(l);
    const isSave = (l) => NATIVE_RE.save.test(l) || NATIVE_RE.unsave.test(l);
    for (let node = anchor.parentElement; node && node !== document.body; node = node.parentElement) {
      const svgs = [...node.querySelectorAll('svg')].filter((sv) => !sv.closest('#igg-overlay'));
      const like = svgs.find((sv) => labelsOf(sv).some(isLike));
      const save = svgs.find((sv) => labelsOf(sv).some(isSave));
      if (like && save) return { like, save };
    }
    return null;
  }

  // Pulsa el botón nativo de Instagram (like / guardar) según el estado actual.
  // Devuelve 'clicked' | 'already' | null (no se encontró la barra nativa).
  function nativeToggle(wantOn, onAction, offAction) {
    const bar = barByDom();
    if (!bar) {
      console.warn('[IG Grid] No encuentro la barra de acciones nativa');
      return null;
    }
    const sv = onAction === 'like' ? bar.like : bar.save;
    const isOn = labelsOf(sv).some((l) => NATIVE_RE[offAction].test(l));
    if (isOn === wantOn) return 'already';
    (sv.closest('[role="button"], button, a') || sv.parentElement).click();
    return 'clicked';
  }

  /* ---------- versiones de imagen ---------- */
  // Una versión "recortada" lleva el tamaño en `stp` (p1080x1080, s640x640, c0.0...).
  // Las originales no lo llevan. Las URLs van firmadas (`oh=`): no se pueden retocar.
  const SIZE_TOKEN = /[?&]stp=[^&]*_(?:[ps]\d+x\d+|c\d)/;
  const px = (v) => (v.width || 0) * (v.height || 0);
  const hasOriginal = (m) => (m.image_versions2?.candidates || []).some((v) => !SIZE_TOKEN.test(v.url || ''));
  const needsMore = (item) => (item.carousel_media || []).some((m) => m.media_type !== 2 && !hasOriginal(m));

  // Mayor resolución: primero las sin recorte (sin dimensiones = se asume original,
  // salvo que sean mucho más pequeñas que el resto); si no hay, la de más píxeles.
  function bestVersion(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const maxPx = Math.max(...list.map(px));
    const originals = list.filter((v) => !SIZE_TOKEN.test(v.url || '') && (!px(v) || px(v) >= maxPx * 0.5));
    const pool = originals.length ? originals : list;
    return [...pool].sort((x, y) => (px(y) || Infinity) - (px(x) || Infinity))[0];
  }

  /* ---------- datos del post ---------- */
  // Cabeceras como las de la propia web de Instagram.
  function igHeaders() {
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1];
    let claim = null;
    let session = null;
    try { claim = sessionStorage.getItem('www-claim-v2'); } catch (e) { /* sin acceso */ }
    try {
      const v = localStorage.getItem('Session');
      if (v && /^[0-9a-z]{6}:[0-9]+$/.test(v)) session = v.slice(0, 6);
    } catch (e) { /* sin acceso */ }
    const rnd = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    const h = {
      'Accept': '*/*',
      'X-ASBD-ID': '359341',
      'X-IG-App-ID': '936619743392459',
      'X-IG-Max-Touch-Points': String(navigator.maxTouchPoints || 0),
      'X-Requested-With': 'XMLHttpRequest',
      'X-Web-Session-ID': `${session || rnd()}:${rnd()}:${rnd()}`,
    };
    if (claim) h['X-IG-WWW-Claim'] = claim;
    if (csrf) h['X-CSRFToken'] = csrf;
    return h;
  }

  async function fetchInfo(id) {
    const r = await fetch(`https://www.instagram.com/api/v1/media/${id}/info/`, {
      credentials: 'include',
      cache: 'no-store',
      headers: igHeaders(),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.items && j.items[0]) || null;
  }

  // Deshace los escapes de JSON/HTML incrustado: \/  \\/  \u0026  &amp;  &#x3D;  &#61;
  function decodeEscapes(t) {
    return t
      .replace(/\\+\//g, '/')
      .replace(/\\+u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  // La API a veces solo trae versiones de 1080, pero el HTML del post incluye las
  // URLs originales firmadas. Todas las versiones de una foto comparten el nombre
  // de archivo (..._n.jpg), así que se buscan por él y se añaden como candidatas.
  async function enrichFromHtml(code, item) {
    const r = await fetch(`https://www.instagram.com/p/${code}/`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Accept': 'text/html' },
    });
    if (!r.ok) throw new Error('HTML HTTP ' + r.status);
    const text = decodeEscapes(
      (await r.text()) + '\n' + [...document.scripts].map((sc) => sc.textContent || '').join('\n'));
    const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const m of item.carousel_media || []) {
      if (m.media_type === 2 || hasOriginal(m)) continue;
      let base = '';
      try { base = new URL(m.image_versions2.candidates[0].url).pathname.split('/').pop(); } catch (e) { continue; }
      if (!base) continue;
      const re = new RegExp('https://[^"\'\\s<>\\\\]*' + escRe(base) + '[^"\'\\s<>\\\\]*', 'g');
      const urls = [...new Set(text.match(re) || [])].filter((u) => !SIZE_TOKEN.test(u));
      urls.slice(-5).forEach((u) => m.image_versions2.candidates.push({ url: u, width: 0, height: 0 }));
    }
  }

  async function fetchPost(code) {
    if (cache.has(code)) return cache.get(code);
    const item = await fetchInfo(shortcodeToId(code));
    if (item && item.carousel_media && needsMore(item)) {
      try { await enrichFromHtml(code, item); } catch (e) { console.warn('[IG Grid] HTML del post', e); }
    }
    cache.set(code, item || null);
    return item || null;
  }

  /* ---------- UI ---------- */
  function closeOverlay() {
    const ov = document.getElementById('igg-overlay');
    if (ov) ov.remove();
    document.documentElement.style.overflow = '';
  }

  function setFab(visible) {
    let fab = document.getElementById('igg-fab');
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'igg-fab';
      fab.title = 'Ver en cuadrícula';
      fab.textContent = '▦';
      fab.addEventListener('click', () => {
        if (current && currentItem) {
          dismissed.delete(current);
          show(currentItem);
        }
      });
      document.body.appendChild(fab);
    }
    fab.style.display = visible ? 'block' : 'none';
  }

  function dismiss() {
    if (!current) return;
    dismissed.add(current);
    closeOverlay();
    setFab(true);
  }

  // Cerrar: volver a marcadores / perfil de origen, o ir al perfil del autor.
  function leave(username) {
    const saved = !!lastNonPost && /\/saved(\/|$)/.test(lastNonPost);
    const path = (lastNonPost || '').replace(/\?.*$/, '').replace(/\/$/, '');
    const fromProfile = !!username && path === '/' + username;
    const profile = '/' + username + '/';
    closeOverlay();
    setFab(false);
    if ((saved || fromProfile) && postDepth > 0 && history.length > postDepth) {
      history.go(-postDepth);
      return;
    }
    const link = [...document.querySelectorAll('a[href]')]
      .find((a) => !a.closest('#igg-overlay') && a.getAttribute('href') === profile);
    if (link) link.click();
    else location.assign(profile);
  }

  // Busca en lo que la propia página de Instagram ya ha cargado (imágenes y
  // peticiones) una URL firmada de esa misma foto SIN recorte de tamaño.
  function pageOriginal(url) {
    const base = ((url || '').split('?')[0] || '').split('/').pop();
    if (!base) return null;
    const urls = (performance.getEntriesByType?.('resource') || []).map((e) => e.name);
    for (const img of document.querySelectorAll('img')) {
      if (img.closest('#igg-overlay')) continue;
      if (img.currentSrc) urls.push(img.currentSrc);
      (img.getAttribute('srcset') || '').split(',').forEach((x) => urls.push(x.trim().split(/\s+/)[0]));
    }
    const hits = urls.filter((u) => u && u.includes(base) && !SIZE_TOKEN.test(u));
    return hits.length ? hits[hits.length - 1] : null;
  }

  function makeCell(m) {
    const w = m.original_width || 1;
    const h = m.original_height || 1;
    const cell = document.createElement('div');
    cell.className = 'igg-cell';
    cell.style.flex = `${w / h} 1 0`;
    cell.style.aspectRatio = `${w} / ${h}`;

    const cands = m.image_versions2?.candidates || [];
    const best = bestVersion(cands)?.url || '';
    const vidUrl = bestVersion(m.video_versions)?.url;

    if (m.media_type === 2 && vidUrl) {
      const v = document.createElement('video');
      v.src = vidUrl;
      v.poster = best;
      v.controls = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = 'metadata';
      cell.appendChild(v);
      return cell;
    }

    // Orden de intentos (si una URL falla se pasa a la siguiente, así la foto nunca
    // se queda en blanco): la que la página nativa ya cargó, la mejor, y el resto
    // (sin recorte primero, luego de más a menos píxeles).
    const rest = [...cands].sort((x, y) =>
      (SIZE_TOKEN.test(x.url || '') - SIZE_TOKEN.test(y.url || '')) || ((px(y) || Infinity) - (px(x) || Infinity)));
    const urls = [pageOriginal(best), best, ...rest.map((v) => v.url)]
      .filter((u, n, arr) => u && arr.indexOf(u) === n);

    let k = 0;
    const a = document.createElement('a');
    a.href = urls[0] || '';
    a.target = '_blank';
    a.rel = 'noopener';
    const i = document.createElement('img');
    i.loading = 'lazy';
    i.src = urls[0] || '';
    i.addEventListener('error', () => {
      if (k >= urls.length - 1) return;
      k++;
      i.src = urls[k];
      a.href = urls[k];
    });
    a.appendChild(i);
    cell.appendChild(a);
    return cell;
  }

  function show(item) {
    closeOverlay();
    setFab(false);

    const media = item.carousel_media || [];
    const u = item.user || {};
    const repostCount = item.repost_count ?? item.reshare_count ?? null;
    const date = item.taken_at
      ? new Date(item.taken_at * 1000).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })
      : '';

    const ov = document.createElement('div');
    ov.id = 'igg-overlay';

    const wrap = document.createElement('div');
    wrap.id = 'igg-wrap';

    const head = document.createElement('div');
    head.id = 'igg-head';
    head.innerHTML = `
      <a class="igg-av" href="/${esc(u.username)}/"><img src="${esc(u.profile_pic_url)}" alt=""></a>
      <div class="igg-info">
        <div class="igg-top">
          <a class="igg-user" href="/${esc(u.username)}/">${esc(u.username)}</a>
          ${u.is_verified ? '<span class="igg-v">✔</span>' : ''}
          <span class="igg-date">${esc(date)}</span>
        </div>
        ${item.location ? `<div class="igg-loc">📍 ${esc(item.location.name)}</div>` : ''}
        <div class="igg-cap">${linkify(item.caption?.text || '')}</div>
        <div class="igg-bar">
          <button class="igg-act like" title="Me gusta">${ICONS.heart}<span class="n"></span></button>
          <button class="igg-act comment" title="Ver comentarios (cierra la cuadrícula)">${ICONS.comment}<span>${fmt(item.comment_count)}</span></button>
          ${repostCount != null ? `<span class="igg-act static" title="Reposts">${ICONS.repost}<span>${fmt(repostCount)}</span></span>` : ''}
          <button class="igg-act save" title="Guardar">${ICONS.save}</button>
          <span class="igg-count">🖼 ${media.length}</span>
        </div>
      </div>
      <div class="igg-actions">
        <button class="igg-btn" id="igg-close" title="Cerrar (Esc)">✕ Cerrar</button>
      </div>`;
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'igg-grid';
    for (let i = 0; i < media.length; i += COLS) {
      const chunk = media.slice(i, i + COLS);
      const row = document.createElement('div');
      row.className = 'igg-row';
      if (chunk.length < COLS) {
        // fila incompleta: mismo tamaño de celda que las filas completas
        row.style.width = `calc((100% - ${(COLS - 1) * GAP}px) * ${chunk.length / COLS} + ${(chunk.length - 1) * GAP}px)`;
      }
      chunk.forEach((m) => row.appendChild(makeCell(m)));
      grid.appendChild(row);
    }
    wrap.appendChild(grid);

    ov.appendChild(wrap);
    document.body.appendChild(ov);
    document.documentElement.style.overflow = 'hidden';
    head.querySelector('#igg-close').addEventListener('click', () => leave(u.username));

    /* ---- interacciones ---- */
    const likeBtn = head.querySelector('.igg-act.like');
    const saveBtn = head.querySelector('.igg-act.save');

    const renderBar = () => {
      likeBtn.classList.toggle('on', !!item.has_liked);
      likeBtn.querySelector('.n').textContent = fmt(item.like_count);
      saveBtn.classList.toggle('on', !!item.has_viewer_saved);
    };
    renderBar();

    likeBtn.addEventListener('click', async () => {
      const was = !!item.has_liked;
      const delta = was ? -1 : 1;
      item.has_liked = !was;
      if (item.like_count != null) item.like_count += delta;
      renderBar();
      try {
        if (!nativeToggle(!was, 'like', 'unlike')) throw new Error('botón nativo no encontrado');
      } catch (e) {
        console.warn('[IG Grid] like', e);
        item.has_liked = was;
        if (item.like_count != null) item.like_count -= delta;
        renderBar();
      }
    });

    saveBtn.addEventListener('click', async () => {
      const was = !!item.has_viewer_saved;
      item.has_viewer_saved = !was;
      renderBar();
      try {
        if (!nativeToggle(!was, 'save', 'unsave')) throw new Error('botón nativo no encontrado');
      } catch (e) {
        console.warn('[IG Grid] save', e);
        item.has_viewer_saved = was;
        renderBar();
      }
    });

    head.querySelector('.igg-act.comment').addEventListener('click', dismiss);
  }

  /* ---------- detección de post (SPA) ---------- */
  async function tick() {
    const m = location.pathname.match(/^\/(?:[^/]+\/)?p\/([A-Za-z0-9_-]+)/);
    const code = m ? m[1] : null;
    if (!code) lastNonPost = location.pathname + location.search;
    if (code === current) return;
    if (code) postDepth++; else postDepth = 0;

    current = code;
    currentItem = null;
    const my = ++token;
    closeOverlay();
    setFab(false);
    if (!code) return;

    try {
      const item = await fetchPost(code);
      if (my !== token || !item) return;
      if (ONLY_CAROUSELS && !item.carousel_media) return;
      currentItem = item;
      if (dismissed.has(code)) setFab(true);
      else show(item);
    } catch (e) {
      console.warn('[IG Grid]', e);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('igg-overlay')) leave(currentItem?.user?.username);
  });

  setInterval(tick, 400);
  tick();
})();