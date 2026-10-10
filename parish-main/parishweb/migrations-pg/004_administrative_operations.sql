-- Administrative and financial operations.
-- Converted from MSSQL migration 004.
-- Note: ActiveSlotKey trigger replaced by app-level computation in server.js.
-- Note: EXEC sys.sp_executesql blocks converted to plain SQL.

CREATE TABLE IF NOT EXISTS "MassIntentions" (
    "MassIntentionId"  SERIAL          NOT NULL CONSTRAINT "PK_MassIntentions" PRIMARY KEY,
    "IntentionDate"    DATE            NOT NULL,
    "IntentionTime"    VARCHAR(10)     NOT NULL,
    "Offering"         DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "RequestedBy"      TEXT            NOT NULL,
    "IntentionText"    TEXT            NOT NULL,
    "Status"           VARCHAR(30)     NOT NULL DEFAULT 'Scheduled',
    "CreatedBy"        TEXT            NOT NULL,
    "CreatedAt"        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_MassIntentions_DateTime"
    ON "MassIntentions" ("IntentionDate", "IntentionTime");

CREATE TABLE IF NOT EXISTS "FinancialEntries" (
    "FinancialEntryId"  SERIAL          NOT NULL CONSTRAINT "PK_FinancialEntries" PRIMARY KEY,
    "EntryDate"         DATE            NOT NULL,
    "EntryType"         VARCHAR(30)     NOT NULL,
    "Description"       TEXT            NOT NULL,
    "Amount"            DECIMAL(12,2)   NOT NULL,
    "ReferenceType"     VARCHAR(30)     NULL,
    "ReferenceId"       INT             NULL,
    "EnteredBy"         TEXT            NOT NULL,
    "CreatedAt"         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_FinancialEntries_DateType"
    ON "FinancialEntries" ("EntryDate", "EntryType");

CREATE TABLE IF NOT EXISTS "ApplicationEditLog" (
    "ApplicationEditLogId"  SERIAL      NOT NULL CONSTRAINT "PK_ApplicationEditLog" PRIMARY KEY,
    "ServiceRequestId"      INT         NOT NULL,
    "ChangedBy"             TEXT        NOT NULL,
    "ChangedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Changes"               TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS "IX_ApplicationEditLog_Request"
    ON "ApplicationEditLog" ("ServiceRequestId", "ChangedAt" DESC);

-- Add columns to ServiceRequest if they don't exist yet
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "AttendanceStatus" VARCHAR(30)  NULL;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "AttendanceMarkedAt" TIMESTAMPTZ NULL;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "VoidedAt"          TIMESTAMPTZ NULL;
-- ActiveSlotKey: computed by app on every INSERT/UPDATE (no trigger needed in PostgreSQL for test)
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "ActiveSlotKey"     TEXT        NULL;

-- Populate ActiveSlotKey for existing rows
UPDATE "ServiceRequest"
SET "ActiveSlotKey" = CASE
    WHEN "Status" IN ('PendingVerification', 'Confirmed')
        THEN "ServiceId"::text || '|' || "ScheduledDate"::date::text || '|' || "ScheduledTime"
    ELSE NULL
END;

-- Void duplicate slots, keeping the earliest booking per slot
UPDATE "ServiceRequest" sr
SET "Status"   = 'ConflictVoided',
    "VoidedAt" = NOW()
FROM (
    SELECT "ServiceRequestId",
           ROW_NUMBER() OVER (PARTITION BY "ActiveSlotKey" ORDER BY "CreatedAt", "ServiceRequestId") AS slot_order
    FROM "ServiceRequest"
    WHERE "ActiveSlotKey" IS NOT NULL
) dupes
WHERE sr."ServiceRequestId" = dupes."ServiceRequestId"
  AND dupes.slot_order > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "UX_ServiceRequest_ActiveSlot"
    ON "ServiceRequest" ("ActiveSlotKey")
    WHERE "ActiveSlotKey" IS NOT NULL;
