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
