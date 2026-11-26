#!/usr/bin/env sh
# Sync approved radio audio from Cloudflare R2 to the local Liquidsoap
# folders using rclone (free, open source). Run from cron, e.g. hourly:
#   0 * * * * /path/to/sync-r2.sh
#
# One-time rclone remote setup (reads keys from the environment, never
# stored in this repository):
#   rclone config create r2 s3 provider=Cloudflare \
#     access_key_id="$R2_ACCESS_KEY_ID" \
#     secret_access_key="$R2_SECRET_ACCESS_KEY" \
#     endpoint="https://0ccc7e18ae8b624a22d75984a4859ab6.r2.cloudflarestorage.com"
set -eu

BUCKET="${R2_BUCKET_NAME:-prayer-dome}"
DEST="$(dirname "$0")"

rclone sync "r2:${BUCKET}/radio/music" "${DEST}/music" --transfers 4 --checksum
rclone sync "r2:${BUCKET}/radio/announcements" "${DEST}/announcements" --transfers 4 --checksum
echo "R2 sync complete: $(date -u +%FT%TZ)"
