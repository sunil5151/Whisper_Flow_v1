@echo off
setlocal EnableExtensions EnableDelayedExpansion
title MEMO setup
rem MEMO V1 installer for Windows 10/11. Safe to rerun: it repairs and keeps your settings.
rem MEMO itself needs no admin rights. Installing Git or Node.js may show a Windows permission prompt.
rem Usage: setup_memo.bat [--provider openrouter^|groq^|anthropic^|openai^|mock] [--model <id>] [--yes] [--skip-live]

set "REPO_URL=https://github.com/sunil5151/Whisper_Flow_v1.git"
if defined MEMO_REPO_URL set "REPO_URL=%MEMO_REPO_URL%"
set "SELF=%~nx0"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "MANAGED=%LOCALAPPDATA%\MEMO\app"
set "APP="
set "NODEEXE="

echo.
echo  MEMO setup
echo  ----------
echo  Installs MEMO for this Windows user. Run it again at any time to repair or update.
echo.

echo [1/6] Windows
ver | findstr /c:"Version 10." >nul
if errorlevel 1 (
  echo [FAIL] MEMO V1 needs Windows 10 or 11.
  goto :fail
)
where powershell >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Windows PowerShell is missing; MEMO uses it for the scheduler and key storage.
  goto :fail
)
echo [ok]   Windows 10/11 with PowerShell

echo [2/6] Git, Node.js, npm
call :ensure git Git.Git "Git" "https://git-scm.com/download/win"
if errorlevel 1 goto :fail
call :ensure node OpenJS.NodeJS.LTS "Node.js LTS" "https://nodejs.org/"
if errorlevel 1 goto :fail
call :nodeversion
if errorlevel 1 goto :fail
where npm >nul 2>nul
if errorlevel 1 (
  echo [warn] npm not found. MEMO has no npm dependencies, so setup continues.
) else (
  echo [ok]   npm found ^(MEMO has no dependencies to install^)
)

echo [3/6] Claude Code
call :claude

echo [4/6] MEMO program files
call :source
if errorlevel 1 goto :fail

echo [5/6] Configure MEMO ^(provider, API key, hooks, background task^)
"!NODEEXE!" "!APP!\bin\memo.js" install %*
set "INSTALL_RC=!errorlevel!"

echo.
echo [6/6] Verify
"!NODEEXE!" "!APP!\bin\memo.js" doctor
set "DOCTOR_RC=!errorlevel!"
echo.

if not "!INSTALL_RC!"=="0" goto :partial
if not "!DOCTOR_RC!"=="0" goto :partial
echo ==============================================================
echo  MEMO is installed and working.
echo    1. Open a NEW terminal ^(so the memo command is found^)
echo    2. cd into a project that uses Git
echo    3. run:  memo init
echo    4. use Claude Code there as usual; check with:  memo status
echo  Uninstall: uninstall_memo.bat  ^(your memory data is kept^)
echo ==============================================================
call :maybepause
endlocal
exit /b 0

:partial
echo ==============================================================
echo  MEMO is installed, but something above needs attention.
echo  Fix the FAIL lines, then run setup_memo.bat again - it keeps
echo  everything that already works. Details:  memo doctor
echo ==============================================================
call :maybepause
endlocal
exit /b 1

:fail
echo.
echo Setup stopped before MEMO was configured. Nothing was scheduled.
echo Fix the problem above and run setup_memo.bat again.
call :maybepause
endlocal
exit /b 1

rem ---------------------------------------------------------------------------
rem :ensure <command> <winget id> <display name> <download page>
:ensure
where %1 >nul 2>nul
if not errorlevel 1 (
  echo [ok]   %~3 found
  exit /b 0
)
echo [..]   %~3 is not installed.
where winget >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Install %~3 from %~4 then run setup_memo.bat again.
  exit /b 1
)
set "ANS=Y"
set /p "ANS=       Install %~3 now with winget? Windows may ask for permission. [Y/n]: "
if /i "!ANS!"=="n" (
  echo [FAIL] %~3 is required. Install it from %~4 and run setup_memo.bat again.
  exit /b 1
)
winget install --id %2 -e --source winget --accept-package-agreements --accept-source-agreements
call :refreshpath
where %1 >nul 2>nul
if errorlevel 1 (
  echo [FAIL] %~3 was installed, but this window cannot see it yet.
  echo        Close this window and run setup_memo.bat again - it continues from here.
  exit /b 1
)
echo [ok]   %~3 installed
exit /b 0

rem :nodeversion - Node 20 or newer, and remember node.exe
:nodeversion
set "NODEMAJOR=0"
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJOR=%%v"
if !NODEMAJOR! GEQ 20 goto :nodeok
echo [..]   Node.js !NODEMAJOR! is too old; MEMO needs 20 or newer.
set "ANS=Y"
set /p "ANS=       Upgrade Node.js LTS with winget? [Y/n]: "
if /i "!ANS!"=="n" (
  echo [FAIL] Install Node.js 20+ from https://nodejs.org/ and run setup_memo.bat again.
  exit /b 1
)
winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
call :refreshpath
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJOR=%%v"
if !NODEMAJOR! LSS 20 (
  echo [FAIL] Node.js is still !NODEMAJOR!. Close this window and run setup_memo.bat again.
  exit /b 1
)
:nodeok
for /f "delims=" %%p in ('node -p "process.execPath"') do set "NODEEXE=%%p"
echo [ok]   Node.js !NODEMAJOR! at !NODEEXE!
exit /b 0

rem :claude - optional but expected; the official native installer needs no admin
:claude
where claude >nul 2>nul
if not errorlevel 1 (
  echo [ok]   Claude Code found
  exit /b 0
)
if exist "%USERPROFILE%\.local\bin\claude.exe" (
  set "PATH=%USERPROFILE%\.local\bin;!PATH!"
  echo [ok]   Claude Code found in %%USERPROFILE%%\.local\bin
  exit /b 0
)
echo [..]   Claude Code is not installed. MEMO captures Claude Code sessions.
set "ANS=Y"
set /p "ANS=       Install it now with the official installer from claude.ai? [Y/n]: "
if /i "!ANS!"=="n" (
  echo [warn] skipped. Install later: https://code.claude.com/docs/en/setup
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
call :refreshpath
if exist "%USERPROFILE%\.local\bin\claude.exe" set "PATH=%USERPROFILE%\.local\bin;!PATH!"
where claude >nul 2>nul
if errorlevel 1 (
  echo [warn] Claude Code is not visible in this window yet; open a new terminal after setup.
  exit /b 0
)
echo [ok]   Claude Code installed ^(run "claude" once to log in^)
exit /b 0

rem :source - use this folder if it holds MEMO, else download/update the managed copy
:source
if exist "%HERE%\bin\memo.js" (
  set "APP=%HERE%"
  echo [ok]   using MEMO in !APP!
  if exist "%HERE%\.git" echo        This is a Git checkout; setup never changes its files. Update it with "git pull".
  exit /b 0
)
if exist "%MANAGED%\bin\memo.js" (
  set "APP=%MANAGED%"
  call :update
  exit /b 0
)
echo [..]   downloading MEMO into %MANAGED%
git clone --depth 1 "%REPO_URL%" "%MANAGED%"
if errorlevel 1 (
  echo [FAIL] Download failed. Check your internet connection and run setup_memo.bat again.
  exit /b 1
)
set "APP=%MANAGED%"
echo [ok]   MEMO downloaded
exit /b 0

:update
if not exist "%APP%\.git" (
  echo [ok]   using MEMO in !APP!
  exit /b 0
)
set "DIRTY="
for /f "delims=" %%s in ('git -C "%APP%" status --porcelain') do set "DIRTY=1"
if defined DIRTY (
  echo [warn] local changes in !APP! - not updating it.
  exit /b 0
)
git -C "%APP%" pull --ff-only --quiet
if errorlevel 1 (
  echo [warn] could not update MEMO - keeping the installed version.
) else (
  echo [ok]   MEMO is up to date in !APP!
)
exit /b 0

rem :refreshpath - pick up PATH changes made by installers without reopening the window
:refreshpath
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
exit /b 0

rem :maybepause - keep the window open when started by double-click
:maybepause
echo !cmdcmdline! | findstr /i /c:"!SELF!" >nul
if not errorlevel 1 if not defined MEMO_NO_PAUSE pause
exit /b 0
