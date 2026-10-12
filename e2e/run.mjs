#!/usr/bin/env node
// Runs the end-to-end suites: builds main + preload, starts the Vite dev server on
// :5173 (or reuses an `npm run dev` one), runs e2e/suites/*.test.mjs with node:test,
// then shuts Vite down.
//
//   npm run test:e2e                       # every suite
//   npm run test:e2e -- files export       # suites whose file name contains "files" or "export"
//   npm run test:e2e -- --test-name-pattern="auto-save"
//
// Env: E2E_SKIP_BUILD=1 skips the main/preload build, E2E_CONCURRENCY=n sets how many
// suites run at once, E2E_KEEP=1 keeps the temp profiles/fixtures.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(E2E);
const SUITES = path.join(E2E, 'suites');
const DEV_URL = 'http://localhost:5173/';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
const filters = args.filter((a) => !a.startsWith('-'));
const suites = fs
  .readdirSync(SUITES)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()
  .map((f) => path.join(SUITES, f));
if (suites.length === 0) {
  console.error(`No suites match ${filters.join(', ')}`);
  process.exit(2);
}

const log = (msg) => console.log(`\x1b[36m[e2e]\x1b[0m ${msg}`);

if (!process.env.E2E_SKIP_BUILD) {
  log('building main + preload');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', '--silent', 'build:main'], { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** An MDitor renderer already served on :5173 (e.g. `npm run dev`)? */
async function devServerUp() {
  try {
    const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(2_000) });
    return (await res.text()).includes('<title>MDitor</title>');
  } catch {
    return false;
  }
}

let server = null;
if (await devServerUp()) {
  log(`reusing the renderer already served at ${DEV_URL}`);
} else {
  const { createServer, createLogger } = await import('vite');
  const logger = createLogger('warn');
  // Vite logs a dependency re-optimization (which reloads open pages) only at info level.
  logger.info = (msg, opts) => {
    if (/reload/i.test(msg)) logger.warn(msg, opts);
  };
  server = await createServer({
    configFile: path.join(REPO, 'vite.config.ts'),
    customLogger: logger,
    server: { port: 5173, strictPort: true, hmr: false },
  });
  await server.listen();
  log(`vite listening on ${DEV_URL}`);
}

let exitCode = 1;
let child = null;
const stopServer = async () => {
  if (server) await server.close().catch(() => {});
  server = null;
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    child?.kill(sig);
    await stopServer();
    process.exit(130);
  });
}

try {
  // Warm-up: the first page load makes Vite transform (and maybe pre-bundle) the whole
  // renderer; do it once here so the suites don't race it in parallel.
  log('warming up');
  const { withApp } = await import('./harness.mjs');
  await withApp({}, async () => {});

  const concurrency = Number(process.env.E2E_CONCURRENCY) || Math.max(1, Math.min(suites.length, Math.floor(os.availableParallelism() / 2)));
  log(`running ${suites.length} suite(s), ${concurrency} at a time`);
  exitCode = await new Promise((resolve) => {
    child = spawn(
      process.execPath,
      ['--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', ...flags, ...suites],
      { cwd: REPO, stdio: 'inherit', env: { ...process.env, E2E_RUNNER: '1' } },
    );
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await stopServer();
}
process.exit(exitCode);
