@echo off
setlocal EnableExtensions
title Sync Local Main with Latest GitHub Commit

cd /d "%~dp0"
set "REPO_URL=https://github.com/sunil5151/Whisper_Flow_v1.git"

echo.
echo ==========================================
echo   Sync local repo with latest origin/main
echo ==========================================

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo ERROR: This BAT must be placed inside the local Git repository.
    pause
    exit /b 1
)

echo.
echo === Verify origin ===
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)
if errorlevel 1 goto :error

echo.
echo === Safety check: local changes ===
git status --short
if not errorlevel 1 (
    for /f "delims=" %%A in ('git status --porcelain') do (
        echo.
        echo ERROR: Local changes exist. Commit or stash them first.
        echo This script will not overwrite local work.
        pause
        exit /b 1
    )
)

echo.
echo === Fetch latest GitHub state ===
git fetch origin
if errorlevel 1 goto :error

echo.
echo === Switch to local main branch ===
git show-ref --verify --quiet refs/heads/main
if errorlevel 1 (
    git switch --track -c main origin/main
) else (
    git switch main
)
if errorlevel 1 (
    echo ERROR: Could not switch to main. Resolve the issue above and rerun.
    pause
    exit /b 1
)

echo.
echo === Fast-forward local main to latest origin/main ===
git pull --ff-only origin main
if errorlevel 1 (
    echo ERROR: Fast-forward was not possible.
    echo No force-push or history rewrite was performed.
    echo Inspect your local main branch before retrying.
    pause
    exit /b 1
)

echo.
echo === Local main is now synced ===
git log -1 --oneline --decorate
echo.
echo No push or PR was created. This only updated your local repository.
pause
exit /b 0

:error
echo.
echo ERROR: Git command failed. Read the message above.
pause
exit /b 1
