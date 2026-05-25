// Help overlay. Lazy-built. Shortcut list: keyboard.js#SHORTCUTS.
// Credits below mirror /NOTICE and docs/licenses.md.

import { isTypingTarget } from './dom.js';
import { SHORTCUTS } from './keyboard.js';

const CREDITS = [
    { name: 'libopenmpt',    url: 'https://lib.openmpt.org/libopenmpt/',          license: 'BSD-3' },
    { name: 'Chiptune.js',   url: 'https://github.com/DrSnuggles/chiptune',       license: 'MIT'   },
    { name: 'Font Awesome',  url: 'https://fontawesome.com/license/free',         license: 'CC BY 4.0' },
];

let overlayEl = null;
let closeBtnEl = null;
let isOpen = false;

function buildOverlay() {
    const node = document.createElement('div');
    node.id = 'helpOverlay';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    node.setAttribute('aria-label', 'Keyboard shortcuts');

    let rows = '';
    for (const { keys, label, joiner = ' / ' } of SHORTCUTS) {
        const kbds = keys.map(k => `<kbd>${k}</kbd>`).join(joiner);
        rows += `<dt>${kbds}</dt><dd>${label}</dd>`;
    }

    const creditLinks = CREDITS
        .map(c => `<a href="${c.url}" target="_blank" rel="noopener">${c.name}</a> <span class="help-credits-license">(${c.license})</span>`)
        .join(' · ');

    node.innerHTML = `
        <div class="help-card">
            <h2>
                <span>Keyboard shortcuts</span>
                <button type="button" class="help-close" aria-label="Close (Esc)">×</button>
            </h2>
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
            </footer>
        </div>
    `;

    node.addEventListener('click', e => {
        if (e.target === node) closeHelp();
    });
    closeBtnEl = node.querySelector('.help-close');
    closeBtnEl.addEventListener('click', closeHelp);

    document.body.appendChild(node);
    return node;
}

export function openHelp() {
    if (!overlayEl) overlayEl = buildOverlay();
    overlayEl.classList.add('visible');
    isOpen = true;
    closeBtnEl?.focus();
}

export function closeHelp() {
    if (!overlayEl) return;
    overlayEl.classList.remove('visible');
    isOpen = false;
}

export function toggleHelp() {
    if (isOpen) closeHelp(); else openHelp();
}

export function installHelpEscape() {
    document.addEventListener('keydown', e => {
        if (e.code === 'Escape' && isOpen) {
            e.preventDefault();
            closeHelp();
            return;
        }
        // '?' (Shift+/) — not in the shortcut table; it's a derived shifted key.
        if (e.key === '?' && !isTypingTarget(e.target)) {
            e.preventDefault();
            toggleHelp();
        }
    });
}
