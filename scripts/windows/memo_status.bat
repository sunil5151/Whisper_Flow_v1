@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
node "%ROOT%\bin\memo.js" status
echo.
pause
endlocal
