import type { RiskPolicy, RiskRule } from '@lens/core';

/** Words become path globs that respect word boundaries (`auth` matches `auth.ts`, `useAuth.ts`, not `author.ts`). */
function nameGlobs(words: string[], extraCaps: string[] = []): string[] {
  const out: string[] = [];
  for (const w of words) {
    const cap = w[0]!.toUpperCase() + w.slice(1);
    const caps = [cap, w.toUpperCase(), ...extraCaps.filter((c) => c.toLowerCase() === w)];
    out.push(
      `**/${w}/**`, `**/${w}-*/**`, `**/*-${w}/**`, `**/${w}.*`, `**/${w}-*`, `**/${w}_*`,
      `**/*-${w}`, `**/*-${w}.*`, `**/*-${w}-*`, `**/*_${w}.*`, `**/*_${w}_*`, `**/*.${w}.*`,
      `**/${w}[A-Z]*`,
    );
    for (const c of new Set(caps)) out.push(`**/*${c}[A-Z._-]*`, `**/*${c}`);
  }
  return out;
}

const TEST_GLOBS = [
  '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}', '**/__tests__/**', '**/test/**', '**/tests/**', '**/*_test.*',
];
/** Appended to code-area path rules so test files in an area do not trigger the area rule. */
const NOT_TESTS = TEST_GLOBS.map((g) => `!${g}`);

const AUTH_PATHS = [
  ...nameGlobs(['auth', 'authn', 'authz', 'authentication', 'authorization', 'session', 'sessions', 'jwt', 'login', 'logout', 'password', 'passwords', 'sso'], []),
  ...nameGlobs(['oauth'], ['OAuth']),
  '**/authori[sz]*', '**/*Authori[sz]*', '**/authentic*', '**/*Authentic*', '**/oauth*/**', '**/OAuth*',
];
const PERMISSION_PATHS = nameGlobs(['permission', 'permissions', 'rbac', 'acl', 'acls', 'role', 'roles', 'policies']);
const PAYMENT_PATHS = nameGlobs(['billing', 'payment', 'payments', 'stripe', 'checkout', 'invoice', 'invoices', 'paypal', 'subscription', 'subscriptions']);
const CRYPTO_PATHS = nameGlobs(['crypto', 'cipher', 'encrypt', 'encryption', 'decrypt', 'kms', 'hmac']);

const rule = (
  id: string, description: string, level: RiskRule['level'], mustReview: boolean, match: RiskRule['match'],
): RiskRule => ({ id, description, level, mustReview, match });

export const LENS_POLICY_RULE: RiskRule = rule(
  'lens-policy', 'Changes Lens policy (.lens/**), which controls what gets reviewed', 'blocker', true,
  { paths: ['.lens/**', '**/.lens/**'] },
);

/**
 * Content patterns may start with `added:`, `removed:` or `net-removed:` (more matches removed than added in the
 * same hunk), and `(?i)` for case-insensitive. Without a prefix, added and removed lines are both searched.
 */
export const DEFAULT_RULES: RiskRule[] = [
  rule('auth', 'Changes authentication or authorization code', 'high', true, {
    paths: [...AUTH_PATHS, ...NOT_TESTS],
    symbols: ['authori[sz]e', 'authenticate', 'verify(Token|Signature|Jwt|Session)', 'sign(Token|Jwt)', '(hash|compare|verify)Password', 'validateSession', 'createSession'],
  }),
  rule('auth-guard-removed', 'Removes an authentication or permission check', 'high', true, {
    paths: NOT_TESTS,
    content: ['net-removed:\\b(requireAuth\\w*|isAuthenticated|ensureAuth\\w*|authenticate\\w*|authori[sz]e\\w*|checkPermission|hasPermission|requireRole|requireAdmin|isAdmin)\\s*\\('],
  }),
  rule('permissions', 'Changes roles or permission checks', 'high', true, {
    paths: [...PERMISSION_PATHS, ...NOT_TESTS],
    symbols: ['(check|has|require|assert)(Permission|Role|Scope)s?', 'isAdmin', 'isSuperuser', 'canAccess'],
  }),
  rule('secrets', 'Touches files that hold secrets or key material', 'high', true, {
    paths: ['**/*.{pem,key,p12,pfx,jks,keystore}', '**/id_rsa*', '**/id_ed25519*', '**/secrets/**', '**/secrets.*', '**/*.secret', '**/*.secrets.*', '**/credentials.json', '**/.npmrc'],
  }),
  rule('hardcoded-secret', 'Adds what looks like a hardcoded secret', 'high', true, {
    paths: NOT_TESTS,
    content: [
      'added:-----BEGIN [A-Z ]*PRIVATE KEY-----', 'added:\\bAKIA[0-9A-Z]{16}\\b', 'added:\\bgh[pousr]_[A-Za-z0-9]{36,}\\b',
      'added:\\bsk_live_[A-Za-z0-9]{10,}', 'added:\\bxox[baprs]-[A-Za-z0-9-]{10,}',
      "added:(?i)\\b(api[_-]?key|secret|passw(or)?d|access[_-]?token|private[_-]?key)\\b['\"]?\\s*[:=]\\s*['\"][A-Za-z0-9/+_=.-]{16,}['\"]",
    ],
  }),
  rule('crypto', 'Changes cryptographic code', 'high', true, {
    paths: [...CRYPTO_PATHS, ...NOT_TESTS],
    symbols: ['\\b(encrypt|decrypt|hmac|pbkdf2|scrypt|bcrypt|argon2)\\w*', 'sign(Payload|Message)', 'derive(Key|Secret)'],
  }),
  rule('crypto-api', 'Uses low-level cryptographic primitives', 'high', true, {
    paths: NOT_TESTS,
    content: [
      'added:\\bcrypto\\.(subtle|createCipheriv|createDecipheriv|createSign|createVerify|createHmac|pbkdf2(Sync)?|scrypt(Sync)?|timingSafeEqual)\\b',
      "added:\\bcreateHash\\(\\s*['\"](md5|sha1)['\"]",
    ],
  }),
  rule('payments', 'Changes billing or payment code', 'high', true, {
    paths: [...PAYMENT_PATHS, ...NOT_TESTS],
    symbols: ['\\b(charge(Card|Customer)?|refund\\w*|payout\\w*|createPaymentIntent|capturePayment|createCheckoutSession|createSubscription|cancelSubscription)\\b'],
  }),
  rule('db-migration', 'Changes a database migration or schema definition', 'high', true, {
    paths: [
      '**/migrations/**', '**/migrate/**', '**/*.sql', '**/prisma/schema.prisma', '**/schema.prisma', '**/drizzle/**',
      '**/db/schema.*', '**/alembic/**', '**/flyway/**', '**/knex/migrations/**',
    ],
  }),
  rule('db-schema', 'Alters or drops database schema', 'high', true, {
    content: ['added:(?i)\\bDROP\\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)\\b', 'added:(?i)\\bALTER\\s+TABLE\\b', 'added:(?i)\\bTRUNCATE\\s+(TABLE\\s+)?\\w', 'added:\\.(dropTable|dropColumn|dropIndex)\\('],
  }),
  rule('sql-raw', 'Builds raw SQL (injection risk)', 'med', true, {
    paths: NOT_TESTS,
    content: [
      'added:\\$(query|execute)RawUnsafe', 'added:\\bsql\\.raw\\(', 'added:\\b(knex|db|trx|tx)\\.raw\\(',
      'added:(?i)\\b(select\\s[^`;]*\\sfrom|insert\\s+into|update\\s+\\w+\\s+set|delete\\s+from)\\b[^`]*\\$\\{',
    ],
  }),
  rule('data-delete', 'Deletes persisted data', 'med', false, {
    paths: NOT_TESTS,
    content: [
      'added:(?i)\\bDELETE\\s+FROM\\b', 'added:\\.(deleteMany|destroy|destroyAll|removeAll)\\(',
      'added:\\b\\w*(?:[Rr]epo|[Rr]epository|[Dd]b|[Pp]risma|[Kk]nex|[Cc]ollection|[Tt]able|tx|trx)\\w*\\.(?:\\w+\\.)?delete\\(',
    ],
  }),
  rule('infra', 'Changes infrastructure or deployment configuration', 'med', false, {
    paths: [
      'Dockerfile*', '**/Dockerfile*', '**/*.dockerfile', '**/docker-compose*.{yml,yaml}', '**/*.tf', '**/*.tfvars', '**/terraform/**',
      '**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/charts/**', '**/pulumi/**', '**/cloudformation/**', '**/serverless.{yml,yaml}',
    ],
  }),
  rule('ci', 'Changes CI/CD pipeline configuration', 'med', false, {
    paths: ['.github/workflows/**', '.github/actions/**', '.gitlab-ci.yml', '.circleci/**', '.buildkite/**', '**/Jenkinsfile', 'azure-pipelines.yml'],
  }),
  rule('deps-manifest', 'Changes dependency manifest', 'med', false, {
    paths: ['**/package.json', '**/requirements*.txt', '**/pyproject.toml', '**/go.mod', '**/Cargo.toml', '**/Gemfile'],
  }),
  rule('env-config', 'Changes environment configuration', 'med', false, {
    paths: ['**/.env', '**/.env.*', '**/*.env'],
  }),
  rule('env-read', 'Reads a new environment variable', 'low', false, {
    paths: NOT_TESTS,
    content: ['added:\\bprocess\\.env\\.[A-Z_][A-Z0-9_]*', 'added:\\bimport\\.meta\\.env\\.[A-Z_]\\w*'],
  }),
  rule('deleted-tests', 'Deletes a test file', 'high', true, { paths: TEST_GLOBS, fileStatus: ['removed'] }),
  rule('skipped-tests', 'Adds a skipped or focused test', 'high', true, {
    paths: TEST_GLOBS,
    content: ['added:\\.(skip|only|todo)\\(', 'added:\\b(xit|xdescribe|xtest|fit|fdescribe)\\(', 'added:\\b(it|test|describe)\\.(skip|only|todo)\\b'],
  }),
  rule('weakened-test', 'Removes assertions from a test', 'high', true, {
    paths: TEST_GLOBS,
    content: ['net-removed:\\b(expect|assert\\w*)\\s*\\('],
    fileStatus: ['modified', 'renamed'],
  }),
  rule('error-swallow', 'Swallows errors silently', 'med', true, {
    paths: NOT_TESTS,
    content: [
      'added:\\bcatch\\s*(\\([^)]*\\))?\\s*\\{\\s*(//[^\\n]*)?\\s*\\}',
      'added:\\.catch\\(\\s*(\\(\\s*\\w*\\s*\\)|\\w+)\\s*=>\\s*(\\{\\s*\\}|undefined|null|void 0)\\s*\\)',
      'added:\\bexcept(\\s+\\w+)?(\\s+as\\s+\\w+)?\\s*:\\s*pass\\b',
    ],
  }),
  rule('security-headers', 'Changes security headers, CORS or CSP', 'med', false, {
    paths: NOT_TESTS,
    content: [
      '(?i)\\bContent-Security-Policy\\b', '(?i)\\bStrict-Transport-Security\\b', '(?i)\\bX-Frame-Options\\b',
      '(?i)\\bAccess-Control-Allow-(Origin|Credentials)\\b', '\\bhelmet\\(', '\\bcors\\(',
    ],
  }),
  rule('unsafe-eval', 'Adds dynamic code execution or unescaped HTML', 'med', true, {
    paths: NOT_TESTS,
    content: ['added:dangerouslySetInnerHTML', 'added:(?<![.\\w])eval\\(', 'added:\\bnew Function\\(', 'added:\\.innerHTML\\s*=(?!=)', 'added:\\bchild_process\\b'],
  }),
  rule('deletion', 'Removes a file', 'med', false, { fileStatus: ['removed'] }),
  LENS_POLICY_RULE,
];

export const DEFAULT_POLICY: RiskPolicy = { rules: DEFAULT_RULES, neverCollapse: ['.lens/**'] };
