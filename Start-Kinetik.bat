@echo off
setlocal
title Kinetik
cd /d "%~dp0"
echo.
echo   K I N E T I K  -  AI video agent
echo   ---------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [!] FFmpeg belum terpasang. Render video butuh FFmpeg.
  echo     Pasang dengan perintah:  winget install Gyan.FFmpeg
  echo     lalu tutup jendela ini dan jalankan Start-Kinetik.bat lagi.
  echo.
)

where python >nul 2>nul
if errorlevel 1 (
  echo [!] Python belum terpasang. Suara narasi dan latar transparan butuh Python 3.
  echo     Unduh di https://www.python.org/downloads/ dan centang "Add python.exe to PATH".
  echo.
) else (
  python -c "import edge_tts, numpy, PIL, scipy" >nul 2>nul
  if errorlevel 1 (
    echo Memasang paket Python, sekali saja...
    python -m pip install --user -r requirements.txt
  )
)

if not exist node_modules (
  echo Memasang Kinetik untuk pertama kali. Ini sekali saja dan butuh beberapa menit...
  call npm install
  if errorlevel 1 goto :failed
)

echo Kinetik akan terbuka di browser: http://localhost:3210
echo Biarkan jendela ini tetap terbuka selama memakai Kinetik.
start "" cmd /c "timeout /t 12 /nobreak >nul & start http://localhost:3210"
call npm start
goto :end

:nonode
echo [!] Node.js belum terpasang.
echo     Unduh versi LTS di https://nodejs.org lalu jalankan Start-Kinetik.bat lagi.
start "" "https://nodejs.org/en/download"
goto :end

:failed
echo.
echo [!] Pemasangan gagal. Cek koneksi internet lalu coba lagi.

:end
echo.
pause
