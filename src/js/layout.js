// Anything changing chrome above the tracker triggers relayout via .app's RO.

import { $, debounce } from './dom.js';
import { relayoutTracker } from './tracker.js';

export function installResizeHandler() {
    const relayout = debounce(relayoutTracker, 50);

    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);

    const app = $('.app');
    if (app && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(relayout);
        ro.observe(app);
    }

    // FontAwesome loads async — reflow once icons reach final width.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => relayoutTracker()).catch(() => {});
    }
}
