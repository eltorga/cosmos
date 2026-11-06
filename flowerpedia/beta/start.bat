@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title BloomDesk Launcher v0.2.2
if not exist "%~dp0private\start.bat" (
    echo ERROR: No se encuentra private\start.bat.
    echo Ejecuta start.bat desde la carpeta principal de BloomDesk.
    pause
    exit /b 1
)
call "%~dp0private\start.bat"
exit /b %ERRORLEVEL%
