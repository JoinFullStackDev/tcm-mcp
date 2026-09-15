#!/usr/bin/env node
/**
 * Runs every compiled self-check in dist/tools.
 *
 * Each check file exports `run()`, and this AWAITS it. An earlier version imported the
 * files and relied on a floating top-level IIFE, which meant import() resolved the moment
 * evaluation kicked the promise off — so a failure in the first file aborted the process
 * and every later file silently never ran. (create_suite sorts before list_test_cases, so
 * one create_suite regression hid every list_test_cases check.)
 *
 * Not a shell loop either: npm runs scripts through cmd.exe on Windows, where
 * `for f in ...; do` is a syntax error, and sh passes an unmatched glob through literally,
 * so a renamed test would fail as MODULE_NOT_FOUND and read as a failing test.
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

let failed = 0;
for (const file of files) {
  const mod = await import(pathToFileURL(join(dir, file)).href);
  // TS compiles to CJS here, so the export can surface as `run` or under `default`.
  const run = mod.run ?? mod.default?.run ?? mod.default;
  if (typeof run !== 'function') {
    console.error(`${file}: no exported run() — check files must \`export async function run()\``);
    failed++;
    continue;
  }
  try {
    await run();
  } catch (err) {
    // Keep going: one failing suite must not hide the results of the others.
    console.error(`\n${file} FAILED:`);
    console.error(err);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} check file(s) failed.`);
  process.exit(1);
}
