@echo off
setlocal EnableExtensions EnableDelayedExpansion
title MEMO uninstall
rem Removes what MEMO set up on this machine: the scheduled task, the Claude Code hooks and the
rem memo command. Your memory data is NOT deleted: .memory\ in each repo and %USERPROFILE%\.memo stay
rem unless you explicitly ask for it below. Usage: uninstall_memo.bat [--remove-key] [--yes]

set "SELF=%~nx0"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "MANAGED=%LOCALAPPDATA%\MEMO\app"
set "APP="
if exist "%HERE%\bin\memo.js" (
  set "APP=%HERE%"
) else if exist "%MANAGED%\bin\memo.js" (
  set "APP=%MANAGED%"
)
if not defined APP (
  echo MEMO program files were not found next to this script or in %MANAGED%.
  goto :end
)
where node >nul 2>nul
if errorlevel 1 (
  echo node was not found, so MEMO cannot remove its hooks itself.
  echo Remove the "MEMO Background Processor" task in Task Scheduler and the memo.js entries in
  echo %%USERPROFILE%%\.claude\settings.json by hand.
  goto :end
)

node "!APP!\bin\memo.js" uninstall %*

if /i "!APP!"=="%MANAGED%" (
  echo.
  set "ANS=N"
  set /p "ANS=Also delete the downloaded MEMO program in !APP!? Your data is elsewhere. [y/N]: "
  if /i "!ANS!"=="y" (
    rmdir /s /q "!APP!"
    echo [ok]     deleted !APP!
  )
)

:end
echo.
echo Done.
echo !cmdcmdline! | findstr /i /c:"!SELF!" >nul
if not errorlevel 1 if not defined MEMO_NO_PAUSE pause
endlocal
exit /b 0
