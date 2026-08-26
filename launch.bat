@echo off
chcp 65001 >nul
title NvCheckList - 展锐 NV 检查工具

rem ============================================================
rem  NvCheckList 启动器（Edge 应用模式）
rem
rem  使用方式：
rem    1. 本地开发/调试：直接双击本 bat，会打开本地 index.html
rem    2. 云端部署后：把下方 URL 改成 GitHub Pages 地址，组内只需要发这个 bat
rem
rem  --app= 模式：以"独立应用窗口"打开，无地址栏/标签栏，体验像独立软件
rem ============================================================

rem ===== 云端 URL（部署后把这一行取消注释，并注释下方本地文件行）=====
rem set "APP_URL=https://eamon-yang-Quectel.github.io/NvCheckList/"

rem ===== 本地文件路径（默认）=====
set "APP_URL=%~dp0index.html"

echo ============================================================
echo  正在启动 NvCheckList ...
echo  URL: %APP_URL%
echo ============================================================
echo.

rem 尝试 msedge，再退到 chrome
where msedge >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" msedge --app="%APP_URL%" --window-size=1100,780
    goto :done
)
where chrome >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" chrome --app="%APP_URL%" --window-size=1100,780
    goto :done
)

rem 两个都没找到，退到默认浏览器打开
echo [警告] 未找到 msedge 或 chrome，将使用默认浏览器打开。
echo        建议使用 Edge 以获得最佳体验（独立窗口、Web Serial 支持）。
start "" "%APP_URL%"

:done
timeout /t 1 >nul
exit /b 0
