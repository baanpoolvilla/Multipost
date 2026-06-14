@echo off
echo Set sh=CreateObject("WScript.Shell") > "%temp%\_mpa.vbs"
echo sh.CurrentDirectory = "%~dp0" >> "%temp%\_mpa.vbs"
echo sh.Run "cmd /c npm start",0,False >> "%temp%\_mpa.vbs"
cscript //nologo "%temp%\_mpa.vbs"
del "%temp%\_mpa.vbs" 2>nul
