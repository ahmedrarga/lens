// Usage: tsx apps/cli/src/validate-golden.ts [name...]  -> parses fixtures/golden/*.json and checks coverage.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangeGraph } from '@lens/core';
import { assertCoverage } from '@lens/graph';

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'fixtures/golden');
const names = process.argv.slice(2);
let bad = 0;
for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) {
  if (names.length && !names.some((n) => f.startsWith(n))) continue;
  const g = ChangeGraph.parse(JSON.parse(await readFile(join(dir, f), 'utf8')));
  const v = assertCoverage(g);
  if (v.length) bad++;
  console.log(`${f}: ${v.length ? 'COVERAGE FAIL ' + v.join('; ') : 'ok'}`);
  for (const n of g.nodes) {
    if (n.risk && (n.risk.mustReview || n.risk.level !== 'low') && n.kind !== 'module' && n.kind !== 'cluster') {
      console.log(`   ${n.risk.level}${n.risk.mustReview ? '+must' : ''} ${n.id}: ${n.risk.reasons.map((r) => r.message).join(' | ')}`);
    }
  }
}
process.exit(bad ? 1 : 0);
