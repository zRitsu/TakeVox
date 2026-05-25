@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "SETUP_PYINSTALLER=0"
set "BUILD_PYINSTALLER_BOOTLOADER=0"
set "PYINSTALLER_REPO=https://github.com/pyinstaller/pyinstaller.git"
set "PYINSTALLER_TAG=v6.10.0"
set "PYINSTALLER_WORKDIR=%CD%\.build-tools\pyinstaller"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--with-pyinstaller" (
  set "SETUP_PYINSTALLER=1"
  shift
  goto :parse_args
)
if /i "%~1"=="--build-pyinstaller-bootloader" (
  set "SETUP_PYINSTALLER=1"
  set "BUILD_PYINSTALLER_BOOTLOADER=1"
  shift
  goto :parse_args
)
echo Argumento desconhecido: %~1
echo.
echo Uso:
echo   setup.bat
echo   setup.bat --with-pyinstaller
echo   setup.bat --build-pyinstaller-bootloader
exit /b 1

:args_done

if not exist "venv" (
  py -3 -m venv venv
)

call "venv\Scripts\python.exe" -m pip install --upgrade pip
call "venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

if "%SETUP_PYINSTALLER%"=="1" (
  echo.
  echo ==== Instalando PyInstaller na venv ====
  call "venv\Scripts\python.exe" -m pip install pyinstaller
  if errorlevel 1 exit /b 1
)

if "%BUILD_PYINSTALLER_BOOTLOADER%"=="1" (
  echo.
  echo ==========================================
  echo   PyInstaller custom bootloader
  echo ==========================================
  echo.

  where git >nul 2>&1
  if errorlevel 1 (
    echo ERROR: git nao encontrado no PATH.
    echo Instale o Git antes de compilar o bootloader do PyInstaller.
    exit /b 1
  )

  if not exist ".build-tools" mkdir ".build-tools"

  if not exist "%PYINSTALLER_WORKDIR%" (
    echo [1/5] Clonando repositorio do PyInstaller...
    git clone %PYINSTALLER_REPO% "%PYINSTALLER_WORKDIR%"
    if errorlevel 1 (
      echo ERROR: Falha ao clonar o PyInstaller.
      exit /b 1
    )
  ) else (
    echo [1/5] Repositorio local do PyInstaller ja existe. Reutilizando.
  )

  pushd "%PYINSTALLER_WORKDIR%"
  if errorlevel 1 (
    echo ERROR: Falha ao abrir a pasta de trabalho do PyInstaller.
    exit /b 1
  )

  echo.
  echo [2/5] Checkout da versao %PYINSTALLER_TAG%...
  git fetch --tags --force >nul 2>&1
  git checkout %PYINSTALLER_TAG%
  if errorlevel 1 (
    echo WARNING: Nao foi possivel trocar para %PYINSTALLER_TAG%. Seguindo com a arvore atual.
  )

  pushd bootloader
  if errorlevel 1 (
    echo ERROR: Pasta bootloader nao encontrada no repositorio do PyInstaller.
    popd
    exit /b 1
  )

  echo.
  echo [3/5] Limpando build anterior do bootloader...
  call "..\..\venv\Scripts\python.exe" .\waf distclean

  echo.
  echo [4/5] Compilando bootloader do PyInstaller...
  call "..\..\venv\Scripts\python.exe" .\waf all
  if errorlevel 1 (
    echo.
    echo ERROR: Falha ao compilar o bootloader do PyInstaller.
    echo Verifique se o Visual Studio Build Tools / MSVC estao instalados.
    popd
    popd
    exit /b 1
  )

  popd

  echo.
  echo [5/5] Instalando PyInstaller da arvore compilada...
  call "..\..\venv\Scripts\python.exe" -m pip install .
  if errorlevel 1 (
    echo ERROR: Falha ao instalar o PyInstaller com o bootloader compilado.
    popd
    exit /b 1
  )

  popd
)

echo.
echo Ambiente pronto.
