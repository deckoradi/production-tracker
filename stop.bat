@echo off
echo.
echo ========================================
echo   🛑 GASIM PRODUCTION TRACKER SERVERE
echo ========================================
echo.

echo 📡 Gasim Node server...
taskkill /f /im node.exe >nul 2>&1
if %errorlevel%==0 (
    echo    ✅ Node server ugašen
) else (
    echo    ℹ️ Node server nije bio pokrenut
)

echo.
echo 🌐 Gasim Python server...
taskkill /f /im python.exe >nul 2>&1
if %errorlevel%==0 (
    echo    ✅ Python server ugašen
) else (
    echo    ℹ️ Python server nije bio pokrenut
)

echo.
echo ========================================
echo   ✅ SVI SERVERI SU UGAŠENI!
echo ========================================
echo.
echo 💡 Možete zatvoriti ovaj prozor.
echo.
pause