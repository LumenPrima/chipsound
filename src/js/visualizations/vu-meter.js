import {
    defineVisualization,
    lastVolumes,
    vizGridSoft,
    volumeRgb
} from '../viz-core.js';

export const name = 'VU Meter';

function rgb(t) {
    const { r, g, b } = volumeRgb(t);
    return `rgb(${r}, ${g}, ${b})`;
}

const { draw, idle } = defineVisualization({
    draw({ ctx, width, height }, vol, col) {
        lastVolumes[col] += (vol.maxVolume - lastVolumes[col]) * 0.2;
        const barWidth = lastVolumes[col] * width;

        // 3-stop gradient from --viz-vol-cold/mid/hot — one source for
        // every intensity-coloured viz.
        const grad = ctx.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, rgb(0));
        grad.addColorStop(0.5, rgb(0.5));
        grad.addColorStop(1, rgb(1));

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(0, 0, barWidth, height, 4);
        ctx.fill();
    },
    drawMuted({ ctx, width, height }) {
        ctx.fillStyle = vizGridSoft;
        ctx.fillRect(0, height / 2 - 0.5, width, 1);
    },
    resetState(col) { lastVolumes[col] = 0; },
});

export { draw, idle };
