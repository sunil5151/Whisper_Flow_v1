@echo off
setlocal
title Initialize Whisper_Flow_v1 Repository

cd /d "%~dp0"
set "REPO_URL=https://github.com/sunil5151/Whisper_Flow_v1.git"

echo.
echo === Whisper_Flow_v1 Repository Setup ===
echo Folder: %CD%
echo Remote: %REPO_URL%
echo.

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed or is not available in PATH.
    pause
    exit /b 1
)

if not exist ".git" (
    echo Initializing Git repository...
    git init
    if errorlevel 1 goto error
) else (
    echo Git repository already initialized.
)

echo.
echo Setting default branch to main...
git branch -M main
if errorlevel 1 goto error

echo.
echo Configuring origin remote...
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)
if errorlevel 1 goto error

echo.
echo === Setup Complete ===
git remote -v
git status
echo.
echo Note: This script does not create a commit or push files.
pause
exit /b 0

:error
echo.
echo ERROR: Repository setup failed. Check the Git error above.
pause
exit /b 1
