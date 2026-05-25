import {
    defineVisualization,
    fillBackground,
    nebulaStateByChannel,
    stepParticles,
    vizGlow,
    vizGridSoft,
    vizPrimary,
    volumeRgb
} from '../viz-core.js';

const MAX_WAVES_PER_CHANNEL      = 24;
const MAX_STARBURSTS_PER_CHANNEL = 32;

function ensureState(state) {
    if (state.time === undefined) state.time = 0;
    if (!state.waves) state.waves = [];
    if (!state.starbursts) state.starbursts = [];
}

function paintBackground({ ctx, width, height }) {
    fillBackground(ctx, width, height);
}

function drawDimCore(ctx, width, height) {
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = vizGridSoft;
    ctx.shadowBlur = 0.2;
    ctx.shadowColor = vizGlow;
    ctx.fill();
    ctx.shadowBlur = 0;
}

export const name = 'Nebula Pulse';

const { draw, idle } = defineVisualization({
    background: paintBackground,
    draw({ ctx, width, height }, vol, col) {
        const state = nebulaStateByChannel[col];
        ensureState(state);
        state.time += 0.016;

        const { maxVolume } = vol;
        const glowIntensity = 5 + 5 * (maxVolume * 0.5 + 0.5 * Math.abs(Math.sin(state.time * 4)));
        const coreRadius = 6 + 3 * maxVolume;
        const { r, g, b } = volumeRgb(maxVolume);
        const coreColor = `rgb(${r}, ${g}, ${b})`;
        const waveColor = `rgba(${r}, ${g}, ${b}, 0.3)`;

        const pulseSpeed = 3;
        if (Math.random() < 0.2 * (maxVolume + 0.5)) {
            state.waves.push({
                radius: 0,
                opacity: 0.3,
                speed: pulseSpeed * (0.5 + maxVolume * 0.5),
                phase: Math.random() * Math.PI * 2,
            });
        }

        stepParticles(state.waves, {
            update(w) {
                w.radius += w.speed * 0.016;
                w.opacity -= 0.002;
            },
            isAlive(w) { return w.opacity > 0; },
            draw(w) {
                ctx.beginPath();
                ctx.arc(width / 2, height / 2, w.radius, 0, Math.PI * 2);
                ctx.strokeStyle = waveColor;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            },
            cap: MAX_WAVES_PER_CHANNEL,
        });

        if (Math.random() < 0.15 * maxVolume) {
            state.starbursts.push({
                angle: Math.random() * Math.PI * 2,
                orbitRadius: 10 + Math.random() * 5,
                speed: pulseSpeed * (0.3 + Math.random() * 0.2),
                life: 1,
            });
        }

        stepParticles(state.starbursts, {
            update(s) {
                s.angle += s.speed * 0.016;
                s.life -= 0.01;
            },
            isAlive(s) { return s.life > 0; },
            draw(s) {
                const x = width / 2 + Math.cos(s.angle) * s.orbitRadius;
                const y = height / 2 + Math.sin(s.angle) * s.orbitRadius;
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${s.life * 0.6})`;
                ctx.fillRect(x - 1, y - 1, 2, 2);
            },
            cap: MAX_STARBURSTS_PER_CHANNEL,
        });

        const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, coreRadius);
        gradient.addColorStop(0, coreColor);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, coreRadius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.shadowBlur = glowIntensity;
        ctx.shadowColor = vizPrimary;
        ctx.fill();
        ctx.shadowBlur = 0;
    },
    drawMuted({ ctx, width, height }) { drawDimCore(ctx, width, height); },
    resetState(col) { nebulaStateByChannel[col] = {}; },
});

export { draw, idle };
