// Tracker UI: channel headers, pattern grid (triple-buffered), sample list.

import { $, $$, el, show } from './dom.js';
import { hb, padNumber, renderNote } from './format.js';
import { playerState } from './state.js';
import { prefs } from './prefs.js';
import {
    registerCanvas,
    clearCanvasCache,
    invalidateCanvasSizes,
} from './viz-engine.js';

// Two Sets so updateUsedSamples can swap roles each tick (no per-frame alloc).
let sampleItemsById = {};
let channelSampleId = [];
let highlightedSampleIds = new Set();
let pendingSampleIds = new Set();

// Triple-buffered grids, one per order slot: previous (ghost), current,
// next (ghost). They are stacked in #trackerPatterns in that DOM order so
// the pattern view reads as one continuous scroll across order boundaries.
// Grids are keyed by ORDER, not pattern index: consecutive orders can play
// the same pattern, and a cached pattern can be relabelled to a new order
// without rebuilding it. A grid with order === -1 is unassigned (hidden)
// but may still cache a pattern's DOM for reuse.
const grids = [];
// Off by default: only the active grid is shown (classic one-pattern view); the
// neighbours are still prefetched so the boundary swap stays hot.
let ghostOrders = false;
let prevGrid   = null;
let activeGrid = null;
let nextGrid   = null;

// Ghost prefetch: [{ grid, order }], drained one item per idle callback.
let prefetchQueue = [];
let prefetchIdleHandle = -1;

let lastDrawnPattern = -1;
let lastDrawnRow = -1;
let lastRowEls = null;

// Throttle the sample-list highlight on unchanged rows (~20 Hz).
const SAMPLE_THROTTLE_DIVISOR = 3;
let sampleUpdateCounter = 0;

let currentOrder = 0;

// Status-bar text fields are static elements in index.html — never replaced,
// just rewritten. We resolve each selector to its node on first write and
// cache it alongside the last-written text. After the first frame, the hot
// update path is one property lookup + one string compare + (when changed)
// one textContent write — zero DOM queries.
const statusFields = Object.create(null);

// Row height in px (also the height of each grid's order-break line).
let scrollOffset = 18;
// Vertical padding + border of the outermost grids (see .grid-top/.grid-bottom).
let gridPadTop = 4;
let gridPadBottom = 4;
// Cached at cold loads and relayouts so the hot swap path never reads layout.
let viewMetrics = { headerH: 0, viewportH: 0 };

let trackerMainEl = null;
function getTrackerMain() {
    if (!trackerMainEl) trackerMainEl = $('.tracker-main');
    return trackerMainEl;
}

let trackerHeaderEl = null;
function getTrackerHeader() {
    if (!trackerHeaderEl) trackerHeaderEl = $('#trackerHeader');
    return trackerHeaderEl;
}

// Public: build the whole tracker for a freshly loaded song.
export function renderTracker(meta) {
    if (!meta || !meta.song) return;

    const song = meta.song;
    playerState.resetChannelMutes();

    ensureChannelMuteRules();

    resetGrids(song);
    clearCanvasCache();
    renderHeaders(song.channels);
    renderSamples(song);
    refreshMutedChannelsAttribute();

    lastDrawnPattern = -1;
    lastDrawnRow = -1;
    invalidateStatusCache();

    requestAnimationFrame(() => resetTracker(meta));
}

const MIN_CHANNEL_WIDTH = 70;

function gridTemplate(channels) {
    return `var(--row-label-col, 20px) repeat(${channels}, minmax(${MIN_CHANNEL_WIDTH}px, 1fr))`;
}

// Public: reset to the song's starting position. Drives placeholder + real loads.
export function resetTracker(meta) {
    if (!meta || !meta.song) return;
    const song = meta.song;
    const firstPattern = song.orders[0];
    const placeholder = meta.isPlaceholder === true;

    invalidateStatusCache();

    if (!placeholder) {
        writeIfChanged('#songName', meta.title || '-');
        writeIfChanged('#channels', String(song.channels));
        writeIfChanged('#samples', String(song.samples.length));

        writeIfChanged('#order', `01 / ${padNumber(song.totalOrders)}`);
        writeIfChanged('#pattern', hb(firstPattern));
        writeIfChanged('#row', '00');
        writeIfChanged('#bpm', String(song.bpm));
    }

    lastDrawnPattern = -1;
    lastDrawnRow = -1;
    currentOrder = 0;

    layoutGrids(song);
    showPattern(song, firstPattern, 0);
    clearSampleHighlights();
    updateCurrentRow(firstPattern, 0);
}

// Public: jump to a specific order. Returns the shown order (clamped).
export function jumpToOrder(song, targetOrder) {
    if (!song || !song.orders) return currentOrder;
    const clamped = Math.max(0, Math.min(song.totalOrders - 1, targetOrder));
    const pattern = song.orders[clamped];
    if (pattern == null) return currentOrder;

    // Keep shared state in sync so Play resumption doesn't snap back.
    const prev = playerState.modpos || {};
    playerState.modpos = {
        ...prev,
        order: clamped,
        pattern,
        row: 0,
        bpm: prev.bpm ?? song.bpm,
        chVol: prev.chVol,
    };

    // Arm the stale-pos filter in index.js#onProgress. See state.js#pendingJumpOrder.
    playerState.pendingJumpOrder = clamped;

    showPattern(song, pattern, clamped);
    updateCurrentRow(pattern, 0);
    writeIfChanged('#order', `${padNumber(clamped + 1)} / ${padNumber(song.totalOrders)}`);
    writeIfChanged('#pattern', hb(pattern));
    writeIfChanged('#row', '00');

    currentOrder = clamped;
    return clamped;
}

export function getCurrentOrder() {
    return currentOrder;
}

// Public: show or hide the previous/next order around the current pattern.
export function setGhostOrdersVisible(visible) {
    ghostOrders = !!visible;
    if (!activeGrid) return;
    applyRoles();
    measureGeometry();
    applyGeometry();
    if (lastDrawnRow >= 0) centerRow(lastDrawnRow);
}

// Public: keyboard toggle — flips the pref and returns the new state.
export function toggleGhostOrders() {
    const visible = !prefs.ghostOrders;
    prefs.ghostOrders = visible;
    setGhostOrdersVisible(visible);
    return visible;
}

// Public: diagnostics — bounded by design (always 0–3). See ?diag.
export function getPatternCacheSize() {
    let n = 0;
    for (const g of grids) if (g.patternIndex !== -1) n++;
    return n;
}

// Public: diagnostics — bounded (0–2: the two ghost slots).
export function getRenderQueueSize() {
    return prefetchQueue.length;
}

// Public: called every animation frame while playing.
export function updateTrackerFrame(song, pos, volumes) {
    if (typeof pos.pattern !== 'number' || typeof pos.row !== 'number') return;

    // Stale-pos guard: a pos for the OUTGOING song can arrive between loads.
    if (pos.pattern < 0 || pos.pattern >= song.patterns.length) return;

    if (pos.pattern === lastDrawnPattern && pos.row === lastDrawnRow) {
        if (++sampleUpdateCounter % SAMPLE_THROTTLE_DIVISOR === 0) {
            updateUsedSamples(song, pos, volumes);
        }
        return;
    }

    const order = typeof pos.order === 'number' ? pos.order : currentOrder;
    if (!activeGrid || pos.pattern !== activeGrid.patternIndex || order !== activeGrid.order) {
        showPattern(song, pos.pattern, order);
    }

    updateCurrentRow(pos.pattern, pos.row);
    if (typeof pos.order === 'number') currentOrder = pos.order;
    writeIfChanged('#order', `${padNumber((pos.order ?? 0) + 1)} / ${padNumber(song.totalOrders)}`);
    writeIfChanged('#pattern', hb(pos.pattern));
    writeIfChanged('#row', hb(pos.row));
    writeIfChanged('#bpm', String(pos.bpm ?? song.bpm));

    sampleUpdateCounter = 0;
    updateUsedSamples(song, pos, volumes);
}

function writeIfChanged(selector, text) {
    let slot = statusFields[selector];
    if (slot === undefined) {
        const node = $(selector);
        if (!node) return;
        slot = statusFields[selector] = { node, lastText: null };
    }
    if (slot.lastText === text) return;
    slot.lastText = text;
    slot.node.textContent = text;
}

function invalidateStatusCache() {
    for (const k in statusFields) statusFields[k].lastText = null;
}

export function clearSampleHighlights() {
    for (const id of highlightedSampleIds) {
        sampleItemsById[id]?.classList.remove('highlighted');
    }
    highlightedSampleIds.clear();
    for (let i = 0; i < channelSampleId.length; i++) channelSampleId[i] = null;
}

// Public: funnel for layout-affecting changes (resize, theme/viz/samples toggle).
export function relayoutTracker() {
    if (!playerState.meta || !playerState.meta.song) return;
    layoutGrids(playerState.meta.song);

    measureGeometry();
    applyGeometry();
    invalidateCanvasSizes();

    if (activeGrid && activeGrid.patternIndex !== -1 && lastDrawnRow >= 0) {
        centerRow(lastDrawnRow);
    }
}

// Public: one attribute write — CSS does the cascade via the injected rules.
export function refreshMutedChannelsAttribute() {
    const main = getTrackerMain();
    if (!main) return;
    const muted = playerState.mutedChannels;
    if (muted.size === 0) {
        main.removeAttribute('data-muted');
        return;
    }
    let out = '';
    for (const ch of muted) out += (out ? ' ' : '') + ch;
    main.dataset.muted = out;
}

// 64 = libopenmpt channel ceiling for our formats.
let muteRulesInjected = false;
function ensureChannelMuteRules() {
    if (muteRulesInjected) return;
    muteRulesInjected = true;
    let css = '';
    for (let i = 0; i < 64; i++) {
        css += `.tracker-main[data-muted~="${i}"] [data-channel="${i}"]{opacity:.5;filter:grayscale(80%)}`;
    }
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
}

// ---- header / canvas registration --------------------------------------

function renderHeaders(channels) {
    const header = $('#trackerHeader');
    header.replaceChildren();
    header.style.display = 'none';

    // Synchronous so the next RAF measures the correct per-channel width.
    header.style.gridTemplateColumns = gridTemplate(channels);

    header.append(
        el('button', {
            type: 'button',
            class: 'header-label muteable',
            dataset: { channel: 'all', track: 'mute_all_clicked' },
            title: 'Click to mute or unmute all channels',
            'aria-label': 'Toggle all channels',
            'aria-pressed': 'false',
        }, `<i class="fa-solid fa-grip-lines-vertical header-label-icon" aria-hidden="true"></i>`),
    );

    for (let col = 0; col < channels; col++) {
        const id = `canvas${col}`;
        const button = el('button', {
            type: 'button',
            class: 'channel-cell channel-header muteable',
            dataset: { channel: col, track: 'mute_channel_clicked', trackChannel: col },
            'aria-label': `Toggle mute on channel ${col + 1}`,
            'aria-pressed': 'false',
        }, `
            <span data-col="${col}" class="channel-label">CH${col + 1}</span>
            <div class="canvas-parent">
                <canvas class="visualization-canvas" id="${id}" width="100%" height="100%"></canvas>
            </div>
        `);
        header.append(button);
    }

    header.style.display = 'grid';

    requestAnimationFrame(() => {
        for (let col = 0; col < channels; col++) {
            const canvas = document.getElementById(`canvas${col}`);
            if (canvas) registerCanvas(col, canvas);
        }
    });
}

// ---- pattern grid construction + lifecycle -----------------------------

function createEmptyGrid() {
    const elNode = document.createElement('div');
    elNode.className = 'tracker-grid';
    elNode.style.display = 'none';
    return {
        el: elNode,
        topSpacer: null,
        breakEl: null,
        bottomSpacer: null,
        rows: new Map(),
        order: -1,          // assigned order, -1 = unassigned (hidden)
        patternIndex: -1,   // cached pattern DOM, -1 = empty
        rowCount: 0,
        topPx: 0,
        bottomPx: 0,
    };
}

function resetGrids(song) {
    cancelPrefetch();
    const container = $('#trackerPatterns');
    grids.length = 0;
    for (let i = 0; i < 3; i++) grids.push(createEmptyGrid());
    [prevGrid, activeGrid, nextGrid] = grids;
    container.replaceChildren(prevGrid.el, activeGrid.el, nextGrid.el);

    const cols = gridTemplate(song.channels);
    for (const g of grids) g.el.style.gridTemplateColumns = cols;
    lastRowEls = null;
}

function breakLabel(song, order, patternIndex) {
    return `ORD ${padNumber(order + 1)} / ${padNumber(song.totalOrders)} · PAT ${hb(patternIndex)}`;
}

// Synchronous (~5–20 ms typical). innerHTML is ~3× faster than createElement here.
// Children layout: [topSpacer, break, ...rows*(N+1), bottomSpacer].
function populateGrid(target, song, patternIndex, order) {
    const rows = song.patterns[patternIndex];
    if (!rows) return false;
    const numChannels = song.channels;

    let html = `<div class="grid-spacer" style="height:0px"></div>`
             + `<div class="grid-break" style="height:${scrollOffset}px">${breakLabel(song, order, patternIndex)}</div>`;
    for (let row = 0; row < rows.length; row++) {
        html += `<div class="row-label" data-row="${row}">${hb(row)}</div>`;
        const rowCells = rows[row];
        for (let col = 0; col < numChannels; col++) {
            html += `<div class="channel-cell" data-channel="${col}" data-row="${row}">${renderNote(rowCells[col])}</div>`;
        }
    }
    html += `<div class="grid-spacer" style="height:0px"></div>`;

    target.el.innerHTML = html;
    target.el.dataset.pattern = patternIndex;
    target.el.style.gridTemplateColumns = gridTemplate(numChannels);

    target.topSpacer    = target.el.firstChild;
    target.breakEl      = target.topSpacer.nextSibling;
    target.bottomSpacer = target.el.lastChild;
    target.topPx        = 0;
    target.bottomPx     = 0;
    target.patternIndex = patternIndex;
    target.order        = order;
    target.rowCount     = rows.length;

    target.rows.clear();
    const cellsPerRow = numChannels + 1;
    const children = target.el.children;
    for (let row = 0; row < rows.length; row++) {
        const base = 2 + row * cellsPerRow;
        const arr = new Array(cellsPerRow);
        for (let k = 0; k < cellsPerRow; k++) arr[k] = children[base + k];
        target.rows.set(row, arr);
    }
    return true;
}

// Same pattern, different order: keep the DOM, rewrite the break line.
function relabelGrid(target, song, order) {
    target.order = order;
    if (target.breakEl) target.breakEl.textContent = breakLabel(song, order, target.patternIndex);
}

function unassignGrid(target) {
    target.order = -1;
    target.el.style.display = 'none';
}

// Assign the three grids to the prev/active/next slots around `order`.
// Reuses any grid already holding the wanted order, then any grid caching
// the wanted pattern (relabel), and builds the active grid synchronously
// only on a true cold miss. Ghost slots that end up empty are prefetched.
function assignGrids(song, order, patternIndex) {
    const prevOrder = order > 0 ? order - 1 : -1;
    const nextOrder = order + 1 < song.totalOrders ? order + 1 : -1;
    const wants = [
        { role: 'active', order, pattern: patternIndex },
        { role: 'next',   order: nextOrder, pattern: nextOrder === -1 ? null : song.orders[nextOrder] },
        { role: 'prev',   order: prevOrder, pattern: prevOrder === -1 ? null : song.orders[prevOrder] },
    ];
    for (const w of wants) {
        if (w.pattern != null && (w.pattern < 0 || w.pattern >= song.patterns.length)) w.pattern = null;
    }

    const free = new Set(grids);
    const pick = (fn) => { for (const g of free) if (fn(g)) { free.delete(g); return g; } return null; };

    // Pass 1: exact order+pattern match. Pass 2: cached pattern, relabel.
    for (const w of wants) {
        if (w.pattern == null) continue;
        w.grid = pick(g => g.order === w.order && g.patternIndex === w.pattern);
    }
    for (const w of wants) {
        if (w.pattern == null || w.grid) continue;
        w.grid = pick(g => g.patternIndex === w.pattern);
        if (w.grid) relabelGrid(w.grid, song, w.order);
    }
    // Pass 3: whatever is left. Active is built now; ghosts are queued.
    const pending = [];
    for (const w of wants) {
        if (w.grid) continue;
        w.grid = pick(() => true);
        if (w.pattern == null) {
            unassignGrid(w.grid);
        } else if (w.role === 'active') {
            populateGrid(w.grid, song, w.pattern, w.order);
        } else {
            unassignGrid(w.grid);
            pending.push({ grid: w.grid, order: w.order, deferrals: 0 });
        }
    }

    activeGrid = wants[0].grid;
    nextGrid   = wants[1].grid;
    prevGrid   = wants[2].grid;

    // DOM order must be prev, active, next. Writes only.
    const container = prevGrid.el.parentNode;
    const want = [prevGrid.el, activeGrid.el, nextGrid.el];
    for (let i = 0; i < want.length; i++) {
        if (container.children[i] !== want[i]) container.insertBefore(want[i], container.children[i] ?? null);
    }

    applyRoles();

    cancelPrefetch();
    prefetchQueue = pending;
    schedulePrefetch(song);
}

// Visibility, ghost/edge classes and spacer heights for the current roles.
function applyRoles() {
    const shown = [prevGrid, activeGrid, nextGrid].filter(isGridShown);
    const topGrid = shown[0];
    const bottomGrid = shown[shown.length - 1];
    for (const g of grids) {
        const isShown = isGridShown(g);
        const display = isShown ? 'grid' : 'none';
        if (g.el.style.display !== display) g.el.style.display = display;
        g.el.classList.toggle('ghost', g !== activeGrid);
        g.el.classList.toggle('grid-top', g === topGrid);
        g.el.classList.toggle('grid-bottom', g === bottomGrid);
    }
    applyGeometry();
}

function isGridShown(g) {
    return g.order !== -1 && (g === activeGrid || ghostOrders);
}

// Layout reads. Only from cold loads and relayouts — never the swap path.
function measureGeometry() {
    if (!activeGrid || !activeGrid.el) return;
    const rowLabel = activeGrid.el.querySelector('.row-label');
    if (rowLabel?.offsetHeight) scrollOffset = rowLabel.offsetHeight;

    const topEl = grids.find(g => g.el.classList.contains('grid-top'))?.el;
    const bottomEl = grids.find(g => g.el.classList.contains('grid-bottom'))?.el;
    if (topEl) {
        const cs = getComputedStyle(topEl);
        gridPadTop = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
    }
    if (bottomEl) {
        const cs = getComputedStyle(bottomEl);
        gridPadBottom = (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    }
    viewMetrics = {
        headerH: getTrackerHeader()?.offsetHeight ?? 0,
        viewportH: getTrackerMain()?.offsetHeight ?? window.innerHeight,
    };
}

// Writes only: break-line heights and the spacers that let row 0 / the last
// row of the active pattern reach the viewport centre. When a ghost is shown
// on that side, its rows count towards the padding and the spacer shrinks.
function applyGeometry() {
    const off = scrollOffset || 18;
    const breakH = ghostOrders ? off : 0;
    const half = (viewMetrics.viewportH - viewMetrics.headerH) / 2 - off / 2;
    const needTop    = Math.max(80, Math.floor(half - gridPadTop - breakH));
    const needBottom = Math.max(80, Math.floor(half - gridPadBottom));

    for (const g of grids) {
        if (!g.breakEl) continue;
        const h = breakH + 'px';
        if (g.breakEl.style.height !== h) g.breakEl.style.height = h;
    }
    if (!activeGrid || activeGrid.order === -1) return;

    let prevTop = 0, activeTop = needTop, activeBottom = needBottom, nextBottom = 0;
    if (isGridShown(prevGrid)) {
        prevTop = Math.max(0, needTop - breakH - prevGrid.rowCount * off);
        activeTop = 0;
    }
    if (isGridShown(nextGrid)) {
        nextBottom = Math.max(0, needBottom - breakH - nextGrid.rowCount * off);
        activeBottom = 0;
    }
    setSpacers(prevGrid, prevTop, 0);
    setSpacers(activeGrid, activeTop, activeBottom);
    setSpacers(nextGrid, 0, nextBottom);
}

function setSpacers(g, topPx, bottomPx) {
    if (!g.topSpacer) return;
    if (g.topPx !== topPx) {
        g.topPx = topPx;
        g.topSpacer.style.height = topPx + 'px';
    }
    if (g.bottomPx !== bottomPx) {
        g.bottomPx = bottomPx;
        g.bottomSpacer.style.height = bottomPx + 'px';
    }
}

// Hot path when the wanted order is already a ghost (no layout reads: the
// flush lands in centerRow via the next updateCurrentRow). Cold miss builds
// the active grid synchronously and re-measures.
function showPattern(song, patternIndex, order) {
    if (activeGrid.order === order && activeGrid.patternIndex === patternIndex) return;

    const cold = !grids.some(g => g.patternIndex === patternIndex);
    assignGrids(song, order, patternIndex);
    if (!cold) return;

    // applyGeometry ran against stale metrics (or an empty container).
    measureGeometry();
    applyGeometry();
    syncSampleListHeight();
}

//   y_of_row = headerH + padTop + [prev block] + activeTop + breakH (0 when ghosts are off)
//              + R*offset + offset/2
//   scrollTop = y_of_row - (headerH + viewportH) / 2
function centerRow(row) {
    const main = getTrackerMain();
    if (!main || !activeGrid || activeGrid.order === -1) return;
    const headerH = getTrackerHeader()?.offsetHeight ?? 0;
    const viewportH = main.offsetHeight;
    viewMetrics.headerH = headerH;
    viewMetrics.viewportH = viewportH;

    const off = scrollOffset;
    const breakH = ghostOrders ? off : 0;
    let y = headerH + gridPadTop;
    if (isGridShown(prevGrid)) y += prevGrid.topPx + breakH + prevGrid.rowCount * off;
    y += activeGrid.topPx + breakH + row * off + off / 2;
    main.scrollTop = y - (headerH + viewportH) / 2;
}

// Drains prefetchQueue one grid per idle callback; only the latest
// assignGrids' queue is live (it cancels any in-flight run).
function schedulePrefetch(song) {
    if (prefetchIdleHandle !== -1 || prefetchQueue.length === 0) return;

    const run = (deadline) => {
        prefetchIdleHandle = -1;
        // Re-check — world can change between schedule and fire.
        if (!playerState.meta || playerState.meta.song !== song) { prefetchQueue = []; return; }
        const item = prefetchQueue[0];
        if (!item) return;
        const stillWanted =
            (item.grid === nextGrid && activeGrid.order + 1 === item.order) ||
            (item.grid === prevGrid && activeGrid.order - 1 === item.order);
        if (!stillWanted || item.grid.order !== -1) { prefetchQueue.shift(); schedulePrefetch(song); return; }

        // Prefer a quiet slot, but don't wait forever: while the rAF loop runs
        // the idle budget peaks near one frame (~16 ms), and a cold miss at
        // the boundary would cost the same build inside a playback frame.
        if (deadline && typeof deadline.timeRemaining === 'function'
            && deadline.timeRemaining() < PREFETCH_MIN_BUDGET_MS
            && ++item.deferrals < PREFETCH_MAX_DEFERRALS) {
            schedulePrefetch(song);
            return;
        }
        prefetchQueue.shift();
        const pattern = song.orders[item.order];
        if (populateGrid(item.grid, song, pattern, item.order)) {
            applyRoles();
            // A ghost appearing above shifts the active rows down: re-centre.
            if (item.grid === prevGrid && ghostOrders && lastDrawnRow >= 0) centerRow(lastDrawnRow);
        }
        schedulePrefetch(song);
    };

    if (typeof requestIdleCallback === 'function') {
        // No `timeout` — prefetch is non-urgent; timeout would promote to high-pri.
        prefetchIdleHandle = requestIdleCallback(run);
    } else {
        // Safari < 16.4 fallback.
        prefetchIdleHandle = setTimeout(
            () => run({ timeRemaining: () => 50, didTimeout: false }),
            50,
        );
    }
}

const PREFETCH_MIN_BUDGET_MS = 8;
const PREFETCH_MAX_DEFERRALS = 4;

function cancelPrefetch() {
    if (prefetchIdleHandle === -1) return;
    if (typeof cancelIdleCallback === 'function') {
        try { cancelIdleCallback(prefetchIdleHandle); } catch { /* not an idle handle */ }
    }
    clearTimeout(prefetchIdleHandle);
    prefetchIdleHandle = -1;
}

// ---- layout ------------------------------------------------------------

function layoutGrids(song) {
    const header = $('#trackerHeader');
    const gridCols = gridTemplate(song.channels);
    if (header.style.gridTemplateColumns !== gridCols) {
        header.style.gridTemplateColumns = gridCols;
    }
    for (const grid of grids) {
        if (grid.el.style.gridTemplateColumns !== gridCols) {
            grid.el.style.gridTemplateColumns = gridCols;
        }
    }

    // Natural width: 20 (row label) + N*(MIN_CHANNEL_WIDTH + 2 gap) + 8 (padding).
    const main = getTrackerMain();
    const naturalWidth = 20 + song.channels * (MIN_CHANNEL_WIDTH + 2) + 8;
    const naturalCss = `${naturalWidth}px`;
    if (main.style.getPropertyValue('--grid-min-width') !== naturalCss) {
        main.style.setProperty('--grid-min-width', naturalCss);
    }

    // max-height = min(viewport - app-chrome, lowest-below-sibling-top - gap).
    const mainRect = main.getBoundingClientRect();
    const top = mainRect.top;
    const bottomChrome = Math.max(8, computeAppBottomChrome());
    const containerBottomChrome = computeContainerBottomChrome(main);
    let lowerBound = window.innerHeight - bottomChrome;

    // Adopt the topmost .app sibling below the tracker as a hard ceiling.
    // 50px clearance filters transient mid-relayout false matches.
    const app = $('.app');
    const trackerContainer = main.closest('.tracker-container');
    if (app) {
        const gap = parseFloat(getComputedStyle(app).rowGap) || 12;
        for (const sibling of app.children) {
            if (sibling === trackerContainer) continue;
            const sRect = sibling.getBoundingClientRect();
            if (sRect.width === 0 || sRect.height === 0) continue;
            const horizontalOverlap =
                sRect.right > mainRect.left && sRect.left < mainRect.right;
            if (horizontalOverlap && sRect.top > top + 50) {
                lowerBound = Math.min(lowerBound, sRect.top - gap);
            }
        }
    }

    // Reserve space for in-container siblings below main (e.g. aurora's
    // samples band). Read by height + gap; on first render main's
    // max-height isn't set yet and the sibling can land far below.
    if (trackerContainer) {
        const tcGap = parseFloat(getComputedStyle(trackerContainer).rowGap) || 12;
        let reservedForBelow = 0;
        for (const sibling of trackerContainer.children) {
            if (sibling === main) continue;
            const sRect = sibling.getBoundingClientRect();
            if (sRect.width === 0 || sRect.height === 0) continue;
            const horizontalOverlap =
                sRect.right > mainRect.left && sRect.left < mainRect.right;
            if (horizontalOverlap && sRect.top > top + 50) {
                reservedForBelow += sRect.height + tcGap;
            }
        }
        lowerBound -= reservedForBelow;
    }

    // -1 floors sub-pixel rounding so densely-framed themes don't grow a hairline scrollbar.
    const raw = lowerBound - top - containerBottomChrome - 1;
    const availableHeight = Math.max(150, Math.floor(raw));
    const next = `${availableHeight}px`;
    if (main.style.maxHeight !== next) {
        main.style.maxHeight = next;
    }

    syncSampleListHeight();
}

// Cached app chrome (padding+border+margin bottom), keyed by computed-style fingerprint.
let cachedAppChrome = { fp: '', value: 0 };
function computeAppBottomChrome() {
    const app = $('.app');
    if (!app) return 0;
    const cs = getComputedStyle(app);
    const fp = `${cs.paddingBottom}|${cs.borderBottomWidth}|${cs.marginBottom}`;
    if (fp === cachedAppChrome.fp) return cachedAppChrome.value;
    const value =
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0) +
        (parseFloat(cs.marginBottom) || 0);
    cachedAppChrome = { fp, value };
    return value;
}

// main.getBoundingClientRect().top is INSIDE the container's padding.
const containerChromeCache = new WeakMap();
function computeContainerBottomChrome(main) {
    const container = main && main.closest('.tracker-container');
    if (!container) return 0;
    const cs = getComputedStyle(container);
    const fp = `${cs.paddingBottom}|${cs.borderBottomWidth}|${cs.marginBottom}`;
    const cached = containerChromeCache.get(container);
    if (cached && cached.fp === fp) return cached.value;
    const value =
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0) +
        (parseFloat(cs.marginBottom) || 0);
    containerChromeCache.set(container, { fp, value });
    return value;
}

function syncSampleListHeight() {
    const main = getTrackerMain();
    const sampleList = $('#sampleList');
    if (!sampleList || !main) return;
    const next = `${main.offsetHeight}px`;
    if (sampleList.style.height !== next) {
        sampleList.style.height = next;
    }
}

// ---- samples -----------------------------------------------------------

function renderSamples(song) {
    const list = $('#sampleList');

    let html = '';
    for (let i = 0; i < song.samples.length; i++) {
        const name = (song.samples[i] || '').replaceAll(' ', '&nbsp;');
        html += `<div class="sample-item" data-sample-id="${i}">${hb(i + 1)} ${name}</div>`;
    }
    list.innerHTML = html;
    list.style.display = 'block';

    sampleItemsById = {};
    const children = list.children;
    for (let i = 0; i < children.length; i++) {
        sampleItemsById[children[i].dataset.sampleId] = children[i];
    }
    channelSampleId = new Array(song.channels).fill(null);
    highlightedSampleIds.clear();
    pendingSampleIds.clear();
}

// ---- current row + sample highlighting ---------------------------------

function updateCurrentRow(pattern, row) {
    if (pattern === lastDrawnPattern && row === lastDrawnRow) return;

    // The previous row's cells may now sit in a ghost grid (or be detached
    // after a rebuild); we kept the element list, so no lookup is needed.
    if (lastRowEls) {
        for (let i = 0; i < lastRowEls.length; i++) lastRowEls[i].classList.remove('highlighted-row');
        lastRowEls = null;
    }

    if (pattern === activeGrid.patternIndex) {
        const els = activeGrid.rows.get(row);
        if (els) {
            for (let i = 0; i < els.length; i++) els[i].classList.add('highlighted-row');
            lastRowEls = els;
        }
        centerRow(row);
    }

    lastDrawnPattern = pattern;
    lastDrawnRow = row;
}

function updateUsedSamples(song, pos, volumes) {
    const patternRows = song.patterns[pos.pattern];
    if (!patternRows) return;

    pendingSampleIds.clear();
    for (let col = 0; col < song.channels; col++) {
        const vol = volumes[col];
        if (vol.isMuted) {
            channelSampleId[col] = null;
            continue;
        }

        if (pos.pattern >= 0 && pos.row >= 0) {
            const note = patternRows[pos.row]?.[col];
            const sampleId = note && note[1] > 0 ? (note[1] - 1).toString() : null;
            if (sampleId && sampleItemsById[sampleId]) channelSampleId[col] = sampleId;
        }

        const sampleId = channelSampleId[col];
        if (sampleId && vol.maxVolume > 0.05) {
            pendingSampleIds.add(sampleId);
        } else {
            channelSampleId[col] = null;
        }
    }

    for (const id of highlightedSampleIds) {
        if (!pendingSampleIds.has(id)) sampleItemsById[id]?.classList.remove('highlighted');
    }
    for (const id of pendingSampleIds) {
        if (!highlightedSampleIds.has(id)) sampleItemsById[id]?.classList.add('highlighted');
    }

    const swap = highlightedSampleIds;
    highlightedSampleIds = pendingSampleIds;
    pendingSampleIds = swap;
}

// ---- panel toggles -----------------------------------------------------

export function toggleVisualizationsVisible(visible) {
    $$('.canvas-parent').forEach(node => show(node, visible));
    // Defer the reflow to rAF so the click handler returns immediately.
    requestAnimationFrame(relayoutTracker);
}

export function toggleSamplesVisible(visible) {
    // Class on <html> mirrors the inline preboot script for first paint.
    document.documentElement.classList.toggle('samples-hidden', !visible);
    // Only canvas pixel dimensions change; skip full relayout.
    requestAnimationFrame(invalidateCanvasSizes);
}
