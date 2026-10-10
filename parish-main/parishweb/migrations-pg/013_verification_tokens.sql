-- Verification tokens for service request email confirmation.
-- Converted from MSSQL migration 013.
-- Note: filtered indexes use PostgreSQL WHERE syntax.

CREATE TABLE IF NOT EXISTS "VerificationTokens" (
    "TokenId"           SERIAL      NOT NULL CONSTRAINT "PK_VerificationTokens" PRIMARY KEY,
    "Token"             VARCHAR(64) NOT NULL,
    "ServiceRequestId"  INT         NOT NULL REFERENCES "ServiceRequest" ("ServiceRequestId"),
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
