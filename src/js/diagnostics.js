import { getPatternCacheSize, getRenderQueueSize } from './tracker.js';

const PREFIX = '[diag]';

function readHeap() {
    if (!performance.memory) return null;
    const m = performance.memory;
    return {
        usedMB:  (m.usedJSHeapSize  / 1e6).toFixed(1),
        totalMB: (m.totalJSHeapSize / 1e6).toFixed(1),
        limitMB: (m.jsHeapSizeLimit / 1e6).toFixed(0),
    };
}

function isDiagnosticsRequested() {
    try {
        const params = new URLSearchParams(location.search);
        return params.has('diag');
    } catch {
        return false;
    }
}

let installed = false;
export function installDiagnostics() {
    if (installed) return true;
    if (!isDiagnosticsRequested()) return false;
    installed = true;

    console.warn(`${PREFIX} ACTIVE. Open Console, filter for "${PREFIX}" to see live data.`);
    console.warn(`${PREFIX} Long-task threshold = 50 ms. RAF stall threshold = 25 ms.`);

    installLongTaskObserver();
    installPeriodicSnapshot();
    installRafJitterWatchdog();
    return true;
}

function installLongTaskObserver() {
    if (typeof PerformanceObserver === 'undefined') {
        console.warn(`${PREFIX} PerformanceObserver unavailable; long-task tracking off.`);
        return;
    }
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        console.warn(`${PREFIX} 'longtask' entry type unavailable; long-task tracking off.`);
        return;
    }

    const obs = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
            const attr = entry.attribution?.map(a => a.name || a.containerType).join(',') || '?';
            console.warn(
                `${PREFIX} LONG TASK ${entry.duration.toFixed(0)} ms ` +
                `at t=${(entry.startTime / 1000).toFixed(2)}s ` +
                `(${attr})`
            );
        }
    });

    try {
        obs.observe({ type: 'longtask', buffered: true });
    } catch (err) {
        console.warn(`${PREFIX} Could not start longtask observer:`, err);
    }
}

function installPeriodicSnapshot() {
    const SNAPSHOT_INTERVAL_MS = 5000;
    let snapshotCount = 0;
    let lastHeap = null;
    let lastNodes = 0;

    setInterval(() => {
        snapshotCount++;
        const heap  = readHeap();
        const cache = getPatternCacheSize();
        const queue = getRenderQueueSize();
        const nodes = document.querySelectorAll('*').length;

        const heapDelta = (heap && lastHeap)
            ? (parseFloat(heap.usedMB) - parseFloat(lastHeap.usedMB)).toFixed(1)
            : null;
        const nodeDelta = snapshotCount > 1 ? (nodes - lastNodes) : null;

        const parts = [
            `${PREFIX} #${snapshotCount}`,
            heap ? `heap=${heap.usedMB}/${heap.totalMB} MB (Δ${heapDelta >= 0 ? '+' : ''}${heapDelta})` : 'heap=n/a',
            `cache=${cache}`,
            `queue=${queue}`,
            `dom=${nodes}${nodeDelta != null ? ` (Δ${nodeDelta >= 0 ? '+' : ''}${nodeDelta})` : ''}`,
        ];
        console.log(parts.join(' | '));

        lastHeap = heap;
        lastNodes = nodes;
    }, SNAPSHOT_INTERVAL_MS);
}

// Catches sustained <40 fps stutters that no single <50 ms task triggers.
function installRafJitterWatchdog() {
    const STALL_MS = 25;
    const RUN_LENGTH = 3;
    let lastFrame = 0;
    let consecutiveSlow = 0;

    function tick(now) {
        if (lastFrame > 0) {
            const gap = now - lastFrame;
            if (gap > STALL_MS) {
                consecutiveSlow++;
                if (consecutiveSlow >= RUN_LENGTH) {
                    console.warn(
                        `${PREFIX} RAF STALL: ${consecutiveSlow} consecutive ` +
                        `frames slower than ${STALL_MS} ms (last gap ${gap.toFixed(0)} ms)`
                    );
                    consecutiveSlow = 0;
                }
            } else {
                consecutiveSlow = 0;
            }
        }
        lastFrame = now;
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}
