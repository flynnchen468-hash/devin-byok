@echo off
chcp 65001 >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3006 .*LISTENING"') do taskkill /F /PID %%p
echo devin-byok gateway stopped.
pause
