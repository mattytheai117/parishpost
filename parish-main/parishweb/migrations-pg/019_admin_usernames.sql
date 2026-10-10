-- Store admin account usernames separately from email addresses.
-- Converted from MSSQL migration 019.
-- Note: sys.sp_executesql blocks converted to plain SQL.

ALTER TABLE "AspNetUsers" ADD COLUMN IF NOT EXISTS "UserName" TEXT NULL;

-- Backfill: use email prefix or user-{id} for any missing username
UPDATE "AspNetUsers"
SET "UserName" = COALESCE(
    NULLIF(TRIM("EmailAddress"), ''),
    'user-' || "UserId"::text
)
WHERE "UserName" IS NULL OR TRIM("UserName") = '';

-- Make non-nullable now that all rows are populated
ALTER TABLE "AspNetUsers" ALTER COLUMN "UserName" SET NOT NULL;
