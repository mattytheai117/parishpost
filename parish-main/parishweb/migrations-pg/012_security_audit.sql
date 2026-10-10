-- Security events audit log.
-- Converted from MSSQL migration 012.

CREATE TABLE IF NOT EXISTS "SecurityAuditLog" (
    "SecurityAuditId"  SERIAL      NOT NULL CONSTRAINT "PK_SecurityAuditLog" PRIMARY KEY,
    "EventType"        VARCHAR(40) NOT NULL,
    "ActorUserName"    TEXT        NOT NULL,
    "TargetUserName"   TEXT        NULL,
    "Reason"           TEXT        NULL,
    "ExpiresAt"        TIMESTAMPTZ NULL,
    "CreatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Details"          TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_SecurityAuditLog_CreatedAt"
    ON "SecurityAuditLog" ("CreatedAt" DESC);
