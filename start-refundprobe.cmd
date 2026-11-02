@echo off
rem start-refundprobe.cmd —— 重啟退款探測常駐（避免 Start-Process 在環境變數重複時失敗）
rem 用法：雙擊，或在命令列執行 start-refundprobe.cmd
chcp 65001 >nul
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" refundprobe.mjs --watch >> "data\refundprobe_console.log" 2>&1
