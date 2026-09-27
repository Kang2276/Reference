@echo off
cd /d "%~dp0"
echo 온라인 버전(GitHub)에서 최신 파일을 받아오는 중...
echo (즐겨찾기/메모/직접 추가한 항목 등 내 데이터는 그대로 유지됩니다)
echo.

powershell -Command "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Kang2276/Reference/main/index.html' -OutFile 'index.html' -UseBasicParsing; Write-Host '[OK] index.html' } catch { Write-Host '[실패] index.html - 인터넷 연결을 확인하세요.'; exit 1 }"
if errorlevel 1 goto :fail

powershell -Command "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Kang2276/Reference/main/style.css' -OutFile 'style.css' -UseBasicParsing; Write-Host '[OK] style.css' } catch { Write-Host '[실패] style.css'; exit 1 }"
if errorlevel 1 goto :fail

powershell -Command "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Kang2276/Reference/main/app.js' -OutFile 'app.js' -UseBasicParsing; Write-Host '[OK] app.js' } catch { Write-Host '[실패] app.js'; exit 1 }"
if errorlevel 1 goto :fail

powershell -Command "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Kang2276/Reference/main/data.js' -OutFile 'data.js' -UseBasicParsing; Write-Host '[OK] data.js' } catch { Write-Host '[실패] data.js'; exit 1 }"
if errorlevel 1 goto :fail

echo.
echo 업데이트 완료! 실행.bat 으로 실행하세요.
pause
exit /b 0

:fail
echo.
echo 업데이트 실패. 인터넷 연결 상태를 확인하고 다시 시도해주세요.
pause
exit /b 1
