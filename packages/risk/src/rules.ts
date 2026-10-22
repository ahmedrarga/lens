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
  '**/*[a-z0-9]{Test,Tests,IT,TestCase}.{java,kt}',
];
/** Appended to code-area path rules so test files in an area do not trigger the area rule. */
const NOT_TESTS = TEST_GLOBS.map((g) => `!${g}`);

const AUTH_PATHS = [
  ...nameGlobs(['auth', 'authn', 'authz', 'authentication', 'authorization', 'session', 'sessions', 'jwt', 'login', 'logout', 'password', 'passwords', 'sso'], []),
  ...nameGlobs(['oauth'], ['OAuth']),
  '**/authori[sz]*', '**/*Authori[sz]*', '**/authentic*', '**/*Authentic*', '**/oauth*/**', '**/OAuth*',
];
/** Spring/Java naming: JwtAuthenticationFilter, UserDetailsService, SecurityConfig, PasswordEncoder (Password* is covered above). */
const JAVA_AUTH_PATHS = [
  '**/security/**/*.{java,kt}', '**/*Security[A-Z]*.{java,kt}', '**/*Security.{java,kt}', '**/*UserDetails*.{java,kt}',
  '**/*Principal[A-Z]*.{java,kt}', '**/*SecurityConfig*.{java,kt}',
];
const PERMISSION_PATHS = nameGlobs(['permission', 'permissions', 'rbac', 'acl', 'acls', 'role', 'roles', 'policies']);
const PAYMENT_PATHS = nameGlobs(['billing', 'payment', 'payments', 'stripe', 'checkout', 'invoice', 'invoices', 'paypal']);
const CRYPTO_PATHS = nameGlobs(['crypto', 'cipher', 'encrypt', 'encryption', 'decrypt', 'kms', 'hmac']);

const JAVA_SRC = ['**/*.{java,kt}'];
const SPRING_CONFIG = ['**/application*.{yml,yaml,properties}', '**/bootstrap*.{yml,yaml,properties}'];

const rule = (
  id: string, description: string, level: RiskRule['level'], mustReview: boolean, match: RiskRule['match'],
): RiskRule => ({ id, description, level, mustReview, match });

export const LENS_POLICY_RULE: RiskRule = rule(
  'lens-policy', 'Changes Lens policy (.lens/**), which controls what gets reviewed', 'blocker', true,
  { paths: ['.lens/**', '**/.lens/**'] },
);

/** package.json: fires only when dependency entries change (custom analysis in deps.ts; level/message come from it). */
export const DEPS_MANIFEST_RULE: RiskRule = rule(
  'deps-manifest', 'Changes dependencies', 'med', false, { paths: ['**/package.json', '**/pom.xml', '**/build.gradle', '**/build.gradle.kts'] },
);

/**
 * Content patterns may start with `added:`, `removed:` or `net-removed:` (more matches removed than added in the
 * same hunk), and `(?i)` for case-insensitive. Without a prefix, added and removed lines are both searched.
 */
export const DEFAULT_RULES: RiskRule[] = [
  rule('auth', 'Changes authentication or authorization code', 'high', true, {
    paths: [...AUTH_PATHS, ...JAVA_AUTH_PATHS, ...NOT_TESTS],
    symbols: ['authori[sz]e', 'authenticate', 'loadUserByUsername', '\\bjwt', 'PasswordEncoder', 'verify(Token|Signature|Jwt|Session)', 'sign(Token|Jwt)', '(hash|compare|verify)Password', 'validateSession', 'createSession'],
  }),
  rule('auth-guard-removed', 'Removes an authentication or permission check', 'high', true, {
    paths: NOT_TESTS,
    content: ['net-removed:\\b(requireAuth\\w*|isAuthenticated|ensureAuth\\w*|authenticate\\w*|authori[sz]e\\w*|checkPermission|hasPermission|requireRole|requireAdmin|isAdmin)\\s*\\('],
  }),
  rule('permissions', 'Changes roles or permission checks', 'high', true, {
    paths: [...PERMISSION_PATHS, ...NOT_TESTS],
    symbols: ['(check|has|require|assert)(Permission|Role|Scope)s?', 'has(Any)?(Role|Authority)', 'isAdmin', 'isSuperuser', 'canAccess'],
  }),
  rule('secrets', 'Touches files that hold secrets or key material', 'high', true, {
    paths: ['**/*.{pem,key,p12,pfx,jks,keystore}', '**/id_rsa*', '**/id_ed25519*', '**/secrets/**', '**/secrets.*', '**/*.secret', '**/*.secrets.*', '**/credentials.json', '**/.npmrc',
      '**/application-secret*.{yml,yaml,properties}', '**/*-secrets.{yml,yaml,properties}', '**/*.truststore'],
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
    symbols: ['\\b(charge(Card|Customer)?|refund\\w*|payout\\w*|createPaymentIntent|capturePayment|createCheckoutSession|(create|cancel|update|renew)(Billing|Stripe|Paid|Plan)Subscription|(stripe|billing|invoice|checkout|payment|plan|price)\\w*Subscription|Subscription(Plan|Price|Invoice|Billing)\\w*)\\b'],
  }),
  rule('db-migration', 'Changes a database migration or schema definition', 'high', true, {
    paths: [
      '**/migrations/**', '**/migrate/**', '**/*.sql', '**/prisma/schema.prisma', '**/schema.prisma', '**/drizzle/**',
      '**/db/schema.*', '**/alembic/**', '**/flyway/**', '**/knex/migrations/**',
      // Flyway (V*__*.sql, R__*.sql, Java migrations) and Liquibase
      '**/db/migration/**', '**/db/changelog/**', '**/*[Cc]hangelog*.{xml,yaml,yml,sql}',
    ],
  }),
  rule('db-schema', 'Alters or drops database schema', 'high', true, {
    content: ['added:(?i)\\bDROP\\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)\\b', 'added:(?i)\\bALTER\\s+TABLE\\b', 'added:(?i)\\bTRUNCATE\\s+(TABLE\\s+)?\\w', 'added:\\.(dropTable|dropColumn|dropIndex)\\(',
      'added:\\bRENAME\\s+(TABLE|COLUMN)\\b', 'added:\\bsp_rename\\b',
      // Liquibase XML / YAML changes
      'added:<(dropTable|dropColumn|dropForeignKeyConstraint|dropIndex|renameTable|renameColumn|modifyDataType|dropNotNullConstraint)\\b',
      'added:(?:^|\\n)\\s*-?\\s*(dropTable|dropColumn|renameTable|renameColumn|modifyDataType|dropNotNullConstraint)\\s*:',
    ],
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
  DEPS_MANIFEST_RULE,
  rule('deps-manifest-other', 'Changes dependency manifest', 'med', false, {
    paths: ['**/requirements*.txt', '**/pyproject.toml', '**/go.mod', '**/Cargo.toml', '**/Gemfile', '**/libs.versions.toml'],
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
    content: ['added:\\.(skip|only|todo)\\(', 'added:\\b(xit|xdescribe|xtest|fit|fdescribe)\\(', 'added:\\b(it|test|describe)\\.(skip|only|todo)\\b',
      'added:^\\s*@(Disabled|Ignore)\\b', 'added:\\n\\s*@(Disabled|Ignore)\\b'],
  }),
  rule('weakened-test', 'Removes assertions from a test', 'high', true, {
    paths: TEST_GLOBS,
    content: ['net-removed:\\b(expect|assert\\w*)\\s*\\('],
    fileStatus: ['modified', 'renamed'],
  }),
  rule('error-swallow', 'Swallows errors silently (empty catch, or catch that only logs and continues)', 'med', true, {
    paths: NOT_TESTS,
    content: [
      'added:\\bcatch\\s*(\\([^)]*\\))?\\s*\\{\\s*(//[^\\n]*)?\\s*\\}',
      'added:\\.catch\\(\\s*(\\(\\s*\\w*\\s*\\)|\\w+)\\s*=>\\s*(\\{\\s*\\}|undefined|null|void 0)\\s*\\)',
      'added:\\bexcept(\\s+\\w+)?(\\s+as\\s+\\w+)?\\s*:\\s*pass\\b',
      // Java/Kotlin: empty catch (comments allowed), or a catch that only logs / prints the exception and carries on
      'added:\\bcatch\\s*\\([^)]*\\)\\s*\\{(?:\\s*(?://[^\\n]*|/\\*[\\s\\S]*?\\*/))*\\s*\\}',
      'added:\\bcatch\\s*\\([^)]*\\)\\s*\\{\\s*(?:(?:log|logger|LOG|LOGGER|slf4jLogger)\\.\\w+\\([^;]*\\);|\\w+\\.printStackTrace\\(\\s*\\);|System\\.(?:err|out)\\.print(?:ln)?\\([^;]*\\);)\\s*\\}',
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
  // ---- Spring / JPA / Java ----
  rule('jpa-entity', 'Changes JPA entity mapping (annotations or fields), which implies a database schema change', 'med', false, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [`added:@(Entity|Table|Column|JoinColumn|JoinTable|OneToMany|ManyToOne|OneToOne|ManyToMany|ElementCollection|Embedded|Embeddable|MappedSuperclass|Inheritance|GeneratedValue|Enumerated|Convert|Version)\\b`,
      `removed:@(Entity|Table|Column|JoinColumn|JoinTable|OneToMany|ManyToOne|OneToOne|ManyToMany|ElementCollection|Embedded|Embeddable|MappedSuperclass|Inheritance|GeneratedValue|Enumerated|Convert|Version)\\b`],
  }),
  rule('jpa-entity-schema', 'Removes or alters a JPA column or relationship (nullable/unique/length/name changed or mapping dropped): existing data and the migration must still fit', 'med', true, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [
      'net-removed:@(Column|JoinColumn|JoinTable|OneToMany|ManyToOne|OneToOne|ManyToMany|ElementCollection|Embedded|Id|Table|Entity)\\b',
      'removed:@(Column|JoinColumn)\\b[^\\n]*\\b(nullable|unique|length|precision|scale|columnDefinition|name)\\s*=',
      'added:@(Column|JoinColumn)\\b[^\\n]*\\b(nullable|unique|length|precision|scale|columnDefinition)\\s*=',
    ],
  }),
  rule('spring-security', 'Changes Spring Security configuration (filter chain, HTTP rules, who may call what)', 'high', true, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [
      'added:\\b(SecurityFilterChain|WebSecurityConfigurerAdapter|HttpSecurity|EnableWebSecurity|AuthenticationManager)\\b',
      'removed:\\b(SecurityFilterChain|WebSecurityConfigurerAdapter|HttpSecurity)\\b',
      '\\.(anyRequest|authorizeHttpRequests|authorizeRequests|requestMatchers|antMatchers|mvcMatchers)\\(',
      '\\.(hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|authenticated|denyAll|anonymous)\\(',
    ],
  }),
  rule('spring-security-open', 'Opens access: permitAll(), CSRF disabled, or wildcard CORS origin', 'high', true, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [
      'added:\\.permitAll\\(\\)', 'added:\\bcsrf\\(\\s*\\)\\s*\\.\\s*disable\\(\\)',
      'added:\\bcsrf\\(\\s*(?:\\w+\\s*->\\s*\\w+\\s*\\.\\s*disable\\(\\)|\\w+::disable|AbstractHttpConfigurer::disable)',
      'added:\\ballowedOrigin(?:Pattern)?s\\(\\s*"\\*"', 'added:\\.addAllowedOrigin(?:Pattern)?\\(\\s*"\\*"',
      'added:@CrossOrigin(?!\\s*\\()', 'added:@CrossOrigin\\([^)]*"\\*"',
    ],
  }),
  rule('spring-security-annotation-removed', 'Removes or changes a method-level access check (@PreAuthorize/@Secured/@RolesAllowed): the method may become callable by more users', 'high', true, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: ['removed:@(PreAuthorize|PostAuthorize|Secured|RolesAllowed|PreFilter|PostFilter)\\b'],
  }),
  rule('spring-security-annotation', 'Adds method-level access control (@PreAuthorize/@Secured/@RolesAllowed): check the expression grants exactly the intended roles', 'med', false, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: ['added:@(PreAuthorize|PostAuthorize|Secured|RolesAllowed|PreFilter|PostFilter|EnableMethodSecurity|EnableGlobalMethodSecurity)\\b'],
  }),
  rule('transactional', 'Changes transaction boundaries (@Transactional added/removed, propagation/isolation/readOnly changed): affects atomicity and rollback', 'med', true, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [
      '@Transactional\\b', '\\b(Propagation|Isolation)\\.[A-Z_]+', '(\\bTransactionTemplate\\b|@EnableTransactionManagement\\b)',
      '\\b(rollbackFor|noRollbackFor)\\s*=',
    ],
  }),
  rule('native-query', 'Uses native SQL or JdbcTemplate, which bypasses JPA/JPQL checks and is database specific', 'med', false, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [
      'added:\\bnativeQuery\\s*=\\s*true', 'added:\\bcreateNativeQuery\\(',
      'added:\\b(JdbcTemplate|NamedParameterJdbcTemplate|JdbcClient|SimpleJdbcInsert)\\b',
    ],
  }),
  rule('native-query-concat', 'Builds SQL/JPQL by string concatenation or formatting: SQL injection risk, use bind parameters', 'med', true, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: [
      `added:(?i)"[^"\\n]*\\b(select\\s[^"\\n]*\\bfrom|insert\\s+into|update\\s+\\w+\\s+set|delete\\s+from|where\\s+[\\w.]+\\s*(=|<|>|!=|like|in)|from\\s+\\w+\\s+\\w+\\s+where)\\b[^"\\n]*"\\s*\\+\\s*[\\w(]`,
      `added:(?i)[\\w)\\]]\\s*\\+\\s*"[^"\\n]*\\b(where|and|or|order\\s+by|group\\s+by|limit|values)\\b[^"\\n]*"[^;\\n]*(createQuery|createNativeQuery|query|execute|update|prepareStatement)`,
      `added:(?i)(String\\.format\\(|\\.formatted\\()?\\s*"[^"\\n]*\\b(select\\s[^"\\n]*\\bfrom|insert\\s+into|update\\s+\\w+\\s+set|delete\\s+from)\\b[^"\\n]*%[sd][^"\\n]*"`,
    ],
  }),
  rule('spring-config-ddl', 'Lets Hibernate change the schema on startup (ddl-auto create/update/create-drop): can drop or alter tables outside migrations', 'high', true, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: ['added:(?i)\\bddl[-_]auto\\s*[:=]\\s*["\']?(create|update|create-drop|create_drop)\\b'],
  }),
  rule('spring-config-secret', 'Puts a literal credential/secret in Spring config; use an environment placeholder (${...}) or a secret store', 'high', true, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: [`added:(?i)(?<!\\$\\{[\\w.-]*)(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|secret[-_]?key|signing[-_]?key|access[-_]?key|credentials?)[ \\t]*[:=][ \\t]*(?!["']?\\$\\{)(?![ \\t]*(?:\\n|$|#))["']?[^\\s"'#]`],
  }),
  rule('spring-config-actuator-open', 'Exposes sensitive actuator endpoints (wildcard, env, heapdump, shutdown, ...) over HTTP', 'high', true, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: [
      'added:management\\.endpoints\\.web\\.exposure\\.include\\s*[=:][^\\n]*(\\*|\\b(env|heapdump|shutdown|beans|mappings|configprops|threaddump|loggers)\\b)',
      'added:(?:^|\\n)\\s*include\\s*:\\s*\\[?\\s*["\']?[^\\n]*(\\*|\\b(env|heapdump|shutdown|beans|mappings|configprops|threaddump|loggers)\\b)',
      'added:(?i)\\bshow-(values|details)\\s*[:=]\\s*always\\b', 'added:management\\.endpoint\\.shutdown\\.enabled\\s*[:=]\\s*true',
    ],
  }),
  rule('spring-config-actuator', 'Changes actuator/management exposure settings', 'med', false, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: ['management\\.endpoints?\\.', '(?:^|\\n)\\s*(management|exposure)\\s*:'],
  }),
  rule('spring-config-tls', 'Changes server TLS/SSL settings (certificates, protocols, enabled flag)', 'high', true, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: ['\\bserver\\.ssl\\.', '(?:^|\\n)\\s*ssl\\s*:'],
  }),
  rule('spring-config-datasource', 'Changes datasource/connection settings: the app may point at a different database or pool', 'med', false, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: ['(?i)\\bspring\\.(datasource|data\\.\\w+|redis|r2dbc|flyway|liquibase)\\.', '\\bjdbc:\\w+:', '(?:^|\\n)\\s*(datasource|hikari|r2dbc|flyway|liquibase)\\s*:'],
  }),
  rule('spring-config-profile', 'Changes Spring profile activation or imported config: different environments may load different settings', 'med', false, {
    paths: [...SPRING_CONFIG, ...NOT_TESTS],
    content: ['\\bspring\\.profiles\\.(active|include|group)', '\\bspring\\.config\\.(activate\\.on-profile|import)', '\\bspring\\.profiles\\s*:', '(?:^|\\n)\\s*on-profile\\s*:'],
  }),
  rule('spring-config-prod', 'Changes production-profile Spring configuration', 'med', false, {
    paths: ['**/application-{prod,production,live,stage,staging}.{yml,yaml,properties}', '**/bootstrap-{prod,production}.{yml,yaml,properties}'],
  }),
  rule('scheduled-jobs', 'Adds or changes background execution (@Scheduled/@Async/message listeners): runs outside a request, with its own failure and concurrency behaviour', 'med', false, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: ['@(Scheduled|Async|KafkaListener|RabbitListener|JmsListener|SqsListener|StreamListener|EventListener|TransactionalEventListener|EnableScheduling|EnableAsync|SchedulerLock)\\b'],
  }),
  rule('java-throws-broad', 'Broadens a method signature to throws Exception/Throwable, hiding which failures callers must handle', 'low', false, {
    paths: [...JAVA_SRC, ...NOT_TESTS],
    content: ['added:\\bthrows\\s+(Exception|Throwable)\\b'],
  }),
  rule('deletion', 'Removes a file', 'med', false, { fileStatus: ['removed'] }),
  LENS_POLICY_RULE,
];

export const DEFAULT_POLICY: RiskPolicy = { rules: DEFAULT_RULES, neverCollapse: ['.lens/**'] };
