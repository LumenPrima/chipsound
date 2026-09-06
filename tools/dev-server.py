"""Chipsound dev server: static src/ (with the directory listings the
theme / visualization / Library discovery need) plus the /api/modarchive proxy
for the Library's Mod Archive tab.

    MODARCHIVE_API_KEY=… python3 tools/dev-server.py [port] [--bind 127.0.0.1]

The tab uses The Mod Archive's XML API (https://modarchive.org/index.php?xml-api),
which needs a per-application key. The key stays here: the page calls
./api/modarchive?request=… and this proxy adds key=… and forwards an allowlist
of read-only requests to api.modarchive.org/xml-tools.php. Without the key the
proxy answers 503 and the tab explains what's missing. Listings are cached for
10 minutes (the key has a monthly request budget); random picks are not.
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
UPSTREAM = 'https://api.modarchive.org/xml-tools.php'
API_KEY = os.environ.get('MODARCHIVE_API_KEY', '').strip()
ALLOWED_REQUEST = {
    'search', 'chart', 'random', 'view_by_moduleid',
    'view_by_list', 'view_by_rating_reviews', 'view_by_rating_comments',
}
ALLOWED_TYPE = {'filename', 'songtitle', 'filename_or_songtitle'}
ALLOWED_KEYS = {'request', 'type', 'query', 'page', 'format'}
CACHE_TTL = 600
_cache = {}


def sanitize(query):
    """Return an allowlisted query string or None. The key is added later."""
    params = urllib.parse.parse_qs(query, keep_blank_values=False)
    out = []
    for key, values in params.items():
        if key not in ALLOWED_KEYS:
            return None
        value = values[0]
        if key == 'request' and value not in ALLOWED_REQUEST:
            return None
        if key == 'type' and value not in ALLOWED_TYPE:
            return None
        if key == 'page' and not value.isdigit():
            return None
        if key == 'format' and not re.fullmatch(r'[a-z0-9]{1,8}', value):
            return None
        if key == 'query' and not re.fullmatch(r"[\w .\-'!\[\]()&+,/:*]{1,80}", value):
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
        if not API_KEY:
            self.send_error(503, 'No MODARCHIVE_API_KEY configured on this server')
            return
        cacheable = 'request=random' not in q      # random must be fresh every time
        now = time.time()
        hit = _cache.get(q) if cacheable else None
        if hit and hit[0] > now:
            body, ctype = hit[1], hit[2]
        else:
            url = f'{UPSTREAM}?key={urllib.parse.quote(API_KEY)}&{q}'
            req = urllib.request.Request(url, headers={'User-Agent': 'Chipsound dev proxy (+https://github.com/LumenPrima/chipsound)'})
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    body = r.read()
                    ctype = r.headers.get('Content-Type', 'text/xml; charset=UTF-8')
            except urllib.error.URLError as e:
                # Never echo the URL: it carries the key.
                self.send_error(502, f'Mod Archive API unreachable: {getattr(e, "reason", e)}')
                return
            if cacheable:
                _cache[q] = (now + CACHE_TTL, body, ctype)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', f'public, max-age={CACHE_TTL}' if cacheable else 'no-store')
        self.send_header('X-Proxied-From', 'api.modarchive.org')
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
    print(f'Chipsound dev server on http://{args.bind}:{args.port}/ (root {os.path.abspath(ROOT)}; /api/modarchive proxy {"on" if API_KEY else "needs MODARCHIVE_API_KEY"})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
