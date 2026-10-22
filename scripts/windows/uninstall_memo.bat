@echo off
setlocal EnableDelayedExpansion
title MEMO uninstaller
set "HERE=%~dp0"
for %%I in ("%HERE%..\..") do set "ROOT=%%~fI"
set "MEMOJS=%ROOT%\bin\memo.js"
set "TASKNAME=MEMO Background Processor"

echo MEMO uninstaller
echo This removes the scheduled task, the logon shortcut and the Claude Code hooks.
echo Your memory data is NOT deleted: .memory/ in each repo and %%USERPROFILE%%\.memo stay.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%register-task.ps1" -NodeExe "node" -MemoJs "%MEMOJS%" -TaskName "%TASKNAME%" -Remove
call node "%MEMOJS%" setup claude --remove
echo.

echo To also erase the captured data, type exactly:  DELETE-ALL-MEMO-DATA
set /p "WIPE=otherwise press Enter to keep it: "
if /i "!WIPE!"=="DELETE-ALL-MEMO-DATA" (
  echo.
  echo Per repo, run this inside the repo:
  echo   node "%MEMOJS%" clear --all-repo-data --yes --confirm DELETE-ALL-MEMO-DATA
  echo.
  set /p "WIPEHOME=also delete %USERPROFILE%\.memo on this machine? [y/N]: "
  if /i "!WIPEHOME!"=="y" (
    rmdir /s /q "%USERPROFILE%\.memo"
    echo [ok] %USERPROFILE%\.memo removed
  )
) else (
  echo [ok] data kept
)

echo.
echo Done.
endlocal
exit /b 0
