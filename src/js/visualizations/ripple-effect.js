import {
    defineVisualization,
    ripplesByChannel,
    stepParticles,
    vizGridSoft,
    vuColorForVolume
} from '../viz-core.js';

const MAX_RIPPLES = 5;

function spawn(bucket, vol) {
    if (vol.maxVolume <= 0.3) return;
    bucket.push({
        radius: 2,
        opacity: Math.min(vol.maxVolume * 1.2, 1.0),
    });
}

export const name = 'Ripple Effect';

const { draw, idle } = defineVisualization({
    canvas: { crtEffect: 'circle' },
    draw({ ctx, width, height }, vol, col) {
        const bucket = ripplesByChannel[col];
        spawn(bucket, vol);

        ctx.strokeStyle = vuColorForVolume(vol.maxVolume);
        ctx.lineWidth = 1;

        stepParticles(bucket, {
            update(r) {
                r.radius += 0.5;
                r.opacity -= 0.05;
            },
            isAlive(r) { return r.opacity > 0 && r.radius < 12; },
            draw(r) {
                ctx.beginPath();
                ctx.arc(width / 2, height / 2, r.radius, 0, Math.PI * 2);
                ctx.globalAlpha = r.opacity;
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            },
            cap: MAX_RIPPLES,
        });
    },
    drawMuted({ ctx, width, height }) {
        ctx.strokeStyle = vizGridSoft;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 4, 0, Math.PI * 2);
        ctx.stroke();
    },
    resetState(col) { ripplesByChannel[col].length = 0; },
});

export { draw, idle };
