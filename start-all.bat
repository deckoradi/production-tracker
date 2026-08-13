@echo off
echo 🚀 Pokrecem Production Tracker...
start "Backend" cmd /k "cd /d C:\Users\Korisnik\Desktop\production-tracker\backend && node server.js"
timeout /t 3 /nobreak >nul
start "Frontend" cmd /k "cd /d C:\Users\Korisnik\Desktop\production-tracker\frontend && python -m http.server 3000"
timeout /t 2 /nobreak >nul
start chrome http://localhost:3000
echo ✅ Aplikacija pokrenuta!
pause