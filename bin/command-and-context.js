#!/usr/bin/env node
// `npx command-and-context`: starts the dashboard and opens it, as a chromeless app window on Windows and in the
// default browser elsewhere. Any of --open, --app, --no-open, --dump or --help turns the automatic opening off,
// and every flag is passed through to the server (see --help). `node server/index.js` never opens anything
// unless asked, so scripts and test servers stay headless.
const args = process.argv.slice(2);
const decided = args.some((a) => /^(--open|--app|--no-open|--dump|--help|-h)$/.test(a.split('=')[0]));
if (!decided) process.argv.push(process.platform === 'win32' ? '--app' : '--open');
await import('../server/index.js');
