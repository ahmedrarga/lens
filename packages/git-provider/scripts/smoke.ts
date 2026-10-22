// Live smoke test: npx tsx packages/git-provider/scripts/smoke.ts [owner/repo#n]
import { createGitHubProvider } from '../src/index.js';

const ref = process.argv[2] ?? 'vitejs/vite#23871';
const gh = createGitHubProvider();
const pr = await gh.getPr(ref);
console.log(`PR: ${pr.owner}/${pr.repo}#${pr.number} "${pr.title}" by ${pr.author}`);
const files = await gh.listFiles(pr);
console.log(`files: ${files.length} (${files.filter((f) => f.patch).length} with patch)`);
const t0 = Date.now();
const src = await gh.getSourceFiles(pr, pr.headSha, (p) => p.endsWith('.ts'));
console.log(`.ts files at head: ${src.size} in ${Date.now() - t0}ms`);
const first = files.find((f) => f.status !== 'removed' && f.path.endsWith('.ts'));
if (first) console.log(`getFile(${first.path}):`, (await gh.getFile(pr, first.path, pr.headSha))?.length, 'chars');
