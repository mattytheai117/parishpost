import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { hashAspNetPassword } from '../password-hash.js';

dotenv.config();

const { Pool } = pg;

async function ask(prompt) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => readline.question(prompt, resolve));
  } finally {
    readline.close();
  }
}

function askHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal so the password can be entered without echo.'));
  }

  return new Promise((resolve, reject) => {
    let password = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(password);
    };
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Password entry cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (password.length > 0) {
            password = [...password].slice(0, -1).join('');
            process.stdout.write('\b \b');
          }
        } else if (character >= ' ') {
          password += character;
          process.stdout.write('*');
        }
      }
    };

    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function resetAdminPassword() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL must point to the Supabase PostgreSQL database.');
  }

  const email = (await ask('Admin account email: ')).trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid account email.');
  }

  const operator = (await ask('Your name or email for the audit record: ')).trim();
  if (!operator || operator.length > 256) {
    throw new Error('A name or email of at most 256 characters is required for the audit record.');
  }

  let password = '';
  for (let attempt = 1; ; attempt++) {
    password = await askHidden('New password (8+ characters; shown as *): ');
    const confirmation = await askHidden('Confirm new password: ');
    if (password.length >= 8 && password === confirmation) break;
    const reason = password.length < 8 ? 'must be at least 8 characters' : 'do not match';
    if (attempt >= 3) {
      throw new Error(`The passwords ${reason}. No password was changed.`);
    }
    console.log(`The passwords ${reason}. Try again (${attempt}/3).`);
  }

  const expectedConfirmation = `RESET ${email}`;
  const typedConfirmation = await ask(`This changes only ${email} in the configured Supabase database. Type "${expectedConfirmation}" to continue: `);
  if (typedConfirmation !== expectedConfirmation) {
    throw new Error('Confirmation did not match; no password was changed.');
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'true' },
  });
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    try {
      const accountResult = await client.query(`
          SELECT u."UserId", u."EmailAddress"
          FROM "AspNetUsers" u
          WHERE LOWER(u."EmailAddress") = $1
            AND EXISTS (
              SELECT 1
              FROM "AspNetUserRoles" ur
              INNER JOIN "AspNetRoles" r ON r."RoleId" = ur."RoleId"
              WHERE ur."UserId" = u."UserId" AND r."Name" = 'Admin'
            )
          LIMIT 2
          FOR UPDATE OF u
        `, [email]);

      if (accountResult.rows.length !== 1) {
        throw new Error('Exactly one existing Admin account must match that email. No password was changed.');
      }

      const account = accountResult.rows[0];
      const updateResult = await client.query(
        'UPDATE "AspNetUsers" SET "PasswordHash" = $1 WHERE "UserId" = $2 RETURNING "UserId"',
        [hashAspNetPassword(password), account.UserId],
      );

      if (updateResult.rowCount !== 1) {
        throw new Error('The account was not updated exactly once. No password was changed.');
      }

      await client.query(`
          INSERT INTO "UserManagementAudit" ("ActionName", "TargetUserId", "TargetUserName", "ChangedBy", "Details")
          VALUES ($1, $2, $3, $4, $5)
        `, ['ResetPassword', account.UserId, account.EmailAddress, operator, JSON.stringify({ method: 'local-admin-password-reset' })]);

      await client.query('COMMIT');
      transactionStarted = false;
      console.log(`Password reset completed for ${account.EmailAddress}. The change was recorded in UserManagementAudit.`);
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
        transactionStarted = false;
      }
      throw error;
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  resetAdminPassword().catch((error) => {
    console.error(`Admin password reset failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { askHidden, resetAdminPassword };
