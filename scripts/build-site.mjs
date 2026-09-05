/**
 * Assembles what gets published: the landing page at the root, the app under
 * /app.
 *
 * Two separate things are being served from one origin. The landing page is
 * hand-written and lives in site/; the app is a Vite build and lives in dist/.
 * Mounting the app on a subpath works without any base-path juggling because
 * the Vite config is already `base: './'`, so every asset it asks for is
 * relative to wherever the page ended up.
 *
 * Usage: node scripts/build-site.mjs   (expects `npm run build` to have run)
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, '_site');

if (!fs.existsSync(DIST)) {
  console.error('dist/ is missing — run `npm run build` first');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.cpSync(SITE, OUT, { recursive: true });
fs.cpSync(DIST, path.join(OUT, 'app'), { recursive: true });

// Pages runs the output through Jekyll unless told not to, and Jekyll drops
// files and directories whose names begin with an underscore — which the Vite
// asset directory does not, but future ones might. Cheap insurance.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

/** Total bytes and file count under a directory, for a sanity line at the end. */
function measure(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = measure(full);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      bytes += fs.statSync(full).size;
      files += 1;
    }
  }
  return { bytes, files };
}

const { bytes, files } = measure(OUT);
console.log(`_site: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  landing page at /`);
console.log(`  app at /app/`);
