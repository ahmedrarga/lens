import { describe, expect, it } from 'vitest';
import type { ChangeGraph } from '@lens/core';
import { summarize } from './run.js';

describe('summarize', () => {
  it('counts nodes by kind', () => {
    const g = {
      nodes: [{ kind: 'file' }, { kind: 'file' }, { kind: 'symbol' }], edges: [], hunks: [{}], limits: ['x'],
      stats: { durationMs: 12 },
    } as unknown as ChangeGraph;
    expect(summarize(g)).toBe('nodes: 2 file, 1 symbol; edges: 0; hunks: 1; limits: 1; 12ms');
  });

  it('adds risk, collapsed and policy sections', () => {
    const risk = (level: string, mustReview: boolean) => ({ level, mustReview, reasons: [] });
    const g = {
      nodes: [
        { kind: 'file', risk: risk('high', true) }, { kind: 'symbol', risk: risk('med', false) },
        { kind: 'group', risk: risk('low', false) }, { kind: 'cluster', risk: risk('high', true) },
      ],
      edges: [], hunks: [], limits: [], stats: { durationMs: 1 },
      collapsed: [{ kind: 'lockfile', hunkIds: ['a'] }, { kind: 'formatting', hunkIds: ['b', 'c'] }],
      policy: { source: 'repo', changedInPr: true, errors: [] },
    } as unknown as ChangeGraph;
    expect(summarize(g)).toBe(
      'nodes: 1 file, 1 symbol, 1 group, 1 cluster; edges: 0; hunks: 0; risk: 1 must-review (1 high, 1 med); ' +
      'collapsed: 2 groups (lockfile, formatting; 3 hunks); policy: repo (changed in PR); limits: 0; 1ms',
    );
  });
});
