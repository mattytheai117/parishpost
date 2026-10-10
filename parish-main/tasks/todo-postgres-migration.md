# Task List: MSSQL → PostgreSQL Migration

## Phase 1: Safety

- [ ] Task 1: Rotate credentials + fix .gitignore
  - Acceptance: `.env` is in `.gitignore`; Resend API key is rotated (old key revoked in Resend dashboard); a `.env.example` with placeholder values exists
  - Verify: `git check-ignore -v parishweb/.env` returns a match; new key is different from the committed one
  - Files: `parishweb/.gitignore`, `parishweb/.env.example` (new)

- [ ] Task 2: Swap npm packages
  - Acceptance: `pg@8.13.1` in dependencies; `mssql` and `msnodesqlv8` removed from dependencies; `@types/pg` in devDependencies; `npm install` succeeds
  - Verify: `npm install` exits 0; `node -e "import('pg').then(() => console.log('ok'))"` passes
  - Files: `parishweb/package.json`

### Checkpoint: Phase 1
- [ ] `npm install` succeeds
- [ ] `.env` is gitignored
- [ ] `.env.example` exists with placeholder values
- [ ] Resend key rotated

---

## Phase 2: PostgreSQL Migrations

- [ ] Task 3: Write `migrations-pg/` (all 24 migrations)
  - Acceptance: All 24 files exist in `parishweb/migrations-pg/` with matching names; each file is valid PostgreSQL syntax; `IF OBJECT_ID` → `CREATE TABLE IF NOT EXISTS`; `IDENTITY` → `SERIAL`; `NVARCHAR`/`NVARCHAR(MAX)` → `TEXT`; `DATETIME2` → `TIMESTAMPTZ`; `BIT` → `BOOLEAN`; `dbo.` removed; `SYSUTCDATETIME()`/`GETDATE()` → `NOW()`; MSSQL triggers replaced by comments noting app-level `UpdatedAt`; `MERGE` → `INSERT … ON CONFLICT DO UPDATE`; `PRINT` → `-- note:` comments; filtered indexes use PostgreSQL `WHERE` syntax; `GO` statements removed
  - Verify: Connect to any local PostgreSQL or Supabase, run each file in order, all apply without error
  - Files: `parishweb/migrations-pg/001_staff_mass_schedule.sql` … `024_blocked_slots.sql` (24 new files)

### Checkpoint: Phase 2
- [ ] All 24 migrations apply to a fresh database in order with no errors
- [ ] `\dt` (or Supabase table editor) shows all expected tables

---

## Phase 3: Server Rewrite

- [ ] Task 4: Rewrite `server.js` database layer for `pg`
  - Acceptance:
    - `import sql from 'mssql'` removed; `import pg from 'pg'` added
    - `initializePool` uses `new pg.Pool({ connectionString })` from `DATABASE_URL` env var
    - `pool.request().input(...).query(...)` → `pool.query(sql, [params])`
    - All `@paramName` → `$1`, `$2`, … with matching values arrays
    - `result.recordset` → `result.rows`
    - `sql.Int`, `sql.VarChar`, `sql.NVarChar`, `sql.Date`, `sql.Decimal`, `sql.Bit`, `sql.DateTime2`, `sql.MAX` references removed
    - `OUTPUT INSERTED.X` → `RETURNING "X"`
    - `MERGE … USING` (finance snapshot) → `INSERT … ON CONFLICT DO UPDATE … RETURNING`
    - `DECLARE @t TABLE` workaround (ServiceRequest trigger) → standard `INSERT … RETURNING`
    - `SYSUTCDATETIME()` / `GETUTCDATE()` / `GETDATE()` → `NOW()`
    - `dbo.TableName` → `"TableName"` (double-quoted PascalCase, no schema prefix)
    - `TOP 1` → `LIMIT 1`
    - `CONVERT(varchar(10), col, 23)` → `col::date`
    - `BIT` comparisons (`=== 1`, `=== 0`) → boolean checks where needed
    - `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DB_AUTH`, `DB_DOMAIN`, `DB_TRUST_SERVER_CERTIFICATE` env vars replaced by single `DATABASE_URL`
    - `npm run test:run` passes
  - Verify: `node server.js` starts; `curl localhost:5000/api/health` → 200; `curl localhost:5000/api/services` → 200; `npm run test:run` passes
  - Files: `parishweb/server.js`, `parishweb/.env` (update DB vars → `DATABASE_URL`)

### Checkpoint: Phase 3
- [ ] `npm run test:run` passes
- [ ] Server starts against Supabase connection string without error
- [ ] `/api/health`, `/api/services`, `/api/events` return 200

---

## Phase 4: Deploy

- [ ] Task 5: Create Supabase project and apply migrations
  - Acceptance: Supabase project created; `DATABASE_URL` (connection string, transaction pooler mode) noted; all 24 `migrations-pg/` files applied in order via Supabase SQL editor or `psql`; tables visible in Supabase table editor
  - Steps:
    1. Go to supabase.com → New project → choose region closest to you → note the password
    2. Settings → Database → Connection string → **Transaction pooler** → copy the URI
    3. Replace `[YOUR-PASSWORD]` in the URI with your project password
    4. Open SQL editor → paste and run each `migrations-pg/` file in order (001 → 024)
    5. Confirm tables appear in Table Editor
  - Verify: Supabase table editor shows `ServiceRequest`, `Parishioners`, `AspNetUsers`, etc.
  - Files: none (cloud setup)

- [ ] Task 6: Create Render service and configure env vars
  - Acceptance: Render Web Service created from the repo; environment variables set; service deploys and `/api/health` returns 200
  - Steps:
    1. render.com → New → Web Service → connect your GitHub repo
    2. Root directory: `parishweb`
    3. Build command: `npm install`
    4. Start command: `node server.js`
    5. Set environment variables:
       - `NODE_ENV=production`
       - `PORT=5000`
       - `DATABASE_URL=<supabase transaction pooler URI>`
       - `ADMIN_TOKEN=<a strong random string>`
       - `RESEND_API_KEY=<new rotated key>`
       - `FRONTEND_URL=<leave blank for now — fill in after Vercel deploy>`
       - `TRUST_PROXY_HOPS=1`
    6. Deploy → wait for build to complete
    7. Copy the Render service URL (e.g. `https://parish-api.onrender.com`)
  - Verify: `curl https://<render-url>/api/health` → `{"status":"healthy",...}`
  - Files: none (cloud setup)

- [ ] Task 7: Create Vercel project and configure env vars
  - Acceptance: Vercel project created; `VITE_API_URL` points to Render service; preview URL loads the app; API requests go to Render (not localhost)
  - Steps:
    1. vercel.com → Add New Project → import your GitHub repo
    2. Root directory: `parishweb`
    3. Build command: `npm run build` (Vercel detects this automatically)
    4. Output directory: `dist`
    5. Add environment variable: `VITE_API_URL=https://<render-url>` (no trailing slash)
    6. Deploy → copy the preview URL (e.g. `https://parish-abc123.vercel.app`)
    7. Go back to Render → update `FRONTEND_URL=https://parish-abc123.vercel.app`
    8. Redeploy Render service so CORS picks up the new origin
  - Verify: Open Vercel preview URL → browser DevTools Network tab → API requests go to Render URL; no CORS errors in console
  - Files: none (cloud setup)

### Checkpoint: Phase 4
- [ ] Vercel preview loads without console errors
- [ ] Network tab shows API calls to Render, not localhost
- [ ] CORS allows the Vercel origin
- [ ] Supabase shows data after a test action

---

## Phase 5: Smoke Test

- [ ] Task 8: End-to-end transaction smoke test
  - Acceptance: Each flow below completes without error and Supabase shows the resulting row
  - Test flows:
    1. **Public booking** — submit a service request; check `ServiceRequest` table in Supabase
    2. **Email verification** — click verification link from email; row status changes to `Confirmed`
    3. **Certificate request** — submit a certificate request; check `CertificateRequests` table
    4. **Admin login** — use `ADMIN_TOKEN` to authenticate; confirm token is accepted
    5. **Event create** — POST a new event via admin; check `Events` table
    6. **Portal register + login** — create a parishioner portal account; check `ParishionerAccounts`
    7. **Finance entry** — create a financial entry; check `FinancialEntries` table
    8. **Upload** — upload a photo via admin; confirm file is served at `/uploads/<filename>` (note: file is lost on next Render redeploy)
  - Verify: All flows return 2xx; Supabase table editor shows updated rows after each action; taking a break and returning shows data still present (Supabase persists it)
  - Files: none

### Checkpoint: Complete
- [ ] All 8 smoke test flows pass
- [ ] Data persists in Supabase after closing and reopening the browser
- [ ] No 500 errors in Render logs
- [ ] Ready for extended testing or handoff
