@echo off
setlocal
cd /d "%~dp0"
title BloomDesk v0.01

echo ==========================================
echo          BLOOMDESK - INICIO LOCAL
echo ==========================================
echo.

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON_CMD=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo ERROR: No se encontro Python.
        echo Instala Python 3.10 o superior desde https://www.python.org/downloads/
        echo Marca la opcion "Add Python to PATH" durante la instalacion.
        pause
        exit /b 1
    )
    set "PYTHON_CMD=python"
)

if not exist ".venv\Scripts\python.exe" (
    echo Creando entorno de Python...
    %PYTHON_CMD% -m venv .venv
    if errorlevel 1 goto error
)

echo Comprobando e instalando dependencias...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto error

echo.
echo Abriendo BloomDesk en http://127.0.0.1:5000
start "" http://127.0.0.1:5000
echo.
echo Para cerrar BloomDesk, cierra esta ventana.
echo No cierres el navegador para detener el servidor; usa esta ventana.
echo.
".venv\Scripts\python.exe" app.py
goto end

:error
echo.
echo No se pudo iniciar BloomDesk. Revisa el mensaje anterior.
pause
exit /b 1

:end
endlocal
