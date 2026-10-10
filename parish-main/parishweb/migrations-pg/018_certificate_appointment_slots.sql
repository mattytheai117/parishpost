-- Certificate appointment slot protection.
-- Converted from MSSQL migration 018.
-- The MSSQL version used a trigger to prevent double-booking confirmed certificate slots.
-- In PostgreSQL this is enforced by a partial unique index instead (simpler, no trigger needed).

CREATE UNIQUE INDEX IF NOT EXISTS "UX_CertificateRequests_ConfirmedSlot"
    ON "CertificateRequests" ("PreferredDate", "PreferredTime")
    WHERE "Status" IN ('Confirmed', 'ReadyForClaim', 'Claimed');
