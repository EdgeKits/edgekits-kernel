# Changelog

All notable changes to `@edgekits/kernel` are recorded here. The package follows semantic versioning with the 0.x rule: until 1.0, a minor release (0.2.0) may contain breaking changes, and every breaking change is listed under its release with the migration it needs. A patch release (0.1.1) never breaks.

## 0.1.0 (2026-11-05)

The first public release: the kernel the EdgeKits SaaS Starter v1 is built on.

### Subpaths

The package root exports nothing. Everything is imported from one of nine subpaths:

- `/tenancy`: `TenantContext`, `resolveTenant()` (membership re-verified on every call), `tenantTable()` and `tenantReference()`, tenant-bound repositories (`ctx.db.repo(table)`), the dev-time query guard (`tenantGuardLogger`), and org claims (single-use, hashed tokens).
- `/policy`: the policy engine (`can()`, `entitled()`, `requirePermission()`, `requireEntitlement()`, `entitlementFlags()`), the entitlement resolver, the subscription, override and suspension tables, kernel trials, provider subscription writes, and the plan catalog with its prices and settings.
- `/events`: the `KernelEvent` vocabulary (billing, organization, lifecycle and admin events), `InboundEvent`, the `EventBus` port and the pure subscription reducer.
- `/ports`: the `BillingProvider` and `MailProvider` ports, billing capability manifests (`paddleCapabilities`) and price capability checks.
- `/admin`: the `AdminRpc` contract and `accessIdentity()`, the Cloudflare Access JWT middleware.
- `/config`: `defineSaaS()` (the typed blueprint), provider capability validation, and the typed env (`defineEnv()`, `composeEnv()`, `parseEnv()`, `checkEnv()`).
- `/hono`: `tenant()`, `requirePlan()`, `errors()`, `noStore()`, `sameOrigin()`, `securityHeaders()` and the denial and error logs.
- `/astro`: `KernelLocals` and `toLocals()`.
- `/eslint`: `tenantTables()`, the flat-config fragment with the tenant-table lint rules.

### Design decisions in this release

The decisions are recorded in the kit's design documents, by number:

- ADR-002a: the admin identity comes from the Access JWT.
- ADR-004: the tenant-table guarantee in three layers (tenant-bound repositories, the lint rule, the dev-time query guard).
- ADR-005: the active org lives in the session.
- ADR-006: per-org entitlement overrides go only through the admin table.
- ADR-007: billing events are applied by a Workflow.
- ADR-008: tenant tables are keyed per tenant, `(org_id, id)`.
- ADR-010: plans are data in the catalog tables, not code.
- ADR-012: the organization lifecycle is a Workflow per phase (its event vocabulary).

### Security

The kernel went through seven `security-scanner` reports during Phase 1 and a `security-audit` before this release. Every kernel finding of that chain is closed by code, except two: an `npm audit` note on the lockfile, carried to a later review, and one accepted design point in the admin contract. The pre-release audit left four unconfirmed leads, fixed in this release:

- `repo().findMany(where)` groups the caller's predicate before ANDing it with `org_id`, so a raw `sql` fragment with a top-level `OR` cannot read another org's rows.
- `accessIdentity()` refuses to start without a non-empty `aud` and `teamDomain` outside `mode: 'dev'`, and compares `iss` and `aud` itself after the signature check.
- `entitlementFlags()` answers like `entitled()` for a suspended org: every flag is false, and `flags.suspended` is true.
- `applySubscriptionEvents()` de-duplicates on each event's `sourceId`, so every event of one provider notification applies. Sibling events apply in a fixed order (terms, then status changes, then terminal statuses), whatever the array order.

### Packaging

- `drizzle-orm` is a peer dependency (`^0.45.4`), next to `hono` (`^4.13.13`) and the optional `eslint` (`^9 || ^10`), so the app and the kernel share one Drizzle. `zod` is the only dependency.
- Node 22 or later for the tooling (`/eslint` and the build). The runtime subpaths target Cloudflare Workers.
- Published with npm provenance from the repository's publish workflow.
