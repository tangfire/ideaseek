@echo off
REM IdeaSeek one-command setup for Windows.
REM Clone → run this → ideaseek is globally available.
setlocal enabledelayedexpansion

set "RED=[31m"
set "GREEN=[32m"
set "YELLOW=[33m"
set "NC=[0m"

echo.
echo ==^> Checking required tools
echo.

REM Git
where git >nul 2>&1
if %errorlevel%==0 (
    echo [ok] git available
) else (
    echo [X] git not found
    echo   Install: https://git-scm.com/downloads
    exit /b 1
)

REM Node.js
where node >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
    echo [ok] node !NODE_VER!
) else (
    echo [X] node not found
    echo   Install: https://nodejs.org/ (LTS recommended)
    exit /b 1
)

REM pnpm
where pnpm >nul 2>&1
if %errorlevel%==0 (
    echo [ok] pnpm available
) else (
    echo [!] pnpm not found - installing...
    npm install -g pnpm
    echo [ok] pnpm installed
)

REM Python
where python >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PY_VER=%%i
    echo [ok] python !PY_VER!
) else (
    echo [!] python not found - needed for experiments
    echo   Install: https://python.org/downloads/ (check "Add to PATH")
)

REM LaTeX
where pdflatex >nul 2>&1
if %errorlevel%==0 (
    echo [ok] pdflatex available
) else (
    echo [!] pdflatex not found - needed for "ideaseek paper compile"
    echo   Install: https://tug.org/texlive/ (Windows installer)
)

REM SVG converter
where inkscape >nul 2>&1
if %errorlevel%==0 (
    echo [ok] inkscape available
) else (
    where rsvg-convert >nul 2>&1
    if !errorlevel!==0 (
        echo [ok] rsvg-convert available
    ) else (
        echo [!] no SVG^>PDF converter - "paper diagram" figures will be skipped
        echo   Install: https://inkscape.org/ (Windows installer)
    )
)

echo.
echo ==^> Installing IdeaSeek dependencies
call pnpm install

echo.
echo ==^> Building IdeaSeek
call pnpm build

echo.
echo ==^> Making ideaseek globally available
where ideaseek >nul 2>&1
if %errorlevel%==0 (
    echo [ok] ideaseek already on PATH
) else (
    REM Add dist to user PATH
    set "IDEASEEK_BIN=%~dp0dist\cli.js"
    for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"
    echo !USER_PATH!;%IDEASEEK_BIN% | find /i "%IDEASEEK_BIN%" >nul 2>&1
    if %errorlevel% neq 0 (
        setx Path "%USER_PATH%;%IDEASEEK_BIN%" >nul 2>&1
        echo [ok] added to PATH - restart your terminal
    ) else (
        echo [ok] already in PATH
    )
)

echo.
echo ==^> Setup complete!
echo.
echo Next steps:
echo   1. cd your-project-directory
echo   2. ideaseek init
echo   3. ideaseek setup          (verify environment)
echo   4. ideaseek models setup   (configure API key)
echo   5. ideaseek prepare --question "your research question"
echo.
pause
