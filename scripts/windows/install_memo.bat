@echo off
rem Kept so older instructions still work. The installer is setup_memo.bat in the MEMO folder.
call "%~dp0..\..\setup_memo.bat" %*
exit /b %errorlevel%
