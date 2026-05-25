#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ ! -x "./venv/bin/python" ]; then
  printf 'Venv nao encontrada. Rode setup.sh primeiro.\n' >&2
  exit 1
fi

"./venv/bin/python" app.py
