import {
    defineVisualization,
    vuColorForVolume
} from '../viz-core.js';

export const name = 'Pulsing Circles';

const { draw, idle } = defineVisualization({
    canvas: { crtEffect: 'circle' },
    draw({ ctx, width, height }, vol) {
        const radius = 4 + vol.maxVolume * 6;
        ctx.fillStyle = vuColorForVolume(vol.maxVolume, 0.3 + vol.maxVolume * 0.7);
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
        ctx.fill();
    },
    drawIdle({ ctx, width, height }) {
        ctx.fillStyle = vuColorForVolume(0, 0.3);
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 4, 0, Math.PI * 2);
        ctx.fill();
    },
});

export { draw, idle };
