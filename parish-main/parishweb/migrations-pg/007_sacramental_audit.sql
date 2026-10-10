-- Sacramental record audit history.
-- Converted from MSSQL migration 007.

CREATE TABLE IF NOT EXISTS "SacramentalRecordAudit" (
    "AuditId"     SERIAL      NOT NULL CONSTRAINT "PK_SacramentalRecordAudit" PRIMARY KEY,
    "RecordType"  VARCHAR(30) NOT NULL,
    "RecordId"    INT         NOT NULL,
    "ActionName"  VARCHAR(20) NOT NULL,
    "ChangedBy"   TEXT        NOT NULL,
    "ChangedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Changes"     TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_SacramentalRecordAudit_Record"
    ON "SacramentalRecordAudit" ("RecordType", "RecordId", "ChangedAt" DESC);
