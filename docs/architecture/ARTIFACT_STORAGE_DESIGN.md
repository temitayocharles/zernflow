# Artifact Storage Design

## 1. Abstraction

`lib/storage/object-store.ts` defines `ObjectStore`:
`putObject`, `getObject`, `deleteObject`, `headObject`, `presignPut`, `presignGet`.

Drivers:
* `S3ObjectStore` — AWS SDK v3 against **any S3-compatible endpoint** (AWS S3, Cloudflare R2, Backblaze B2,
  MinIO/Garage on K3s). Configured by `ARTIFACT_S3_ENDPOINT`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_BUCKET`,
  `ARTIFACT_S3_ACCESS_KEY_ID`, `ARTIFACT_S3_SECRET_ACCESS_KEY`, `ARTIFACT_S3_FORCE_PATH_STYLE`,
  `ARTIFACT_S3_SSE` (`AES256` | `aws:kms` | `none` for providers that encrypt by default).
* `MemoryObjectStore` — tests only.
No vendor-specific API is used beyond the S3 protocol; switching providers is configuration only ($0 friendly).

## 2. Keys and isolation

`ws/<workspace_id>/<kind>/<yyyy>/<mm>/<artifact_uuid>` — generated server-side only. User-supplied file
names are stored as metadata, never used in keys (no path traversal). Every read/write resolves the
artifact row first and verifies `workspace_id` → cross-tenant object access is impossible through the API.
The bucket is private; access is only through short-lived presigned URLs (default 5 min, max 1 h).

## 3. Upload flow

1. `POST /api/v1/assets` `{fileName, contentType, sizeBytes, sha256, kind}` → validates MIME allowlist per
   kind, size ≤ `MAX_UPLOAD_SIZE_BYTES`, inserts `artifacts` row (`pending_upload`), returns presigned PUT
   bound to content-type and checksum (`x-amz-checksum-sha256`).
2. Client uploads directly to storage.
3. `POST /api/v1/assets/:id/complete` → `HEAD` verifies size/content-type/checksum → `available`;
   mismatch → `quarantined`.

## 4. Retention and lifecycle

* Execution artifacts (screenshot, trace) get `retention_until = now + MAX_ARTIFACT_RETENTION_DAYS`.
* Maintenance tick deletes expired objects and marks rows `deleted` (bounded batch).
* Bucket-side lifecycle rules (recommended): abort incomplete multipart after 1 day; expire `ws/*/trace/*`
  and `ws/*/screenshot/*` after retention; versioning optional for `export`/`backup` kinds.

## 5. MIME allowlist (initial)

image: png, jpeg, webp, gif · video: mp4, quicktime, webm · document: pdf, csv, json, plain text ·
trace: zip · screenshot: png, jpeg · export/import/bundle/report/backup: zip, json, csv, gzip.
SVG and HTML are rejected (active content).
