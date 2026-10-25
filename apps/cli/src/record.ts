// Usage: tsx apps/cli/src/record.ts <prUrl> <name>   -> fixtures/golden/<name>.json
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeWithProgress, summarize } from './run.js';

async function main() {
  const [prUrl, name] = process.argv.slice(2);
  if (!prUrl || !name || !/^[\w.-]+$/.test(name)) {
    console.error('Usage: tsx apps/cli/src/record.ts <prUrl> <name>');
    process.exit(1);
  }
  const graph = await analyzeWithProgress(prUrl);
  const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'fixtures/golden');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  await writeFile(file, JSON.stringify(graph, null, 2) + '\n');
  console.error(`wrote ${file}\n${summarize(graph)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
