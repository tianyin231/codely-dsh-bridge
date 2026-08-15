@echo off
title codely-dsh-bridge (port 8790)
cd /d "%~dp0"
node codely-proxy.js
pause
