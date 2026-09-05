#!/usr/bin/env python3
"""Chipsound dev server: static files from src/ (with directory listings, which
theme / visualization / Library discovery need) plus the /api/modarchive proxy
the Library's "Mod Archive" tab uses. Production deployments get the same proxy
from the Caddyfile; this is only so `python3 tools/dev-server.py` matches.

    python3 tools/dev-server.py [port] [--bind 127.0.0.1]

modarchive.org sends no CORS headers, so the browser cannot read its chart or
search pages directly. This forwards a strict allowlist of read-only requests
and caches them for ten minutes. Nothing else is proxied.
"""
import argparse
import http.server
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
UPSTREAM = 'https://modarchive.org/index.php'
ALLOWED_REQUEST = {'view_chart', 'search', 'view_random', 'view_top_favourites'}
ALLOWED_KEYS = {'request', 'query', 'page', 'submit', 'search_type'}
CACHE_TTL = 600
_cache = {}


def sanitize(query):
    """Return an allowlisted query string or None."""
    params = urllib.parse.parse_qs(query, keep_blank_values=False)
    out = []
    for key, values in params.items():
        if key not in ALLOWED_KEYS:
            return None
        value = values[0]
        if key == 'request' and value not in ALLOWED_REQUEST:
            return None
        if key == 'page' and not value.isdigit():
            return None
        if key == 'query' and not re.fullmatch(r'[\w .\-\'!\[\]()&+,/:]{1,80}', value):
            return None
        if key == 'search_type' and value != 'filename_or_songtitle':
            return None
        if key == 'submit' and value != 'Find':
            return None
        out.append((key, value))
    if not any(k == 'request' for k, _ in out):
        return None
    return urllib.parse.urlencode(out)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/modarchive':
            return self.proxy(parsed.query)
        return super().do_GET()

    def proxy(self, query):
        q = sanitize(query)
        if q is None:
            self.send_error(400, 'Query not allowed by the Mod Archive proxy allowlist')
            return
        url = f'{UPSTREAM}?{q}'
        cacheable = 'request=view_random' not in q      # random must be fresh every time
        now = time.time()
        hit = _cache.get(url) if cacheable else None
        if hit and hit[0] > now:
            body, ctype = hit[1], hit[2]
        else:
            req = urllib.request.Request(url, headers={'User-Agent': 'Chipsound dev proxy (+https://github.com/gamosoft/chipsound)'})
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    body = r.read()
                    ctype = r.headers.get('Content-Type', 'text/html; charset=UTF-8')
            except urllib.error.URLError as e:
                self.send_error(502, f'Mod Archive unreachable: {e.reason}')
                return
            if cacheable:
                _cache[url] = (now + CACHE_TTL, body, ctype)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', f'public, max-age={CACHE_TTL}' if cacheable else 'no-store')
        self.send_header('X-Proxied-From', 'modarchive.org')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('port', nargs='?', type=int, default=8765)
    ap.add_argument('--bind', default='127.0.0.1')
    args = ap.parse_args()
    server = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f'Chipsound dev server on http://{args.bind}:{args.port}/ (root {os.path.abspath(ROOT)}; /api/modarchive proxy on)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
