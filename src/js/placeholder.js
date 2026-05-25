// Boot-time placeholder song. `isPlaceholder: true` skips mod-info + row hilite.

const ROWS = 64;
const CHANNELS = 4;
const SAMPLES = 8;

// Shared frozen tuple — render pipeline never mutates in place.
const EMPTY_NOTE = Object.freeze([0, 0, 0, 0, 0, 0]);

function emptyPattern() {
    const pattern = new Array(ROWS);
    for (let r = 0; r < ROWS; r++) {
        const row = new Array(CHANNELS);
        for (let c = 0; c < CHANNELS; c++) row[c] = EMPTY_NOTE;
        pattern[r] = row;
    }
    return pattern;
}

export function placeholderMeta() {
    return {
        title: '',
        isPlaceholder: true,
        song: {
            channels: CHANNELS,
            samples: new Array(SAMPLES).fill(''),
            patterns: [emptyPattern()],
            orders: [0],
            totalOrders: 1,
            totalPatterns: 1,
            bpm: 125,
        },
    };
}
