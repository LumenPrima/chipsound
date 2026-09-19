// Fork-only: Mod Archive tab for the Library, built on The Mod Archive's XML
// API (https://modarchive.org/index.php?xml-api). The API needs a key, which
// never reaches the browser: the tab calls ./api/modarchive?… on its own
// origin and the proxy (Caddyfile / tools/dev-server.py) adds the key and
// forwards to api.modarchive.org/xml-tools.php. Self-contained: registers
// itself through registerLibraryTab() and loads its own stylesheet, so the
// only touch on shared code is the install call in index.js.

import { registerLibraryTab, modArchiveDownloadUrl } from './library.js';

const MA_PROXY = './api/modarchive';

// Level 3 keys (the free tier) get the browse lists; the charts need level 5.
// A chart on a level 3 key comes back as an API error, shown as such.
const MA_LISTS = [
    { id: 'featured', group: 'Charts', label: 'Featured',        params: { request: 'chart', query: 'featured' } },
    { id: 'topscore', group: 'Charts', label: 'Top scored',      params: { request: 'chart', query: 'topscore' } },
    { id: 'tophits',  group: 'Charts', label: 'Most downloaded', params: { request: 'chart', query: 'tophits' } },
    { id: 'rated10',  group: 'Browse', label: 'Reviewed 10/10',  params: { request: 'view_by_rating_reviews', query: '10' } },
    { id: 'rated9',   group: 'Browse', label: 'Reviewed 9/10',   params: { request: 'view_by_rating_reviews', query: '9' } },
    { id: 'rated8',   group: 'Browse', label: 'Reviewed 8/10',   params: { request: 'view_by_rating_reviews', query: '8' } },
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => ({
        id: `alpha-${l}`, group: 'By filename', label: l, params: { request: 'view_by_list', query: l },
    })),
];
const MA_FORMATS = [
    { id: '',    label: 'Any format' },
    { id: 'mod', label: 'MOD' },
    { id: 'xm',  label: 'XM' },
    { id: 's3m', label: 'S3M' },
    { id: 'it',  label: 'IT' },
];
const maState = { list: 'featured', format: '', page: 1, search: '' };

// Proxy → XML document. Distinguishes "no proxy" (404), "no key" (503) and
// API-level errors (<error> in the body) so the tab can say what's missing.
async function maFetch(params) {
    const fresh = params.request === 'random';
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
    const res = await fetch(`${MA_PROXY}?${query}`, { headers: { Accept: 'text/xml' }, cache: fresh ? 'no-store' : 'default' });
    if (res.status === 404) throw new Error('NO_PROXY');
    if (res.status === 503) throw new Error('NO_KEY');
    if (!res.ok) throw new Error(`proxy returned HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('unreadable reply from the API');
    const err = doc.querySelector('error');
    if (err) throw new Error(`The Mod Archive API said: ${err.textContent.trim()}`);
    return doc;
}

// One <module> element → plain object. Field names follow the XML tool's
// module record (filename, songtitle, format, channels, size, id, artist_info).
function maModule(el) {
    const text = (tag, root = el) => root.getElementsByTagName(tag)[0]?.textContent.trim() ?? '';
    const artistInfo = el.getElementsByTagName('artist_info')[0];
    let artist = '';
    if (artistInfo) {
        const a = artistInfo.getElementsByTagName('artist')[0];
        artist = a ? text('alias', a) : '';
        if (!artist) {
            const g = artistInfo.getElementsByTagName('guessed_artists')[0];
            artist = g ? text('alias', g) : '';
        }
    }
    return {
        id: text('id'),
        file: text('filename'),
        title: text('songtitle'),
        format: text('format').toUpperCase(),
        channels: text('channels'),
        size: text('size'),
        artist,
    };
}

function maParseList(doc) {
    const items = [...doc.getElementsByTagName('module')].map(maModule).filter(m => m.id);
    const pages = Number(doc.getElementsByTagName('totalpages')[0]?.textContent) || 1;
    return { items, pages };
}

function maItemToEntry(m) {
    const title = m.title || m.file;
    return {
        title,
        subtitle: [m.artist, m.file !== title ? m.file : ''].filter(Boolean).join(' · '),
        meta: [m.format, m.channels ? `${m.channels} ch` : '', m.size].filter(Boolean).join(' · '),
        url: modArchiveDownloadUrl(m.id),
        name: m.file || undefined,
    };
}

function maErrorText(err) {
    if (err.message === 'NO_PROXY') return 'This server has no Mod Archive proxy (./api/modarchive). The Caddy config ships with one; for local development run `python3 tools/dev-server.py`. See README → Mod Archive tab.';
    if (err.message === 'NO_KEY') return 'This server has no Mod Archive API key (MODARCHIVE_API_KEY is not set). Keys are granted by The Mod Archive on application; see README → Mod Archive tab.';
    return `Could not reach The Mod Archive: ${err.message}`;
}

const modArchiveTab = {
    id: 'modarchive', label: 'Mod Archive', icon: 'fa-server',
    async render(body, api) {
        const bar = document.createElement('form');
        bar.className = 'library-ma-bar';
        bar.innerHTML = `
            <select class="retro-select" name="list" aria-label="List"></select>
            <select class="retro-select library-ma-format" name="format" aria-label="Format"></select>
            <input type="search" class="retro-select" name="q" placeholder="Search title or filename…" spellcheck="false" autocomplete="off" aria-label="Search The Mod Archive">
            <button type="submit" class="retro-button retro-button-icon" title="Search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
            <button type="button" class="retro-button retro-button-icon ma-random" title="Play a random module"><i class="fa-solid fa-dice" aria-hidden="true"></i> <span class="btn-label">Random</span></button>`;
        const listSel = bar.elements.list;
        let group = null;
        for (const l of MA_LISTS) {
            if (!group || group.label !== l.group) {
                group = document.createElement('optgroup');
                group.label = l.group;
                listSel.appendChild(group);
            }
            const o = document.createElement('option'); o.value = l.id; o.textContent = l.label; group.appendChild(o);
        }
        listSel.value = maState.list;
        const formatSel = bar.elements.format;
        for (const f of MA_FORMATS) {
            const o = document.createElement('option'); o.value = f.id; o.textContent = f.label; formatSel.appendChild(o);
        }
        formatSel.value = maState.format;
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
            const list = MA_LISTS.find(l => l.id === maState.list) || MA_LISTS[0];
            const params = maState.search
                ? { request: 'search', type: 'filename_or_songtitle', query: maState.search, page: maState.page, format: maState.format }
                : { ...list.params, page: maState.page, format: maState.format };
            status.textContent = maState.search
                ? `Search results for “${maState.search}”`
                : `${list.group === 'By filename' ? `Filenames starting with ${list.label}` : list.label} on The Mod Archive`;
            let parsed;
            try {
                parsed = maParseList(await maFetch(params));
            } catch (err) {
                holder.innerHTML = '';
                const p = document.createElement('p');
                p.className = 'library-error';
                p.textContent = maErrorText(err);
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

        listSel.addEventListener('change', () => { maState.list = listSel.value; maState.search = ''; bar.elements.q.value = ''; maState.page = 1; load(); });
        formatSel.addEventListener('change', () => { maState.format = formatSel.value; maState.page = 1; load(); });
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
                const doc = await maFetch({ request: 'random', format: maState.format });
                const m = maParseList(doc).items[0];
                if (!m) throw new Error('no module in the reply');
                status.textContent = `Random pick: ${m.title || m.file}`;
                api.load(modArchiveDownloadUrl(m.id), { name: m.file || undefined });
            } catch (err) {
                status.textContent = `Random pick failed: ${maErrorText(err)}`;
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
