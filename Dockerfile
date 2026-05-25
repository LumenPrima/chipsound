# syntax=docker/dockerfile:1.7
# Multi-stage: minify (esbuild) -> precompress (brotli/zstd) -> caddy + content.
# Build:  docker build -t chipsound .
# Run:    docker run --rm -p 8765:80 chipsound


# --- 1. Minify .js / .css in place (per-file, not bundled). ---
# Skips libopenmpt.worklet.js (emscripten output, fragile to re-minification)
# and *.min.css (Font Awesome ships pre-minified — stripping the embedded
# attribution headers would breach the FA Free license).
FROM node:20-alpine AS minify
RUN npm install -g esbuild@0.20.2
WORKDIR /work
COPY src/ ./src/

RUN find ./src -type f -name "*.js" \
        ! -name "libopenmpt.worklet.js" \
        -exec sh -c 'esbuild --minify --target=es2020 --legal-comments=none "$1" --outfile="$1.tmp" && mv "$1.tmp" "$1"' _ {} \;

RUN find ./src -type f -name "*.css" \
        ! -name "*.min.css" \
        -exec sh -c 'esbuild --minify --loader=css --legal-comments=none "$1" --outfile="$1.tmp" && mv "$1.tmp" "$1"' _ {} \;


# --- 2. Precompress text assets so Caddy serves the .br / .zst sibling. ---
FROM alpine:3.20 AS compress
RUN apk add --no-cache brotli zstd findutils
COPY --from=minify /work/src /work/src

RUN find /work/src -type f \( \
            -name "*.js" -o -name "*.css" -o -name "*.html" \
            -o -name "*.svg" -o -name "*.json" -o -name "*.txt" \
        \) ! -name "*.br" ! -name "*.zst" \
        -exec brotli -q 11 -k {} \; \
        -exec zstd -q -19 -k {} \;


# --- 3. Runtime image. None of the build tooling ships. ---
FROM caddy:2.11.3-alpine
COPY --from=compress /work/src   /usr/share/caddy
COPY Caddyfile                   /etc/caddy/Caddyfile

# Third-party attribution shipped with the deployed artifact (required by
# SIL OFL 1.1 §2 for the bundled Font Awesome webfont).
COPY NOTICE                      /usr/share/caddy/NOTICE
COPY docs/third-party/           /usr/share/caddy/docs/third-party/

EXPOSE 80
EXPOSE 443
