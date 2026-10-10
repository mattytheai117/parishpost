/**
 * convert4.mjs — Final server.js MSSQL → pg conversion
 * Handles nested parens in .input() values correctly.
 */
import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('server.js', 'utf8');

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Find the index of the matching closing paren/bracket, handling nesting and strings. */
function findClose(str, openIdx, open = '(', close = ')') {
  let depth = 1;
  let i = openIdx + 1;
  while (i < str.length && depth > 0) {
    const c = str[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`' || c === '"' || c === "'") {
      const q = c; i++;
      while (i < str.length && str[i] !== q) {
        if (str[i] === '\\') i++;
        i++;
      }
    } else if (c === open) { depth++; }
    else if (c === close) { depth--; }
    i++;
  }
  return i - 1;
}

/**
 * Parse a .input('name', sql.Type, value) call starting at the dot.
 * Returns { name, value, end } or null.
 */
function parseInput(str, dotIdx) {
  const inputPrefix = str.slice(dotIdx, dotIdx + 7);
  if (inputPrefix !== '.input(') return null;
  const openParen = dotIdx + 6;
  const closeParen = findClose(str, openParen);
  const inner = str.slice(openParen + 1, closeParen);
  // inner is: 'name', sql.Type, value
  // First arg: quoted name
  const nameMatch = inner.match(/^'([^']+)'/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  // Skip past first comma (after the name)
  let pos = nameMatch[0].length;
  while (pos < inner.length && inner[pos] === ' ') pos++;
  if (inner[pos] !== ',') return null;
  pos++;
  // Skip the sql.Type(...) arg — find next comma at depth 0
  let depth = 0;
  let typeStart = pos;
  while (pos < inner.length) {
    const c = inner[pos];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) break;
    pos++;
  }
  if (inner[pos] !== ',') return null;
  pos++; // skip comma
  while (pos < inner.length && inner[pos] === ' ') pos++;
  // Remainder is the value
  const value = inner.slice(pos).trim();
  return { name, value, end: closeParen + 1 };
}

/**
 * Convert a .request()[ .input(...)* ].query(`...`) chain starting at chainStart.
 * Returns { replacement, end } or null.
 */
function convertChain(str, chainStart) {
  // str[chainStart..] starts with .request()
  if (str.slice(chainStart, chainStart + 10) !== '.request()') return null;
  let pos = chainStart + 10;

  const params = [];
  const names = [];

  // Consume whitespace and .input() calls
  while (pos < str.length) {
    // Skip whitespace/newlines
    let ws = pos;
    while (ws < str.length && /[\s]/.test(str[ws])) ws++;
    if (str.slice(ws, ws + 7) === '.input(') {
      const inp = parseInput(str, ws);
      if (!inp) break;
      names.push(inp.name);
      params.push(inp.value);
      pos = inp.end;
    } else {
      pos = ws;
      break;
    }
  }

  // Expect .query(...)
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str.slice(pos, pos + 7) !== '.query(') return null;
  const queryOpen = pos + 6;
  const queryClose = findClose(str, queryOpen);
  const queryArg = str.slice(queryOpen + 1, queryClose);
  const end = queryClose + 1;

  // Replace @name with $N in the query arg
  let q = queryArg;
  names.forEach((name, i) => {
    q = q.replace(new RegExp('@' + name + '\\b', 'g'), `$${i + 1}`);
  });

  const paramStr = params.length ? `, [${params.join(', ')}]` : '';
  return { replacement: `.query(${q}${paramStr})`, end };
}

/**
 * Walk the source and convert all .request() chains.
 */
function convertAllChains(source) {
  let result = '';
  let i = 0;
  while (i < source.length) {
    const rIdx = source.indexOf('.request()', i);
    if (rIdx === -1) { result += source.slice(i); break; }
    const chain = convertChain(source, rIdx);
    if (!chain) {
      result += source.slice(i, rIdx + 10);
      i = rIdx + 10;
    } else {
      result += source.slice(i, rIdx) + chain.replacement;
      i = chain.end;
    }
  }
  return result;
}

// ─── PASS 1: Remove MSSQL config block ─────────────────────────────────────

src = src.replace(
  /const dbAuth = \(process\.env\.DB_AUTH[\s\S]*?^}/m,
  ''
);
// fallback pattern
src = src.replace(
  /const dbAuth[\s\S]*?\n} else \{[\s\S]*?config = baseConfig;\n\}/,
  ''
);
src = src.replace(
  /logger\.info\('DB startup config:'[\s\S]*?\}\);\n/,
  ''
);
src = src.replace('await initializePool(config);', 'await initializePool();');

// ─── PASS 2: SQL syntax rewrites inside template literals ───────────────────

// Process template literals only to avoid corrupting JS code
function rewriteTemplateLiterals(text, rewriter) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Skip regular strings and comments
    if (text[i] === '/' && text[i+1] === '/') {
      const end = text.indexOf('\n', i);
      result += text.slice(i, end === -1 ? text.length : end + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text[i] === '/' && text[i+1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      result += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (text[i] === "'" || text[i] === '"') {
      const q = text[i]; let j = i + 1;
      while (j < text.length && text[j] !== q) {
        if (text[j] === '\\') j++;
        j++;
      }
      result += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (text[i] === '`') {
      // Find matching backtick (simple, no nested templates for now)
      let j = i + 1; let depth = 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$' && text[j+1] === '{') { depth++; j += 2; continue; }
        if (text[j] === '}' && depth > 1) { depth--; j++; continue; }
        if (text[j] === '`') { depth--; if (depth > 0) j++; else break; }
        else j++;
      }
      const raw = text.slice(i, j + 1);
      result += rewriter(raw);
      i = j + 1;
      continue;
    }
    result += text[i]; i++;
  }
  return result;
}

function sqlRewriter(tpl) {
  let s = tpl;
  s = s.replace(/\bdbo\.([A-Za-z]\w*)/g, '"$1"');
  s = s.replace(/SYSUTCDATETIME\(\)/g, 'NOW()');
  s = s.replace(/\bGETUTCDATE\(\)/g, 'NOW()');
  s = s.replace(/\bGETDATE\(\)/g, 'NOW()');
  s = s.replace(/OUTPUT INSERTED\.(\w+)/g, 'RETURNING "$1"');
  s = s.replace(/CAST\(NOW\(\) AS date\)/g, 'CURRENT_DATE');
  s = s.replace(/\bN'/g, "'");
  s = s.replace(/\bISNULL\(/g, 'COALESCE(');
  s = s.replace(/CONVERT\(varchar\(10\),\s*(\w+),\s*23\)/g, '$1::date::text');
  s = s.replace(/DATENAME\(month,\s*/g, 'TO_CHAR(');
  s = s.replace(/DATEFROMPARTS\(([^,)]+),\s*([^,)]+),\s*1\)/g,
    (_, y, m) => `MAKE_DATE((${y.trim()})::int, (${m.trim()})::int, 1)`);
  s = s.replace(/DATEDIFF\(year,\s*([^,)]+),\s*([^)]+)\)/g,
    (_, a, b) => `EXTRACT(year FROM age(${b.trim()}, ${a.trim()}))::int`);
  s = s.replace(/\bYEAR\(([^)]+)\)/g, (_, x) => `EXTRACT(year FROM ${x})::int`);
  s = s.replace(/\bMONTH\(([^)]+)\)/g, (_, x) => `EXTRACT(month FROM ${x})::int`);
  s = s.replace(/CAST\(0 AS bit\)/g, 'FALSE');
  s = s.replace(/\bMustChangePassword\s*=\s*0\b/g, '"MustChangePassword" = FALSE');
  s = s.replace(/\bMustChangePassword\s*=\s*1\b/g, '"MustChangePassword" = TRUE');
  s = s.replace(/\bIsApproved\s*=\s*1\b/g, '"IsApproved" = TRUE');
  s = s.replace(/\bIsApproved\s*=\s*0\b/g, '"IsApproved" = FALSE');
  s = s.replace(/\bShareWithCommunity\s*=\s*1\b/g, '"ShareWithCommunity" = TRUE');
  s = s.replace(/\bUpdatedAt\s*=\s*NOW\(\)/g, '"UpdatedAt" = NOW()');
  s = s.replace(/\bAttendanceMarkedAt\s*=\s*NOW\(\)/g, '"AttendanceMarkedAt" = NOW()');
  s = s.replace(/\bVoidedAt\s*=\s*NOW\(\)/g, '"VoidedAt" = NOW()');
  s = s.replace(/\bGeneratedAt\s*=\s*NOW\(\)/g, '"GeneratedAt" = NOW()');
  s = s.replace(/\bUsedAt\s*=\s*NOW\(\)/g, '"UsedAt" = NOW()');
  s = s.replace(/SELECT TOP 1\b/g, 'SELECT');
  s = s.replace(/SELECT TOP \(1\)/g, 'SELECT');
  s = s.replace(/SELECT TOP 200\b/g, 'SELECT');
  s = s.replace(/SELECT TOP 100\b/g, 'SELECT');
  s = s.replace(/SELECT TOP \(@limit\)/g, 'SELECT');
  s = s.replace(/\bIsRead\s*=\s*@isRead\b/g, '"IsRead" = $2');
  s = s.replace(
    /CONCAT\(COALESCE\(Notes,\s*''\),\s*@adminNote\)/g,
    `COALESCE("Notes", '') || $2`
  );
  // MERGE → INSERT ON CONFLICT (finance snapshots)
  s = s.replace(
    /MERGE "FinanceReportSnapshots"[\s\S]*?VALUES \(@type,@start,@end,@income,@expenses,@net,@details,@by\);?/,
    `INSERT INTO "FinanceReportSnapshots" ("ReportType","PeriodStart","PeriodEnd","TotalIncome","TotalExpenses","NetTotal","Details","GeneratedBy")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ("ReportType","PeriodStart","PeriodEnd") DO UPDATE
      SET "TotalIncome"=EXCLUDED."TotalIncome","TotalExpenses"=EXCLUDED."TotalExpenses","NetTotal"=EXCLUDED."NetTotal","Details"=EXCLUDED."Details","GeneratedAt"=NOW(),"GeneratedBy"=EXCLUDED."GeneratedBy"`
  );
  // MERGE → INSERT ON CONFLICT (site content)
  s = s.replace(
    /MERGE "SiteContent"[\s\S]*?VALUES \(@key, @content, @updatedBy\);?/,
    `INSERT INTO "SiteContent" ("ContentKey","ContentJson","UpdatedBy")
          VALUES ($1,$2,$3)
          ON CONFLICT ("ContentKey") DO UPDATE
          SET "ContentJson"=EXCLUDED."ContentJson","UpdatedAt"=NOW(),"UpdatedBy"=EXCLUDED."UpdatedBy"`
  );
  // DECLARE @inserted workaround
  s = s.replace(
    /DECLARE @inserted TABLE \(ServiceRequestId INT\);\s*\nINSERT INTO "ServiceRequest"\s*\(([^)]+)\)\s*\nOUTPUT "ServiceRequestId" INTO @inserted\s*\nVALUES\s*\(([^;]+)\);\s*\nSELECT ServiceRequestId FROM @inserted;/s,
    `INSERT INTO "ServiceRequest" ($1)\n      VALUES ($2)\n      RETURNING "ServiceRequestId"`
  );
  // TO_CHAR needs format string
  s = s.replace(/TO_CHAR\((MAKE_DATE\([^)]+\))\)(?!\s*,)/g, "TO_CHAR($1, 'Month')");
  return s;
}

src = rewriteTemplateLiterals(src, sqlRewriter);

// Also handle single-quoted SQL strings (used in some .query('...') calls)
function rewriteSingleQuotedSql(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Look for .query(' pattern
    if (text.slice(i, i + 8) === ".query('") {
      const qStart = i + 7;
      let j = qStart + 1;
      while (j < text.length && text[j] !== "'") {
        if (text[j] === '\\') j++;
        j++;
      }
      const inner = "'" + sqlRewriter("'" + text.slice(qStart + 1, j) + "'").slice(1, -1) + "'";
      result += '.query(' + inner;
      i = j + 1;
    } else {
      result += text[i]; i++;
    }
  }
  return result;
}
src = rewriteSingleQuotedSql(src);

// ─── PASS 3: Convert .request() chains ─────────────────────────────────────
src = convertAllChains(src);

// ─── PASS 4: Convert result.recordset → result.rows ────────────────────────
src = src.replace(/\.recordset\b/g, '.rows');
src = src.replace(/\.rowsAffected\[0\]/g, '.rowCount');

// ─── PASS 5: Remaining no-input .request().query() ─────────────────────────
src = src.replace(/([\w.()[\]]+?)\.request\(\)\.query\(/g, '$1.query(');
src = src.replace(/db\.request\(\)\.query\(/g, 'db.query(');

// ─── PASS 6: sql.Transaction → pg client ───────────────────────────────────
// Replace declaration
src = src.replace(
  /let transaction;\s*\n\s*let transactionStarted = false;/g,
  'const client = await getPool().connect();\n  let committed = false;'
);
// Replace new sql.Transaction + begin (various forms)
src = src.replace(
  /transaction = new sql\.Transaction\((?:db|getPool\(\))\);\s*\n\s*await transaction\.begin\((?:sql\.ISOLATION_LEVEL\.SERIALIZABLE)?\);\s*\n\s*transactionStarted = true;/g,
  "await client.query('BEGIN');"
);
src = src.replace(
  /transaction = new sql\.Transaction\(db\);\s*\n\s*await transaction\.begin\(sql\.ISOLATION_LEVEL\.SERIALIZABLE\);\s*\n\s*transactionStarted = true;/g,
  "await client.query('BEGIN');"
);
// commit + reset flag
src = src.replace(
  /await transaction\.commit\(\);\s*\n\s*transactionStarted = false;/g,
  "await client.query('COMMIT');\n    committed = true;"
);
// rollback in catch
src = src.replace(
  /if \(transactionStarted\) \{\s*\n\s*try \{ await transaction\.rollback\(\); \} catch \(rollbackError\) \{ logError\(rollbackError, \{ context: '([^']+)' \}\); \}\s*\n\s*\}/g,
  `if (!committed) {\n      try { await client.query('ROLLBACK'); } catch (re) { logError(re, { context: '$1' }); }\n    }`
);
// transaction.request() → client
src = src.replace(/transaction\.request\(\)/g, 'client');
// Add finally { client.release() } — insert before closing } of each catch block
// that contains 'committed'. This is too complex for pure regex; we'll do targeted edits.

// ─── PASS 7: @includeDetails boolean ───────────────────────────────────────
src = src.replace(
  "CASE WHEN @includeDetails = 1 THEN u.EmailAddress ELSE NULL END",
  'CASE WHEN $1 THEN u."EmailAddress" ELSE NULL END'
);
src = src.replace(
  "req.staff.role === 'Admin' ? 1 : 0",
  "req.staff.role === 'Admin'"
);

// ─── PASS 8: DELETE OUTPUT DELETED → two queries ───────────────────────────
src = src.replace(
  /const result = await getPool\(\)\.query\('DELETE FROM "SacramentalArchives" RETURNING "FileUrl" WHERE "ArchiveId"=\$1', \[id\]\);\s*\n\s*const fileUrl = result\.rows\[0\]\?\.FileUrl;/,
  `const _sel = await getPool().query('SELECT "FileUrl" FROM "SacramentalArchives" WHERE "ArchiveId"=$1', [id]);\n    const fileUrl = _sel.rows[0]?.FileUrl;\n    if (!fileUrl) return res.status(404).json({ message: 'Archive entry not found.' });\n    await getPool().query('DELETE FROM "SacramentalArchives" WHERE "ArchiveId"=$1', [id]);`
);
// Remove the now-duplicate "if (!fileUrl)" check that came after in the original
src = src.replace(
  /if \(!fileUrl\) return res\.status\(404\)\.json\(\{ message: 'Archive entry not found\.' \}\);\n\s*if \(String\(fileUrl\)/,
  'if (String(fileUrl)'
);

// ─── PASS 9: Error code ─────────────────────────────────────────────────────
src = src.replace(
  "error?.number === 2601 || error?.number === 2627",
  "error?.code === '23505'"
);

// ─── PASS 10: Fix dynamic table/column references ──────────────────────────
// sacramentalDefinitions uses dbo.${definition.table} — already fixed by dbo. replace
// Dynamic column quoting in saveSacramentalRecord
src = src.replace(
  /`UPDATE dbo\.\$\{definition\.table\}/g,
  '`UPDATE "${definition.table}"'
);
src = src.replace(
  /`SELECT \* FROM dbo\.\$\{definition\.table\}/g,
  '`SELECT * FROM "${definition.table}"'
);
src = src.replace(
  /`DELETE FROM dbo\.\$\{definition\.table\}/g,
  '`DELETE FROM "${definition.table}"'
);
src = src.replace(
  /`INSERT INTO dbo\.\$\{definition\.table\}/g,
  '`INSERT INTO "${definition.table}"'
);
// These were already handled in sqlRewriter for template literals,
// but the backtick-in-JS-code patterns need this fallback

// ─── PASS 11: Fix @param refs that remain in already-converted pool.query calls ──
// These are in single-quoted SQL strings that weren't caught; replace remaining
src = src.replace(/'[^']*@\w+[^']*'/g, (match) => {
  // If this is inside a pool.query() call and still has @params, report but leave
  return match; // conservative - leave for manual check
});

// ─── Report ─────────────────────────────────────────────────────────────────
const sqlTypeCount = (src.match(/\bsql\.\w+/g) || []).length;
const requestCount = (src.match(/\.request\(\)/g) || []).length;
const atParamCount = (src.match(/@[a-zA-Z]\w*/g) || []).length;
const recordsetCount = (src.match(/\.recordset\b/g) || []).length;
const transCount = (src.match(/sql\.Transaction/g) || []).length;

console.log(`sql.Type refs: ${sqlTypeCount}`);
console.log(`.request() refs: ${requestCount}`);
console.log('@param refs: ', atParamCount);
console.log('.recordset refs:', recordsetCount);
console.log('sql.Transaction refs:', transCount);

writeFileSync('server.js', src, 'utf8');
console.log('Written.');
