const NOTES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

// libopenmpt reports OpenMPT's internal command ids (soundlib/modcommand.h,
// enum EffectCommand); these are the IT/S3M-style display letters for them.
const EFFECT_LETTERS = {
    0: '.', 1: 'J', 2: 'F', 3: 'E', 4: 'G', 5: 'H', 6: 'L', 7: 'K',
    8: 'R', 9: 'X', 10: 'O', 11: 'D', 12: 'B', 13: '.', 14: 'C', 15: 'Q',
    16: 'A', 17: 'T', 18: 'I', 19: 'S', 20: 'S', 21: 'M', 22: 'N', 23: 'V',
    24: 'W', 25: 'K', 26: 'U', 27: 'Y', 28: 'S', 29: 'P', 30: 'L', 31: 'Z', 37: 'S',
};

// ---- effect families ----------------------------------------------------
//
// Reading "E6A" vs "EA4" at 6 rows a second is not something a human can do,
// so each effect / volume-column command is tagged with the *kind* of thing
// it does and the CSS colours it by family (--tracker-fx-* tokens, falling
// back to --tracker-effect so themes that don't opt in look unchanged):
//
//   fx-pitch   arpeggio, portamento, vibrato, finetune, note slides
//   fx-volume  volume slides, tremolo, tremor, channel / global volume
//   fx-pan     panning, pan slides, panbrello
//   fx-flow    position jump, pattern break, speed, tempo, pattern loop / delay
//   fx-sample  offset, retrigger, note cut / delay, key off, envelopes, macros
//
// Sxy / Exy extended commands are classified by their high nibble.

const FX_PITCH  = ' fx-pitch';
const FX_VOLUME = ' fx-volume';
const FX_PAN    = ' fx-pan';
const FX_FLOW   = ' fx-flow';
const FX_SAMPLE = ' fx-sample';

const EFFECT_FAMILY = new Array(64).fill('');
for (const id of [1, 2, 3, 4, 5, 6, 7, 26, 28, 35, 36, 38, 39, 40, 41, 47, 50, 51, 52, 53, 54, 55]) EFFECT_FAMILY[id] = FX_PITCH;
for (const id of [8, 11, 13, 18, 21, 22, 23, 24, 46, 49, 56, 57]) EFFECT_FAMILY[id] = FX_VOLUME;
for (const id of [9, 27, 29]) EFFECT_FAMILY[id] = FX_PAN;
for (const id of [12, 14, 16, 17]) EFFECT_FAMILY[id] = FX_FLOW;
for (const id of [10, 15, 25, 30, 31, 32, 33, 42, 43, 44, 45, 48]) EFFECT_FAMILY[id] = FX_SAMPLE;

// CMD_MODCMDEX (19): MOD / XM "Exy", by sub-command x.
const MODCMDEX_FAMILY = [
    FX_SAMPLE, FX_PITCH,  FX_PITCH,  FX_PITCH,   // E0 filter, E1/E2 fine porta, E3 glissando
    FX_PITCH,  FX_PITCH,  FX_FLOW,   FX_VOLUME,  // E4 vibrato wave, E5 finetune, E6 loop, E7 tremolo wave
    FX_PAN,    FX_SAMPLE, FX_VOLUME, FX_VOLUME,  // E8 pan, E9 retrig, EA/EB fine vol slide
    FX_SAMPLE, FX_SAMPLE, FX_FLOW,   FX_SAMPLE,  // EC note cut, ED note delay, EE pattern delay, EF funk repeat
];

// CMD_S3MCMDEX (20): S3M / IT "Sxy", by sub-command x.
const S3MCMDEX_FAMILY = [
    FX_SAMPLE, FX_PITCH,  FX_PITCH,  FX_PITCH,   // S0 filter, S1 glissando, S2 finetune, S3 vibrato wave
    FX_VOLUME, FX_PAN,    FX_FLOW,   FX_SAMPLE,  // S4 tremolo wave, S5 panbrello wave, S6 fine delay, S7 NNA / envelopes
    FX_PAN,    FX_PAN,    FX_SAMPLE, FX_FLOW,    // S8 pan, S9 sound control, SA high offset, SB loop
    FX_SAMPLE, FX_SAMPLE, FX_FLOW,   FX_SAMPLE,  // SC note cut, SD note delay, SE pattern delay, SF macro
];

function effectFamily(effect, param) {
    if (effect === 19) return MODCMDEX_FAMILY[param >> 4] ?? '';
    if (effect === 20) return S3MCMDEX_FAMILY[param >> 4] ?? '';
    return EFFECT_FAMILY[effect] ?? '';
}

// Volume column commands (enum VolumeCommand). VOLCMD_VOLUME (1) stays in
// the plain --tracker-volume colour; everything else joins a family.
const VOLCMD_FAMILY = [
    '', '', FX_PAN, FX_VOLUME, FX_VOLUME, FX_VOLUME, FX_VOLUME, FX_PITCH,
    FX_PITCH, FX_PAN, FX_PAN, FX_PITCH, FX_PITCH, FX_PITCH, FX_SAMPLE, FX_SAMPLE,
];

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
    const volcmd = note[2];
    const effect = note[3];
    return {
        note:
            note[0] === 0 ? '' :
            note[0] === 255 ? '===' :
            note[0] === 254 ? '^^.' :
            NOTES[(note[0] - 1) % 12] + (Math.floor((note[0] - 1) / 12) - 1),
        sample: note[1] === 0 ? '' : hb(note[1]),
        // A volume-column command with a zero argument (v00, p00, …) is still
        // a command; only an empty column is blank.
        volume:
            effect === 13 ? padNumber(note[5]) :
            (volcmd !== 0 || note[4] !== 0) ? padNumber(note[4]) :
            '',
        volumeClass: VOLCMD_FAMILY[volcmd] ?? '',
        effect:
            (effect === 0 || effect === 13) ? '' :
            (EFFECT_LETTERS[effect] ?? '?') + hb(note[5]),
        effectClass: effect === 13 ? '' : effectFamily(effect, note[5]),
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
        `<span class="volume${n.volumeClass}">${n.volume || EMPTY_VOLUME}</span>` +
        `<span class="effect${n.effectClass}">${n.effect || EMPTY_EFFECT}</span>`
    );
}
