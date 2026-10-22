@echo off
setlocal EnableExtensions
title Sync Local Main from GitHub

cd /d "%~dp0"

echo.
echo ==========================================
echo   Sync local main with latest origin/main
echo   No push. No automatic conflict resolution.
echo ==========================================

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed or not on PATH.
    pause
    exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo ERROR: Place this BAT in the repository root.
    pause
    exit /b 1
)

echo.
echo === Current repository ===
git remote -v
echo.
git status --short

echo.
echo === Fetch latest commits from GitHub ===
git fetch origin
if errorlevel 1 goto :error

echo.
echo === Switch to local main ===
git switch main
if errorlevel 1 (
    echo ERROR: Could not switch to main.
    echo Commit or stash changes on the current branch, then rerun.
    pause
    exit /b 1
)

echo.
echo === Update local main from origin/main ===
echo If a merge conflict occurs, Git will stop and show the conflicting files.
echo Resolve them manually, then run: git add ^<resolved-files^>
echo Then run: git commit
echo.
git pull --no-rebase origin main
if errorlevel 1 (
    echo.
    echo UPDATE STOPPED. Git reported an error or merge conflict.
    echo Resolve conflicts manually. Do not run this BAT again until resolved.
    echo Check status with: git status
    echo After resolving: git add ^<resolved-files^> ^&^& git commit
    pause
    exit /b 1
)

echo.
echo === Local main now includes origin/main ===
git log -1 --oneline --decorate
echo.
echo This script did not push anything to GitHub.
pause
exit /b 0

:error
echo.
echo ERROR: Git fetch failed. Check network or credentials.
pause
exit /b 1
