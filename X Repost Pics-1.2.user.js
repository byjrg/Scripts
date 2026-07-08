// ==UserScript==
// @name         X Repost Pics
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Sustituye el botón de compartir por una pluma de pájaro: extrae las imágenes originales del tweet y las incrusta en el composer modal como si se subieran desde el PC. Solo imágenes.
// @author       You
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-idle
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
    // EXTRAER IMÁGENES DE UN TWEET (DOM)
    // ============================================================

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

        if (items.length === 0) {
            throw new Error('Este tweet no tiene imágenes que extraer.');
        }
        return items;
    }

    // ============================================================
    // DESCARGAR Y CONVERTIR A File
    // ============================================================

    async function downloadAsFile(url, index) {
        const resp = await fetch(url, { credentials: 'omit' });
        if (!resp.ok) throw new Error(`Fallo descargando imagen (${resp.status})`);
        const blob = await resp.blob();

        const fmt = new URL(url).searchParams.get('format') || 'jpg';
        const ext = fmt === 'jpg' ? 'jpg' : fmt;
        const mime = blob.type || (fmt === 'png' ? 'image/png' : 'image/jpeg');

        return new File([blob], `media_${Date.now()}_${index}.${ext}`, { type: mime });
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

    async function handleFeatherClick(article, featherBtn) {
        try {
            featherBtn.style.opacity = '0.4';

            const urls = collectImagesFromTweet(article);
            log(`Extrayendo ${urls.length} imagen(es)...`);

            const files = [];
            for (let i = 0; i < urls.length; i++) {
                files.push(await downloadAsFile(urls[i], i));
            }

            await openComposerAndInject(files);
        } catch (err) {
            console.error('[X-RepostMedia] Error:', err);
            alert('Fallo: ' + err.message);
        } finally {
            featherBtn.style.opacity = '';
        }
    }

    function replaceShareButton(article) {
        const shareBtn = findShareButton(article);
        if (!shareBtn || shareBtn.dataset.featherHooked) return;
        shareBtn.dataset.featherHooked = 'true';

        // Cambiar el icono por la pluma de pájaro
        const svg = shareBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.innerHTML = FEATHER_SVG;
        }

        shareBtn.setAttribute('aria-label', 'Repostear imágenes');
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
    }

    // ============================================================
    // OBSERVER
    // ============================================================

    const observer = new MutationObserver(scanTweets);
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(scanTweets, 2000);

})();