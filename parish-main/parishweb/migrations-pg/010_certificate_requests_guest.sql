-- Guest certificate requests: make AccountId nullable, add contact fields and reference code.
-- Converted from MSSQL migration 010.

ALTER TABLE "CertificateRequests" ALTER COLUMN "AccountId" DROP NOT NULL;

ALTER TABLE "CertificateRequests" ADD COLUMN IF NOT EXISTS "ContactEmail"  TEXT        NULL;
ALTER TABLE "CertificateRequests" ADD COLUMN IF NOT EXISTS "ContactPhone"  VARCHAR(50) NULL;
ALTER TABLE "CertificateRequests" ADD COLUMN IF NOT EXISTS "FirstName"     TEXT        NULL;
ALTER TABLE "CertificateRequests" ADD COLUMN IF NOT EXISTS "LastName"      TEXT        NULL;
ALTER TABLE "CertificateRequests" ADD COLUMN IF NOT EXISTS "ReferenceCode" VARCHAR(10) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CertificateRequests_RefCode"
    ON "CertificateRequests" ("ReferenceCode")
    WHERE "ReferenceCode" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "IX_CertificateRequests_EmailRef"
    ON "CertificateRequests" ("ContactEmail", "ReferenceCode")
    WHERE "ContactEmail" IS NOT NULL;
