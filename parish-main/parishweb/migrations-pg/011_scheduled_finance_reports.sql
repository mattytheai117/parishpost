-- Persisted weekly and monthly finance report snapshots.
-- Converted from MSSQL migration 011.

CREATE TABLE IF NOT EXISTS "FinanceReportSnapshots" (
    "FinanceReportSnapshotId"  SERIAL          NOT NULL CONSTRAINT "PK_FinanceReportSnapshots" PRIMARY KEY,
    "ReportType"               VARCHAR(20)     NOT NULL,
    "PeriodStart"              DATE            NOT NULL,
    "PeriodEnd"                DATE            NOT NULL,
    "TotalIncome"              DECIMAL(14,2)   NOT NULL,
    "TotalExpenses"            DECIMAL(14,2)   NOT NULL,
    "NetTotal"                 DECIMAL(14,2)   NOT NULL,
    "Details"                  TEXT            NOT NULL,
    "GeneratedAt"              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "GeneratedBy"              TEXT            NOT NULL,
    CONSTRAINT "CK_FinanceReportSnapshots_Type"   CHECK ("ReportType" IN ('Weekly', 'Monthly')),
    CONSTRAINT "UQ_FinanceReportSnapshots_Period" UNIQUE ("ReportType", "PeriodStart", "PeriodEnd")
);

CREATE INDEX IF NOT EXISTS "IX_FinanceReportSnapshots_Period"
    ON "FinanceReportSnapshots" ("ReportType", "PeriodStart" DESC);
