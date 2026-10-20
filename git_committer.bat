@echo off
setlocal
title Git Add Commit Push - Whisper_Flow_v1

cd /d "%~dp0"
set "REPO_URL=https://github.com/sunil5151/Whisper_Flow_v1.git"

echo.
echo === Git Status ===
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo ERROR: This folder is not a Git repository.
    echo Run init_repo.bat first.
    pause
    exit /b 1
)

echo.
git status

echo.
set /p "msg=Enter commit message: "

if not defined msg (
    echo ERROR: Commit message cannot be empty.
    pause
    exit /b 1
)

echo.
echo === Checking Origin Remote ===
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)
if errorlevel 1 goto error

echo.
echo === Adding Changes ===
git add .
if errorlevel 1 goto error

echo.
echo === Committing Changes ===
git commit -m "%msg%"
if errorlevel 1 (
    echo.
    echo Commit failed. There may be no changes to commit, or Git identity may not be configured.
    echo Check the message above before trying again.
    pause
    exit /b 1
)

echo.
echo === Pushing to Origin ===
git push -u origin HEAD
if errorlevel 1 goto error

echo.
echo === Push Successful ===
pause
exit /b 0

:error
echo.
echo ERROR: Git command failed. Check the message above.
pause
exit /b 1
