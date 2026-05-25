// Viz engine: main-thread orchestration. Three sections:
//
//   1. PALETTE READER   — vizPaletteFromCss(): CSS → palette object, with
//                          contrast safety net.
//   2. RENDERER HOSTS   — createWorkerHost() (OffscreenCanvas worker) and
//                          createMainRenderer() (fallback for old browsers).
//   3. FAÇADE           — discovery + public API (initVisualizations, draw,
//                          idle, registerCanvas, setPalette, …).
//
// Loaded once on the main thread. The worker entry (viz-worker.js) stays
// separate because it runs in a different realm.

import { playerState } from './state.js';
import {
    DEFAULT_VIZ_PALETTE,
    rgbOf,
    registerCanvas as cacheCanvas,
    clearCanvasCache as cacheClear,
    invalidateCanvasSizes as cacheInvalidate,
    getChannelVolumes,
    setPalette as applyPalette,
} from './viz-core.js';


// ============================================================================
// 1. PALETTE READER  (CSS custom properties → palette object)
// ============================================================================

function readString(cs, name, fallback) {
    const raw = cs.getPropertyValue(name);
    return raw && raw.trim() !== '' ? raw.trim() : fallback;
}

// "r, g, b" → {r, g, b}.
function readTriplet(cs, name, fallback) {
    const raw = cs.getPropertyValue(name);
    if (!raw || raw.trim() === '') return fallback;
    const parts = raw.split(',').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 3 || parts.some(Number.isNaN)) return fallback;
    return { r: parts[0], g: parts[1], b: parts[2] };
}

// Rec. 601 luminance (coarse "same shade?" — no gamma needed).
function luminance(rgb) {
    return (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) / 255;
}

const CONTRAST_MIN = 0.20;

// Unparseable colours assumed safe — can't reason about them.
function collides(a, b) {
    const ra = rgbOf(a);
    const rb = rgbOf(b);
    if (!ra || !rb) return false;
    return Math.abs(luminance(ra) - luminance(rb)) < CONTRAST_MIN;
}

// Rescue when --viz-ink itself collides with the bg.
function autoInk(bg) {
    const rgb = rgbOf(bg);
    return rgb && luminance(rgb) > 0.5 ? '#1a1a1a' : '#ffffff';
}

// Rescue --viz-ink first so others can fall back to a known-good ink.
function applyContrastSafety(p) {
    if (collides(p.vizInk, p.vizCanvasBg)) {
        const fixed = autoInk(p.vizCanvasBg);
        console.warn(
            `viz palette: --viz-ink (${p.vizInk}) collides with --viz-canvas-bg `
            + `(${p.vizCanvasBg}); auto-substituting ${fixed}. Add an explicit `
            + `--viz-ink override in the theme's CSS to silence this.`,
        );
        p.vizInk = fixed;
    }
    if (collides(p.vizSecondary, p.vizCanvasBg)) {
        console.warn(
            `viz palette: --viz-secondary (${p.vizSecondary}) collides with `
            + `--viz-canvas-bg (${p.vizCanvasBg}); auto-substituting --viz-ink `
            + `(${p.vizInk}). Pick a more contrasting --viz-secondary to silence this.`,
        );
        p.vizSecondary = p.vizInk;
    }
    if (collides(p.vizPrimary, p.vizCanvasBg)) {
        console.warn(
            `viz palette: --viz-primary (${p.vizPrimary}) collides with `
            + `--viz-canvas-bg (${p.vizCanvasBg}); auto-substituting --viz-ink `
            + `(${p.vizInk}). Pick a more contrasting --viz-primary to silence this.`,
        );
        p.vizPrimary = p.vizInk;
    }
    return p;
}

// Must be called AFTER the theme-<id> class swap so rules have cascaded.
export function vizPaletteFromCss() {
    const cs = getComputedStyle(document.documentElement);
    const d = DEFAULT_VIZ_PALETTE;
    const p = {
        vizPrimary:   readString(cs, '--viz-primary',   d.vizPrimary),
        vizSecondary: readString(cs, '--viz-secondary', d.vizSecondary),
        vizGlow:      readString(cs, '--viz-glow',      d.vizGlow),
        vizGrid:      readString(cs, '--viz-grid',      d.vizGrid),
        vizGridSoft:  readString(cs, '--viz-grid-soft', d.vizGridSoft),
        vizCanvasBg:  readString(cs, '--viz-canvas-bg', d.vizCanvasBg),
        vizInk:       readString(cs, '--viz-ink',       d.vizInk),
        vuLow:        readString(cs, '--vu-low',        d.vuLow),
        vuMid:        readString(cs, '--vu-mid',        d.vuMid),
        vuHigh:       readString(cs, '--vu-high',       d.vuHigh),
        volCold:      readTriplet(cs, '--viz-vol-cold', d.volCold),
        volMid:       readTriplet(cs, '--viz-vol-mid',  d.volMid),
        volHot:       readTriplet(cs, '--viz-vol-hot',  d.volHot),
    };
    return applyContrastSafety(p);
}


// ============================================================================
// 2. RENDERER HOSTS  (Worker preferred; main-thread fallback)
// ============================================================================

const DEFAULT_CANVAS_BG = '#1f2937';
function readCanvasBg() {
    if (typeof document === 'undefined') return DEFAULT_CANVAS_BG;
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--viz-canvas-bg')
        .trim();
    return value || DEFAULT_CANVAS_BG;
}

// ---- Worker host -------------------------------------------------------

// 30 Hz throttle (audio 60 Hz / 2). Integer frame-skip stays phase-locked.
const VIZ_FRAME_SKIP = 2;
const PRIMING_KEYS = null;

function createWorkerHost() {
    const worker = new Worker(
        new URL('./viz-worker.js', import.meta.url),
        { type: 'module' },
    );

    // Without these, a hard error inside the worker silently kills rendering
    // with no console feedback. Per-viz errors are already caught inside the
    // worker; this only fires for top-level / module-load / OOM failures.
    worker.onerror = (e) => {
        const where = e.filename ? ` @ ${e.filename}:${e.lineno}` : '';
        console.error(`viz worker error${where}: ${e.message || e}`);
    };
    worker.onmessageerror = (e) => {
        console.error('viz worker message deserialisation error', e);
    };

    // DOM ref kept only for CSS-size queries during layout changes.
    const domCanvases = new Map();

    let mutedScratch = [];

    let drawTickCounter = 0;

    function packMuted(mutedSet) {
        mutedScratch.length = 0;
        if (!mutedSet) return mutedScratch;
        for (const id of mutedSet) mutedScratch.push(id);
        return mutedScratch;
    }

    function registerCanvas(col, canvas) {
        // tracker re-creates canvases per song load so they're always fresh.
        const width  = canvas.offsetWidth  || canvas.clientWidth  || canvas.width;
        const height = canvas.offsetHeight || canvas.clientHeight || canvas.height;
        const bg = readCanvasBg();
        const offscreen = canvas.transferControlToOffscreen();
        domCanvases.set(col, canvas);
        worker.postMessage(
            { cmd: 'registerCanvas', col, canvas: offscreen, width, height, bg },
            [offscreen],
        );
    }

    function clearCanvasCache() {
        domCanvases.clear();
        worker.postMessage({ cmd: 'clearCanvasCache' });
    }

    function invalidateCanvasSizes() {
        if (domCanvases.size === 0) return;
        const sizes = [];
        for (const [col, canvas] of domCanvases) {
            const w = canvas.offsetWidth || canvas.clientWidth;
            const h = canvas.offsetHeight || canvas.clientHeight;
            if (!w || !h) continue;
            sizes.push({ col, width: w, height: h });
        }
        if (sizes.length === 0) return;
        worker.postMessage({ cmd: 'invalidateSizes', sizes });
    }

    function draw(song, chVol, mutedSet, vizId) {
        if (drawTickCounter++ % VIZ_FRAME_SKIP !== 0) return;
        worker.postMessage({
            cmd: 'draw',
            channels: song.channels,
            chVol,
            mutedIds: packMuted(mutedSet),
            vizId,
        });
    }

    function idle(song, _chVol, mutedSet, vizId) {
        worker.postMessage({
            cmd: 'idle',
            channels: song.channels,
            mutedIds: packMuted(mutedSet),
            vizId,
        });
    }

    function preload(vizId) {
        worker.postMessage({ cmd: 'preload', vizId });
    }

    function setPalette(palette) {
        worker.postMessage({ cmd: 'setPalette', palette });
    }

    // Worker can't fetch its own listing — main thread is the SoT.
    function setManifest(manifest) {
        worker.postMessage({ cmd: 'setManifest', manifest });
    }

    if (PRIMING_KEYS) {
        for (const k of PRIMING_KEYS) preload(k);
    }

    return { registerCanvas, clearCanvasCache, invalidateCanvasSizes, draw, idle, preload, setPalette, setManifest };
}

// ---- Main-thread renderer (fallback when OffscreenCanvas unavailable) --

// Mirrors the worker's per-viz error isolation. Disabled-set lookup is one
// Set.has on the happy path — no measurable cost. After N throws we stop
// calling the viz so it can't spam the console / deopt the hot loop.
const MAIN_MAX_VIZ_ERRORS = 3;

function createMainRenderer() {
    // Manifest populated post-discovery via setManifest. Draw before that is a no-op.
    let byId = Object.create(null);
    const loaded = new Map();
    const loading = new Map();
    const vizErrorCount = new Map();
    const disabledVizIds = new Set();

    function recordVizError(vizId, where, err) {
        const n = (vizErrorCount.get(vizId) || 0) + 1;
        vizErrorCount.set(vizId, n);
        console.error(`viz "${vizId}" ${where} error ${n}/${MAIN_MAX_VIZ_ERRORS}:`, err);
        if (n >= MAIN_MAX_VIZ_ERRORS) {
            disabledVizIds.add(vizId);
            console.warn(`viz "${vizId}" disabled (main thread) after ${MAIN_MAX_VIZ_ERRORS} errors. Reload to retry.`);
        }
    }

    function setManifest(manifest) {
        byId = Object.create(null);
        for (const entry of manifest) byId[entry.id] = entry;
    }

    function ensureLoaded(id) {
        if (loaded.has(id)) return Promise.resolve(loaded.get(id));
        if (loading.has(id)) return loading.get(id);

        const entry = byId[id];
        if (!entry) {
            console.warn(`Visualization "${id}" not found.`);
            return Promise.resolve(null);
        }

        const p = import(entry.url)
            .then(mod => {
                loaded.set(id, mod);
                loading.delete(id);
                return mod;
            })
            .catch(err => {
                console.error(`Failed to load visualization "${id}":`, err);
                loading.delete(id);
                return null;
            });
        loading.set(id, p);
        return p;
    }

    return {
        setManifest,
        registerCanvas(col, canvas) {
            cacheCanvas(col, canvas, { bg: readCanvasBg() });
        },
        clearCanvasCache() {
            cacheClear();
        },
        invalidateCanvasSizes() {
            cacheInvalidate();
        },
        draw(song, chVol, mutedSet, vizId) {
            if (disabledVizIds.has(vizId)) return;
            const mod = loaded.get(vizId);
            if (mod) {
                const volumes = getChannelVolumes(song, chVol, mutedSet);
                try {
                    mod.draw(song, volumes);
                } catch (err) {
                    recordVizError(vizId, 'draw', err);
                }
                return;
            }
            ensureLoaded(vizId);
        },
        idle(song, _chVol, _mutedSet, vizId) {
            if (disabledVizIds.has(vizId)) return;
            const mod = loaded.get(vizId);
            if (mod) {
                if (mod.idle) {
                    try { mod.idle(song); }
                    catch (err) { recordVizError(vizId, 'idle', err); }
                }
                return;
            }
            ensureLoaded(vizId).then(loadedMod => {
                if (!loadedMod?.idle || disabledVizIds.has(vizId)) return;
                try { loadedMod.idle(song); }
                catch (err) { recordVizError(vizId, 'idle', err); }
            });
        },
        preload(vizId) {
            ensureLoaded(vizId);
        },
        setPalette(palette) {
            applyPalette(palette);
        },
    };
}


// ============================================================================
// 3. FAÇADE  (discovery + public API + renderer selection)
// ============================================================================

const RX_NAME = /export\s+const\s+name\s*=\s*["']([^"'\n]+)["']/;

// Absolute URL — worker would otherwise resolve against the worker script's URL.
function vizUrlFor(id) {
    return new URL(`./js/visualizations/${id}.js`, document.baseURI).href;
}

const FALLBACK_MANIFEST = Object.freeze([Object.freeze({
    id: 'spectrum-analyzer',
    name: 'Spectrum Analyzer',
    url: '',
})]);

function titleCase(id) {
    return id
        .split(/[-_]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

async function listJsFiles() {
    const res = await fetch('./js/visualizations/', { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`js/visualizations/ listing returned HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ids = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
        // a.href returns "about:blank/<file>" — use raw attribute.
        const href = a.getAttribute('href') || '';
        const base = href.split('?')[0].split('#')[0].split('/').pop();
        if (!base || !base.endsWith('.js')) continue;
        ids.add(base.slice(0, -3));
    }
    if (ids.size === 0) throw new Error('js/visualizations/ listing parsed to zero .js files');
    return [...ids].map(id => ({ id, url: vizUrlFor(id) }));
}

async function readVizName({ id, url }) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`viz ${id}: HTTP ${res.status}`);
    const text = await res.text();
    const head = text.slice(0, 2048);
    const name = (head.match(RX_NAME)?.[1] || titleCase(id)).trim();
    return { id, url, name };
}

async function discoverVisualizations() {
    try {
        const files = await listJsFiles();
        const list = await Promise.all(files.map(readVizName));
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return list;
    } catch (err) {
        console.warn('Visualization discovery failed; using fallback list:', err);
        return FALLBACK_MANIFEST.map(v => ({ ...v, url: vizUrlFor(v.id) }));
    }
}

const CAN_USE_WORKER = (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype
);

// new Worker can throw synchronously in sandbox/CSP contexts.
function makeRenderer() {
    if (!CAN_USE_WORKER) return createMainRenderer();
    try {
        return createWorkerHost();
    } catch (e) {
        console.warn('Visualization worker unavailable; falling back to main thread.', e);
        return createMainRenderer();
    }
}

const renderer = makeRenderer();

// ---- Public API -------------------------------------------------------

// Live references — consumers that snapshot at import time still see updates.
export const availableVisualizations = [];
export const visualizationNames = {};

export async function initVisualizations() {
    const manifest = await discoverVisualizations();
    availableVisualizations.length = 0;
    for (const key of Object.keys(visualizationNames)) delete visualizationNames[key];
    for (const v of manifest) {
        availableVisualizations.push(v.id);
        visualizationNames[v.id] = v.name;
    }
    renderer.setManifest(manifest);
    return manifest;
}

export function registerCanvas(col, canvas) {
    renderer.registerCanvas(col, canvas);
}

export function clearCanvasCache() {
    renderer.clearCanvasCache();
}

export function invalidateCanvasSizes() {
    renderer.invalidateCanvasSizes();
}

// vizNames: string id or 1-element array.
export function updateVisualizations(song, chVol, vizNames) {
    if (!vizNames || vizNames.length === 0) return;
    const id = Array.isArray(vizNames) ? vizNames[0] : vizNames;
    renderer.draw(song, chVol, playerState.mutedChannels, id);
}

// Idle frame (stopped / paused / just-loaded).
export function clearVisualizations(song, vizNames) {
    if (!vizNames || vizNames.length === 0) return;
    const id = Array.isArray(vizNames) ? vizNames[0] : vizNames;
    renderer.idle(song, null, playerState.mutedChannels, id);
}

export function setVisualizationPalette(palette) {
    renderer.setPalette(palette);
}
