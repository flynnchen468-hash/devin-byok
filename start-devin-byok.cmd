@echo off
chcp 65001 >nul
title devin-byok gateway
cd /d "%~dp0"
echo [devin-byok] starting gateway on port 3006 ...
node src/hybrid-server.js
pause
