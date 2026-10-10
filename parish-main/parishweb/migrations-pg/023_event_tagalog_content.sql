-- Add Tagalog (TL) content columns to Events.
-- Converted from MSSQL migration 023.

ALTER TABLE "Events" ADD COLUMN IF NOT EXISTS "TitleTl"       TEXT NULL;
ALTER TABLE "Events" ADD COLUMN IF NOT EXISTS "DescriptionTl" TEXT NULL;
ALTER TABLE "Events" ADD COLUMN IF NOT EXISTS "BodyTl"        TEXT NULL;
ALTER TABLE "Events" ADD COLUMN IF NOT EXISTS "LocationTl"    TEXT NULL;
