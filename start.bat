@echo off
setlocal
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
  echo Venv nao encontrada. Rode setup.bat primeiro.
  exit /b 1
)

call "venv\Scripts\python.exe" app.py
