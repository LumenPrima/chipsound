import {
    registerCanvas,
    clearCanvasCache,
    invalidateCanvasSizes,
    getChannelVolumes,
    setPalette as applyPalette,
} from './viz-core.js';

// Empty until setManifest arrives — early draw/idle becomes a no-op.
let byId = Object.create(null);
const loaded = new Map();
const loading = new Map();

function ensureLoaded(id) {
    if (loaded.has(id)) return Promise.resolve(loaded.get(id));
    if (loading.has(id)) return loading.get(id);

    const entry = byId[id];
    if (!entry) return Promise.resolve(null);

    const p = import(entry.url)
        .then(mod => {
            loaded.set(id, mod);
            loading.delete(id);
            return mod;
        })
        .catch(err => {
            console.error(`Failed to load viz "${id}" in worker:`, err);
            loading.delete(id);
            return null;
        });
    loading.set(id, p);
    return p;
}

const muteSet = new Set();
function syncMute(mutedIds) {
    muteSet.clear();
    if (!mutedIds) return;
    for (let i = 0; i < mutedIds.length; i++) muteSet.add(mutedIds[i]);
}

// Reused across frames — vizs only read `song.channels`, so a single mutable
// object suffices for the sync path. The async ensureLoaded() branch must
// still allocate (the closure outlives the next message tick).
const _workerSong = { channels: 0 };

// A buggy viz that throws inside draw/idle would otherwise produce 30+ console
// errors per second AND deopt the worker's hot path. We log up to N times per
// id, then disable it for the rest of the session. Disabled-set lookup is a
// single O(1) Set.has on the happy path — no measurable cost.
const MAX_VIZ_ERRORS = 3;
const vizErrorCount = new Map();
const disabledVizIds = new Set();

function recordVizError(vizId, where, err) {
    const n = (vizErrorCount.get(vizId) || 0) + 1;
    vizErrorCount.set(vizId, n);
    console.error(`viz "${vizId}" ${where} error ${n}/${MAX_VIZ_ERRORS}:`, err);
    if (n >= MAX_VIZ_ERRORS) {
        disabledVizIds.add(vizId);
        console.warn(`viz "${vizId}" disabled in worker after ${MAX_VIZ_ERRORS} errors. Reload to retry.`);
    }
}

self.onmessage = (e) => {
    const msg = e.data;
    switch (msg.cmd) {
        case 'setManifest': {
            byId = Object.create(null);
            for (const entry of msg.manifest) byId[entry.id] = entry;
            break;
        }
        case 'registerCanvas': {
            registerCanvas(msg.col, msg.canvas, {
                width: msg.width,
                height: msg.height,
                bg: msg.bg,
            });
            break;
        }
        case 'clearCanvasCache': {
            clearCanvasCache();
            break;
        }
        case 'invalidateSizes': {
            invalidateCanvasSizes(msg.sizes);
            break;
        }
        case 'preload': {
            ensureLoaded(msg.vizId);
            break;
        }
        case 'setPalette': {
            applyPalette(msg.palette);
            break;
        }
        case 'draw': {
            syncMute(msg.mutedIds);
            if (disabledVizIds.has(msg.vizId)) break;
            _workerSong.channels = msg.channels;
            const mod = loaded.get(msg.vizId);
            if (mod) {
                const volumes = getChannelVolumes(_workerSong, msg.chVol, muteSet);
                try {
                    mod.draw(_workerSong, volumes);
                } catch (err) {
                    recordVizError(msg.vizId, 'draw', err);
                }
            } else {
                ensureLoaded(msg.vizId);
            }
            break;
        }
        case 'idle': {
            syncMute(msg.mutedIds);
            if (disabledVizIds.has(msg.vizId)) break;
            _workerSong.channels = msg.channels;
            const mod = loaded.get(msg.vizId);
            if (mod && mod.idle) {
                try {
                    mod.idle(_workerSong);
                } catch (err) {
                    recordVizError(msg.vizId, 'idle', err);
                }
            } else if (!mod) {
                // Snapshot channels — by the time the import resolves a later
                // message may have mutated _workerSong.
                const asyncSong = { channels: msg.channels };
                ensureLoaded(msg.vizId).then(loadedMod => {
                    if (!loadedMod?.idle || disabledVizIds.has(msg.vizId)) return;
                    try { loadedMod.idle(asyncSong); }
                    catch (err) { recordVizError(msg.vizId, 'idle', err); }
                });
            }
            break;
        }
    }
};
