#!/usr/bin/env bash
# Mirror design/*.fig ↔ MinIO open-pencil bucket (OpenPencil storage paths).
#
# Fixed document ids:
#   aska-app.fig     ↔ open_pencil_storage/canvases/aska-app.fig
#   aska-landing.fig ↔ open_pencil_storage/canvases/aska-landing.fig
#
# Direction is chosen by mtime (last-write-wins). Previous local copies are
# saved under design/.pencil-sync-bak/ before overwrite.
#
# Usage:
#   /root/open-pencil/scripts/sync-pencil-storage.sh          # sync both
#   /root/open-pencil/scripts/sync-pencil-storage.sh push      # force design → bucket
#   /root/open-pencil/scripts/sync-pencil-storage.sh pull      # force bucket → design
#   /root/open-pencil/scripts/sync-pencil-storage.sh status    # show mtimes / sizes
#
set -euo pipefail

ROOT_ENV="${PENCIL_MINIO_ENV:-/root/open-pencil/.envs/.env.minio}"
# shellcheck disable=SC1090
set -a; source "$ROOT_ENV"; set +a

MC="${PENCIL_MC:-/root/open-pencil/.minio-bin/mc}"
DESIGN_DIR="${PENCIL_DESIGN_DIR:-/root/aska.chat/design}"
BUCKET="${MINIO_BUCKET:-open-pencil}"
BACKUP_DIR="${DESIGN_DIR}/.pencil-sync-bak"
PREFIX="open_pencil_storage/canvases"
DOCS=(aska-app aska-landing)
MODE="${1:-sync}"

if [[ ! -x "$MC" ]]; then
  echo "mc not found at $MC" >&2
  exit 1
fi

resolve_endpoint() {
  if [[ -n "${PENCIL_S3_INTERNAL:-}" ]]; then
    echo "$PENCIL_S3_INTERNAL"
    return
  fi
  local ip
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' open_pencil_minio 2>/dev/null || true)"
  if [[ -n "$ip" ]]; then
    echo "http://${ip}:9000"
  else
    echo "${PENCIL_S3_ENDPOINT:-https://pencil-s3.rpine.xyz}"
  fi
}

ENDPOINT="$(resolve_endpoint)"
ALIAS="pencil-sync-$$"
cleanup() { "$MC" alias remove "$ALIAS" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$MC" alias set "$ALIAS" "$ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

iso_from_epoch() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z
}

write_meta() {
  local id="$1" updated_at="$2" dest="$3"
  python3 - "$id" "$updated_at" "$dest" <<'PY'
import json, pathlib, sys
doc_id, updated_at, dest = sys.argv[1:4]
pathlib.Path(dest).write_text(json.dumps({"name": doc_id, "updatedAt": updated_at}, indent=2) + "\n")
PY
}

remote_mtime_epoch() {
  local key="$1"
  "$MC" stat --json "${ALIAS}/${BUCKET}/${key}" 2>/dev/null \
    | python3 -c 'import sys,json; from datetime import datetime,timezone
d=json.load(sys.stdin)
# mc returns lastModified like "2026-10-13T10:12:07Z"
s=d.get("lastModified") or d.get("LastModified") or ""
s=s.replace("Z","+00:00")
print(int(datetime.fromisoformat(s).timestamp()))' 2>/dev/null || echo 0
}

remote_size() {
  local key="$1"
  "$MC" stat --json "${ALIAS}/${BUCKET}/${key}" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("size",0))' 2>/dev/null || echo 0
}

backup_local() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  mkdir -p "$BACKUP_DIR"
  local base ts
  base="$(basename "$file")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "$file" "${BACKUP_DIR}/${base}.${ts}.bak"
  echo "backup: ${BACKUP_DIR}/${base}.${ts}.bak"
}

push_doc() {
  local id="$1"
  local local_fig="${DESIGN_DIR}/${id}.fig"
  local remote_fig="${PREFIX}/${id}.fig"
  local remote_meta="${PREFIX}/${id}.meta.json"
  [[ -f "$local_fig" ]] || { echo "missing $local_fig" >&2; return 1; }

  local epoch meta_tmp
  epoch="$(stat -c %Y "$local_fig")"
  meta_tmp="$(mktemp)"
  write_meta "$id" "$(iso_from_epoch "$epoch")" "$meta_tmp"
  "$MC" cp "$local_fig" "${ALIAS}/${BUCKET}/${remote_fig}"
  "$MC" cp "$meta_tmp" "${ALIAS}/${BUCKET}/${remote_meta}"
  rm -f "$meta_tmp"
  # Ensure namespace marker exists
  local marker_tmp
  marker_tmp="$(mktemp)"
  printf '%s' '{"app":"open-pencil","version":1}' >"$marker_tmp"
  "$MC" cp "$marker_tmp" "${ALIAS}/${BUCKET}/open_pencil_storage/.openpencil-namespace" >/dev/null
  rm -f "$marker_tmp"
  echo "push: ${id}.fig → s3://${BUCKET}/${remote_fig}"
}

pull_doc() {
  local id="$1"
  local local_fig="${DESIGN_DIR}/${id}.fig"
  local remote_fig="${PREFIX}/${id}.fig"
  local tmp
  tmp="$(mktemp)"
  "$MC" cp "${ALIAS}/${BUCKET}/${remote_fig}" "$tmp"
  backup_local "$local_fig"
  mv "$tmp" "$local_fig"
  # Align local mtime to remote LastModified when possible
  local rem_epoch
  rem_epoch="$(remote_mtime_epoch "$remote_fig")"
  if [[ "$rem_epoch" -gt 0 ]]; then
    touch -d "@${rem_epoch}" "$local_fig"
  fi
  echo "pull: s3://${BUCKET}/${remote_fig} → ${local_fig}"
}

status_doc() {
  local id="$1"
  local local_fig="${DESIGN_DIR}/${id}.fig"
  local remote_fig="${PREFIX}/${id}.fig"
  local l_epoch=0 l_size=0 r_epoch r_size
  if [[ -f "$local_fig" ]]; then
    l_epoch="$(stat -c %Y "$local_fig")"
    l_size="$(stat -c %s "$local_fig")"
  fi
  r_epoch="$(remote_mtime_epoch "$remote_fig")"
  r_size="$(remote_size "$remote_fig")"
  printf '%-14s local=%s (%s B)  remote=%s (%s B)\n' \
    "$id" \
    "$( [[ $l_epoch -gt 0 ]] && iso_from_epoch "$l_epoch" || echo missing )" \
    "$l_size" \
    "$( [[ $r_epoch -gt 0 ]] && iso_from_epoch "$r_epoch" || echo missing )" \
    "$r_size"
}

sync_doc() {
  local id="$1"
  local local_fig="${DESIGN_DIR}/${id}.fig"
  local remote_fig="${PREFIX}/${id}.fig"
  local l_epoch=0 r_epoch
  [[ -f "$local_fig" ]] && l_epoch="$(stat -c %Y "$local_fig")"
  r_epoch="$(remote_mtime_epoch "$remote_fig")"

  if [[ "$l_epoch" -eq 0 && "$r_epoch" -eq 0 ]]; then
    echo "skip: $id (missing both sides)"
    return 0
  fi
  if [[ "$l_epoch" -eq 0 ]]; then
    pull_doc "$id"
    return 0
  fi
  if [[ "$r_epoch" -eq 0 ]]; then
    push_doc "$id"
    return 0
  fi

  local l_size r_size
  l_size="$(stat -c %s "$local_fig")"
  r_size="$(remote_size "$remote_fig")"
  # Identical size after seed/upload → treat as in sync (S3 LastModified ≠ local mtime).
  if [[ "$l_size" = "$r_size" ]]; then
    echo "ok: $id already in sync (size=$l_size)"
    return 0
  fi

  if [[ "$l_epoch" -gt "$r_epoch" ]]; then
    push_doc "$id"
  else
    pull_doc "$id"
  fi
}

case "$MODE" in
  status)
    for id in "${DOCS[@]}"; do status_doc "$id"; done
    ;;
  push)
    for id in "${DOCS[@]}"; do push_doc "$id"; done
    ;;
  pull)
    for id in "${DOCS[@]}"; do pull_doc "$id"; done
    ;;
  sync|"")
    for id in "${DOCS[@]}"; do sync_doc "$id"; done
    ;;
  *)
    echo "Usage: $0 [sync|push|pull|status]" >&2
    exit 2
    ;;
esac
