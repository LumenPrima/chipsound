import {
    defineVisualization,
    vizGridSoft,
    vuColorForVolume
} from '../viz-core.js';

export const name = 'Glow Bars';

const BAR_WIDTH = 20;

const { draw, idle } = defineVisualization({
    canvas: { crtEffect: 'topbottom' },
    draw({ ctx, width, height }, vol) {
        const { maxVolume } = vol;
        const barX = (width - BAR_WIDTH) / 2;
        const maxBarHeight = height - 2;
        const barHeight = maxVolume * maxBarHeight;
        const barY = height - barHeight;

        const gradient = ctx.createLinearGradient(barX, height, barX, barY);
        gradient.addColorStop(0, vuColorForVolume(maxVolume, 0.2));
        gradient.addColorStop(1, vuColorForVolume(maxVolume, 1.0));

        ctx.fillStyle = gradient;
        ctx.fillRect(barX, barY, BAR_WIDTH, barHeight);

        ctx.shadowColor = vuColorForVolume(maxVolume);
        ctx.shadowBlur = 5;
        ctx.fillRect(barX, barY, BAR_WIDTH, barHeight);
        ctx.shadowBlur = 0;
    },
    drawMuted({ ctx, width, height }) {
        const barX = (width - BAR_WIDTH) / 2;
        ctx.strokeStyle = vizGridSoft;
        ctx.lineWidth = 1;
        ctx.strokeRect(barX + 0.5, 1.5, BAR_WIDTH - 1, height - 3);
    },
});

export { draw, idle };
