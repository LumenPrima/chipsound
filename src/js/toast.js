import { $ } from './dom.js';

let hideTimer = null;

function ensureContainer() {
    let node = $('#toast');
    if (node) return node;
    node = document.createElement('div');
    node.id = 'toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
    return node;
}

export function toast(message, { variant = 'info', duration = 3500 } = {}) {
    const node = ensureContainer();
    node.textContent = message;
    node.dataset.variant = variant;
    node.classList.add('visible');

    clearTimeout(hideTimer);
    if (duration > 0) {
        hideTimer = setTimeout(() => node.classList.remove('visible'), duration);
    }
}

// Explicit dismissal — used by sticky toasts (duration: 0) like the
// "Loading: <url>" feedback while a URL fetch is in flight.
export function hideToast() {
    clearTimeout(hideTimer);
    hideTimer = null;
    const node = document.getElementById('toast');
    if (node) node.classList.remove('visible');
}
