-- =============================================================
-- check_db.sql  –  database diagnostics
-- Run in psql, pgAdmin, or Supabase SQL Editor.
-- =============================================================

-- ── 1. Tables present ─────────────────────────────────────────
SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_type   = 'BASE TABLE'
ORDER  BY table_name;

-- ── 2. Roles ──────────────────────────────────────────────────
SELECT "RoleId", "Name" FROM "AspNetRoles" ORDER BY "Name";

-- ── 3. Users with their roles ─────────────────────────────────
SELECT
    u."UserId",
    u."UserName",
    u."EmailAddress",
    u."MustChangePassword",
    u."CreatedAt",
    COALESCE(string_agg(r."Name", ', ' ORDER BY r."Name"), '(no role)') AS "Roles"
FROM   "AspNetUsers"          u
LEFT   JOIN "AspNetUserRoles" ur ON ur."UserId" = u."UserId"
LEFT   JOIN "AspNetRoles"     r  ON r."RoleId"  = ur."RoleId"
GROUP  BY u."UserId", u."UserName", u."EmailAddress",
          u."MustChangePassword", u."CreatedAt"
ORDER  BY u."UserId";

-- ── 4. Password hash sanity check ─────────────────────────────
-- Valid hash: 68 chars, starts with 'AX' (0x01 header in base64)
SELECT
    u."EmailAddress",
    LENGTH(u."PasswordHash")   AS "HashLength",
    LEFT(u."PasswordHash", 2)  AS "HashPrefix",
    CASE
        WHEN LENGTH(u."PasswordHash") = 68
         AND LEFT(u."PasswordHash", 2) = 'AX'
        THEN 'OK'
        ELSE 'BAD FORMAT'
    END                        AS "HashStatus"
FROM   "AspNetUsers" u
WHERE  u."PasswordHash" IS NOT NULL;

-- ── 5. Users with NO role (will fail login) ───────────────────
SELECT u."UserId", u."UserName", u."EmailAddress"
FROM   "AspNetUsers" u
WHERE  NOT EXISTS (
    SELECT 1 FROM "AspNetUserRoles" ur WHERE ur."UserId" = u."UserId"
);

-- ── 6. AspNetUsers column list ────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'AspNetUsers'
ORDER  BY ordinal_position;
