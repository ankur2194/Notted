#!/bin/sh
# Manually create the private Notted MinIO buckets (dev helper).
# At normal `docker compose up`, the `minio-init` sidecar already does this.
# Buckets are PRIVATE per ADR 0005 — never set anonymous/public policy.
set -eu

ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
ACCESS_KEY="${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
SECRET_KEY="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
BUCKET_ATTACHMENTS="${MINIO_BUCKET_ATTACHMENTS:-notted-attachments}"
BUCKET_EXPORTS="${MINIO_BUCKET_EXPORTS:-notted-exports}"

mc alias set local "$ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY"
mc mb             "local/$BUCKET_ATTACHMENTS" --ignore-existing
mc mb             "local/$BUCKET_EXPORTS"     --ignore-existing
# Intentionally NO `mc anonymous` / `mc policy set public`.
