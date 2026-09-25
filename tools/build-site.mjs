// Builds the hosted web demo (GitHub Pages): public/ minus the dev harness pages, plus the two three.js build files
// the page imports, with the page marked <html data-site="static"> so it always runs the simulated world (there is no
// server behind it) and link-preview tags for sharing. Used by .github/workflows/pages.yml.
//
//   node tools/build-site.mjs [outDir]        (default: _site)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://geekgreg.github.io/command-and-context/';
const out = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const pub = path.join(ROOT, 'public');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(pub, out, { recursive: true, filter: (src) => path.relative(pub, src).split(path.sep)[0] !== 'dev' });

// three.js: the page's import map points at ./vendor/three/build/three.module.js, which imports ./three.core.js.
const isThree = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'three'; } catch { return false; } };
let three = path.dirname(createRequire(import.meta.url).resolve('three'));
for (let i = 0; i < 4 && !isThree(three); i++) three = path.dirname(three);
if (!isThree(three)) throw new Error('build-site: three is not installed (run npm ci)');
const vendor = path.join(out, 'vendor', 'three');
fs.mkdirSync(path.join(vendor, 'build'), { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) fs.copyFileSync(path.join(three, 'build', f), path.join(vendor, 'build', f));
fs.copyFileSync(path.join(three, 'LICENSE'), path.join(vendor, 'LICENSE'));

// Preview image for link unfurls (Slack, Discord, social posts).
fs.copyFileSync(path.join(ROOT, 'docs', 'screenshots', 'hero.png'), path.join(out, 'preview.png'));

const indexFile = path.join(out, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
const mark = (from, to) => {
  if (!html.includes(from)) throw new Error(`build-site: index.html no longer contains ${from}`);
  html = html.replace(from, to);
};
const desc = 'A low-poly isometric RTS diorama of every Claude Code session, sub-agent and dev server on your machine. '
  + 'This is the web demo: a simulated world. Run it on your own machine with npx command-and-context.';
mark('<html lang="en">', '<html lang="en" data-site="static">');
mark('<title>Command &amp; Context</title>', [
  '<title>Command &amp; Context: web demo</title>',
  `  <meta name="description" content="${desc}">`,
  '  <meta property="og:type" content="website">',
  '  <meta property="og:title" content="Command &amp; Context">',
  `  <meta property="og:description" content="${desc}">`,
  `  <meta property="og:url" content="${SITE_URL}">`,
  `  <meta property="og:image" content="${SITE_URL}preview.png">`,
  '  <meta name="twitter:card" content="summary_large_image">',
].join('\n'));
fs.writeFileSync(indexFile, html);

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (x) => files.push(x))(path.join(d, e.name)); };
walk(out);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`web demo built in ${out}: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB`);
