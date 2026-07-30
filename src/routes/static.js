import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the handful of files in `public/`.
 *
 * Resolved from this module's own location rather than `process.cwd()`, so the
 * app does not care what directory it was started from.
 *
 * Only files sitting directly in `public/` are served — no subdirectories — and
 * the resolved path is checked to still be inside `public/`, so a traversal
 * attempt can never escape it.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const CONTENT_TYPES = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  // The registered type for a web app manifest. Serving it as octet-stream (the
  // fallback below) makes Chrome ignore the manifest entirely.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Plan §6/§6.1: the three brand files exist to be hotlinked from other people's
// sites, so they get permissive CORS and a cross-origin resource policy.
const HOTLINKABLE = new Set([
  'iheartrss.svg',
  'iheartrss-dark.svg',
  'iheartrss-icon.svg',
]);

export function registerStatic(app) {
  app.get('/:file{[^/]+\\.[a-z0-9]+}', async (c, next) => {
    const name = c.req.param('file');

    const filePath = path.resolve(PUBLIC_DIR, name);
    if (!filePath.startsWith(PUBLIC_DIR)) return next();

    let info;
    try {
      info = await stat(filePath);
    } catch {
      return next();
    }
    if (!info.isFile()) return next();

    // Read the bytes rather than handing `c.body()` a Node stream.
    //
    // `c.body(createReadStream(path))` put a Node `Readable` where a web
    // `ReadableStream` belongs. Node's bundled undici adapts it via its
    // async-iterator path and closes the stream controller twice when the file
    // ends, throwing `ERR_INVALID_STATE: ReadableStream is already closed` in a
    // microtask *after* the response has already been sent — so it could not be
    // caught per-request and it killed the whole process. One visit to any page
    // was enough, because `/style.css` comes through here.
    //
    // Everything in `public/` is small (largest ~34 KB), so buffering removes the
    // entire stream-lifecycle problem rather than trading it for a subtler one.
    // It also makes Content-Length exact: taken from `stat`, it could disagree
    // with the bytes actually sent if the file changed in between.
    let body;
    try {
      body = await readFile(filePath);
    } catch {
      return next();
    }

    const ext = path.extname(name).toLowerCase();
    const headers = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
    };

    if (HOTLINKABLE.has(name)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }

    return c.body(body, 200, headers);
  });
}
