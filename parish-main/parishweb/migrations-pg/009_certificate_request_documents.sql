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
