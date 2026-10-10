-- =============================================================
-- seed_admin.sql  –  test admin user seed
-- Safe to run multiple times (all inserts are idempotent).
-- Credentials: admin@parish.local / Admin@123
-- =============================================================

-- ── 1. Seed all roles ─────────────────────────────────────────
INSERT INTO "AspNetRoles" ("Name")
VALUES
    ('Admin'),
    ('ParishPriest'),
    ('Secretary'),
    ('Bookkeeper'),
    ('Staff')
ON CONFLICT ("Name") DO NOTHING;

-- ── 2. Create admin user ──────────────────────────────────────
-- Hash of "Admin@123"
-- Format: 0x01 | 16-byte random salt | 32-byte PBKDF2-HMACSHA256 subkey (10 000 iters), base64
INSERT INTO "AspNetUsers" ("UserName", "EmailAddress", "PasswordHash", "CreatedAt", "UpdatedAt")
VALUES (
    'admin',
    'admin@parish.local',
    'AXm+vQnlNLtQXFh0SFQU2ZZu8uXLixyzQczw6+ufNMGe9nx7Lau3t/TX24dT8bq9Lw==',
    NOW(),
    NOW()
)
ON CONFLICT ("EmailAddress") DO NOTHING;

-- ── 3. Assign Admin role ───────────────────────────────────────
INSERT INTO "AspNetUserRoles" ("UserId", "RoleId")
SELECT u."UserId", r."RoleId"
FROM   "AspNetUsers"  u
CROSS  JOIN "AspNetRoles" r
WHERE  u."EmailAddress" = 'admin@parish.local'
  AND  r."Name"         = 'Admin'
ON CONFLICT DO NOTHING;

-- ── 4. Verify ─────────────────────────────────────────────────
SELECT
    u."UserId",
    u."UserName",
    u."EmailAddress",
    string_agg(r."Name", ', ' ORDER BY r."Name") AS "Roles"
FROM   "AspNetUsers"     u
JOIN   "AspNetUserRoles" ur ON ur."UserId" = u."UserId"
JOIN   "AspNetRoles"     r  ON r."RoleId"  = ur."RoleId"
WHERE  u."EmailAddress" = 'admin@parish.local'
GROUP  BY u."UserId", u."UserName", u."EmailAddress";
