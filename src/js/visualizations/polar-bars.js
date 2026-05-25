import {
    defineVisualization,
    MAX_CHANNELS,
    rgbOf,
    vizGlow,
    vizGridSoft,
    vizPrimary,
    volumeRgb,
    WHITE_RGB,
} from '../viz-core.js';

export const name = 'Polar Bars';

const NUM_RAYS = 12;

// Per-channel persistent rotation phase so each channel's clock spins on
// its own slightly different rhythm.
const phaseByChannel = new Array(MAX_CHANNELS).fill(0);

function drawCompass(ctx, cx, cy, radius) {
    // Compass tick marks at every ray angle — gives the "clock face" frame.
    ctx.strokeStyle = vizGridSoft;
    ctx.lineWidth = 0.6;
    for (let i = 0; i < NUM_RAYS; i++) {
        const a = (i / NUM_RAYS) * Math.PI * 2;
        const r0 = radius * 0.88;
        const r1 = radius;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
}

const { draw, idle } = defineVisualization({
    draw({ ctx, width, height }, vol, col) {
        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(width, height) * 0.45;

        // Channel's own phase advances slightly each frame, faster when louder.
        phaseByChannel[col] = (phaseByChannel[col] + 0.01 + vol.maxVolume * 0.05) % (Math.PI * 2);
        const phase = phaseByChannel[col];

        drawCompass(ctx, cx, cy, radius);

        const { r, g, b } = volumeRgb(vol.maxVolume);
        const baseLen = radius * 0.15;
        const peakLen = radius * 0.95 * (0.3 + vol.maxVolume * 0.7);

        ctx.lineWidth = Math.max(1.2, radius * 0.07);
        ctx.lineCap = 'round';

        for (let i = 0; i < NUM_RAYS; i++) {
            const a = phase + (i / NUM_RAYS) * Math.PI * 2;
            // Stereo-aware: rays whose angle is left-of-vertical get leftVolume bias,
            // right side gets rightVolume bias. Subtle but noticeable.
            const side = Math.cos(a);
            const bias = side > 0 ? vol.rightVolume : vol.leftVolume;
            const len = baseLen + (peakLen - baseLen) * (0.4 + 0.6 * bias);

            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.7 + 0.3 * bias})`;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * baseLen, cy + Math.sin(a) * baseLen);
            ctx.lineTo(cx + Math.cos(a) * len,     cy + Math.sin(a) * len);
            ctx.stroke();
        }

        // Centre hub.
        const hubRgb = rgbOf(vizPrimary) ?? WHITE_RGB;
        ctx.fillStyle = `rgba(${hubRgb.r}, ${hubRgb.g}, ${hubRgb.b}, ${0.6 + 0.4 * vol.maxVolume})`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = vizGlow;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    },
    drawIdle({ ctx, width, height }) {
        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(width, height) * 0.45;
        drawCompass(ctx, cx, cy, radius);
        // Dim cross at rest.
        ctx.strokeStyle = vizGridSoft;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(cx - radius * 0.3, cy);
        ctx.lineTo(cx + radius * 0.3, cy);
        ctx.moveTo(cx, cy - radius * 0.3);
        ctx.lineTo(cx, cy + radius * 0.3);
        ctx.stroke();
    },
    resetState(col) {
        phaseByChannel[col] = 0;
    },
});

export { draw, idle };
