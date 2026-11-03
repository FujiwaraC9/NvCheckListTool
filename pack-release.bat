@echo off
chcp 65001 >nul
title 打包发布
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-release.ps1"
pause
