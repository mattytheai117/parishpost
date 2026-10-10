-- Admin-configurable form fields per sacrament, plus typed detail tables.
-- Converted from MSSQL migration 016.
-- Note: CROSS APPLY replaced with a VALUES + JOIN pattern.

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
