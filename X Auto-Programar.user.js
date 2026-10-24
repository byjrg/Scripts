// ==UserScript==
// @name         X Auto-Programar
// @namespace    http://tampermonkey.net/
// @version      3.20
// @description  Dos botones "+" repurposeados con espacio entre ellos: rayo (izquierda) = express, rango 1-7 días; reloj (derecha) = estándar, rango 7 días-N meses (N=3/6/9/12, configurable con pulsación larga, se recuerda con localStorage; badge indicador en el botón). Icono de reloj recentrado. Sin tooltip. Tamaño igualado al de Postear.
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
    // Reloj clásico con primitivas SVG simples (circle + line) en vez de arcos
    // escritos a mano — así no hay cálculo de curvas que se pueda estropear.
    // Círculo centrado exactamente en (12,12); las manecillas parten del mismo
    // centro. Color fijado en el azul de X directamente (stroke, no fill, así
    // que no dependemos de la herencia de "fill" para el color).
    const CLOCK_SVG_INNER = '<circle cx="12.8" cy="12" r="10" fill="none" stroke="#1d9bf0" stroke-width="2.3"/><line x1="12.8" y1="12" x2="12.8" y2="5.8" stroke="#1d9bf0" stroke-width="2.3" stroke-linecap="round"/><line x1="12.8" y1="12" x2="17.8" y2="12" stroke="#1d9bf0" stroke-width="2.3" stroke-linecap="round"/>';

    const CUSTOM_LABEL_STANDARD = 'Auto-Programar';
    const CUSTOM_LABEL_EXPRESS = 'Auto-Programar (7 días)';

    // Opciones de rango máximo para el botón estándar (el mínimo, 7 días, es
    // fijo). Se guardan en localStorage (persiste siempre, sin caducidad,
    // scopeado al dominio x.com/twitter.com) para recordar la última elección.
    const STORAGE_KEY = 'xAutoProgramarMaxMonths';
    const MONTH_OPTIONS = [3, 6, 9, 12];

    function getMaxMonths() {
        const stored = parseInt(localStorage.getItem(STORAGE_KEY), 10);
        return MONTH_OPTIONS.includes(stored) ? stored : 12;
    }

    function setMaxMonths(months) {
        localStorage.setItem(STORAGE_KEY, String(months));
    }

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

    // mode: 'full' -> uniforme entre 7 días y el máximo configurado (3/6/9/12
    //                 meses, ver getMaxMonths — por defecto 12), EXCLUYENDO los
    //                 primeros 7 días (esa franja la cubre el botón express)
    //       'near' -> uniforme entre 1 y 7 días, empezando mañana. El mínimo de 1
    //                 día completo garantiza que, sea cual sea la hora que se
    //                 sortee después, el resultado siempre cae en el futuro — con
    //                 offsets menores a 1 día, una hora sorteada anterior a la
    //                 hora actual caía en el pasado.
    function generateRandomDate(mode = 'full') {
        const date = new Date();
        date.setMinutes(date.getMinutes() + 5);

        let dayOffset;

        if (mode === 'near') {
            dayOffset = 1 + Math.random() * 6;
        } else {
            const maxDays = getMaxMonths() * 30; // aproximación de mes
            dayOffset = 7 + Math.random() * (maxDays - 7);
        }

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

    async function runAutoSchedule(nativeBtn, initialModal, dateGenerator) {
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

            const d = dateGenerator();
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

    // ============ CLICK EN LOS BOTONES REPURPOSEADOS ============

    function makeAutoClickHandler(nativeBtn, dateGenerator) {
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

                await runAutoSchedule(nativeBtn, readyModal, dateGenerator);
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
    function setupCustomTooltip(btn) {
        btn.removeAttribute('title'); // evita también el tooltip nativo del navegador

        let hovering = false;
        btn.addEventListener('mouseenter', () => { hovering = true; });
        btn.addEventListener('mouseleave', () => { hovering = false; });
        btn.addEventListener('focus', () => { hovering = true; });
        btn.addEventListener('blur', () => { hovering = false; });

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

    // El efecto hover nativo de X ("círculo se oscurece") está atado en su CSS
    // al atributo data-testid="addButton" exacto. Como al clon se lo quitamos
    // (para que no se confunda con el "+" nativo en futuros escaneos), pierde
    // ese hover — así que se lo simulamos manualmente por JS.
    function addManualHover(btn) {
        const HOVER_BG = 'rgba(29, 155, 240, 0.1)';
        btn.style.transition = 'background-color 0.2s ease';
        btn.addEventListener('mouseenter', () => { btn.style.backgroundColor = HOVER_BG; });
        btn.addEventListener('mouseleave', () => { btn.style.backgroundColor = ''; });
        btn.addEventListener('touchstart', () => { btn.style.backgroundColor = HOVER_BG; }, { passive: true });
        btn.addEventListener('touchend', () => { btn.style.backgroundColor = ''; });
    }

    // ============ SELECTOR DE RANGO MÁXIMO (pulsación larga) ============
    //
    // No es viable engancharse al menú nativo de X (es un componente React
    // interno sin API pública), así que construimos un menú propio con un
    // estilo visual similar, disparado con una pulsación larga sobre el botón
    // del reloj. Un tap normal sigue programando como siempre.

    function createMonthsBadge(btn) {
        const badge = document.createElement('div');
        badge.style.cssText = `
            position: absolute;
            bottom: -2px;
            right: -2px;
            background: #1d9bf0;
            color: #fff;
            font-size: 9px;
            font-weight: 700;
            line-height: 1;
            padding: 2px 4px;
            border-radius: 8px;
            border: 1.5px solid #000;
            pointer-events: none;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        btn.style.position = 'relative';
        btn.appendChild(badge);
        return badge;
    }

    function updateMonthsBadge(badge) {
        badge.textContent = getMaxMonths() + 'm';
    }

    let monthsMenuEl = null;

    function closeMonthsMenuOnOutsideClick(e) {
        if (monthsMenuEl && !monthsMenuEl.contains(e.target)) {
            closeMonthsMenu();
        }
    }

    function closeMonthsMenu() {
        if (monthsMenuEl) {
            monthsMenuEl.remove();
            monthsMenuEl = null;
        }
        document.removeEventListener('click', closeMonthsMenuOnOutsideClick, true);
    }

    function openMonthsMenu(anchorBtn, badge) {
        closeMonthsMenu(); // por si ya había uno abierto

        const current = getMaxMonths();
        const rect = anchorBtn.getBoundingClientRect();

        monthsMenuEl = document.createElement('div');
        monthsMenuEl.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.top - 8}px;
            transform: translateY(-100%);
            background: #16181c;
            border: 1px solid rgb(47, 51, 54);
            border-radius: 14px;
            padding: 4px;
            z-index: 999999;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            min-width: 160px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        MONTH_OPTIONS.forEach(months => {
            const isCurrent = months === current;
            const item = document.createElement('div');
            item.textContent = `Hasta ${months} meses` + (isCurrent ? ' ✓' : '');
            item.style.cssText = `
                padding: 10px 14px;
                color: ${isCurrent ? '#1d9bf0' : 'rgb(231,233,234)'};
                font-size: 14px;
                font-weight: ${isCurrent ? '700' : '400'};
                border-radius: 8px;
                cursor: pointer;
            `;
            item.addEventListener('mouseenter', () => { item.style.backgroundColor = 'rgba(239,243,244,0.1)'; });
            item.addEventListener('mouseleave', () => { item.style.backgroundColor = 'transparent'; });
            // Usamos "pointerup" en vez de "click": el click solo se
            // sintetiza cuando mousedown y mouseup ocurren sobre el MISMO
            // elemento, y aquí el mousedown real fue sobre el botón del
            // reloj (el que abrió el menú con la pulsación larga), no sobre
            // esta opción — con ratón (mantener pulsado + arrastrar + soltar
            // encima de la opción) eso significa que nunca llegaría un click
            // aquí. "pointerup" sí se dispara sobre lo que haya bajo el
            // cursor al soltar, sin importar dónde empezó la pulsación.
            item.addEventListener('pointerup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setMaxMonths(months);
                updateMonthsBadge(badge);
                closeMonthsMenu();
                log(`Rango estándar actualizado: 7 días - ${months} meses`);
            }, true);
            monthsMenuEl.appendChild(item);
        });

        document.body.appendChild(monthsMenuEl);

        // Si se sale de la pantalla por arriba, lo mostramos hacia abajo
        const menuRect = monthsMenuEl.getBoundingClientRect();
        if (menuRect.top < 0) {
            monthsMenuEl.style.top = (rect.bottom + 8) + 'px';
            monthsMenuEl.style.transform = 'none';
        }

        // Armamos el detector de "clic fuera" con retraso: soltar el dedo tras
        // la pulsación larga que abrió este menú genera, casi de inmediato, un
        // evento "click" sobre el propio botón. Si empezáramos a escuchar ya
        // mismo, ese click se interpretaría como "fuera" y cerraría el menú
        // antes de que te diera tiempo a tocar una opción. 350ms es de sobra
        // para que ese click de suelta ya haya pasado, y sigue siendo
        // imperceptible para un "clic fuera" genuino posterior.
        setTimeout(() => {
            document.addEventListener('click', closeMonthsMenuOnOutsideClick, true);
        }, 350);
    }

    // Pulsación larga (500ms) vía pointer events, compatible con ratón y
    // táctil. En vez de un segundo listener de "click" separado que intente
    // bloquear al primero (frágil: depende del orden de ejecución entre dos
    // listeners distintos en el mismo elemento), dejamos una bandera en el
    // propio botón (btn._longPressTriggered) que el handler de click ÚNICO
    // (ver configureButton) comprueba él mismo antes de decidir qué hacer.
    function setupLongPress(btn, onLongPress) {
        const LONG_PRESS_MS = 500;
        let pressTimer = null;
        btn._longPressTriggered = false;

        btn.style.webkitUserSelect = 'none';
        btn.style.userSelect = 'none';
        btn.style.webkitTouchCallout = 'none';

        const start = () => {
            btn._longPressTriggered = false;
            pressTimer = setTimeout(() => {
                btn._longPressTriggered = true;
                onLongPress();
            }, LONG_PRESS_MS);
        };
        const cancel = () => {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            // Red de seguridad: si el "click" que debería resetear la bandera
            // no llega (algún navegador no lo dispara tras una pulsación
            // larga), la limpiamos igualmente pasado un rato para no dejar
            // bloqueado el próximo tap normal.
            if (btn._longPressTriggered) {
                setTimeout(() => { btn._longPressTriggered = false; }, 400);
            }
        };

        btn.addEventListener('pointerdown', start);
        btn.addEventListener('pointerup', cancel);
        btn.addEventListener('pointerleave', cancel);
        btn.addEventListener('pointercancel', cancel);
    }

    // Aplica icono, aria-label, tamaño (igualado al botón Postear) y el
    // listener de click a un botón "+" (original o clonado). Si el botón
    // tiene pulsación larga configurada (setupLongPress), el propio handler
    // de click comprueba la bandera _longPressTriggered antes de programar.
    function configureButton(btn, { svgInner, ariaLabel, postBtn, handler }) {
        const svg = btn.querySelector('svg');
        if (svg) {
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.innerHTML = svgInner;
        }
        btn.setAttribute('aria-label', ariaLabel);

        if (postBtn) {
            const h = postBtn.getBoundingClientRect().height;
            if (h > 0) {
                btn.style.width = h + 'px';
                btn.style.height = h + 'px';
                btn.style.borderRadius = '9999px';
                btn.style.display = 'flex';
                btn.style.alignItems = 'center';
                btn.style.justifyContent = 'center';
                if (svg) {
                    const iconSize = Math.round(h * 0.5);
                    svg.style.width = iconSize + 'px';
                    svg.style.height = iconSize + 'px';
                }
            }
        }

        setupCustomTooltip(btn);
        btn.addEventListener('click', (e) => {
            if (btn._longPressTriggered) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                btn._longPressTriggered = false;
                return;
            }
            handler(e);
        }, true);
    }

    // ============ ENGANCHAR EL COMPOSER ============

    function hookComposer(toolBar) {
        const nativeBtn = findNativeScheduleButton(toolBar);
        if (!nativeBtn) return;

        const root = findComposerRoot(toolBar);
        const addBtn = findAddButton(root);
        if (!addBtn || addBtn.dataset.autoHooked) return;

        addBtn.dataset.autoHooked = 'true';

        // Clonamos el "+" ANTES de modificarlo, para partir de un botón nativo
        // intacto (mismo tamaño/estructura) y sin listeners todavía —
        // cloneNode() no copia los listeners añadidos con addEventListener.
        const expressBtn = addBtn.cloneNode(true);
        expressBtn.removeAttribute('data-testid'); // que no se confunda con el "+" nativo en futuros escaneos
        delete expressBtn.dataset.autoHooked;
        expressBtn.style.marginRight = '8px'; // separación visual entre los dos círculos
        addBtn.parentNode.insertBefore(expressBtn, addBtn);

        const postBtn = findPostButton(root);

        // Botón izquierdo (nuevo): rayo → express, rango corto (1-7 días)
        configureButton(expressBtn, {
            svgInner: BOLT_SVG_INNER,
            ariaLabel: CUSTOM_LABEL_EXPRESS,
            postBtn,
            handler: makeAutoClickHandler(nativeBtn, () => generateRandomDate('near'))
        });
        addManualHover(expressBtn);

        // Botón derecho (el "+" original): reloj → programación estándar, rango
        // 7 días - máximo configurable. IMPORTANTE: setupLongPress se llama
        // ANTES que configureButton para que su listener de "click" (el que
        // bloquea el click tras una pulsación larga) se registre primero.
        setupLongPress(addBtn, () => openMonthsMenu(addBtn, badge));
        configureButton(addBtn, {
            svgInner: CLOCK_SVG_INNER,
            ariaLabel: CUSTOM_LABEL_STANDARD,
            postBtn,
            handler: makeAutoClickHandler(nativeBtn, () => generateRandomDate('full'))
        });
        const badge = createMonthsBadge(addBtn);
        updateMonthsBadge(badge);

        log(`Botones repurposeados: rayo (express, 1-7 días) + reloj (estándar, 7 días-${getMaxMonths()} meses; pulsación larga para cambiar el rango)`);
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
