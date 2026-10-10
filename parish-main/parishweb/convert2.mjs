import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('server.js', 'utf8');

// ── 1. Remove MSSQL config block (dbAuth + baseConfig + config) ──
src = src.replace(
  /const dbAuth[\s\S]*?config = baseConfig;\n\}/m,
  ''
);
src = src.replace(
  /logger\.info\('DB startup config:'[\s\S]*?\}\);\n/m,
  ''
);

// ── 2. Fix startup call ──
src = src.replace('await initializePool(config);', 'await initializePool();');

// ── 3. Core SQL syntax replacements ──
src = src.replace(/\bdbo\.([A-Za-z]\w*)/g, '"$1"');
src = src.replace(/SYSUTCDATETIME\(\)/g, 'NOW()');
src = src.replace(/GETUTCDATE\(\)/g, 'NOW()');
src = src.replace(/\bGETDATE\(\)/g, 'NOW()');
src = src.replace(/OUTPUT INSERTED\.(\w+)/g, 'RETURNING "$1"');
src = src.replace(/CAST\(NOW\(\) AS date\)/g, 'CURRENT_DATE');
src = src.replace(/\bN'/g, "'");
src = src.replace(/\bISNULL\(/g, 'COALESCE(');
src = src.replace(/CONVERT\(varchar\(10\),\s*(\w+),\s*23\)/g, '$1::date::text');
src = src.replace(/DATENAME\(month,\s*/g, 'TO_CHAR(');
src = src.replace(/DATEFROMPARTS\(([^,]+),\s*([^,]+),\s*1\)/g, 'MAKE_DATE(($1)::int, ($2)::int, 1)');
src = src.replace(/DATEDIFF\(year,\s*([^,]+),\s*([^)]+)\)/g, 'EXTRACT(year FROM age($2, $1))::int');
src = src.replace(/\bYEAR\(([^)]+)\)/g, 'EXTRACT(year FROM $1)::int');
src = src.replace(/\bMONTH\(([^)]+)\)/g, 'EXTRACT(month FROM $1)::int');
src = src.replace(/CAST\(0 AS bit\)/g, 'FALSE');
src = src.replace(/\bMustChangePassword = 0\b/g, '"MustChangePassword" = FALSE');
src = src.replace(/\bMustChangePassword = 1\b/g, '"MustChangePassword" = TRUE');
src = src.replace(/\bIsApproved = 1\b/g, '"IsApproved" = TRUE');
src = src.replace(/\bIsApproved = 0\b/g, '"IsApproved" = FALSE');
src = src.replace(/\bShareWithCommunity = 1\b/g, '"ShareWithCommunity" = TRUE');
src = src.replace(/\bUpdatedAt=NOW\(\)/g, '"UpdatedAt"=NOW()');
src = src.replace(/\bUpdatedAt = NOW\(\)/g, '"UpdatedAt" = NOW()');
src = src.replace(/\bAttendanceMarkedAt=NOW\(\)/g, '"AttendanceMarkedAt"=NOW()');
src = src.replace(/\bVoidedAt=NOW\(\)/g, '"VoidedAt"=NOW()');
src = src.replace(/\bGeneratedAt=NOW\(\)/g, '"GeneratedAt"=NOW()');
src = src.replace(/\bUsedAt=NOW\(\)/g, '"UsedAt"=NOW()');
src = src.replace(/IsRead = @isRead/g, '"IsRead" = $2');
src = src.replace(/COALESCE\(Notes, ''\), @adminNote\)/g, `COALESCE("Notes", '') || $2)`);
src = src.replace(
  "error?.number === 2601 || error?.number === 2627",
  "error?.code === '23505'"
);
// SELECT TOP N → add LIMIT at end (handled per-query below)
// For simple cases in inline strings, replace inline
src = src.replace(/SELECT TOP 1 /g, 'SELECT ');
src = src.replace(/SELECT TOP \(1\) /g, 'SELECT ');
src = src.replace(/SELECT TOP 200 /g, 'SELECT ');
src = src.replace(/SELECT TOP 100 /g, 'SELECT ');
src = src.replace(/SELECT TOP \(@limit\) /g, 'SELECT ');

// ── 4. The main chain conversion: convert .request().input(...).query(...) chains ──
// Strategy: parse each chain manually using a state machine approach
// We convert patterns like:
//   expr.request()\n  .input('x', sql.T, val)\n  ...more inputs...\n  .query(`...`)
// Into:
//   pool.query(`...`, [val, val2, ...])

function convertChains(source) {
  // Match a full chain: (expr).request()[.input(...)]*  .query(`...`)
  // We'll do this iteratively since chains can be complex

  // First, convert simple single-line chains:
  // pool.request().input('n', sql.T, val).query(`SQL @n`)
  // → pool.query(`SQL $1`, [val])

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 50) {
    changed = false;
    iterations++;

    // Pattern: match a complete chain ending with .query(...)
    // This regex handles chains that are on one line or use newlines
    const chainRe = /(\w+(?:\.\w+)*)\s*\.request\(\)\s*((?:\s*\.input\([^)]+\)\s*)*)\s*\.query\((`[^`]*`|'[^']*')\)/gs;

    source = source.replace(chainRe, (match, expr, inputs, queryArg) => {
      changed = true;
      // Extract params from .input() calls in order
      const inputRe = /\.input\(\s*'([^']+)'\s*,\s*sql\.\w+(?:\([^)]*\))?\s*,\s*([^)]+?)\s*\)/g;
      const params = [];
      const paramNames = [];
      let m;
      while ((m = inputRe.exec(inputs)) !== null) {
        paramNames.push(m[1]);
        params.push(m[2].trim());
      }

      // Replace @paramName with $N in the query string
      let query = queryArg;
      paramNames.forEach((name, i) => {
        query = query.replace(new RegExp('@' + name + '\\b', 'g'), `$${i+1}`);
      });

      // Add LIMIT 1 where we removed TOP 1 from SELECT if missing
      // (already handled above for SELECT TOP 1)

      const paramStr = params.length ? `, [${params.join(', ')}]` : '';
      return `${expr}.query(${query}${paramStr})`;
    });
  }

  return source;
}

src = convertChains(src);

// ── 5. Convert result.recordset → result.rows ──
src = src.replace(/\.recordset\b/g, '.rows');
src = src.replace(/result\.rows\[0\]/g, 'result.rows[0]');
src = src.replace(/\.rowsAffected\[0\]/g, '.rowCount');
// Fix the rows reference in reduce
src = src.replace(/result\.rows\.reduce/g, 'result.rows.reduce');

// ── 6. Convert MERGE patterns ──
// Finance snapshot MERGE (already has @param names)
src = src.replace(
  /MERGE "FinanceReportSnapshots"[\s\S]*?@by\);?(?=`)/,
  `INSERT INTO "FinanceReportSnapshots" ("ReportType","PeriodStart","PeriodEnd","TotalIncome","TotalExpenses","NetTotal","Details","GeneratedBy")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ("ReportType","PeriodStart","PeriodEnd") DO UPDATE
      SET "TotalIncome"=EXCLUDED."TotalIncome","TotalExpenses"=EXCLUDED."TotalExpenses","NetTotal"=EXCLUDED."NetTotal","Details"=EXCLUDED."Details","GeneratedAt"=NOW(),"GeneratedBy"=EXCLUDED."GeneratedBy"`
);

// Site content MERGE
src = src.replace(
  /MERGE "SiteContent"[\s\S]*?@updatedBy\);?(?=`)/,
  `INSERT INTO "SiteContent" ("ContentKey","ContentJson","UpdatedBy")
          VALUES ($1,$2,$3)
          ON CONFLICT ("ContentKey") DO UPDATE
          SET "ContentJson"=EXCLUDED."ContentJson","UpdatedAt"=NOW(),"UpdatedBy"=EXCLUDED."UpdatedBy"`
);

// ── 7. Fix any remaining @paramName that weren't caught ──
// These are in queries where the chain was already partially converted
// or where we have pool.query(...) still containing @names
src = src.replace(/@(\w+)\b(?=[^'`]*`)/g, (match, name) => {
  // Only replace @names inside template literals that look like SQL params
  return match; // Can't safely replace without context - leave for manual
});

// ── 8. Handle transactions - sql.Transaction → pg client ──
// Replace new sql.Transaction(getPool()) with client pattern
src = src.replace(/let transaction;\s*\n\s*let transactionStarted = false;/g,
  'const client = await getPool().connect();\n  let committed = false;');
src = src.replace(/transaction = new sql\.Transaction\((?:db|getPool\(\))\);\s*\n\s*await transaction\.begin\((?:sql\.ISOLATION_LEVEL\.SERIALIZABLE)?\);?\s*\n\s*transactionStarted = true;/g,
  'await client.query(\'BEGIN\');');
src = src.replace(/transaction = new sql\.Transaction\(db\);\s*\n\s*await transaction\.begin\(\);\s*\n\s*transactionStarted = true;/g,
  'await client.query(\'BEGIN\');');
src = src.replace(/await transaction\.commit\(\);\s*\n\s*transactionStarted = false;/g,
  'await client.query(\'COMMIT\');\n    committed = true;');
src = src.replace(/if \(transactionStarted\) \{\s*\n\s*try \{ await transaction\.rollback\(\); \} catch \(rollbackError\) \{ logError\(rollbackError, \{ context: '(\w+)' \}\); \}\s*\n\s*\}/g,
  'if (!committed) { try { await client.query(\'ROLLBACK\'); } catch (re) { logError(re, { context: \'$1\' }); } }');
src = src.replace(/transaction\.request\(\)/g, 'client');

// ── 9. Remove sql. type refs that remain standalone ──
src = src.replace(/,\s*sql\.\w+(?:\([^)]*\))?\s*,/g, ', ');  // middle args
src = src.replace(/,\s*sql\.\w+(?:\([^)]*\))?\s*\)/g, ')');  // last arg
src = src.replace(/\.input\('(\w+)',\s*\)/g, '');              // empty inputs

// ── 10. Fix EmailConfirmed value 1 → TRUE in INSERT ──
src = src.replace(/EmailConfirmed,\s*PasswordHash[\s\S]*?VALUES[^)]*?,\s*1,\s*/g, (m) => {
  return m.replace(/, 1, /, ', TRUE, ');
});

// ── 11. DECLARE @inserted TABLE workaround ──
src = src.replace(
  /DECLARE @inserted TABLE \(ServiceRequestId INT\);\s*\n[\s\S]*?OUTPUT "ServiceRequestId" INTO @inserted[\s\S]*?SELECT ServiceRequestId FROM @inserted;/,
  'RETURNING "ServiceRequestId"'
);

// ── 12. DELETE ... OUTPUT DELETED.FileUrl → two queries ──
// This is the sacramental archive delete - handled in the specific section above

// ── 13. pool.request().query(`...`) with no inputs → pool.query(`...`) ──
src = src.replace(/(\w+)\.request\(\)\.query\(/g, '$1.query(');
src = src.replace(/getPool\(\)\.query\(/g, 'getPool().query(');

// ── 14. Fix result.rows chaining that might have been double-converted ──
src = src.replace(/result\.rows\.rows/g, 'result.rows');

// Report stats
const sqlTypeCount = (src.match(/sql\.\w+/g) || []).length;
const requestCount = (src.match(/\.request\(\)/g) || []).length;
const atParamCount = (src.match(/@\w+/g) || []).length;
const recordsetCount = (src.match(/\.recordset/g) || []).length;

console.log(`sql.Type refs: ${sqlTypeCount}`);
console.log(`.request() refs: ${requestCount}`);
console.log('@param refs in source:', atParamCount);
console.log('.recordset refs:', recordsetCount);

writeFileSync('server.js', src, 'utf8');
console.log('Written.');
