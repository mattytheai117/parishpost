-- Site content table for editable page content.
-- Converted from MSSQL migration 020.

CREATE TABLE IF NOT EXISTS "SiteContent" (
    "ContentKey"   TEXT        NOT NULL CONSTRAINT "PK_SiteContent" PRIMARY KEY,
    "ContentJson"  TEXT        NOT NULL,
    "UpdatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "UpdatedBy"    TEXT        NULL
);
