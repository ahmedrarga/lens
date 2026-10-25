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

// ---------- JVM: pom.xml and build.gradle(.kts) ----------

const GRADLE_CONFIGS = '(?:implementation|api|runtimeOnly|compileOnly|compile|runtime|annotationProcessor|developmentOnly|kapt|ksp|testImplementation|testRuntimeOnly|testCompileOnly|testAnnotationProcessor|testFixturesApi|testFixturesImplementation|integrationTestImplementation)';
const GRADLE_DEP = new RegExp(`^\\s*(${GRADLE_CONFIGS})\\b\\s*\\(?\\s*(?:platform\\(\\s*|enforcedPlatform\\(\\s*)?["']([^"']+)["']`);
const GRADLE_DEP_MAP = new RegExp(`^\\s*(${GRADLE_CONFIGS})\\b\\s*\\(?\\s*group\\s*[:=]\\s*["']([^"']+)["']\\s*,\\s*name\\s*[:=]\\s*["']([^"']+)["'](?:\\s*,\\s*version\\s*[:=]\\s*["']([^"']+)["'])?`);
const GRADLE_DEP_CATALOG = new RegExp(`^\\s*(${GRADLE_CONFIGS})\\b\\s*\\(?\\s*(libs\\.[\\w.]+)`);
const GRADLE_BOOT_PLUGIN = /\bid\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*\(?\s*["']([^"']+)["']/;
const MVN_TAG = /^\s*<([\w.-]+)>\s*([^<]*?)\s*<\/\1>\s*$/;

interface JvmEnt { removed?: string; added?: string; dev: boolean; boot: boolean }

/** Analyse pom.xml / build.gradle(.kts) hunks for dependency changes. Null when none changed. */
export function analyzeJvmDeps(hunks: Hunk[]): DepsChange | null {
  const ents = new Map<string, JvmEnt>();
  const hunkIds: string[] = [];
  let bootFrom: string | undefined;
  let bootTo: string | undefined;
  let boot = false;
  const note = (key: string, kind: '+' | '-', version: string | undefined, dev: boolean, isBoot: boolean) => {
    const e = ents.get(key) ?? { dev, boot: isBoot };
    if (kind === '+') e.added = version ?? ''; else e.removed = version ?? '';
    e.dev &&= dev;
    e.boot ||= isBoot;
    ents.set(key, e);
  };

  for (const h of hunks) {
    const lines = h.patch.split('\n').slice(1).filter((l) => !l.startsWith('\\'));
    let hit = false;
    if (/\.gradle(\.kts)?$/.test(h.path)) {
      for (const line of lines) {
        const kind = line[0];
        if (kind !== '+' && kind !== '-') continue;
        const text = line.slice(1);
        const plug = GRADLE_BOOT_PLUGIN.exec(text);
        if (plug) {
          boot = true; hit = true;
          if (kind === '+') bootTo = plug[1]; else bootFrom = plug[1];
          continue;
        }
        let m = GRADLE_DEP.exec(text);
        let cfg: string, key: string, version: string | undefined;
        if (m) {
          const parts = m[2]!.split(':');
          if (parts.length < 2) continue;
          cfg = m[1]!; key = `${parts[0]}:${parts[1]}`; version = parts[2];
        } else if ((m = GRADLE_DEP_MAP.exec(text))) {
          cfg = m[1]!; key = `${m[2]}:${m[3]}`; version = m[4];
        } else if ((m = GRADLE_DEP_CATALOG.exec(text))) {
          cfg = m[1]!; key = m[2]!; version = undefined;
        } else continue;
        const isBoot = key.startsWith('org.springframework.boot:');
        note(key, kind, version, cfg.startsWith('test') || cfg === 'compileOnly' || cfg === 'annotationProcessor', isBoot);
        hit = true;
      }
    } else {
      // Maven: group the hunk's lines (context included) into <dependency>/<parent>/<plugin> blocks.
      type Blk = { type: 'dependency' | 'parent' | 'plugin' | 'unknown'; fields: Map<string, { '+'?: string; '-'?: string; ' '?: string }> };
      const blocks: Blk[] = [];
      let cur: Blk = { type: 'unknown', fields: new Map() };
      blocks.push(cur);
      let inProps = false;
      for (const line of lines) {
        const kind = (line[0] === '+' || line[0] === '-' ? line[0] : ' ') as '+' | '-' | ' ';
        const text = line.slice(1);
        const open = /^\s*<(dependency|parent|plugin)>\s*$/.exec(text) ?? /^\s*<(dependency|parent|plugin)>/.exec(text);
        if (open) {
          cur = { type: open[1] as Blk['type'], fields: new Map() };
          blocks.push(cur);
          continue;
        }
        if (/^\s*<\/(dependency|parent|plugin)>/.test(text)) { cur = { type: 'unknown', fields: new Map() }; blocks.push(cur); continue; }
        if (/^\s*<properties>/.test(text)) inProps = true;
        if (/^\s*<\/properties>/.test(text)) inProps = false;
        const t = MVN_TAG.exec(text);
        if (!t) continue;
        const [, name, value] = t as unknown as [string, string, string];
        if (inProps || (cur.type === 'unknown' && /(\.version|-version|Version)$/.test(name) && kind !== ' ')) {
          if (kind !== ' ' && /(\.version|-version|Version)$/.test(name)) {
            note(`property:${name}`, kind, value, false, /^spring[-.]?boot[-.]?version$/i.test(name));
            hit = true;
          }
          continue;
        }
        const f = cur.fields.get(name) ?? {};
        f[kind] = value;
        cur.fields.set(name, f);
      }
      for (const b of blocks) {
        const art = b.fields.get('artifactId');
        const artifact = art?.['+'] ?? art?.['-'] ?? art?.[' '];
        if (!artifact) continue;
        const group = b.fields.get('groupId');
        const groupId = group?.['+'] ?? group?.['-'] ?? group?.[' '] ?? '';
        const changed = [...b.fields.values()].some((f) => f['+'] !== undefined || f['-'] !== undefined);
        if (!changed) continue;
        let type = b.type;
        if (type === 'unknown') type = /(^|-)maven-.*-plugin$|-maven-plugin$|^maven-.*plugin$/.test(artifact) ? 'plugin' : 'dependency';
        const isBoot = groupId === 'org.springframework.boot' || artifact.startsWith('spring-boot');
        const ver = b.fields.get('version');
        if (type === 'parent' || (type === 'plugin' && artifact === 'spring-boot-maven-plugin')) {
          if (ver && ver['+'] !== ver['-'] && (ver['+'] !== undefined || ver['-'] !== undefined)) {
            boot ||= isBoot; bootTo ??= ver['+']; bootFrom ??= ver['-'];
            hit = true;
          }
          continue;
        }
        if (type !== 'dependency') continue;
        const key = `${groupId}:${artifact}`;
        const dev = (b.fields.get('scope')?.['+'] ?? b.fields.get('scope')?.['-'] ?? b.fields.get('scope')?.[' ']) === 'test';
        const a = art!;
        if (a['+'] !== undefined && a['-'] === undefined && a[' '] === undefined) note(key, '+', ver?.['+'], dev, isBoot);
        else if (a['-'] !== undefined && a['+'] === undefined && a[' '] === undefined) note(key, '-', ver?.['-'], dev, isBoot);
        else {
          // artifact unchanged: version/scope edited in place
          if (ver && ver['+'] !== ver['-']) { note(key, '-', ver['-'] ?? '', dev, isBoot); note(key, '+', ver['+'] ?? '', dev, isBoot); }
          else continue;
        }
        hit = true;
      }
    }
    if (hit) hunkIds.push(h.id);
  }

  for (const [k, e] of [...ents]) {
    if (e.added !== undefined && e.removed !== undefined && e.added === e.removed) { ents.delete(k); continue; }
    const isBootProp = k.startsWith('property:') && e.boot;
    if ((isBootProp || k === 'org.springframework.boot:spring-boot-gradle-plugin') && e.added !== undefined && e.removed !== undefined) {
      boot = true; bootFrom ??= e.removed; bootTo ??= e.added;
      ents.delete(k);
    }
  }
  const bootBump = boot && bootFrom !== bootTo;
  if (ents.size === 0 && !bootBump) return null;

  const counts = { added: 0, removed: 0, bumped: 0 };
  let level: RiskLevel = 'low';
  const names = new Set<string>();
  for (const [key, e] of ents) {
    const pretty = key.startsWith('property:') ? key.slice(9) : key.includes(':') ? key.split(':')[1]! : key;
    names.add(pretty);
    if (e.added !== undefined && e.removed !== undefined) counts.bumped++;
    else if (e.added !== undefined) { counts.added++; if (!e.dev) level = 'med'; }
    else { counts.removed++; if (!e.dev) level = 'med'; }
  }
  if (bootBump) level = 'med';
  const verbs = [
    counts.added ? `adds ${counts.added}` : '', counts.removed ? `removes ${counts.removed}` : '',
    counts.bumped ? `changes ${counts.bumped}` : '',
  ].filter(Boolean);
  const list = [...names].sort();
  const shown = list.slice(0, 6).join(', ') + (list.length > 6 ? ', …' : '');
  const parts: string[] = [];
  if (verbs.length) {
    const sentence = verbs.join(', ').replace(/^./, (c) => c.toUpperCase());
    parts.push(`${sentence} ${list.length === 1 ? 'dependency' : 'dependencies'}: ${shown}`);
  }
  if (bootBump) {
    parts.push(`Spring Boot version ${bootFrom ?? '?'} -> ${bootTo ?? '?'} (framework upgrade changes defaults for the whole app)`);
  }
  let message = parts.join('; ');
  if (level === 'low') message += ' (version bumps or test/compile-only)';
  return { level, message, hunkIds: [...new Set(hunkIds)].sort() };
}
