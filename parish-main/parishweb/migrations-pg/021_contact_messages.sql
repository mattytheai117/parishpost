-- Contact messages from the public contact form.
-- Converted from MSSQL migration 021.

CREATE TABLE IF NOT EXISTS "ContactMessages" (
    "ContactMessageId"  SERIAL      NOT NULL CONSTRAINT "PK_ContactMessages" PRIMARY KEY,
    "Name"              TEXT        NOT NULL,
    "Email"             TEXT        NOT NULL,
    "Phone"             TEXT        NULL,
    "Message"           TEXT        NOT NULL,
    "IsRead"            BOOLEAN     NOT NULL DEFAULT FALSE,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
