import type { HunkNoise, NoiseInput, ParsedHunk } from '@lens/core';

export interface Verdict { noise: HunkNoise; verified: boolean }

export interface Ctx {
  input: NoiseInput;
  /** Head path -> file entry. */
  files: Map<string, NoiseInput['files'][number]>;
}

/** Path of the file on the base side. */
export const basePath = (h: Pick<ParsedHunk, 'path' | 'oldPath'>): string => h.oldPath ?? h.path;
