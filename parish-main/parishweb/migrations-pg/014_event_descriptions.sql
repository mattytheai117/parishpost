-- Add Description column to Events.
-- Converted from MSSQL migration 014.

ALTER TABLE "Events" ADD COLUMN IF NOT EXISTS "Description" TEXT NULL;
