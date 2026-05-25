import {
    defineVisualization,
    MAX_CHANNELS,
    vizGrid,
    vizPrimary,
    volumeRgb
} from '../viz-core.js';

export const name = 'Waveform Terrain';

const HISTORY = 64;
const historyByChannel = new Array(MAX_CHANNELS).fill(null);

function getHistory(col) {
    if (!historyByChannel[col]) historyByChannel[col] = new Float32Array(HISTORY);
    return historyByChannel[col];
}

const { draw, idle } = defineVisualization({
    draw({ ctx, width, height }, vol, col) {
        const history = getHistory(col);
        history.copyWithin(0, 1);
        history[HISTORY - 1] = vol.maxVolume;

        const horizonY = height * 0.55;
        const peakHeight = height * 0.5;

        const { r, g, b } = volumeRgb(vol.maxVolume);
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.5)`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, horizonY);
        for (let i = 0; i < HISTORY; i++) {
            const x = (i / (HISTORY - 1)) * width;
            const y = horizonY - history[i] * peakHeight;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(width, horizonY);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < HISTORY; i++) {
            const x = (i / (HISTORY - 1)) * width;
            const y = horizonY - history[i] * peakHeight;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.strokeStyle = vizGrid;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(0, horizonY);
        ctx.lineTo(width, horizonY);
        ctx.stroke();
    },
    drawIdle({ ctx, width, height }) {
        const horizonY = height * 0.55;
        ctx.strokeStyle = vizPrimary;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(0, horizonY);
        ctx.lineTo(width, horizonY);
        ctx.stroke();
        ctx.globalAlpha = 1;
    },
    resetState(col) {
        if (historyByChannel[col]) historyByChannel[col].fill(0);
    },
});

export { draw, idle };
