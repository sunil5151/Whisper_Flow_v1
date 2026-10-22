@echo off
rem Kept so older instructions still work. The uninstaller is uninstall_memo.bat in the MEMO folder.
call "%~dp0..\..\uninstall_memo.bat" %*
exit /b %errorlevel%
