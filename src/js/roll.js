// Roll overlay: every channel's notes drawn as pitch ribbons beside (or over)
// the pattern text. The shapes are computed tick by tick from the pattern
// data with the classic replayer rules — portamento leans, vibrato wobbles,
// tremolo throbs, volume slides taper, note delay lowers the onset cap, note
// cut ends the ribbon — so the picture is what the row is about to sound
// like rather than a hex code you have to decode.
//
// Two pure functions: buildRollModel() turns a song into per-order tick
// arrays (once per load), drawRoll() paints one order onto a canvas.

// Formats whose slides are in Amiga period units; everything else is linear.
const AMIGA_FORMATS = new Set([
    'mod', 'm15', 'stk', 'nst', 'wow', 'pt36', 's3m', 'stm', 'med', 'okt',
    '669', 'far', 'ult', 'mtm', 'dmf', 'ptm', 'amf', 'dsm', 'psm', 'mdl',
]);

// ProTracker C-1 (period 856) is libopenmpt note 61.
const periodOf = semi => 856 * Math.pow(2, -(semi - 61) / 12);
const semiOf   = per  => 61 - 12 * Math.log2(per / 856);

// Tick flags.
export const F_ACTIVE = 1, F_ON = 2, F_HOLLOW = 4, F_CUT = 8;

// IT volume-column tone portamento speeds (Gx), in effect-column units.
const IT_VOLCMD_PORTA = [0, 1, 4, 8, 16, 32, 64, 96, 128, 255];

function channelState() {
    return {
        pitch: 61, target: 61, portaMem: 0, vol: 64, active: false, inst: 0,
        vibPos: 0, vibSpd: 0, vibDep: 0, tremPos: 0, tremSpd: 0, tremDep: 0,
        age: 0, tremor: 0,
    };
}

export function buildRollModel(song, type) {
    const fmt = (type || '').toLowerCase();
    const linear = !AMIGA_FORMATS.has(fmt);
    const itLike = fmt === 'it' || fmt === 'mptm';
    const numCh = song.channels;

    // param units → new pitch (semitones). Linear: 4 units per param,
    // 64 units per semitone. Amiga: param is period units.
    const slide = linear
        ? (semi, units, dir) => semi + dir * units / 16
        : (semi, units, dir) => semiOf(Math.max(56, Math.min(3424, periodOf(semi) - dir * units)));
    // Vibrato: a sine at `pos` with `depth` → displayed pitch.
    const vibratoPitch = linear
        ? (semi, pos, depth) => semi + Math.sin(pos * Math.PI / 32) * depth * (itLike ? 1 / 16 : 1 / 8)
        : (semi, pos, depth) => semiOf(periodOf(semi) + Math.sin(pos * Math.PI / 32) * depth * 2);

    const st = [];
    for (let c = 0; c < numCh; c++) st.push(channelState());
    let speed = 6;

    const orders = new Array(song.orders.length);
    const lo = new Float32Array(numCh).fill(999);
    const hi = new Float32Array(numCh).fill(-999);

    for (let ord = 0; ord < song.orders.length; ord++) {
        const pattern = song.patterns[song.orders[ord]];
        if (!pattern) continue;
        const rows = pattern.length;

        // Pass 1: speeds per row (so the tick arrays can be sized up front).
        const speeds = new Uint8Array(rows);
        const rowOff = new Uint32Array(rows + 1);
        let total = 0;
        for (let r = 0; r < rows; r++) {
            for (const cell of pattern[r]) if (cell[3] === 16 && cell[5] > 0 && cell[5] < 32) speed = cell[5];
            speeds[r] = speed;
            rowOff[r] = total;
            total += speed;
        }
        rowOff[rows] = total;

        const chData = [];
        for (let c = 0; c < numCh; c++) {
            chData.push({ s: new Float32Array(total), v: new Uint8Array(total), f: new Uint8Array(total), i: new Uint8Array(total) });
        }

        // Pass 2: replay.
        for (let r = 0; r < rows; r++) {
            const spd = speeds[r];
            for (let c = 0; c < numCh; c++) {
                const s = st[c], cell = pattern[r][c], out = chData[c];
                const [n, inst, volcmd, e, volp, p] = cell;
                const ex = (e === 19 || e === 20) ? (p >> 4) : -1, exv = p & 15;

                // --- tick 0: read the row ---
                let onset = -1, hollow = false, retrig = 0, cut = -1;
                if (inst > 0) { s.vol = 64; s.inst = inst; }
                if (ex === 13) onset = exv;                                // EDx / SDx note delay
                if (e === 33) { onset = p >> 4; cut = p & 15; }           // IT :xy delay + cut
                const porta = e === 4 || e === 6 || volcmd === 11;
                if (n > 0 && n < 251) {
                    if (porta) {
                        s.target = n;
                        if (!s.active) { s.pitch = n; s.active = true; onset = Math.max(onset, 0); s.age = 0; }
                    } else {
                        s.pitch = n; s.target = n; s.active = true; s.vibPos = 0; s.tremPos = 0;
                        if (onset < 0) onset = 0;
                        s.age = 0;
                    }
                } else if (n >= 253 && n <= 255) {
                    s.active = false;                                     // fade / cut / key off
                }
                if (e === 4 && p) s.portaMem = p;
                if (volcmd === 11) s.portaMem = itLike ? IT_VOLCMD_PORTA[Math.min(9, volp)] : volp * 4;
                if (e === 13) s.vol = Math.min(64, p);
                if (e === 10 || e === 42 || e === 44 || volcmd === 15 || ex === 10 && e === 20) hollow = true;
                if (e === 5 || e === 26) { if (p >> 4) s.vibSpd = p >> 4; if (p & 15) s.vibDep = (e === 26 ? 0.25 : 1) * (p & 15); }
                if (e === 8) { if (p >> 4) s.tremSpd = p >> 4; if (p & 15) s.tremDep = p & 15; }
                if (volcmd === 1) s.vol = Math.min(64, volp);
                if (volcmd === 5) s.vol = Math.min(64, s.vol + volp);
                if (volcmd === 6) s.vol = Math.max(0, s.vol - volp);
                if (volcmd === 7) s.vibSpd = volp;
                if (volcmd === 8) s.vibDep = volp;
                if (e === 19 || e === 20) {
                    if (ex === 1) s.pitch = slide(s.pitch, exv, +1);
                    if (ex === 2) s.pitch = slide(s.pitch, exv, -1);
                    if (ex === 9) retrig = exv;
                    if (ex === 10 && e === 19) s.vol = Math.min(64, s.vol + exv);
                    if (ex === 11 && e === 19) s.vol = Math.max(0, s.vol - exv);
                    if (ex === 12) cut = exv;
                }
                if (e === 28) {                                          // Xxy extra-fine porta
                    if ((p >> 4) === 1) s.pitch = slide(s.pitch, exv / 4, +1);
                    if ((p >> 4) === 2) s.pitch = slide(s.pitch, exv / 4, -1);
                }
                if (e === 15) retrig = p & 15;                           // Qxy
                if (e === 25) cut = p;                                   // Kxx key off at tick
                if (e === 18) s.tremor = 0;

                // Effects that continue on ticks 1..speed-1.
                const vibrato = e === 5 || e === 7 || e === 26 || volcmd === 8 || volcmd === 7;
                const volSlideP = (e === 11 || e === 6 || e === 7) ? p : 0;
                const volUp = volcmd === 3 ? volp : 0, volDown = volcmd === 4 ? volp : 0;

                // --- ticks ---
                const base = rowOff[r];
                for (let t = 0; t < spd; t++) {
                    let disp, vol;
                    if (t > 0) {
                        if (e === 2) s.pitch = slide(s.pitch, p, +1);
                        if (e === 3) s.pitch = slide(s.pitch, p, -1);
                        if (volcmd === 12) s.pitch = slide(s.pitch, volp * 4, +1);
                        if (volcmd === 13) s.pitch = slide(s.pitch, volp * 4, -1);
                        if (porta && s.portaMem) {
                            const next = slide(s.pitch, s.portaMem, s.pitch < s.target ? +1 : -1);
                            s.pitch = s.pitch < s.target ? Math.min(s.target, next) : Math.max(s.target, next);
                        }
                        if (vibrato) s.vibPos = (s.vibPos + s.vibSpd) & 63;
                        if (e === 8) s.tremPos = (s.tremPos + s.tremSpd) & 63;
                        if (volSlideP) s.vol = Math.max(0, Math.min(64, s.vol + (volSlideP >> 4) - (volSlideP & 15)));
                        if (volUp || volDown) s.vol = Math.max(0, Math.min(64, s.vol + volUp - volDown));
                        if (retrig && t % retrig === 0) s.age = 0;
                        if (cut === t) { s.vol = 0; }
                    }
                    if (onset === t && t > 0) { s.active = true; s.age = 0; }

                    disp = vibrato ? vibratoPitch(s.pitch, s.vibPos, s.vibDep) : s.pitch;
                    if (e === 1 && s.active) {                            // arpeggio: base, +x, +y
                        const k = t % 3;
                        disp += k === 1 ? (p >> 4) : k === 2 ? (p & 15) : 0;
                    }
                    vol = s.vol;
                    if (e === 8) vol = Math.max(0, Math.min(64, vol + Math.sin(s.tremPos * Math.PI / 32) * s.tremDep * 4));
                    if (e === 18) {                                       // tremor: x+1 on, y+1 off
                        const on = (p >> 4) + 1, off = (p & 15) + 1;
                        if (s.tremor % (on + off) >= on) vol = 0;
                        s.tremor++;
                    }

                    const starts = onset === t || (retrig && t > 0 && t % retrig === 0);
                    const waiting = onset > t;                            // delayed note: previous one still rings
                    const active = s.active && !(waiting && s.age === 0);
                    const k = base + t;
                    out.s[k] = disp; out.v[k] = vol; out.i[k] = s.inst;
                    out.f[k] = (active ? F_ACTIVE : 0) | (starts ? F_ON : 0) | (starts && hollow ? F_HOLLOW : 0) | (cut === t ? F_CUT : 0);
                    if (active) { if (disp < lo[c]) lo[c] = disp; if (disp > hi[c]) hi[c] = disp; }
                    s.age++;
                }
            }
        }
        orders[ord] = { rows, speeds, rowOff, ch: chData };
    }

    // Pitch range per channel: the notes it actually plays, at least 14 semitones.
    const range = [];
    for (let c = 0; c < numCh; c++) {
        let l = lo[c], h = hi[c];
        if (l > h) { l = 49; h = 73; }
        l = Math.floor(l) - 1; h = Math.ceil(h) + 1;
        if (h - l < 14) { const mid = (h + l) / 2; l = Math.floor(mid - 7); h = l + 14; }
        range.push({ lo: l, hi: h });
    }
    return { orders, range };
}

// ---- drawing ------------------------------------------------------------

function instRGB(i) {
    const h = (i * 137.508) % 360, s = 0.62, l = 0.64;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    return `${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)}`;
}
const instCache = [];
const instColor = i => instCache[i] || (instCache[i] = instRGB(i));

// One smooth ribbon through pts [{x, y, w, rgb, a}]: left edge down, right edge back up.
function ribbon(ctx, pts) {
    const y0 = pts[0].y, y1 = pts[pts.length - 1].y;
    if (y1 - y0 < 0.5) return;
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    let prev = null;
    for (const p of pts) {
        const off = Math.max(0, Math.min(1, (p.y - y0) / (y1 - y0)));
        if (prev && prev.rgb !== p.rgb) grad.addColorStop(off, `rgba(${prev.rgb},${prev.a})`);
        grad.addColorStop(off, `rgba(${p.rgb},${p.a})`);
        prev = p;
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(pts[0].x - pts[0].w / 2, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].w / 2, pts[i].y);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x + pts[i].w / 2, pts[i].y);
    ctx.closePath();
    ctx.fill();
}

// Backing-store budget so a 64-channel grid at 2× DPR doesn't eat the GPU.
const MAX_PIXELS = 6e6;

// geom: { width, laneX[], laneW, textW, rowH, fg, cut, beside }
// muted: Set of channel indices to dim.
export function drawRoll(canvas, model, order, geom, muted) {
    const data = model.orders[order];
    if (!data) { canvas.width = canvas.height = 0; return; }
    const { rows, speeds, rowOff, ch } = data;
    const cssW = geom.width, cssH = rows * geom.rowH;
    const scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (cssW * cssH)));
    canvas.width = Math.max(1, Math.round(cssW * scale));
    canvas.height = Math.max(1, Math.round(cssH * scale));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const inset = geom.beside ? geom.textW : 0;
    const rollW = geom.laneW - inset;
    const pad = Math.max(4, rollW * 0.06);
    const wMax = Math.max(3, Math.min(11, rollW / 17));
    const overAlpha = geom.beside ? 1 : 0.6;
    const capW = wMax * 1.9;

    for (let c = 0; c < ch.length; c++) {
        const { s, v, f, i } = ch[c];
        const rollX = geom.laneX[c] + inset;
        const { lo, hi } = model.range[c];
        const xOf = semi => rollX + pad + (semi - lo) / (hi - lo) * (rollW - 2 * pad);
        const dim = muted && muted.has(c) ? 0.3 : 1;

        let run = [];
        let age = 0;
        const flush = () => { if (run.length > 1) ribbon(ctx, run); run = []; };
        for (let r = 0; r < rows; r++) {
            const th = geom.rowH / speeds[r], y0 = r * geom.rowH;
            for (let t = 0, k = rowOff[r]; t < speeds[r]; t++, k++) {
                const fl = f[k], y = y0 + t * th;
                if (!(fl & F_ACTIVE)) { if (run.length) { run.push({ ...run[run.length - 1], y }); flush(); } age = 0; continue; }
                if (fl & F_ON) { if (run.length) { run.push({ ...run[run.length - 1], y }); flush(); } age = 0; }
                const vol = v[k] / 64;
                let a = (0.4 + 0.6 * vol) * overAlpha * dim;
                a *= Math.max(0.28, 1 - age / (6 * 28));   // sample length unknown: assume it thins out
                if (v[k] === 0) a = 0.08 * dim;
                run.push({ x: xOf(s[k]), y, w: Math.max(1.5, wMax * (0.3 + 0.7 * vol)), rgb: instColor(i[k]), a });
                age++;
            }
        }
        if (run.length) { run.push({ ...run[run.length - 1], y: cssH }); flush(); }

        // Caps and cuts on top.
        for (let r = 0; r < rows; r++) {
            const th = geom.rowH / speeds[r], y0 = r * geom.rowH;
            for (let t = 0, k = rowOff[r]; t < speeds[r]; t++, k++) {
                const fl = f[k];
                if (!(fl & (F_ON | F_CUT))) continue;
                const x = xOf(s[k]), y = y0 + t * th;
                if (fl & F_ON) {
                    ctx.globalAlpha = 0.92 * dim;
                    if (fl & F_HOLLOW) { ctx.lineWidth = 1.5; ctx.strokeStyle = geom.fg; ctx.strokeRect(x - capW / 2 + 0.5, y + 0.5, capW, 3); }
                    else { ctx.fillStyle = geom.fg; ctx.fillRect(x - capW / 2, y, capW, 3); }
                    ctx.globalAlpha = 1;
                }
                if (fl & F_CUT) { ctx.fillStyle = geom.cut; ctx.fillRect(x - wMax, y, wMax * 2, 2); }
            }
        }
    }
}
