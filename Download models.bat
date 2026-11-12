@echo off
title Roleplay Room - download models
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-models.ps1"
if errorlevel 1 pause
