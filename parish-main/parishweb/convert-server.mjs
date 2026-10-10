import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('server.js', 'utf8');

// ── 1. Remove MSSQL config block ──
// Remove dbAuth logger line
src = src.replace(
  /const dbAuth = \(process\.env\.DB_AUTH[\s\S]*?config = baseConfig;\n\}/,
  ''
);
src = src.replace(
  /logger\.info\('DB startup config:'[\s\S]*?\}\);\n/,
  ''
);

// ── 2. Fix startup call ──
src = src.replace('await initializePool(config);', 'await initializePool();');

// ── 3. dbo.TableName → "TableName" ──
src = src.replace(/\bdbo\.([A-Za-z]\w*)/g, '"$1"');

// ── 4. Timestamp functions ──
src = src.replace(/SYSUTCDATETIME\(\)/g, 'NOW()');
src = src.replace(/GETUTCDATE\(\)/g, 'NOW()');
src = src.replace(/\bGETDATE\(\)/g, 'NOW()');

// ── 5. OUTPUT INSERTED.X → RETURNING "X" ──
src = src.replace(/OUTPUT INSERTED\.(\w+)/g, 'RETURNING "$1"');

// ── 6. CAST(NOW() AS date) → CURRENT_DATE ──
src = src.replace(/CAST\(NOW\(\) AS date\)/g, 'CURRENT_DATE');

// ── 7. N'' string literals ──
src = src.replace(/\bN'/g, "'");

// ── 8. ISNULL → COALESCE ──
src = src.replace(/\bISNULL\(/g, 'COALESCE(');

// ── 9. CONVERT(varchar(10), col, 23) → col::date::text ──
src = src.replace(/CONVERT\(varchar\(10\),\s*(\w+),\s*23\)/g, '$1::date::text');

// ── 10. DATENAME/DATEFROMPARTS/DATEDIFF/YEAR/MONTH ──
src = src.replace(/DATENAME\(month,\s*/g, "TO_CHAR(");
// DATEFROMPARTS needs special handling - add format arg
src = src.replace(/DATEFROMPARTS\(([^,]+),\s*([^,]+),\s*1\)/g, 'MAKE_DATE(($1)::int, ($2)::int, 1)');
src = src.replace(/DATEDIFF\(year,\s*([^,]+),\s*([^)]+)\)/g, 'EXTRACT(year FROM age($2, $1))::int');
src = src.replace(/\bYEAR\(([^)]+)\)/g, 'EXTRACT(year FROM $1)::int');
src = src.replace(/\bMONTH\(([^)]+)\)/g, 'EXTRACT(month FROM $1)::int');
src = src.replace(/CAST\(0 AS bit\)/g, 'FALSE');
src = src.replace(/CAST\(1 AS bit\)/g, 'TRUE');

// ── 11. Boolean column comparisons in SQL ──
src = src.replace(/MustChangePassword = 0\b/g, '"MustChangePassword" = FALSE');
src = src.replace(/MustChangePassword = 1\b/g, '"MustChangePassword" = TRUE');
src = src.replace(/"MustChangePassword" = 0\b/g, '"MustChangePassword" = FALSE');
src = src.replace(/"MustChangePassword" = 1\b/g, '"MustChangePassword" = TRUE');
src = src.replace(/IsApproved = 1\b/g, '"IsApproved" = TRUE');
src = src.replace(/IsApproved = 0\b/g, '"IsApproved" = FALSE');
src = src.replace(/ShareWithCommunity = 1\b/g, '"ShareWithCommunity" = TRUE');

// ── 12. UpdatedAt=NOW() quoting ──
src = src.replace(/\bUpdatedAt=NOW\(\)/g, '"UpdatedAt"=NOW()');
src = src.replace(/\bAttendanceMarkedAt=NOW\(\)/g, '"AttendanceMarkedAt"=NOW()');
src = src.replace(/\bVoidedAt=NOW\(\)/g, '"VoidedAt"=NOW()');
src = src.replace(/\bGeneratedAt=NOW\(\)/g, '"GeneratedAt"=NOW()');
src = src.replace(/\bUsedAt=NOW\(\)/g, '"UsedAt"=NOW()');
src = src.replace(/\bUpdatedAt = NOW\(\)/g, '"UpdatedAt" = NOW()');

// ── 13. CAST(0/1 AS bit) in SELECT ──
src = src.replace(/CAST\(0 AS bit\)/g, 'FALSE');

// ── 14. SQL Server error code → pg ──
src = src.replace(
  "error?.number === 2601 || error?.number === 2627",
  "error?.code === '23505'"
);

// ── 15. DECLARE @inserted TABLE workaround in ServiceRequest INSERT ──
src = src.replace(
  /DECLARE @inserted TABLE \(ServiceRequestId INT\);\s*\n\s*INSERT INTO "ServiceRequest"\s*\([^)]+\)\s*\n\s*OUTPUT INSERTED\.ServiceRequestId INTO @inserted\s*\n([\s\S]*?);\s*\n\s*SELECT ServiceRequestId FROM @inserted;/,
  (match, middle) => {
    const cleaned = middle.replace(/\s*OUTPUT INSERTED\.\w+ INTO @inserted/, '');
    return `INSERT INTO "ServiceRequest"\n        (ParishionerId, ServiceId, RequestDate, ScheduledDate, ScheduledTime, Venue, Status, Notes, CreatedAt,\n         ContactFirstName, ContactLastName, ContactEmail, ContactMobile, ContactAddress)\n      VALUES\n        (@parishionerId, @serviceId, NOW(), @scheduledDate, @scheduledTime, '', 'PendingVerification', @notes, NOW(),\n         @firstName, @lastName, @email, @mobileNumber, @address)\n      RETURNING "ServiceRequestId"`;
  }
);

// ── 16. DELETE ... OUTPUT DELETED.FileUrl → SELECT then DELETE ──
// Already handled manually if needed - mark for later

// ── 17. MERGE FinanceReportSnapshots → INSERT ON CONFLICT ──
src = src.replace(
  /MERGE "FinanceReportSnapshots" AS target USING[\s\S]*?VALUES \(@type,@start,@end,@income,@expenses,@net,@details,@by\);/,
  `INSERT INTO "FinanceReportSnapshots" ("ReportType","PeriodStart","PeriodEnd","TotalIncome","TotalExpenses","NetTotal","Details","GeneratedBy")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ("ReportType","PeriodStart","PeriodEnd") DO UPDATE
      SET "TotalIncome"=EXCLUDED."TotalIncome","TotalExpenses"=EXCLUDED."TotalExpenses","NetTotal"=EXCLUDED."NetTotal","Details"=EXCLUDED."Details","GeneratedAt"=NOW(),"GeneratedBy"=EXCLUDED."GeneratedBy"`
);

// ── 18. MERGE SiteContent → INSERT ON CONFLICT ──
src = src.replace(
  /MERGE "SiteContent"[\s\S]*?VALUES \(@key, @content, @updatedBy\);/,
  `INSERT INTO "SiteContent" ("ContentKey","ContentJson","UpdatedBy")
          VALUES ($1,$2,$3)
          ON CONFLICT ("ContentKey") DO UPDATE
          SET "ContentJson"=EXCLUDED."ContentJson","UpdatedAt"=NOW(),"UpdatedBy"=EXCLUDED."UpdatedBy"`
);

// ── 19. TOP N → LIMIT N ──
src = src.replace(/SELECT TOP \(@limit\)/g, 'SELECT');
src = src.replace(/SELECT TOP \(1\)/g, 'SELECT');
src = src.replace(/SELECT TOP 1 /g, 'SELECT ');
src = src.replace(/SELECT TOP 200 /g, 'SELECT ');
src = src.replace(/SELECT TOP 100 /g, 'SELECT ');
// For inline SELECT TOP 1 without trailing space
src = src.replace(/SELECT TOP 1\b/g, 'SELECT');

// ── 20. COALESCE pattern for Notes append ──
src = src.replace(
  "COALESCE(Notes, ''), @adminNote)",
  `COALESCE("Notes", '') || $2)`
);

// Report
const sqlCount = (src.match(/\bsql\./g) || []).length;
const reqCount = (src.match(/\.request\(\)/g) || []).length;
console.log(`Done. Remaining sql. refs: ${sqlCount}, .request() refs: ${reqCount}`);

writeFileSync('server.js', src, 'utf8');
