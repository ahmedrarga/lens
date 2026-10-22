import { describe, expect, it } from 'vitest';
import type { ChangeGraph, FileStatus, GraphNode, Hunk, PrFile } from '@lens/core';
import { DEFAULT_POLICY, applyRisk } from './index.js';

const pr = {
  provider: 'gitlab' as const, owner: 'o', repo: 'r', number: 1, url: 'u', title: 't', body: null, author: null,
  baseSha: 'b', headSha: 'h', baseRef: 'main', headRef: 'f',
};

interface Spec { path: string; status?: FileStatus; added?: string[]; removed?: string[]; body?: string[] }

/** One file node per spec; `body` gives a raw hunk body (with ' ' context lines) instead of added/removed. */
function run(spec: Spec) {
  const status = spec.status ?? 'modified';
  const id = `file:${spec.path}`;
  const body = spec.body ?? [...(spec.removed ?? []).map((l) => `-${l}`), ...(spec.added ?? []).map((l) => `+${l}`)];
  const nodes: GraphNode[] = [
    { id: 'module:m', kind: 'module', level: 0, label: 'm', state: 'modified' },
    { id: 'cluster:c', kind: 'cluster', level: 1, label: 'c', state: 'modified', parent: 'module:m' },
    { id, kind: 'file', level: 2, label: spec.path, state: status, path: spec.path, parent: 'cluster:c' },
  ];
  const hunk: Hunk = {
    id: 'h0', path: spec.path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    added: body.filter((l) => l[0] === '+').length, removed: body.filter((l) => l[0] === '-').length, owner: id,
    patch: ['@@ -1 +1 @@', ...body].join('\n'),
  };
  const graph: ChangeGraph = {
    schema: 1, pr, generatedAt: '', pipelineVersion: 't', nodes, edges: [], hunks: [hunk], skippedFiles: [], limits: [],
    stats: { files: 1, added: 0, removed: 0, durationMs: 0 },
  };
  const files: PrFile[] = [{ path: spec.path, status, additions: 0, deletions: 0 }];
  const out = applyRisk(graph, DEFAULT_POLICY, { files, policySource: { source: 'default', errors: [] } });
  const risk = out.nodes[2]!.risk!;
  return { ids: risk.reasons.map((r) => r.ruleId), reasons: risk.reasons, must: risk.mustReview, level: risk.level };
}

const SVC = 'src/main/java/com/acme/shop/orders/OrderService.java';
const CFG = 'src/main/resources/application.yml';

type Case = [name: string, spec: Spec, has: string[], hasNot?: string[]];
function table(cases: Case[]) {
  for (const [name, spec, has, hasNot = []] of cases) {
    it(name, () => {
      const r = run(spec);
      for (const id of has) expect(r.ids, `${name}: expected ${id} in ${r.ids}`).toContain(id);
      for (const id of hasNot) expect(r.ids, `${name}: unexpected ${id}`).not.toContain(id);
    });
  }
}

describe('java: path rules', () => {
  table([
    ['JwtAuthenticationFilter is auth', { path: 'src/main/java/com/acme/security/JwtAuthenticationFilter.java' }, ['auth']],
    ['UserDetailsServiceImpl is auth', { path: 'src/main/java/com/acme/user/UserDetailsServiceImpl.java' }, ['auth']],
    ['PasswordEncoder config is auth', { path: 'src/main/java/com/acme/config/PasswordEncoderConfig.java' }, ['auth']],
    ['WebSecurityConfig is auth', { path: 'src/main/java/com/acme/config/WebSecurityConfig.java' }, ['auth']],
    ['SecurityConfiguration is auth', { path: 'src/main/java/com/acme/SecurityConfiguration.java' }, ['auth']],
    ['security package file is auth', { path: 'src/main/java/com/acme/security/Whatever.java' }, ['auth']],
    ['RoleRepository is permissions', { path: 'src/main/java/com/acme/user/RoleRepository.java' }, ['permissions']],
    ['author is not auth', { path: 'src/main/java/com/acme/book/AuthorService.java' }, [], ['auth']],
    ['Authority-less OrderService is clean', { path: SVC }, [], ['auth', 'permissions']],
    ['test for auth class is not auth', { path: 'src/test/java/com/acme/security/JwtAuthenticationFilterTest.java' }, [], ['auth']],
    ['hasRole symbol-free path', { path: SVC, added: ['if (user.hasRole("ADMIN")) {'] }, []],
    ['keystore secret', { path: 'src/main/resources/keystore.jks' }, ['secrets']],
    ['deleted JUnit test', { path: 'src/test/java/com/acme/OrderServiceTest.java', status: 'removed' }, ['deleted-tests']],
    ['@Disabled test', { path: 'src/test/java/com/acme/OrderServiceTest.java', added: ['    @Disabled("flaky")'] }, ['skipped-tests']],
    ['removed assertEquals', { path: 'src/test/java/com/acme/OrderServiceTest.java', removed: ['assertEquals(3, total);'] }, ['weakened-test']],
  ]);
});

describe('java: db-migration and schema', () => {
  table([
    ['flyway SQL', { path: 'src/main/resources/db/migration/V12__add_orders.sql', added: ['CREATE TABLE orders (id bigint);'] }, ['db-migration'], ['db-schema']],
    ['flyway repeatable', { path: 'src/main/resources/db/migration/R__views.sql' }, ['db-migration']],
    ['flyway java migration', { path: 'src/main/java/db/migration/V3__Backfill.java' }, ['db-migration']],
    ['liquibase changelog dir', { path: 'src/main/resources/db/changelog/2024/001-orders.xml' }, ['db-migration']],
    ['liquibase master', { path: 'src/main/resources/db.changelog-master.yaml' }, ['db-migration']],
    ['ALTER in migration', { path: 'src/main/resources/db/migration/V13__x.sql', added: ['ALTER TABLE orders DROP COLUMN note;'] }, ['db-migration', 'db-schema']],
    ['RENAME TABLE', { path: 'src/main/resources/db/migration/V14__x.sql', added: ['RENAME TABLE a TO b;'] }, ['db-schema']],
    ['liquibase dropColumn xml', { path: 'src/main/resources/db/changelog/x.xml', added: ['<dropColumn tableName="orders" columnName="note"/>'] }, ['db-schema']],
    ['liquibase dropTable yaml', { path: 'src/main/resources/db/changelog/x.yaml', added: ['      - dropTable:', '          tableName: legacy'] }, ['db-schema']],
    ['CHANGELOG.md is not a migration', { path: 'CHANGELOG.md' }, [], ['db-migration']],
    ['plain service is not a migration', { path: SVC }, [], ['db-migration', 'db-schema']],
  ]);
});

describe('java: jpa-entity', () => {
  table([
    ['new @Column field', { path: 'src/main/java/com/acme/Order.java', added: ['    @Column(name = "note")', '    private String note;'] }, ['jpa-entity'], ['jpa-entity-schema']],
    ['@Column removed', { path: 'src/main/java/com/acme/Order.java', removed: ['    @Column(name = "note")', '    private String note;'] }, ['jpa-entity', 'jpa-entity-schema']],
    ['nullable changed', { path: 'src/main/java/com/acme/Order.java', removed: ['    @Column(name = "note", nullable = true)'], added: ['    @Column(name = "note", nullable = false)'] }, ['jpa-entity-schema']],
    ['length changed', { path: 'src/main/java/com/acme/Order.java', removed: ['    @Column(length = 100)'], added: ['    @Column(length = 50)'] }, ['jpa-entity-schema']],
    ['new non-null column', { path: 'src/main/java/com/acme/Order.java', added: ['    @Column(nullable = false, unique = true)'] }, ['jpa-entity-schema']],
    ['relationship removed', { path: 'src/main/java/com/acme/Order.java', removed: ['    @OneToMany(mappedBy = "order")'] }, ['jpa-entity-schema']],
    ['@Entity added', { path: 'src/main/java/com/acme/Order.java', added: ['@Entity', '@Table(name = "orders")'] }, ['jpa-entity'], ['jpa-entity-schema']],
    ['ordinary service method', { path: SVC, added: ['    return repo.findAll();'] }, [], ['jpa-entity', 'jpa-entity-schema']],
    ['entity test ignored', { path: 'src/test/java/com/acme/OrderTest.java', added: ['@Entity'] }, [], ['jpa-entity']],
  ]);
  it('mustReview only for destructive/constraint changes', () => {
    expect(run({ path: 'src/main/java/com/acme/Order.java', added: ['@Column(name = "x")'] }).must).toBe(false);
    expect(run({ path: 'src/main/java/com/acme/Order.java', removed: ['@Column(name = "x")'] }).must).toBe(true);
  });
});

describe('java: spring-security', () => {
  table([
    ['filter chain bean', { path: 'src/main/java/com/acme/Cfg.java', added: ['    public SecurityFilterChain chain(HttpSecurity http) throws Exception {'] }, ['spring-security']],
    ['anyRequest', { path: 'src/main/java/com/acme/Cfg.java', added: ['        .anyRequest().authenticated()'] }, ['spring-security']],
    ['permitAll', { path: 'src/main/java/com/acme/Cfg.java', added: ['        .requestMatchers("/api/**").permitAll()'] }, ['spring-security', 'spring-security-open']],
    ['csrf disable classic', { path: 'src/main/java/com/acme/Cfg.java', added: ['    http.csrf().disable()'] }, ['spring-security-open']],
    ['csrf disable lambda', { path: 'src/main/java/com/acme/Cfg.java', added: ['    http.csrf(csrf -> csrf.disable())'] }, ['spring-security-open']],
    ['csrf disable method ref', { path: 'src/main/java/com/acme/Cfg.java', added: ['    http.csrf(AbstractHttpConfigurer::disable)'] }, ['spring-security-open']],
    ['cors star', { path: 'src/main/java/com/acme/Cfg.java', added: ['    registry.addMapping("/**").allowedOrigins("*");'] }, ['spring-security-open']],
    ['cors explicit origin is fine', { path: 'src/main/java/com/acme/Cfg.java', added: ['    registry.addMapping("/**").allowedOrigins("https://app.acme.com");'] }, [], ['spring-security-open']],
    ['bare @CrossOrigin', { path: 'src/main/java/com/acme/Ctl.java', added: ['@CrossOrigin'] }, ['spring-security-open']],
    ['@PreAuthorize removed', { path: 'src/main/java/com/acme/Ctl.java', removed: ['    @PreAuthorize("hasRole(\'ADMIN\')")'] }, ['spring-security-annotation-removed']],
    ['@PreAuthorize changed', { path: 'src/main/java/com/acme/Ctl.java', removed: ['    @PreAuthorize("hasRole(\'ADMIN\')")'], added: ['    @PreAuthorize("hasRole(\'USER\')")'] }, ['spring-security-annotation-removed', 'spring-security-annotation']],
    ['@Secured added', { path: 'src/main/java/com/acme/Ctl.java', added: ['    @Secured("ROLE_ADMIN")'] }, ['spring-security-annotation'], ['spring-security-annotation-removed']],
    ['@RolesAllowed removed', { path: 'src/main/java/com/acme/Ctl.java', removed: ['    @RolesAllowed("admin")'] }, ['spring-security-annotation-removed']],
    ['plain controller', { path: 'src/main/java/com/acme/Ctl.java', added: ['    return ResponseEntity.ok(x);'] }, [], ['spring-security', 'spring-security-open', 'spring-security-annotation']],
    ['test config ignored', { path: 'src/test/java/com/acme/Cfg.java', added: ['http.csrf().disable()'] }, [], ['spring-security-open']],
  ]);
  it('severity and mustReview', () => {
    const removed = run({ path: 'src/main/java/com/acme/Ctl.java', removed: ['@PreAuthorize("x")'] });
    expect(removed.level).toBe('high');
    expect(removed.must).toBe(true);
    const added = run({ path: 'src/main/java/com/acme/Ctl.java', added: ['@PreAuthorize("x")'] });
    expect(added.level).toBe('med');
    expect(added.must).toBe(false);
  });
});

describe('java: transactional, native queries, jobs, errors', () => {
  table([
    ['@Transactional added', { path: SVC, added: ['    @Transactional'] }, ['transactional']],
    ['@Transactional removed', { path: SVC, removed: ['    @Transactional'] }, ['transactional']],
    ['propagation changed', { path: SVC, removed: ['    @Transactional'], added: ['    @Transactional(propagation = Propagation.REQUIRES_NEW)'] }, ['transactional']],
    ['readOnly changed', { path: SVC, added: ['    @Transactional(readOnly = true)'] }, ['transactional']],
    ['Transactional import only', { path: SVC, added: ['import org.springframework.transaction.annotation.Transactional;'] }, [], ['transactional']],
    ['nativeQuery', { path: 'src/main/java/com/acme/OrderRepo.java', added: ['    @Query(value = "select * from orders", nativeQuery = true)'] }, ['native-query'], ['native-query-concat']],
    ['jpql query is fine', { path: 'src/main/java/com/acme/OrderRepo.java', added: ['    @Query("select o from Order o where o.id = :id")'] }, [], ['native-query', 'native-query-concat']],
    ['JdbcTemplate', { path: SVC, added: ['    private final JdbcTemplate jdbc;'] }, ['native-query']],
    ['concatenated SQL', { path: SVC, added: ['    String sql = "select * from users where name = \'" + name + "\'";'] }, ['native-query-concat']],
    ['concatenated JPQL', { path: SVC, added: ['    em.createQuery("from User u where u.name = \'" + name + "\'")'] }, ['native-query-concat']],
    ['String.format SQL', { path: SVC, added: ['    String sql = String.format("delete from t where id = %s", id);'] }, ['native-query-concat']],
    ['bind parameters are fine', { path: SVC, added: ['    jdbc.query("select * from users where name = ?", mapper, name);'] }, [], ['native-query-concat']],
    ['log message concat is fine', { path: SVC, added: ['    log.info("Loaded order " + id + " for user");'] }, [], ['native-query-concat']],
    ['@Scheduled', { path: SVC, added: ['    @Scheduled(cron = "0 0 * * * *")'] }, ['scheduled-jobs']],
    ['@KafkaListener', { path: SVC, added: ['    @KafkaListener(topics = "orders")'] }, ['scheduled-jobs']],
    ['@EventListener', { path: SVC, removed: ['    @EventListener'] }, ['scheduled-jobs']],
    ['@Async', { path: SVC, added: ['    @Async'] }, ['scheduled-jobs']],
    ['empty catch', { path: SVC, added: ['        } catch (IOException e) {', '        }'] }, ['error-swallow']],
    ['empty catch with comment', { path: SVC, added: ['        } catch (Exception e) {', '            // ignore', '        }'] }, ['error-swallow']],
    ['log-only catch', { path: SVC, added: ['        } catch (Exception e) {', '            log.error("failed", e);', '        }'] }, ['error-swallow']],
    ['printStackTrace catch', { path: SVC, added: ['        } catch (Exception e) {', '            e.printStackTrace();', '        }'] }, ['error-swallow']],
    ['catch that rethrows is fine', { path: SVC, added: ['        } catch (IOException e) {', '            log.error("failed", e);', '            throw new UncheckedIOException(e);', '        }'] }, [], ['error-swallow']],
    ['throws Exception', { path: SVC, added: ['    public void run() throws Exception {'] }, ['java-throws-broad']],
    ['throws specific', { path: SVC, added: ['    public void run() throws IOException {'] }, [], ['java-throws-broad']],
    ['test catch ignored', { path: 'src/test/java/com/acme/XTest.java', added: ['} catch (Exception e) {', '}'] }, [], ['error-swallow']],
  ]);
  it('mustReview matrix', () => {
    expect(run({ path: SVC, added: ['@Transactional'] }).must).toBe(true);
    expect(run({ path: SVC, added: ['@Scheduled(fixedRate = 1000)'] }).must).toBe(false);
    expect(run({ path: SVC, added: ['private JdbcTemplate j;'] }).must).toBe(false);
    expect(run({ path: SVC, added: ['String s = "select * from t where a = " + a;'] }).must).toBe(true);
    expect(run({ path: SVC, added: ['void f() throws Exception {'] }).must).toBe(false);
  });
});

describe('spring config files', () => {
  table([
    ['ddl-auto update (yaml)', { path: CFG, added: ['      ddl-auto: update'] }, ['spring-config-ddl']],
    ['ddl-auto create-drop (properties)', { path: 'src/main/resources/application.properties', added: ['spring.jpa.hibernate.ddl-auto=create-drop'] }, ['spring-config-ddl']],
    ['ddl-auto validate is fine', { path: CFG, added: ['      ddl-auto: validate'] }, [], ['spring-config-ddl']],
    ['ddl-auto none is fine', { path: CFG, added: ['      ddl-auto: none'] }, [], ['spring-config-ddl']],
    ['literal password', { path: CFG, added: ['    password: hunter2hunter2'] }, ['spring-config-secret']],
    ['literal secret (properties)', { path: 'src/main/resources/application-dev.properties', added: ['jwt.secret=abc123'] }, ['spring-config-secret']],
    ['env placeholder password', { path: CFG, added: ['    password: ${DB_PASSWORD}'] }, [], ['spring-config-secret']],
    ['placeholder with default', { path: CFG, added: ['    password: ${DB_PASSWORD:changeme}'] }, [], ['spring-config-secret']],
    ['empty password', { path: 'src/main/resources/application.properties', added: ['spring.datasource.password='] }, [], ['spring-config-secret']],
    ['token validity is not a secret', { path: CFG, added: ['  token-validity-seconds: 3600'] }, [], ['spring-config-secret']],
    ['datasource url', { path: CFG, added: ['    url: jdbc:postgresql://prod-db:5432/shop'] }, ['spring-config-datasource']],
    ['spring.datasource props', { path: 'src/main/resources/application.properties', added: ['spring.datasource.hikari.maximum-pool-size=50'] }, ['spring-config-datasource']],
    ['actuator wildcard', { path: 'src/main/resources/application.properties', added: ['management.endpoints.web.exposure.include=*'] }, ['spring-config-actuator-open', 'spring-config-actuator']],
    ['actuator env yaml', { path: CFG, added: ['        include: health,info,env'] }, ['spring-config-actuator-open']],
    ['actuator health,info', { path: 'src/main/resources/application.properties', added: ['management.endpoints.web.exposure.include=health,info'] }, ['spring-config-actuator'], ['spring-config-actuator-open']],
    ['server ssl', { path: 'src/main/resources/application.properties', added: ['server.ssl.enabled=false'] }, ['spring-config-tls']],
    ['profile activation', { path: 'src/main/resources/application.properties', added: ['spring.profiles.active=prod'] }, ['spring-config-profile']],
    ['prod profile file', { path: 'src/main/resources/application-prod.yml', added: ['logging.level.root: INFO'] }, ['spring-config-prod']],
    ['unrelated config line', { path: CFG, added: ['server.port: 8081'] }, [], ['spring-config-ddl', 'spring-config-secret', 'spring-config-datasource', 'spring-config-actuator', 'spring-config-tls', 'spring-config-profile']],
    ['test config ignored', { path: 'src/test/resources/application.yml', added: ['ddl-auto: create'] }, [], ['spring-config-ddl']],
    ['non-config yaml ignored', { path: 'deploy/values.yaml', added: ['ddl-auto: update'] }, [], ['spring-config-ddl']],
  ]);
  it('ddl-auto and literal secrets are high + mustReview', () => {
    const r = run({ path: CFG, added: ['ddl-auto: update'] });
    expect(r.level).toBe('high');
    expect(r.must).toBe(true);
    expect(r.reasons[0]!.message).toMatch(/ddl-auto/);
  });
});

describe('java: deps-manifest (pom.xml, Gradle)', () => {
  const deps = (spec: Spec) => run(spec).reasons.find((r) => r.ruleId === 'deps-manifest');
  it('new runtime Maven dependency is med and merged into one reason', () => {
    const r = deps({
      path: 'pom.xml',
      body: [
        ' <dependencies>',
        '+        <dependency>',
        '+            <groupId>org.apache.commons</groupId>',
        '+            <artifactId>commons-lang3</artifactId>',
        '+            <version>3.14.0</version>',
        '+        </dependency>',
        '+        <dependency>',
        '+            <groupId>com.google.guava</groupId>',
        '+            <artifactId>guava</artifactId>',
        '+            <version>33.0.0-jre</version>',
        '+        </dependency>',
        ' </dependencies>',
      ],
    })!;
    expect(r.level).toBe('med');
    expect(r.message).toContain('Adds 2 dependencies');
    expect(r.message).toContain('commons-lang3');
    expect(r.message).toContain('guava');
  });
  it('Maven version bump is low', () => {
    const r = deps({
      path: 'pom.xml',
      body: [
        '         <groupId>org.apache.commons</groupId>',
        '         <artifactId>commons-lang3</artifactId>',
        '-        <version>3.13.0</version>',
        '+        <version>3.14.0</version>',
        '     </dependency>',
      ],
    })!;
    expect(r.level).toBe('low');
    expect(r.message).toContain('Changes 1 dependency: commons-lang3');
  });
  it('test-scoped Maven dependency is low', () => {
    const r = deps({
      path: 'module/pom.xml',
      body: [
        '+        <dependency>',
        '+            <groupId>org.mockito</groupId>',
        '+            <artifactId>mockito-core</artifactId>',
        '+            <scope>test</scope>',
        '+        </dependency>',
      ],
    })!;
    expect(r.level).toBe('low');
  });
  it('Spring Boot parent bump is med with a specific message', () => {
    const r = deps({
      path: 'pom.xml',
      body: [
        '     <parent>',
        '         <groupId>org.springframework.boot</groupId>',
        '         <artifactId>spring-boot-starter-parent</artifactId>',
        '-        <version>3.1.5</version>',
        '+        <version>3.2.0</version>',
        '     </parent>',
      ],
    })!;
    expect(r.level).toBe('med');
    expect(r.message).toContain('Spring Boot version 3.1.5 -> 3.2.0');
  });
  it('unrelated pom edits (plugin config, project version) do not fire', () => {
    expect(deps({ path: 'pom.xml', body: ['-    <version>1.0.0-SNAPSHOT</version>', '+    <version>1.0.1-SNAPSHOT</version>'] })).toBeUndefined();
    expect(deps({
      path: 'pom.xml',
      body: [
        '         <artifactId>maven-compiler-plugin</artifactId>',
        '-        <version>3.10.0</version>',
        '+        <version>3.11.0</version>',
      ],
    })).toBeUndefined();
  });
  it('Gradle: new implementation is med, bump is low, test is low', () => {
    const add = deps({ path: 'build.gradle.kts', added: ['    implementation("org.flywaydb:flyway-core:10.4.1")', '    runtimeOnly("org.postgresql:postgresql")'] })!;
    expect(add.level).toBe('med');
    expect(add.message).toContain('Adds 2 dependencies: flyway-core, postgresql');
    const bump = deps({
      path: 'build.gradle', removed: ["    implementation 'org.flywaydb:flyway-core:10.4.0'"], added: ["    implementation 'org.flywaydb:flyway-core:10.4.1'"],
    })!;
    expect(bump.level).toBe('low');
    const test = deps({ path: 'build.gradle.kts', added: ['    testImplementation("org.mockito:mockito-core:5.8.0")'] })!;
    expect(test.level).toBe('low');
  });
  it('Gradle: Spring Boot plugin bump is med', () => {
    const r = deps({
      path: 'build.gradle.kts',
      removed: ['    id("org.springframework.boot") version "3.1.5"'], added: ['    id("org.springframework.boot") version "3.2.0"'],
    })!;
    expect(r.level).toBe('med');
    expect(r.message).toContain('3.1.5 -> 3.2.0');
  });
  it('Gradle: non-dependency lines do not fire', () => {
    expect(deps({ path: 'build.gradle.kts', added: ['    sourceCompatibility = JavaVersion.VERSION_21', 'tasks.test { useJUnitPlatform() }'] })).toBeUndefined();
  });
});
