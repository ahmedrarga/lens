# @lens/risk

Deterministic risk scoring for a `ChangeGraph`. `applyRisk(graph, policy, ctx)` returns a new graph with `node.risk` on every
symbol/file/group node, bubbled up to clusters and modules (max level, any mustReview, `inheritedFrom` capped at 20 ids), plus
`graph.policy`. Ghost (unchanged) nodes get no risk. Hard rules only: a model may escalate risk later but never lower it.

## Rule semantics

A rule fires on a node when ALL of these hold:

1. `fileStatus` (if set) contains the file's status.
2. Location (if `paths` or `symbols` is set): the node path matches a `paths` glob (and no `!` glob), OR the symbol's qualified
   name matches a `symbols` regex (case-insensitive).
3. `content` (if set): some regex matches the added and/or removed lines of the node's hunks (hunks it owns, plus hunks
   overlapping a symbol's range). Hunk ids that matched go in the reason.

Globs are picomatch (dotfiles included). A glob starting with `!` excludes. Content patterns may start with `added:`,
`removed:` or `net-removed:` (more matches in removed than added lines of the same hunk, e.g. dropped assertions), and
`(?i)` for case-insensitive.

Collapsed noise groups are evaluated per file: path/symbol/status rules always, content rules only when the group is not
`verified`. If a group trips a high or must-review rule it also gets `collapsed-risky`.

## `.lens/policy.yml`

Read from the PR's BASE commit, so a PR cannot weaken its own review.

```yaml
extends: default            # default | none   (default: default)
rules:                      # same id as a default rule replaces it
  - id: ledger
    description: Touches the ledger core      # shown in the reason
    level: high             # low | med | high | blocker
    mustReview: true        # default false
    match:                  # at least one key
      paths: ["svc/ledger/**", "!**/*.test.ts"]
      symbols: ["^Ledger\\."]          # regex on qualified names
      content: ["added:\\.raw\\("]     # regex on hunk lines
      fileStatus: [added, modified, removed, renamed]
disable: [deps-manifest]    # default rule ids to turn off
neverCollapse: ["gen/auth/**"]   # never collapse matching hunks as noise
```

Invalid policy (bad YAML, unknown keys, bad level/regex/glob, unknown disable id) falls back to the default policy and
reports readable `errors` (also on `graph.policy.errors`). `lens-policy` (any change under `.lens/**`) is always
blocker + mustReview; it cannot be disabled or overridden, and `.lens/**` is always in `neverCollapse`.

## Default rules

auth, auth-guard-removed, permissions, secrets, hardcoded-secret, crypto, crypto-api, payments, db-migration, db-schema,
sql-raw, data-delete, infra, ci, deps-manifest, env-config, env-read, deleted-tests, skipped-tests, weakened-test,
error-swallow, security-headers, unsafe-eval, deletion, lens-policy. See `src/rules.ts`.

Spring/Java rules (each message states why): jpa-entity, jpa-entity-schema (must-review on removed/changed column or
nullable/unique/length), spring-security, spring-security-open (permitAll, csrf disable, wildcard CORS),
spring-security-annotation(-removed), transactional, native-query, native-query-concat, spring-config-{ddl,secret,
actuator-open,actuator,tls,datasource,profile,prod}, scheduled-jobs, java-throws-broad. `db-migration`/`db-schema` also
cover Flyway/Liquibase, `error-swallow` covers Java catch blocks, `deps-manifest` reads pom.xml and build.gradle(.kts)
(new runtime dependency = med, version bump = low, Spring Boot parent/plugin bump = med).
