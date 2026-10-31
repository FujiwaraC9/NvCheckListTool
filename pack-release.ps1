# 打包发布脚本：将 web 目录打包为 zip，排除开发文件
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $src) { $src = Split-Path -Parent $PSCommandPath }
if (-not $src) { $src = (Get-Location).Path }
$dst = Join-Path $src 'NvCheckListTool_Release.zip'

Write-Host '============================================================'
Write-Host '  开始打包 NvCheckListTool'
Write-Host '============================================================'

if (Test-Path $dst) { Remove-Item $dst -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($dst, 'Create')

Get-ChildItem -Path $src -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\\.git\\' -and
  $_.FullName -notmatch '\\\.git$' -and
  $_.Name -ne '.gitignore' -and
  $_.Name -ne 'generate-version.py' -and
  $_.Name -ne 'pack-release.bat' -and
  $_.Name -ne 'pack-release.ps1' -and
  $_.FullName -notmatch '\\__pycache__\\' -and
  $_.Extension -ne '.zip'
} | ForEach-Object {
  $rel = $_.FullName.Substring($src.Length).TrimStart('\')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)
  Write-Host ('  + ' + $rel)
}

$zip.Dispose()

$size = [math]::Round((Get-Item $dst).Length / 1KB, 1)
Write-Host ''
Write-Host ('打包完成: ' + $dst)
Write-Host ('文件大小: ' + $size + ' KB')
Write-Host '============================================================'
