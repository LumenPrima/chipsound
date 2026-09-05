// Mixer panel — live playback parameters. Every control maps to one key of
// the worklet config (see chiptune3.worklet.js#applyRenderParam); changes go
// straight to libopenmpt and take effect on the next audio quantum. Values
// persist in prefs.render and are fed into the player's initial config by
// index.js, so a reload comes back exactly as you left it.

import { $ } from './dom.js';
import { prefs } from './prefs.js';
import { playerState } from './state.js';
import { relayoutTracker } from './tracker.js';

const fmtFactor = v => `${Number(v).toFixed(2)}×`;
const fmtDb = v => `${v > 0 ? '+' : ''}${(v / 100).toFixed(0)} dB`;

// `def` must match defaultCfg in chiptune3.js.
export const PARAMS = [
    {
        key: 'stereoSeparation', label: 'Stereo separation', type: 'range',
        min: 0, max: 200, step: 5, def: 100, fmt: v => `${v}%`,
        hint: '0 = mono · 100 = default · 200 = full width (Amiga hard pan)',
    },
    {
        key: 'amigaResampler', label: 'Amiga resampler', type: 'select', def: 'a1200',
        options: [['off', 'Off'], ['auto', 'Auto'], ['a500', 'A500'], ['a1200', 'A1200'], ['unfiltered', 'Unfiltered']],
        hint: 'Paula emulation for Amiga-style modules (MOD etc.). Off = use the interpolation filter below.',
    },
    {
        key: 'interpolationFilter', label: 'Interpolation', type: 'select', def: 0,
        options: [[0, 'Default'], [1, 'None (nearest)'], [2, 'Linear'], [4, 'Cubic'], [8, 'Sinc (8-tap)']],
        hint: 'Sample interpolation. Ignored for Amiga modules while the Amiga resampler is on.',
    },
    {
        key: 'volumeRamping', label: 'Volume ramping', type: 'range',
        min: -1, max: 10, step: 1, def: -1,
        fmt: v => (v < 0 ? 'Default' : v === 0 ? 'Off' : String(v)),
        hint: 'Smooths volume jumps to avoid clicks. Off = raw tracker behaviour.',
    },
    {
        key: 'tempoFactor', label: 'Tempo', type: 'range',
        min: 0.5, max: 2, step: 0.01, def: 1, fmt: fmtFactor,
        hint: 'Speed without changing pitch.',
    },
    {
        key: 'pitchFactor', label: 'Pitch', type: 'range',
        min: 0.5, max: 2, step: 0.01, def: 1, fmt: fmtFactor,
        hint: 'Pitch without changing speed.',
    },
    {
        key: 'masterGain', label: 'Gain', type: 'range',
        min: -1200, max: 1200, step: 100, def: 0, fmt: fmtDb,
        hint: 'Pre-mix master gain inside libopenmpt (independent of the volume slider).',
    },
    {
        key: 'repeatCount', label: 'Loop', type: 'select', def: 0,
        options: [[0, 'Play once'], [-1, 'Forever'], [1, 'Twice'], [3, '4 times']],
        hint: 'What happens when the module reaches its end.',
    },
];

let panelEl = null;
let toggleBtn = null;
const inputs = new Map();     // key -> input/select element
const readouts = new Map();   // key -> value <output>

function coerce(param, raw) {
    if (param.type === 'select') {
        // Options may be numbers or strings — map back to the declared value.
        const opt = param.options.find(([v]) => String(v) === String(raw));
        return opt ? opt[0] : param.def;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : param.def;
}

// Saved settings merged over defaults, validated. Used by index.js to seed the
// player config before the worklet even starts.
export function savedRenderConfig() {
    const saved = prefs.render || {};
    const out = {};
    for (const p of PARAMS) {
        out[p.key] = p.key in saved ? coerce(p, saved[p.key]) : p.def;
        if (p.type === 'range') out[p.key] = Math.min(p.max, Math.max(p.min, out[p.key]));
    }
    return out;
}

function persist() {
    const cfg = {};
    for (const p of PARAMS) cfg[p.key] = coerce(p, inputs.get(p.key).value);
    prefs.render = cfg;
}

function setParam(param, value, { save = true } = {}) {
    const input = inputs.get(param.key);
    if (input && String(input.value) !== String(value)) input.value = value;
    const out = readouts.get(param.key);
    if (out) out.textContent = param.fmt ? param.fmt(value) : '';
    playerState.player?.setRenderParam(param.key, value);
    if (save) persist();
}

function buildRow(param, current) {
    const row = document.createElement('div');
    row.className = 'mixer-row';
    row.title = param.hint || '';

    const id = `mixer-${param.key}`;
    const label = document.createElement('label');
    label.className = 'mixer-label';
    label.htmlFor = id;
    label.textContent = param.label;

    let input;
    if (param.type === 'select') {
        input = document.createElement('select');
        input.className = 'retro-select';
        for (const [value, text] of param.options) {
            const o = document.createElement('option');
            o.value = String(value);
            o.textContent = text;
            input.appendChild(o);
        }
    } else {
        input = document.createElement('input');
        input.type = 'range';
        input.min = param.min;
        input.max = param.max;
        input.step = param.step;
    }
    input.id = id;
    input.value = String(current);
    input.setAttribute('aria-label', param.label);

    const out = document.createElement('output');
    out.className = 'mixer-value';
    out.htmlFor = id;

    inputs.set(param.key, input);
    readouts.set(param.key, out);

    input.addEventListener('input', () => setParam(param, coerce(param, input.value)));
    // Double-click a slider to snap it back to default.
    if (param.type === 'range') {
        input.addEventListener('dblclick', () => setParam(param, param.def));
    }

    row.append(label, input, out);
    return row;
}

function buildPanel() {
    const cfg = savedRenderConfig();
    panelEl.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'mixer-head';
    head.innerHTML = `<span class="mixer-title"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Playback parameters</span>
        <span class="mixer-note">live · libopenmpt render settings · double-click a slider to reset it</span>`;
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'retro-button retro-button-icon mixer-reset';
    reset.title = 'Reset all to defaults';
    reset.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i> <span class="btn-label">Reset</span>';
    reset.addEventListener('click', resetAll);
    head.appendChild(reset);
    panelEl.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'mixer-grid';
    for (const p of PARAMS) grid.appendChild(buildRow(p, cfg[p.key]));
    panelEl.appendChild(grid);

    // Paint readouts (no player message yet — config already seeded).
    for (const p of PARAMS) readouts.get(p.key).textContent = p.fmt ? p.fmt(cfg[p.key]) : '';
}

export function resetAll() {
    for (const p of PARAMS) setParam(p, p.def, { save: false });
    persist();
}

export function isMixerOpen() {
    return Boolean(panelEl && !panelEl.hidden);
}

export function setMixerOpen(open) {
    if (!panelEl) return;
    panelEl.hidden = !open;
    toggleBtn?.setAttribute('aria-pressed', String(open));
    toggleBtn?.classList.toggle('active', open);
    prefs.showMixer = open;
    // Panel height changes the space left for the tracker grid.
    requestAnimationFrame(() => relayoutTracker());
}

export function toggleMixer() {
    setMixerOpen(!isMixerOpen());
}

export function initMixer() {
    panelEl = $('#mixerPanel');
    toggleBtn = $('#toggle-mixer');
    if (!panelEl) return;
    buildPanel();
    toggleBtn?.addEventListener('click', toggleMixer);
    setMixerOpen(Boolean(prefs.showMixer));
}
