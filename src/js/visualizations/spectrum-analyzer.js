import {
    applyVHSGlitch,
    defineVisualization,
    drawGridBackground,
    drawNoSignalBars,
    fillBackground,
    vizPrimary,
    vizSecondary
} from '../viz-core.js';

function drawGridFrame({ ctx, width, height }) {
    fillBackground(ctx, width, height);
    drawGridBackground(ctx, width, height);
}

export const name = 'Spectrum Analyzer';

const { draw, idle } = defineVisualization({
    background: drawGridFrame,
    draw({ ctx, width, height }, vol) {
        const { maxVolume } = vol;
        const numBars = 10;
        const barWidth = width / numBars - 2;
        const maxBarHeight = height * 0.8;
        const time = 0;

        for (let i = 0; i < numBars; i++) {
            const fluctuation = Math.sin(time + i * 0.5) * 0.1 + (Math.random() - 0.5) * 0.2;
            const barHeight = Math.max(10, maxBarHeight * (maxVolume + fluctuation));
            const x = i * (barWidth + 2);
            const y = height - barHeight;

            const gradient = ctx.createLinearGradient(x, height, x, y);
            gradient.addColorStop(0, vizPrimary);
            gradient.addColorStop(1, vizSecondary);

            ctx.fillStyle = gradient;
            ctx.shadowBlur = 8;
            ctx.shadowColor = vizPrimary;
            ctx.fillRect(x, y, barWidth, barHeight);
            ctx.shadowBlur = 0;
        }
    },
    drawMuted({ ctx, width, height }) {
        applyVHSGlitch(ctx, width, height);
        drawNoSignalBars(ctx, width, height);
    },
    drawIdle({ ctx, width, height }) {
        drawNoSignalBars(ctx, width, height);
    },
});

export { draw, idle };
