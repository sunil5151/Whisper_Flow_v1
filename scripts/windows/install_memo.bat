@echo off
setlocal EnableDelayedExpansion
title MEMO installer
set "HERE=%~dp0"
for %%I in ("%HERE%..\..") do set "ROOT=%%~fI"
set "MEMOJS=%ROOT%\bin\memo.js"
set "TASKNAME=MEMO Background Processor"

echo MEMO installer
echo repo: %ROOT%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [FAIL] git not found in PATH.
  echo        install it:  winget install --id Git.Git -e
  goto :fail
)
where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] node not found in PATH.
  echo        install it:  winget install --id OpenJS.NodeJS.LTS -e
  goto :fail
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJOR=%%v"
if !NODEMAJOR! LSS 20 (
  echo [FAIL] Node !NODEMAJOR! is too old, MEMO needs 20 or newer.
  echo        upgrade:  winget install --id OpenJS.NodeJS.LTS -e
  goto :fail
)
for /f "delims=" %%p in ('node -e "process.stdout.write(process.execPath)"') do set "NODEEXE=%%p"
echo [ok] node !NODEMAJOR! at !NODEEXE!
echo.

echo --- setup (config, Claude Code hooks, privacy notice) ---
call node "%MEMOJS%" install
if errorlevel 1 (
  echo [FAIL] memo install failed.
  goto :fail
)
echo.

if defined MEMO_API_KEY (
  echo [ok] MEMO_API_KEY is already set in this session.
) else (
  echo MEMO_API_KEY is not set. It is stored in your Windows user environment
  echo ^(visible to programs running as you^) and is never written into the repo.
  set /p "WANTKEY=enter it now? [y/N]: "
  if /i "!WANTKEY!"=="y" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Read-Host -AsSecureString 'API key (not echoed)'; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); $p=[Runtime.InteropServices.Marshal]::PtrToStringAuto($b); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); if ($p) { [Environment]::SetEnvironmentVariable('MEMO_API_KEY', $p, 'User'); Write-Host '[ok] saved to user environment MEMO_API_KEY (reopen terminals to see it)' } else { Write-Host '[skip] nothing entered' }"
  ) else (
    echo [skip] set it later:  setx MEMO_API_KEY "your-key"
  )
)
echo.

echo --- scheduled task ---
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%register-task.ps1" -NodeExe "!NODEEXE!" -MemoJs "%MEMOJS%" -TaskName "%TASKNAME%"
if errorlevel 1 (
  echo [warn] task registration failed. You can still run "memo cycle" by hand.
)
echo.

set /p "WANTLINK=make the 'memo' command global with npm link? [y/N]: "
if /i "!WANTLINK!"=="y" (
  pushd "%ROOT%" && call npm link && popd
)
echo.

echo --- self test ---
call node "%MEMOJS%" doctor
echo.
call node "%MEMOJS%" cycle
echo.
call node "%MEMOJS%" status
echo.
echo Done. Useful next:
echo   memo status                 what MEMO did
echo   memo console                browse and delete captured data
echo   scripts\windows\uninstall_memo.bat
goto :done

:fail
echo.
echo Installation stopped. Nothing was scheduled.
endlocal
exit /b 1

:done
endlocal
exit /b 0
