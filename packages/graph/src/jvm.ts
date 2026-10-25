/**
 * Module resolution for the graph (zoom level 0).
 *
 * Non-JVM paths: module = first two directory segments (id `module:<dir>`, label = dir), as before.
 *
 * JVM layouts (a path containing `src/{main,test}/{java,kotlin,resources}/`):
 *   build prefix  = the part before `src/` ('' for a single-module repo, `billing` or `services/billing` otherwise)
 *   base package  = longest common package prefix of the PR's changed .java/.kt files in that build module
 *                   (if all files share one package, the base is its parent, so the module is still named)
 *   module        = base package + the next package segment. Test sources map to the same module as main.
 *
 *   id    `module:<prefix>/java:<dotted.package>`    (no `<prefix>/` for a single-module repo; Kotlin uses `java:` too)
 *         `module:<prefix>/resources:db-migration`  (src/main/resources/db/migration|changelog/**, Java files in a db.migration package)
 *         `module:<prefix>/resources:config`        (all other resources: application*.yml, templates, static, ...)
 *   label `orders` / `db migrations` / `config & resources`; when the PR touches several build modules the label is
 *         prefixed: `billing: orders`.
 *   path  the main-source directory of the module (resources: the resources directory).
 */

export interface ModuleInfo { key: string; label: string; path?: string }

const JVM_RE = /^(?:(.+?)\/)?src\/(main|test)\/(java|kotlin|resources)\/(.*)$/;
const MIGRATION_RE = /(^|\/)db\/(migration|changelog)(\/|$)/;

interface Jvm { prefix: string; kind: 'java' | 'kotlin' | 'resources'; rest: string; pkg: string[] }

function parseJvm(path: string): Jvm | null {
  const m = JVM_RE.exec(path);
  if (!m) return null;
  const kind = m[3] as Jvm['kind'];
  const rest = m[4]!;
  const pkg = kind === 'resources' ? [] : rest.split('/').slice(0, -1);
  return { prefix: m[1] ?? '', kind, rest, pkg };
}
const isMigrationPkg = (pkg: string[]) => MIGRATION_RE.test(pkg.join('/'));

export function moduleDir(path: string): string {
  const dirs = path.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join('/') : '.';
}

export function createModuleResolver(paths: Iterable<string>): (path: string) => ModuleInfo {
  const prefixes = new Set<string>();
  const pkgsByPrefix = new Map<string, string[][]>();
  for (const p of paths) {
    const j = parseJvm(p);
    if (!j) continue;
    prefixes.add(j.prefix);
    if (j.kind !== 'resources' && !isMigrationPkg(j.pkg) && /\.(java|kt)$/.test(p)) {
      (pkgsByPrefix.get(j.prefix) ?? pkgsByPrefix.set(j.prefix, []).get(j.prefix)!).push(j.pkg);
    }
  }
  const multi = prefixes.size > 1;
  const base = new Map<string, string[]>();
  for (const [prefix, pkgs] of pkgsByPrefix) {
    let common = pkgs[0]!;
    for (const p of pkgs) {
      let n = 0;
      while (n < common.length && n < p.length && common[n] === p[n]) n++;
      common = common.slice(0, n);
    }
    // One shared package: use its parent as base so the module still gets a name (`orders`, not `(root)`).
    if (pkgs.every((p) => p.length === common.length) && common.length > 0) common = common.slice(0, -1);
    base.set(prefix, common);
  }

  const cache = new Map<string, ModuleInfo>();
  const decorate = (prefix: string, label: string) => (multi ? `${prefix || 'root'}: ${label}` : label);
  const idPrefix = (prefix: string, kind: string) => `${prefix ? `${prefix}/` : ''}${kind}`;
  const srcDir = (prefix: string, kind: string) => `${prefix ? `${prefix}/` : ''}src/main/${kind}`;

  return (path: string): ModuleInfo => {
    const hit = cache.get(path);
    if (hit) return hit;
    const j = parseJvm(path);
    let info: ModuleInfo;
    if (!j) {
      const dir = moduleDir(path);
      info = { key: dir, label: dir, ...(dir === '.' ? {} : { path: dir }) };
    } else if (j.kind === 'resources' || isMigrationPkg(j.pkg)) {
      const mig = j.kind === 'resources' ? MIGRATION_RE.test(j.rest) : true;
      info = mig
        ? { key: `${idPrefix(j.prefix, 'resources')}:db-migration`, label: decorate(j.prefix, 'db migrations'), path: `${srcDir(j.prefix, 'resources')}/db` }
        : { key: `${idPrefix(j.prefix, 'resources')}:config`, label: decorate(j.prefix, 'config & resources'), path: srcDir(j.prefix, 'resources') };
      if (j.kind !== 'resources') info.path = `${srcDir(j.prefix, j.kind)}/${j.pkg.join('/')}`;
    } else {
      const b = base.get(j.prefix);
      let modPkg: string[];
      let label: string;
      if (b && b.length <= j.pkg.length && b.every((s, i) => j.pkg[i] === s)) {
        modPkg = j.pkg.slice(0, b.length + 1);
        label = j.pkg.length > b.length ? j.pkg[b.length]! : (b[b.length - 1] ?? '(default package)');
        if (j.pkg.length === b.length) modPkg = b;
      } else {
        modPkg = j.pkg;
        label = j.pkg[j.pkg.length - 1] ?? '(default package)';
      }
      info = {
        key: `${idPrefix(j.prefix, 'java')}:${modPkg.join('.')}`,
        label: decorate(j.prefix, label),
        path: `${srcDir(j.prefix, j.kind)}/${modPkg.join('/')}`.replace(/\/$/, ''),
      };
    }
    cache.set(path, info);
    return info;
  };
}
