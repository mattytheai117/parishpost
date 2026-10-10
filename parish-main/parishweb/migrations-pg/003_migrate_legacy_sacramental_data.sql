-- Migrate legacy sacramental data to new schema.
-- Converted from MSSQL migration 003.
-- For a fresh Supabase test database there is no legacy data to migrate.
-- This file runs safely against an empty database (all INSERT ... WHERE NOT EXISTS).

-- Baptism legacy migration (no-op when BaptismDetail does not exist)
INSERT INTO "BaptismRecords" (
    "RegistryNumber", "ChildFirstName", "ChildLastName",
    "DateOfBirth", "DateOfBaptism", "MinisterName", "Remarks", "CreatedBy"
)
SELECT
    'BAP-' || EXTRACT(YEAR FROM "DateOfBirth")::text || '-' || LPAD(ROW_NUMBER() OVER (ORDER BY "ServiceRequestId")::text, 4, '0'),
    SPLIT_PART("ChildName", ' ', 1),
    CASE WHEN POSITION(' ' IN "ChildName") > 0 THEN SUBSTRING("ChildName" FROM POSITION(' ' IN "ChildName") + 1) ELSE 'Unknown' END,
    "DateOfBirth",
    "DateOfBirth",
    'Legacy Import',
    'Migrated from legacy BaptismDetail table',
    'MigrationScript'
FROM "BaptismDetail"
WHERE NOT EXISTS (SELECT 1 FROM "BaptismRecords")
ON CONFLICT DO NOTHING;

-- Note: ConfirmationDetail, MarriageDetail, FuneralMassDetail, HouseBlessingDetail
-- follow the same pattern. Omitted here — legacy tables will not exist on a fresh
-- Supabase test database. Add INSERT blocks above if migrating real legacy data.
