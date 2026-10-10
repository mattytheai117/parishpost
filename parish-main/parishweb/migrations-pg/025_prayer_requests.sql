-- === 025_prayer_requests.sql ===
-- Prayer requests from parishioners.
-- This table was present in the legacy MSSQL schema but was never ported
-- to the PostgreSQL migrations.

CREATE TABLE IF NOT EXISTS "PrayerRequests" (
    "PrayerId"            SERIAL      NOT NULL CONSTRAINT "PK_PrayerRequests" PRIMARY KEY,
    "Name"                TEXT        NULL,
    "Category"            VARCHAR(100) NULL,
    "Request"             TEXT        NULL,
    "Anonymous"           BOOLEAN     NOT NULL DEFAULT FALSE,
    "ShareWithCommunity"  BOOLEAN     NOT NULL DEFAULT FALSE,
    "IsApproved"          BOOLEAN     NOT NULL DEFAULT FALSE,
    "CreatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_PrayerRequests_CreatedAt"
    ON "PrayerRequests" ("CreatedAt" DESC);

CREATE INDEX IF NOT EXISTS "IX_PrayerRequests_Approved"
    ON "PrayerRequests" ("IsApproved", "ShareWithCommunity")
    WHERE "IsApproved" = TRUE;
