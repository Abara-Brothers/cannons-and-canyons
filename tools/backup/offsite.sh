#!/usr/bin/env bash
#
# offsite.sh — turn a backup into ONE encrypted file you can put anywhere.
#
#   bash tools/backup/offsite.sh                  # encrypt the newest backup
#   bash tools/backup/offsite.sh <backup-dir>     # encrypt a specific one
#   bash tools/backup/offsite.sh --verify <file>  # decrypt and check it
#   bash tools/backup/offsite.sh --drill  <file>  # decrypt and FULLY restore it
#
# WHY: the dumps are on the same laptop that made them, which covers a bad
# migration but not a lost machine. Getting them off requires two things the
# local copies do not need — encryption, because this is every account and
# every career leaving your control, and a way to prove the copy is still good
# without your laptop.
#
# CRYPTO, stated plainly rather than implied:
#   AES-256-CBC, key derived with PBKDF2-HMAC-SHA512 at 600,000 iterations,
#   random salt per archive. Plain `openssl` — no age, no gpg — because a
#   recovery must not be blocked on installing software, and openssl is already
#   on every Mac and Linux box you might restore from.
#
#   INTEGRITY: a SHA256SUMS file is generated and placed INSIDE the archive
#   before encryption, so it is covered by the encryption rather than sitting
#   next to it where anyone could edit it to match tampered content. Producing
#   an archive that decrypts, un-gzips, un-tars AND matches those checksums
#   without the passphrase is not feasible. Note the honest limit: CBC is
#   malleable and this is not a formal AEAD, so treat the guarantee as "damage
#   and tampering are detected", not "an active attacker is cryptographically
#   locked out". If that is your threat model, use age or gpg instead.
#
# THE PASSPHRASE IS THE WHOLE THING. It lives in your Keychain so this can run
# unattended — but the Keychain is ON THE LAPTOP. If the laptop is what you
# lost, the Keychain copy is gone with it and the archive is unrecoverable
# forever. There is no reset, no support line, no recovery. It MUST also exist
# somewhere independent: your password manager, a printed copy in a drawer.
# That is not a nag; it is the difference between a backup and a coaster.
set -uo pipefail

# Overridable ONLY so the tool can be tested without touching the real
# passphrase slot. Never set this in normal use.
SERVICE="${CC_ARCHIVE_PASS_SERVICE:-cc-backup-archive-passphrase}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OSSL="/usr/bin/openssl"
CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha512 -salt)
OUT_DIR="${CC_OFFSITE_DIR:-$ROOT/backups/offsite}"

die() { echo "ERROR: $*" >&2; exit 1; }
[ -x "$OSSL" ] || die "no openssl at $OSSL"

# ONE cleanup registry, cleaned on EVERY exit path.
#
# The per-function `trap ... RETURN` this replaces does NOT fire when the script
# exits or is signalled — macOS ships bash 3.2 — so any failure between mktemp and
# the end of the function left the DECRYPTED dump (every account and every career,
# in plaintext) sitting in /private/tmp. Per-function EXIT traps would not fix it
# either: create() calls verify(), so the second trap would simply replace the
# first and orphan create's directory.
CLEANUP=()
cleanup_all() {
  for d in ${CLEANUP[@]+"${CLEANUP[@]}"}; do [ -n "$d" ] && rm -rf -- "$d"; done
}
trap cleanup_all EXIT INT TERM
# Registration MUST happen in the parent shell. A scratch() helper called as
# work="$(scratch ...)" looks tidy and silently does nothing: command
# substitution runs in a SUBSHELL, so CLEANUP+= there mutates a copy that dies
# with it, and the parent registry stays empty. That version passed inspection
# and still leaked a plaintext dump on the first forced-failure test.

get_pass() {
  PASS="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null || true)"
  if [ -z "$PASS" ]; then
    cat >&2 <<EOF

No archive passphrase is stored yet.

  1. Create a strong passphrase IN YOUR PASSWORD MANAGER first, and save it
     there. If you only ever have it here, losing this Mac loses every
     off-site archive permanently — they cannot be recovered by anyone.

  2. Then store a copy for automation:

       security add-generic-password -a "\$USER" -s $SERVICE -T /usr/bin/security -U -w

     Paste it at the prompt. Nothing will echo. That is normal.

EOF
    exit 1
  fi
}

# Feeds the passphrase down file descriptor 3. Not an argument (arguments are
# world-readable through `ps`) and not a file (a secret written to disk is a
# secret that can outlive the process that wrote it).
ossl_enc() { exec 3< <(printf '%s' "$PASS"); "$OSSL" enc "${CIPHER[@]}" -pass fd:3 -in "$1" -out "$2"; local r=$?; exec 3<&-; return $r; }
# openssl's own failure text is noisy and unhelpful ("bad decrypt" plus a build
# path from whoever compiled LibreSSL). It is swallowed here so the caller can
# print something a human can act on; the exit status is what we act on.
ossl_dec() { exec 3< <(printf '%s' "$PASS"); "$OSSL" enc -d "${CIPHER[@]}" -pass fd:3 -in "$1" -out "$2" 2>/dev/null; local r=$?; exec 3<&-; return $r; }

# ---------------------------------------------------------------- create
create() {
  local src="${1:-$(ls -1dt "$ROOT"/backups/*/ 2>/dev/null | head -1)}"
  [ -n "$src" ] && [ -s "$src/auth.sql" ] || die "no usable backup found in $ROOT/backups"
  src="${src%/}"
  local stamp; stamp="$(basename "$src")"
  local work; work="$(mktemp -d /tmp/ccoff.XXXXXX)"
  CLEANUP+=("$work")          # in the PARENT, not a subshell

  get_pass
  mkdir -p "$OUT_DIR"
  local enc="$OUT_DIR/cc-backup-$stamp.tar.gz.enc"

  echo "packing   $src"
  cp -R "$src" "$work/$stamp"
  ( cd "$work/$stamp" && shasum -a 256 -- * > SHA256SUMS )   # inside, so it gets encrypted
  ( cd "$work" && tar -czf payload.tar.gz "$stamp" )
  echo "encrypting (AES-256-CBC, PBKDF2-SHA512 x600000)"
  ossl_enc "$work/payload.tar.gz" "$enc" || die "encryption failed"

  # A recovery note NEXT TO the archive, deliberately unencrypted: whoever is
  # holding this in an emergency needs the command, and the command is not a
  # secret. Only the passphrase is.
  cat > "$OUT_DIR/HOW-TO-DECRYPT.txt" <<EOF
Cannons & Canyons — encrypted database backup

To decrypt (any openssl, macOS LibreSSL or OpenSSL 3; you will be asked for the passphrase):

  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha512 \\
    -in cc-backup-<stamp>.tar.gz.enc -out backup.tar.gz
  tar -xzf backup.tar.gz
  cd <stamp> && shasum -a 256 -c SHA256SUMS

Then restore, auth BEFORE public — see tools/backup/RESTORE.md:
  roles.sql, auth.sql, public.sql

The passphrase is NOT here and is not recoverable. It is in the project owner's
password manager. Without it this file is permanently unreadable.
EOF

  echo
  echo "verifying by decrypting it again (a copy nobody has opened is a guess)"
  verify "$enc" || die "the archive it just wrote does not verify — do NOT rely on it"

  echo
  echo "  archive : $enc"
  echo "  size    : $(du -h "$enc" | cut -f1)"
  echo "  note    : $OUT_DIR/HOW-TO-DECRYPT.txt"
  echo
  echo "Copy BOTH files off this machine. That last step is manual on purpose:"
  echo "where this data is allowed to live is your decision, not a script's."
}

# ---------------------------------------------------------------- verify
verify() {
  local enc="$1"; [ -s "$enc" ] || die "no such archive: $enc"
  get_pass
  local work; work="$(mktemp -d /tmp/ccver.XXXXXX)"
  CLEANUP+=("$work")          # in the PARENT, not a subshell

  ossl_dec "$enc" "$work/p.tar.gz" || { echo "  DECRYPT FAILED — wrong passphrase, or the file is damaged"; return 1; }
  tar -xzf "$work/p.tar.gz" -C "$work" 2>/dev/null || { echo "  UNPACK FAILED — the file is damaged"; return 1; }
  local d; d="$(ls -1d "$work"/*/ 2>/dev/null | head -1)"
  [ -n "$d" ] || { echo "  archive is empty"; return 1; }
  ( cd "$d" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1 ) \
    || { echo "  CHECKSUM MISMATCH — contents do not match what was encrypted"; return 1; }
  [ -s "$d/auth.sql" ] && [ -s "$d/public.sql" ] || { echo "  auth.sql or public.sql is EMPTY inside the archive"; return 1; }
  echo "  decrypts, unpacks, and every checksum matches ($(ls -1 "$d" | wc -l | tr -d ' ') files)"
  echo "  rows recorded: $(grep '^live_rows' "$d/MANIFEST.txt" 2>/dev/null | cut -d: -f2-)"
  return 0
}

# ---------------------------------------------------------------- drill
drill() {
  local enc="$1"; [ -s "$enc" ] || die "no such archive: $enc"
  get_pass
  local work; work="$(mktemp -d /tmp/ccdrl.XXXXXX)"
  CLEANUP+=("$work")          # in the PARENT, not a subshell
  ossl_dec "$enc" "$work/p.tar.gz" || die "decrypt failed"
  tar -xzf "$work/p.tar.gz" -C "$work" || die "unpack failed"
  local d; d="$(ls -1d "$work"/*/ 2>/dev/null | head -1)"
  echo "restoring the DECRYPTED archive, not the local backup:"
  bash "$HERE/restore-drill.sh" "$d"
}

case "${1:-}" in
  --verify) shift; get_pass; verify "${1:?usage: --verify <file>}" ;;
  --drill)  shift; drill "${1:?usage: --drill <file>}" ;;
  --help|-h) sed -n '2,12p' "$0" ;;
  *)        create "${1:-}" ;;
esac
