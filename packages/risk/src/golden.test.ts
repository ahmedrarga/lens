// Precision regression: the (node, rule) pairs the default policy produces on recorded real PRs.
// If this fails after a rule change, inspect the diff; update the snapshot only if the change is deliberate
// (vitest -u).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeGraph } from '@lens/core';
import { DEFAULT_POLICY, applyRisk } from './index.js';

const dir = join(__dirname, '../../../fixtures/golden');
const names = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'sample.json').sort();

describe('golden risk precision', () => {
  for (const f of names) {
    it(f, () => {
      const g = ChangeGraph.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      const out = applyRisk(g, DEFAULT_POLICY, {
        files: [], policySource: { source: 'default', errors: [] },
      });
      const pairs = out.nodes
        .filter((n) => n.risk && n.risk.reasons.length)
        .flatMap((n) => n.risk!.reasons.map((r) => `${n.id} :: ${r.ruleId} (${r.level})`))
        .sort();
      expect(pairs.join('\n')).toMatchSnapshot();
    });
  }
});
