#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

SETUP_PYINSTALLER=0
BUILD_PYINSTALLER_BOOTLOADER=0
PYINSTALLER_REPO="https://github.com/pyinstaller/pyinstaller.git"
PYINSTALLER_TAG="v6.10.0"
PYINSTALLER_WORKDIR="$PWD/.build-tools/pyinstaller"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-pyinstaller)
      SETUP_PYINSTALLER=1
      ;;
    --build-pyinstaller-bootloader)
      SETUP_PYINSTALLER=1
      BUILD_PYINSTALLER_BOOTLOADER=1
      ;;
    *)
      printf 'Argumento desconhecido: %s\n\n' "$1"
      printf 'Uso:\n'
      printf '  ./setup.sh\n'
      printf '  ./setup.sh --with-pyinstaller\n'
      printf '  ./setup.sh --build-pyinstaller-bootloader\n'
      exit 1
      ;;
  esac
  shift
done

if [ ! -d "venv" ]; then
  python3 -m venv venv
fi

"./venv/bin/python" -m pip install --upgrade pip
"./venv/bin/python" -m pip install -r requirements.txt

if [ "$SETUP_PYINSTALLER" -eq 1 ]; then
  printf '\n==== Instalando PyInstaller na venv ====\n'
  "./venv/bin/python" -m pip install pyinstaller
fi

if [ "$BUILD_PYINSTALLER_BOOTLOADER" -eq 1 ]; then
  printf '\n==========================================\n'
  printf '  PyInstaller custom bootloader\n'
  printf '==========================================\n\n'

  if ! command -v git >/dev/null 2>&1; then
    printf 'ERROR: git nao encontrado no PATH.\n'
    printf 'Instale o Git antes de compilar o bootloader do PyInstaller.\n'
    exit 1
  fi

  mkdir -p ".build-tools"

  if [ ! -d "$PYINSTALLER_WORKDIR" ]; then
    printf '[1/5] Clonando repositorio do PyInstaller...\n'
    git clone "$PYINSTALLER_REPO" "$PYINSTALLER_WORKDIR"
  else
    printf '[1/5] Repositorio local do PyInstaller ja existe. Reutilizando.\n'
  fi

  (
    cd "$PYINSTALLER_WORKDIR"

    printf '\n[2/5] Checkout da versao %s...\n' "$PYINSTALLER_TAG"
    git fetch --tags --force >/dev/null 2>&1 || true
    if ! git checkout "$PYINSTALLER_TAG"; then
      printf 'WARNING: Nao foi possivel trocar para %s. Seguindo com a arvore atual.\n' "$PYINSTALLER_TAG"
    fi

    cd bootloader

    printf '\n[3/5] Limpando build anterior do bootloader...\n'
    "$OLDPWD/venv/bin/python" ./waf distclean || true

    printf '\n[4/5] Compilando bootloader do PyInstaller...\n'
    "$OLDPWD/venv/bin/python" ./waf all

    cd ..

    printf '\n[5/5] Instalando PyInstaller da arvore compilada...\n'
    "$OLDPWD/venv/bin/python" -m pip install .
  )
fi

printf '\nAmbiente pronto.\n'
