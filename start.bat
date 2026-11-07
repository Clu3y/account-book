@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Please install Python and add it to PATH.
  pause
  exit /b 1
)
python app.py --open
if errorlevel 1 pause
