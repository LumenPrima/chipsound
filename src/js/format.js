const NOTES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

const EFFECT_LETTERS = {
    0: '.', 1: 'J', 2: 'F', 3: 'E', 4: 'G', 5: 'H', 6: 'L', 7: 'K',
    8: 'R', 9: 'S', 10: 'O', 11: 'D', 12: 'B', 13: '.', 14: 'C', 15: 'Q',
    16: 'A', 17: 'T', 18: 'L', 19: 'S', 20: 'S', 21: 'M', 22: 'N', 23: 'V',
    24: 'W', 26: 'U', 27: 'Y', 28: 'S', 29: 'P', 31: 'I', 37: 'S',
};

export function padNumber(num) {
    return num.toString().padStart(2, '0');
}

// hb() is called once per cell in populateGrid (thousands per pattern load),
// plus on every row change. The input is always 0–255, so the result space is
// finite — precompute it once and read by index. Replaces three string
// allocations per call (toString + padStart + toUpperCase) with a single
// indexed read. Out-of-range values fall back to the original computation.
const HB_TABLE = new Array(256);
for (let i = 0; i < 256; i++) {
    HB_TABLE[i] = i.toString(16).padStart(2, '0').toUpperCase();
}

export function hb(n) {
    if (n === undefined || n === null) return '00';
    // Fast path for the only inputs that actually occur in this codebase
    // (integers 0–255). Anything else falls back to the original formatter.
    if (typeof n === 'number' && n >= 0 && n < 256 && (n | 0) === n) return HB_TABLE[n];
    return n.toString(16).padStart(2, '0').toUpperCase();
}

// note[0]=pitch, [1]=sample, [2]=vol-effect, [3]=effect, [4]=vol, [5]=param.
function getNote(note) {
    return {
        note:
            note[0] === 0 ? '' :
            note[0] === 255 ? '===' :
            note[0] === 254 ? '^^.' :
            NOTES[(note[0] - 1) % 12] + (Math.floor((note[0] - 1) / 12) - 1),
        sample: note[1] === 0 ? '' : hb(note[1]),
        volume:
            (note[4] === 0 && note[3] !== 13) ? '' :
            note[3] === 13 ? padNumber(note[5]) :
            padNumber(note[4]),
        effect:
            (note[3] === 0 || note[3] === 13) ? '' :
            (EFFECT_LETTERS[note[3]] ?? '?') + hb(note[5]),
    };
}

// Always emit all four segments — CSS @container rules hide them on narrow cols.
const EMPTY_PITCH  = '...';
const EMPTY_SAMPLE = '..';
const EMPTY_VOLUME = '..';
const EMPTY_EFFECT = '...';

export function renderNote(note) {
    const n = getNote(note);
    return (
        `<span class="note">${n.note || EMPTY_PITCH}</span>` +
        `<span class="sample">${n.sample || EMPTY_SAMPLE}</span>` +
        `<span class="volume">${n.volume || EMPTY_VOLUME}</span>` +
        `<span class="effect">${n.effect || EMPTY_EFFECT}</span>`
    );
}
