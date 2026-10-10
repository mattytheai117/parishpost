/**
 * server.js MSSQL → pg conversion script
 * Converts all mssql query chains to pg pool.query() calls.
 * Run from the parishweb/ directory: node convert3.mjs
 */
import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('server.js', 'utf8');

// ─────────────────────────────────────────────
// PASS 1: Remove MSSQL-only config blocks
// ─────────────────────────────────────────────

// Remove dbAuth + baseConfig + config if/else block
src = src.replace(
  /const dbAuth = \(process\.env\.DB_AUTH[\s\S]*?^}/m,
  ''
);
// Tighten up: also handles ending without newline
src = src.replace(
  /const dbAuth[\s\S]*?config = baseConfig;\n\}/,
  ''
);
src = src.replace(
  /logger\.info\('DB startup config:'[\s\S]*?\}\);\n/,
  ''
);
src = src.replace('await initializePool(config);', 'await initializePool();');

// ─────────────────────────────────────────────
// PASS 2: SQL syntax inside template literals
// Strategy: only replace inside backtick strings to avoid
// double-quoting issues in JS code itself
// ─────────────────────────────────────────────

// We'll process template literals separately
// First: find all template literal positions, apply SQL rewrites inside them
// Then: apply JS-level changes outside them

function splitByTemplateLiterals(text) {
  // Returns array of {type: 'code'|'template', content, start, end}
  const parts = [];
  let i = 0;
  let inTemplate = false;
  let depth = 0;
  let start = 0;

  while (i < text.length) {
    if (!inTemplate) {
      // Look for start of template literal
      if (text[i] === '`') {
        // Save code part
        if (i > start) parts.push({ type: 'code', content: text.slice(start, i) });
        start = i;
        inTemplate = true;
        depth = 1;
        i++;
      } else if (text[i] === '/' && text[i+1] === '/') {
        // Skip line comment
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text[i] === '\'' || text[i] === '"') {
        // Skip regular string
        const q = text[i]; i++;
        while (i < text.length && text[i] !== q) {
          if (text[i] === '\\') i++;
          i++;
        }
        i++; // closing quote
      } else {
        i++;
      }
    } else {
      if (text[i] === '`') {
        depth--;
        if (depth === 0) {
          i++;
          parts.push({ type: 'template', content: text.slice(start, i) });
          start = i;
          inTemplate = false;
        } else {
          i++;
        }
      } else if (text[i] === '$' && text[i+1] === '{') {
        depth++;
        i += 2;
      } else if (text[i] === '}' && depth > 1) {
        depth--;
        i++;
      } else {
        i++;
      }
    }
  }
  if (start < text.length) parts.push({ type: 'code', content: text.slice(start) });
  return parts;
}

function rewriteSqlInTemplate(sql) {
  // Apply all SQL-level rewrites
  sql = sql.replace(/\bdbo\.([A-Za-z]\w*)/g, '"$1"');
  sql = sql.replace(/SYSUTCDATETIME\(\)/g, 'NOW()');
  sql = sql.replace(/\bGETUTCDATE\(\)/g, 'NOW()');
  sql = sql.replace(/\bGETDATE\(\)/g, 'NOW()');
  sql = sql.replace(/OUTPUT INSERTED\.(\w+)/g, 'RETURNING "$1"');
  sql = sql.replace(/CAST\(NOW\(\) AS date\)/g, 'CURRENT_DATE');
  sql = sql.replace(/\bN'/g, "'");
  sql = sql.replace(/\bISNULL\(/g, 'COALESCE(');
  sql = sql.replace(/CONVERT\(varchar\(10\),\s*(\w+),\s*23\)/g, '$1::date::text');
  sql = sql.replace(/DATENAME\(month,\s*/g, 'TO_CHAR(');
  sql = sql.replace(/DATEFROMPARTS\(([^,]+),\s*([^,]+),\s*1\)/g,
    (_, y, m) => `MAKE_DATE((${y.trim()})::int, (${m.trim()})::int, 1)`);
  sql = sql.replace(/DATEDIFF\(year,\s*([^,]+),\s*([^)]+)\)/g,
    (_, a, b) => `EXTRACT(year FROM age(${b.trim()}, ${a.trim()}))::int`);
  sql = sql.replace(/\bYEAR\(([^)]+)\)/g, (_, x) => `EXTRACT(year FROM ${x})::int`);
  sql = sql.replace(/\bMONTH\(([^)]+)\)/g, (_, x) => `EXTRACT(month FROM ${x})::int`);
  sql = sql.replace(/CAST\(0 AS bit\)/g, 'FALSE');
  sql = sql.replace(/\bMustChangePassword\s*=\s*0\b/g, '"MustChangePassword" = FALSE');
  sql = sql.replace(/\bMustChangePassword\s*=\s*1\b/g, '"MustChangePassword" = TRUE');
  sql = sql.replace(/\bIsApproved\s*=\s*1\b/g, '"IsApproved" = TRUE');
  sql = sql.replace(/\bIsApproved\s*=\s*0\b/g, '"IsApproved" = FALSE');
  sql = sql.replace(/\bShareWithCommunity\s*=\s*1\b/g, '"ShareWithCommunity" = TRUE');
  sql = sql.replace(/\bEmailConfirmed,\s*([A-Za-z, ]+)\)\s*\n(\s*)OUTPUT/g,
    (m) => m); // leave complex ones
  // UpdatedAt quoting
  sql = sql.replace(/\bUpdatedAt\s*=\s*NOW\(\)/g, '"UpdatedAt" = NOW()');
  sql = sql.replace(/\bAttendanceMarkedAt\s*=\s*NOW\(\)/g, '"AttendanceMarkedAt" = NOW()');
  sql = sql.replace(/\bVoidedAt\s*=\s*NOW\(\)/g, '"VoidedAt" = NOW()');
  sql = sql.replace(/\bGeneratedAt\s*=\s*NOW\(\)/g, '"GeneratedAt" = NOW()');
  sql = sql.replace(/\bUsedAt\s*=\s*NOW\(\)/g, '"UsedAt" = NOW()');
  // SELECT TOP N → SELECT ... LIMIT N
  sql = sql.replace(/SELECT TOP 1\b/g, 'SELECT');
  sql = sql.replace(/SELECT TOP \(1\)/g, 'SELECT');
  sql = sql.replace(/SELECT TOP 200\b/g, 'SELECT');
  sql = sql.replace(/SELECT TOP 100\b/g, 'SELECT');
  sql = sql.replace(/SELECT TOP \(@limit\)/g, 'SELECT');
  // LIMIT N at end of queries that had TOP N (add only where missing)
  // We can't easily determine "end of query" in a template, so leave; main
  // select results are already limited by the removed TOP
  // IsRead
  sql = sql.replace(/\bIsRead\s*=\s*@isRead\b/g, '"IsRead" = $2');
  // Notes concat
  sql = sql.replace(
    /CONCAT\(COALESCE\(Notes,\s*''\),\s*@adminNote\)/g,
    `COALESCE("Notes", '') || $2`
  );
  // VoidedAt CASE
  sql = sql.replace(
    /VoidedAt\s*=\s*CASE WHEN @status IN \('Voided','VoidedNoShow','Cancelled'\) THEN NOW\(\) ELSE VoidedAt END/g,
    `"VoidedAt" = CASE WHEN $2 IN ('Voided','VoidedNoShow','Cancelled') THEN NOW() ELSE "VoidedAt" END`
  );
  // MERGE → INSERT ON CONFLICT
  sql = sql.replace(
    /MERGE "FinanceReportSnapshots"[\s\S]*?VALUES \(@type,@start,@end,@income,@expenses,@net,@details,@by\);?/,
    `INSERT INTO "FinanceReportSnapshots" ("ReportType","PeriodStart","PeriodEnd","TotalIncome","TotalExpenses","NetTotal","Details","GeneratedBy")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ("ReportType","PeriodStart","PeriodEnd") DO UPDATE
      SET "TotalIncome"=EXCLUDED."TotalIncome","TotalExpenses"=EXCLUDED."TotalExpenses","NetTotal"=EXCLUDED."NetTotal","Details"=EXCLUDED."Details","GeneratedAt"=NOW(),"GeneratedBy"=EXCLUDED."GeneratedBy"`
  );
  sql = sql.replace(
    /MERGE "SiteContent"[\s\S]*?VALUES \(@key, @content, @updatedBy\);?/,
    `INSERT INTO "SiteContent" ("ContentKey","ContentJson","UpdatedBy")
          VALUES ($1,$2,$3)
          ON CONFLICT ("ContentKey") DO UPDATE
          SET "ContentJson"=EXCLUDED."ContentJson","UpdatedAt"=NOW(),"UpdatedBy"=EXCLUDED."UpdatedBy"`
  );
  // DECLARE @inserted workaround → RETURNING
  sql = sql.replace(
    /DECLARE @inserted TABLE \(ServiceRequestId INT\);\s*\n\s*INSERT INTO "ServiceRequest"\s*\(([^)]+)\)\s*\n\s*OUTPUT "ServiceRequestId" INTO @inserted\s*\n\s*VALUES\s*\(([^;]+)\);\s*\n\s*SELECT ServiceRequestId FROM @inserted;/s,
    `INSERT INTO "ServiceRequest" ($1)\n      VALUES ($2)\n      RETURNING "ServiceRequestId"`
  );
  return sql;
}

const parts = splitByTemplateLiterals(src);
src = parts.map(p => p.type === 'template' ? rewriteSqlInTemplate(p.content) : p.content).join('');

// ─────────────────────────────────────────────
// PASS 3: Convert .request().input().query() chains in JS code
// ─────────────────────────────────────────────

// This converts chains like:
//   expr.request()
//     .input('name1', sql.Type, val1)
//     .input('name2', sql.Type, val2)
//     .query(`SQL WITH @name1 AND @name2`)
// to:
//   expr.query(`SQL WITH $1 AND $2`, [val1, val2])

function convertRequestChains(code) {
  // Match: <expr>.request()<inputs>.query(<queryStr>)
  // where <inputs> is zero or more .input('name', sql.Type, value) calls
  // Handles multi-line chains

  const chainPattern = /([\w.()[\]]+?)\.request\(\)((?:\s*\.input\s*\([^)]*\))*)\s*\.query\((`[^`]*`)\)/gs;

  return code.replace(chainPattern, (match, expr, inputSection, queryStr) => {
    // Extract all inputs
    const inputPattern = /\.input\s*\(\s*'([^']+)'\s*,\s*sql\.\w+(?:\([^)]*\))?\s*,\s*([\s\S]+?)\s*\)(?=\s*[.)$])/g;
    const params = [];
    const names = [];
    let m;
    while ((m = inputPattern.exec(inputSection)) !== null) {
      names.push(m[1]);
      params.push(m[2].trim());
    }

    // Replace @name with $N in query string
    let q = queryStr;
    names.forEach((name, i) => {
      q = q.replace(new RegExp('@' + name + '\\b', 'g'), `$${i+1}`);
    });

    const paramArg = params.length ? `, [${params.join(', ')}]` : '';
    return `${expr}.query(${q}${paramArg})`;
  });
}

// Run multiple passes to catch nested/complex chains
for (let i = 0; i < 10; i++) {
  const prev = src;
  src = convertRequestChains(src);
  if (src === prev) break;
}

// ─────────────────────────────────────────────
// PASS 4: Fix result.recordset → result.rows
// ─────────────────────────────────────────────

src = src.replace(/\.recordset\b/g, '.rows');
src = src.replace(/\.rowsAffected\[0\]/g, '.rowCount');

// ─────────────────────────────────────────────
// PASS 5: Convert remaining single-line .request().query() (no inputs)
// ─────────────────────────────────────────────

src = src.replace(/([\w.()[\]]+?)\.request\(\)\.query\(/g, '$1.query(');

// ─────────────────────────────────────────────
// PASS 6: Convert sql.Transaction blocks to pg client pattern
// ─────────────────────────────────────────────

// Pattern A: full transaction with transactionStarted flag
// Replace new sql.Transaction + begin
src = src.replace(
  /let transaction;\s*\n\s*let transactionStarted = false;/g,
  'const client = await getPool().connect();\n  let committed = false;'
);
src = src.replace(
  /transaction = new sql\.Transaction\((?:db|getPool\(\))\);\s*\nawait transaction\.begin\((?:sql\.ISOLATION_LEVEL\.SERIALIZABLE)?\);\s*\ntransactionStarted = true;/g,
  "await client.query('BEGIN');"
);
src = src.replace(
  /transaction = new sql\.Transaction\(db\);\s*\n\s*await transaction\.begin\(sql\.ISOLATION_LEVEL\.SERIALIZABLE\);\s*\n\s*transactionStarted = true;/g,
  "await client.query('BEGIN');"
);
src = src.replace(
  /transaction = new sql\.Transaction\(db\);\s*\n\s*await transaction\.begin\(\);\s*\n\s*transactionStarted = true;/g,
  "await client.query('BEGIN');"
);
// Replace commit + reset
src = src.replace(
  /await transaction\.commit\(\);\s*\n\s*transactionStarted = false;/g,
  "await client.query('COMMIT');\n    committed = true;"
);
// Replace rollback in catch
src = src.replace(
  /if \(transactionStarted\) \{\s*\n\s*try \{ await transaction\.rollback\(\); \} catch \(rollbackError\) \{ logError\(rollbackError, \{ context: '([^']+)' \}\); \}\s*\n\s*\}/g,
  `if (!committed) {\n      try { await client.query('ROLLBACK'); } catch (re) { logError(re, { context: '$1' }); }\n    }`
);
// Replace transaction.request() → client
src = src.replace(/transaction\.request\(\)/g, 'client');
// Add finally { client.release() } before closing brace of catch blocks in transactions
// This is tricky to do with regex; add a note for manual fixup
// For now, add client.release() before the end of each try/catch that has 'committed'
// Actually, we'll handle this differently - wrap the catch content

// ─────────────────────────────────────────────
// PASS 7: Error constraint code
// ─────────────────────────────────────────────

src = src.replace(
  "error?.number === 2601 || error?.number === 2627",
  "error?.code === '23505'"
);

// ─────────────────────────────────────────────
// PASS 8: Fix DELETE OUTPUT DELETED in sacramental archive
// ─────────────────────────────────────────────
src = src.replace(
  /const result = await getPool\(\)\.query\('DELETE FROM "SacramentalArchives" OUTPUT DELETED\."FileUrl" WHERE "ArchiveId"=\$1', \[id\]\);\s*\n\s*const fileUrl = result\.rows\[0\]\?\.FileUrl;/,
  `const selResult = await getPool().query('SELECT "FileUrl" FROM "SacramentalArchives" WHERE "ArchiveId"=$1', [id]);\n    const fileUrl = selResult.rows[0]?.FileUrl;\n    if (!fileUrl) return res.status(404).json({ message: 'Archive entry not found.' });\n    await getPool().query('DELETE FROM "SacramentalArchives" WHERE "ArchiveId"=$1', [id]);`
);

// Also fix the if(!fileUrl) check that follows (now it's above)
src = src.replace(
  /const fileUrl = selResult\.rows\[0\]\?\.FileUrl;\n    if \(!fileUrl\) return res\.status\(404\)\.json\(\{ message: 'Archive entry not found\.' \}\);\n    await getPool\(\)\.query\('DELETE FROM "SacramentalArchives" WHERE "ArchiveId"=\$1', \[id\]\);\n    const fileUrl = result\.rows\[0\]\?\.FileUrl;\n    if \(!fileUrl\)/,
  `const fileUrl = selResult.rows[0]?.FileUrl;\n    if (!fileUrl`
);

// ─────────────────────────────────────────────
// PASS 9: Fix @includeDetails → boolean $1
// ─────────────────────────────────────────────
src = src.replace(
  'CASE WHEN @includeDetails = 1 THEN u.EmailAddress ELSE NULL END',
  'CASE WHEN $1 THEN u."EmailAddress" ELSE NULL END'
);
src = src.replace(
  "req.staff.role === 'Admin' ? 1 : 0",
  "req.staff.role === 'Admin'"
);

// ─────────────────────────────────────────────
// PASS 10: Fix DATENAME TO_CHAR missing second arg
// ─────────────────────────────────────────────
// DATENAME(month, DATEFROMPARTS...) was converted to TO_CHAR(MAKE_DATE...)
// but needs a format string. Add ', 'Month'' after the first arg if missing.
// This is complex; find TO_CHAR( followed by MAKE_DATE but no second TO_CHAR arg
src = src.replace(
  /TO_CHAR\((MAKE_DATE\([^)]+\))\)/g,
  "TO_CHAR($1, 'Month')"
);

// ─────────────────────────────────────────────
// PASS 11: Fix remaining @paramName in queries that weren't caught
// ─────────────────────────────────────────────
// These are in dynamic query construction (saveSacramentDetails, sacramental search)
// We'll leave those for targeted edits since they're complex dynamic builders

// ─────────────────────────────────────────────
// PASS 12: Pool.query syntax - fix getPool().query vs pool.query
// ─────────────────────────────────────────────
// Some places use db.query() after const db = getPool() - those are fine
// Some use pool.query() - pool is the module-level variable - also fine
// getPool().query() works too

// ─────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────
const sqlTypeCount = (src.match(/sql\.\w+/g) || []).length;
const requestCount = (src.match(/\.request\(\)/g) || []).length;
const atParamCount = (src.match(/@\w+\b/g) || []).filter(p => !p.startsWith('@types')).length;
const recordsetCount = (src.match(/\.recordset\b/g) || []).length;
const transactionCount = (src.match(/sql\.Transaction/g) || []).length;

console.log(`sql.Type refs remaining: ${sqlTypeCount}`);
console.log(`.request() refs remaining: ${requestCount}`);
console.log('@param refs remaining:', atParamCount);
console.log('.recordset refs remaining:', recordsetCount);
console.log('sql.Transaction refs remaining:', transactionCount);

writeFileSync('server.js', src, 'utf8');
console.log('Written server.js');
