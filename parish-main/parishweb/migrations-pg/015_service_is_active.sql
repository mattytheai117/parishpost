-- Add IsActive flag to Service; disable Anointing of the Sick.
-- Converted from MSSQL migration 015.

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "IsActive" BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE "Service" SET "IsActive" = FALSE WHERE "Name" = 'Anointing of the Sick';
