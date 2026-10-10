-- Role-aware staff scheduling foundation.
-- Converted from MSSQL migration 001.

CREATE TABLE IF NOT EXISTS "MassSchedule" (
    "MassScheduleId"  SERIAL          NOT NULL CONSTRAINT "PK_MassSchedule" PRIMARY KEY,
    "Title"           TEXT            NOT NULL,
    "MassDate"        DATE            NOT NULL,
    "MassTime"        VARCHAR(10)     NOT NULL,
    "Location"        TEXT            NOT NULL,
    "PriestUsername"  VARCHAR(256)    NOT NULL,
    "Notes"           TEXT            NULL,
    "Status"          VARCHAR(30)     NOT NULL DEFAULT 'Scheduled',
    "CreatedAt"       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_MassSchedule_PriestDate"
    ON "MassSchedule" ("PriestUsername", "MassDate", "MassTime");

-- Note: role seeding moved to 005_user_management_audit.sql where AspNetRoles is created.
