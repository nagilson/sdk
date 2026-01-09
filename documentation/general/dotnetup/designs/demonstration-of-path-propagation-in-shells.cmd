rem demonstrates that a subprocess environment variable modification 'wins' over the 'system path' and the lookup is really an ordering problem for that shell.
@echo off
setlocal EnableDelayedExpansion
goto :main

:ShowPath
setlocal EnableDelayedExpansion
echo ===============================
echo %displayLabel% entries:
echo -------------------------------
set "displayWorking=!pathValue!"

:showPathLoop
if "!displayWorking!"=="" goto :afterShowPath
for /f "tokens=1* delims=;" %%A in ("!displayWorking!") do (
	set "segment=%%~A"
	set "displayWorking=%%~B"
)

if not "!segment!"=="" echo    !segment!
goto :showPathLoop

:afterShowPath
echo -------------------------------
echo where dotnet:
set "savedPath=%PATH%"
set "PATH=!pathValue!"
if exist "%SystemRoot%\System32\where.exe" (
	"%SystemRoot%\System32\where.exe" dotnet 2>&1
) else (
	echo where.exe not found at %SystemRoot%\System32\where.exe
)
set "PATH=!savedPath!"
echo ===============================
echo.
endlocal
goto :EOF

:main
rem Resolve repo root so PATH points to the local .dotnet install.
for %%I in ("%~dp0..\..\..\..") do set "repoRoot=%%~fI"

rem Capture the original PATH and build a variant that only swaps dotnet entries.
set "originalPath=%PATH%"
set "modifiedPath="

set "pathWorking=!originalPath!"

:buildModified
if "!pathWorking!"=="" goto :afterBuild
for /f "tokens=1* delims=;" %%A in ("!pathWorking!") do (
	set "entry=%%~A"
	set "pathWorking=%%~B"
)

if not "!entry!"=="" (
	set "normalized=!entry:/=\!"
	if "!normalized:~-1!"=="\" set "normalized=!normalized:~0,-1!"
	if /I "!normalized:~-7!"=="\dotnet" (
		set "entry=%repoRoot%\.dotnet"
	)
	if defined modifiedPath (
		set "modifiedPath=!modifiedPath!;!entry!"
	) else (
		set "modifiedPath=!entry!"
	)
)

goto :buildModified

:afterBuild

rem Fall back to the repo muxer if no replacements occurred (unlikely but keeps test predictable).
if not defined modifiedPath set "modifiedPath=%repoRoot%\.dotnet"

set "displayLabel=Baseline PATH"
set "pathValue=!originalPath!"
call :ShowPath

set "displayLabel=Modified PATH"
set "pathValue=!modifiedPath!"
call :ShowPath

endlocal
exit /b
