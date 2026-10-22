// Snapshot selection for Java: cheap text scans (package line, import lines, simple-name mentions); no parsing.

export const MAX_JAVA_FILES = 1500;

const SOURCE_ROOT_RE = /(?:^|\/)src\/(?:main|test)\/java\//;

/** Package of a file derived from its path after a `**\/src/main/java/` or `**\/src/test/java/` root. */
export function javaPackageFromPath(path: string): string | null {
  const m = SOURCE_ROOT_RE.exec(path);
  if (!m) return null;
  const rest = path.slice(m.index + m[0].length);
  const dir = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '';
  return dir.replace(/\//g, '.');
}

const PKG_RE = /^\s*package\s+([\w.]+)\s*;/m;
const IMPORT_RE = /^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/gm;
const HEADER_RE = /\b(?:class|interface|enum|record)\s+\w+(?:\s*<[^{]*?>)?(?:\s*\([^)]*\))?\s*((?:extends|implements)\b[^{]*)\{/g;

interface JInfo {
  path: string;
  dir: string;
  pkg: string;
  simple: string;
  fqn: string;
  src: string;
  single: string[];
  wildcard: string[];
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.java$/, '');
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scan(path: string, src: string): JInfo {
  const pkg = PKG_RE.exec(src)?.[1] ?? javaPackageFromPath(path) ?? '';
  const single: string[] = [];
  const wildcard: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const name = m[2]!;
    if (m[3]) wildcard.push(name); // a.b.* and static a.b.C.* both name the scope before the star
    else single.push(name);        // type FQN, or static member FQN (a.b.C.m): callers strip trailing segments
  }
  const simple = basename(path);
  return { path, dir: dirname(path), pkg, simple, fqn: pkg ? `${pkg}.${simple}` : simple, src, single, wildcard };
}

export interface JavaSelectInput {
  /** All Java files at head (path -> content). */
  allFiles: Map<string, string>;
  /** Changed .java files that exist at head. */
  changed: string[];
  cap?: number;
}

export function selectJavaSnapshot({ allFiles, changed, cap = MAX_JAVA_FILES }: JavaSelectInput): { paths: string[]; limits: string[] } {
  const infos = new Map<string, JInfo>();
  for (const [p, s] of allFiles) if (p.endsWith('.java')) infos.set(p, scan(p, s));
  const changedSet = new Set(changed.filter((p) => infos.has(p)));

  const byFqn = new Map<string, JInfo>();
  const byDir = new Map<string, JInfo[]>();
  const byPkg = new Map<string, JInfo[]>();
  for (const i of infos.values()) {
    byFqn.set(i.fqn, i);
    (byDir.get(i.dir) ?? byDir.set(i.dir, []).get(i.dir)!).push(i);
    (byPkg.get(i.pkg) ?? byPkg.set(i.pkg, []).get(i.pkg)!).push(i);
  }
  /** Map an imported name (type FQN, nested type, or static member) to the declaring file. */
  const fileOfImport = (name: string): JInfo | undefined => {
    let n = name;
    for (;;) {
      const f = byFqn.get(n);
      if (f) return f;
      const dot = n.lastIndexOf('.');
      if (dot < 0) return undefined;
      n = n.slice(0, dot);
    }
  };
  const mentions = (src: string, simple: string) => new RegExp(`\\b${esc(simple)}\\b`).test(src);

  // Files that use a type declared in `target` (import by FQN, or wildcard import of its package/type plus a mention).
  const usersOf = (targets: JInfo[], skip: Set<string>): JInfo[] => {
    const fqns = new Set(targets.map((t) => t.fqn));
    const pkgs = new Map<string, JInfo[]>();
    for (const t of targets) (pkgs.get(t.pkg) ?? pkgs.set(t.pkg, []).get(t.pkg)!).push(t);
    const out: JInfo[] = [];
    for (const f of infos.values()) {
      if (skip.has(f.path)) continue;
      let hit = f.single.some((s) => {
        const d = fileOfImport(s);
        return !!d && fqns.has(d.fqn);
      });
      if (!hit) {
        for (const w of f.wildcard) {
          const ts = pkgs.get(w) ?? (fileOfImport(w) && fqns.has(fileOfImport(w)!.fqn) ? [fileOfImport(w)!] : undefined);
          if (ts?.some((t) => mentions(f.src, t.simple))) { hit = true; break; }
        }
      }
      if (hit) out.push(f);
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  };

  // Files declaring types that `f` references via imports, or wildcard-imported/same-package names it mentions.
  const dependenciesOf = (f: JInfo): JInfo[] => {
    const out = new Set<JInfo>();
    for (const s of f.single) { const d = fileOfImport(s); if (d && d !== f) out.add(d); }
    for (const w of f.wildcard) {
      const d = fileOfImport(w);
      if (d && d !== f) out.add(d);
      for (const c of byPkg.get(w) ?? []) if (c !== f && mentions(f.src, c.simple)) out.add(c);
    }
    return [...out];
  };
  // Supertypes named in extends/implements clauses, resolved through imports and the file's own package.
  const supertypesOf = (f: JInfo): JInfo[] => {
    const out: JInfo[] = [];
    for (const m of f.src.matchAll(HEADER_RE)) {
      const names = (m[1] ?? '').replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '').split(/[\s,]+/).filter((x) => /^[A-Za-z_][\w.]*$/.test(x) && x !== 'extends' && x !== 'implements' && x !== 'permits');
      for (const nm of names) {
        const simple = nm.slice(nm.lastIndexOf('.') + 1);
        const viaImport = f.single.map(fileOfImport).find((d) => d && d.simple === simple);
        const cand = viaImport ?? byFqn.get(f.pkg ? `${f.pkg}.${simple}` : simple) ?? fileOfImport(nm) ??
          f.wildcard.map((w) => byFqn.get(`${w}.${simple}`)).find(Boolean);
        if (cand && cand !== f) out.push(cand);
      }
    }
    return out;
  };

  const ordered: string[] = [];
  const seen = new Set<string>();
  const take = (list: Iterable<JInfo>) => {
    for (const i of [...list].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (!seen.has(i.path)) { seen.add(i.path); ordered.push(i.path); }
    }
  };
  const changedInfos = [...changedSet].map((p) => infos.get(p)!);
  for (const p of changedSet) { seen.add(p); ordered.push(p); }

  take(usersOf(changedInfos, new Set()));                       // importers / wildcard users of changed types
  const deps = new Set<JInfo>();
  for (const c of changedInfos) for (const d of dependenciesOf(c)) deps.add(d);
  take(deps);                                                   // types the changed files reference
  const supers = new Set<JInfo>();                              // supertypes up to 3 hops (inherited methods, DI interfaces)
  let frontier: JInfo[] = changedInfos;
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const next: JInfo[] = [];
    for (const f of frontier) for (const s of supertypesOf(f)) if (!supers.has(s) && !changedSet.has(s.path)) { supers.add(s); next.push(s); }
    frontier = next;
  }
  take(supers);
  const sameDirs = new Set(changedInfos.map((c) => c.dir));
  for (const d of sameDirs) take(byDir.get(d) ?? []);           // same package directory
  take(usersOf([...supers], seen));                             // callers of implemented interfaces / base classes

  const limits: string[] = [];
  let paths = ordered;
  if (ordered.length > cap) {
    paths = ordered.slice(0, cap);
    limits.push(`Indexed ${cap} of ${ordered.length} relevant Java files; ${ordered.length - cap} neighbouring files were left out.`);
  }
  return { paths, limits };
}
