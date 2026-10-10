-- Update voided no-show records to use dedicated VoidedNoShow status.
-- Converted from MSSQL migration 017.

UPDATE "ServiceRequest"
SET "Status" = 'VoidedNoShow'
WHERE "Status" = 'Voided'
  AND "AttendanceStatus" = 'NoShow';
