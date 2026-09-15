#!/usr/bin/env node
/**
 * Runs every compiled self-check in dist/tools.
 *
 * Not a shell loop: npm runs scripts through cmd.exe on Windows, where `for f in ...; do`
 * is a syntax error, and sh passes an unmatched glob through literally — so a missing or
 * renamed test file would fail with MODULE_NOT_FOUND and read as a failing test rather
 * than as "there are no tests". Both cases are explicit here.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve('dist/tools');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.js in ${dir} — did the build run?`);
  process.exit(1);
}

for (const file of files) {
  await import(pathToFileURL(join(dir, file)).href);
}
