@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  === Fridge Ops ===
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js не найден. Установите LTS-версию с https://nodejs.org и запустите файл снова.
  pause
  exit /b 1
)
if not exist node_modules (
  echo  Первый запуск: устанавливаю зависимости, это займёт 1-2 минуты...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
echo  Компьютер:  http://localhost:3000
echo  Телефон в той же Wi-Fi сети: адрес из строки "Network" ниже
echo  Остановить: закройте это окно или нажмите Ctrl+C
echo.
start "" /min cmd /c "timeout /t 8 >nul & start http://localhost:3000"
call npm run dev -- -H 0.0.0.0
pause
