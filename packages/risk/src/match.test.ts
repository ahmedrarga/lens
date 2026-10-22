import { describe, expect, it } from 'vitest';
import type { Hunk } from '@lens/core';
import { hunkText } from './match.js';

const hunk = (patch: string): Hunk => ({
  id: 'h', path: 'db/migration/V1__x.sql', oldStart: 0, oldLines: 0, newStart: 1, newLines: 3,
  patch, added: 3, removed: 0, owner: 'file:db/migration/V1__x.sql',
});

describe('hunkText', () => {
  it('ignores SQL comment lines so rollback notes cannot trigger content rules', () => {
    const t = hunkText(hunk('@@ -0,0 +1,4 @@\n+CREATE TABLE t (id INT);\n+-- rollback: DROP TABLE t;\n+/* DROP TABLE t */'));
    expect(t.added).toBe('CREATE TABLE t (id INT);');
  });

  it('keeps code lines that merely contain comment markers later on', () => {
    const t = hunkText(hunk('@@ -0,0 +1,1 @@\n+DROP TABLE t; -- cleanup'));
    expect(t.added).toContain('DROP TABLE t');
  });
});
