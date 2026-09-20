@echo off
cd /d "%~dp0"
start "" http://localhost:8787/index.html
python nocache_server.py
