@echo off

setlocal



set "PUBLISH_BAT=%~dp0publish_auto.bat"

set "TASK_ACTION=cmd.exe /c ""%PUBLISH_BAT%"""



echo ==============================

echo Register Masaki Market Radar Publish Tasks

echo ==============================

echo.

echo Target:

echo %PUBLISH_BAT%

echo.

echo Schedule:

echo Monday-Friday 09:35 / 12:30 / 15:10 / 17:15 / 22:30

echo.



if not exist "%PUBLISH_BAT%" (

  echo ERROR: publish_auto.bat was not found.

  echo.

  pause

  exit /b 1

)



schtasks /Create /TN "MasakiMarketRadar_Publish_0935" /TR "%TASK_ACTION%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 09:35 /RL LIMITED /F

if errorlevel 1 goto error



schtasks /Create /TN "MasakiMarketRadar_Publish_1230" /TR "%TASK_ACTION%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 12:30 /RL LIMITED /F

if errorlevel 1 goto error


schtasks /Create /TN "MasakiMarketRadar_Publish_1510" /TR "%TASK_ACTION%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 15:10 /RL LIMITED /F

if errorlevel 1 goto error



schtasks /Create /TN "MasakiMarketRadar_Publish_1715" /TR "%TASK_ACTION%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 17:15 /RL LIMITED /F

if errorlevel 1 goto error



schtasks /Create /TN "MasakiMarketRadar_Publish_2230" /TR "%TASK_ACTION%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 22:30 /RL LIMITED /F

if errorlevel 1 goto error



echo.

echo Done. Check the task status with show_publish_task.bat.

echo.

pause

exit /b 0



:error

echo.

echo ERROR: Failed to register one or more publish tasks.

echo.

pause

exit /b 1

