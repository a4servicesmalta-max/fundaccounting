// Dependency-free test runner: discovers every *.test.ts under src/ and runs
// them with the Node test runner via tsx, serially, against an isolated DB
// (.env.test points the store at a throwaway file so tests never touch real data).
// Node 20's --test does not expand globs, hence this small discovery step.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(p));
    else if (entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = findTests('src').sort();
if (files.length === 0) {
  console.log('No test files found under src/.');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ['--env-file=.env.test', '--import', 'tsx', '--test', '--test-concurrency=1', ...files],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
