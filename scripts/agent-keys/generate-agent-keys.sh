#!/usr/bin/env bash
set -euo pipefail
umask 077
out="${HOME}/.cli-model-gateway/agent-keys"
force=false
validate=false
while (($#)); do
  case "$1" in
    --output-dir) out="${2:?Missing output directory}"; shift 2 ;;
    --force) force=true; shift ;;
    --validate-only) validate=true; shift ;;
    *) echo 'Usage: generate-agent-keys.sh [--output-dir DIR] [--force] [--validate-only]' >&2; exit 1 ;;
  esac
done
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }
command -v git >/dev/null || { echo 'git is required to validate the output location' >&2; exit 1; }
out=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve())' "$out")
probe="$out"
while [[ ! -d "$probe" ]]; do probe=$(dirname "$probe"); done
if [[ $(git -C "$probe" rev-parse --is-inside-work-tree 2>/dev/null || true) == true ]]; then
  echo 'Refusing output inside a git work tree' >&2; exit 1
fi
# Also reject a work tree rooted at a pre-existing output directory.
for file in age-key.txt keys.sops.json checker.sops.json; do
  if [[ -e "$out/$file" || -L "$out/$file" ]]; then
    if [[ "$force" != true ]]; then echo 'Output exists; use --force to replace the complete key set' >&2; exit 1; fi
  fi
done
if [[ "$validate" == true ]]; then printf 'Validated output directory: %s\n' "$out"; exit 0; fi
command -v sops >/dev/null || { echo 'sops is required' >&2; exit 1; }
command -v age-keygen >/dev/null || { echo 'age-keygen is required' >&2; exit 1; }
mkdir -p "$out"
chmod 700 "$out"
scratch=$(mktemp -d "$out/.generate.XXXXXXXX")
cleanup() { rm -f "$scratch/keys.json" "$scratch/checker.json" "$scratch/age-key.txt" "$scratch/keys.sops.json" "$scratch/checker.sops.json"; rmdir "$scratch"; }
trap cleanup EXIT
age-keygen -o "$scratch/age-key.txt" 2>/dev/null
recipient=$(age-keygen -y "$scratch/age-key.txt")
python3 - "$scratch" <<'PY'
import base64, json, os, pathlib, secrets, sys
directory = pathlib.Path(sys.argv[1])
for name, document in (
    ('keys.json', {'keys': {'data': base64.b64encode(secrets.token_bytes(32)).decode('ascii')}}),
    ('checker.json', {'macKey': base64.b64encode(secrets.token_bytes(32)).decode('ascii')}),
):
    with os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        json.dump(document, f)
PY
sops --encrypt --age "$recipient" --input-type json --output-type json --output "$scratch/keys.sops.json" "$scratch/keys.json"
sops --encrypt --age "$recipient" --input-type json --output-type json --output "$scratch/checker.sops.json" "$scratch/checker.json"
for file in age-key.txt keys.sops.json checker.sops.json; do
  if [[ "$force" == true ]]; then mv -f "$scratch/$file" "$out/$file"; else
    # Hard-link publication fails rather than overwriting a concurrently created file.
    ln "$scratch/$file" "$out/$file"
    rm "$scratch/$file"
  fi
done
printf 'Age public recipient: %s\n' "$recipient"
printf '%s\n' "$out/age-key.txt" "$out/keys.sops.json" "$out/checker.sops.json"
printf 'kubectl create secret generic cli-model-gateway-agent-keys --from-file=keys.sops.json=%q --from-file=checker.sops.json=%q --from-file=age-key.txt=%q\n' "$out/keys.sops.json" "$out/checker.sops.json" "$out/age-key.txt"
