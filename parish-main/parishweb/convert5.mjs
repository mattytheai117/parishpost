/**
 * convert5.mjs — Handle "const request = pool.request()" assigned-variable pattern
 * and fix remaining issues in server.js after convert4.mjs
 */
import { readFileSync, writeFileSync } from 'fs';

// Helpers from convert4 (duplicated here for standalone use)
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

function parseInput(str, dotIdx) {
  if (str.slice(dotIdx, dotIdx + 7) !== '.input(') return null;
  const openParen = dotIdx + 6;
  const closeParen = findClose(str, openParen);
  const inner = str.slice(openParen + 1, closeParen);
  const nameMatch = inner.match(/^'([^']+)'/);
  if (!nameMatch) {
    // Try template literal name: `q_${type}` etc — skip these (dynamic)
    const tmplMatch = inner.match(/^`([^`]+)`/);
    if (!tmplMatch) return null;
    return null; // dynamic names — skip
  }
  const name = nameMatch[1];
  let pos = nameMatch[0].length;
  while (pos < inner.length && inner[pos] === ' ') pos++;
  if (inner[pos] !== ',') return null;
  pos++;
  // Skip the sql.Type arg
  let depth = 0;
  while (pos < inner.length) {
    const c = inner[pos];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) break;
    pos++;
  }
  if (inner[pos] !== ',') return null;
  pos++;
  while (pos < inner.length && inner[pos] === ' ') pos++;
  const value = inner.slice(pos).trim();
  return { name, value, end: closeParen + 1 };
}

let src = readFileSync('server.js', 'utf8');

// ─── Fix 1: Syntax error at line ~3115 ────────────────────────────────────────
// Double-quoted SQL string containing "CertificateRequests" — convert to backtick
src = src.replace(
  `"SELECT CertificateRequestId FROM "CertificateRequests" WHERE CertificateRequestId<>$1 AND PreferredDate=$2 AND PreferredTime=$3 AND Status IN ('Confirmed','ReadyForClaim','Claimed')"`,
  '`SELECT "CertificateRequestId" FROM "CertificateRequests" WHERE "CertificateRequestId"<>$1 AND "PreferredDate"=$2 AND "PreferredTime"=$3 AND "Status" IN (\'Confirmed\',\'ReadyForClaim\',\'Claimed\')`'
);

// ─── Fix 2: Convert simple "const request = pool.request(); request.query()" ──
// Pattern: const request = <expr>.request();\n ... await request.query(`...`)
// where there are no .input() calls between them
// Replace with: await <expr>.query(`...`)
src = src.replace(
  /const request = (pool|getPool\(\)|db)\.request\(\);\s*\n(\s*)const result = await request\.query\(/g,
  'const result = await $1.query('
);
src = src.replace(
  /const request = (pool|getPool\(\)|db)\.request\(\);\s*\n(\s*)await request\.query\(/g,
  'await $1.query('
);
// req_obj variant (prayer submit)
src = src.replace(
  /const req_obj = (pool|getPool\(\)|db)\.request\(\)\s*\n((?:\s*\.input\([^;]+\)\s*\n)*)\s*const result = await req_obj\.query\(/g,
  (_, poolExpr, inputs) => `const req_obj = ${poolExpr}.request()\n${inputs}  const result = await req_obj.query(`
);

// ─── Fix 3: Convert single-line "const request = pool.request().input(...)" ──
// Pattern: const request = <expr>.request().input('n', sql.T, val);
//          ...
//          await request.query(`...`)  or  const result = await request.query(`...`)
// This is a two-step: first collect the inputs, then merge with the query call

function convertAssignedRequest(text) {
  // Match: (const request = <expr>.request()<inputs>;)
  // where inputs are chained inline .input() calls
  // Followed later by: (await request.query(`...`)) or (const X = await request.query(`...`))
  // The key insight: variable name may be 'request', 'req_obj', 'updateRequest'

  // Strategy: find all "const VAR = EXPR.request()" declarations, collect their inputs,
  // then find "await VAR.query(...)" and replace the whole thing.

  // We do one pass at a time until no more changes
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 30) {
    changed = false;
    iterations++;

    // Match: const (varName) = (poolExpr).request()INPUTS;\n
    // where INPUTS is zero or more .input(...) calls (possibly multiline)
    const declRe = /const (request|req_obj|updateRequest)\s*=\s*(pool|getPool\(\)|db)\.request\(\)((?:\s*\n?\s*\.input\([^;{]+?\))*)\s*;/gs;

    let match;
    const replacements = [];

    while ((match = declRe.exec(text)) !== null) {
      const varName = match[1];
      const poolExpr = match[2];
      const inputSection = match[3];
      const declStart = match.index;
      const declEnd = match.index + match[0].length;

      // Parse inputs from inputSection
      const params = [];
      const names = [];
      let pos = 0;
      while (pos < inputSection.length) {
        let ws = pos;
        while (ws < inputSection.length && /[\s\n]/.test(inputSection[ws])) ws++;
        if (inputSection.slice(ws, ws + 7) !== '.input(') break;
        const inp = parseInput(inputSection, ws);
        if (!inp) break;
        names.push(inp.name);
        params.push(inp.value);
        pos = inp.end;
      }

      // Now find the corresponding await VAR.query(...) or const X = await VAR.query(...)
      // It must appear after declEnd and before the next function/block boundary
      // Simple heuristic: find first occurrence of varName.query after declEnd
      const querySearchStr = `${varName}.query(`;
      let qIdx = text.indexOf(querySearchStr, declEnd);
      if (qIdx === -1) continue;

      // Make sure there are no additional .input() calls on varName between declEnd and qIdx
      // (those would be dynamic builds — skip)
      const between = text.slice(declEnd, qIdx);
      if (between.includes(`${varName}.input(`)) {
        // Dynamic builder — skip
        continue;
      }

      const queryOpen = qIdx + querySearchStr.length - 1;
      const queryClose = findClose(text, queryOpen);
      const queryArg = text.slice(queryOpen + 1, queryClose);
      const queryCallEnd = queryClose + 1;

      // Replace @name with $N in query arg
      let q = queryArg;
      names.forEach((name, i) => {
        q = q.replace(new RegExp('@' + name + '\\b', 'g'), `$${i + 1}`);
      });

      // Apply SQL rewrites to q (dbo. → "Table", etc.)
      q = q.replace(/\bdbo\.([A-Za-z]\w*)/g, '"$1"');
      q = q.replace(/SYSUTCDATETIME\(\)/g, 'NOW()');
      q = q.replace(/\bGETUTCDATE\(\)/g, 'NOW()');
      q = q.replace(/\bGETDATE\(\)/g, 'NOW()');
      q = q.replace(/OUTPUT INSERTED\.(\w+)/g, 'RETURNING "$1"');
      q = q.replace(/\bN'/g, "'");
      q = q.replace(/\bISNULL\(/g, 'COALESCE(');
      q = q.replace(/SELECT TOP 1\b/g, 'SELECT');
      q = q.replace(/SELECT TOP \(1\)/g, 'SELECT');
      q = q.replace(/\bMustChangePassword\s*=\s*0\b/g, '"MustChangePassword" = FALSE');
      q = q.replace(/\bMustChangePassword\s*=\s*1\b/g, '"MustChangePassword" = TRUE');
      q = q.replace(/\bIsApproved\s*=\s*1\b/g, '"IsApproved" = TRUE');
      q = q.replace(/\bIsApproved\s*=\s*0\b/g, '"IsApproved" = FALSE');
      q = q.replace(/\bShareWithCommunity\s*=\s*1\b/g, '"ShareWithCommunity" = TRUE');

      const paramStr = params.length ? `, [${params.join(', ')}]` : '';
      const newQueryCall = `${poolExpr}.query(${q}${paramStr})`;

      // Figure out what came before varName.query( — was it "const X = await" or "await"?
      // Look backwards from qIdx for "await"
      let prefix = '';
      let searchBack = qIdx - 1;
      while (searchBack >= 0 && /[ \t]/.test(text[searchBack])) searchBack--;
      // Now searchBack points to last non-space before varName.query(
      // We need to remove the declaration and replace the query call
      replacements.push({
        declStart, declEnd,
        queryCallStart: qIdx,
        queryCallEnd,
        newQueryCall,
      });
      changed = true;
    }

    if (replacements.length > 0) {
      // Apply replacements in reverse order (from end to start) to preserve indices
      replacements.sort((a, b) => b.queryCallStart - a.queryCallStart);

      for (const r of replacements) {
        // Replace query call first (higher index)
        text = text.slice(0, r.queryCallStart) + r.newQueryCall + text.slice(r.queryCallEnd);
        // Then remove declaration (lower index) — includes trailing newline
        let removeEnd = r.declEnd;
        if (text[removeEnd] === '\n') removeEnd++;
        text = text.slice(0, r.declStart) + text.slice(removeEnd);
      }
    }
  }

  return text;
}

src = convertAssignedRequest(src);

// ─── Fix 4: Multi-line assigned request (events create/update) ────────────────
// Pattern: const request = pool.request()\n  .input(...)\n  ...\n  .input(...);\n
// followed by: await request.query(`...`) or const result = await request.query(`...`)
// These are the same as Fix 3 but inputs are on separate lines with continuation

// After convertAssignedRequest, any remaining const request = ... with inputs
// that didn't match (because inputs were multiline with continuation) — handle here
// Actually convertAssignedRequest should have caught these. Let's check:

// ─── Fix 5: Remove lingering "const pool = getPool();" where pool is unused ───
// After conversion, some blocks have: const pool = getPool(); but no more pool references
// Leave these — they're harmless

// ─── Fix 6: dbo. in remaining non-template SQL strings ────────────────────────
src = src.replace(/`([^`]*)\bdbo\.([A-Za-z]\w*)([^`]*)`/g, (_, pre, tbl, post) => {
  return '`' + pre + '"' + tbl + '"' + post + '`';
});
// Also in single-quoted strings passed to .query()
src = src.replace(/\.query\('([^']*)dbo\.([A-Za-z]\w*)([^']*)'/g, (_, pre, tbl, post) => {
  return `.query('${pre}"${tbl}"${post}'`;
});

// ─── Fix 7: @param refs still in remaining queries ────────────────────────────
// These are in the dynamic builder blocks — tag them for manual review but leave intact
// Count them:
const atParamRemaining = (src.match(/@[a-zA-Z]\w*/g) || []).length;

// ─── Fix 8: Remove remaining sql. type refs (they should be gone from chains) ──
// These show up in .input() calls still waiting to be removed (dynamic builders)
// Leave — they'll be handled in manual fixup of dynamic sections

// ─── Fix 9: Fix INSERT INTO "Events" column/VALUES order (create event) ────────
// The INSERT had RETURNING before VALUES which is invalid SQL
src = src.replace(
  /INSERT INTO "Events" \(Title, TitleTl, Description, DescriptionTl, Body, BodyTl, EventDate, EventTime, Location, LocationTl, PhotoUrl\)\s*\n\s*RETURNING "EventId"\s*\n\s*VALUES \(@title, @titleTl, @description, @descriptionTl, @detail, @detailTl, @date, @time, @location, @locationTl, @photoUrl\)/,
  `INSERT INTO "Events" ("Title", "TitleTl", "Description", "DescriptionTl", "Body", "BodyTl", "EventDate", "EventTime", "Location", "LocationTl", "PhotoUrl")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING "EventId"`
);

// ─── Fix 10: Event UPDATE — @param refs ──────────────────────────────────────
src = src.replace(
  /SET Title = @title, TitleTl = @titleTl, Description = @description, DescriptionTl = @descriptionTl,\s*\n\s*Body = @detail, BodyTl = @detailTl, EventDate = @date, EventTime = @time,\s*\n\s*Location = @location, LocationTl = @locationTl, PhotoUrl = @photoUrl\s*\n\s*WHERE EventId = @eventId/,
  `SET "Title"=$1,"TitleTl"=$2,"Description"=$3,"DescriptionTl"=$4,"Body"=$5,"BodyTl"=$6,"EventDate"=$7,"EventTime"=$8,"Location"=$9,"LocationTl"=$10,"PhotoUrl"=$11
      WHERE "EventId"=$12`
);

// ─── Fix 11: ServiceRequest verification @requestId ──────────────────────────
src = src.replace(
  /UPDATE dbo\.ServiceRequest\s*\n\s*SET Status = N'Confirmed'\s*\n\s*WHERE ServiceRequestId = @requestId/,
  `UPDATE "ServiceRequest"\n      SET "Status" = 'Confirmed'\n      WHERE "ServiceRequestId" = $1`
);

// ─── Fix 12: PrayerRequests @prayerId, @anonymous, @shareWithCommunity ────────
src = src.replace(
  /DELETE FROM "PrayerRequests"\s*\n\s*WHERE PrayerId = @prayerId/g,
  `DELETE FROM "PrayerRequests"\n      WHERE "PrayerId" = $1`
);
src = src.replace(
  /UPDATE dbo\.PrayerRequests\s*\n\s*SET IsApproved = 1\s*\n\s*WHERE PrayerId = @prayerId/,
  `UPDATE "PrayerRequests"\n      SET "IsApproved" = TRUE\n      WHERE "PrayerId" = $1`
);
src = src.replace(
  /SELECT PrayerId, Name, Category, Request, CreatedAt\s*\n\s*FROM dbo\.PrayerRequests\s*\n\s*WHERE PrayerId = @prayerId AND IsApproved = 1 AND ShareWithCommunity = 1/,
  `SELECT "PrayerId", "Name", "Category", "Request", "CreatedAt"\n      FROM "PrayerRequests"\n      WHERE "PrayerId" = $1 AND "IsApproved" = TRUE AND "ShareWithCommunity" = TRUE`
);
src = src.replace(
  /INSERT INTO dbo\.PrayerRequests \(Name, Category, Request, Anonymous, ShareWithCommunity, CreatedAt, IsApproved\)\s*\n\s*OUTPUT INSERTED\.PrayerId\s*\n\s*VALUES \(@name, @category, @request, @anonymous, @shareWithCommunity, GETDATE\(\), 0\)/,
  `INSERT INTO "PrayerRequests" ("Name","Category","Request","Anonymous","ShareWithCommunity","CreatedAt","IsApproved")\n      VALUES ($1,$2,$3,$4,$5,NOW(),FALSE)\n      RETURNING "PrayerId"`
);
// Also fix the Bit 0/1 JS side for anonymous/shareWithCommunity
src = src.replace(
  ".input('anonymous', sql.Bit, anonymous ? 1 : 0)",
  ".input('anonymous', sql.Bit, anonymous ? true : false)"
);
src = src.replace(
  ".input('shareWithCommunity', sql.Bit, shareWithCommunity ? 1 : 0)",
  ".input('shareWithCommunity', sql.Bit, shareWithCommunity ? true : false)"
);

// ─── Fix 13: ServiceRequest DELETE @requestId ─────────────────────────────────
src = src.replace(
  /DELETE FROM "ServiceRequest"\s*\n\s*WHERE ServiceRequestId = @requestId/,
  `DELETE FROM "ServiceRequest"\n      WHERE "ServiceRequestId" = $1`
);

// ─── Fix 14: ServiceRequest UPDATE status/adminNotes @requestId @status @adminNote
src = src.replace(
  /UPDATE "ServiceRequest"\s*\n\s*SET Status = @status,\s*\n\s*Notes = COALESCE\("Notes", ''\) \|\| \$2,\s*\n\s*VoidedAt = CASE WHEN @status IN \('Voided','VoidedNoShow','Cancelled'\) THEN NOW\(\) ELSE VoidedAt END\s*\n\s*WHERE ServiceRequestId = @requestId/,
  `UPDATE "ServiceRequest"\n        SET "Status"=$2,\n            "Notes"=COALESCE("Notes",'') || $3,\n            "VoidedAt"=CASE WHEN $2 IN ('Voided','VoidedNoShow','Cancelled') THEN NOW() ELSE "VoidedAt" END\n        WHERE "ServiceRequestId"=$1`
);
src = src.replace(
  /UPDATE "ServiceRequest"\s*\n\s*SET Status = @status,\s*\n\s*VoidedAt = CASE WHEN @status IN \('Voided','VoidedNoShow','Cancelled'\) THEN NOW\(\) ELSE VoidedAt END\s*\n\s*WHERE ServiceRequestId = @requestId/,
  `UPDATE "ServiceRequest"\n        SET "Status"=$2,\n            "VoidedAt"=CASE WHEN $2 IN ('Voided','VoidedNoShow','Cancelled') THEN NOW() ELSE "VoidedAt" END\n        WHERE "ServiceRequestId"=$1`
);

// ─── Fix 15: getSlotBookings @serviceId (line ~865-875) ──────────────────────
src = src.replace(
  /SELECT ScheduledDate, ScheduledTime\s*\n\s*FROM dbo\.ServiceRequest\s*\n\s*WHERE ServiceId = @serviceId\s*\n\s*AND Status IN \('PendingVerification', 'Confirmed'\)/,
  `SELECT "ScheduledDate","ScheduledTime"\n        FROM "ServiceRequest"\n        WHERE "ServiceId"=$1\n          AND "Status" IN ('PendingVerification','Confirmed')`
);

// ─── Report ───────────────────────────────────────────────────────────────────
const requestCount = (src.match(/\.request\(\)/g) || []).length;
const atParamCount2 = (src.match(/@[a-zA-Z]\w*/g) || []).length;
const sqlTypeCount = (src.match(/\bsql\.\w+/g) || []).length;
const dboCount = (src.match(/\bdbo\./g) || []).length;

console.log(`.request() refs: ${requestCount}`);
console.log('@param refs: ', atParamCount2);
console.log('sql.Type refs:', sqlTypeCount);
console.log('dbo. refs:', dboCount);

writeFileSync('server.js', src, 'utf8');
console.log('Written.');
