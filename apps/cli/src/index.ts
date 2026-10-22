import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyzeWithProgress, summarize } from './run.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', short: 'o' } } });
  const prUrl = positionals[0];
  if (!prUrl) {
    console.error('Usage: tsx apps/cli/src/index.ts <prUrl> [--out graph.json]');
    process.exit(1);
  }
  const graph = await analyzeWithProgress(prUrl);
  const json = JSON.stringify(graph, null, 2);
  if (values.out) await writeFile(values.out, json + '\n');
  else process.stdout.write(json + '\n');
  console.error(summarize(graph));
  for (const l of graph.limits) console.error(`  limit: ${l}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
