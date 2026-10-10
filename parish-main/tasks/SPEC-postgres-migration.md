# Spec: MSSQL → PostgreSQL Migration (Supabase + Vercel + Render)

## Objective

Migrate the Parish web app's backend from Microsoft SQL Server (`mssql` npm package)
to PostgreSQL (`pg` / node-postgres), so the system can be tested end-to-end on:

- **Supabase** — PostgreSQL database host
- **Vercel** — React/Vite frontend host
- **Render** — Express API host (Node.js)

This is a test deployment, not a production cutover. No existing MSSQL data needs
to be migrated — a fresh Supabase database will be seeded from the converted migrations.

Success: the app boots, connects to Supabase, and all existing API endpoints work
identically to their MSSQL counterparts.

## Tech Stack

- Node.js + Express (`server.js`) — backend
- React + Vite (`src/`) — frontend
- `pg` (node-postgres) replacing `mssql`
- Supabase (managed PostgreSQL)
- Vercel (static frontend)
- Render (persistent Node.js server)

## Commands

```
Dev server:   node server.js          (in parishweb/)
Frontend:     npm run dev             (Vite, port 5173)
Build:        npm run build
Test:         npm run test:run
Lint:         npm run lint
```

## Project Structure

```
parishweb/
  server.js              ← backend: all db calls live here
  server-rules.js        ← pure logic, no db — untouched
  password-hash.js       ← pure crypto — untouched
  migrations/            ← SQL files to rewrite for PostgreSQL
    001_*.sql … 024_*.sql
  .env                   ← local only, never committed
  package.json
src/                     ← React frontend — untouched
tasks/
  SPEC-postgres-migration.md   ← this file
  plan-postgres-migration.md
  todo-postgres-migration.md
```

## Code Style

Follow what `server.js` already does. Keep the pool/request pattern but replace
MSSQL-flavoured calls with `pg` equivalents:

```js
// BEFORE (mssql)
const result = await pool.request()
  .input('id', sql.Int, id)
  .query('SELECT * FROM dbo.Users WHERE UserId = @id');
const row = result.recordset[0];

// AFTER (pg)
const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);
const row = result.rows[0];
```

- No ORM, no query builder — raw `pg` only (matches existing pattern)
- Keep all existing error handling, logging, and auth logic unchanged
- Table names: keep `dbo.` prefix removed, use lowercase snake_case schema
- Parameter style: `$1`, `$2` … (PostgreSQL positional params)

## MSSQL → PostgreSQL Syntax Cheat Sheet

| MSSQL | PostgreSQL |
|---|---|
| `IDENTITY(1,1)` | `SERIAL` or `GENERATED ALWAYS AS IDENTITY` |
| `NVARCHAR(n)` / `NVARCHAR(MAX)` | `TEXT` or `VARCHAR(n)` |
| `DATETIME2` | `TIMESTAMPTZ` |
| `BIT` | `BOOLEAN` |
| `GETDATE()` / `GETUTCDATE()` | `NOW()` |
| `SYSUTCDATETIME()` | `NOW() AT TIME ZONE 'UTC'` or `NOW()` |
| `dbo.TableName` | `public.table_name` (or just `table_name`) |
| `IF OBJECT_ID(...) IS NULL` | `CREATE TABLE IF NOT EXISTS` |
| `IF COL_LENGTH(...) IS NULL` | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` |
| `MERGE ... USING ...` | `INSERT ... ON CONFLICT DO UPDATE` |
| `OUTPUT INSERTED.Id` | `RETURNING id` |
| `DECLARE @t TABLE (...)` | CTE or temp table |
| `TOP 1` | `LIMIT 1` |
| `CONVERT(varchar(10), col, 23)` | `col::date::text` or `TO_CHAR(col, 'YYYY-MM-DD')` |
| `PRINT '...'` | `RAISE NOTICE '...'` or omit |
| Filtered index `WHERE Used = 0` | `CREATE INDEX ... WHERE used = false` |
| `CREATE INDEX CONCURRENTLY` | same (Postgres-native) |
| `sql.VarChar`, `sql.Int`, etc. | removed — pg uses positional `$n` |

## Testing Strategy

- Framework: Vitest (already configured)
- Existing tests in `src/*.test.ts` cover server-rules and password-hash (pure logic) — these pass unchanged
- `src/server.test.ts` may need pool mock updated from `mssql` to `pg`
- Verify: `npm run test:run` passes after migration
- Manual smoke test: start server, hit `/api/services`, `/api/events`, `/api/health` via curl or browser

## Boundaries

- **Always:** keep `.env` out of git; keep all validation and auth logic intact; run `npm run test:run` after each task
- **Ask first:** schema naming changes beyond `dbo.` removal; adding new npm packages beyond `pg`; changing any API response shape
- **Never:** commit real Supabase credentials; change `server-rules.js` or `password-hash.js`; break existing API contracts

## Success Criteria

- [ ] `npm install` succeeds with `pg` instead of `mssql` + `msnodesqlv8`
- [ ] Server starts and connects to Supabase without error
- [ ] All 24 migrations apply cleanly to a fresh Supabase database
- [ ] `GET /api/services` returns `[]` or seeded data (not a 500)
- [ ] `GET /api/events` returns `[]` or seeded data
- [ ] `GET /api/health` returns `{ status: 'healthy' }`
- [ ] Auth flow: admin login returns a token, protected routes enforce it
- [ ] `npm run test:run` passes
- [ ] Vercel preview loads and hits the Render API (not localhost)
- [ ] CORS allows only the Vercel origin

## Open Questions

1. Supabase project already created, or do you need steps to create one?
2. Render service already created, or needs setup steps in the plan?
3. Table/schema naming: keep `PascalCase` table names as-is (just drop `dbo.`), or convert to `snake_case`?
4. The `.env` has a real Resend API key committed — rotate it before deploying?
5. Uploads: local disk on Render (disposable test) or skip upload endpoints for now?
