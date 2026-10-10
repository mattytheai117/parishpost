-- Parishioner portal accounts and certificate appointment requests.
-- Converted from MSSQL migration 006.
-- Note: tables already created in 006_parishioner_portal_cert.sql (which also
-- creates Service, ServiceRequest, Events, etc.). This file adds the indexes
-- and columns that the original 006 migration introduced on top of the baseline.

ALTER TABLE "ParishionerAccounts" ADD COLUMN IF NOT EXISTS "LastLoginAt" TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ParishionerAccounts_Parishioner"
    ON "ParishionerAccounts" ("ParishionerId");

CREATE INDEX IF NOT EXISTS "IX_ParishionerPortalSessions_Account"
    ON "ParishionerPortalSessions" ("AccountId", "ExpiresAt");

CREATE INDEX IF NOT EXISTS "IX_CertificateRequests_Account"
    ON "CertificateRequests" ("AccountId", "CreatedAt" DESC);

CREATE INDEX IF NOT EXISTS "IX_CertificateRequests_Appointment"
    ON "CertificateRequests" ("PreferredDate", "PreferredTime", "Status");
