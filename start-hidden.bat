@echo off
cd /d "C:\Users\Korisnik\Desktop\production-tracker\backend"
start /b node server.js > nul 2>&1

cd /d "C:\Users\Korisnik\Desktop\production-tracker\frontend"
start /b python -m http.server 3000 > nul 2>&1

timeout /t 3 /nobreak >nul

start chrome http://localhost:3000

exit