#!/usr/bin/env node
/* eslint-disable no-console */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '..', 'package.json');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/check-version.mjs <version>');
  process.exit(2);
}

const normalized = input.replace(/^v/, '').trim();
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));

if (pkg.version !== normalized) {
  console.error(
    `Version mismatch: input "${normalized}" does not match package.json version "${pkg.version}".`,
  );
  process.exit(1);
}

console.log(`Version OK: ${pkg.version}`);

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  await fs.appendFile(githubOutput, `version=${pkg.version}\n`);
}
