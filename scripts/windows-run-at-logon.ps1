# 让「需要管理员权限的启动命令」在登录时自动跑，而且不弹 UAC。
#
# 背景：NapCat 要把 DLL 注入 QQ（QQ 装在 Program Files），这一步必须提权。
# 常见做法是在 .bat 里 `Start-Process -Verb RunAs` 自我提权 —— 代价是**每次登录
# 都弹一次 UAC**。用「计划任务 + 最高权限」可以开机自动跑且不弹。
#
# 用法（需要一次管理员权限，因为它要写计划任务）：
#
#   powershell -ExecutionPolicy Bypass -File .\windows-run-at-logon.ps1 `
#     -TaskName NapCatQQ -Target "D:\path\to\start-napcat.bat" `
#     -RemoveStartupLink "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\NapCatQQ.lnk"
#
# 卸载：
#
#   powershell -ExecutionPolicy Bypass -File .\windows-run-at-logon.ps1 -TaskName NapCatQQ -Remove

param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [string]$Target = '',
    [string]$Arguments = '',
    [string]$WorkingDirectory = '',
    [string]$RemoveStartupLink = '',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 写计划任务必须管理员；没有就自我提权一次（这一次会弹 UAC，之后不再弹）。
if (-not (Test-Admin)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-TaskName', "`"$TaskName`"")
    if ($Target) { $argList += @('-Target', "`"$Target`"") }
    if ($Arguments) { $argList += @('-Arguments', "`"$Arguments`"") }
    if ($WorkingDirectory) { $argList += @('-WorkingDirectory', "`"$WorkingDirectory`"") }
    if ($RemoveStartupLink) { $argList += @('-RemoveStartupLink', "`"$RemoveStartupLink`"") }
    if ($Remove) { $argList += '-Remove' }
    Write-Host '需要管理员权限，正在提权（这一次会弹 UAC）……'
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    exit
}

if ($Remove) {
    schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "已删除计划任务：$TaskName" }
    else { Write-Host "没有找到计划任务：$TaskName（或删除失败）" }
    exit
}

if (-not $Target) {
    Write-Error '缺少 -Target（要开机自动跑的 exe/bat 的完整路径）'
}

if (-not (Test-Path $Target)) {
    Write-Error "找不到目标文件：$Target"
}

# /RL HIGHEST = 以最高权限运行（不弹 UAC）；/SC ONLOGON = 登录时触发
$command = "`"$Target`""
if ($Arguments) { $command = "$command $Arguments" }

$createArgs = @('/Create', '/TN', $TaskName, '/TR', $command, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F')
if ($WorkingDirectory) {
    # schtasks 不支持直接设工作目录，用 cmd /c cd 包一层
    $wrapped = "cmd.exe /c cd /d `"$WorkingDirectory`" && `"$Target`""
    if ($Arguments) { $wrapped = "$wrapped $Arguments" }
    $createArgs = @('/Create', '/TN', $TaskName, '/TR', $wrapped, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F')
}

schtasks @createArgs | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "创建计划任务失败（schtasks 返回 $LASTEXITCODE）"
}

Write-Host "已创建计划任务：$TaskName"
schtasks /Query /TN $TaskName /V /FO LIST | Select-String 'TaskName|Run As User|Schedule Type|Task To Run|Status'

if ($RemoveStartupLink) {
    if (Test-Path $RemoveStartupLink) {
        Remove-Item $RemoveStartupLink -Force
        Write-Host "已删除开机启动快捷方式：$RemoveStartupLink"
    } else {
        Write-Host "启动快捷方式不存在，跳过：$RemoveStartupLink"
    }
}

Write-Host ''
Write-Host '完成。下次登录会自动以最高权限启动，不再弹 UAC。'
Write-Host '注意：这条命令每次登录都会跑；如果你的脚本自己会常驻，别同时留两份自启动。'
