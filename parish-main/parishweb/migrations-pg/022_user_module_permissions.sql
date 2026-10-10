-- Per-account module permission overrides and forced password change flag.
-- Converted from MSSQL migration 022.

ALTER TABLE "AspNetUsers" ADD COLUMN IF NOT EXISTS "MustChangePassword" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS "UserModulePermissions" (
    "UserId"      INT         NOT NULL REFERENCES "AspNetUsers" ("UserId") ON DELETE CASCADE,
    "ModuleName"  TEXT        NOT NULL,
    "CanView"     BOOLEAN     NOT NULL DEFAULT FALSE,
    "CanEdit"     BOOLEAN     NOT NULL DEFAULT FALSE,
    "UpdatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedBy"   TEXT        NULL,
    CONSTRAINT "PK_UserModulePermissions" PRIMARY KEY ("UserId", "ModuleName")
);
