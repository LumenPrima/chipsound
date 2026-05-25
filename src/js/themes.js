// Theme manager. Discovery + applyTheme + picker.

import { prefs } from './prefs.js';
import { $ } from './dom.js';
import { toast } from './toast.js';
import { relayoutTracker } from './tracker.js';
import {
    setVisualizationPalette,
    clearVisualizations,
    vizPaletteFromCss,
} from './viz-engine.js';
import { playerState } from './state.js';
import { getCurrentVisualizations } from './controls.js';


// ---- Discovery ---------------------------------------------------------

const RX_NAME = /--theme-name\s*:\s*["']([^"'\n]+)["']/i;

const FALLBACK_THEMES = Object.freeze([Object.freeze({
    id: 'clusters',
    name: 'Clusters',
    cssPath: './css/themes/clusters.css',
})]);

// Fallback for themes that don't declare `--theme-name`.
function titleCase(id) {
    return id
        .split(/[-_]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

async function listCssFiles() {
    const res = await fetch('./css/themes/', { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`css/themes/ listing returned HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ids = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        // Server indexes differ (Python bare names vs Caddy `./` prefix).
        const name = href.split('?')[0].split('#')[0].split('/').pop();
        if (!name || !name.endsWith('.css')) continue;
        ids.add(name.slice(0, -4));
    }
    if (ids.size === 0) throw new Error('css/themes/ listing parsed to zero .css files');
    return [...ids];
}

async function readThemeTokens(id) {
    const res = await fetch(`./css/themes/${id}.css`);
    if (!res.ok) throw new Error(`theme ${id}: HTTP ${res.status}`);
    const text = await res.text();
    // Name token lives in the first ~2 KB.
    const head = text.slice(0, 2048);
    const name = (head.match(RX_NAME)?.[1] || titleCase(id)).trim();
    return { id, name, cssPath: `./css/themes/${id}.css` };
}

async function discoverThemes() {
    try {
        const ids = await listCssFiles();
        const list = await Promise.all(ids.map(readThemeTokens));
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return list;
    } catch (err) {
        console.warn('Theme discovery failed; using fallback list:', err);
        return FALLBACK_THEMES;
    }
}


// ---- Cache + lookup ----------------------------------------------------

let themes = [];

// Last-resort id if initThemes() hasn't run yet.
const BOOTSTRAP_DEFAULT = 'clusters';

function defaultThemeId() {
    return themes[0]?.id || BOOTSTRAP_DEFAULT;
}

function findTheme(id) {
    return themes.find(t => t.id === id);
}

function themeCssPath(id) {
    return findTheme(id)?.cssPath || `./css/themes/${id}.css`;
}

function normalize(id) {
    return findTheme(id) ? id : defaultThemeId();
}


// ---- Public API --------------------------------------------------------

export function currentTheme() {
    return normalize(prefs.theme);
}

export async function initThemes() {
    themes = await discoverThemes();
    return themes;
}

// Prefetch every theme's CSS so future switches are a pure classList toggle.
export function prefetchOtherThemes() {
    for (const theme of themes) injectThemeCss(theme.id);
}

// Idempotent. Forced-flush work deferred to a single rAF.
export function applyTheme(id, { silent = true } = {}) {
    const safe = normalize(id);
    injectThemeCss(safe);

    const root = document.documentElement;
    for (const t of themes) {
        root.classList.toggle('theme-' + t.id, t.id === safe);
    }
    // Strip any stale `theme-*` not in the manifest (preboot, deleted theme, …).
    for (const cls of [...root.classList]) {
        if (cls.startsWith('theme-') && cls !== 'theme-' + safe) {
            root.classList.remove(cls);
        }
    }
    root.classList.add('theme-' + safe);

    prefs.theme = safe;

    const select = $('#themePicker');
    if (select && select.value !== safe) select.value = safe;

    if (!silent) {
        const entry = findTheme(safe);
        if (entry) toast(`Theme: ${entry.name}`, { variant: 'info', duration: 1500 });
    }

    requestAnimationFrame(() => {
        setVisualizationPalette(vizPaletteFromCss());
        relayoutTracker();

        // Repaint idle viz canvases — next live frame handles it while playing.
        const song = playerState.meta?.song;
        if (song && !playerState.isPlaying) {
            clearVisualizations(song, getCurrentVisualizations());
        }
    });
}

// Cycle through themes alphabetically (T keyboard shortcut).
export function cycleTheme() {
    if (themes.length === 0) return;
    const idx = themes.findIndex(t => t.id === currentTheme());
    const next = themes[(idx + 1) % themes.length];
    applyTheme(next.id, { silent: false });
}

export function wireThemePicker() {
    const select = $('#themePicker');
    if (!select) return;
    select.innerHTML = themes
        .map(t => `<option value="${escapeAttr(t.id)}">${escapeText(t.name)}</option>`)
        .join('');
    select.value = currentTheme();
    select.addEventListener('change', () => applyTheme(select.value, { silent: false }));
}


// ---- Internals ---------------------------------------------------------

const injectedThemes = new Set();

function injectThemeCss(id) {
    if (injectedThemes.has(id)) return;
    injectedThemes.add(id);
    // Preboot stamps data-theme-id on its <link> so we skip the duplicate fetch.
    const existing = document.querySelector(`link[data-theme-id="${id}"]`);
    if (existing) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = themeCssPath(id);
    link.dataset.themeId = id;
    document.head.appendChild(link);
}

function escapeText(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
