// Viz core: the shared infrastructure that runs in BOTH the main thread
// and the OffscreenCanvas worker, plus every viz file. Layered:
//
//   1. COLORS    — palette tokens + live ES-module bindings + setPalette()
//   2. VOLUMES   — chVol Float32Array → per-channel { l, r, max, avg } pool
//   3. UTILS     — canvas cache, defineVisualization factory, draw helpers
//   4. STATE     — shared per-channel state pools (particles, etc.)
//
// Keeping the four layers in one file means viz files do a single import
// and the worker only loads one module. See docs/VISUALIZATIONS.md.


// ============================================================================
// 1. COLORS  (live-binding palette; setPalette() rebinds module locals)
// ============================================================================

export const DEFAULT_VIZ_PALETTE = Object.freeze({
    vizPrimary:   '#00a1ce',
    vizSecondary: '#00ffff',
    vizGlow:      'rgba(136, 136, 255, 0.5)',
    vizGrid:      'rgba(136, 255, 255, 0.5)',
    vizGridSoft:  'rgba(136, 255, 255, 0.3)',

    vizCanvasBg:  '#1f2937',
    vizInk:       '#ffffff',

    volCold: { r: 136, g: 136, b: 255 },
    volMid:  { r: 136, g: 255, b: 255 },
    volHot:  { r: 255, g:  64, b:  64 },

    vuLow:  '#4ade80',
    vuMid:  '#facc15',
    vuHigh: '#ef4444',
});

// Behaviour thresholds — never themed.
export const vuLowThreshold = 0.6;
export const vuMidThreshold = 0.8;

export let vizPrimary   = DEFAULT_VIZ_PALETTE.vizPrimary;
export let vizSecondary = DEFAULT_VIZ_PALETTE.vizSecondary;
export let vizGlow      = DEFAULT_VIZ_PALETTE.vizGlow;
export let vizGrid      = DEFAULT_VIZ_PALETTE.vizGrid;
export let vizGridSoft  = DEFAULT_VIZ_PALETTE.vizGridSoft;
export let vizCanvasBg  = DEFAULT_VIZ_PALETTE.vizCanvasBg;
export let vizInk       = DEFAULT_VIZ_PALETTE.vizInk;
export let vuLow        = DEFAULT_VIZ_PALETTE.vuLow;
export let vuMid        = DEFAULT_VIZ_PALETTE.vuMid;
export let vuHigh       = DEFAULT_VIZ_PALETTE.vuHigh;

let volCold = { ...DEFAULT_VIZ_PALETTE.volCold };
let volMid  = { ...DEFAULT_VIZ_PALETTE.volMid };
let volHot  = { ...DEFAULT_VIZ_PALETTE.volHot };

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// CSS colour string for volume ∈ [0, 1] via volumeRgb.
export function vuColorForVolume(volume, opacity = 1) {
    const { r, g, b } = volumeRgb(volume);
    return opacity === 1
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Three-stop cold → mid → hot interpolation.
export function volumeRgb(volume) {
    const t = Math.min(Math.max(volume, 0), 1);
    if (t < 0.5) {
        const k = t / 0.5;
        return {
            r: lerp(volCold.r, volMid.r, k),
            g: lerp(volCold.g, volMid.g, k),
            b: lerp(volCold.b, volMid.b, k),
        };
    }
    const k = (t - 0.5) / 0.5;
    return {
        r: lerp(volMid.r, volHot.r, k),
        g: lerp(volMid.g, volHot.g, k),
        b: lerp(volMid.b, volHot.b, k),
    };
}

// `#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)` → {r,g,b}. Cached. null on unparseable.
const _rgbCache = new Map();
export function rgbOf(color) {
    if (!color) return null;
    const cached = _rgbCache.get(color);
    if (cached !== undefined) return cached;
    let rgb = null;
    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        let h = hex[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        rgb = {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    } else {
        const fn = color.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
        if (fn) rgb = { r: +fn[1], g: +fn[2], b: +fn[3] };
    }
    _rgbCache.set(color, rgb);
    return rgb;
}

export const WHITE_RGB = Object.freeze({ r: 255, g: 255, b: 255 });

// Parse + apply alpha. Falls back to white on unparseable.
export function rgbaFromColor(color, alpha) {
    const c = rgbOf(color) ?? WHITE_RGB;
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

// Merge partial palette. Unknown keys ignored.
export function setPalette(palette) {
    if (!palette) return;
    if ('vizPrimary'   in palette) vizPrimary   = palette.vizPrimary;
    if ('vizSecondary' in palette) vizSecondary = palette.vizSecondary;
    if ('vizGlow'      in palette) vizGlow      = palette.vizGlow;
    if ('vizGrid'      in palette) vizGrid      = palette.vizGrid;
    if ('vizGridSoft'  in palette) vizGridSoft  = palette.vizGridSoft;
    if ('vizCanvasBg'  in palette) vizCanvasBg  = palette.vizCanvasBg;
    if ('vizInk'       in palette) vizInk       = palette.vizInk;
    if ('vuLow'        in palette) vuLow        = palette.vuLow;
    if ('vuMid'        in palette) vuMid        = palette.vuMid;
    if ('vuHigh'       in palette) vuHigh       = palette.vuHigh;
    if (palette.volCold) volCold = { ...palette.volCold };
    if (palette.volMid)  volMid  = { ...palette.volMid };
    if (palette.volHot)  volHot  = { ...palette.volHot };
}


// ============================================================================
// 2. VOLUMES  (chVol Float32Array → pooled per-channel volume snapshot)
// ============================================================================

// chVol from the worklet is packed as [ch0L, ch0R, ch1L, ch1R, …].

const _volPool = [];
let _volPooledFor = -1;

function ensureVolPool(channels) {
    if (_volPooledFor !== channels) {
        _volPool.length = 0;
        for (let i = 0; i < channels; i++) {
            _volPool.push({
                leftVolume: 0,
                rightVolume: 0,
                maxVolume: 0,
                averageVolume: 0,
                isMuted: false,
            });
        }
        _volPooledFor = channels;
    }
    return _volPool;
}

// Pool is shared — callers must not retain references past the current frame.
export function getChannelVolumes(song, chVol, mutedSet) {
    const channels = song.channels;
    const out = ensureVolPool(channels);
    const buf = chVol instanceof Float32Array ? chVol : null;
    for (let col = 0; col < channels; col++) {
        const left  = buf ? buf[2 * col]     : 0;
        const right = buf ? buf[2 * col + 1] : 0;
        const entry = out[col];
        entry.leftVolume = left;
        entry.rightVolume = right;
        entry.maxVolume = left > right ? left : right;
        entry.averageVolume = (left + right) * 0.5;
        entry.isMuted = mutedSet ? mutedSet.has(col) : false;
    }
    return out;
}


// ============================================================================
// 3. UTILS  (canvas cache, defineVisualization, draw helpers)
// ============================================================================

// IT caps modules at 64 channels.
export const MAX_CHANNELS = 64;

// Hot-path cache for --viz-canvas-bg. Invalidated when setPalette mutates it.
// The `rgb(...)` and `rgba(..., ` strings are kept alongside the {r,g,b} tuple
// so setupCanvas / fillBackground / drawDiagonalStripes don't have to rebuild
// a template literal every channel every frame (≈2000 string allocs/sec at
// 64 channels × 30 Hz, gone).
let _bgCacheSource = null;
let _bgCacheRgb = { r: 0, g: 0, b: 0 };
let _bgCacheRgbStr = 'rgb(0, 0, 0)';
let _bgCacheRgbaPrefix = 'rgba(0, 0, 0, ';
function refreshBgCache() {
    _bgCacheSource = vizCanvasBg;
    const rgb = rgbOf(vizCanvasBg) ?? WHITE_RGB;
    _bgCacheRgb = rgb;
    _bgCacheRgbStr = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    _bgCacheRgbaPrefix = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, `;
}
function canvasBgRgb() {
    if (_bgCacheSource !== vizCanvasBg) refreshBgCache();
    return _bgCacheRgb;
}
function canvasBgFillStyle() {
    if (_bgCacheSource !== vizCanvasBg) refreshBgCache();
    return _bgCacheRgbStr;
}
function canvasBgRgbaStyle(alpha) {
    if (_bgCacheSource !== vizCanvasBg) refreshBgCache();
    return _bgCacheRgbaPrefix + alpha + ')';
}

// Frozen so a viz can't accidentally mutate shared geometry (each .map()
// already returns a fresh array; freezing only blocks bugs, not the hot
// read path). V8 specialises frozen arrays for read-only access.
export const cubeVertices = Object.freeze([
    Object.freeze([-0.5, -0.5, -0.5]), Object.freeze([0.5, -0.5, -0.5]),
    Object.freeze([0.5, 0.5, -0.5]),   Object.freeze([-0.5, 0.5, -0.5]),
    Object.freeze([-0.5, -0.5, 0.5]),  Object.freeze([0.5, -0.5, 0.5]),
    Object.freeze([0.5, 0.5, 0.5]),    Object.freeze([-0.5, 0.5, 0.5]),
]);
export const cubeEdges = Object.freeze([
    Object.freeze([0, 1]), Object.freeze([1, 2]), Object.freeze([2, 3]), Object.freeze([3, 0]),
    Object.freeze([4, 5]), Object.freeze([5, 6]), Object.freeze([6, 7]), Object.freeze([7, 4]),
    Object.freeze([0, 4]), Object.freeze([1, 5]), Object.freeze([2, 6]), Object.freeze([3, 7]),
]);

// 4 outer vertices + centroid at index 4.
export const tetraVertices = Object.freeze([
    Object.freeze([0, 0, 1]),
    Object.freeze([0.816, 0, -0.333]),
    Object.freeze([-0.408, 0.707, -0.333]),
    Object.freeze([-0.408, -0.707, -0.333]),
]);
export const tetraCentroid = Object.freeze([0, 0, 0]);
export const tetraEdges = Object.freeze([
    Object.freeze([0, 1]), Object.freeze([0, 2]), Object.freeze([0, 3]),
    Object.freeze([1, 2]), Object.freeze([1, 3]), Object.freeze([2, 3]),
    Object.freeze([0, 4]), Object.freeze([1, 4]), Object.freeze([2, 4]), Object.freeze([3, 4]),
]);

// Returned closure caches sin/cos — amortize trig cost across vertices.
export function make3DProjector(rx, ry, rz, scale, width, height) {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const fov = 40;
    const d = 0.8;
    const halfW = width / 2;
    const halfH = height / 2;
    return ([x, y, z]) => {
        let ny = y * cx - z * sx;
        let nz = y * sx + z * cx;
        y = ny; z = nz;
        let nx = x * cy + z * sy;
        nz = -x * sy + z * cy;
        x = nx; z = nz;
        nx = x * cz - y * sz;
        ny = x * sz + y * cz;
        x = nx; y = ny;
        const f = fov / (fov + z * d + 0.3);
        return [x * f * scale + halfW, y * f * scale + halfH, z];
    };
}

// Back-to-front for painter's algorithm.
export function sortEdgesByDepth(edgeList, projected) {
    return edgeList
        .map(edge => {
            const [i, j] = edge;
            return {
                edge,
                avgZ: (projected[i][2] + projected[j][2]) / 2,
                isInner: i === 4 || j === 4,
            };
        })
        .sort((a, b) => b.avgZ - a.avgZ);
}

// ---- Canvas cache ------------------------------------------------------

const canvasCache = new Map(); // col -> { canvas, ctx, width, height }

// canvas: HTMLCanvasElement (main) or OffscreenCanvas (worker).
// options.bg: initial fill so the canvas doesn't flash opaque-black on first frame.
export function registerCanvas(col, canvas, options = {}) {
    // alpha: false skips compositor blending — wins across 32+ canvases at 60 Hz.
    const ctx = canvas.getContext('2d', { alpha: false });
    const width  = options.width  ?? canvas.offsetWidth  ?? canvas.clientWidth  ?? canvas.width;
    const height = options.height ?? canvas.offsetHeight ?? canvas.clientHeight ?? canvas.height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvasCache.set(col, { canvas, ctx, width, height });

    if (options.bg) {
        ctx.fillStyle = options.bg;
        ctx.fillRect(0, 0, width, height);
    }
}

export function clearCanvasCache() {
    canvasCache.clear();
}

// Explicit `sizes` for worker path; DOM re-read for main-thread path.
export function invalidateCanvasSizes(sizes) {
    if (sizes) {
        for (let i = 0; i < sizes.length; i++) {
            const { col, width, height } = sizes[i];
            const entry = canvasCache.get(col);
            if (!entry) continue;
            if (width !== entry.width || height !== entry.height) {
                entry.canvas.width = width;
                entry.canvas.height = height;
                entry.width = width;
                entry.height = height;
            }
        }
        return;
    }
    for (const entry of canvasCache.values()) {
        const w = entry.canvas.offsetWidth || entry.canvas.clientWidth;
        const h = entry.canvas.offsetHeight || entry.canvas.clientHeight;
        if (w !== entry.width || h !== entry.height) {
            entry.canvas.width = w;
            entry.canvas.height = h;
            entry.width = w;
            entry.height = h;
        }
    }
}

// Returns { ctx, width, height } or null when unregistered.
export function setupCanvas(col, options) {
    const entry = canvasCache.get(col);
    if (!entry) return null;
    const { ctx, width, height } = entry;
    ctx.fillStyle = canvasBgFillStyle();
    ctx.fillRect(0, 0, width, height);
    if (options && options.crtEffect) drawCrtMotif(ctx, width, height, options.crtEffect);
    return entry;
}

function drawCrtMotif(ctx, width, height, motif) {
    ctx.strokeStyle = '#4a4a4a';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    switch (motif) {
        case 'circle':
            ctx.arc(width / 2, height / 2, 8, 0, Math.PI * 2);
            break;
        case 'hline':
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            break;
        case 'vline':
            ctx.moveTo(width / 2, 0);
            ctx.lineTo(width / 2, height);
            break;
        case 'boxlines':
            ctx.moveTo(width / 2, 0);
            ctx.lineTo(width / 2, height);
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width / 2, height / 2);
            ctx.moveTo(width / 2, height / 2);
            ctx.lineTo(width, height / 2);
            break;
        case 'topbottom':
            ctx.moveTo(0, 0);
            ctx.lineTo(width, 0);
            ctx.moveTo(0, height);
            ctx.lineTo(width, height);
            break;
    }
    ctx.stroke();
}

// ---- Visualization factory ---------------------------------------------

// drawMuted / drawIdle share fallback: drawMuted ~60 Hz for muted channels;
// drawIdle is one-shot on state-change events.
export function defineVisualization({
    canvas = null,
    draw,
    drawMuted,
    drawIdle,
    background,
    resetState,
}) {
    const idleDraw = drawIdle ?? drawMuted;
    const muteDraw = drawMuted ?? drawIdle;
    return {
        draw: makeDrawFrame(canvas, background, draw, muteDraw, resetState),
        idle: makeIdleFrame(canvas, background, idleDraw, resetState),
    };
}

function makeDrawFrame(canvas, background, draw, drawMuted, resetState) {
    return function drawFrame(song, volumes) {
        const channels = song.channels;
        for (let col = 0; col < channels; col++) {
            const entry = setupCanvas(col, canvas);
            if (!entry) continue;
            if (background) background(entry, col);
            const vol = volumes[col];
            if (vol.isMuted) {
                if (resetState) resetState(col);
                if (drawMuted) drawMuted(entry, col);
                continue;
            }
            draw(entry, vol, col);
        }
    };
}

function makeIdleFrame(canvas, background, drawIdle, resetState) {
    return function idleFrame(song) {
        const channels = song.channels;
        for (let col = 0; col < channels; col++) {
            const entry = setupCanvas(col, canvas);
            if (!entry) continue;
            if (background) background(entry, col);
            if (resetState) resetState(col);
            if (drawIdle) drawIdle(entry, col);
        }
    };
}

// ---- 3D rotating state -------------------------------------------------

const ROTATION_JITTER = 0.15;
const ROTATION_SPEED  = 3;

export function initRotatingState(state) {
    if (state.time === undefined) state.time = 0;
    if (!state.randomOffset) {
        state.randomOffset = {
            x: (Math.random() - 0.5) * ROTATION_JITTER,
            y: (Math.random() - 0.5) * ROTATION_JITTER,
            z: (Math.random() - 0.5) * ROTATION_JITTER,
        };
    }
    if (!state.rotationSpeeds) {
        state.rotationSpeeds = {
            x: (Math.random() * ROTATION_SPEED + 0.8) * (Math.random() < 0.5 ? 1 : -1),
            y: (Math.random() * ROTATION_SPEED + 0.9) * (Math.random() < 0.5 ? 1 : -1),
            z: (Math.random() * ROTATION_SPEED + 0.7) * (Math.random() < 0.5 ? 1 : -1),
        };
    }
    if (!state.trail) state.trail = [];
}

export function rotationsForFrame(state) {
    const t = state.time;
    const off = state.randomOffset;
    const sp = state.rotationSpeeds;
    return {
        rx: t * sp.x + Math.sin(t * 1.5) * off.x,
        ry: t * sp.y + Math.cos(t * 1.6) * off.y,
        rz: t * sp.z + Math.sin(t * 1.4) * off.z,
    };
}

// ---- Particle lifecycle ------------------------------------------------

// In-place update/draw/cull. Avoids .filter() / .shift() allocations.
// cap: max retained; oldest dropped.
export function stepParticles(bucket, { update, isAlive, draw, cap = Infinity }) {
    let w = 0;
    for (let i = 0; i < bucket.length; i++) {
        const p = bucket[i];
        update(p);
        if (isAlive(p)) {
            draw(p);
            bucket[w++] = p;
        }
    }
    if (w > cap) {
        const drop = w - cap;
        for (let i = 0; i < cap; i++) bucket[i] = bucket[i + drop];
        bucket.length = cap;
    } else {
        bucket.length = w;
    }
}

// ---- Draw helpers ------------------------------------------------------

export function applyVHSGlitch(ctx, width, height) {
    if (Math.random() < 0.15) {
        const offset = Math.random() * 10 - 5;
        ctx.fillStyle = 'rgba(255, 0, 0, 0.1)';
        ctx.fillRect(offset, 0, width, height);
    }
}

export function drawGridBackground(ctx, width, height) {
    ctx.strokeStyle = vizGridSoft;
    ctx.lineWidth = 0.5;
    for (let y = 0; y <= height; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    for (let x = 0; x <= width; x += 15) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
}

// Stripes in --viz-canvas-bg — punches gaps through a coloured bar.
export function drawDiagonalStripes(ctx, width, height) {
    ctx.fillStyle = canvasBgFillStyle();
    const stripeWidth = 2;
    const stripeSpacing = 6;
    const tan = 1;
    for (let x = -height; x < width + height; x += stripeSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + height * tan, height);
        ctx.lineTo(x + height * tan + stripeWidth, height);
        ctx.lineTo(x + stripeWidth, 0);
        ctx.closePath();
        ctx.fill();
    }
}

export function drawNoSignalBars(ctx, width, height) {
    const numBars = 10;
    const barWidth = width / numBars - 2;
    ctx.fillStyle = vizGridSoft;
    for (let i = 0; i < numBars; i++) {
        const barHeight = height * 0.1;
        const x = i * (barWidth + 2);
        const y = height - barHeight;
        ctx.fillRect(x, y, barWidth, barHeight);
    }
    ctx.fillStyle = vizGridSoft;
    ctx.font = '10px monospace';
    ctx.fillText('NO SIGNAL', width / 2 - 25, height / 2);
}

// One random phase per line, not per point — cheap analog wobble.
export function drawOscilloscopeLine(ctx, x0, w, h, volume, strokeStyle, freqDelta) {
    const baseFrequency = 0.5;
    const points = 50;
    const phase = Math.random() * Math.PI;
    const amp = h * 0.4 * volume;
    const halfH = h / 2;
    const freq = baseFrequency + freqDelta;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
        const x = x0 + (i / points) * w;
        const y = halfH - Math.sin(i * freq + phase) * amp;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

// Fades older content toward --viz-canvas-bg for motion trails.
export function fillBackground(ctx, width, height, alpha = 0.9) {
    ctx.fillStyle = canvasBgRgbaStyle(alpha);
    ctx.fillRect(0, 0, width, height);
}


// ============================================================================
// 4. STATE  (shared per-channel pools — opt-in by viz files)
// ============================================================================

const _makeArrayState  = () => Array(MAX_CHANNELS).fill().map(() => []);
const _makeObjectState = () => Array(MAX_CHANNELS).fill().map(() => ({}));
const _makeNumberState = (value = 0) => Array(MAX_CHANNELS).fill(value);

export const ripplesByChannel    = _makeArrayState();
export const particlesByChannel  = _makeArrayState();
export const tendrilsByChannel   = _makeArrayState();
export const embersByChannel     = _makeArrayState();
export const emojisByChannel     = _makeArrayState();

export const nebulaStateByChannel = _makeObjectState();
export const cubeStateByChannel   = _makeObjectState();
export const tetraStateByChannel  = _makeObjectState();

export const needleAngles = _makeNumberState(0);
export const lastVolumes  = _makeNumberState(0);

export const emojiSet = ['😆', '🎉', '🥳', '🚀', '🌟', '😎'];
