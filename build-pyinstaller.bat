@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ==========================================
echo   BUILD SCRIPT - TakeVox
echo   PyInstaller (onefile)
echo ==========================================
echo.

echo ==== (1) Checking virtual environment ====
if not exist "venv\Scripts\python.exe" (
    echo ERROR: Virtual environment not found.
    echo Expected: venv\Scripts\python.exe
    echo.
    pause
    exit /b 1
)

set "PYTHON=venv\Scripts\python.exe"
echo Virtual environment found.
echo.

echo ==== (2) Checking PyInstaller ====
"%PYTHON%" -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo PyInstaller not found. Installing...
    "%PYTHON%" -m pip install pyinstaller --quiet
    if errorlevel 1 (
        echo ERROR: Failed to install PyInstaller.
        pause
        exit /b 1
    )
)

for /f "delims=" %%v in ('"%PYTHON%" -m PyInstaller --version 2^>^&1') do (
    echo PyInstaller %%v
    goto :pyinstaller_ok
)
:pyinstaller_ok
echo.

echo ==== (3) Cleaning previous builds ====
if exist "build" rd /s /q build
if exist "dist" rd /s /q dist
if exist "TakeVox.spec" del /q TakeVox.spec
echo Clean complete.
echo.

echo ==== (4) Validating required assets ====
if not exist "static\desktop.html" (
    echo ERROR: static assets not found.
    pause
    exit /b 1
)
if not exist "app.py" (
    echo ERROR: app.py not found.
    pause
    exit /b 1
)
echo Assets found.
echo.

echo ==== (5) Building executable with PyInstaller ====
echo.

"%PYTHON%" -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --onefile ^
    --name TakeVox ^
    --add-data "static;static" ^
    --hidden-import uvicorn.logging ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --collect-all qrcode ^
    app.py

if errorlevel 1 (
    echo.
    echo ERROR: PyInstaller build failed.
    pause
    exit /b 1
)

echo.
echo ==== (6) Checking build result ====
if not exist "dist\TakeVox.exe" (
    echo ERROR: Executable not found in dist\.
    pause
    exit /b 1
)

echo.
echo ==== (7) Generating SHA-256 checksum ====
certutil -hashfile "dist\TakeVox.exe" SHA256 > "dist\TakeVox.exe.sha256"
type "dist\TakeVox.exe.sha256"

echo.
echo ==========================================
echo   BUILD SUCCESSFUL!
echo   Executable : dist\TakeVox.exe
echo   Checksum   : dist\TakeVox.exe.sha256
echo ==========================================
echo.

timeout /t 5 >nul
