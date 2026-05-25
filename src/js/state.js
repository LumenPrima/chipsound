const muted = new Set();

export const playerState = {
    player: null,
    modpos: {},
    meta: null,
    fileName: '',

    // Suppresses stale pos messages for the previous order during a jump.
    pendingJumpOrder: null,

    // Tri-state: isPlaying/isPaused exclusive; both false = stopped.
    isPlaying: false,
    isPaused: false,

    isChannelMuted(col) {
        return muted.has(col);
    },
    toggleChannelMute(col) {
        if (muted.has(col)) muted.delete(col); else muted.add(col);
        return muted.has(col);
    },
    setChannelMuted(col, value) {
        if (value) muted.add(col); else muted.delete(col);
    },
    resetChannelMutes() {
        muted.clear();
    },
    get mutedChannels() {
        return muted;
    },
};
