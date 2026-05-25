import {
    defineVisualization,
    drawOscilloscopeLine,
    vizGrid,
    vizPrimary,
    vizSecondary
} from '../viz-core.js';

function drawFlatline(ctx, width, height) {
    ctx.strokeStyle = vizGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
}

export const name = 'Oscilloscopes';

const { draw, idle } = defineVisualization({
    canvas: { crtEffect: 'hline' },
    draw({ ctx, width, height }, vol) {
        const freqVariation = (Math.random() - 0.5) * 0.05;
        drawOscilloscopeLine(ctx, 0, width, height, vol.leftVolume, vizPrimary, freqVariation);
        drawOscilloscopeLine(ctx, 0, width, height, vol.rightVolume, vizSecondary, -freqVariation);
    },
    drawMuted({ ctx, width, height }) { drawFlatline(ctx, width, height); },
});

export { draw, idle };
