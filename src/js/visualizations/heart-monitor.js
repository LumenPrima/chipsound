import {
    defineVisualization,
    MAX_CHANNELS,
    vizGridSoft,
    vizPrimary,
    vizSecondary,
    vuColorForVolume
} from '../viz-core.js';

export const name = 'Heart Monitor';

const stateByChannel = new Array(MAX_CHANNELS).fill(null);

const SAMPLES = 96;
function ensureState(col) {
    if (stateByChannel[col]) return stateByChannel[col];
    const s = { samples: new Float32Array(SAMPLES), cursor: 0 };
    stateByChannel[col] = s;
    return s;
}

const { draw, idle } = defineVisualization({
    draw({ ctx, width, height }, vol, col) {
        const s = ensureState(col);
        s.samples[s.cursor] = vol.maxVolume;
        s.cursor = (s.cursor + 1) % SAMPLES;

        const baselineY = height * 0.65;
        const peakHeight = height * 0.55;
        const dx = width / SAMPLES;

        ctx.strokeStyle = vizGridSoft;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, baselineY);
        ctx.lineTo(width, baselineY);
        ctx.stroke();

        ctx.strokeStyle = vuColorForVolume(vol.maxVolume);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < SAMPLES; i++) {
            const idx = (s.cursor + i) % SAMPLES;
            const v = s.samples[idx];
            const x = i * dx;
            const yPeak = baselineY - v * peakHeight;
            if (i === 0) ctx.moveTo(x, baselineY); else ctx.lineTo(x, baselineY);
            if (v > 0.04) {
                ctx.lineTo(x + dx * 0.3, baselineY - v * 0.25 * peakHeight);
                ctx.lineTo(x + dx * 0.5, yPeak);
                ctx.lineTo(x + dx * 0.7, baselineY + v * 0.15 * peakHeight);
            }
        }
        ctx.lineTo(width, baselineY);
        ctx.stroke();

        const cursorX = width - dx * 0.5;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = vizSecondary;
        ctx.fillRect(cursorX, baselineY - peakHeight, 1.5, peakHeight + 4);
        ctx.globalAlpha = 1;
    },
    drawIdle({ ctx, width, height }) {
        const baselineY = height * 0.65;
        ctx.strokeStyle = vizPrimary;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(0, baselineY);
        ctx.lineTo(width, baselineY);
        ctx.stroke();
        ctx.globalAlpha = 1;
    },
    resetState(col) {
        if (stateByChannel[col]) {
            stateByChannel[col].samples.fill(0);
            stateByChannel[col].cursor = 0;
        }
    },
});

export { draw, idle };
