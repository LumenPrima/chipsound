import {
    defineVisualization,
    MAX_CHANNELS,
    vizGridSoft,
    vuColorForVolume,
} from '../viz-core.js';

export const name = 'Bouncing Balls';

const BALLS_PER_CHANNEL = 3;
const GRAVITY  = 0.35;
const DAMPING  = 0.78;
const KICK_MIN = 0.25;
const RADIUS   = 3.5;

const ballsByChannel = new Array(MAX_CHANNELS).fill(null);

function ensureBalls(col, width, height) {
    let balls = ballsByChannel[col];
    if (!balls || balls.length !== BALLS_PER_CHANNEL) {
        balls = new Array(BALLS_PER_CHANNEL);
        for (let i = 0; i < BALLS_PER_CHANNEL; i++) {
            balls[i] = {
                x: width  * (0.25 + (i / BALLS_PER_CHANNEL) * 0.5),
                y: height - RADIUS,
                vx: (Math.random() - 0.5) * 0.6,
                vy: 0,
                hue: 0,
            };
        }
        ballsByChannel[col] = balls;
    }
    return balls;
}

function step(b, width, height) {
    b.vy += GRAVITY;
    b.x += b.vx;
    b.y += b.vy;
    if (b.x < RADIUS)         { b.x = RADIUS;          b.vx = -b.vx * DAMPING; }
    if (b.x > width - RADIUS) { b.x = width - RADIUS;  b.vx = -b.vx * DAMPING; }
    if (b.y < RADIUS)         { b.y = RADIUS;          b.vy = -b.vy * DAMPING; }
    if (b.y > height - RADIUS) {
        b.y = height - RADIUS;
        b.vy = -b.vy * DAMPING;
        b.vx *= 0.95;
    }
    if (Math.abs(b.vy) < 0.05 && b.y >= height - RADIUS - 0.5) b.vy = 0;
    if (Math.abs(b.vx) < 0.05) b.vx *= 0.5;
}

// Cap so the apex of a free-fall kick from the floor sits at ~90 % of the
// available clearance — leaves a small headroom for the ceiling so balls
// never visibly clip the top edge.
function maxKickVelocity(height) {
    const reach = Math.max(1, height - 2 * RADIUS);
    return Math.sqrt(2 * GRAVITY * reach) * 0.95;
}

function kick(balls, vol, height) {
    if (vol <= KICK_MIN) return;
    const intensity = (vol - KICK_MIN) / (1 - KICK_MIN);
    const vMax = maxKickVelocity(height);
    for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        // Only launch settled balls. Mid-flight balls follow physics on their
        // own — re-kicking them would compound velocity and pin them to the top.
        const onFloor = b.y >= height - RADIUS - 0.5 && Math.abs(b.vy) < 0.6;
        if (!onFloor) continue;
        if (Math.random() < 0.35 + 0.5 * intensity) {
            const want = 1.6 + intensity * (vMax - 1.6);
            b.vy = -Math.min(want, vMax);
            b.vx += (Math.random() - 0.5) * 1.5 * intensity;
            b.hue = vol;
        }
    }
}

function paint(ctx, balls) {
    for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        ctx.fillStyle = vuColorForVolume(Math.max(0.2, b.hue));
        ctx.beginPath();
        ctx.arc(b.x, b.y, RADIUS, 0, Math.PI * 2);
        ctx.fill();
        b.hue *= 0.97;
    }
}

function drawFloor(ctx, width, height) {
    ctx.strokeStyle = vizGridSoft;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
}

const { draw, idle } = defineVisualization({
    draw({ ctx, width, height }, vol, col) {
        const balls = ensureBalls(col, width, height);
        kick(balls, vol.maxVolume, height);
        for (let i = 0; i < balls.length; i++) step(balls[i], width, height);
        drawFloor(ctx, width, height);
        paint(ctx, balls);
    },
    drawMuted({ ctx, width, height }, col) {
        const balls = ensureBalls(col, width, height);
        for (let i = 0; i < balls.length; i++) step(balls[i], width, height);
        drawFloor(ctx, width, height);
        ctx.fillStyle = vizGridSoft;
        for (let i = 0; i < balls.length; i++) {
            ctx.beginPath();
            ctx.arc(balls[i].x, balls[i].y, RADIUS, 0, Math.PI * 2);
            ctx.fill();
        }
    },
    drawIdle({ ctx, width, height }, col) {
        const balls = ensureBalls(col, width, height);
        for (let i = 0; i < balls.length; i++) {
            balls[i].y = height - RADIUS;
            balls[i].vx = 0;
            balls[i].vy = 0;
            balls[i].hue = 0;
        }
        drawFloor(ctx, width, height);
        ctx.fillStyle = vizGridSoft;
        for (let i = 0; i < balls.length; i++) {
            ctx.beginPath();
            ctx.arc(balls[i].x, balls[i].y, RADIUS, 0, Math.PI * 2);
            ctx.fill();
        }
    },
    resetState(col) {
        ballsByChannel[col] = null;
    },
});

export { draw, idle };
