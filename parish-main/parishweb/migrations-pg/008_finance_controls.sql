-- Finance workflow: expenses, approvals, reconciliation, and audit history.
-- Converted from MSSQL migration 008.

ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "Status"       VARCHAR(30) NOT NULL DEFAULT 'Draft';
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ApprovedBy"   TEXT        NULL;
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ApprovedAt"   TIMESTAMPTZ NULL;
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ReconciledBy" TEXT        NULL;
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ReconciledAt" TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS "FinancialEntryAudit" (
    "AuditId"           SERIAL      NOT NULL CONSTRAINT "PK_FinancialEntryAudit" PRIMARY KEY,
    "FinancialEntryId"  INT         NOT NULL,
    "ActionName"        VARCHAR(30) NOT NULL,
    "ChangedBy"         TEXT        NOT NULL,
    "ChangedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Details"           TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_FinancialEntryAudit_Entry"
    ON "FinancialEntryAudit" ("FinancialEntryId", "ChangedAt" DESC);
