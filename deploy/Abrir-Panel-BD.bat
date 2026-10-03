@echo off
REM EV2 - Abrir el panel de la base de datos (D69).
REM
REM Abre un tunel SSH al servidor y el panel en el navegador. El panel NO esta en
REM internet: solo existe dentro del servidor, y este tunel lo trae a tu PC.
REM Mientras esta ventana siga abierta, el panel funciona. Para cerrarlo: cierra la
REM ventana (o Ctrl+C).
REM
REM Si tu usuario o la IP del servidor cambian, edita estas dos lineas:
set EV2_SSH=ev2@45.93.100.244
set EV2_PUERTO=8081

setlocal
chcp 65001 >nul
title EV2 - Panel de la base de datos

where ssh >nul 2>nul
if errorlevel 1 (
  echo No se encontro el comando ssh.
  echo Instalalo en Windows: Configuracion ^> Aplicaciones ^> Caracteristicas opcionales ^> Cliente OpenSSH.
  pause
  exit /b 1
)

echo.
echo  Conectando con %EV2_SSH% ...
echo  Si pide contrasena, es la del usuario SSH del servidor.
echo.
echo  Cuando conecte, el navegador abre:  http://localhost:%EV2_PUERTO%
echo  Entra con:  Sistema PostgreSQL / Servidor postgres / Usuario ev2_lectura / Base ev2
echo.
echo  Deja esta ventana abierta mientras uses el panel.
echo.

REM El navegador se abre a los 4 segundos, en paralelo, para dar tiempo al tunel.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:%EV2_PUERTO%/?pgsql=postgres&username=ev2_lectura&db=ev2&ns=public'"

ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L %EV2_PUERTO%:127.0.0.1:8081 %EV2_SSH%

echo.
echo  El tunel se cerro. Si fue un error, revisa el mensaje de arriba.
pause
