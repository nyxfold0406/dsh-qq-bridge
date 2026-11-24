@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在关闭旧的待办小窗...
taskkill /f /im 桌面待办.exe >nul 2>&1
timeout /t 2 /nobreak >nul
if not exist "桌面待办.new.exe" goto nodata
del /f /q "桌面待办.exe" >nul 2>&1
move /y "桌面待办.new.exe" "桌面待办.exe" >nul
if not exist "桌面待办.exe" goto fail
echo 换好了，正在打开新版本...
start "" "桌面待办.exe"
exit /b 0
:nodata
echo 没找到 桌面待办.new.exe，这次没什么可更新的。
pause
exit /b 1
:fail
echo 替换失败：旧 exe 还被占用。先手动关掉小窗，再点一次这个脚本。
pause
exit /b 1
