@echo off
chcp 65001 >nul
title NvCheckList 本地预览服务器
cd /d d:\Workspace\NvCheckListTool\web
echo 正在启动本地预览服务器 http://localhost:8765/ ...
echo 按 Ctrl+C 停止
echo.
py -3 -m http.server 8765
pause
