import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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

    const ext = path.extname(name).toLowerCase();
    const headers = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
    };

    if (HOTLINKABLE.has(name)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }

    return c.body(createReadStream(filePath), 200, headers);
  });
}
