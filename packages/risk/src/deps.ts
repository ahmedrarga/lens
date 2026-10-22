import type { Hunk, RiskLevel } from '@lens/core';

const DEP_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
const SECTION_OPEN = /^(\s*)"([^"]+)"\s*:\s*[{[]\s*$/;
const ENTRY = /^\s*"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;
const RANGE = /^(?:[~^]|[<>]=?|=)?\s*\d[\w.*+-]*(?:\s.*)?$|^(?:workspace|npm|catalog|github|git\+?\w*|file|link|portal):|^\*$|^latest$|^[\w.-]+\/[\w.-]+(#.*)?$/;
const NOT_DEPS = new Set(['version', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'packageManager', 'name', 'license', 'main', 'module', 'types', 'type', 'description']);

export interface DepsChange { level: RiskLevel; message: string; hunkIds: string[] }

interface Ent { removed?: string; added?: string; section: string }

/** Analyse package.json hunks for dependency entry changes. Null when none changed. */
export function analyzeDeps(hunks: Hunk[]): DepsChange | null {
  const ents = new Map<string, Ent>();
  const hunkIds: string[] = [];
  for (const h of hunks) {
    const lines = h.patch.split('\n');
    // Section hint from the hunk header's function-context text, e.g. `@@ -1,3 +1,3 @@ "devDependencies": {`
    const ctx = /^@@[^@]*@@\s*(.*)$/.exec(lines[0] ?? '')?.[1] ?? '';
    let section = 'unknown';
    let openIndent = -1;
    const hm = SECTION_OPEN.exec(ctx);
    if (hm) { section = hm[2]!; openIndent = hm[1]!.length; }
    let hit = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith('\\')) continue;
      const kind = line[0];
      const text = line.slice(1);
      const open = SECTION_OPEN.exec(text);
      if (open) { section = open[2]!; openIndent = open[1]!.length; continue; }
      const close = /^(\s*)[}\]],?\s*$/.exec(text);
      if (close) {
        if (openIndent >= 0 && close[1]!.length <= openIndent) { section = 'top'; openIndent = -1; }
        else if (openIndent < 0) section = 'unknown';
        continue;
      }
      if (kind !== '+' && kind !== '-') continue;
      const m = ENTRY.exec(text);
      if (!m) continue;
      const [, name, value] = m as unknown as [string, string, string];
      const inDeps = DEP_SECTIONS.has(section);
      if (!inDeps && !(section === 'unknown' && !NOT_DEPS.has(name) && RANGE.test(value))) continue;
      const key = `${section}\u0000${name}`;
      const e = ents.get(key) ?? { section };
      if (kind === '+') e.added = value; else e.removed = value;
      ents.set(key, e);
      hit = true;
    }
    if (hit) hunkIds.push(h.id);
  }
  if (ents.size === 0) return null;

  const names = new Set<string>();
  const counts = { added: 0, removed: 0, bumped: 0 };
  let level: RiskLevel = 'low';
  let runtimeNames = 0;
  for (const [key, e] of ents) {
    const name = key.split('\u0000')[1]!;
    names.add(name);
    const dev = e.section === 'devDependencies';
    if (e.added !== undefined && e.removed !== undefined) { counts.bumped++; if (e.added === e.removed) counts.bumped--; }
    else if (e.added !== undefined) { counts.added++; if (!dev) { level = 'med'; runtimeNames++; } }
    else { counts.removed++; if (!dev) { level = 'med'; runtimeNames++; } }
  }
  const verbs = [
    counts.added ? `adds ${counts.added}` : '', counts.removed ? `removes ${counts.removed}` : '',
    counts.bumped ? `changes ${counts.bumped}` : '',
  ].filter(Boolean);
  const list = [...names].sort();
  const shown = list.slice(0, 6).join(', ') + (list.length > 6 ? ', …' : '');
  const sentence = verbs.join(', ').replace(/^./, (c) => c.toUpperCase());
  const message = `${sentence} ${list.length === 1 ? 'dependency' : 'dependencies'}: ${shown}` +
    (level === 'low' ? ' (version bumps or dev-only)' : '');
  void runtimeNames;
  return { level, message, hunkIds: [...new Set(hunkIds)].sort() };
}
