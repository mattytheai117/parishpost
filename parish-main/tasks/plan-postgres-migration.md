# Implementation Plan: MSSQL → PostgreSQL Migration

## Overview

Migrate the Express backend from `mssql` to `pg` (node-postgres) so the app runs
against Supabase (PostgreSQL). The frontend stays on Vercel unchanged. The API moves
to Render. Uploads stay on Render's local disk (ephemeral — files survive until
next redeploy, good enough for transaction testing). Supabase persists all DB state
between test sessions.

Target stack: **Supabase** (DB) + **Render** (API) + **Vercel** (frontend).

## Architecture Decisions

1. **`pg` over any ORM** — The codebase uses raw SQL throughout. Swapping the
   driver is the smallest change; introducing an ORM would rewrite every query.

2. **PascalCase table names kept** — Tables stay `ServiceRequest`, `AspNetUsers`,
   etc. Only the `dbo.` schema prefix is removed. Supabase/PostgreSQL is
   case-sensitive for quoted identifiers, so every table name in queries gets
   double-quoted: `"ServiceRequest"`.

3. **`pg.Pool` replaces `mssql.ConnectionPool`** — The existing pool/request
   pattern is preserved as closely as possible. `pool.query(sql, params)` replaces
   `pool.request().input(...).query(...)`.

4. **Positional params `$1…$n`** — All `@paramName` references in queries become
   `$1`, `$2`, etc. with a matching values array.

5. **`MERGE` → `INSERT … ON CONFLICT DO UPDATE`** — Used in the finance snapshot
   job. One query, no helper needed.

6. **`OUTPUT INSERTED.*` → `RETURNING`** — Every INSERT that returns the new ID
   gets a `RETURNING` clause instead.

7. **Triggers replaced by app-level `UpdatedAt`** — MSSQL triggers set `UpdatedAt`
   on records tables. In PostgreSQL these are replaced with explicit `UpdatedAt = NOW()`
   in every UPDATE query for those tables (simpler, no trigger DDL needed for a test).

8. **`migrations-pg/` folder alongside `migrations/`** — The original MSSQL
   migrations are untouched as documentation. New PostgreSQL versions live in
   `parishweb/migrations-pg/` with matching filenames.

9. **Resend API key rotation before deploy** — The `.env` file has a real key
   committed to git. It must be rotated before any public push or deploy.

## Dependency Graph

```
Task 1: Rotate credentials + .gitignore .env
    │
Task 2: Add pg, remove mssql/msnodesqlv8 from package.json
    │
Task 3: Rewrite migrations-pg/ (001–024, PostgreSQL syntax)
    │
Task 4: Rewrite server.js db layer (pool init, all queries)
    │
    ├── Task 5: Supabase project setup + run migrations-pg/
    │
    └── Task 6: Render service setup + env vars
            │
        Task 7: Vercel frontend setup + env vars
            │
        Task 8: End-to-end smoke test
```

Tasks 3 and 4 can be done in parallel. Task 5 needs Task 3. Task 6 needs Task 4.

## Task List

### Phase 1: Safety

- [ ] Task 1: Rotate the committed Resend API key and fix .gitignore
- [ ] Task 2: Swap npm packages (add pg, remove mssql + msnodesqlv8)

### Checkpoint: Phase 1
- [ ] `npm install` succeeds
- [ ] `.env` is gitignored and contains fresh credentials

### Phase 2: PostgreSQL migrations

- [ ] Task 3: Write all 24 migrations in `migrations-pg/` (PostgreSQL syntax)

### Checkpoint: Phase 2
- [ ] All migrations apply cleanly to a fresh local PostgreSQL or Supabase DB
- [ ] No syntax errors

### Phase 3: Server rewrite

- [ ] Task 4: Rewrite `server.js` database layer for `pg`

### Checkpoint: Phase 3
- [ ] `npm run test:run` passes
- [ ] `node server.js` starts without error against a local/Supabase DB
- [ ] `GET /api/health`, `/api/services`, `/api/events` return 200

### Phase 4: Deploy

- [ ] Task 5: Create Supabase project and apply `migrations-pg/`
- [ ] Task 6: Create Render service and configure env vars
- [ ] Task 7: Create Vercel project and configure env vars

### Checkpoint: Phase 4
- [ ] Vercel preview loads
- [ ] Frontend requests hit Render API (not localhost)
- [ ] CORS allows only the Vercel origin

### Phase 5: Smoke test

- [ ] Task 8: End-to-end transaction smoke test

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| PascalCase table names need quoting in PostgreSQL | High | Every table name in queries gets double-quoted: `"ServiceRequest"` |
| `MERGE` statement has no direct PG equivalent | Medium | Rewrite as `INSERT … ON CONFLICT DO UPDATE` |
| MSSQL triggers for `UpdatedAt` don't exist in PG | Low | Set `UpdatedAt = NOW()` explicitly in each UPDATE |
| Filtered indexes (`WHERE Used = 0`) need PG syntax | Low | PostgreSQL supports partial indexes with same `WHERE` clause |
| `BIT` → `BOOLEAN`: `0`/`1` vs `true`/`false` in JS | Medium | `pg` returns JS booleans automatically for `BOOLEAN` columns; update any `=== 1` checks |
| Resend key already committed to git history | High | Rotate key immediately, add `.env` to `.gitignore`, note git history still has old key |
| Render disk wipes on redeploy | Low | Accepted for test; document the limitation |
| `sql.MAX` → `TEXT` mapping | Low | Replace all `NVarChar(MAX)` with `TEXT` in migrations |

## Open Questions Resolved

- Uploads: kept working, ephemeral on Render (acceptable for test)
- Table naming: PascalCase preserved, `dbo.` removed, double-quoted in queries
- Migration folder: `migrations-pg/` alongside existing `migrations/`
- Supabase + Render: both need full setup steps (included in Tasks 5 and 6)
