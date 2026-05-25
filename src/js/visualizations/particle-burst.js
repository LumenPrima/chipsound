import {
    defineVisualization,
    particlesByChannel,
    stepParticles,
    vizGridSoft,
    volumeRgb
} from '../viz-core.js';

const MAX_PARTICLES = 20;

function spawn(bucket, vol, width, height) {
    const { maxVolume } = vol;
    if (maxVolume <= 0.3) return;
    const count = Math.floor(maxVolume * 5);
    const ox = width  * (0.1 + Math.random() * 0.8);
    const oy = height * (0.1 + Math.random() * 0.8);
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.5 + maxVolume * 1.5;
        const t = Math.max(0, Math.min(1, maxVolume + (Math.random() - 0.5) * 0.5));
        const { r, g, b } = volumeRgb(t);
        bucket.push({
            x: ox,
            y: oy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            opacity: Math.min(maxVolume * 1.2, 1.0),
            size: 2,
            color: `rgb(${r}, ${g}, ${b})`,
            fadeColor: `rgba(${r}, ${g}, ${b}, 0)`,
        });
    }
}

export const name = 'Particle Burst';

const { draw, idle } = defineVisualization({
    draw({ ctx, width, height }, vol, col) {
        const bucket = particlesByChannel[col];
        spawn(bucket, vol, width, height);

        stepParticles(bucket, {
            update(p) {
                p.x += p.vx;
                p.y += p.vy;
                p.opacity -= 0.05;
            },
            isAlive(p) {
                return p.opacity > 0 && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;
            },
            draw(p) {
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
                g.addColorStop(0, p.color);
                g.addColorStop(1, p.fadeColor);
                ctx.fillStyle = g;
                ctx.globalAlpha = p.opacity;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;
            },
            cap: MAX_PARTICLES,
        });
    },
    drawMuted({ ctx, width, height }) {
        ctx.fillStyle = vizGridSoft;
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 2, 0, Math.PI * 2);
        ctx.fill();
    },
    resetState(col) { particlesByChannel[col].length = 0; },
});

export { draw, idle };
