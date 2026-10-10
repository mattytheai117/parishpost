-- User and role management audit trail.
-- Converted from MSSQL migration 005.
-- AspNetUsers and AspNetRoles tables are created here (ASP.NET Identity base schema).

CREATE TABLE IF NOT EXISTS "AspNetRoles" (
    "RoleId"  SERIAL NOT NULL CONSTRAINT "PK_AspNetRoles" PRIMARY KEY,
    "Name"    TEXT   NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_AspNetRoles_Name" ON "AspNetRoles" ("Name");

CREATE TABLE IF NOT EXISTS "AspNetUsers" (
    "UserId"          SERIAL      NOT NULL CONSTRAINT "PK_AspNetUsers" PRIMARY KEY,
    "EmailAddress"    TEXT        NOT NULL,
    "PasswordHash"    TEXT        NULL,
    "CreatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_AspNetUsers_Email" ON "AspNetUsers" ("EmailAddress");

CREATE TABLE IF NOT EXISTS "AspNetUserRoles" (
    "UserId"   INT NOT NULL REFERENCES "AspNetUsers" ("UserId") ON DELETE CASCADE,
    "RoleId"   INT NOT NULL REFERENCES "AspNetRoles" ("RoleId") ON DELETE CASCADE,
    CONSTRAINT "PK_AspNetUserRoles" PRIMARY KEY ("UserId", "RoleId")
);

CREATE TABLE IF NOT EXISTS "UserManagementAudit" (
    "AuditId"         SERIAL      NOT NULL CONSTRAINT "PK_UserManagementAudit" PRIMARY KEY,
    "ActionName"      VARCHAR(40) NOT NULL,
    "TargetUserId"    INT         NULL,
    "TargetUserName"  TEXT        NULL,
    "ChangedBy"       TEXT        NOT NULL,
    "ChangedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Details"         TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_UserManagementAudit_ChangedAt"
    ON "UserManagementAudit" ("ChangedAt" DESC);
CREATE INDEX IF NOT EXISTS "IX_UserManagementAudit_TargetUser"
    ON "UserManagementAudit" ("TargetUserId", "ChangedAt" DESC);
