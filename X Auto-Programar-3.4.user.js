// ==UserScript==
// @name         X Auto-Programar (%)
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Botón "+" repurposeado como Auto-Programar (visible, sin capa oculta). Sin tooltip. Tamaño igualado al de Postear. Fechas con distribución ponderada por buckets de días (50/25/15/10).
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
        minDelay: 600,
        maxDelay: 1000,
        maxRetries: 10,
        mediaPollMs: 400,
        maxMediaWaitMs: 5 * 60 * 1000,
        modalReadyTimeoutMs: 6000
    };

    const BOLT_SVG_INNER = '<path fill-rule="evenodd" d="M14.615 1.595a.75.75 0 01.359.852L12.982 9.75h7.268a.75.75 0 01.548 1.262l-10.5 11.25a.75.75 0 01-1.272-.71l1.992-7.302H3.75a.75.75 0 01-.548-1.262l10.5-11.25a.75.75 0 01.913-.143z" clip-rule="evenodd" />';
    const CUSTOM_LABEL = 'Auto-Programar';

    let isRunning = false;

    function log(...args) {
        if (CONFIG.debug) console.log('[X-AutoProgramar]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function randomDelay() {
        return CONFIG.minDelay + Math.random() * (CONFIG.maxDelay - CONFIG.minDelay);
    }

    async function safeClick(element, description) {
        if (!element) throw new Error(`Elemento no encontrado: ${description}`);
        await sleep(randomDelay());
        element.click();
        log(`Click (Script) en: ${description}`);
    }

    function generateRandomDate() {
        // Buckets en días desde hoy, con su probabilidad acumulada
        const buckets = [
            { maxCum: 0.50, fromDay: 0,   toDay: 90  },  // 50% → 0-3 meses
            { maxCum: 0.75, fromDay: 90,  toDay: 180 },  // 25% → 3-6 meses
            { maxCum: 0.90, fromDay: 180, toDay: 270 },  // 15% → 6-9 meses
            { maxCum: 1.00, fromDay: 270, toDay: 365 }   // 10% → 9-12 meses
        ];

        const roll = Math.random();
        const bucket = buckets.find(b => roll < b.maxCum);

        // Día aleatorio dentro del bucket (uniforme)
        const dayOffset = bucket.fromDay + Math.random() * (bucket.toDay - bucket.fromDay);

        // Base: ahora + 5 min de margen (evita el error de "fecha en el pasado")
        const date = new Date();
        date.setMinutes(date.getMinutes() + 5);
        date.setTime(date.getTime() + dayOffset * 24 * 60 * 60 * 1000);

        // Hora aleatoria del día (independiente del offset, para no sesgar horas)
        date.setHours(Math.floor(Math.random() * 24));
        date.setMinutes(Math.floor(Math.random() * 60));

        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
            minute: date.getMinutes()
        };
    }

    // ============ LOCALIZAR ELEMENTOS ============

    function findNativeScheduleButton(toolBar) {
        return toolBar.querySelector('[aria-label*="Programar"], [aria-label*="Schedule"]') ||
               toolBar.querySelector('svg path[d*="M12 2"]')?.closest('div[role="button"]') ||
               null;
    }

    function findComposerRoot(toolBar) {
        let node = toolBar;
        for (let i = 0; i < 8 && node; i++) {
            if (node.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')) {
                return node;
            }
            node = node.parentElement;
        }
        return document;
    }

    function findAddButton(root) {
        return root.querySelector('[data-testid="addButton"]') ||
               Array.from(root.querySelectorAll('button[role="button"], div[role="button"]')).find(b => {
                   const label = (b.getAttribute('aria-label') || '').toLowerCase();
                   return label.includes('añadir') || label.includes('add post') || label.includes('add another');
               }) ||
               null;
    }

    function findPostButton(root) {
        return root.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]') || null;
    }

    // Nunca reutilices una referencia "modal" de una ronda anterior: X crea un nodo
    // NUEVO cada vez que se abre, así que hay que volver a llamar a esto cada vez
    // que se cierra y se reabre.
    async function waitForModalWithSelects(timeoutMs = CONFIG.modalReadyTimeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const modal = document.querySelector('[data-testid="scheduleModal"]') ||
                          document.querySelector('div[aria-modal="true"]');
            if (modal && modal.querySelectorAll('select').length >= 5) {
                return modal;
            }
            await sleep(120);
        }
        return null;
    }

    // ============ AUTOMATIZACIÓN ============

    async function runAutoSchedule(nativeBtn, initialModal) {
        log('Tomando el control...');

        let modal = initialModal;
        let scheduled = false;
        let attempt = 0;

        while (!scheduled && attempt < CONFIG.maxRetries) {
            attempt++;

            if (!modal || !modal.isConnected || modal.querySelectorAll('select').length < 5) {
                modal = await waitForModalWithSelects();
                if (!modal) throw new Error('Estructura de fechas no reconocida (el modal no está disponible).');
            }

            const d = generateRandomDate();
            log(`Intento ${attempt}: ${d.day}/${d.month}/${d.year} ${d.hour}:${d.minute}`);

            // 1. SETEAR FECHAS
            const selects = modal.querySelectorAll('select');
            const setVal = (select, val) => {
                select.value = val;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setVal(selects[0], d.month);
            setVal(selects[1], d.day);
            setVal(selects[2], d.year);
            setVal(selects[3], d.hour);
            setVal(selects[4], d.minute);

            await sleep(500);

            // 2. CONFIRMAR
            const confirmBtn = Array.from(modal.querySelectorAll('button')).find(
                b => b.textContent.includes('Confirmar') || b.textContent.includes('Confirm') || b.querySelector('span')?.textContent.includes('Confirm')
            );

            if (!confirmBtn) throw new Error('No encuentro el botón Confirmar');
            await safeClick(confirmBtn, 'Confirmando fecha');

            await sleep(600);

            // 3. CHECK ERRORES (fecha en el pasado)
            if (document.body.innerText.includes('futuro') || document.body.innerText.includes('future')) {
                log('Fecha inválida (pasado), cerrando y reabriendo modal...');
                const closeBtn = modal.querySelector('[aria-label="Cerrar"], [aria-label="Close"]');
                if (closeBtn) await safeClick(closeBtn, 'Cerrando modal por error');
                await sleep(800);

                if (nativeBtn) nativeBtn.click();
                modal = await waitForModalWithSelects();
                if (!modal) throw new Error('No se pudo reabrir el modal tras una fecha inválida.');
                continue;
            }

            // 4. CLICK FINAL — espera larga por si hay un vídeo procesándose
            let finalBtn = null;
            const waitStart = Date.now();
            let lastLog = 0;

            while (Date.now() - waitStart < CONFIG.maxMediaWaitMs) {
                finalBtn = document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');

                if (!finalBtn) {
                    const allBtns = Array.from(document.querySelectorAll('button[role="button"], div[role="button"]'));
                    finalBtn = allBtns.find(b => b.textContent.includes('Programación') || b.textContent.includes('Schedule') || b.textContent.includes('Postear'));
                }

                if (finalBtn && !finalBtn.disabled) break;

                const elapsed = Date.now() - waitStart;
                if (elapsed - lastLog > 5000) {
                    log(`Esperando a que el botón final se active (posible vídeo procesando)... ${Math.round(elapsed / 1000)}s`);
                    lastLog = elapsed;
                }

                await sleep(CONFIG.mediaPollMs);
            }

            if (!finalBtn || finalBtn.disabled) {
                throw new Error('El botón final no se activó a tiempo (¿vídeo tardando demasiado en procesar?).');
            }

            await sleep(200);
            finalBtn.click();
            log('Click (Script) en: Programar Post Definitivo');

            scheduled = true;
            log('¡Proceso completado!');
        }

        if (!scheduled) throw new Error('Límite de intentos superado.');
    }

    // ============ CLICK EN EL "+" REPURPOSEADO ============

    function makeAutoClickHandler(nativeBtn) {
        return async function handleAutoClick(e) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

            if (isRunning) {
                log('Ya hay una programación en curso, ignorando click.');
                return;
            }
            isRunning = true;

            try {
                nativeBtn.click();
                const readyModal = await waitForModalWithSelects();
                if (!readyModal) throw new Error('El modal no se abrió o no cargó los selectores de fecha a tiempo.');

                await runAutoSchedule(nativeBtn, readyModal);
            } catch (err) {
                console.error('[X-AutoProgramar] Error:', err);
                alert('Fallo: ' + err.message);
                isRunning = false;
                return;
            }

            isRunning = false;
        };
    }

    // ============ TOOLTIP PROPIO ============

    // El tooltip de X no lee el aria-label en vivo: es un div portal que X crea
    // en cada hover con el texto original ("Agregar"). En vez de reescribirlo,
    // lo ocultamos directamente mientras el ratón está sobre nuestro botón.
    function setupCustomTooltip(addBtn) {
        addBtn.removeAttribute('title'); // evita también el tooltip nativo del navegador

        let hovering = false;
        addBtn.addEventListener('mouseenter', () => { hovering = true; });
        addBtn.addEventListener('mouseleave', () => { hovering = false; });
        addBtn.addEventListener('focus', () => { hovering = true; });
        addBtn.addEventListener('blur', () => { hovering = false; });

        const hideTooltip = () => {
            if (!hovering) return;
            document.querySelectorAll('[role="tooltip"]').forEach(tip => {
                if (tip.style.display !== 'none') {
                    tip.style.display = 'none';
                }
            });
        };

        const tooltipObserver = new MutationObserver(hideTooltip);
        tooltipObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // ============ ENGANCHAR EL COMPOSER ============

    function hookComposer(toolBar) {
        const nativeBtn = findNativeScheduleButton(toolBar);
        if (!nativeBtn) return;

        const root = findComposerRoot(toolBar);
        const addBtn = findAddButton(root);
        if (!addBtn || addBtn.dataset.autoHooked) return;

        addBtn.dataset.autoHooked = 'true';

        // Icono
        const svg = addBtn.querySelector('svg');
        if (svg) {
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.innerHTML = BOLT_SVG_INNER;
        }
        addBtn.setAttribute('aria-label', CUSTOM_LABEL);

        // Tamaño: igualamos la altura al botón de Postear, sin perder la forma redonda
        const postBtn = findPostButton(root);
        if (postBtn) {
            const h = postBtn.getBoundingClientRect().height;
            if (h > 0) {
                addBtn.style.width = h + 'px';
                addBtn.style.height = h + 'px';
                addBtn.style.borderRadius = '9999px';
                addBtn.style.display = 'flex';
                addBtn.style.alignItems = 'center';
                addBtn.style.justifyContent = 'center';
                if (svg) {
                    const iconSize = Math.round(h * 0.5);
                    svg.style.width = iconSize + 'px';
                    svg.style.height = iconSize + 'px';
                }
            }
        }

        setupCustomTooltip(addBtn);

        addBtn.addEventListener('click', makeAutoClickHandler(nativeBtn), true);

        log('Botón "+" repurposeado como Auto-Programar');
    }

    // ============ OBSERVER ============

    function scanForComposers() {
        document.querySelectorAll('[data-testid="toolBar"]').forEach(hookComposer);
    }

    const observer = new MutationObserver(() => {
        const isComposer = window.location.href.includes('/compose/') || document.querySelector('[data-testid="toolBar"]');
        if (isComposer) {
            scanForComposers();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(scanForComposers, 2000);

})();
