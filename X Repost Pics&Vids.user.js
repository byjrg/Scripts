// ==UserScript==
// @name         X Repost Pics&Vids
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Sustituye el botón de compartir por una pluma de pájaro: extrae las imágenes originales (o el mp4 original si es vídeo/GIF) del tweet y los incrusta en el composer modal como si se subieran desde el PC. Reactiva el botón cuando X lo desactiva (cuentas que te bloquean) y corrige su coloración apagada.
// @author       You
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      twimg.com
// @connect      cdn.syndication.twimg.com
// @connect      video.twimg.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        debug: true,
        composerTimeoutMs: 8000
    };

    // Pluma de pájaro (Feather Icons "feather"), a trazo, como los iconos de X
    const FEATHER_SVG = '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></g>';

    function log(...args) {
        if (CONFIG.debug) console.log('[X-RepostMedia]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============================================================
    // CACHÉ DE VÍDEOS: interceptar las respuestas de la API de X
    // ============================================================
    // tweetId -> [{ type: 'video' | 'animated_gif', variants: [...] }]

    const videoCache = new Map();

    const stats = { responses: 0, videos: 0 };

    function addVideo(id, type, variants) {
        if (!id) return;
        const key = (variants[0] && variants[0].url) || '';
        const arr = videoCache.get(id) || [];
        if (!arr.some(e => e.key === key)) {
            arr.push({ key, type, variants });
            videoCache.set(id, arr);
            stats.videos++;
            log('Vídeo cacheado para tweet', id, `(${variants.length} variantes)`);
        }
    }

    // Recorre el JSON recordando el ID del tweet más cercano hacia arriba
    function walk(node, depth, ctxId) {
        if (!node || typeof node !== 'object' || depth > 50) return;

        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1, ctxId);
            return;
        }

        let id = ctxId;
        // Resultado de tweet de GraphQL: rest_id + legacy.full_text
        if (node.rest_id && /^\d+$/.test(node.rest_id) && node.legacy && node.legacy.full_text !== undefined) {
            id = node.rest_id;
        }
        // Objeto legacy de tweet (REST v1.1 o dentro de GraphQL)
        if (node.id_str && /^\d+$/.test(node.id_str) && node.full_text !== undefined) {
            id = node.id_str;
        }

        if (node.video_info && Array.isArray(node.video_info.variants)) {
            addVideo(id, node.type || 'video', node.video_info.variants);
        }

        for (const key in node) {
            const v = node[key];
            if (v && typeof v === 'object') walk(v, depth + 1, id);
        }
    }

    function isApiUrl(url) {
        return /\/i\/api\/|\/graphql\/|\/1\.1\/|\/2\/timeline/.test(String(url || ''));
    }

    function ingest(url, text) {
        if (!isApiUrl(url)) return;
        if (!text || text.charCodeAt(0) !== 123 /* { */) return;
        try {
            stats.responses++;
            walk(JSON.parse(text), 0, null);
        } catch (e) { /* no era JSON útil */ }
    }

    // Hook de fetch
    const origFetch = window.fetch;
    window.fetch = function(...args) {
        const p = origFetch.apply(this, args);
        try {
            const req = args[0];
            const url = typeof req === 'string' ? req : (req && req.url);
            if (url && isApiUrl(url)) {
                p.then(resp => {
                    resp.clone().text().then(t => ingest(url, t)).catch(() => {});
                }).catch(() => {});
            }
        } catch (e) { /* nunca romper X */ }
        return p;
    };

    // Hook de Response.json(): atrapa respuestas aunque X haya guardado una referencia propia a fetch
    try {
        const origJson = Response.prototype.json;
        Response.prototype.json = function() {
            const url = this.url;
            return origJson.apply(this, arguments).then(data => {
                try {
                    if (isApiUrl(url)) { stats.responses++; walk(data, 0, null); }
                } catch (e) { /* ignorar */ }
                return data;
            });
        };
    } catch (e) { log('No pude enganchar Response.json:', e); }

    // Hook de XMLHttpRequest (soporta responseType '', 'text' y 'json')
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        try {
            const xhrUrl = String(url);
            this.addEventListener('load', () => {
                try {
                    if (!isApiUrl(xhrUrl)) return;
                    if (this.responseType === '' || this.responseType === 'text') {
                        ingest(xhrUrl, this.responseText);
                    } else if (this.responseType === 'json' && this.response) {
                        stats.responses++;
                        walk(this.response, 0, null);
                    }
                } catch (e) { /* ignorar */ }
            });
        } catch (e) { /* ignorar */ }
        return origOpen.apply(this, arguments);
    };

    log('Hooks instalados en', location.href);

    // ============================================================
    // EXTRAER MEDIA DE UN TWEET
    // ============================================================

    function getTweetId(article) {
        const timeEl = article.querySelector('a[href*="/status/"] time');
        const a = timeEl ? timeEl.closest('a') : article.querySelector('a[href*="/status/"]');
        const href = a && a.getAttribute('href');
        const m = href && href.match(/\/status\/(\d+)/);
        if (m) return m[1];
        const m2 = location.pathname.match(/\/status\/(\d+)/);
        return m2 ? m2[1] : null;
    }

    function pickBestMp4(variants) {
        const mp4s = variants.filter(v => v.content_type === 'video/mp4' && v.url);
        if (!mp4s.length) return null;
        mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        return mp4s[0].url;
    }

    // Lista de variantes -> lista de URLs mp4 (la mejor de cada vídeo, sin repetidos)
    function bestUrls(variantLists) {
        const urls = [];
        for (const v of variantLists || []) {
            const u = pickBestMp4(v);
            if (u && !urls.includes(u)) urls.push(u);
        }
        return urls;
    }

    function toOriginalImageUrl(src) {
        try {
            const u = new URL(src);
            if (!u.hostname.includes('pbs.twimg.com') || !u.pathname.includes('/media/')) return null;
            u.searchParams.set('name', 'orig');
            if (!u.searchParams.get('format')) u.searchParams.set('format', 'jpg');
            return u.toString();
        } catch (e) {
            return null;
        }
    }

    function collectImagesFromTweet(article) {
        const items = [];
        const imgs = article.querySelectorAll('[data-testid="tweetPhoto"] img');
        for (const img of imgs) {
            const orig = toOriginalImageUrl(img.src);
            if (orig) items.push(orig);
        }
        return items;
    }

    // Fallback: leer los datos del tweet desde las props de React del propio <article>
    function findVariantsInFiber(article) {
        try {
            const fkey = Object.keys(article).find(k => k.startsWith('__reactFiber$'));
            if (!fkey) return null;
            const seen = new WeakSet();
            const found = [];
            let budget = 20000;

            function search(node, depth) {
                if (!node || typeof node !== 'object' || depth > 12 || budget-- <= 0) return null;
                if (seen.has(node)) return null;
                seen.add(node);
                if (node.$$typeof || node.nodeType) return null;
                if (node.video_info && Array.isArray(node.video_info.variants)) { found.push(node.video_info.variants); return null; }
                for (const k in node) {
                    if (k === '_owner' || k === 'children') continue;
                    let v;
                    try { v = node[k]; } catch (e) { continue; }
                    if (v && typeof v === 'object') {
                        const r = search(v, depth + 1);
                        if (r) return r;
                    }
                }
                return null;
            }

            let fiber = article[fkey];
            for (let i = 0; i < 40 && fiber; i++) {
                search(fiber.memoizedProps, 0);
                if (found.length) return found;
                fiber = fiber.return;
            }
        } catch (e) { log('Fallback React falló:', e); }
        return null;
    }

    // Petición cross-origin saltándose CORS/CSP de la página (GM_xmlhttpRequest)
    function gmGet(url, responseType) {
        return new Promise((resolve, reject) => {
            const gm = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest :
                       (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
            if (!gm) { reject(new Error('GM_xmlhttpRequest no disponible')); return; }
            gm({
                method: 'GET',
                url,
                responseType: responseType || 'text',
                anonymous: true,
                onload: r => (r.status >= 200 && r.status < 300)
                    ? resolve(r.response)
                    : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('Error de red (GM)')),
                ontimeout: () => reject(new Error('Timeout (GM)'))
            });
        });
    }

    // Fallback: endpoint público de syndication (el que usan los embeds de tweets)
    async function fetchVariantsViaSyndication(id) {
        try {
            const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
            const raw = await gmGet(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`, 'text');
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const details = Array.isArray(data.mediaDetails) ? data.mediaDetails : [];
            for (const md of details) {
                if (md && md.video_info && Array.isArray(md.video_info.variants)) {
                    addVideo(id, md.type || 'video', md.video_info.variants);
                }
            }
            const arr = videoCache.get(id);
            return arr ? arr.map(e => e.variants) : null;
        } catch (e) {
            log('Syndication falló:', e);
            return null;
        }
    }

    // Devuelve { kind: 'video', url } o { kind: 'images', urls: [...] }
    async function resolveMedia(article) {
        // 1) Vídeo / GIF desde la caché de la API (probando todos los IDs de status del article)
        const ids = [getTweetId(article)];
        article.querySelectorAll('a[href*="/status/"]').forEach(a => {
            const m = a.getAttribute('href').match(/\/status\/(\d+)/);
            if (m) ids.push(m[1]);
        });
        for (const id of ids) {
            if (id && videoCache.has(id)) {
                const urls = bestUrls(videoCache.get(id).map(e => e.variants));
                if (urls.length) return { kind: 'video', urls };
            }
        }

        // 2) Imágenes desde el DOM
        const images = collectImagesFromTweet(article);
        if (images.length) return { kind: 'images', urls: images };

        // 3) Fallback: props de React (funciona aunque el <video> aún no esté montado)
        const fiberUrls = bestUrls(findVariantsInFiber(article));
        if (fiberUrls.length) return { kind: 'video', urls: fiberUrls };

        // 4) GIF u otro vídeo con src directo (no blob:)
        const videoEl = article.querySelector('video');
        if (videoEl) {
            const src = videoEl.currentSrc || videoEl.src ||
                        (videoEl.querySelector('source') && videoEl.querySelector('source').src) || '';
            if (/^https?:/.test(src) && /\.mp4(\?|$)/.test(src)) {
                return { kind: 'video', urls: [src] };
            }
        }

        // 5) Fallback: syndication público
        const synId = ids.find(Boolean);
        if (synId) {
            const synUrls = bestUrls(await fetchVariantsViaSyndication(synId));
            if (synUrls.length) return { kind: 'video', urls: synUrls };
        }

        const testids = [...new Set([...article.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')))];
        log('Diagnóstico:', { ids, testids, hayVideoEl: !!videoEl, respuestasLeidas: stats.responses, videosCacheados: stats.videos });

        const hasPlayer = videoEl || article.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
        if (hasPlayer) {
            throw new Error(`No encuentro las URLs de este vídeo (IDs probados: ${ids.filter(Boolean).join(', ') || 'ninguno'}; respuestas leídas: ${stats.responses}; vídeos cacheados: ${stats.videos}). Mira la consola ([X-RepostMedia]).`);
        }
        throw new Error(`Este tweet no tiene imágenes ni vídeo que extraer (respuestas leídas: ${stats.responses}; vídeos cacheados: ${stats.videos}). Mira la consola ([X-RepostMedia]).`);
    }

    // ============================================================
    // DESCARGAR Y CONVERTIR A File
    // ============================================================

    async function downloadImageAsFile(url, index) {
        const resp = await fetch(url, { credentials: 'omit' });
        if (!resp.ok) throw new Error(`Fallo descargando imagen (${resp.status})`);
        const blob = await resp.blob();

        const fmt = new URL(url).searchParams.get('format') || 'jpg';
        const ext = fmt === 'jpg' ? 'jpg' : fmt;
        const mime = blob.type || (fmt === 'png' ? 'image/png' : 'image/jpeg');

        return new File([blob], `media_${Date.now()}_${index}.${ext}`, { type: mime });
    }

    async function downloadVideoAsFile(url, index) {
        let blob;
        try {
            blob = await gmGet(url, 'blob');
        } catch (e) {
            log('GM falló al descargar el vídeo, pruebo con fetch:', e);
            const resp = await fetch(url, { credentials: 'omit' });
            if (!resp.ok) throw new Error(`Fallo descargando vídeo (${resp.status})`);
            blob = await resp.blob();
        }
        log(`Vídeo descargado: ${(blob.size / 1048576).toFixed(1)} MB`);
        return new File([blob], `media_${Date.now()}_${index}.mp4`, { type: 'video/mp4' });
    }

    // ============================================================
    // ABRIR COMPOSER MODAL E INYECTAR ARCHIVOS
    // ============================================================

    async function waitFor(selectorFn, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = selectorFn();
            if (el) return el;
            await sleep(150);
        }
        return null;
    }

    // Solo aceptamos el file input que esté DENTRO del modal (#layers / aria-modal),
    // nunca el del composer inline de la parte superior del feed.
    function findModalFileInput() {
        const containers = [];
        const layers = document.getElementById('layers');
        if (layers) containers.push(layers);
        document.querySelectorAll('div[aria-modal="true"], [role="dialog"]').forEach(d => containers.push(d));

        for (const c of containers) {
            const input = c.querySelector('input[data-testid="fileInput"], input[type="file"]');
            if (input) return input;
        }
        return null;
    }

    async function openComposerAndInject(files) {
        const composeBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
                           document.querySelector('a[href="/compose/post"]');
        if (composeBtn) {
            composeBtn.click();
        } else {
            window.history.pushState({}, '', '/compose/post');
            window.dispatchEvent(new PopStateEvent('popstate'));
        }

        const fileInput = await waitFor(findModalFileInput, CONFIG.composerTimeoutMs);
        if (!fileInput) throw new Error('No se abrió el composer modal o no encuentro su input de archivos.');

        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        log(`${files.length} archivo(s) inyectado(s) en el composer modal.`);
    }

    // ============================================================
    // SUSTITUIR EL BOTÓN DE COMPARTIR POR LA PLUMA
    // ============================================================

    function findShareButton(article) {
        // El botón de compartir es el de la flecha hacia arriba saliendo de una caja
        return article.querySelector('button[aria-label*="Compartir" i], button[aria-label*="Share" i]') ||
               article.querySelector('[data-testid="share"], button[data-testid="shareButton"]') ||
               null;
    }

    function forceEnable(btn) {
        btn.disabled = false;
        btn.removeAttribute('disabled');
        btn.removeAttribute('aria-disabled');
        btn.style.setProperty('pointer-events', 'auto', 'important');
        btn.style.setProperty('opacity', '1', 'important');
        btn.style.setProperty('cursor', 'pointer', 'important');
        // Color estándar de los iconos de acción de X (gris normal, no apagado)
        btn.style.setProperty('color', 'rgb(113, 118, 123)', 'important');

        // Forzar también en los wrappers internos que llevan el color/opacidad por clase
        btn.querySelectorAll('div, span, svg').forEach(el => {
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('color', 'inherit', 'important');
        });

        // Y en los contenedores padres, que a veces llevan el estilo "apagado"
        let parent = btn.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
            parent.style.setProperty('pointer-events', 'auto', 'important');
            parent.style.setProperty('opacity', '1', 'important');
            parent = parent.parentElement;
        }
    }

    async function handleFeatherClick(article, featherBtn) {
        try {
            featherBtn.style.opacity = '0.4';

            const media = await resolveMedia(article);
            let files = [];

            if (media.kind === 'video') {
                log(`Extrayendo ${media.urls.length} vídeo(s)...`);
                for (let i = 0; i < media.urls.length; i++) {
                    files.push(await downloadVideoAsFile(media.urls[i], i));
                }
            } else {
                log(`Extrayendo ${media.urls.length} imagen(es)...`);
                for (let i = 0; i < media.urls.length; i++) {
                    files.push(await downloadImageAsFile(media.urls[i], i));
                }
            }

            await openComposerAndInject(files);
        } catch (err) {
            console.error('[X-RepostMedia] Error:', err);
            alert('Fallo: ' + err.message);
        } finally {
            featherBtn.style.setProperty('opacity', '1', 'important');
        }
    }

    function replaceShareButton(article) {
        const shareBtn = findShareButton(article);
        if (!shareBtn || shareBtn.dataset.featherHooked) return;
        shareBtn.dataset.featherHooked = 'true';

        // Reactivar el botón si X lo ha desactivado (p. ej. cuentas que te bloquean)
        forceEnable(shareBtn);

        // Cambiar el icono por la pluma de pájaro
        const svg = shareBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.innerHTML = FEATHER_SVG;
        }

        shareBtn.setAttribute('aria-label', 'Repostear imágenes o vídeo');
        shareBtn.removeAttribute('title');

        shareBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

            const article = this.closest('article');
            if (!article) return;
            handleFeatherClick(article, this);
        }, true);
    }

    function scanTweets() {
        document.querySelectorAll('article[data-testid="tweet"]').forEach(replaceShareButton);

        // Re-forzar botones ya enganchados que React haya vuelto a desactivar o apagar
        document.querySelectorAll('button[data-feather-hooked="true"][disabled], button[data-feather-hooked="true"][aria-disabled="true"]').forEach(forceEnable);
    }

    // ============================================================
    // OBSERVER (document-start: el body aún no existe)
    // ============================================================

    const observer = new MutationObserver(scanTweets);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(scanTweets, 2000);

})();
