import type { Indexer } from '@lens/core';
import { createJavaIndexer } from './java/index.js';
import { createTsIndexer } from './ts-indexer.js';

export { createTsIndexer, moduleSymbolId } from './ts-indexer.js';
export { createJavaIndexer, type JavaIndexResult } from './java/index.js';

/** All built-in language indexers (TS/JS + Java). The pipeline dispatches files to them by extension. */
export function createDefaultIndexers(): Indexer[] {
  return [createTsIndexer(), createJavaIndexer()];
}
