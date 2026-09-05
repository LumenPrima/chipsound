// Fork-only: Mod Archive browser tab for the Library (charts, search,
// random). Kept out of the upstream PRs because it needs a server-side
// proxy (see README → "Mod Archive tab"). Self-contained: registers itself
// through registerLibraryTab() and loads its own stylesheet, so the only
// touch on shared code is the install call in index.js.

import { registerLibraryTab, modArchiveDownloadUrl } from './library.js';

// ---------- Mod Archive (charts, search, random) ----------
//
// modarchive.org has no CORS headers, so listings go through a same-origin
// proxy at ./api/modarchive that forwards an allowlist of read-only
// requests (Caddyfile / tools/dev-server.py). The HTML comes back as-is and
// is parsed here; the download itself goes straight to api.modarchive.org.

const MA_PROXY = './api/modarchive';
const MA_CHARTS = [
    { id: 'featured',   label: 'Featured',        params: { request: 'view_chart', query: 'featured' } },
    { id: 'topscore',   label: 'Top scored',      params: { request: 'view_chart', query: 'topscore' } },
    { id: 'tophits',    label: 'Most downloaded', params: { request: 'view_chart', query: 'tophits' } },
    { id: 'favourites', label: 'Top favourites',  params: { request: 'view_top_favourites' } },
];
const maState = { chart: 'featured', page: 1, search: '' };

async function maFetch(params) {
    const fresh = params.request === 'view_random';
    const res = await fetch(`${MA_PROXY}?${new URLSearchParams(params)}`, { headers: { Accept: 'text/html' }, cache: fresh ? 'no-store' : 'default' });
    if (res.status === 404) throw new Error('NO_PROXY');
    if (!res.ok) throw new Error(`proxy returned HTTP ${res.status}`);
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
}

function maIdFrom(href) {
    const m = String(href || '').match(/(?:module\.php\?|moduleid=|query=)(\d+)/);
    return m ? m[1] : null;
}

// Chart pages: <a class="chart-listing-title" href="module.php?ID">Title</a>
// … <span class="chart-listing">file.ext</span> … info line after an
// "information.png" icon. Search pages: table rows with a .format-icon and
// <a href="…view_by_moduleid&query=ID" title="Song title">file.ext</a>.
function maParseList(doc) {
    const items = [];
    for (const a of doc.querySelectorAll('a.chart-listing-title')) {
        const id = maIdFrom(a.getAttribute('href'));
        if (!id) continue;
        const table = a.closest('table');
        const file = table?.querySelector('span.chart-listing')?.textContent.trim() || '';
        const info = table?.querySelector('img[alt="info"] + a')?.textContent.trim() || '';
        items.push({ id, title: a.textContent.trim(), file, info });
    }
    if (!items.length) {
        for (const a of doc.querySelectorAll('a[href*="view_by_moduleid"]')) {
            const id = maIdFrom(a.getAttribute('href'));
            if (!id) continue;
            const row = a.closest('tr');
            items.push({ id, title: a.getAttribute('title')?.trim() || a.textContent.trim(), file: a.textContent.trim(),
                         info: row?.querySelector('.format-icon')?.textContent.trim() || '' });
        }
    }
    let pages = 1;
    for (const el of doc.querySelectorAll('a[href*="page="], select[name="page"] option')) {
        const raw = el.hasAttribute('href') ? el.getAttribute('href').match(/[?&;]page=(\d+)/)?.[1] : el.getAttribute('value');
        const n = Number(raw);
        if (Number.isFinite(n) && n > pages && n < 100000) pages = n;
    }
    return { items, pages };
}

function maItemToEntry(it) {
    const ext = (it.file.split('.').pop() || '').toUpperCase();
    return {
        title: it.title || it.file,
        subtitle: it.file && it.file !== it.title ? it.file : '',
        meta: [ext, it.info !== ext ? it.info : ''].filter(Boolean).join(' · '),
        url: modArchiveDownloadUrl(it.id),
        name: it.file || undefined,
    };
}

const modArchiveTab = {
    id: 'modarchive', label: 'Mod Archive', icon: 'fa-server',
    async render(body, api) {
        const bar = document.createElement('form');
        bar.className = 'library-ma-bar';
        bar.innerHTML = `
            <select class="retro-select" name="chart" aria-label="Chart"></select>
            <input type="search" class="retro-select" name="q" placeholder="Search title or filename…" spellcheck="false" autocomplete="off" aria-label="Search The Mod Archive">
            <button type="submit" class="retro-button retro-button-icon" title="Search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
            <button type="button" class="retro-button retro-button-icon ma-random" title="Play a random module"><i class="fa-solid fa-dice" aria-hidden="true"></i> <span class="btn-label">Random</span></button>`;
        const chartSel = bar.elements.chart;
        for (const c of MA_CHARTS) {
            const o = document.createElement('option'); o.value = c.id; o.textContent = c.label; chartSel.appendChild(o);
        }
        chartSel.value = maState.chart;
        bar.elements.q.value = maState.search;
        body.appendChild(bar);

        const status = document.createElement('p');
        status.className = 'library-blurb';
        body.appendChild(status);

        const holder = document.createElement('div');
        holder.className = 'library-listing';
        body.appendChild(holder);

        const pager = document.createElement('div');
        pager.className = 'library-pager';
        pager.innerHTML = `<button type="button" class="retro-button retro-button-icon" data-dir="-1" aria-label="Previous page"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <span class="library-pager-label"></span>
            <button type="button" class="retro-button retro-button-icon" data-dir="1" aria-label="Next page"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
        body.appendChild(pager);

        let pages = 1;
        const load = async () => {
            holder.textContent = 'Loading…';
            pager.hidden = true;
            const chart = MA_CHARTS.find(c => c.id === maState.chart) || MA_CHARTS[0];
            const params = maState.search
                ? { request: 'search', query: maState.search, submit: 'Find', search_type: 'filename_or_songtitle', page: maState.page }
                : { ...chart.params, page: maState.page };
            status.textContent = maState.search ? `Search results for “${maState.search}”` : `${chart.label} on The Mod Archive`;
            let parsed;
            try {
                parsed = maParseList(await maFetch(params));
            } catch (err) {
                holder.innerHTML = '';
                const p = document.createElement('p');
                p.className = 'library-error';
                p.textContent = err.message === 'NO_PROXY'
                    ? 'This server has no Mod Archive proxy (./api/modarchive). The Caddy config ships with one; for local development run `python3 tools/dev-server.py`. See README → Mod Archive tab.'
                    : `Could not reach The Mod Archive: ${err.message}`;
                holder.appendChild(p);
                return;
            }
            pages = Math.max(1, parsed.pages);
            holder.innerHTML = '';
            holder.appendChild(api.list(parsed.items.map(maItemToEntry), { empty: maState.search ? 'No matches.' : 'Nothing listed.' }));
            pager.hidden = pages <= 1 && maState.page === 1;
            pager.querySelector('.library-pager-label').textContent = `Page ${maState.page} of ${pages}`;
            pager.querySelector('[data-dir="-1"]').disabled = maState.page <= 1;
            pager.querySelector('[data-dir="1"]').disabled = maState.page >= pages;
        };

        chartSel.addEventListener('change', () => { maState.chart = chartSel.value; maState.search = ''; bar.elements.q.value = ''; maState.page = 1; load(); });
        bar.addEventListener('submit', e => { e.preventDefault(); maState.search = bar.elements.q.value.trim(); maState.page = 1; load(); });
        bar.elements.q.addEventListener('search', () => { if (!bar.elements.q.value) { maState.search = ''; maState.page = 1; load(); } });
        pager.addEventListener('click', e => {
            const dir = Number(e.target.closest('[data-dir]')?.dataset.dir);
            if (!dir) return;
            maState.page = Math.min(pages, Math.max(1, maState.page + dir));
            load();
        });
        bar.querySelector('.ma-random').addEventListener('click', async () => {
            status.textContent = 'Picking a random module…';
            try {
                const doc = await maFetch({ request: 'view_random' });
                const link = doc.querySelector('a[href*="downloads.php?moduleid="]')?.getAttribute('href') || '';
                const id = maIdFrom(link);
                if (!id) throw new Error('no module in the response');
                const file = link.split('#')[1];
                api.load(modArchiveDownloadUrl(id), { name: file ? decodeURIComponent(file) : undefined });
            } catch (err) {
                status.textContent = `Random pick failed: ${err.message === 'NO_PROXY' ? 'no proxy on this server' : err.message}`;
            }
        });

        await load();
    },
};

export function installModArchiveTab() {
    if (!document.querySelector('link[data-library-modarchive]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/library-modarchive.css', import.meta.url).href;
        link.dataset.libraryModarchive = '1';
        document.head.appendChild(link);
    }
    registerLibraryTab(modArchiveTab, { before: 'url' });
}
