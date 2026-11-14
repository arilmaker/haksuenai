#!/usr/bin/env bash
# Kirim isi file .env ke Vercel (production + development) tanpa tempel manual.
# Pakai: 1) npx vercel login   2) npx vercel link   3) bash scripts/push-env.sh [.env]
# Baris kosong dilewati, jadi DATABASE_URL & BLOB_READ_WRITE_TOKEN (diisi otomatis oleh Vercel) aman.
set -euo pipefail
FILE="${1:-.env}"
[ -f "$FILE" ] || { echo "File $FILE tidak ditemukan"; exit 1; }
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  name="${line%%=*}"
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  if [ -z "$value" ]; then echo "↷ lewati $name (kosong)"; continue; fi
  for target in production development; do
    if printf '%s' "$value" | npx vercel env add "$name" "$target" --force >/dev/null 2>&1; then
      echo "✔ $name → $target"
    else
      echo "✖ gagal $name → $target"
    fi
  done
done < "$FILE"
echo "Selesai. Jalankan: npx vercel --prod (redeploy) supaya variabel terbaca."
