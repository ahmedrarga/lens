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
});
