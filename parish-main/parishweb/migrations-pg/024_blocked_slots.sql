-- Admin-managed blocked dates/times for service and certificate appointments.
-- Converted from MSSQL migration 024.

CREATE TABLE IF NOT EXISTS "BlockedSlots" (
    "BlockedSlotId"  SERIAL      NOT NULL CONSTRAINT "PK_BlockedSlots" PRIMARY KEY,
    "BlockDate"      DATE        NOT NULL,
    "BlockTime"      VARCHAR(5)  NULL,         -- NULL blocks the whole day
    "Scope"          VARCHAR(20) NOT NULL,     -- All | Service | Certificate
    "ServiceId"      INT         NULL,         -- required when Scope = Service
    "Reason"         TEXT        NULL,
    "CreatedBy"      TEXT        NULL,
    "CreatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "CK_BlockedSlots_Scope"     CHECK ("Scope" IN ('All', 'Service', 'Certificate')),
    CONSTRAINT "CK_BlockedSlots_ServiceId" CHECK (
        ("Scope" = 'Service' AND "ServiceId" IS NOT NULL) OR
        ("Scope" <> 'Service' AND "ServiceId" IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS "IX_BlockedSlots_BlockDate" ON "BlockedSlots" ("BlockDate");
