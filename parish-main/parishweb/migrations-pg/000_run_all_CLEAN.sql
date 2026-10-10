-- === 001_staff_mass_schedule.sql ===
-- Role-aware staff scheduling foundation.
-- Converted from MSSQL migration 001.

CREATE TABLE IF NOT EXISTS "MassSchedule" (
    "MassScheduleId"  SERIAL          NOT NULL CONSTRAINT "PK_MassSchedule" PRIMARY KEY,
    "Title"           TEXT            NOT NULL,
    "MassDate"        DATE            NOT NULL,
    "MassTime"        VARCHAR(10)     NOT NULL,
    "Location"        TEXT            NOT NULL,
    "PriestUsername"  VARCHAR(256)    NOT NULL,
    "Notes"           TEXT            NULL,
    "Status"          VARCHAR(30)     NOT NULL DEFAULT 'Scheduled',
    "CreatedAt"       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_MassSchedule_PriestDate"
    ON "MassSchedule" ("PriestUsername", "MassDate", "MassTime");

-- === 002_sacramental_records.sql ===
-- Sacramental Records Digital Ledger & Archives.
-- Converted from MSSQL migration 002.
-- Note: MSSQL UPDATE triggers for UpdatedAt removed; app sets UpdatedAt = NOW() on every UPDATE.

CREATE TABLE IF NOT EXISTS "BaptismRecords" (
    "BaptismId"           SERIAL          NOT NULL CONSTRAINT "PK_BaptismRecords" PRIMARY KEY,
    "RegistryNumber"      TEXT            NOT NULL,
    "ChildFirstName"      TEXT            NOT NULL,
    "ChildMiddleName"     TEXT            NULL,
    "ChildLastName"       TEXT            NOT NULL,
    "DateOfBirth"         DATE            NOT NULL,
    "PlaceOfBirth"        TEXT            NULL,
    "DateOfBaptism"       DATE            NOT NULL,
    "FatherFullName"      TEXT            NULL,
    "MotherFullName"      TEXT            NULL,
    "MinisterName"        TEXT            NOT NULL,
    "Sponsors"            TEXT            NULL,
    "Remarks"             TEXT            NULL,
    "ScannedDocumentUrl"  TEXT            NULL,
    "CreatedAt"           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "CreatedBy"           TEXT            NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_BaptismRecords_RegistryNumber" ON "BaptismRecords" ("RegistryNumber");
CREATE INDEX IF NOT EXISTS "IX_BaptismRecords_DateOfBaptism"        ON "BaptismRecords" ("DateOfBaptism");
CREATE INDEX IF NOT EXISTS "IX_BaptismRecords_ChildName"            ON "BaptismRecords" ("ChildLastName", "ChildFirstName");

CREATE TABLE IF NOT EXISTS "ConfirmationRecords" (
    "ConfirmationId"       SERIAL      NOT NULL CONSTRAINT "PK_ConfirmationRecords" PRIMARY KEY,
    "RegistryNumber"       TEXT        NOT NULL,
    "CandidateFirstName"   TEXT        NOT NULL,
    "CandidateMiddleName"  TEXT        NULL,
    "CandidateLastName"    TEXT        NOT NULL,
    "DateOfBirth"          DATE        NOT NULL,
    "DateOfConfirmation"   DATE        NOT NULL,
    "FatherFullName"       TEXT        NULL,
    "MotherFullName"       TEXT        NULL,
    "SponsorName"          TEXT        NULL,
    "BishopOrMinister"     TEXT        NOT NULL,
    "ParishOfBaptism"      TEXT        NULL,
    "ScannedDocumentUrl"   TEXT        NULL,
    "CreatedAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "CreatedBy"            TEXT        NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_ConfirmationRecords_RegistryNumber"    ON "ConfirmationRecords" ("RegistryNumber");
CREATE INDEX IF NOT EXISTS "IX_ConfirmationRecords_DateOfConfirmation"        ON "ConfirmationRecords" ("DateOfConfirmation");
CREATE INDEX IF NOT EXISTS "IX_ConfirmationRecords_CandidateName"             ON "ConfirmationRecords" ("CandidateLastName", "CandidateFirstName");

CREATE TABLE IF NOT EXISTS "MarriageRecords" (
    "MarriageId"          SERIAL      NOT NULL CONSTRAINT "PK_MarriageRecords" PRIMARY KEY,
    "RegistryNumber"      TEXT        NOT NULL,
    "GroomFirstName"      TEXT        NOT NULL,
    "GroomMiddleName"     TEXT        NULL,
    "GroomLastName"       TEXT        NOT NULL,
    "GroomAge"            INT         NULL,
    "GroomParents"        TEXT        NULL,
    "BrideFirstName"      TEXT        NOT NULL,
    "BrideMiddleName"     TEXT        NULL,
    "BrideLastName"       TEXT        NOT NULL,
    "BrideAge"            INT         NULL,
    "BrideParents"        TEXT        NULL,
    "DateOfMarriage"      DATE        NOT NULL,
    "Witnesses"           TEXT        NULL,
    "SolemnizingPriest"   TEXT        NOT NULL,
    "ScannedDocumentUrl"  TEXT        NULL,
    "CreatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "CreatedBy"           TEXT        NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_MarriageRecords_RegistryNumber"  ON "MarriageRecords" ("RegistryNumber");
CREATE INDEX IF NOT EXISTS "IX_MarriageRecords_DateOfMarriage"          ON "MarriageRecords" ("DateOfMarriage");
CREATE INDEX IF NOT EXISTS "IX_MarriageRecords_GroomBrideName"          ON "MarriageRecords" ("GroomLastName", "BrideLastName");

CREATE TABLE IF NOT EXISTS "DeathRecords" (
    "DeathId"             SERIAL      NOT NULL CONSTRAINT "PK_DeathRecords" PRIMARY KEY,
    "RegistryNumber"      TEXT        NOT NULL,
    "DeceasedFirstName"   TEXT        NOT NULL,
    "DeceasedMiddleName"  TEXT        NULL,
    "DeceasedLastName"    TEXT        NOT NULL,
    "Age"                 INT         NULL,
    "DateOfDeath"         DATE        NOT NULL,
    "DateOfBurial"        DATE        NULL,
    "CauseOfDeath"        TEXT        NULL,
    "PlaceOfBurial"       TEXT        NULL,
    "SacramentsReceived"  TEXT        NULL,
    "OfficiatingPriest"   TEXT        NOT NULL,
    "ScannedDocumentUrl"  TEXT        NULL,
    "CreatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "CreatedBy"           TEXT        NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_DeathRecords_RegistryNumber"  ON "DeathRecords" ("RegistryNumber");
CREATE INDEX IF NOT EXISTS "IX_DeathRecords_DateOfDeath"             ON "DeathRecords" ("DateOfDeath");
CREATE INDEX IF NOT EXISTS "IX_DeathRecords_DeceasedName"            ON "DeathRecords" ("DeceasedLastName", "DeceasedFirstName");

CREATE TABLE IF NOT EXISTS "SacramentalArchives" (
    "ArchiveId"      SERIAL      NOT NULL CONSTRAINT "PK_SacramentalArchives" PRIMARY KEY,
    "SacramentType"  VARCHAR(30) NOT NULL,
    "BookNumber"     INT         NOT NULL,
    "PageNumber"     INT         NOT NULL,
    "FileUrl"        TEXT        NOT NULL,
    "Notes"          TEXT        NULL,
    "UploadedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UploadedBy"     TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS "IX_SacramentalArchives_SacramentType" ON "SacramentalArchives" ("SacramentType");
CREATE INDEX IF NOT EXISTS "IX_SacramentalArchives_BookPage"       ON "SacramentalArchives" ("SacramentType", "BookNumber", "PageNumber");

-- === 004_administrative_operations.sql ===
-- Administrative and financial operations.
-- NOTE: Migration 003 (legacy data migration) skipped — not applicable to fresh database

CREATE TABLE IF NOT EXISTS "MassIntentions" (
    "MassIntentionId"  SERIAL          NOT NULL CONSTRAINT "PK_MassIntentions" PRIMARY KEY,
    "IntentionDate"    DATE            NOT NULL,
    "IntentionTime"    VARCHAR(10)     NOT NULL,
    "Offering"         DECIMAL(12,2)   NOT NULL DEFAULT 0,
    "RequestedBy"      TEXT            NOT NULL,
    "IntentionText"    TEXT            NOT NULL,
    "Status"           VARCHAR(30)     NOT NULL DEFAULT 'Scheduled',
    "CreatedBy"        TEXT            NOT NULL,
    "CreatedAt"        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_MassIntentions_DateTime"
    ON "MassIntentions" ("IntentionDate", "IntentionTime");

CREATE TABLE IF NOT EXISTS "FinancialEntries" (
    "FinancialEntryId"  SERIAL          NOT NULL CONSTRAINT "PK_FinancialEntries" PRIMARY KEY,
    "EntryDate"         DATE            NOT NULL,
    "EntryType"         VARCHAR(30)     NOT NULL,
    "Description"       TEXT            NOT NULL,
    "Amount"            DECIMAL(12,2)   NOT NULL,
    "ReferenceType"     VARCHAR(30)     NULL,
    "ReferenceId"       INT             NULL,
    "EnteredBy"         TEXT            NOT NULL,
    "CreatedAt"         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "UpdatedAt"         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_FinancialEntries_DateType"
    ON "FinancialEntries" ("EntryDate", "EntryType");

CREATE TABLE IF NOT EXISTS "ApplicationEditLog" (
    "ApplicationEditLogId"  SERIAL      NOT NULL CONSTRAINT "PK_ApplicationEditLog" PRIMARY KEY,
    "ServiceRequestId"      INT         NOT NULL,
    "ChangedBy"             TEXT        NOT NULL,
    "ChangedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Changes"               TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS "IX_ApplicationEditLog_Request"
    ON "ApplicationEditLog" ("ServiceRequestId", "ChangedAt" DESC);

-- === 005_user_management_audit.sql ===
-- User and role management audit trail.
-- Converted from MSSQL migration 005.
-- AspNetUsers and AspNetRoles tables are created here (ASP.NET Identity base schema).

CREATE TABLE IF NOT EXISTS "AspNetRoles" (
    "RoleId"  SERIAL NOT NULL CONSTRAINT "PK_AspNetRoles" PRIMARY KEY,
    "Name"    TEXT   NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_AspNetRoles_Name" ON "AspNetRoles" ("Name");

CREATE TABLE IF NOT EXISTS "AspNetUsers" (
    "UserId"          SERIAL      NOT NULL CONSTRAINT "PK_AspNetUsers" PRIMARY KEY,
    "EmailAddress"    TEXT        NOT NULL,
    "PasswordHash"    TEXT        NULL,
    "CreatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_AspNetUsers_Email" ON "AspNetUsers" ("EmailAddress");

CREATE TABLE IF NOT EXISTS "AspNetUserRoles" (
    "UserId"   INT NOT NULL REFERENCES "AspNetUsers" ("UserId") ON DELETE CASCADE,
    "RoleId"   INT NOT NULL REFERENCES "AspNetRoles" ("RoleId") ON DELETE CASCADE,
    CONSTRAINT "PK_AspNetUserRoles" PRIMARY KEY ("UserId", "RoleId")
);

CREATE TABLE IF NOT EXISTS "UserManagementAudit" (
    "AuditId"         SERIAL      NOT NULL CONSTRAINT "PK_UserManagementAudit" PRIMARY KEY,
    "ActionName"      VARCHAR(40) NOT NULL,
    "TargetUserId"    INT         NULL,
    "TargetUserName"  TEXT        NULL,
    "ChangedBy"       TEXT        NOT NULL,
    "ChangedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Details"         TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_UserManagementAudit_ChangedAt"
    ON "UserManagementAudit" ("ChangedAt" DESC);
CREATE INDEX IF NOT EXISTS "IX_UserManagementAudit_TargetUser"
    ON "UserManagementAudit" ("TargetUserId", "ChangedAt" DESC);

-- === 006_parishioner_portal_certificates.sql ===
-- Parishioner portal accounts and certificate appointment requests.
-- NOTE: Assumes Service, ServiceRequest, Events, ParishionerAccounts tables exist from baseline
-- This migration adds indexes and columns on top of the baseline

-- (These tables are expected to exist from a separate baseline migration)

CREATE TABLE IF NOT EXISTS "ParishionerAccounts" (
    "ParishionerId"   SERIAL      NOT NULL CONSTRAINT "PK_ParishionerAccounts" PRIMARY KEY,
    "EmailAddress"    TEXT        NOT NULL UNIQUE,
    "PasswordHash"    TEXT        NULL,
    "FullName"        TEXT        NOT NULL,
    "CreatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "LastLoginAt"     TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS "ParishionerPortalSessions" (
    "SessionId"       SERIAL      NOT NULL CONSTRAINT "PK_ParishionerPortalSessions" PRIMARY KEY,
    "AccountId"       INT         NOT NULL REFERENCES "ParishionerAccounts" ("ParishionerId") ON DELETE CASCADE,
    "Token"           TEXT        NOT NULL,
    "ExpiresAt"       TIMESTAMPTZ NOT NULL,
    "CreatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "CertificateRequests" (
    "CertificateRequestId"  SERIAL      NOT NULL CONSTRAINT "PK_CertificateRequests" PRIMARY KEY,
    "AccountId"             INT         NULL REFERENCES "ParishionerAccounts" ("ParishionerId"),
    "CertificateType"       VARCHAR(50) NOT NULL,
    "PreferredDate"         DATE        NULL,
    "PreferredTime"         VARCHAR(10) NULL,
    "Status"                VARCHAR(30) NOT NULL DEFAULT 'Pending',
    "ContactEmail"          TEXT        NULL,
    "ContactPhone"          VARCHAR(50) NULL,
    "FirstName"             TEXT        NULL,
    "LastName"              TEXT        NULL,
    "ReferenceCode"         VARCHAR(10) NULL,
    "CreatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ParishionerAccounts_Parishioner"
    ON "ParishionerAccounts" ("ParishionerId");

CREATE INDEX IF NOT EXISTS "IX_ParishionerPortalSessions_Account"
    ON "ParishionerPortalSessions" ("AccountId", "ExpiresAt");

CREATE INDEX IF NOT EXISTS "IX_CertificateRequests_Account"
    ON "CertificateRequests" ("AccountId", "CreatedAt" DESC);

CREATE INDEX IF NOT EXISTS "IX_CertificateRequests_Appointment"
    ON "CertificateRequests" ("PreferredDate", "PreferredTime", "Status");

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CertificateRequests_RefCode"
    ON "CertificateRequests" ("ReferenceCode")
    WHERE "ReferenceCode" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "IX_CertificateRequests_EmailRef"
    ON "CertificateRequests" ("ContactEmail", "ReferenceCode")
    WHERE "ContactEmail" IS NOT NULL;

-- === 007_sacramental_audit.sql ===
-- Sacramental record audit history.
-- Converted from MSSQL migration 007.

CREATE TABLE IF NOT EXISTS "SacramentalRecordAudit" (
    "AuditId"     SERIAL      NOT NULL CONSTRAINT "PK_SacramentalRecordAudit" PRIMARY KEY,
    "RecordType"  VARCHAR(30) NOT NULL,
    "RecordId"    INT         NOT NULL,
    "ActionName"  VARCHAR(20) NOT NULL,
    "ChangedBy"   TEXT        NOT NULL,
    "ChangedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Changes"     TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_SacramentalRecordAudit_Record"
    ON "SacramentalRecordAudit" ("RecordType", "RecordId", "ChangedAt" DESC);

-- === 008_finance_controls.sql ===
-- Finance workflow: expenses, approvals, reconciliation, and audit history.
-- Converted from MSSQL migration 008.

ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "Status"       VARCHAR(30) NOT NULL DEFAULT 'Draft';
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ApprovedBy"   TEXT        NULL;
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ApprovedAt"   TIMESTAMPTZ NULL;
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ReconciledBy" TEXT        NULL;
ALTER TABLE "FinancialEntries" ADD COLUMN IF NOT EXISTS "ReconciledAt" TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS "FinancialEntryAudit" (
    "AuditId"           SERIAL      NOT NULL CONSTRAINT "PK_FinancialEntryAudit" PRIMARY KEY,
    "FinancialEntryId"  INT         NOT NULL,
    "ActionName"        VARCHAR(30) NOT NULL,
    "ChangedBy"         TEXT        NOT NULL,
    "ChangedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Details"           TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_FinancialEntryAudit_Entry"
    ON "FinancialEntryAudit" ("FinancialEntryId", "ChangedAt" DESC);

-- === 009_certificate_request_documents.sql ===
-- Certificate request supporting documents.
-- Converted from MSSQL migration 009.

CREATE TABLE IF NOT EXISTS "CertificateRequestDocuments" (
    "CertificateRequestDocumentId"  SERIAL      NOT NULL CONSTRAINT "PK_CertificateRequestDocuments" PRIMARY KEY,
    "CertificateRequestId"          INT         NOT NULL REFERENCES "CertificateRequests" ("CertificateRequestId"),
    "OriginalFileName"              TEXT        NOT NULL,
    "StoredFileName"                TEXT        NOT NULL,
    "FileUrl"                       TEXT        NOT NULL,
    "MimeType"                      VARCHAR(100) NOT NULL,
    "FileSizeBytes"                 INT         NOT NULL,
    "UploadedAt"                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IX_CertificateRequestDocuments_Request"
    ON "CertificateRequestDocuments" ("CertificateRequestId", "UploadedAt" DESC);

-- === 010_certificate_requests_guest.sql ===
-- Guest certificate requests: make AccountId nullable, add contact fields and reference code.
-- Converted from MSSQL migration 010.
-- NOTE: AccountId nullable constraint already applied in 006

-- === 011_scheduled_finance_reports.sql ===
-- Persisted weekly and monthly finance report snapshots.
-- Converted from MSSQL migration 011.

CREATE TABLE IF NOT EXISTS "FinanceReportSnapshots" (
    "FinanceReportSnapshotId"  SERIAL          NOT NULL CONSTRAINT "PK_FinanceReportSnapshots" PRIMARY KEY,
    "ReportType"               VARCHAR(20)     NOT NULL,
    "PeriodStart"              DATE            NOT NULL,
    "PeriodEnd"                DATE            NOT NULL,
    "TotalIncome"              DECIMAL(14,2)   NOT NULL,
    "TotalExpenses"            DECIMAL(14,2)   NOT NULL,
    "NetTotal"                 DECIMAL(14,2)   NOT NULL,
    "Details"                  TEXT            NOT NULL,
    "GeneratedAt"              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "GeneratedBy"              TEXT            NOT NULL,
    CONSTRAINT "CK_FinanceReportSnapshots_Type"   CHECK ("ReportType" IN ('Weekly', 'Monthly')),
    CONSTRAINT "UQ_FinanceReportSnapshots_Period" UNIQUE ("ReportType", "PeriodStart", "PeriodEnd")
);

CREATE INDEX IF NOT EXISTS "IX_FinanceReportSnapshots_Period"
    ON "FinanceReportSnapshots" ("ReportType", "PeriodStart" DESC);

-- === 012_security_audit.sql ===
-- Security events audit log.
-- Converted from MSSQL migration 012.

CREATE TABLE IF NOT EXISTS "SecurityAuditLog" (
    "SecurityAuditId"  SERIAL      NOT NULL CONSTRAINT "PK_SecurityAuditLog" PRIMARY KEY,
    "EventType"        VARCHAR(40) NOT NULL,
    "ActorUserName"    TEXT        NOT NULL,
    "TargetUserName"   TEXT        NULL,
    "Reason"           TEXT        NULL,
    "ExpiresAt"        TIMESTAMPTZ NULL,
    "CreatedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "Details"          TEXT        NULL
);

CREATE INDEX IF NOT EXISTS "IX_SecurityAuditLog_CreatedAt"
    ON "SecurityAuditLog" ("CreatedAt" DESC);

-- === 013_verification_tokens.sql ===
-- Verification tokens for service request email confirmation.
-- Converted from MSSQL migration 013.
-- NOTE: Assumes ServiceRequest table exists from baseline

CREATE TABLE IF NOT EXISTS "VerificationTokens" (
    "TokenId"           SERIAL      NOT NULL CONSTRAINT "PK_VerificationTokens" PRIMARY KEY,
    "Token"             VARCHAR(64) NOT NULL,
    "ServiceRequestId"  INT         NOT NULL,
    "ExpiresAt"         TIMESTAMPTZ NOT NULL,
    "Used"              BOOLEAN     NOT NULL DEFAULT FALSE,
    "UsedAt"            TIMESTAMPTZ NULL,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "UQ_VerificationTokens_Token" UNIQUE ("Token")
);

CREATE INDEX IF NOT EXISTS "IX_VerificationTokens_Token"
    ON "VerificationTokens" ("Token")
    WHERE "Used" = FALSE;

CREATE INDEX IF NOT EXISTS "IX_VerificationTokens_ExpiresAt"
    ON "VerificationTokens" ("ExpiresAt")
    WHERE "Used" = FALSE;

-- === 014_event_descriptions.sql ===
-- Add Description column to Events.
-- NOTE: Assumes Events table exists from baseline

CREATE TABLE IF NOT EXISTS "Events" (
    "EventId"           SERIAL      NOT NULL CONSTRAINT "PK_Events" PRIMARY KEY,
    "Title"             TEXT        NOT NULL,
    "Description"       TEXT        NULL,
    "Body"              TEXT        NULL,
    "Location"          TEXT        NULL,
    "EventDate"         DATE        NOT NULL,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "TitleTl"           TEXT        NULL,
    "DescriptionTl"     TEXT        NULL,
    "BodyTl"            TEXT        NULL,
    "LocationTl"        TEXT        NULL
);

-- === 015_service_is_active.sql ===
-- Add IsActive flag to Service; disable Anointing of the Sick.

CREATE TABLE IF NOT EXISTS "Service" (
    "ServiceId"         SERIAL      NOT NULL CONSTRAINT "PK_Service" PRIMARY KEY,
    "Name"              TEXT        NOT NULL UNIQUE,
    "Description"       TEXT        NULL,
    "IsActive"          BOOLEAN     NOT NULL DEFAULT TRUE,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default services if they don't exist
INSERT INTO "Service" ("Name", "IsActive") VALUES
    ('Baptism', TRUE),
    ('Confirmation', TRUE),
    ('Marriage', TRUE),
    ('Funeral Mass', TRUE),
    ('House Blessing', TRUE),
    ('Anointing of the Sick', FALSE)
ON CONFLICT DO NOTHING;

-- === 016_sacrament_booking_fields.sql ===
-- Admin-configurable form fields per sacrament, plus typed detail tables.

CREATE TABLE IF NOT EXISTS "ServiceFieldDefinition" (
    "FieldDefinitionId"  SERIAL      NOT NULL CONSTRAINT "PK_ServiceFieldDefinition" PRIMARY KEY,
    "ServiceId"          INT         NOT NULL REFERENCES "Service" ("ServiceId"),
    "FieldKey"           VARCHAR(100) NOT NULL,
    "Label"              TEXT        NOT NULL,
    "FieldType"          VARCHAR(20) NOT NULL DEFAULT 'text',
    "OptionsJson"        TEXT        NULL,
    "IsRequired"         BOOLEAN     NOT NULL DEFAULT FALSE,
    "SortOrder"          INT         NOT NULL DEFAULT 0,
    "IsActive"           BOOLEAN     NOT NULL DEFAULT TRUE,
    "CreatedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IX_ServiceFieldDefinition_ServiceKey"
    ON "ServiceFieldDefinition" ("ServiceId", "FieldKey");

CREATE TABLE IF NOT EXISTS "ServiceRequest" (
    "ServiceRequestId"      SERIAL      NOT NULL CONSTRAINT "PK_ServiceRequest" PRIMARY KEY,
    "ServiceId"             INT         NOT NULL REFERENCES "Service" ("ServiceId"),
    "ScheduledDate"         DATE        NULL,
    "ScheduledTime"         VARCHAR(10) NULL,
    "Status"                VARCHAR(30) NOT NULL DEFAULT 'PendingVerification',
    "AttendanceStatus"      VARCHAR(30) NULL,
    "AttendanceMarkedAt"    TIMESTAMPTZ NULL,
    "VoidedAt"              TIMESTAMPTZ NULL,
    "ActiveSlotKey"         TEXT        NULL,
    "CreatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "UX_ServiceRequest_ActiveSlot"
    ON "ServiceRequest" ("ActiveSlotKey")
    WHERE "ActiveSlotKey" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "BaptismRequestDetail" (
    "ServiceRequestId"  INT  NOT NULL CONSTRAINT "PK_BaptismRequestDetail" PRIMARY KEY
                             REFERENCES "ServiceRequest" ("ServiceRequestId"),
    "ChildFirstName"    TEXT NULL,
    "ChildMiddleName"   TEXT NULL,
    "ChildLastName"     TEXT NULL,
    "ChildDateOfBirth"  DATE NULL,
    "PlaceOfBirth"      TEXT NULL,
    "FatherFullName"    TEXT NULL,
    "MotherFullName"    TEXT NULL,
    "GodfatherName"     TEXT NULL,
    "GodmotherName"     TEXT NULL,
    "ExtraFieldsJson"   TEXT NULL
);

CREATE TABLE IF NOT EXISTS "MarriageRequestDetail" (
    "ServiceRequestId"  INT  NOT NULL CONSTRAINT "PK_MarriageRequestDetail" PRIMARY KEY
                             REFERENCES "ServiceRequest" ("ServiceRequestId"),
    "GroomFirstName"    TEXT NULL,
    "GroomMiddleName"   TEXT NULL,
    "GroomLastName"     TEXT NULL,
    "GroomAge"          INT  NULL,
    "BrideFirstName"    TEXT NULL,
    "BrideMiddleName"   TEXT NULL,
    "BrideLastName"     TEXT NULL,
    "BrideAge"          INT  NULL,
    "CenomarNumber"     TEXT NULL,
    "Witnesses"         TEXT NULL,
    "ExtraFieldsJson"   TEXT NULL
);

CREATE TABLE IF NOT EXISTS "ConfirmationRequestDetail" (
    "ServiceRequestId"       INT  NOT NULL CONSTRAINT "PK_ConfirmationRequestDetail" PRIMARY KEY
                                  REFERENCES "ServiceRequest" ("ServiceRequestId"),
    "CandidateFirstName"     TEXT NULL,
    "CandidateMiddleName"    TEXT NULL,
    "CandidateLastName"      TEXT NULL,
    "CandidateDateOfBirth"   DATE NULL,
    "SponsorName"            TEXT NULL,
    "ParishOfBaptism"        TEXT NULL,
    "ExtraFieldsJson"        TEXT NULL
);

CREATE TABLE IF NOT EXISTS "FuneralRequestDetail" (
    "ServiceRequestId"         INT  NOT NULL CONSTRAINT "PK_FuneralRequestDetail" PRIMARY KEY
                                    REFERENCES "ServiceRequest" ("ServiceRequestId"),
    "DeceasedFirstName"        TEXT NULL,
    "DeceasedMiddleName"       TEXT NULL,
    "DeceasedLastName"         TEXT NULL,
    "DateOfDeath"              DATE NULL,
    "RelationshipToDeceased"   TEXT NULL,
    "PlaceOfWake"              TEXT NULL,
    "ExtraFieldsJson"          TEXT NULL
);

CREATE TABLE IF NOT EXISTS "HouseBlessingRequestDetail" (
    "ServiceRequestId"          INT  NOT NULL CONSTRAINT "PK_HouseBlessingRequestDetail" PRIMARY KEY
                                      REFERENCES "ServiceRequest" ("ServiceRequestId"),
    "FullAddress"               TEXT NULL,
    "Landmark"                  TEXT NULL,
    "PreferredContactPerson"    TEXT NULL,
    "ExtraFieldsJson"           TEXT NULL
);

-- Seed default field definitions per active sacrament
INSERT INTO "ServiceFieldDefinition" ("ServiceId", "FieldKey", "Label", "FieldType", "IsRequired", "SortOrder")
SELECT s."ServiceId", v.field_key, v.label, v.field_type, v.is_required, v.sort_order
FROM "Service" s
JOIN (VALUES
    ('Baptism',       'childFirstName',          'Child first name',                     'text',     TRUE,  1),
    ('Baptism',       'childMiddleName',          'Child middle name',                    'text',     FALSE, 2),
    ('Baptism',       'childLastName',            'Child last name',                      'text',     TRUE,  3),
    ('Baptism',       'childDateOfBirth',         'Child date of birth',                  'date',     TRUE,  4),
    ('Baptism',       'placeOfBirth',             'Place of birth',                       'text',     FALSE, 5),
    ('Baptism',       'fatherFullName',           'Father''s full name',                  'text',     TRUE,  6),
    ('Baptism',       'motherFullName',           'Mother''s full name',                  'text',     TRUE,  7),
    ('Baptism',       'godfatherName',            'Godfather name',                       'text',     FALSE, 8),
    ('Baptism',       'godmotherName',            'Godmother name',                       'text',     FALSE, 9),
    ('Marriage',      'groomFirstName',           'Groom first name',                     'text',     TRUE,  1),
    ('Marriage',      'groomMiddleName',          'Groom middle name',                    'text',     FALSE, 2),
    ('Marriage',      'groomLastName',            'Groom last name',                      'text',     TRUE,  3),
    ('Marriage',      'groomAge',                 'Groom age',                            'number',   TRUE,  4),
    ('Marriage',      'brideFirstName',           'Bride first name',                     'text',     TRUE,  5),
    ('Marriage',      'brideMiddleName',          'Bride middle name',                    'text',     FALSE, 6),
    ('Marriage',      'brideLastName',            'Bride last name',                      'text',     TRUE,  7),
    ('Marriage',      'brideAge',                 'Bride age',                            'number',   TRUE,  8),
    ('Marriage',      'cenomarNumber',            'CENOMAR number',                       'text',     FALSE, 9),
    ('Marriage',      'witnesses',                'Witnesses',                            'textarea', FALSE, 10),
    ('Confirmation',  'candidateFirstName',       'Candidate first name',                 'text',     TRUE,  1),
    ('Confirmation',  'candidateMiddleName',      'Candidate middle name',                'text',     FALSE, 2),
    ('Confirmation',  'candidateLastName',        'Candidate last name',                  'text',     TRUE,  3),
    ('Confirmation',  'candidateDateOfBirth',     'Candidate date of birth',              'date',     TRUE,  4),
    ('Confirmation',  'sponsorName',              'Sponsor name',                         'text',     TRUE,  5),
    ('Confirmation',  'parishOfBaptism',          'Parish of baptism',                    'text',     FALSE, 6),
    ('Funeral Mass',  'deceasedFirstName',        'Deceased first name',                  'text',     TRUE,  1),
    ('Funeral Mass',  'deceasedMiddleName',       'Deceased middle name',                 'text',     FALSE, 2),
    ('Funeral Mass',  'deceasedLastName',         'Deceased last name',                   'text',     TRUE,  3),
    ('Funeral Mass',  'dateOfDeath',              'Date of death',                        'date',     TRUE,  4),
    ('Funeral Mass',  'relationshipToDeceased',   'Your relationship to the deceased',    'text',     TRUE,  5),
    ('Funeral Mass',  'placeOfWake',              'Place of wake',                        'text',     FALSE, 6),
    ('House Blessing','fullAddress',              'Full address to bless',                'textarea', TRUE,  1),
    ('House Blessing','landmark',                 'Nearby landmark',                      'text',     FALSE, 2),
    ('House Blessing','preferredContactPerson',   'Preferred contact person on site',     'text',     FALSE, 3)
) AS v(service_name, field_key, label, field_type, is_required, sort_order)
  ON s."Name" = v.service_name
WHERE NOT EXISTS (
    SELECT 1 FROM "ServiceFieldDefinition" existing
    WHERE existing."ServiceId" = s."ServiceId"
      AND existing."FieldKey"  = v.field_key
);

-- === 017_no_show_status.sql ===
-- Update voided no-show records to use dedicated VoidedNoShow status.

UPDATE "ServiceRequest"
SET "Status" = 'VoidedNoShow'
WHERE "Status" = 'Voided'
  AND "AttendanceStatus" = 'NoShow';

-- === 018_certificate_appointment_slots.sql ===
-- Certificate appointment slot protection.

CREATE UNIQUE INDEX IF NOT EXISTS "UX_CertificateRequests_ConfirmedSlot"
    ON "CertificateRequests" ("PreferredDate", "PreferredTime")
    WHERE "Status" IN ('Confirmed', 'ReadyForClaim', 'Claimed');

-- === 019_admin_usernames.sql ===
-- Store admin account usernames separately from email addresses.

ALTER TABLE "AspNetUsers" ADD COLUMN IF NOT EXISTS "UserName" TEXT NULL;

-- Backfill: use email prefix or user-{id} for any missing username
UPDATE "AspNetUsers"
SET "UserName" = COALESCE(
    NULLIF(TRIM("EmailAddress"), ''),
    'user-' || "UserId"::text
)
WHERE "UserName" IS NULL OR TRIM("UserName") = '';

-- Make non-nullable now that all rows are populated
ALTER TABLE "AspNetUsers" ALTER COLUMN "UserName" SET NOT NULL;

-- === 020_site_content.sql ===
-- Site content table for editable page content.

CREATE TABLE IF NOT EXISTS "SiteContent" (
    "ContentKey"   TEXT        NOT NULL CONSTRAINT "PK_SiteContent" PRIMARY KEY,
    "ContentJson"  TEXT        NOT NULL,
    "UpdatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedBy"    TEXT        NULL
);

-- === 021_contact_messages.sql ===
-- Contact messages from the public contact form.

CREATE TABLE IF NOT EXISTS "ContactMessages" (
    "ContactMessageId"  SERIAL      NOT NULL CONSTRAINT "PK_ContactMessages" PRIMARY KEY,
    "Name"              TEXT        NOT NULL,
    "Email"             TEXT        NOT NULL,
    "Phone"             TEXT        NULL,
    "Message"           TEXT        NOT NULL,
    "IsRead"            BOOLEAN     NOT NULL DEFAULT FALSE,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === 022_user_module_permissions.sql ===
-- Per-account module permission overrides and forced password change flag.

ALTER TABLE "AspNetUsers" ADD COLUMN IF NOT EXISTS "MustChangePassword" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS "UserModulePermissions" (
    "UserId"      INT         NOT NULL REFERENCES "AspNetUsers" ("UserId") ON DELETE CASCADE,
    "ModuleName"  TEXT        NOT NULL,
    "CanView"     BOOLEAN     NOT NULL DEFAULT FALSE,
    "CanEdit"     BOOLEAN     NOT NULL DEFAULT FALSE,
    "UpdatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedBy"   TEXT        NULL,
    CONSTRAINT "PK_UserModulePermissions" PRIMARY KEY ("UserId", "ModuleName")
);

-- === 023_event_tagalog_content.sql ===
-- Add Tagalog (TL) content columns to Events.
-- NOTE: Already included in Events table creation in 014

-- === 024_blocked_slots.sql ===
-- Admin-managed blocked dates/times for service and certificate appointments.

CREATE TABLE IF NOT EXISTS "BlockedSlots" (
    "BlockedSlotId"  SERIAL      NOT NULL CONSTRAINT "PK_BlockedSlots" PRIMARY KEY,
    "BlockDate"      DATE        NOT NULL,
    "BlockTime"      VARCHAR(5)  NULL,         -- NULL blocks the whole day
    "Scope"          VARCHAR(20) NOT NULL,     -- All | Service | Certificate
    "ServiceId"      INT         NULL,         -- required when Scope = Service
    "Reason"         TEXT        NULL,
    "CreatedBy"      TEXT        NULL,
    "CreatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "CK_BlockedSlots_Scope"     CHECK ("Scope" IN ('All', 'Service', 'Certificate')),
    CONSTRAINT "CK_BlockedSlots_ServiceId" CHECK (
        ("Scope" = 'Service' AND "ServiceId" IS NOT NULL) OR
        ("Scope" <> 'Service' AND "ServiceId" IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS "IX_BlockedSlots_BlockDate" ON "BlockedSlots" ("BlockDate");
