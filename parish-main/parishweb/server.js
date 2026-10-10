import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import pg from 'pg';
import { Resend } from 'resend';
import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import {
  servicePolicy,
  findScheduleConflict,
  findIntentionConflict,
  financeTransition,
  isNoShowEligible,
  isUnverifiedExpired,
  ALLOWED_REQUEST_STATUSES,
  isAllowedArchiveUpload,
  isValidGalleryContent,
  toCsv,
  OVERRIDABLE_MODULES,
  moduleForPath,
  overrideDecision,
} from './server-rules.js';
import { hashAspNetPassword } from './password-hash.js';

// pg connection pool
const { Pool } = pg;
let pool = null;

async function initializePool() {
  if (pool) return pool;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on('error', (err) => { console.error('Pool error:', err); });
  const client = await pool.connect();
  client.release();
  console.log('Database pool connected');
  return pool;
}

function getPool() {
  if (!pool) throw new Error('Database pool not initialized');
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database pool closed');
  }
}

// Simple logger (fallback)
const logger = {
  info: (msg, data) => console.log('[INFO]', msg, data || ''),
  warn: (msg, data) => console.warn('[WARN]', msg, data || ''),
  error: (msg, data) => console.error('[ERROR]', msg, data || ''),
};

const requestLoggingMiddleware = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
  });
  next();
};

const logError = (msg, data) => logger.error(msg, data);
const logEmail = (msg, data) => logger.info('[EMAIL] ' + msg, data);
const logAuth = (msg, data) => logger.info('[AUTH] ' + msg, data);

let totalRequests = 0;
const metricsMiddleware = (_req, _res, next) => {
  totalRequests += 1;
  next();
};

function dateOnly(value) {
  return value.toISOString().slice(0, 10);
}

function previousCompletedPeriods(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = today.getUTCDay() || 7;
  const currentMonday = new Date(today);
  currentMonday.setUTCDate(today.getUTCDate() - day + 1);
  const weekStart = new Date(currentMonday);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const weekEnd = new Date(currentMonday);
  weekEnd.setUTCDate(weekEnd.getUTCDate() - 1);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return [
    { type: 'Weekly', start: dateOnly(weekStart), end: dateOnly(weekEnd) },
    { type: 'Monthly', start: dateOnly(monthStart), end: dateOnly(monthEnd) },
  ];
}

async function generateFinanceSnapshots() {
  const db = getPool();
  for (const period of previousCompletedPeriods()) {
    const totals = await db.query(`SELECT COALESCE(SUM(CASE WHEN EntryType <> 'Expense' THEN Amount ELSE 0 END), 0) AS income, COALESCE(SUM(CASE WHEN EntryType = 'Expense' THEN Amount ELSE 0 END), 0) AS expenses FROM "FinancialEntries" WHERE EntryDate BETWEEN $1 AND $2 AND Status IN ('Approved','Reconciled')`, [period.start, period.end]);
    const row = totals.rows[0] || { income: 0, expenses: 0 };
    await db.query(`INSERT INTO "FinanceReportSnapshots" ("ReportType","PeriodStart","PeriodEnd","TotalIncome","TotalExpenses","NetTotal","Details","GeneratedBy")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ("ReportType","PeriodStart","PeriodEnd") DO UPDATE
      SET "TotalIncome"=EXCLUDED."TotalIncome","TotalExpenses"=EXCLUDED."TotalExpenses","NetTotal"=EXCLUDED."NetTotal","Details"=EXCLUDED."Details","GeneratedAt"=NOW(),"GeneratedBy"=EXCLUDED."GeneratedBy"`, [period.type, period.start, period.end, Number(row.income || 0), Number(row.expenses || 0), Number(row.income || 0) - Number(row.expenses || 0), JSON.stringify({ generatedAutomatically: true }), 'System']);
  }
}

function startFinanceReportSchedule(intervalHours = 6) {
  const run = () => generateFinanceSnapshots().catch(error => logError(error, { context: 'financeReportSchedule' }));
  run();
  setInterval(run, intervalHours * 60 * 60 * 1000);
}

/**
 * Automatic appointment voiding. Confirmed appointments whose scheduled time
 * has passed without attendance being marked become no-shows, and stale
 * unverified bookings expire so their slots are released (the ActiveSlotKey
 * trigger clears the slot lock for non-active statuses).
 */
async function voidNoShowAppointments() {
  const db = getPool();
  const now = new Date();
  const candidates = await db.query(`
    SELECT ServiceRequestId, Status, ScheduledDate, ScheduledTime, AttendanceStatus, CreatedAt
    FROM "ServiceRequest"
    WHERE Status IN ('Confirmed', 'PendingVerification')
  `);
  const normalized = candidates.rows.map(row => ({
    id: row.ServiceRequestId,
    status: row.Status,
    scheduledDate: row.ScheduledDate,
    scheduledTime: row.ScheduledTime instanceof Date ? formatTime(row.ScheduledTime) : String(row.ScheduledTime || '00:00').slice(0, 5),
    attendanceStatus: row.AttendanceStatus,
    createdAt: row.CreatedAt,
  }));
  const noShows = normalized.filter(row => isNoShowEligible(row, now));
  const expired = normalized.filter(row => isUnverifiedExpired(row, now));
  for (const row of noShows) {
    await db.query(`UPDATE "ServiceRequest" SET Status='VoidedNoShow', AttendanceStatus='NoShow', "AttendanceMarkedAt" = NOW(), "VoidedAt" = NOW() WHERE ServiceRequestId=$1 AND Status='Confirmed'`, [row.id]);
  }
  for (const row of expired) {
    await db.query(`UPDATE "ServiceRequest" SET Status='Voided', "VoidedAt" = NOW() WHERE ServiceRequestId=$1 AND Status='PendingVerification'`, [row.id]);
  }
  if (noShows.length || expired.length) {
    logger.info('Automatic appointment voiding completed', { noShows: noShows.length, expiredUnverified: expired.length });
  }
}

function startNoShowVoidSchedule(intervalMinutes = 60) {
  const run = () => voidNoShowAppointments().catch(error => logError(error, { context: 'noShowVoidSchedule' }));
  run();
  setInterval(run, intervalMinutes * 60 * 1000);
}

const handleHealthCheck = (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
};

const handleMetricsRequest = (_req, res) => {
  res.json({ totalRequests, uptime: process.uptime() });
};

// Token management - using database storage for persistence across restarts
const createVerificationToken = async (requestId) => {
  try {
    const pool = getPool();
    // Generate a secure random token
    const token = randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await pool.query(`
      INSERT INTO "VerificationTokens" (Token, ServiceRequestId, ExpiresAt)
      VALUES ($1, $2, $3)
    `, [token, requestId, expiresAt]);
    return token;
  } catch (error) {
    logError(error, { context: 'createVerificationToken' });
    // Fallback to random string if DB fails (shouldn't happen in production)
    return Math.random().toString(36).substring(2, 15);
  }
};

const verifyToken = async (token) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT ServiceRequestId
      FROM "VerificationTokens"
      WHERE Token = $1
        AND Used = 0
        AND ExpiresAt > NOW()
    `, [token]);

    if (result.rows.length === 0) {
      return null;
    }

    const requestId = result.rows[0].ServiceRequestId;

    // Mark token as used
    await pool.query(`
      UPDATE "VerificationTokens"
      SET Used = 1, "UsedAt" = NOW()
      WHERE Token = $1
    `, [token]);

    return requestId;
  } catch (error) {
    logError(error, { context: 'verifyToken' });
    return null;
  }
};

const startTokenCleanupSchedule = (intervalMinutes = 60) => {
  setInterval(async () => {
    try {
      const pool = getPool();
      await pool.query(`
        DELETE FROM "VerificationTokens"
        WHERE ExpiresAt < NOW()
      `);
      logger.info('Expired verification tokens cleaned up');
    } catch (error) {
      logError(error, { context: 'tokenCleanup' });
    }
  }, intervalMinutes * 60 * 1000);
};

dotenv.config();

const app = express();
const trustProxyHopsValue = process.env.TRUST_PROXY_HOPS ?? '0';
if (!/^\d+$/.test(trustProxyHopsValue) || !Number.isSafeInteger(Number(trustProxyHopsValue))) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
}
app.set('trust proxy', Number(trustProxyHopsValue));

const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' },
});
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again later.' },
});

const contactRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many messages sent. Please try again later.' },
});

const uploadDirectory = path.resolve('uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
  },
});

const archiveUpload = multer({
  storage: upload.storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, isAllowedArchiveUpload(file.originalname, file.mimetype, file.size || 0));
  },
});

// CORS configuration - restrict to frontend origin for security
const frontendOrigin = process.env.FRONTEND_URL || (
  process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'
);
if (!frontendOrigin) {
  throw new Error('FRONTEND_URL must be configured in production.');
}
const corsOptions = {
  origin: frontendOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  maxAge: 3600
};
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// Add logging and monitoring middleware
app.use(requestLoggingMiddleware);
app.use(metricsMiddleware);
app.use('/api', apiRateLimit);

const resend = new Resend(process.env.RESEND_API_KEY);


const adminSecret = process.env.ADMIN_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'letmein');
if (process.env.NODE_ENV === 'production' && !adminSecret) {
  throw new Error('ADMIN_TOKEN must be configured in production.');
}
const staffTokenLifetimeMs = 8 * 60 * 60 * 1000;

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY not configured, skipping email send');
    return null;
  }

  try {
    const response = await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: to,
      subject: subject,
      html: html
    });
    logEmail('sent', {
      to,
      subject,
      messageId: response.id,
      timestamp: new Date().toISOString()
    });
    return response;
  } catch (error) {
    logError(error, {
      action: 'sendEmail',
      to,
      subject
    });
    return null;
  }
}

function formatTime(date) {
  return date.toISOString().slice(11, 16);
}

function createStaffToken(userId, role, expiresAt = Date.now() + staffTokenLifetimeMs) {
  return `${adminSecret}.${userId}.${role}.${expiresAt}`;
}

function parseStaffToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== adminSecret) return null;
  const userId = Number(parts[1]);
  const role = String(parts[2] || '');
  const expiresAt = Number(parts[3]);
  if (!Number.isInteger(userId) || !role || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { userId, role, email: null, expiresAt };
}

const staffRolePriority = ['Admin', 'ParishPriest', 'Secretary', 'Bookkeeper', 'Staff'];

async function requireAdmin(req, res, next) {
  const token = String(req.headers['x-admin-token'] ?? '')
  const staff = parseStaffToken(token);
  if (staff && staff.userId > 0) {
    // Roles can change after sign-in, so use the current database role instead of the one baked into the token.
    try {
      const result = await getPool().query('SELECT r.Name FROM "AspNetUserRoles" ur INNER JOIN "AspNetRoles" r ON r.RoleId = ur.RoleId WHERE ur.UserId = $1', [staff.userId]);
      const names = result.rows.map(row => row.Name);
      const current = staffRolePriority.find(name => names.includes(name));
      if (!current) return res.status(403).json({ message: 'Admin token is required.' });
      staff.role = current;
    } catch (error) {
      logError(error, { context: 'requireAdminRoleRefresh' });
    }
    try {
      const [overrides, account] = await Promise.all([
        getPool().query('SELECT ModuleName, CanView, CanEdit FROM "UserModulePermissions" WHERE UserId = $1', [staff.userId]),
        getPool().query('SELECT MustChangePassword FROM "AspNetUsers" WHERE UserId = $1', [staff.userId]),
      ]);
      staff.overrides = Object.fromEntries(overrides.rows.map(row => [row.ModuleName, { view: Boolean(row.CanView), edit: Boolean(row.CanEdit) }]));
      staff.mustChangePassword = Boolean(account.rows[0]?.MustChangePassword);
    } catch (error) {
      logError(error, { context: 'requireAdminPermissionRefresh' });
    }
    if (staff.mustChangePassword && !passwordChangeExemptPaths.includes(req.path)) {
      return res.status(403).json({ message: 'You must change your password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
  }
  if (!staff) {
    logAuth('failed', {
      endpoint: req.path,
      ip: req.ip,
      reason: token ? 'invalid_token' : 'missing_token'
    });
    return res.status(403).json({ message: 'Admin token is required.' })
  }
  req.staff = staff;
  logAuth('success', {
    endpoint: req.path,
    ip: req.ip
  });
  next()
}

const passwordChangeExemptPaths = ['/api/admin/verify', '/api/admin/change-password'];

function requireRole(roles) {
  return (req, res, next) => {
    if (req.staff && req.staff.role !== 'Admin') {
      const action = req.method === 'GET' || req.method === 'HEAD' ? 'view' : 'edit';
      const decision = overrideDecision(req.staff.overrides, moduleForPath(req.originalUrl), action);
      if (decision === true) return next();
      if (decision === false) {
        return res.status(403).json({ message: 'Your account does not have permission for this operation.' });
      }
    }
    if (!req.staff || (!roles.includes(req.staff.role) && req.staff.role !== 'Admin')) {
      return res.status(403).json({ message: 'Your staff role does not have permission for this operation.' });
    }
    next();
  };
}

function requireAdminWithQueryToken(req, res, next) {
  if (!req.headers['x-admin-token'] && typeof req.query.token === 'string') {
    req.headers['x-admin-token'] = req.query.token;
  }
  return requireAdmin(req, res, next);
}

function verifyAspNetPassword(password, storedHash) {
  try {
    const buffer = Buffer.from(String(storedHash || ''), 'base64');
    if (buffer.length !== 49 || buffer[0] !== 0x01) return false;
    const salt = buffer.subarray(1, 17);
    const storedSubkey = buffer.subarray(17, 49);
    const computedSubkey = pbkdf2Sync(password, salt, 10000, 32, 'sha256');
    return timingSafeEqual(storedSubkey, computedSubkey);
  } catch {
    return false;
  }
}

// Parishioner portal authentication is not yet implemented; reject until a real session/token check exists.
async function requirePortal(req, res, next) {
  const token = String(req.headers['x-portal-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Portal sign-in is required.' });
  try {
    const result = await getPool().query(`SELECT s.AccountId, a.EmailAddress FROM "ParishionerPortalSessions" s JOIN "ParishionerAccounts" a ON a.AccountId=s.AccountId WHERE s.SessionToken=$1 AND s.ExpiresAt>NOW() AND a.IsActive=1`, [token]);
    if (!result.rows[0]) return res.status(401).json({ message: 'Portal session is invalid or expired.' });
    req.portal = result.rows[0];
    next();
  } catch (error) { logError(error, { context: 'requirePortal' }); res.status(500).json({ message: 'Unable to verify portal session.' }); }
}

app.post('/api/portal/register', authRateLimit, async (req, res) => {
  const { firstName, lastName, email, mobileNumber, address, password } = req.body || {};
  if (!firstName || !lastName || !isValidEmail(String(email || '')) || !password || String(password).length < 8) return res.status(400).json({ message: 'Name, valid email, and an eight-character password are required.' });
  try {
    const db = getPool(); const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await db.query('SELECT AccountId FROM "ParishionerAccounts" WHERE EmailAddress=$1', [normalizedEmail]);
    if (existing.rows.length) return res.status(409).json({ message: 'An account already exists for this email.' });
    const parishioner = await db.query('INSERT INTO "Parishioners" (FirstName, LastName, EmailAddress, MobileNumber, Address) RETURNING "ParishionerId" VALUES ($1,$2,$3,$4,$5)', [firstName, lastName, normalizedEmail, mobileNumber || null, address || null]);
    await db.query('INSERT INTO "ParishionerAccounts" (ParishionerId, EmailAddress, PasswordHash) VALUES ($1,$2,$3)', [parishioner.rows[0].ParishionerId, normalizedEmail, hashAspNetPassword(password)]);
    res.status(201).json({ message: 'Portal account created.' });
  } catch (error) { logError(error, { context: 'portalRegister' }); res.status(500).json({ message: 'Unable to create portal account.' }); }
});

app.post('/api/portal/login', authRateLimit, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(); const password = String(req.body?.password || '');
  try {
    const result = await getPool().query('SELECT a.AccountId, a.PasswordHash, a.EmailAddress FROM "ParishionerAccounts" a WHERE a.EmailAddress=$1 AND a.IsActive=1', [email]); const account = result.rows[0];
    if (!account || !verifyAspNetPassword(password, account.PasswordHash)) return res.status(401).json({ message: 'Invalid portal credentials.' });
    const token = randomBytes(32).toString('hex'); await getPool().query('INSERT INTO "ParishionerPortalSessions" (SessionToken, AccountId, ExpiresAt) VALUES ($1,$2,$3)', [token, account.AccountId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]);
    res.json({ token, email: account.EmailAddress });
  } catch (error) { logError(error, { context: 'portalLogin' }); res.status(500).json({ message: 'Unable to sign in to the portal.' }); }
});

app.get('/api/portal/me', requirePortal, async (req, res) => {
  try { const result = await getPool().query(`SELECT a.AccountId, a.EmailAddress, p.FirstName, p.LastName, p.MobileNumber, p.Address FROM "ParishionerAccounts" a JOIN "Parishioners" p ON p.ParishionerId=a.ParishionerId WHERE a.AccountId=$1`, [req.portal.AccountId]); res.json(result.rows[0] || {}); } catch (error) { logError(error, { context: 'portalMe' }); res.status(500).json({ message: 'Unable to load portal profile.' }); }
});

app.get('/api/portal/certificate-requests', requirePortal, async (req, res) => {
  try { const result = await getPool().query('SELECT CertificateRequestId, CertificateType, PreferredDate, PreferredTime, Status, Notes, CreatedAt, UpdatedAt FROM "CertificateRequests" WHERE AccountId=$1 ORDER BY CreatedAt DESC', [req.portal.AccountId]); res.json(result.rows); } catch (error) { logError(error, { context: 'portalCertificateRequests' }); res.status(500).json({ message: 'Unable to load certificate requests.' }); }
});

// -- Guest certificate endpoints (no auth required) --------------------------

const VALID_CERT_TYPES = ['Baptism', 'Confirmation', 'Marriage', 'Death'];

// Configure a separate multer instance for certificate documents (PDF + images)
const certUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(null, allowed);
  },
});

app.post('/api/certificate-requests', async (req, res) => {
  const { firstName, lastName, email, phone, certificateType, preferredDate, preferredTime, notes } = req.body;

  if (!firstName || !lastName || !isValidEmail(String(email || '')) || !phone) {
    return res.status(400).json({ message: 'Please provide your name, email, and phone number.' });
  }
  if (!VALID_CERT_TYPES.includes(certificateType)) {
    return res.status(400).json({ message: 'Please select a valid certificate type.' });
  }
  if (!isValidDate(preferredDate) || !isFutureDate(preferredDate) || !preferredTime) {
    return res.status(400).json({ message: 'Please provide a valid future date and time.' });
  }

  // Generate a 6-char uppercase hex reference code
  const referenceCode = randomBytes(3).toString('hex').toUpperCase();

  try {
    const block = await findBlockedSlot(getPool(), { date: preferredDate, time: preferredTime, certificate: true });
    if (block) return res.status(409).json({ message: blockedMessage(block) });
    const result = await getPool().query(`
        INSERT INTO "CertificateRequests"
          (CertificateType, PreferredDate, PreferredTime, Notes,
           FirstName, LastName, ContactEmail, ContactPhone, ReferenceCode)
        RETURNING "CertificateRequestId"
        VALUES
          ($1, $2, $3, $4,
           $5, $6, $7, $8, $9)
      `, [certificateType, preferredDate, preferredTime, notes ? sanitizeText(notes) : null, sanitizeText(firstName), sanitizeText(lastName), String(email).trim().toLowerCase(), sanitizeText(phone), referenceCode]);

    const requestId = result.rows[0].CertificateRequestId;

    // Send confirmation email if configured
    const emailHtml = `
      <div style="font-family: Georgia, 'Times New Roman', serif; background-color: #f9f6f0; margin: 0; padding: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-top: 4px solid #8b1a1a;">

          <!-- Header -->
          <div style="background-color: #8b1a1a; padding: 32px 40px 28px; text-align: center;">
            <p style="margin: 0 0 4px; font-family: Georgia, serif; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: #f0c96e;">Saint John Parish</p>
            <h1 style="margin: 0; font-family: Georgia, serif; font-size: 24px; font-weight: normal; color: #ffffff; letter-spacing: 0.5px;">Certificate Request Received</h1>
          </div>

          <!-- Body -->
          <div style="padding: 36px 40px 28px;">
            <p style="margin: 0 0 20px; font-size: 16px; color: #2c2c2c; line-height: 1.6;">Dear ${escapeHtml(firstName)},</p>
            <p style="margin: 0 0 28px; font-size: 15px; color: #444444; line-height: 1.7;">
              We have received your request for a <strong style="color: #1a1a1a;">${escapeHtml(certificateType)}</strong> certificate.
              The parish office will review your request and confirm your appointment shortly.
            </p>

            <!-- Details card -->
            <div style="background-color: #faf8f4; border-left: 3px solid #8b1a1a; border-radius: 0 6px 6px 0; padding: 24px 28px; margin: 0 0 28px;">
              <p style="margin: 0 0 6px; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #888888;">Your Reference Code</p>
              <p style="margin: 0 0 20px; font-family: 'Courier New', monospace; font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #8b1a1a;">${escapeHtml(referenceCode)}</p>
              <table style="width: 100%; border-collapse: collapse; font-size: 14px; border-top: 1px solid #ede8df;">
                <tr>
                  <td style="padding: 10px 0 7px; color: #888888; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; vertical-align: top; padding-right: 20px;">Preferred Date</td>
                  <td style="padding: 10px 0 7px; color: #1a1a1a; font-size: 15px;">${escapeHtml(preferredDate)}</td>
                </tr>
                <tr>
                  <td style="padding: 7px 0; color: #888888; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; vertical-align: top; padding-right: 20px; border-top: 1px solid #ede8df;">Preferred Time</td>
                  <td style="padding: 7px 0; color: #1a1a1a; font-size: 15px; border-top: 1px solid #ede8df;">${escapeHtml(preferredTime)}</td>
                </tr>
              </table>
            </div>

            <p style="margin: 0 0 28px; font-size: 15px; color: #444444; line-height: 1.7;">
              Keep your reference code safe — you can use it to check the status of your request anytime on the Services page.
            </p>

            <p style="margin: 0; font-size: 13px; color: #888888; line-height: 1.6; font-family: Arial, sans-serif;">
              If you did not submit this request, you can safely ignore this email. For any concerns, please contact the parish office directly.
            </p>
          </div>

          <!-- Footer -->
          <div style="background-color: #f2ede4; border-top: 1px solid #e0d8cc; padding: 20px 40px; text-align: center;">
            <p style="margin: 0; font-family: Arial, sans-serif; font-size: 12px; color: #888888; line-height: 1.6;">
              Saint John Parish &nbsp;·&nbsp; This is an automated message, please do not reply directly to this email.
            </p>
          </div>

        </div>
      </div>
    `;
    await sendEmail(String(email).trim().toLowerCase(), 'Certificate Request Received', emailHtml);

    res.status(201).json({ requestId, referenceCode });
  } catch (error) {
    logError(error, { context: 'createCertificateRequest' });
    res.status(500).json({ message: 'Unable to submit your certificate request.' });
  }
});

app.post('/api/certificate-requests/:id/documents', (req, res, next) => {
  certUpload.array('documents', 5)(req, res, error => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Each file must be smaller than 10 MB.'
        : 'Unable to upload one or more files.';
      return res.status(400).json({ message });
    }
    if (error) return res.status(400).json({ message: 'Only PDF and image files are accepted.' });
    next();
  });
}, async (req, res) => {
  const requestId = Number(req.params.id);
  const referenceCode = String(req.body.referenceCode || '').toUpperCase();

  if (!Number.isInteger(requestId) || requestId <= 0 || !referenceCode) {
    return res.status(400).json({ message: 'Invalid request.' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: 'Please select at least one file.' });
  }

  try {
    // Verify ownership by matching requestId + referenceCode
    const check = await getPool().query(`SELECT CertificateRequestId FROM "CertificateRequests" WHERE CertificateRequestId = $1 AND ReferenceCode = $2`, [requestId, referenceCode]);

    if (check.rows.length === 0) {
      return res.status(403).json({ message: 'Reference code does not match this request.' });
    }

    const db = getPool();
    for (const file of req.files) {
      await db.query(`
          INSERT INTO "CertificateRequestDocuments"
            (CertificateRequestId, OriginalFileName, StoredFileName, FileUrl, MimeType, FileSizeBytes)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [requestId, file.originalname, file.filename, `/uploads/${file.filename}`, file.mimetype, file.size]);
    }

    res.json({ message: `${req.files.length} document(s) uploaded successfully.` });
  } catch (error) {
    logError(error, { context: 'uploadCertificateDocuments' });
    res.status(500).json({ message: 'Unable to save uploaded documents.' });
  }
});

app.get('/api/certificate-requests/lookup', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const ref = String(req.query.ref || '').toUpperCase();

  if (!isValidEmail(email) || !ref) {
    return res.status(400).json({ message: 'Please provide your email and reference code.' });
  }

  try {
    const result = await getPool().query(`
        SELECT CertificateType, PreferredDate, PreferredTime, Status, Notes
        FROM "CertificateRequests"
        WHERE ContactEmail = $1 AND ReferenceCode = $2
      `, [email, ref]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No request found. Check your email and reference code.' });
    }

    const row = result.rows[0];
    res.json({
      certificateType: row.CertificateType,
      preferredDate: row.PreferredDate,
      preferredTime: row.PreferredTime,
      status: row.Status,
      notes: row.Notes,
    });
  } catch (error) {
    logError(error, { context: 'lookupCertificateRequest' });
    res.status(500).json({ message: 'Unable to look up your request.' });
  }
});

app.post('/api/admin/uploads', requireAdmin, (req, res, next) => {
  upload.single('photo')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Photo must be smaller than 5 MB.'
        : 'Unable to upload the selected photo.';
      return res.status(400).json({ message });
    }

    if (error) {
      return res.status(400).json({ message: 'Only image files can be uploaded.' });
    }

    next();
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Please select an image file.' });
  }

  res.status(201).json({ photoUrl: `/uploads/${req.file.filename}` });
});

// Public access is limited to files referenced by an event or published site content.
app.get('/uploads/:filename', async (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ message: 'Invalid file name.' });
  }

  try {
    const result = await getPool().query(`
        SELECT 1 AS found
        WHERE EXISTS (SELECT 1 FROM "Events" WHERE PhotoUrl = $1)
           OR EXISTS (
             SELECT 1 FROM "SiteContent"
             WHERE ContentKey IN ('about', 'gallery') AND ContentJson LIKE '%' + $1 + '%'
           )
      `, [`/uploads/${filename}`]);
    const filePath = path.join(uploadDirectory, filename);
    if (result.rows.length === 0 || !fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Photo not found.' });
    }
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.sendFile(filePath);
  } catch (error) {
    logError(error, { context: 'serveEventPhoto' });
    return res.status(500).json({ message: 'Unable to load photo.' });
  }
});

function formatEventDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Input validation helpers
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidPhoneNumber(phone) {
  // Accept basic phone format: at least 10 digits
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.length >= 10;
}

function isValidDate(dateStr) {
  const date = new Date(dateStr);
  return !Number.isNaN(date.getTime());
}

function isFutureDate(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

async function getServicePolicy(pool, serviceId, scheduledDate) {
  const result = await pool.query('SELECT Name FROM "Service" WHERE ServiceId=$1', [serviceId]);
  const service = result.rows[0];
  return { name: service?.Name || '', ...servicePolicy(service?.Name, scheduledDate) };
}

async function quotaCount(pool, serviceId, scheduledDate) {
  const result = await pool.query(`SELECT COUNT(*) AS total FROM "ServiceRequest" WHERE ServiceId=$1 AND ScheduledDate=$2 AND Status IN ('PendingVerification','Confirmed')`, [serviceId, scheduledDate]);
  return Number(result.rows[0]?.total || 0);
}

// Returns the first admin block covering this date/time, or null. A null BlockTime blocks the whole day.
async function findBlockedSlot(pool, { date, time, serviceId = null, certificate = false }) {
  const result = await pool.query(`SELECT Reason FROM "BlockedSlots"
      WHERE BlockDate=$1
        AND (BlockTime IS NULL OR BlockTime=$2)
        AND (Scope='All' OR (Scope='Certificate' AND $4=1) OR (Scope='Service' AND ServiceId=$3))`, [date, time ? String(time).slice(0, 5) : null, serviceId, certificate ? 1 : 0]);
  return result.rows[0] || null;
}

function blockedMessage(block) {
  return block?.Reason ? `This date or time is unavailable: ${block.Reason}` : 'This date or time is unavailable for booking.';
}

function sanitizeText(text) {
  return String(text).trim().slice(0, 500);
}

function escapeHtml(text) {
  const htmlMap = {
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, char => htmlMap[char]);
}

app.get('/api/services', async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT ServiceId, Name, Description
      FROM "Service"
      WHERE IsActive = 1
      ORDER BY Name
    `);

    const services = result.rows.map(row => ({
      id: row.ServiceId,
      name: row.Name,
      description: row.Description,
    }));

    res.json(services);
  } catch (error) {
    console.error('Services lookup error:', error);
    res.status(500).json({
      message: 'Unable to load services.',
    });
  }
});

app.get('/api/services/:serviceId/slots', async (req, res) => {
  const { serviceId } = req.params;
  const date = req.query.date ? String(req.query.date) : null;
  const startDate = date ? new Date(date) : new Date();

  const slotTimes = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
  const daysToShow = 30;
  const requestedDate = new Date(startDate);

  let bookedSet = new Set();
  let quotaFullDates = new Set();
  let blocks = [];
  let policy = { name: '' };
  const numericServiceId = Number(serviceId);
  const useServiceId = Number.isInteger(numericServiceId) && String(numericServiceId) === serviceId;

  try {
    if (useServiceId) {
      const pool = getPool();
      policy = await getServicePolicy(pool, numericServiceId, requestedDate.toISOString().slice(0, 10));
      const bookedResult = await pool.query(`
        SELECT "ScheduledDate", "ScheduledTime"
        FROM "ServiceRequest"
        WHERE "ServiceId" = $1
          AND "Status" IN ('PendingVerification', 'Confirmed')
      `, [numericServiceId]);

      if (policy.quota) {
        const quotaResult = await pool.query(`SELECT CONVERT(varchar(10), ScheduledDate, 23) AS scheduledDate, COUNT(*) AS total FROM "ServiceRequest" WHERE ServiceId=$1 AND Status IN ('PendingVerification','Confirmed') GROUP BY ScheduledDate`, [numericServiceId]);
        quotaFullDates = new Set(quotaResult.rows.filter(row => Number(row.total) >= policy.quota).map(row => row.scheduledDate));
      }

      const blockResult = await pool.query(`SELECT CONVERT(varchar(10), BlockDate, 23) AS blockDate, BlockTime, Reason FROM "BlockedSlots" WHERE BlockDate >= CAST(SYSUTCDATETIME() AS date) AND (Scope='All' OR (Scope='Service' AND ServiceId=$1))`, [numericServiceId]);
      blocks = blockResult.rows;

      bookedSet = new Set(bookedResult.rows.map((row) => {
        const timeText = row.ScheduledTime instanceof Date
          ? formatTime(row.ScheduledTime)
          : String(row.ScheduledTime).slice(0, 5);
        const dateText = row.ScheduledDate instanceof Date
          ? row.ScheduledDate.toISOString().slice(0, 10)
          : String(row.ScheduledDate).slice(0, 10);
        return `${dateText}|${timeText}`;
      }));
    }

    const slots = [];
    const slotDate = new Date(
      requestedDate.getFullYear(),
      requestedDate.getMonth(),
      requestedDate.getDate(),
    );
    let weekdayCount = 0;
    while (weekdayCount < daysToShow) {
      const dayOfWeek = slotDate.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        const isoDate = [
          slotDate.getFullYear(),
          String(slotDate.getMonth() + 1).padStart(2, '0'),
          String(slotDate.getDate()).padStart(2, '0'),
        ].join('-');
        const policyForDate = servicePolicy(policy.name, isoDate);
        slotTimes.forEach(time => {
          const key = `${isoDate}|${time}`;
          const quotaFull = quotaFullDates.has(isoDate);
          const block = blocks.find(b => b.blockDate === isoDate && (!b.BlockTime || b.BlockTime === time));
          slots.push({ date: isoDate, time, available: policyForDate.allowed && !quotaFull && !block && !bookedSet.has(key), restricted: !policyForDate.allowed || quotaFull || !!block, message: policyForDate.message || (quotaFull ? `Daily booking limit reached for ${policy.quotaLabel}.` : block ? blockedMessage(block) : undefined) });
        });
        weekdayCount += 1;
      }
      slotDate.setDate(slotDate.getDate() + 1);
    }

    const restrictionMessage = slots.find(slot => slot.restricted)?.message;
    res.json({ serviceId, slots, restrictionMessage });
  } catch (error) {
    console.error('Slot lookup error:', error);
    res.status(500).json({ message: 'Unable to load available slots.' });
  }
});

// Maps a service name to its typed detail table so sacrament-specific answers can be persisted.
const SACRAMENT_DETAIL_TABLES = {
  'Baptism': { table: 'BaptismRequestDetail', columns: ['ChildFirstName', 'ChildMiddleName', 'ChildLastName', 'ChildDateOfBirth', 'PlaceOfBirth', 'FatherFullName', 'MotherFullName', 'GodfatherName', 'GodmotherName'] },
  'Marriage': { table: 'MarriageRequestDetail', columns: ['GroomFirstName', 'GroomMiddleName', 'GroomLastName', 'GroomAge', 'BrideFirstName', 'BrideMiddleName', 'BrideLastName', 'BrideAge', 'CenomarNumber', 'Witnesses'] },
  'Confirmation': { table: 'ConfirmationRequestDetail', columns: ['CandidateFirstName', 'CandidateMiddleName', 'CandidateLastName', 'CandidateDateOfBirth', 'SponsorName', 'ParishOfBaptism'] },
  'Funeral Mass': { table: 'FuneralRequestDetail', columns: ['DeceasedFirstName', 'DeceasedMiddleName', 'DeceasedLastName', 'DateOfDeath', 'RelationshipToDeceased', 'PlaceOfWake'] },
  'House Blessing': { table: 'HouseBlessingRequestDetail', columns: ['FullAddress', 'Landmark', 'PreferredContactPerson'] },
};

// Persists the sacrament-specific answers a parishioner submitted, using the matching column when one
// exists and stashing anything else (including admin-added custom fields) in ExtraFieldsJson.
async function saveSacramentDetails(pool, serviceName, serviceRequestId, details) {
  const mapping = SACRAMENT_DETAIL_TABLES[serviceName];
  if (!mapping || !details || typeof details !== 'object') return;

  const columnByKey = new Map(mapping.columns.map(col => [col.charAt(0).toLowerCase() + col.slice(1), col]));
  const extras = {};
  const providedColumns = new Set();
  // Build positional param values: $1 = serviceRequestId, $2..$N = mapped columns, $N+1 = extraFieldsJson
  const colValues = [];

  for (const [key, value] of Object.entries(details)) {
    const column = columnByKey.get(key);
    if (column) {
      providedColumns.add(column);
    } else {
      extras[key] = value;
    }
  }

  // Collect column values in definition order (null for any not provided)
  for (const col of mapping.columns) {
    const key = col.charAt(0).toLowerCase() + col.slice(1);
    const rawVal = details[key];
    colValues.push(rawVal == null ? null : String(rawVal).slice(0, 4000));
  }
  const extraFieldsJson = Object.keys(extras).length ? JSON.stringify(extras) : null;

  // $1 = serviceRequestId, $2..$N = column values, $N+1 = extraFieldsJson
  const params = [serviceRequestId, ...colValues, extraFieldsJson];
  const columnList = mapping.columns.map(c => `"${c}"`).join(', ');
  const paramList = mapping.columns.map((_, i) => `$${i + 2}`).join(', ');

  await pool.query(`
    INSERT INTO "${mapping.table}" ("ServiceRequestId", ${columnList}, "ExtraFieldsJson")
    VALUES ($1, ${paramList}, $${params.length})
  `, params);
}

app.get('/api/services/:serviceId/fields', async (req, res) => {
  const numericServiceId = Number(req.params.serviceId);
  if (!Number.isInteger(numericServiceId) || numericServiceId <= 0) {
    return res.status(400).json({ message: 'Invalid service ID.' });
  }
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT FieldKey, Label, FieldType, OptionsJson, IsRequired, SortOrder
      FROM "ServiceFieldDefinition"
      WHERE ServiceId = $1 AND IsActive = 1
      ORDER BY SortOrder, FieldDefinitionId
    `, [numericServiceId]);
    const fields = result.rows.map(row => ({
      key: row.FieldKey,
      label: row.Label,
      type: row.FieldType,
      options: row.OptionsJson ? JSON.parse(row.OptionsJson) : undefined,
      required: !!row.IsRequired,
    }));
    res.json({ fields });
  } catch (error) {
    console.error('Field definitions lookup error:', error);
    res.status(500).json({ message: 'Unable to load form fields.' });
  }
});

app.post('/api/service-requests', async (req, res) => {
  const { serviceId, firstName, lastName, email, mobileNumber, address, scheduledDate, scheduledTime, notes, details } = req.body;

  if (!serviceId || !firstName || !lastName || !email || !scheduledDate || !scheduledTime) {
    return res.status(400).json({ message: 'Missing required booking fields.' });
  }

  // Validate email format
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Please provide a valid email address.' });
  }

  // Validate phone number
  if (mobileNumber && !isValidPhoneNumber(mobileNumber)) {
    return res.status(400).json({ message: 'Please provide a valid phone number.' });
  }

  // Validate scheduled date
  if (!isValidDate(scheduledDate)) {
    return res.status(400).json({ message: 'Please provide a valid date.' });
  }

  // Validate date is not in the past
  if (!isFutureDate(scheduledDate)) {
    return res.status(400).json({ message: 'Scheduled date must be in the future.' });
  }

  // Validate serviceId is numeric
  const numericServiceId = Number(serviceId);
  if (!Number.isInteger(numericServiceId) || numericServiceId <= 0) {
    return res.status(400).json({ message: 'Invalid service ID.' });
  }

  try {
    const pool = getPool();
    const policy = await getServicePolicy(pool, numericServiceId, scheduledDate);
    if (!policy.allowed) return res.status(400).json({ message: policy.message });
    const block = await findBlockedSlot(pool, { date: scheduledDate, time: scheduledTime, serviceId: numericServiceId });
    if (block) return res.status(409).json({ message: blockedMessage(block) });
    if (policy.quota && await quotaCount(pool, numericServiceId, scheduledDate) >= policy.quota) {
      return res.status(409).json({ message: `${policy.quotaLabel} bookings are limited to ${policy.quota} per day.` });
    }
    const booked = await pool.query(`SELECT TOP 1 ServiceRequestId FROM "ServiceRequest" WHERE ServiceId=$1 AND ScheduledDate=$2 AND ScheduledTime=$3 AND Status IN ('PendingVerification','Confirmed')`, [numericServiceId, scheduledDate, scheduledTime]);
    if (booked.rows.length) return res.status(409).json({ message: 'That appointment slot is already booked.' });

    // Step 1: Check if parishioner exists
    const parishionerLookup = pool.query(`
      SELECT ParishionerId
      FROM "Parishioners"
      WHERE EmailAddress = $1
    `, [email]);
    let existingParishioner = await parishionerLookup;

    if (existingParishioner.rows.length === 0 && mobileNumber) {
      existingParishioner = await pool.query(`
        SELECT ParishionerId
        FROM "Parishioners"
        WHERE MobileNumber = $1
      `, [mobileNumber]);
    }

    let parishionerId;
    if (existingParishioner.rows.length > 0) {
      parishionerId = existingParishioner.rows[0].ParishionerId;
      // Update parishioner table with latest contact info for account profile
      await pool.query(`
        UPDATE "Parishioners"
        SET FirstName = $1, LastName = $2, Address = $3, EmailAddress = $4, MobileNumber = $5
        WHERE ParishionerId = $6
      `, [firstName, lastName, address || null, email, mobileNumber || null, parishionerId]);
    } else {
      const insertResult = await pool.query(`
        INSERT INTO "Parishioners" (FirstName, LastName, EmailAddress, MobileNumber, Address, CreatedAt)
        OUTPUT INSERTED.ParishionerId
        VALUES ($1, $2, $3, $4, $5, GETDATE())
      `, [firstName, lastName, email, mobileNumber || null, address || null]);
      parishionerId = insertResult.rows[0].ParishionerId;
    }

    // Step 2: Save the submitted contact details with this booking.
    const insertRequest = await pool.query(`
      INSERT INTO "ServiceRequest"
        ("ParishionerId", "ServiceId", "RequestDate", "ScheduledDate", "ScheduledTime", "Venue", "Status", "Notes", "CreatedAt",
         "ContactFirstName", "ContactLastName", "ContactEmail", "ContactMobile", "ContactAddress")
      VALUES
        ($1, $2, NOW(), $3, $4, '', 'PendingVerification', $5, NOW(),
         $6, $7, $8, $9, $10)
      RETURNING "ServiceRequestId"
    `, [parishionerId, numericServiceId, scheduledDate, scheduledTime, notes || null, firstName, lastName, email, mobileNumber || null, address || null]);

    const requestId = insertRequest.rows[0].ServiceRequestId;
    try {
      await saveSacramentDetails(pool, policy.name, requestId, details);
    } catch (error) {
      // Keep the appointment usable when an optional detail-table migration is stale.
      logError(error, { context: 'saveSacramentDetails', requestId, serviceId: numericServiceId });
    }
    const token = await createVerificationToken(requestId);

    const verificationLink = `${req.protocol}://${req.get('host')}/api/service-requests/verify?token=${token}`;

    // Send confirmation email
    const emailHtml = `
      <div style="font-family: Georgia, 'Times New Roman', serif; background-color: #f9f6f0; margin: 0; padding: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-top: 4px solid #8b1a1a;">

          <!-- Header -->
          <div style="background-color: #8b1a1a; padding: 32px 40px 28px; text-align: center;">
            <p style="margin: 0 0 4px; font-family: Georgia, serif; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: #f0c96e;">Saint John Parish</p>
            <h1 style="margin: 0; font-family: Georgia, serif; font-size: 24px; font-weight: normal; color: #ffffff; letter-spacing: 0.5px;">Service Booking Confirmation</h1>
          </div>

          <!-- Body -->
          <div style="padding: 36px 40px 28px;">
            <p style="margin: 0 0 20px; font-size: 16px; color: #2c2c2c; line-height: 1.6;">Dear ${escapeHtml(firstName)},</p>
            <p style="margin: 0 0 28px; font-size: 15px; color: #444444; line-height: 1.7;">
              Thank you for reaching out to Saint John Parish. We have received your service booking and it is now pending verification. Please find your booking details below.
            </p>

            <!-- Details card -->
            <div style="background-color: #faf8f4; border-left: 3px solid #8b1a1a; border-radius: 0 6px 6px 0; padding: 24px 28px; margin: 0 0 28px;">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                  <td style="padding: 7px 0; color: #888888; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; vertical-align: top; padding-right: 20px;">Booking&nbsp;ID</td>
                  <td style="padding: 7px 0; color: #1a1a1a; font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold;">${escapeHtml(String(requestId))}</td>
                </tr>
                <tr>
                  <td style="padding: 7px 0; color: #888888; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; vertical-align: top; padding-right: 20px; border-top: 1px solid #ede8df;">Date</td>
                  <td style="padding: 7px 0; color: #1a1a1a; font-size: 15px; border-top: 1px solid #ede8df;">${escapeHtml(scheduledDate)}</td>
                </tr>
                <tr>
                  <td style="padding: 7px 0; color: #888888; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; vertical-align: top; padding-right: 20px; border-top: 1px solid #ede8df;">Time</td>
                  <td style="padding: 7px 0; color: #1a1a1a; font-size: 15px; border-top: 1px solid #ede8df;">${escapeHtml(scheduledTime)}</td>
                </tr>
                ${notes ? `
                <tr>
                  <td style="padding: 7px 0; color: #888888; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; vertical-align: top; padding-right: 20px; border-top: 1px solid #ede8df;">Notes</td>
                  <td style="padding: 7px 0; color: #1a1a1a; font-size: 14px; line-height: 1.5; border-top: 1px solid #ede8df;">${escapeHtml(notes)}</td>
                </tr>` : ''}
              </table>
            </div>

            <!-- Verify CTA -->
            <p style="margin: 0 0 16px; font-size: 15px; color: #444444; line-height: 1.7;">
              To confirm your booking, please click the button below. Your booking will not be finalized until it has been verified.
            </p>
            <div style="text-align: center; margin: 28px 0 32px;">
              <a href="${verificationLink}" style="display: inline-block; background-color: #8b1a1a; color: #ffffff; text-decoration: none; font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 14px 36px; border-radius: 3px;">Verify My Booking</a>
            </div>

            <p style="margin: 0; font-size: 13px; color: #888888; line-height: 1.6; font-family: Arial, sans-serif;">
              If you did not make this booking, you can safely ignore this email. For any changes or concerns, please contact the parish office directly.
            </p>
          </div>

          <!-- Footer -->
          <div style="background-color: #f2ede4; border-top: 1px solid #e0d8cc; padding: 20px 40px; text-align: center;">
            <p style="margin: 0; font-family: Arial, sans-serif; font-size: 12px; color: #888888; line-height: 1.6;">
              Saint John Parish &nbsp;·&nbsp; This is an automated message, please do not reply directly to this email.
            </p>
          </div>

        </div>
      </div>
    `;

    await sendEmail(email, 'Service Booking Confirmation', emailHtml);

    res.json({ requestId, status: 'PendingVerification', verificationLink });
  } catch (error) {
    console.error('Booking error:', error);
    res.status(500).json({ message: 'Unable to create booking.' });
  }
});

app.get('/api/service-requests/verify', async (req, res) => {
  const token = String(req.query.token || '');

  if (!token) {
    return res.status(400).json({ message: 'Verification token is required.' });
  }

  try {
    const requestId = await verifyToken(token);

    if (!requestId) {
      return res.status(400).json({ message: 'Invalid or expired verification token.' });
    }

    const pool = getPool();
    
    await pool.query(`
      UPDATE "ServiceRequest"
      SET Status = 'Confirmed'
      WHERE ServiceRequestId = $1
    `, [requestId]);

    res.json({ message: 'Booking verified and confirmed.' });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ message: 'Unable to verify booking.' });
  }
});

const VATICAN_NEWS_RSS_URL = 'https://www.vaticannews.va/en.rss.xml';
const VATICAN_NEWS_CACHE_TTL_MS = 15 * 60 * 1000;
let vaticanNewsCache = { data: null, fetchedAt: 0 };

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractRssTag(itemXml, tag) {
  const match = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!match) return '';
  const raw = match[1].trim();
  const cdataMatch = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeXmlEntities((cdataMatch ? cdataMatch[1] : raw).trim());
}

function summarizeRssDescription(description) {
  return description
    .replace(/<a[^>]*>\s*Read all\s*<\/a>/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchVaticanNews() {
  const now = Date.now();
  if (vaticanNewsCache.data && now - vaticanNewsCache.fetchedAt < VATICAN_NEWS_CACHE_TTL_MS) {
    return vaticanNewsCache.data;
  }

  const response = await fetch(VATICAN_NEWS_RSS_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Vatican News feed returned status ${response.status}`);
  const xml = await response.text();

  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const news = items.slice(0, 6).map((item, index) => {
    const title = extractRssTag(item, 'title');
    const description = extractRssTag(item, 'description');
    const link = extractRssTag(item, 'link');
    const pubDate = extractRssTag(item, 'pubDate');
    const imageMatch = item.match(/<media:content[^>]*url="([^"]+)"/);
    const parsedDate = pubDate ? new Date(pubDate) : new Date();

    return {
      id: `vatican-news-${index}`,
      title,
      summary: summarizeRssDescription(description),
      date: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
      link,
      imageUrl: imageMatch ? imageMatch[1] : '',
    };
  });

  vaticanNewsCache = { data: news, fetchedAt: now };
  return news;
}

app.get('/api/vatican-news', async (_req, res) => {
  try {
    const news = await fetchVaticanNews();
    res.json(news);
  } catch (error) {
    logError(error, { context: 'vaticanNewsFeed' });
    res.status(502).json({ message: 'Unable to load Vatican News right now.' });
  }
});

app.get('/api/events', async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(`SELECT * FROM "Events" ORDER BY "EventDate"`);

    const events = result.rows
      .map((row, index) => {
        const id = row.EventId ?? row.Id ?? row.ID ?? row.id ?? 'event-' + index;
        const title = row.Title ?? row.Name ?? row.title ?? 'Untitled event';
        const titleTl = row.TitleTl ?? row.titleTl ?? '';
        const description = row.Description ?? row.description ?? row.Body ?? row.body ?? '';
        const descriptionTl = row.DescriptionTl ?? row.descriptionTl ?? '';
        const detail = row.Body ?? row.body ?? row.Detail ?? row.detail ?? '';
        const detailTl = row.BodyTl ?? row.bodyTl ?? row.DetailTl ?? row.detailTl ?? '';
        const dateValue = row.EventDate ?? row.Date ?? row.eventDate ?? row.date;
        const date = formatEventDate(dateValue);
        const time = String(row.EventTime ?? row.Time ?? row.eventTime ?? row.time ?? '').slice(0, 8);
        const location = row.Location ?? row.Venue ?? row.location ?? '';
        const locationTl = row.LocationTl ?? row.locationTl ?? '';
        const photoUrl = row.PhotoUrl ?? row.photoUrl ?? '';

        if (!date) return null;

        return {
          id: String(id),
          title: String(title),
          titleTl: String(titleTl),
          description: String(description),
          descriptionTl: String(descriptionTl),
          detail: String(detail),
          detailTl: String(detailTl),
          date,
          time,
          location: String(location),
          locationTl: String(locationTl),
          photoUrl: String(photoUrl),
        };
      })
      .filter(Boolean);

    res.json(events);
  } catch (error) {
    console.error('Events lookup error:', error);
    res.status(500).json({ message: 'Unable to load events.' });
  }
});

app.post('/api/events', requireAdmin, async (req, res) => {
  const { title, titleTl, description, descriptionTl, detail, detailTl, date, time, location, locationTl, photoUrl } = req.body;

  if (!title || !date) {
    return res.status(400).json({ message: 'Title and date are required.' });
  }

  // Validate title length
  if (String(title).trim().length < 3) {
    return res.status(400).json({ message: 'Event title must be at least 3 characters.' });
  }

  // Validate date format
  if (!isValidDate(date)) {
    return res.status(400).json({ message: 'Please provide a valid event date.' });
  }

  try {
    const pool = getPool();
    
    const result = await pool.query(`
      INSERT INTO "Events" (Title, TitleTl, Description, DescriptionTl, Body, BodyTl, EventDate, EventTime, Location, LocationTl, PhotoUrl)
      RETURNING "EventId"
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [title, titleTl || '', description || '', descriptionTl || '', detail || '', detailTl || '', date, time || '', location || '', locationTl || '', photoUrl || '']);

    const eventId = result.rows[0]?.EventId;
    res.status(201).json({
      id: String(eventId), title, titleTl: titleTl || '', description: description || '',
      descriptionTl: descriptionTl || '', detail, detailTl: detailTl || '', date,
      time: time || '', location, locationTl: locationTl || '', photoUrl: photoUrl || '',
    });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ message: 'Unable to create event.' });
  }
});

app.put('/api/events/:eventId', requireAdmin, async (req, res) => {
  const { eventId } = req.params;
  const { title, titleTl, description, descriptionTl, detail, detailTl, date, time, location, locationTl, photoUrl } = req.body;

  if (!title || !date) {
    return res.status(400).json({ message: 'Title and date are required.' });
  }

  try {
    const pool = getPool();
    
    await pool.query(`
      UPDATE "Events"
      SET Title = $1, TitleTl = $2, Description = $3, DescriptionTl = $4,
          Body = $5, BodyTl = $6, EventDate = $7, EventTime = $8,
          Location = $9, LocationTl = $10, PhotoUrl = $11
      WHERE EventId = $12
    `, [title, titleTl || '', description || '', descriptionTl || '', detail || '', detailTl || '', date, time || '', location || '', locationTl || '', photoUrl || '', eventId]);

    res.json({
      id: String(eventId), title, titleTl: titleTl || '', description: description || '',
      descriptionTl: descriptionTl || '', detail, detailTl: detailTl || '', date,
      time: time || '', location, locationTl: locationTl || '', photoUrl: photoUrl || '',
    });
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ message: 'Unable to update event.' });
  }
});

app.delete('/api/events/:eventId', requireAdmin, async (req, res) => {
  const { eventId } = req.params;

  try {
    const pool = getPool();
    
    await pool.query(`
      DELETE FROM "Events"
      WHERE EventId = $1
    `, [eventId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ message: 'Unable to delete event.' });
  }
});

const siteContentPages = new Set(['about', 'gallery', 'contact', 'footer']);

const isOptionalText = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max);

function isSiteContentDocument(page, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;

  if (page === 'about') {
    return typeof content.heading === 'string'
      && content.heading.length <= 300
      && isOptionalText(content.headingTl, 300)
      && (content.paragraphsTl === undefined || (Array.isArray(content.paragraphsTl)
        && content.paragraphsTl.length <= 30
        && content.paragraphsTl.every(paragraph => typeof paragraph === 'string' && paragraph.length <= 10000)))
      && Array.isArray(content.paragraphs)
      && content.paragraphs.length <= 30
      && content.paragraphs.every(paragraph => typeof paragraph === 'string' && paragraph.length <= 10000)
      && Array.isArray(content.stats)
      && content.stats.length <= 20
      && content.stats.every(stat => stat && typeof stat.value === 'string' && stat.value.length <= 100
        && typeof stat.label === 'string' && stat.label.length <= 300
        && isOptionalText(stat.labelTl, 300))
      && isOptionalText(content.intro, 1000)
      && isOptionalText(content.introTl, 1000)
      && (content.heroImage === undefined || content.heroImage === ''
        || (typeof content.heroImage === 'string' && content.heroImage.length <= 2000
          && (/^https?:\/\//i.test(content.heroImage) || content.heroImage.startsWith('/assets/') || content.heroImage.startsWith('/uploads/'))))
      && (content.timeline === undefined || (Array.isArray(content.timeline)
        && content.timeline.length <= 30
        && content.timeline.every(item => item && typeof item.year === 'string' && item.year.length <= 50
          && typeof item.title === 'string' && item.title.length <= 200
          && isOptionalText(item.titleTl, 200)
          && typeof item.description === 'string' && item.description.length <= 2000
          && isOptionalText(item.descriptionTl, 2000))))
      && (content.quote === undefined || (content.quote && typeof content.quote === 'object'
        && typeof content.quote.text === 'string' && content.quote.text.length <= 1000
        && isOptionalText(content.quote.textTl, 1000)
        && isOptionalText(content.quote.attribution, 200)));
  }

  if (page === 'contact') {
    return typeof content.heading === 'string' && content.heading.length <= 300
      && isOptionalText(content.headingTl, 300)
      && isOptionalText(content.eyebrow, 100)
      && isOptionalText(content.eyebrowTl, 100)
      && isOptionalText(content.description, 1000)
      && isOptionalText(content.descriptionTl, 1000)
      && isOptionalText(content.formTitle, 200)
      && isOptionalText(content.formTitleTl, 200)
      && isOptionalText(content.formDescription, 1000)
      && isOptionalText(content.formDescriptionTl, 1000)
      && Array.isArray(content.cards)
      && content.cards.length <= 12
      && content.cards.every(card => card
        && ['visit', 'call', 'email'].includes(card.type)
        && typeof card.title === 'string' && card.title.length <= 200
        && isOptionalText(card.titleTl, 200)
        && Array.isArray(card.lines) && card.lines.length <= 10
        && card.lines.every(line => typeof line === 'string' && line.length <= 300)
        && (card.linesTl === undefined || (Array.isArray(card.linesTl) && card.linesTl.length <= 10
          && card.linesTl.every(line => typeof line === 'string' && line.length <= 300))));
  }

  if (page === 'footer') {
    const isTextList = (value, maxItems, maxLength) => Array.isArray(value)
      && value.length <= maxItems
      && value.every(item => typeof item === 'string' && item.length <= maxLength);
    return typeof content.parishTitle === 'string' && content.parishTitle.length <= 200
      && isTextList(content.addressLines, 10, 300)
      && typeof content.scheduleTitle === 'string' && content.scheduleTitle.length <= 100
      && isTextList(content.scheduleLines, 20, 300)
      && typeof content.officeHoursTitle === 'string' && content.officeHoursTitle.length <= 100
      && isTextList(content.officeHoursLines, 20, 300)
      && typeof content.contactTitle === 'string' && content.contactTitle.length <= 100
      && typeof content.contactIntro === 'string' && content.contactIntro.length <= 500
      && isTextList(content.phoneNumbers, 10, 50)
      && typeof content.email === 'string' && content.email.length <= 320
      && typeof content.quickLinksTitle === 'string' && content.quickLinksTitle.length <= 100
      && Array.isArray(content.quickLinks) && content.quickLinks.length <= 12
      && content.quickLinks.every(link => link
        && typeof link.label === 'string' && link.label.length <= 100
        && typeof link.path === 'string' && link.path.length <= 500
        && link.path.startsWith('/') && !link.path.startsWith('//'))
      && typeof content.copyright === 'string' && content.copyright.length <= 300;
  }

  return page === 'gallery' && isValidGalleryContent(content);
}

app.get('/api/site-content/:page', async (req, res) => {
  const page = String(req.params.page || '').toLowerCase();
  if (!siteContentPages.has(page)) {
    return res.status(404).json({ message: 'Website content page not found.' });
  }

  try {
    const result = await getPool().query('SELECT "ContentJson" FROM "SiteContent" WHERE "ContentKey" = $1', [page]);
    const stored = result.rows[0]?.ContentJson;
    return res.json({ content: stored ? JSON.parse(stored) : null });
  } catch (error) {
    logError(error, { context: 'getSiteContent', page });
    return res.status(500).json({ message: 'Unable to load website content.' });
  }
});

app.put('/api/admin/site-content/:page', requireAdmin, requireRole(['Admin', 'Secretary', 'ParishPriest']), async (req, res) => {
  const page = String(req.params.page || '').toLowerCase();
  const content = req.body?.content;
  if (!siteContentPages.has(page)) {
    return res.status(404).json({ message: 'Website content page not found.' });
  }
  if (!isSiteContentDocument(page, content)) {
    return res.status(400).json({ message: 'The website content has an invalid format.' });
  }

  try {
    const contentJson = JSON.stringify(content);
    await getPool().query(`
        INSERT INTO "SiteContent" ("ContentKey","ContentJson","UpdatedBy")
          VALUES ($1,$2,$3)
          ON CONFLICT ("ContentKey") DO UPDATE
          SET "ContentJson"=EXCLUDED."ContentJson","UpdatedAt"=NOW(),"UpdatedBy"=EXCLUDED."UpdatedBy"
      `, [page, contentJson, req.staff?.email || String(req.staff?.userId || '')]);
    return res.json({ content });
  } catch (error) {
    logError(error, { context: 'saveSiteContent', page });
    return res.status(500).json({ message: 'Unable to save website content.' });
  }
});

app.post('/api/contact', contactRateLimit, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const message = String(req.body?.message || '').trim();

  if (name.length < 2 || name.length > 200) {
    return res.status(400).json({ message: 'Please provide your name.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ message: 'Please provide a valid email address.' });
  }
  if (phone.length > 50) {
    return res.status(400).json({ message: 'Phone number is too long.' });
  }
  if (message.length < 5 || message.length > 5000) {
    return res.status(400).json({ message: 'Message must be between 5 and 5000 characters.' });
  }

  try {
    await getPool().query('INSERT INTO "ContactMessages" (Name, Email, Phone, Message) VALUES ($1, $2, $3, $4)', [name, email, phone || null, message]);
    return res.json({ success: true });
  } catch (error) {
    logError(error, { context: 'submitContactMessage' });
    return res.status(500).json({ message: 'Unable to send your message.' });
  }
});

// Any signed-in staff role may read and mark messages; only senior roles may delete.
app.get('/api/admin/contact-messages', requireAdmin, requireRole(staffRolePriority), async (_req, res) => {
  try {
    const result = await getPool().query(`
      SELECT ContactMessageId, Name, Email, Phone, Message, IsRead, CreatedAt
      FROM "ContactMessages"
      ORDER BY CreatedAt DESC
    `);
    return res.json(result.rows.map(row => ({
      id: row.ContactMessageId,
      name: row.Name,
      email: row.Email,
      phone: row.Phone,
      message: row.Message,
      isRead: !!row.IsRead,
      createdAt: row.CreatedAt,
    })));
  } catch (error) {
    logError(error, { context: 'listContactMessages' });
    return res.status(500).json({ message: 'Unable to load messages.' });
  }
});

app.patch('/api/admin/contact-messages/:id', requireAdmin, requireRole(staffRolePriority), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || typeof req.body?.isRead !== 'boolean') {
    return res.status(400).json({ message: 'Invalid request.' });
  }
  try {
    await getPool().query('UPDATE "ContactMessages" SET "IsRead" = $2 WHERE ContactMessageId = $1', [id, req.body.isRead ? 1 : 0]);
    return res.json({ success: true });
  } catch (error) {
    logError(error, { context: 'updateContactMessage' });
    return res.status(500).json({ message: 'Unable to update message.' });
  }
});

app.delete('/api/admin/contact-messages/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Invalid request.' });
  }
  try {
    await getPool().query('DELETE FROM "ContactMessages" WHERE ContactMessageId = $1', [id]);
    return res.json({ success: true });
  } catch (error) {
    logError(error, { context: 'deleteContactMessage' });
    return res.status(500).json({ message: 'Unable to delete message.' });
  }
});

app.post('/api/admin/login', authRateLimit, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const result = await getPool().query(`
        SELECT u.UserId, u.EmailAddress, u.PasswordHash, u.MustChangePassword, r.Name AS RoleName
        FROM "AspNetUsers" u
        INNER JOIN "AspNetUserRoles" ur ON ur.UserId = u.UserId
        INNER JOIN "AspNetRoles" r ON r.RoleId = ur.RoleId
        WHERE u.EmailAddress = $1
      `, [email]);
    const user = result.rows[0];

    const supportedRoles = ['Admin', 'ParishPriest', 'Secretary', 'Bookkeeper', 'Staff'];
    if (!user || !supportedRoles.includes(user.RoleName) || !verifyAspNetPassword(password, user.PasswordHash)) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    return res.json({
      token: createStaffToken(user.UserId, user.RoleName),
      user: { id: user.UserId, email: user.EmailAddress, role: user.RoleName, mustChangePassword: Boolean(user.MustChangePassword) },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({ message: 'Unable to sign in.' });
  }
});

app.post('/api/admin/forgot-password', authRateLimit, (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (email.length > 510) return res.status(400).json({ message: 'Enter a valid email address.' });

  return res.status(202).json({
    message: 'If a staff account matches that email, password reset instructions will be sent when email delivery is enabled.',
  });
});

app.get('/api/admin/verify', requireAdmin, async (req, res) => {
  const staff = req.staff;
  let profile = { userName: '', email: '' };
  if (staff.userId > 0) {
    try {
      const result = await getPool().query('SELECT UserName, EmailAddress FROM "AspNetUsers" WHERE UserId = $1', [staff.userId]);
      const row = result.rows[0];
      if (row) profile = { userName: row.UserName, email: row.EmailAddress };
    } catch (error) {
      logError(error, { context: 'adminVerifyProfile' });
    }
  }
  res.json({
    ok: true,
    user: {
      id: staff.userId,
      role: staff.role || 'Admin',
      ...profile,
      mustChangePassword: Boolean(staff.mustChangePassword),
      overrides: staff.overrides || {},
    },
  });
});

function defaultStaffPassword() {
  return process.env.DEFAULT_STAFF_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'Parish@12345');
}

app.post('/api/admin/change-password', authRateLimit, requireAdmin, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (req.staff.userId <= 0) return res.status(400).json({ message: 'This sign-in method has no password to change.' });
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ message: 'The new password must be 8 to 128 characters.' });
  }
  if (newPassword === currentPassword || newPassword === defaultStaffPassword()) {
    return res.status(400).json({ message: 'Choose a new password that is different from your current and default password.' });
  }
  try {
    const result = await getPool().query('SELECT UserName, PasswordHash FROM "AspNetUsers" WHERE UserId = $1', [req.staff.userId]);
    const user = result.rows[0];
    if (!user || !verifyAspNetPassword(currentPassword, user.PasswordHash)) {
      return res.status(401).json({ message: 'Your current password is incorrect.' });
    }
    const updateResult = await getPool().query('UPDATE "AspNetUsers" SET PasswordHash = $2, "MustChangePassword" = FALSE WHERE UserId = $1', [req.staff.userId, hashAspNetPassword(newPassword)]);
    if (updateResult.rowCount !== 1) {
      return res.status(500).json({ message: 'Unable to change password.' });
    }
    try {
      await getPool().query(`
          INSERT INTO "UserManagementAudit" (ActionName, TargetUserId, TargetUserName, ChangedBy, Details)
          VALUES ($1, $2, $3, $4, $5)
        `, ['ChangeOwnPassword', req.staff.userId, user.UserName, user.UserName, null]);
    } catch (auditError) {
      logError(auditError, { context: 'auditChangeOwnPassword', userId: req.staff.userId });
    }
    return res.json({ message: 'Password changed.' });
  } catch (error) {
    logError(error, { context: 'changeOwnPassword' });
    return res.status(500).json({ message: 'Unable to change password.' });
  }
});

app.put('/api/admin/profile', requireAdmin, async (req, res) => {
  const userName = typeof req.body?.userName === 'string' ? req.body.userName.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (req.staff.userId <= 0) return res.status(400).json({ message: 'This sign-in method has no profile.' });
  if (!userName || userName.length > 256 || !isValidEmail(email) || email.length > 510) {
    return res.status(400).json({ message: 'A username and valid email address are required.' });
  }
  try {
    const duplicate = await getPool().query('SELECT UserId FROM "AspNetUsers" WHERE EmailAddress = $2 AND UserId <> $1', [req.staff.userId, email]);
    if (duplicate.rows.length) return res.status(409).json({ message: 'Another account already uses this email address.' });
    await getPool().query('UPDATE "AspNetUsers" SET UserName = $2, EmailAddress = $3 WHERE UserId = $1', [req.staff.userId, userName, email]);
    return res.json({ userName, email });
  } catch (error) {
    logError(error, { context: 'updateOwnProfile' });
    return res.status(500).json({ message: 'Unable to update profile.' });
  }
});

app.get('/api/admin/users/:id/permissions', requireAdmin, requireRole(['Admin']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid staff account ID is required.' });
  try {
    const result = await getPool().query('SELECT ModuleName, CanView, CanEdit FROM "UserModulePermissions" WHERE UserId = $1', [id]);
    res.json({ overrides: Object.fromEntries(result.rows.map(row => [row.ModuleName, { view: Boolean(row.CanView), edit: Boolean(row.CanEdit) }])) });
  } catch (error) {
    logError(error, { context: 'getUserPermissions' });
    res.status(500).json({ message: 'Unable to load permissions.' });
  }
});

app.put('/api/admin/users/:id/permissions', requireAdmin, requireRole(['Admin']), async (req, res) => {
  const id = Number(req.params.id);
  const overrides = req.body?.overrides;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid staff account ID is required.' });
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) ||
      !Object.entries(overrides).every(([module, value]) =>
        OVERRIDABLE_MODULES.includes(module) && value && typeof value.view === 'boolean' && typeof value.edit === 'boolean')) {
    return res.status(400).json({ message: 'The permissions have an invalid format.' });
  }

  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const target = await transaction.query('SELECT UserName FROM "AspNetUsers" WHERE UserId = $1', [id]);
    if (!target.rows[0]) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Staff account not found.' });
    }
    await transaction.query('DELETE FROM "UserModulePermissions" WHERE UserId = $1', [id]);
    for (const [module, value] of Object.entries(overrides)) {
      await transaction.query('INSERT INTO "UserModulePermissions" (UserId, ModuleName, CanView, CanEdit, UpdatedBy) VALUES ($1, $2, $3, $4, $5)', [id, module, value.view || value.edit, value.edit, staffName(req)]);
    }
    await transaction.query(`
        INSERT INTO "UserManagementAudit" (ActionName, TargetUserId, TargetUserName, ChangedBy, Details)
        VALUES ($1, $2, $3, $4, $5)
      `, ['UpdatePermissions', id, target.rows[0].UserName, staffName(req), JSON.stringify(overrides)]);
    await client.query('COMMIT');
    committed = true;
    res.json({ message: 'Permissions updated.' });
  } catch (error) {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch (re) { logError(re, { context: 'updatePermissionsRollback' }); }
    }
    logError(error, { context: 'updateUserPermissions' });
    res.status(500).json({ message: 'Unable to update permissions.' });
  }
});

app.get('/api/admin/users', requireAdmin, requireRole(['Admin', 'ParishPriest', 'Secretary']), async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT u.UserId AS userId, u.UserName AS userName,
        CASE WHEN $1 = 1 THEN u.EmailAddress ELSE NULL END AS email,
        u.EmailConfirmed AS emailConfirmed, FALSE AS lockoutEnabled,
        0 AS accessFailedCount, COALESCE(r.Name, 'Staff') AS roleName
      FROM "AspNetUsers" u
      LEFT JOIN "AspNetUserRoles" ur ON ur.UserId = u.UserId
      LEFT JOIN "AspNetRoles" r ON r.RoleId = ur.RoleId
      ORDER BY u.UserName
    `, [req.staff.role === 'Admin']);
    const users = result.rows.reduce((items, row) => {
      const item = items.find(value => value.userId === row.userId);
      if (item) item.roles.push(row.roleName);
      else items.push({
        userId: row.userId,
        userName: row.userName,
        email: row.email,
        emailConfirmed: Boolean(row.emailConfirmed),
        lockoutEnabled: Boolean(row.lockoutEnabled),
        accessFailedCount: row.accessFailedCount,
        roles: row.roleName ? [row.roleName] : [],
      });
      return items;
    }, []);
    res.json(users);
  } catch (error) {
    logError(error, { context: 'adminUsers' });
    res.status(500).json({ message: 'Unable to load staff accounts.' });
  }
});

app.get('/api/admin/audit/user-management', requireAdmin, requireRole(['Admin']), async (req, res) => {
  try { const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100)); const result = await getPool().query('SELECT * FROM "UserManagementAudit" ORDER BY ChangedAt DESC', [limit]); res.json(result.rows); } catch (error) { logError(error, { context: 'userAudit' }); res.status(500).json({ message: 'Unable to load user audit history.' }); }
});

app.post('/api/admin/users', requireAdmin, requireRole(['Admin']), async (req, res) => {
  const { userName, email, role } = req.body || {};
  const password = req.body?.password ? req.body.password : defaultStaffPassword();
  const username = typeof userName === 'string' ? userName.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const validRoles = ['Admin', 'ParishPriest', 'Secretary', 'Bookkeeper', 'Staff'];
  const selectedRole = role || 'Staff';
  if (!username || username.length > 256 || !isValidEmail(normalizedEmail) || normalizedEmail.length > 510 ||
      typeof password !== 'string' || password.length < 8 || !validRoles.includes(selectedRole)) {
    return res.status(400).json({ message: 'A username, valid email, and valid role are required, and a default password of at least eight characters must be configured.' });
  }

  const client = await getPool().connect();
  let committed = false;
  try {
    const db = getPool();
    const roleResult = await db.query('SELECT RoleId FROM "AspNetRoles" WHERE Name = $1', [selectedRole]);
    if (!roleResult.rows[0]) {
      return res.status(500).json({ message: 'Role is not configured in the database.' });
    }

    await client.query('BEGIN');
    const duplicate = await transaction.query('SELECT UserId FROM "AspNetUsers" WHERE EmailAddress = $1', [normalizedEmail]);
    if (duplicate.rows.length) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'An account with this email address already exists.' });
    }

    const user = await transaction.query(`
        INSERT INTO "AspNetUsers" (UserName, EmailAddress, EmailConfirmed, PasswordHash, MustChangePassword)
        RETURNING "UserId"
        VALUES ($1, $2, 1, $3, 1)
      `, [username, normalizedEmail, hashAspNetPassword(password)]);
    const userId = user.rows[0].UserId;

    await transaction.query('INSERT INTO "AspNetUserRoles" (UserId, RoleId) VALUES ($1, $2)', [userId, roleResult.rows[0].RoleId]);
    await transaction.query(`
        INSERT INTO "UserManagementAudit" (ActionName, TargetUserId, TargetUserName, ChangedBy, Details)
        VALUES ($1, $2, $3, $4, $5)
      `, ['CreateUser', userId, username, staffName(req), JSON.stringify({ role: selectedRole, email: normalizedEmail })]);
    await client.query('COMMIT');
    committed = true;
    res.status(201).json({ userId });
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        logError(rollbackError, { context: 'createAdminUserRollback' });
      }
    }
    logError(error, { context: 'createAdminUser' });
    res.status(500).json({ message: 'Unable to create staff account.' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, requireRole(['Admin', 'ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number(req.params.id);
  const resetToDefault = req.body?.resetToDefault === true;
  const password = resetToDefault ? defaultStaffPassword() : req.body?.password;
  const hasEmail = Object.prototype.hasOwnProperty.call(req.body || {}, 'email');
  const email = hasEmail && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const validRoles = ['Admin', 'ParishPriest', 'Secretary', 'Bookkeeper', 'Staff'];
  const requestedRoles = Array.isArray(req.body?.roles) ? req.body.roles : (req.body?.role ? [req.body.role] : null);
  const hasPassword = password !== undefined && password !== null && password !== '';
  if (resetToDefault && req.body?.password) return res.status(400).json({ message: 'Choose either a default reset or a custom password.' });
  if (req.staff.role !== 'Admin' && (
    hasEmail ||
    hasPassword ||
    !requestedRoles ||
    Object.keys(req.body || {}).some(key => !['roles', 'role'].includes(key)) ||
    requestedRoles.includes('Admin')
  )) {
    return res.status(403).json({ message: 'Only Admin users can change account details or assign the Admin role.' });
  }
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid staff account ID is required.' });
  if (hasEmail && (!isValidEmail(email) || email.length > 510)) {
    return res.status(400).json({ message: 'A valid email address is required.' });
  }
  if (hasPassword && (typeof password !== 'string' || password.length < 8)) {
    return res.status(400).json({ message: 'The password must be at least eight characters.' });
  }
  if (requestedRoles && (requestedRoles.length === 0 || !requestedRoles.every(name => validRoles.includes(name)))) {
    return res.status(400).json({ message: 'A valid role is required.' });
  }
  if (!hasEmail && !hasPassword && !requestedRoles) {
    return res.status(400).json({ message: 'At least one account change is required.' });
  }

  const client = await getPool().connect();
  let committed = false;
  try {
    const db = getPool();
    const roleIds = [];
    if (requestedRoles) {
      for (const name of [...new Set(requestedRoles)]) {
        const roleRow = await db.query('SELECT RoleId FROM "AspNetRoles" WHERE Name = $1', [name]);
        if (!roleRow.rows[0]) {
          return res.status(400).json({ message: `Role ${name} is not configured.` });
        }
        roleIds.push(roleRow.rows[0].RoleId);
      }
    }

    await client.query('BEGIN');
    const targetResult = await transaction.query(`
        SELECT u.UserName, u.EmailAddress,
          CASE WHEN EXISTS (
            SELECT 1 FROM "AspNetUserRoles" ur
            INNER JOIN "AspNetRoles" r ON r.RoleId = ur.RoleId
            WHERE ur.UserId = u.UserId AND r.Name = 'Admin'
          ) THEN 1 ELSE 0 END AS IsAdmin
        FROM "AspNetUsers" u
        WHERE u.UserId = $1
      `, [id]);
    const target = targetResult.rows[0];
    if (!target) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Staff account not found.' });
    }
    if (req.staff.role !== 'Admin' && target.IsAdmin) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(403).json({ message: 'Only Admin users can change an Admin account.' });
    }

    if (hasEmail) {
      const duplicate = await transaction.query('SELECT UserId FROM "AspNetUsers" WHERE EmailAddress = $2 AND UserId <> $1', [id, email]);
      if (duplicate.rows.length) {
        await transaction.rollback();
        transactionStarted = false;
        return res.status(409).json({ message: 'Another account already uses this email address.' });
      }
      await transaction.query('UPDATE "AspNetUsers" SET EmailAddress = $2 WHERE UserId = $1', [id, email]);
    }
    if (hasPassword) {
      await transaction.query('UPDATE "AspNetUsers" SET PasswordHash = $2, "MustChangePassword" = TRUE WHERE UserId = $1', [id, hashAspNetPassword(password)]);
    }
    if (requestedRoles) {
      await transaction.query('DELETE FROM "AspNetUserRoles" WHERE UserId = $1', [id]);
      for (const roleId of roleIds) {
        await transaction.query('INSERT INTO "AspNetUserRoles" (UserId, RoleId) VALUES ($1, $2)', [id, roleId]);
      }
    }

    const details = {};
    if (hasEmail) details.email = email;
    if (hasPassword) details.passwordChanged = true;
    if (resetToDefault) details.passwordResetToDefault = true;
    if (requestedRoles) details.roles = [...new Set(requestedRoles)];
    await transaction.query(`
        INSERT INTO "UserManagementAudit" (ActionName, TargetUserId, TargetUserName, ChangedBy, Details)
        VALUES ($1, $2, $3, $4, $5)
      `, ['UpdateUser', id, target.UserName, staffName(req), JSON.stringify(details)]);
    await client.query('COMMIT');
    committed = true;
    res.json({ message: 'Staff account updated.' });
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        logError(rollbackError, { context: 'updateAdminUserRollback' });
      }
    }
    logError(error, { context: 'updateAdminUser' });
    res.status(500).json({ message: 'Unable to update staff account.' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, requireRole(['Admin']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid staff account ID is required.' });

  const client = await getPool().connect();
  let committed = false;
  try {
    const db = getPool();
    await client.query('BEGIN');
    const targetResult = await transaction.query('SELECT UserName, EmailAddress FROM "AspNetUsers" WHERE UserId = $1', [id]);
    const target = targetResult.rows[0];
    if (!target) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Staff account not found.' });
    }

    await transaction.query('DELETE FROM "AspNetUserRoles" WHERE UserId = $1', [id]);
    await transaction.query('DELETE FROM "AspNetUsers" WHERE UserId = $1', [id]);
    await transaction.query(`
        INSERT INTO "UserManagementAudit" (ActionName, TargetUserId, TargetUserName, ChangedBy, Details)
        VALUES ($1, $2, $3, $4, $5)
      `, ['DeleteUser', id, target.UserName, staffName(req), JSON.stringify({ email: target.EmailAddress })]);
    await client.query('COMMIT');
    committed = true;
    res.json({ message: 'Staff account deleted.' });
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        logError(rollbackError, { context: 'deleteAdminUserRollback' });
      }
    }
    logError(error, { context: 'deleteAdminUser' });
    res.status(500).json({ message: 'Unable to delete staff account.' });
  }
});

app.get('/api/admin/prayers', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT PrayerId, Name, Category, Request, Anonymous, ShareWithCommunity, IsApproved, CreatedAt
      FROM "PrayerRequests"
      ORDER BY CreatedAt DESC
    `);

    const prayers = result.rows.map(row => ({
      id: row.PrayerId,
      name: row.Name,
      category: row.Category,
      request: row.Request,
      anonymous: sqlBitToBoolean(row.Anonymous),
      shareWithCommunity: sqlBitToBoolean(row.ShareWithCommunity),
      isApproved: sqlBitToBoolean(row.IsApproved),
      createdAt: row.CreatedAt
    }));

    res.json(prayers);
  } catch (error) {
    console.error('Admin prayers lookup error:', error);
    res.status(500).json({ message: 'Unable to load prayers.' });
  }
})

app.delete('/api/prayers/:prayerId', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const { prayerId } = req.params;

  try {
    const pool = getPool();
    
    await pool.query(`
      DELETE FROM "PrayerRequests"
      WHERE PrayerId = $1
    `, [prayerId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete prayer error:', error);
    res.status(500).json({ message: 'Unable to delete prayer.' });
  }
});

app.get('/api/admin/service-requests', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (_req, res) => {
  try {
    const pool = getPool();
    
    // Prefer ContactSnapshot columns if populated, fallback to Parishioner columns for legacy rows
    const result = await pool.query(`
      SELECT
        sr.ServiceRequestId,
        sr.ParishionerId,
        sr.ServiceId,
        sr.ScheduledDate,
        sr.ScheduledTime,
        sr.Status,
        sr.Notes,
        sr.CreatedAt,
        bd.ChildFirstName, bd.ChildMiddleName, bd.ChildLastName, bd.ChildDateOfBirth, bd.PlaceOfBirth, bd.FatherFullName, bd.MotherFullName, bd.GodfatherName, bd.GodmotherName, bd.ExtraFieldsJson AS BaptismExtraFields,
        md.GroomFirstName, md.GroomMiddleName, md.GroomLastName, md.GroomAge, md.BrideFirstName, md.BrideMiddleName, md.BrideLastName, md.BrideAge, md.CenomarNumber, md.Witnesses, md.ExtraFieldsJson AS MarriageExtraFields,
        cd.CandidateFirstName, cd.CandidateMiddleName, cd.CandidateLastName, cd.CandidateDateOfBirth, cd.SponsorName, cd.ParishOfBaptism, cd.ExtraFieldsJson AS ConfirmationExtraFields,
        fd.DeceasedFirstName, fd.DeceasedMiddleName, fd.DeceasedLastName, fd.DateOfDeath, fd.RelationshipToDeceased, fd.PlaceOfWake, fd.ExtraFieldsJson AS FuneralExtraFields,
        hd.FullAddress AS HouseBlessingFullAddress, hd.Landmark AS HouseBlessingLandmark, hd.PreferredContactPerson AS HouseBlessingPreferredContactPerson, hd.ExtraFieldsJson AS HouseBlessingExtraFields,
        COALESCE(sr.ContactFirstName, p.FirstName) as FirstName,
        COALESCE(sr.ContactLastName, p.LastName) as LastName,
        COALESCE(sr.ContactEmail, p.EmailAddress) as EmailAddress,
        COALESCE(sr.ContactMobile, p.MobileNumber) as MobileNumber,
        COALESCE(sr.ContactAddress, p.Address) as Address,
        s.Name as ServiceName
      FROM "ServiceRequest" sr
      JOIN "Parishioners" p ON sr.ParishionerId = p.ParishionerId
      JOIN "Service" s ON sr.ServiceId = s.ServiceId
      LEFT JOIN "BaptismRequestDetail" bd ON sr.ServiceRequestId = bd.ServiceRequestId
      LEFT JOIN "MarriageRequestDetail" md ON sr.ServiceRequestId = md.ServiceRequestId
      LEFT JOIN "ConfirmationRequestDetail" cd ON sr.ServiceRequestId = cd.ServiceRequestId
      LEFT JOIN "FuneralRequestDetail" fd ON sr.ServiceRequestId = fd.ServiceRequestId
      LEFT JOIN "HouseBlessingRequestDetail" hd ON sr.ServiceRequestId = hd.ServiceRequestId
      ORDER BY sr.CreatedAt DESC
    `);

    const requests = result.rows.map(row => {
      const details = Object.fromEntries(Object.entries({
        childFirstName: row.ChildFirstName,
        childMiddleName: row.ChildMiddleName,
        childLastName: row.ChildLastName,
        childDateOfBirth: row.ChildDateOfBirth,
        placeOfBirth: row.PlaceOfBirth,
        fatherFullName: row.FatherFullName,
        motherFullName: row.MotherFullName,
        godfatherName: row.GodfatherName,
        godmotherName: row.GodmotherName,
        groomFirstName: row.GroomFirstName,
        groomMiddleName: row.GroomMiddleName,
        groomLastName: row.GroomLastName,
        groomAge: row.GroomAge,
        brideFirstName: row.BrideFirstName,
        brideMiddleName: row.BrideMiddleName,
        brideLastName: row.BrideLastName,
        brideAge: row.BrideAge,
        cenomarNumber: row.CenomarNumber,
        witnesses: row.Witnesses,
        candidateFirstName: row.CandidateFirstName,
        candidateMiddleName: row.CandidateMiddleName,
        candidateLastName: row.CandidateLastName,
        candidateDateOfBirth: row.CandidateDateOfBirth,
        sponsorName: row.SponsorName,
        parishOfBaptism: row.ParishOfBaptism,
        deceasedFirstName: row.DeceasedFirstName,
        deceasedMiddleName: row.DeceasedMiddleName,
        deceasedLastName: row.DeceasedLastName,
        dateOfDeath: row.DateOfDeath,
        relationshipToDeceased: row.RelationshipToDeceased,
        placeOfWake: row.PlaceOfWake,
        fullAddress: row.HouseBlessingFullAddress,
        landmark: row.HouseBlessingLandmark,
        preferredContactPerson: row.HouseBlessingPreferredContactPerson,
      }).filter(([, value]) => value !== null && value !== undefined && value !== ''));

      for (const extraJson of [row.BaptismExtraFields, row.MarriageExtraFields, row.ConfirmationExtraFields, row.FuneralExtraFields, row.HouseBlessingExtraFields]) {
        if (extraJson) {
          try {
            Object.assign(details, JSON.parse(extraJson));
          } catch {
            // Keep the request visible if legacy detail JSON is malformed.
          }
        }
      }

      return {
        id: row.ServiceRequestId,
        parishionerId: row.ParishionerId,
        serviceId: row.ServiceId,
        firstName: row.FirstName,
        lastName: row.LastName,
        email: row.EmailAddress,
        mobileNumber: row.MobileNumber,
        address: row.Address,
        serviceName: row.ServiceName,
        scheduledDate: row.ScheduledDate,
        scheduledTime: row.ScheduledTime,
        status: row.Status,
        notes: row.Notes,
        createdAt: row.CreatedAt,
        details,
      };
    });

    res.json(requests);
  } catch (error) {
    console.error('Service requests lookup error:', error);
    res.status(500).json({ message: 'Unable to load service requests.' });
  }
});

app.get('/api/admin/service-fields', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (_req, res) => {
  try {
    const result = await getPool().query(`
      SELECT f.FieldDefinitionId, f.ServiceId, s.Name AS ServiceName, f.FieldKey, f.Label, f.FieldType, f.OptionsJson, f.IsRequired, f.SortOrder, f.IsActive
      FROM "ServiceFieldDefinition" f
      JOIN "Service" s ON s.ServiceId = f.ServiceId
      ORDER BY s.Name, f.SortOrder, f.FieldDefinitionId
    `);
    res.json(result.rows.map(row => ({
      id: row.FieldDefinitionId,
      serviceId: row.ServiceId,
      serviceName: row.ServiceName,
      key: row.FieldKey,
      label: row.Label,
      type: row.FieldType,
      options: row.OptionsJson ? JSON.parse(row.OptionsJson) : undefined,
      required: !!row.IsRequired,
      sortOrder: row.SortOrder,
      active: !!row.IsActive,
    })));
  } catch (error) {
    console.error('Service field definitions lookup error:', error);
    res.status(500).json({ message: 'Unable to load field definitions.' });
  }
});

app.post('/api/admin/service-fields', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const { serviceId, key, label, type, options, required, sortOrder } = req.body;
  const numericServiceId = Number(serviceId);
  if (!Number.isInteger(numericServiceId) || numericServiceId <= 0 || !key || !label) {
    return res.status(400).json({ message: 'Service, field key, and label are required.' });
  }
  try {
    const result = await getPool().query(`
        INSERT INTO "ServiceFieldDefinition" (ServiceId, FieldKey, Label, FieldType, OptionsJson, IsRequired, SortOrder)
        RETURNING "FieldDefinitionId"
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [numericServiceId, String(key), String(label), String(type || 'text'), Array.isArray(options) ? JSON.stringify(options) : null, !!required, Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0]);
    res.status(201).json({ id: result.rows[0].FieldDefinitionId });
  } catch (error) {
    console.error('Field definition create error:', error);
    res.status(500).json({ message: 'Unable to create field definition. The field key may already exist for this service.' });
  }
});

app.put('/api/admin/service-fields/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number(req.params.id);
  const { label, type, options, required, sortOrder, active } = req.body;
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid field definition ID.' });
  }
  try {
    await getPool().query(`
        UPDATE "ServiceFieldDefinition"
        SET Label = $2, FieldType = $3, OptionsJson = $4, IsRequired = $5, SortOrder = $6, IsActive = $7
        WHERE FieldDefinitionId = $1
      `, [id, String(label), String(type || 'text'), Array.isArray(options) ? JSON.stringify(options) : null, !!required, Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0, active === undefined ? true : !!active]);
    res.json({ message: 'Field definition updated.' });
  } catch (error) {
    console.error('Field definition update error:', error);
    res.status(500).json({ message: 'Unable to update field definition.' });
  }
});

app.delete('/api/admin/service-fields/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid field definition ID.' });
  }
  try {
    await getPool().query('DELETE FROM "ServiceFieldDefinition" WHERE FieldDefinitionId=$1', [id]);
    res.json({ message: 'Field definition deleted.' });
  } catch (error) {
    console.error('Field definition delete error:', error);
    res.status(500).json({ message: 'Unable to delete field definition.' });
  }
});

app.put('/api/admin/service-requests/:requestId', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const requestId = Number(req.params.requestId);
  const { status, adminNotes } = req.body;

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ message: 'Invalid service request ID.' });
  }
  if (!status || !ALLOWED_REQUEST_STATUSES.includes(String(status))) {
    return res.status(400).json({ message: `Status must be one of: ${ALLOWED_REQUEST_STATUSES.join(', ')}.` });
  }

  try {
    const pool = getPool();
    if (adminNotes) {
      const timestamp = new Date().toISOString();
      const adminNote = '\n\n[ADMIN NOTE] ' + timestamp + ': ' + String(adminNotes);
      await pool.query(`
        UPDATE "ServiceRequest"
        SET "Status"=$2,
            "Notes"=COALESCE("Notes",'') || $3,
            "VoidedAt"=CASE WHEN $2 IN ('Voided','VoidedNoShow','Cancelled') THEN NOW() ELSE "VoidedAt" END
        WHERE "ServiceRequestId"=$1
      `, [requestId, String(status), adminNote]);
    } else {
      await pool.query(`
        UPDATE "ServiceRequest"
        SET "Status"=$2,
            "VoidedAt"=CASE WHEN $2 IN ('Voided','VoidedNoShow','Cancelled') THEN NOW() ELSE "VoidedAt" END
        WHERE "ServiceRequestId"=$1
      `, [requestId, String(status)]);
    }

    res.json({ success: true, status });
  } catch (error) {
    console.error('Service request update error:', error);
    res.status(500).json({ message: 'Unable to update service request.' });
  }
});

app.delete('/api/admin/service-requests/:requestId', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const requestId = Number(req.params.requestId);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ message: 'Invalid service request ID.' });
  }

  try {
    const pool = getPool();
    
    await pool.query(`
      DELETE FROM "ServiceRequest"
      WHERE ServiceRequestId = $1
    `, [requestId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete service request error:', error);
    res.status(500).json({ message: 'Unable to delete service request.' });
  }
});

const sacramentalDefinitions = {
  baptism: { table: 'BaptismRecords', id: 'BaptismId', date: 'DateOfBaptism', name: "CONCAT(ChildFirstName, ' ', ChildLastName)", priest: 'MinisterName', columns: ['RegistryNumber', 'ChildFirstName', 'ChildMiddleName', 'ChildLastName', 'DateOfBirth', 'PlaceOfBirth', 'DateOfBaptism', 'FatherFullName', 'MotherFullName', 'MinisterName', 'Sponsors', 'Remarks'] },
  confirmation: { table: 'ConfirmationRecords', id: 'ConfirmationId', date: 'DateOfConfirmation', name: "CONCAT(CandidateFirstName, ' ', CandidateLastName)", priest: 'BishopOrMinister', columns: ['RegistryNumber', 'CandidateFirstName', 'CandidateMiddleName', 'CandidateLastName', 'DateOfBirth', 'DateOfConfirmation', 'FatherFullName', 'MotherFullName', 'SponsorName', 'BishopOrMinister', 'ParishOfBaptism'] },
  marriage: { table: 'MarriageRecords', id: 'MarriageId', date: 'DateOfMarriage', name: "CONCAT(GroomFirstName, ' ', GroomLastName, ' / ', BrideFirstName, ' ', BrideLastName)", priest: 'SolemnizingPriest', columns: ['RegistryNumber', 'GroomFirstName', 'GroomMiddleName', 'GroomLastName', 'GroomAge', 'GroomParents', 'BrideFirstName', 'BrideMiddleName', 'BrideLastName', 'BrideAge', 'BrideParents', 'DateOfMarriage', 'Witnesses', 'SolemnizingPriest'] },
  death: { table: 'DeathRecords', id: 'DeathId', date: 'DateOfDeath', name: "CONCAT(DeceasedFirstName, ' ', DeceasedLastName)", priest: 'OfficiatingPriest', columns: ['RegistryNumber', 'DeceasedFirstName', 'DeceasedMiddleName', 'DeceasedLastName', 'Age', 'DateOfDeath', 'DateOfBurial', 'CauseOfDeath', 'PlaceOfBurial', 'SacramentsReceived', 'OfficiatingPriest'] },
};

const staffName = req => req.staff?.email || req.staff?.role || 'staff';
const requestValue = (body, key) => body[key] ?? body[key.charAt(0).toLowerCase() + key.slice(1)] ?? null;
const sqlBitToBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', ''].includes(normalized)) return false;
  }
  return Boolean(value);
};

app.get('/api/admin/operations/schedule', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper', 'Staff']), async (_req, res) => {
  try {
    const result = await getPool().query(`SELECT "MassScheduleId" AS id, "Title" AS title, "MassDate" AS date, "MassTime" AS time, "Location" AS location, "PriestUsername" AS priestUsername, "Notes" AS notes, "Status" AS status FROM "MassSchedule" ORDER BY "MassDate", "MassTime"`);
    res.json(result.rows);
  } catch (error) { logError(error, { context: 'operationSchedule' }); res.status(500).json({ message: 'Unable to load schedules.' }); }
});

app.post('/api/admin/operations/schedule', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const { title, date, time, location, priestUsername, notes, status } = req.body || {};
  if (!title || !date || !time || !location || !priestUsername) return res.status(400).json({ message: 'Schedule title, date, time, location, and minister are required.' });
  try {
    const pool = getPool();
    const clash = await pool.query(`SELECT MassScheduleId AS id, MassDate AS date, MassTime AS time, Location AS location, PriestUsername AS priestUsername, Status AS status FROM "MassSchedule" WHERE MassDate=$1 AND MassTime=$2`, [date, time]);
    const conflict = findScheduleConflict({ date, time, location, priestUsername }, clash.rows);
    if (conflict.conflict) return res.status(409).json({ message: conflict.message });
    const result = await pool.query(`INSERT INTO "MassSchedule" (Title, MassDate, MassTime, Location, PriestUsername, Notes, Status) RETURNING "MassScheduleId" AS id VALUES ($1, $2, $3, $4, $5, $6, $7)`, [title, date, time, location, priestUsername, notes || null, status || 'Scheduled']);
    res.status(201).json(result.rows[0]);
  } catch (error) { logError(error, { context: 'createSchedule' }); res.status(500).json({ message: 'Unable to save schedule.' }); }
});

app.put('/api/admin/operations/schedule/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const { title, date, time, location, priestUsername, notes, status } = req.body || {};
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid schedule ID.' });
  try {
    const pool = getPool();
    const clash = await pool.query(`SELECT MassScheduleId AS id, MassDate AS date, MassTime AS time, Location AS location, PriestUsername AS priestUsername, Status AS status FROM "MassSchedule" WHERE MassDate=$1 AND MassTime=$2`, [date, time]);
    const conflict = findScheduleConflict({ date, time, location, priestUsername, excludeId: id }, clash.rows);
    if (conflict.conflict) return res.status(409).json({ message: conflict.message });
    await pool.query(`UPDATE "MassSchedule" SET Title=$2, MassDate=$3, MassTime=$4, Location=$5, PriestUsername=$6, Notes=$7, Status=$8, "UpdatedAt" = NOW() WHERE MassScheduleId=$1`, [id, title, date, time, location, priestUsername, notes || null, status || 'Scheduled']);
    res.json({ message: 'Schedule updated.' });
  } catch (error) { logError(error, { context: 'updateSchedule' }); res.status(500).json({ message: 'Unable to update schedule.' }); }
});

app.delete('/api/admin/operations/schedule/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid schedule ID.' });
  try {
    const result = await getPool().query('DELETE FROM "MassSchedule" WHERE MassScheduleId=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ message: 'Schedule not found.' });
    res.json({ message: 'Schedule deleted.' });
  } catch (error) { logError(error, { context: 'deleteSchedule' }); res.status(500).json({ message: 'Unable to delete schedule.' }); }
});

app.get('/api/admin/operations/mass-intentions', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (_req, res) => {
  try { const result = await getPool().query('SELECT * FROM "MassIntentions" ORDER BY "IntentionDate", "IntentionTime"'); res.json(result.rows); } catch (error) { logError(error, { context: 'massIntentions' }); res.status(500).json({ message: 'Unable to load Mass intentions.' }); }
});

app.post('/api/admin/operations/mass-intentions', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const { date, time, offering, requestedBy, intentionText } = req.body || {};
  if (!date || !time || !requestedBy || !intentionText) return res.status(400).json({ message: 'Mass intention date, time, requester, and intention are required.' });
  try {
    const pool = getPool();
    const clash = await pool.query('SELECT MassIntentionId AS id, IntentionDate AS date, IntentionTime AS time, Status AS status FROM "MassIntentions" WHERE IntentionDate=$1 AND IntentionTime=$2', [date, time]);
    const conflict = findIntentionConflict({ date, time }, clash.rows);
    if (conflict.conflict) return res.status(409).json({ message: conflict.message });
    const result = await pool.query(`INSERT INTO "MassIntentions" (IntentionDate, IntentionTime, Offering, RequestedBy, IntentionText, CreatedBy) RETURNING "MassIntentionId" VALUES ($1,$2,$3,$4,$5,$6)`, [date, time, Number(offering || 0), requestedBy, intentionText, staffName(req)]); res.status(201).json(result.rows[0]);
  } catch (error) { logError(error, { context: 'createMassIntention' }); res.status(500).json({ message: 'Unable to save Mass intention.' }); }
});

app.put('/api/admin/operations/mass-intentions/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid Mass intention ID.' });
  if (!['Scheduled', 'Completed', 'Cancelled'].includes(status)) return res.status(400).json({ message: 'Invalid intention status.' });
  try { await getPool().query('UPDATE "MassIntentions" SET Status=$2, "UpdatedAt" = NOW() WHERE MassIntentionId=$1', [id, status]); res.json({ message: 'Mass intention updated.' }); } catch (error) { logError(error, { context: 'updateMassIntention' }); res.status(500).json({ message: 'Unable to update Mass intention.' }); }
});

app.get('/api/admin/operations/finance', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper']), async (_req, res) => {
  try { const result = await getPool().query('SELECT * FROM "FinancialEntries" ORDER BY EntryDate DESC, FinancialEntryId DESC'); res.json(result.rows); } catch (error) { logError(error, { context: 'financeEntries' }); res.status(500).json({ message: 'Unable to load financial entries.' }); }
});

app.post('/api/admin/operations/finance', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper']), async (req, res) => {
  const { date, entryType, description, amount } = req.body || {};
  if (!date || !entryType || !description || Number(amount) <= 0) return res.status(400).json({ message: 'A valid finance date, type, description, and amount are required.' });
  try { const result = await getPool().query(`INSERT INTO "FinancialEntries" (EntryDate, EntryType, Description, Amount, EnteredBy) RETURNING "FinancialEntryId" VALUES ($1,$2,$3,$4,$5)`, [date, entryType, description, Number(amount), staffName(req)]); res.status(201).json(result.rows[0]); } catch (error) { logError(error, { context: 'createFinanceEntry' }); res.status(500).json({ message: 'Unable to save financial entry.' }); }
});

app.put('/api/admin/operations/finance/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper']), async (req, res) => {
  const id = Number(req.params.id); const { date, entryType, description, amount } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid financial entry.' });
  try {
    const pool = getPool();
    const current = await pool.query('SELECT * FROM "FinancialEntries" WHERE FinancialEntryId=$1', [id]);
    if (!current.rows[0]) return res.status(404).json({ message: 'Financial entry not found.' });
    const status = current.rows[0].Status || 'Draft';
    const next = financeTransition(status, 'edit');
    if (!next) return res.status(409).json({ message: `Entries with status '${status}' cannot be edited.` });
    if (!date || !entryType || !description || Number(amount) <= 0) return res.status(400).json({ message: 'A valid finance date, type, description, and amount are required.' });
    await pool.query('UPDATE "FinancialEntries" SET EntryDate=$2, EntryType=$3, Description=$4, Amount=$5, Status=$6, "UpdatedAt" = NOW() WHERE FinancialEntryId=$1', [id, date, entryType, description, Number(amount), next]);
    await pool.query(`INSERT INTO "FinancialEntryAudit" (FinancialEntryId, ActionName, ChangedBy, Details) VALUES ($1,'Edit',$2,$3)`, [id, staffName(req), JSON.stringify({ date, entryType, description, amount })]);
    res.json({ message: `Entry updated (status: ${next}).` });
  } catch (error) { logError(error, { context: 'editFinanceEntry' }); res.status(500).json({ message: 'Unable to update financial entry.' }); }
});

app.delete('/api/admin/operations/finance/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid financial entry.' });
  try {
    const pool = getPool();
    const current = await pool.query('SELECT Status FROM "FinancialEntries" WHERE FinancialEntryId=$1', [id]);
    if (!current.rows[0]) return res.status(404).json({ message: 'Financial entry not found.' });
    if (financeTransition(current.rows[0].Status || 'Draft', 'delete') !== 'Deleted') return res.status(409).json({ message: `Entries with status '${current.rows[0].Status}' cannot be deleted.` });
    await pool.query(`INSERT INTO "FinancialEntryAudit" (FinancialEntryId, ActionName, ChangedBy, Details) VALUES ($1,'Delete',$2,$3); DELETE FROM "FinancialEntries" WHERE FinancialEntryId=$1`, [id, staffName(req), JSON.stringify(current.rows[0])]);
    res.json({ message: 'Draft entry deleted.' });
  } catch (error) { logError(error, { context: 'deleteFinanceEntry' }); res.status(500).json({ message: 'Unable to delete financial entry.' }); }
});

async function changeFinanceStatus(req, res, status) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid financial entry.' });
  const action = status === 'Approved' ? 'approve' : status === 'Reconciled' ? 'reconcile' : String(status).toLowerCase();
  try {
    const pool = getPool();
    const current = await pool.query('SELECT Status FROM "FinancialEntries" WHERE FinancialEntryId=$1', [id]);
    if (!current.rows[0]) return res.status(404).json({ message: 'Financial entry not found.' });
    const existing = current.rows[0].Status || 'Draft';
    const next = financeTransition(existing, action);
    if (next !== status) return res.status(409).json({ message: `Cannot move a '${existing}' entry to '${status}'. Follow the Draft, Submitted, Approved, Reconciled workflow.` });
    const fields = status === 'Approved' ? '"Status"=$2, "ApprovedBy"=$3, "ApprovedAt"=NOW()' : status === 'Reconciled' ? '"Status"=$2, "ReconciledBy"=$3, "ReconciledAt"=NOW()' : '"Status"=$2';
    await pool.query(`UPDATE "FinancialEntries" SET ${fields}, "UpdatedAt" = NOW() WHERE "FinancialEntryId"=$1`, [id, status, staffName(req)]);
    await pool.query(`INSERT INTO "FinancialEntryAudit" ("FinancialEntryId", "ActionName", "ChangedBy", "Details") VALUES ($1,$2,$3,$2)`, [id, status, staffName(req)]);
    res.json({ message: `Entry ${status.toLowerCase()}.` });
  } catch (error) { logError(error, { context: `finance${status}` }); res.status(500).json({ message: 'Unable to update financial entry.' }); }
}
app.post('/api/admin/operations/finance/:id/submit', requireAdmin, requireRole(['Bookkeeper']), (req, res) => changeFinanceStatus(req, res, 'Submitted'));
app.post('/api/admin/operations/finance/:id/reject', requireAdmin, requireRole(['ParishPriest', 'Secretary']), (req, res) => changeFinanceStatus(req, res, 'Rejected'));
app.post('/api/admin/operations/finance/:id/approve', requireAdmin, requireRole(['ParishPriest', 'Secretary']), (req, res) => changeFinanceStatus(req, res, 'Approved'));
app.post('/api/admin/operations/finance/:id/reconcile', requireAdmin, requireRole(['Bookkeeper']), (req, res) => changeFinanceStatus(req, res, 'Reconciled'));

app.get('/api/admin/operations/finance/report', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper', 'Staff']), async (req, res) => {
  const { start, end, type, format } = req.query || {};
  try {
    const params = [];
    const conditions = [`"Status" IN ('Approved','Reconciled')`];
    if (start && isValidDate(String(start))) { params.push(String(start)); conditions.push(`"EntryDate" >= $${params.length}`); }
    if (end && isValidDate(String(end))) { params.push(String(end)); conditions.push(`"EntryDate" <= $${params.length}`); }
    if (type) { params.push(String(type)); conditions.push(`"EntryType" = $${params.length}`); }
    const where = conditions.join(' AND ');
    const result = await getPool().query(`SELECT "EntryType", COUNT(*) AS "EntryCount", SUM("Amount") AS "Total" FROM "FinancialEntries" WHERE ${where} GROUP BY "EntryType" ORDER BY "EntryType"`, params);
    if (String(format || '').toLowerCase() === 'csv') {
      const csv = toCsv(result.rows, [{ key: 'EntryType', label: 'Category' }, { key: 'EntryCount', label: 'Entries' }, { key: 'Total', label: 'Total' }]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="finance-report.csv"');
      return res.send(csv);
    }
    res.json({ totals: result.rows, filters: { start: start || null, end: end || null, type: type || null } });
  } catch (error) { logError(error, { context: 'financeReport' }); res.status(500).json({ message: 'Unable to generate finance report.' }); }
});

app.get('/api/admin/operations/finance/audit', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper']), async (_req, res) => {
  try { const result = await getPool().query(`SELECT a.*, f.EntryType, f.Description FROM "FinancialEntryAudit" a JOIN "FinancialEntries" f ON f.FinancialEntryId=a.FinancialEntryId ORDER BY a.ChangedAt DESC`); res.json(result.rows); } catch (error) { logError(error, { context: 'financeAudit' }); res.status(500).json({ message: 'Unable to load finance audit history.' }); }
});

app.get('/api/admin/operations/finance/reports', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper', 'Staff']), async (_req, res) => {
  try { const result = await getPool().query('SELECT * FROM "FinanceReportSnapshots" ORDER BY GeneratedAt DESC'); res.json(result.rows); } catch (error) { logError(error, { context: 'financeReportHistory' }); res.status(500).json({ message: 'Unable to load finance report history.' }); }
});

app.get('/api/admin/operations/applications/:id/history', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  try { const result = await getPool().query('SELECT * FROM "ApplicationEditLog" WHERE ServiceRequestId=$1 ORDER BY ChangedAt DESC', [Number(req.params.id)]); res.json(result.rows); } catch (error) { logError(error, { context: 'applicationHistory' }); res.status(500).json({ message: 'Unable to load application history.' }); }
});

app.put('/api/admin/operations/applications/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const id = Number(req.params.id); const body = req.body || {};
  try {
    const db = getPool();
    await db.query(`UPDATE "ServiceRequest" SET ContactFirstName=$2, ContactLastName=$3, ContactEmail=$4, ContactMobile=$5, ContactAddress=$6, ScheduledDate=$7, ScheduledTime=$8, Notes=$9 WHERE ServiceRequestId=$1`, [id, body.firstName, body.lastName, body.email, body.mobileNumber || null, body.address || null, body.scheduledDate, body.scheduledTime, body.notes || null]);
    await db.query('INSERT INTO "ApplicationEditLog" (ServiceRequestId, ChangedBy, Changes) VALUES ($1,$2,$3)', [id, staffName(req), JSON.stringify(body)]);
    res.json({ message: 'Application updated.' });
  } catch (error) { logError(error, { context: 'updateApplication' }); res.status(500).json({ message: 'Unable to update application.' }); }
});

app.post('/api/admin/operations/applications/:id/attendance', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const attendanceStatus = String(req.body?.attendanceStatus || '');
  if (!['Present', 'NoShow'].includes(attendanceStatus)) return res.status(400).json({ message: 'Attendance must be Present or NoShow.' });
  try { await getPool().query(`UPDATE "ServiceRequest" SET AttendanceStatus=$2, "AttendanceMarkedAt" = NOW(), Status=CASE WHEN $2='NoShow' THEN 'VoidedNoShow' ELSE Status END, VoidedAt=CASE WHEN $2='NoShow' THEN NOW() ELSE VoidedAt END WHERE ServiceRequestId=$1`, [Number(req.params.id), attendanceStatus]); res.json({ message: 'Attendance recorded.' }); } catch (error) { logError(error, { context: 'markAttendance' }); res.status(500).json({ message: 'Unable to record attendance.' }); }
});

app.get('/api/admin/operations/statistics', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Admin']), async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  try {
    const db = getPool();
    const [summary, monthly, demographics] = await Promise.all([
      db.query(`SELECT (SELECT COUNT(*) FROM "BaptismRecords" WHERE EXTRACT(year FROM DateOfBaptism)::int=$1) AS totalBaptisms, (SELECT COUNT(*) FROM "ConfirmationRecords" WHERE EXTRACT(year FROM DateOfConfirmation)::int=$1) AS totalConfirmations, (SELECT COUNT(*) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1) AS totalMarriages, (SELECT COUNT(*) FROM "DeathRecords" WHERE EXTRACT(year FROM DateOfDeath)::int=$1) AS totalDeaths`, [year]),
      db.query(`SELECT m.month, TO_CHAR(MAKE_DATE(($1)::int, (m.month)::int, 1)) AS monthName, (SELECT COUNT(*) FROM "BaptismRecords" WHERE EXTRACT(year FROM DateOfBaptism)::int=$1 AND EXTRACT(month FROM DateOfBaptism)::int=m.month) AS baptisms, (SELECT COUNT(*) FROM "ConfirmationRecords" WHERE EXTRACT(year FROM DateOfConfirmation)::int=$1 AND EXTRACT(month FROM DateOfConfirmation)::int=m.month) AS confirmations, (SELECT COUNT(*) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1 AND EXTRACT(month FROM DateOfMarriage)::int=m.month) AS marriages, (SELECT COUNT(*) FROM "DeathRecords" WHERE EXTRACT(year FROM DateOfDeath)::int=$1 AND EXTRACT(month FROM DateOfDeath)::int=m.month) AS deaths FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) m(month) ORDER BY m.month`, [year]),
      db.query(`SELECT (SELECT COUNT(*) FROM "BaptismRecords" WHERE EXTRACT(year FROM DateOfBaptism)::int=$1 AND EXTRACT(year FROM age(DateOfBaptism, DateOfBirth))::int=0) AS InfantsUnder1Yr, (SELECT COUNT(*) FROM "BaptismRecords" WHERE EXTRACT(year FROM DateOfBaptism)::int=$1 AND EXTRACT(year FROM age(DateOfBaptism, DateOfBirth))::int>0) AS ChildrenOver1Yr, (SELECT AVG(CAST(GroomAge AS decimal(10,2))) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1) AS AvgGroomAge, (SELECT AVG(CAST(BrideAge AS decimal(10,2))) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1) AS AvgBrideAge, (SELECT COUNT(*) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1 AND GroomAge < 25 AND BrideAge < 25) AS Under25, (SELECT COUNT(*) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1 AND ((GroomAge BETWEEN 25 AND 35) OR (BrideAge BETWEEN 25 AND 35))) AS Age25To35, (SELECT COUNT(*) FROM "MarriageRecords" WHERE EXTRACT(year FROM DateOfMarriage)::int=$1 AND (GroomAge > 35 OR BrideAge > 35)) AS Over35, (SELECT AVG(CAST(Age AS decimal(10,2))) FROM "DeathRecords" WHERE EXTRACT(year FROM DateOfDeath)::int=$1) AS AvgDeceasedAge, (SELECT COUNT(*) FROM "DeathRecords" WHERE EXTRACT(year FROM DateOfDeath)::int=$1 AND Age < 18) AS Under18, (SELECT COUNT(*) FROM "DeathRecords" WHERE EXTRACT(year FROM DateOfDeath)::int=$1 AND Age BETWEEN 18 AND 59) AS Age18To59, (SELECT COUNT(*) FROM "DeathRecords" WHERE EXTRACT(year FROM DateOfDeath)::int=$1 AND Age >= 60) AS Senior60Plus`, [year]),
    ]);
    const row = summary.rows[0] || {};
    const demographicRow = demographics.rows[0] || {};
    res.json({ targetYear: year, summary: row, monthlyBreakdown: monthly.rows, demographics: { baptisms: { InfantsUnder1Yr: demographicRow.InfantsUnder1Yr || 0, ChildrenOver1Yr: demographicRow.ChildrenOver1Yr || 0 }, marriages: { AvgGroomAge: demographicRow.AvgGroomAge || 0, AvgBrideAge: demographicRow.AvgBrideAge || 0, Under25: demographicRow.Under25 || 0, Age25To35: demographicRow.Age25To35 || 0, Over35: demographicRow.Over35 || 0 }, deaths: { AvgDeceasedAge: demographicRow.AvgDeceasedAge || 0, Under18: demographicRow.Under18 || 0, Age18To59: demographicRow.Age18To59 || 0, Senior60Plus: demographicRow.Senior60Plus || 0 } } });
  } catch (error) { logError(error, { context: 'statisticalReport' }); res.status(500).json({ message: 'Unable to generate statistical report.' }); }
});

// Service utilization and no-show reporting for planning and monitoring.
app.get('/api/admin/operations/reports/utilization', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Bookkeeper']), async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  try {
    const db = getPool();
    const [utilization, noShows] = await Promise.all([
      db.query(`SELECT s.Name AS ServiceName, COUNT(*) AS TotalRequests, SUM(CASE WHEN sr.Status='Completed' THEN 1 ELSE 0 END) AS Completed, SUM(CASE WHEN sr.Status='Confirmed' THEN 1 ELSE 0 END) AS Confirmed, SUM(CASE WHEN sr.Status IN ('Cancelled','Voided','VoidedNoShow','ConflictVoided') THEN 1 ELSE 0 END) AS CancelledOrVoided FROM "ServiceRequest" sr JOIN "Service" s ON s.ServiceId=sr.ServiceId WHERE EXTRACT(year FROM sr.ScheduledDate)::int=$1 GROUP BY s.Name ORDER BY TotalRequests DESC`, [year]),
      db.query(`SELECT s.Name AS ServiceName, COUNT(*) AS NoShows FROM "ServiceRequest" sr JOIN "Service" s ON s.ServiceId=sr.ServiceId WHERE EXTRACT(year FROM sr.ScheduledDate)::int=$1 AND (sr.Status='VoidedNoShow' OR sr.AttendanceStatus='NoShow') GROUP BY s.Name ORDER BY NoShows DESC`, [year]),
    ]);
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const csv = toCsv(utilization.rows, [{ key: 'ServiceName', label: 'Service' }, { key: 'TotalRequests', label: 'Requests' }, { key: 'Completed', label: 'Completed' }, { key: 'Confirmed', label: 'Confirmed' }, { key: 'CancelledOrVoided', label: 'CancelledOrVoided' }]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="service-utilization-${year}.csv"`);
      return res.send(csv);
    }
    res.json({ targetYear: year, utilization: utilization.rows, noShows: noShows.rows });
  } catch (error) { logError(error, { context: 'utilizationReport' }); res.status(500).json({ message: 'Unable to generate utilization report.' }); }
});

app.get('/api/admin/sacramental/search', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const requestedType = String(req.query.type || '').toLowerCase();
  const definitions = requestedType && sacramentalDefinitions[requestedType] ? [[requestedType, sacramentalDefinitions[requestedType]]] : Object.entries(sacramentalDefinitions);
  const q = String(req.query.q || ''); const startDate = String(req.query.startDate || ''); const endDate = String(req.query.endDate || ''); const priest = String(req.query.priest || '');
  try {
    const db = getPool(); const queries = [];
    for (const [type, definition] of definitions) {
      const typeParams = [];
      const conditions = ['1=1'];
      if (q) { typeParams.push(`%${q}%`); conditions.push(`(${definition.name} ILIKE $${typeParams.length} OR "RegistryNumber" ILIKE $${typeParams.length})`); }
      if (startDate) { typeParams.push(startDate); conditions.push(`${definition.date} >= $${typeParams.length}`); }
      if (endDate) { typeParams.push(endDate); conditions.push(`${definition.date} <= $${typeParams.length}`); }
      if (priest) { typeParams.push(`%${priest}%`); conditions.push(`${definition.priest} ILIKE $${typeParams.length}`); }
      const where = conditions.join(' AND ');
      queries.push(db.query(
        `SELECT '${type}' AS "RecordType", ${definition.id} AS "Id", "RegistryNumber", ${definition.name} AS "Name", ${definition.date} AS "RecordDate", ${definition.priest} AS "Priest", "ScannedDocumentUrl" FROM "${definition.table}" WHERE ${where}`,
        typeParams
      ));
    }
    const results = await Promise.all(queries); const records = results.flatMap(result => result.rows); res.json({ records, pagination: { total: records.length } });
  } catch (error) { logError(error, { context: 'sacramentalSearch' }); res.status(500).json({ message: 'Unable to search sacramental records.' }); }
});

for (const [type, definition] of Object.entries(sacramentalDefinitions)) {
  app.get(`/api/admin/sacramental/${type}/:id`, requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => { try { const result = await getPool().query(`SELECT * FROM "${definition.table}" WHERE ${definition.id}=$1`, [Number(req.params.id)]); if (!result.rows[0]) return res.status(404).json({ message: 'Record not found.' }); res.json(result.rows[0]); } catch (error) { logError(error, { context: 'sacramentalDetail' }); res.status(500).json({ message: 'Unable to load record.' }); } });
  app.get(`/api/admin/sacramental/${type}/:id/audit`, requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => { try { const result = await getPool().query('SELECT * FROM "SacramentalRecordAudit" WHERE RecordType=$1 AND RecordId=$2 ORDER BY ChangedAt DESC', [type, Number(req.params.id)]); res.json(result.rows); } catch (error) { logError(error, { context: 'sacramentalAudit' }); res.status(500).json({ message: 'Unable to load record history.' }); } });
  app.post(`/api/admin/sacramental/${type}`, requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => saveSacramentalRecord(req, res, type, definition, null));
  app.put(`/api/admin/sacramental/${type}/:id`, requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => saveSacramentalRecord(req, res, type, definition, Number(req.params.id)));
  app.delete(`/api/admin/sacramental/${type}/:id`, requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
    try {
      const db = getPool(); const recordId = Number(req.params.id);
      if (!Number.isInteger(recordId) || recordId <= 0) return res.status(400).json({ message: 'Invalid record ID.' });
      const existing = await db.query(`SELECT * FROM "${definition.table}" WHERE ${definition.id}=$1`, [recordId]);
      if (!existing.rows[0]) return res.status(404).json({ message: 'Record not found.' });
      await db.query(`DELETE FROM "${definition.table}" WHERE ${definition.id}=$1`, [recordId]);
      await db.query('INSERT INTO "SacramentalRecordAudit" (RecordType, RecordId, ActionName, ChangedBy, Changes) VALUES ($1,$2,$3,$4,$5)', [type, recordId, 'Delete', staffName(req), JSON.stringify(existing.rows[0])]);
      res.json({ message: 'Record removed and archived in the audit log.' });
    } catch (error) { logError(error, { context: 'deleteSacramentalRecord' }); res.status(500).json({ message: 'Unable to delete sacramental record.' }); }
  });
}

async function saveSacramentalRecord(req, res, type, definition, id) {
  try {
    const db = getPool(); const fields = definition.columns; const values = fields.map(field => requestValue(req.body || {}, field));
    const action = id ? 'Edit' : 'Create';
    let previous = null;
    if (id) {
      const prior = await db.query(`SELECT * FROM "${definition.table}" WHERE ${definition.id}=$1`, [id]);
      previous = prior.rows[0] || null;
      if (!previous) return res.status(404).json({ message: 'Record not found.' });
      // $1 = id, $2..$N = field values in definition order
      const updateParams = [id, ...values];
      const setClauses = fields.map((field, index) => `"${field}"=$${index + 2}`).join(', ');
      await db.query(`UPDATE "${definition.table}" SET ${setClauses}, "UpdatedAt"=NOW() WHERE "${definition.id}"=$1`, updateParams);
    }
    else {
      // $1..$N = field values, $N+1 = createdBy
      const insertParams = [...values, staffName(req)];
      const colList = fields.map(f => `"${f}"`).join(', ');
      const valList = fields.map((_, i) => `$${i + 1}`).join(', ');
      const result = await db.query(
        `INSERT INTO "${definition.table}" (${colList}, "CreatedBy") VALUES (${valList}, $${insertParams.length}) RETURNING "${definition.id}" AS id`,
        insertParams
      );
      id = result.rows[0].id;
    }
    // Field-level audit: record who changed the record, when, and the previous/new values.
    const changes = {};
    fields.forEach((field, index) => {
      const before = previous ? previous[field] : null;
      const after = values[index];
      if (!previous || String(before ?? '') !== String(after ?? '')) changes[field] = { before: before ?? null, after: after ?? null };
    });
    await db.query('INSERT INTO "SacramentalRecordAudit" (RecordType, RecordId, ActionName, ChangedBy, Changes) VALUES ($1,$2,$3,$4,$5)', [type, id, action, staffName(req), JSON.stringify(changes)]);
    res.json({ id });
  } catch (error) { logError(error, { context: 'saveSacramentalRecord' }); res.status(500).json({ message: 'Unable to save sacramental record.' }); }
}

app.get('/api/admin/sacramental/archives', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const { sacramentType, bookNumber, pageNumber, registryNumber } = req.query || {};
  try {
    const db = getPool();
    const params = [];
    const conditions = ['1=1'];
    if (sacramentType) { params.push(String(sacramentType)); conditions.push(`a."SacramentType"=$${params.length}`); }
    if (Number.isInteger(Number(bookNumber)) && bookNumber) { params.push(Number(bookNumber)); conditions.push(`a."BookNumber"=$${params.length}`); }
    if (Number.isInteger(Number(pageNumber)) && pageNumber) { params.push(Number(pageNumber)); conditions.push(`a."PageNumber"=$${params.length}`); }
    const where = conditions.join(' AND ');
    const result = await db.query(`SELECT a.* FROM "SacramentalArchives" a WHERE ${where} ORDER BY a."UploadedAt" DESC LIMIT 200`, params);
    let archives = result.rows;
    if (registryNumber) {
      // Registry-number search: keep archives whose file is attached to the matching ledger record.
      const definition = sacramentalDefinitions[String(sacramentType || '').toLowerCase()];
      if (definition) {
        const match = await db.query(`SELECT "ScannedDocumentUrl" FROM "${definition.table}" WHERE "RegistryNumber"=$1`, [String(registryNumber).trim()]);
        const urls = new Set(match.rows.map(row => row.ScannedDocumentUrl).filter(Boolean));
        archives = archives.filter(archive => urls.has(archive.FileUrl));
      } else {
        archives = [];
      }
    }
    res.json({ archives });
  } catch (error) { logError(error, { context: 'sacramentalArchives' }); res.status(500).json({ message: 'Unable to load archives.' }); }
});
app.post('/api/admin/sacramental/upload-archive', requireAdmin, requireRole(['ParishPriest', 'Secretary']), (req, res, next) => {
  archiveUpload.single('document')(req, res, error => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'Archive files must be 20 MB or smaller.' });
    if (error) return res.status(400).json({ message: 'Archive files must be JPEG, PNG, TIFF, or PDF.' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'A scanned document is required.' });
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}` });
});
app.post('/api/admin/sacramental/archives', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => { const { sacramentType, bookNumber, pageNumber, fileUrl, notes } = req.body || {}; try { const result = await getPool().query('INSERT INTO "SacramentalArchives" (SacramentType, BookNumber, PageNumber, FileUrl, Notes, UploadedBy) RETURNING "ArchiveId" VALUES ($1,$2,$3,$4,$5,$6)', [sacramentType, Number(bookNumber), Number(pageNumber), fileUrl, notes || null, staffName(req)]); res.status(201).json(result.rows[0]); } catch (error) { logError(error, { context: 'createSacramentalArchive' }); res.status(500).json({ message: 'Unable to save archive entry.' }); } });
app.put('/api/admin/sacramental/archives/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number(req.params.id); const { bookNumber, pageNumber, notes } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid archive ID.' });
  if (!Number.isInteger(Number(bookNumber)) || !Number.isInteger(Number(pageNumber))) return res.status(400).json({ message: 'Book and page numbers are required.' });
  try {
    const result = await getPool().query('UPDATE "SacramentalArchives" SET BookNumber=$2, PageNumber=$3, Notes=$4 WHERE ArchiveId=$1', [id, Number(bookNumber), Number(pageNumber), notes || null]);
    if (!result.rowCount) return res.status(404).json({ message: 'Archive entry not found.' });
    res.json({ message: 'Archive entry updated.' });
  } catch (error) { logError(error, { context: 'updateSacramentalArchive' }); res.status(500).json({ message: 'Unable to update archive entry.' }); }
});
app.delete('/api/admin/sacramental/archives/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid archive ID.' });
  try {
    const result = await getPool().query('DELETE FROM "SacramentalArchives" OUTPUT DELETED.FileUrl WHERE ArchiveId=$1', [id]);
    const fileUrl = result.rows[0]?.FileUrl;
    if (String(fileUrl).startsWith('/uploads/')) {
      fs.promises.unlink(path.join(uploadDirectory, path.basename(String(fileUrl)))).catch(() => {});
    }
    res.json({ message: 'Archive entry and file removed.' });
  } catch (error) { logError(error, { context: 'deleteSacramentalArchive' }); res.status(500).json({ message: 'Unable to delete archive entry.' }); }
});
// Protected archive download: requires a valid staff token (header or query) instead of the public /uploads URL.
app.get('/api/admin/sacramental/archives/:id/file', requireAdminWithQueryToken, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid archive ID.' });
  try {
    const result = await getPool().query('SELECT FileUrl FROM "SacramentalArchives" WHERE ArchiveId=$1', [id]);
    const fileUrl = result.rows[0]?.FileUrl;
    if (!fileUrl || !String(fileUrl).startsWith('/uploads/')) return res.status(404).json({ message: 'Archive file not found.' });
    const filePath = path.join(uploadDirectory, path.basename(String(fileUrl)));
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Archive file not found.' });
    return res.sendFile(filePath);
  } catch (error) { logError(error, { context: 'downloadSacramentalArchive' }); res.status(500).json({ message: 'Unable to download archive file.' }); }
});

// Prayer Request endpoints
app.post('/api/prayers', async (req, res) => {
  const { name, category, request, anonymous, shareWithCommunity } = req.body;

  if (!request || request.trim().length < 10) {
    return res.status(400).json({ message: 'Prayer request must be at least 10 characters.' });
  }

  if (request.trim().length > 2000) {
    return res.status(400).json({ message: 'Prayer request must not exceed 2000 characters.' });
  }

  // Validate name if provided and not anonymous
  if (!anonymous && name && String(name).trim().length < 2) {
    return res.status(400).json({ message: 'Please provide a valid name.' });
  }

  try {
    const pool = getPool();
    
    const result = await pool.query(`
      INSERT INTO "PrayerRequests" (Name, Category, Request, Anonymous, ShareWithCommunity, CreatedAt, IsApproved)
      RETURNING "PrayerId"
      VALUES ($1, $2, $3, $4, $5, NOW(), 0)
    `, [String(name || ''), String(category || 'other'), String(request), anonymous ? 1 : 0, shareWithCommunity ? 1 : 0]);

    res.json({
      prayerId: result.rows[0]?.PrayerId,
      message: 'Prayer request submitted successfully. Thank you for your faith.'
    });
  } catch (error) {
    console.error('Prayer submission error:', error);
    res.status(500).json({ message: 'Unable to submit prayer request.' });
  }
});

app.get('/api/prayers', async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT PrayerId, Name, Category, Request, ShareWithCommunity, CreatedAt
      FROM "PrayerRequests"
      WHERE IsApproved = 1 AND ShareWithCommunity = 1
      ORDER BY CreatedAt DESC
    `);

    const prayers = result.rows.map(row => ({
      id: row.PrayerId,
      name: row.Name,
      category: row.Category,
      request: row.Request,
      createdAt: row.CreatedAt
    }));

    res.json(prayers);
  } catch (error) {
    console.error('Prayers lookup error:', error);
    res.status(500).json({ message: 'Unable to load prayers.' });
  }
});

app.get('/api/prayers/:prayerId', async (req, res) => {
  const prayerId = Number(req.params.prayerId);

  if (!Number.isInteger(prayerId) || prayerId <= 0) {
    return res.status(400).json({ message: 'Invalid prayer ID.' });
  }

  try {
    const pool = getPool();
    
    const result = await pool.query(`
      SELECT PrayerId, Name, Category, Request, CreatedAt
      FROM "PrayerRequests"
      WHERE PrayerId = $1 AND "IsApproved" = TRUE AND "ShareWithCommunity" = TRUE
    `, [prayerId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Prayer not found.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Prayer lookup error:', error);
    res.status(500).json({ message: 'Unable to load prayer.' });
  }
});

app.post('/api/prayers/:prayerId/approve', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const prayerId = Number(req.params.prayerId);

  if (!Number.isInteger(prayerId) || prayerId <= 0) {
    return res.status(400).json({ message: 'Invalid prayer ID.' });
  }

  try {
    const pool = getPool();
    
    await pool.query(`
      UPDATE "PrayerRequests"
      SET "IsApproved" = TRUE
      WHERE PrayerId = $1
    `, [prayerId]);

    res.json({ message: 'Prayer approved.' });
  } catch (error) {
    console.error('Prayer approval error:', error);
    res.status(500).json({ message: 'Unable to approve prayer.' });
  }
});

app.get('/health', handleHealthCheck);

// Metrics endpoint (for monitoring and debugging)
app.get('/api/metrics', handleMetricsRequest);

app.post('/api/test-email', async (req, res) => {
  const { email, subject, message } = req.body;

  if (!email || !subject || !message) {
    return res.status(400).json({ message: 'Email, subject, and message are required.' });
  }

  try {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2></h2>
        <p></p>
        <p>---<br>This is a test email from your Parish website booking system.</p>
      </div>
    `;

    const result = await sendEmail(email, subject, html);

    if (result) {
      res.json({ success: true, message: 'Test email sent successfully!' });
    } else {
      res.status(500).json({ message: 'Failed to send test email. Check API key and try again.' });
    }
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ message: 'Error sending test email.' });
  }
});

const port = Number(process.env.PORT || 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

app.listen(port, () => {
  logger.info('API server started', {
    port,
    environment: process.env.NODE_ENV || 'development',
  });
});

// Initialize database pool and handle graceful shutdown
(async () => {
  try {
    await initializePool();
    logger.info('Database pool initialized successfully');

    // Start cleanup of expired tokens every 60 minutes
    startTokenCleanupSchedule(60);

    startFinanceReportSchedule();
    logger.info('Weekly and monthly finance report generation started');

    startNoShowVoidSchedule();
    logger.info('Automatic no-show and unverified-booking voiding started');
  } catch (error) {
    logError(error, { context: 'Server initialization' });
    process.exit(1);
  }
})();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.warn('SIGTERM received, shutting down gracefully...');
  await closePool();
  logger.info('Database pool closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.warn('SIGINT received, shutting down gracefully...');
  await closePool();
  logger.info('Database pool closed');
  process.exit(0);
});

const portalUpload = multer({
  storage: upload.storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => {
    callback(null, file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'));
  },
});

app.post('/api/portal/certificate-requests/:requestId/documents', requirePortal, (req, res, next) => {
  portalUpload.array('documents', 5)(req, res, async error => {
    if (error) return res.status(400).json({ message: 'Documents must be PDF or image files smaller than 10 MB each.' });
    try {
      const requestId = Number(req.params.requestId);
      const files = req.files || [];
      const ownsRequest = await getPool().query(`
        SELECT CertificateRequestId FROM "CertificateRequests" WHERE CertificateRequestId = $1 AND AccountId = $2
      `, [requestId, req.portalAccount.AccountId]);
      if (!ownsRequest.rows.length) return res.status(404).json({ message: 'Certificate request not found.' });
      for (const file of files) {
        await getPool().query(`INSERT INTO "CertificateRequestDocuments" (CertificateRequestId, OriginalFileName, StoredFileName, FileUrl, MimeType, FileSizeBytes) VALUES ($1, $2, $3, $4, $5, $6)`, [requestId, file.originalname, file.filename, `/uploads/${file.filename}`, file.mimetype, file.size]);
      }
      res.status(201).json({ message: 'Documents uploaded.' });
    } catch (error) {
      logError(error, { context: 'uploadCertificateDocuments' });
      next(error);
    }
  });
});

const BLOCK_SCOPES = ['All', 'Service', 'Certificate'];

app.get('/api/blocked-slots', async (_req, res) => {
  try {
    const result = await getPool().query(`SELECT CONVERT(varchar(10), BlockDate, 23) AS date, BlockTime AS time, Scope AS scope, ServiceId AS serviceId, Reason AS reason FROM "BlockedSlots" WHERE BlockDate >= CAST(SYSUTCDATETIME() AS date)`);
    res.json(result.rows);
  } catch (error) {
    logError(error, { context: 'publicBlockedSlots' });
    res.status(500).json({ message: 'Unable to load unavailable dates.' });
  }
});

app.get('/api/admin/blocked-slots', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (_req, res) => {
  try {
    const result = await getPool().query(`
      SELECT b.BlockedSlotId AS id, CONVERT(varchar(10), b.BlockDate, 23) AS date, b.BlockTime AS time,
             b.Scope AS scope, b.ServiceId AS serviceId, s.Name AS serviceName, b.Reason AS reason,
             b.CreatedBy AS createdBy, b.CreatedAt AS createdAt
      FROM "BlockedSlots" b LEFT JOIN "Service" s ON s."ServiceId" = b."ServiceId"
      WHERE b."BlockDate" >= CURRENT_DATE
      ORDER BY b."BlockDate", b."BlockTime"`);
    res.json(result.rows);
  } catch (error) {
    logError(error, { context: 'listBlockedSlots' });
    res.status(500).json({ message: 'Unable to load blocked slots.' });
  }
});

app.post('/api/admin/blocked-slots', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const { date, time, scope, serviceId, reason } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !isValidDate(date)) return res.status(400).json({ message: 'Please provide a valid date.' });
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) return res.status(400).json({ message: 'Please provide a valid time.' });
  if (!BLOCK_SCOPES.includes(scope)) return res.status(400).json({ message: 'Please choose what to block.' });
  const numericServiceId = scope === 'Service' ? Number(serviceId) : null;
  if (scope === 'Service' && (!Number.isInteger(numericServiceId) || numericServiceId <= 0)) return res.status(400).json({ message: 'Please choose a service.' });
  try {
    const result = await getPool().query(`INSERT INTO "BlockedSlots" (BlockDate, BlockTime, Scope, ServiceId, Reason, CreatedBy) OUTPUT INSERTED.BlockedSlotId AS id VALUES ($1, $2, $3, $4, $5, $6)`, [date, time || null, scope, numericServiceId, reason ? String(reason).trim().slice(0, 300) : null, String(req.staff?.email || req.staff?.userId || '').slice(0, 100)]);
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    logError(error, { context: 'createBlockedSlot' });
    res.status(500).json({ message: 'Unable to block that date or time.' });
  }
});

app.delete('/api/admin/blocked-slots/:id', requireAdmin, requireRole(['ParishPriest', 'Secretary']), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid request.' });
  try {
    await getPool().query('DELETE FROM "BlockedSlots" WHERE BlockedSlotId=$1', [id]);
    res.json({ success: true });
  } catch (error) {
    logError(error, { context: 'deleteBlockedSlot' });
    res.status(500).json({ message: 'Unable to unblock that slot.' });
  }
});

app.get('/api/admin/certificate-requests', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (_req, res) => {
  try {
    // Include guest requests (AccountId is NULL) by preferring the stored contact fields,
    // falling back to the linked parishioner profile for account-based requests.
    const result = await getPool().query(`
      SELECT cr.CertificateRequestId, cr.CertificateType, cr.PreferredDate, cr.PreferredTime, cr.Status, cr.Notes,
        COALESCE(cr.FirstName, p.FirstName, '') AS FirstName,
        COALESCE(cr.LastName, p.LastName, '') AS LastName,
        COALESCE(cr.ContactEmail, p.EmailAddress, '') AS EmailAddress,
        cr.ReferenceCode,
        COUNT(crd.CertificateRequestDocumentId) AS DocumentCount
      FROM "CertificateRequests" cr
      LEFT JOIN "ParishionerAccounts" a ON a."AccountId" = cr."AccountId"
      LEFT JOIN "Parishioners" p ON p."ParishionerId" = a."ParishionerId"
      LEFT JOIN "CertificateRequestDocuments" crd ON crd.CertificateRequestId = cr.CertificateRequestId
      GROUP BY cr.CertificateRequestId, cr.CertificateType, cr.PreferredDate, cr.PreferredTime, cr.Status, cr.Notes,
        cr.FirstName, cr.LastName, cr.ContactEmail, cr.ReferenceCode, p.FirstName, p.LastName, p.EmailAddress, cr.CreatedAt
      ORDER BY cr.CreatedAt DESC
    `);
    res.json(result.rows);
  } catch (error) {
    logError(error, { context: 'adminCertificateRequests' });
    res.status(500).json({ message: 'Unable to load certificate appointments.' });
  }
});

app.get('/api/admin/certificate-requests/:requestId/documents', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ message: 'Invalid certificate request ID.' });
  }
  try {
    const result = await getPool().query(`
      SELECT CertificateRequestDocumentId, CertificateRequestId, OriginalFileName, StoredFileName, FileUrl, MimeType, FileSizeBytes, UploadedAt
      FROM "CertificateRequestDocuments"
      WHERE CertificateRequestId = $1
      ORDER BY UploadedAt DESC
    `, [requestId]);
    res.json(result.rows.map(document => ({
      ...document,
      FileUrl: `/api/admin/certificate-requests/${requestId}/documents/${document.CertificateRequestDocumentId}/file`,
    })));
  } catch (error) {
    logError(error, { context: 'adminCertificateDocuments' });
    res.status(500).json({ message: 'Unable to load request documents.' });
  }
});

app.get('/api/admin/certificate-requests/:requestId/documents/:documentId/file', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const requestId = Number(req.params.requestId);
  const documentId = Number(req.params.documentId);
  if (!Number.isInteger(requestId) || requestId <= 0 || !Number.isInteger(documentId) || documentId <= 0) {
    return res.status(400).json({ message: 'Invalid certificate document ID.' });
  }
  try {
    const result = await getPool().query('SELECT FileUrl, OriginalFileName, MimeType FROM "CertificateRequestDocuments" WHERE CertificateRequestId=$1 AND CertificateRequestDocumentId=$2', [requestId, documentId]);
    const document = result.rows[0];
    if (!document?.FileUrl || !String(document.FileUrl).startsWith('/uploads/')) {
      return res.status(404).json({ message: 'Certificate document not found.' });
    }
    const filePath = path.join(uploadDirectory, path.basename(String(document.FileUrl)));
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Certificate document not found.' });
    res.type(document.MimeType || 'application/octet-stream');
    return res.sendFile(filePath, { headers: { 'Content-Disposition': `inline; filename="${path.basename(document.OriginalFileName || 'document')}"` } });
  } catch (error) {
    logError(error, { context: 'downloadCertificateDocument' });
    return res.status(500).json({ message: 'Unable to download certificate document.' });
  }
});

app.put('/api/admin/certificate-requests/:requestId', requireAdmin, requireRole(['ParishPriest', 'Secretary', 'Staff']), async (req, res) => {
  const allowed = ['Requested', 'Confirmed', 'ReadyForClaim', 'Claimed', 'Rejected'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ message: 'Invalid certificate request status.' });
  try {
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(requestId) || requestId <= 0) return res.status(400).json({ message: 'Invalid certificate request ID.' });
    if (req.body.status === 'Confirmed') {
      const conflict = await getPool().query(`
        SELECT TOP 1 CertificateRequestId
        FROM "CertificateRequests"
        WHERE CertificateRequestId=$1
          AND Status IN ('Confirmed', 'ReadyForClaim', 'Claimed')
      `, [requestId]);
      if (!conflict.rows[0]) {
        const requested = await getPool().query('SELECT PreferredDate, PreferredTime FROM "CertificateRequests" WHERE CertificateRequestId=$1', [requestId]);
        const appointment = requested.rows[0];
        if (!appointment) return res.status(404).json({ message: 'Certificate request not found.' });
        const clash = await getPool().query(`SELECT "CertificateRequestId" FROM "CertificateRequests" WHERE "CertificateRequestId"<>$1 AND "PreferredDate"=$2 AND "PreferredTime"=$3 AND "Status" IN ('Confirmed','ReadyForClaim','Claimed')`, [requestId, appointment.PreferredDate, appointment.PreferredTime]);
        if (clash.rows[0]) return res.status(409).json({ message: 'That certificate appointment slot is already confirmed.' });
      }
    }
    await getPool().query(`
      UPDATE "CertificateRequests" SET Status = $2, UpdatedAt = SYSUTCDATETIME() WHERE CertificateRequestId = $1
    `, [requestId, req.body.status]);
    res.json({ message: 'Certificate request updated.' });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ message: 'That certificate appointment slot is already confirmed.' });
    logError(error, { context: 'updateAdminCertificateRequest' });
    res.status(500).json({ message: 'Unable to update certificate request.' });
  }
});