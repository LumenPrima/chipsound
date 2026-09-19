// Fork-only: "Scene" tab for the Library — browses a Scene Browser instance
// (https://github.com/LumenPrima/… /scenebrowser: a music-first index of the
// Demozoo database with resolved Modland / Mod Archive download links).
// The tab talks to ./api/scene/* on its own origin; the proxy (Caddyfile /
// tools/dev-server.py) forwards to the Scene Browser's /api/*. Self-contained
// like the Mod Archive tab: registers itself and loads its own stylesheet.

import { registerLibraryTab } from './library.js';

const SCENE_PROXY = './api/scene';
const DECADES = [['', 'Any era'], ['1980', '1980s'], ['1990', '1990s'], ['2000', '2000s'], ['2010', '2010s'], ['2020', '2020s']];
const FORMATS = [['', 'Any format'], ['mod', 'MOD'], ['xm', 'XM'], ['it', 'IT'], ['s3m', 'S3M'], ['ahx', 'AHX'], ['med', 'MED'], ['dbm', 'DBM'], ['okt', 'OKT'], ['mptm', 'MPTM']];
const SORTS = [['placing', 'Best placing'], ['date', 'Newest'], ['oldest', 'Oldest'], ['title', 'Title'], ['relevance', 'Relevance']];

// Persisted for the session so reopening the Library lands where you left it.
const st = { q: '', decade: '', format: '', sort: 'placing', page: 1, releaser: null, party: null };
let config = null;   // { ui_url, name } from the Scene Browser, once fetched

async function sceneFetch(path, params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
    const res = await fetch(`${SCENE_PROXY}/${path}${query.size ? '?' + query : ''}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new Error('NO_PROXY');
    if (res.status === 502 || res.status === 503) throw new Error('DOWN');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function errorText(err) {
    if (err.message === 'NO_PROXY') return 'This server has no Scene Browser proxy (./api/scene). The Caddy config ships with one; for local development run `python3 tools/dev-server.py`. See README → Scene tab.';
    if (err.message === 'DOWN') return 'The Scene Browser behind ./api/scene is not answering (is it running? SCENE_API_URL). See README → Scene tab.';
    return `Could not reach the Scene Browser: ${err.message}`;
}

const ordinal = n => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || 'th'}`;
// Modland URLs end in the real filename; Mod Archive downloads end in
// downloads.php, so leave those unnamed and let the player label them by id.
const fileNameOf = url => {
    try {
        const last = decodeURIComponent(new URL(url).pathname.split('/').pop());
        return /\.(php|cgi|aspx?)$/i.test(last) ? undefined : last;
    } catch { return undefined; }
};

function byLine(m) {
    const a = (m.authors || []).map(x => x.nick).join(', ');
    const g = (m.groups || []).map(x => x.nick).join(', ');
    return a && g ? `${a} / ${g}` : a || g || 'unknown';
}

// One track row: the playable button in the shared .library-item style, plus a
// chip line for drilling into the author(s) and the party it placed at.
function trackRow(m, api, refine) {
    const li = document.createElement('li');
    li.className = 'library-scene-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'library-item';
    const best = m.best;
    const sub = [byLine(m), best ? `${ordinal(best.position)} · ${best.party}` : (m.placings?.[0]?.party || '')].filter(Boolean).join(' · ');
    const meta = [m.format?.toUpperCase(), m.year, (m.platforms || [])[0]].filter(Boolean).join(' · ');
    btn.innerHTML = `<i class="fa-solid fa-play" aria-hidden="true"></i><span class="library-item-title"></span><span class="library-item-sub"></span><span class="library-item-meta"></span>`;
    btn.querySelector('.library-item-title').textContent = m.title || '(untitled)';
    btn.querySelector('.library-item-sub').textContent = sub;
    btn.querySelector('.library-item-meta').textContent = meta;
    btn.addEventListener('click', () => api.load(m.play_url, { name: fileNameOf(m.play_url) }));
    li.appendChild(btn);

    const chips = document.createElement('div');
    chips.className = 'library-scene-chips';
    for (const a of [...(m.authors || []), ...(m.groups || [])]) {
        const c = document.createElement('button');
        c.type = 'button'; c.className = 'library-scene-chip';
        c.textContent = a.nick;
        c.title = `All tracks by ${a.nick}`;
        c.addEventListener('click', () => refine({ releaser: { id: a.id, name: a.nick } }));
        chips.appendChild(c);
    }
    if (best) {
        const c = document.createElement('button');
        c.type = 'button'; c.className = 'library-scene-chip library-scene-chip-party';
        c.textContent = best.party;
        c.title = `${best.compo} at ${best.party}`;
        c.addEventListener('click', () => refine({ party: { id: best.party_id, name: best.party } }));
        chips.appendChild(c);
    }
    if (chips.childElementCount) li.appendChild(chips);
    return li;
}

const sceneTab = {
    id: 'scene', label: 'Scene', icon: 'fa-users',
    async render(body, api) {
        const bar = document.createElement('form');
        bar.className = 'library-ma-bar library-scene-bar';
        bar.innerHTML = `
            <input type="search" class="retro-select" name="q" placeholder="Track, musician, group, party…" spellcheck="false" autocomplete="off" aria-label="Search the scene index">
            <button type="submit" class="retro-button retro-button-icon" title="Search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
            <button type="button" class="retro-button retro-button-icon scene-random" title="Play a random track"><i class="fa-solid fa-dice" aria-hidden="true"></i> <span class="btn-label">Random</span></button>
            <a class="retro-button retro-button-icon scene-open" target="_blank" rel="noopener" title="Open the Scene Browser" hidden><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>
            <select class="retro-select library-scene-sel" name="decade" aria-label="Era"></select>
            <select class="retro-select library-scene-sel" name="format" aria-label="Format"></select>
            <select class="retro-select library-scene-sel" name="sort" aria-label="Sort"></select>`;
        const fill = (sel, opts, val) => { for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); } sel.value = val; };
        fill(bar.elements.decade, DECADES, st.decade);
        fill(bar.elements.format, FORMATS, st.format);
        fill(bar.elements.sort, SORTS, st.sort);
        bar.elements.q.value = st.q;
        body.appendChild(bar);

        const context = document.createElement('div');
        context.className = 'library-scene-context';
        body.appendChild(context);

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

        const chip = (label, title, onClick, cls = '') => {
            const c = document.createElement('button');
            c.type = 'button'; c.className = `library-scene-chip ${cls}`; c.textContent = label; c.title = title || '';
            c.addEventListener('click', onClick);
            return c;
        };
        const refine = (change) => {
            Object.assign(st, change, { page: 1 });
            if (change.releaser || change.party) { st.q = ''; bar.elements.q.value = ''; }
            load();
        };
        const clearScope = () => { st.releaser = null; st.party = null; st.page = 1; load(); };

        let pages = 1;
        const load = async () => {
            holder.textContent = 'Loading…';
            pager.hidden = true;
            context.innerHTML = '';
            const scoped = st.releaser || st.party;
            const sort = st.sort === 'relevance' && !st.q ? 'placing' : st.sort;
            const params = { playable: 1, page: st.page, sort, decade: st.decade, format: st.format,
                q: st.q, releaser: st.releaser?.id, party: st.party?.id };
            status.textContent = '';
            let data, hits = null;
            try {
                if (!config) config = await sceneFetch('config').catch(() => ({}));
                if (config.ui_url) { const a = bar.querySelector('.scene-open'); a.href = config.ui_url; a.hidden = false; }
                [data, hits] = await Promise.all([sceneFetch('music', params), st.q && !scoped ? sceneFetch('search', { q: st.q }) : null]);
            } catch (err) {
                holder.innerHTML = '';
                const p = document.createElement('p');
                p.className = 'library-error';
                p.textContent = errorText(err);
                holder.appendChild(p);
                return;
            }
            // Scope line: who/what we're looking at, with a way out.
            if (scoped) {
                const r = data.context?.releaser, pa = data.context?.party;
                const label = r ? `${r.name}${r.first_year ? ` · ${r.first_year}–${r.last_year}` : ''}` : pa ? `${pa.name}${pa.location ? ` · ${pa.location}` : ''}` : '';
                const span = document.createElement('span');
                span.className = 'library-scene-scope';
                span.textContent = label;
                context.append(span, chip('✕ all tracks', 'Clear', clearScope, 'library-scene-chip-clear'));
                if (config.ui_url) {
                    const a = document.createElement('a');
                    a.className = 'library-scene-chip'; a.target = '_blank'; a.rel = 'noopener';
                    a.href = new URL(r ? `releaser/${r.id}` : `party/${pa.id}`, config.ui_url).href;
                    a.textContent = 'full page ⧉';
                    context.appendChild(a);
                }
            } else if (hits && (hits.musicians.length || hits.groups.length || hits.parties.length)) {
                const group = (title, items, kind) => {
                    if (!items.length) return;
                    const g = document.createElement('div');
                    g.className = 'library-scene-hits';
                    const t = document.createElement('span'); t.className = 'library-scene-hits-label'; t.textContent = title; g.appendChild(t);
                    for (const it of items) {
                        const n = kind === 'party' ? it.playable_count : it.playable_count;
                        g.appendChild(chip(`${it.name}${n ? ` ${n}` : ''}`, kind === 'party' ? `${it.year || ''} · ${it.music_count} music entries` : `${it.music_count || it.group_music_count} tracks`,
                            () => refine(kind === 'party' ? { party: { id: it.id, name: it.name } } : { releaser: { id: it.id, name: it.name } }), kind === 'party' ? 'library-scene-chip-party' : ''));
                    }
                    context.appendChild(g);
                };
                group('Musicians', hits.musicians, 'releaser');
                group('Groups', hits.groups, 'group');
                group('Parties', hits.parties, 'party');
            }
            pages = Math.max(1, Math.ceil(data.total / data.per_page));
            status.textContent = data.total
                ? `${data.total.toLocaleString()} playable track${data.total === 1 ? '' : 's'}${st.q ? ` for “${st.q}”` : ''}${st.decade ? ` · ${st.decade}s` : ''}${st.format ? ` · ${st.format.toUpperCase()}` : ''}`
                : '';
            holder.innerHTML = '';
            const ul = document.createElement('ul');
            ul.className = 'library-list library-scene-list';
            if (!data.results.length) {
                const li = document.createElement('li'); li.className = 'library-empty'; li.textContent = st.q ? 'No playable tracks match.' : 'Nothing here.'; ul.appendChild(li);
            }
            for (const m of data.results) ul.appendChild(trackRow(m, api, refine));
            holder.appendChild(ul);
            pager.hidden = pages <= 1 && st.page === 1;
            pager.querySelector('.library-pager-label').textContent = `Page ${st.page} of ${pages}`;
            pager.querySelector('[data-dir="-1"]').disabled = st.page <= 1;
            pager.querySelector('[data-dir="1"]').disabled = st.page >= pages;
        };

        bar.addEventListener('submit', e => { e.preventDefault(); st.q = bar.elements.q.value.trim(); st.releaser = null; st.party = null; st.page = 1; if (st.q && st.sort === 'placing') st.sort = 'relevance'; bar.elements.sort.value = st.sort; load(); });
        bar.elements.q.addEventListener('search', () => { if (!bar.elements.q.value) { st.q = ''; st.page = 1; if (st.sort === 'relevance') { st.sort = 'placing'; bar.elements.sort.value = st.sort; } load(); } });
        for (const k of ['decade', 'format', 'sort']) bar.elements[k].addEventListener('change', () => { st[k] = bar.elements[k].value; st.page = 1; load(); });
        pager.addEventListener('click', e => {
            const dir = Number(e.target.closest('[data-dir]')?.dataset.dir);
            if (!dir) return;
            st.page = Math.min(pages, Math.max(1, st.page + dir));
            load();
        });
        bar.querySelector('.scene-random').addEventListener('click', async () => {
            status.textContent = 'Picking a random track…';
            try {
                const m = await sceneFetch('random', { playable: 1, decade: st.decade, format: st.format, releaser: st.releaser?.id, party: st.party?.id });
                status.textContent = `Random pick: ${m.title} — ${byLine(m)}`;
                api.load(m.play_url, { name: fileNameOf(m.play_url) });
            } catch (err) {
                status.textContent = `Random pick failed: ${errorText(err)}`;
            }
        });

        await load();
    },
};

export function installSceneTab() {
    if (!document.querySelector('link[data-library-scene]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/library-scene.css', import.meta.url).href;
        link.dataset.libraryScene = '1';
        document.head.appendChild(link);
    }
    registerLibraryTab(sceneTab, { before: 'modarchive' });
}
