// Help overlay. Lazy-built on the shared modal primitive (modal.js).
// Shortcut list: keyboard.js#SHORTCUTS. Every entry with a `run` is a
// button here, so anything the keyboard can do is one tap away on a phone;
// toggles show their current state and refresh after each tap.
// Credits mirror /NOTICE and docs/licenses.md.

import { isTypingTarget } from './dom.js';
import { SHORTCUTS } from './keyboard.js';
import { createModal } from './modal.js';

const CREDITS = [
    { name: 'libopenmpt',    url: 'https://lib.openmpt.org/libopenmpt/',          license: 'BSD-3' },
    { name: 'Chiptune.js',   url: 'https://github.com/DrSnuggles/chiptune',       license: 'MIT'   },
    { name: 'Font Awesome',  url: 'https://fontawesome.com/license/free',         license: 'CC BY 4.0' },
];

function refreshStates(body) {
    for (const btn of body.querySelectorAll('.help-run[data-shortcut]')) {
        const entry = SHORTCUTS[Number(btn.dataset.shortcut)];
        if (!entry?.state) continue;
        const on = Boolean(entry.state());
        btn.setAttribute('aria-pressed', String(on));
        const pill = btn.querySelector('.help-state');
        if (pill) pill.textContent = on ? 'on' : 'off';
    }
}

const help = createModal({
    id: 'helpOverlay',
    title: 'Shortcuts',
    className: 'modal-help',
    onOpen(modal) { refreshStates(modal.body); },
    build(body) {
        let rows = '';
        SHORTCUTS.forEach(({ keys, label, joiner = ' / ', run, state }, i) => {
            const kbds = keys.map(k => `<kbd>${k}</kbd>`).join(joiner);
            const text = run
                ? `<button type="button" class="help-run" data-shortcut="${i}"${state ? ' aria-pressed="false"' : ''}>`
                  + `<span class="help-run-label">${label}</span>`
                  + (state ? `<span class="help-state" aria-hidden="true">off</span>` : '')
                  + `</button>`
                : label;
            rows += `<dt>${kbds}</dt><dd>${text}</dd>`;
        });
        const creditLinks = CREDITS
            .map(c => `<a href="${c.url}" target="_blank" rel="noopener">${c.name}</a> <span class="help-credits-license">(${c.license})</span>`)
            .join(' · ');
        body.innerHTML = `
            <dl class="help-list">${rows}</dl>
            <footer class="help-credits">
                <div class="help-home">
                    <a href="https://chipsound.com" target="_blank" rel="noopener">
                        <img src="./images/favicon.svg" alt="" width="22" height="22" aria-hidden="true">
                        <span>chipsound.com</span>
                    </a>
                    <a href="https://ko-fi.com/gamosoft" target="_blank" rel="noopener" class="help-support">
                        <span class="help-support-icon" aria-hidden="true">☕</span>
                        <span>Support on Ko-fi</span>
                    </a>
                </div>
                Built on ${creditLinks}.
            </footer>`;
        body.addEventListener('click', e => {
            const btn = e.target.closest('.help-run[data-shortcut]');
            if (!btn) return;
            const entry = SHORTCUTS[Number(btn.dataset.shortcut)];
            if (!entry?.run) return;
            entry.run(e);
            // The action may have closed this overlay (opened another modal);
            // if it's still up, show the new toggle states.
            if (help.isOpen()) refreshStates(body);
        });
    },
});

export function openHelp() { help.open(); }
export function closeHelp() { help.close(); }
export function toggleHelp() { help.toggle(); }

// '?' (Shift+/) — not in the shortcut table; it's a derived shifted key.
// Esc is handled by the modal primitive.
export function installHelpEscape() {
    document.addEventListener('keydown', e => {
        if (e.key === '?' && !isTypingTarget(e.target)) {
            e.preventDefault();
            toggleHelp();
        }
    });
}
