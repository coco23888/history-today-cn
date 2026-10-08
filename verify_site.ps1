# 展示页运行时校验：确认「HTML 空壳 + 外部 data.json」这种拆分真的能用。
# 之前数据全内嵌在 index.html（10 MB）里，拆开后最容易坏的就是加载那一步 —— 所以单独验一遍。
# 前置：复核服务已启动（python server/review_server.py）
# 用法: pwsh -File onthisday\verify_site.ps1
param(
  [string]$Url = 'http://127.0.0.1:8770/__probe_site.html',
  [string]$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
)
$ErrorActionPreference = 'Stop'
$domFile = Join-Path $env:TEMP 'dsh_site_dom.txt'
$prof = Join-Path $env:TEMP ('dsh_site_prof_' + [guid]::NewGuid().ToString('N').Substring(0, 8))

Start-Process -FilePath $Chrome -ArgumentList @(
  '--headless=new','--disable-gpu','--no-first-run',"--user-data-dir=$prof",
  '--virtual-time-budget=60000','--dump-dom',$Url
) -RedirectStandardOutput $domFile -NoNewWindow -Wait

$dom = Get-Content $domFile -Raw -Encoding UTF8
Remove-Item $domFile -ErrorAction SilentlyContinue
$title = [regex]::Match($dom, '<title>([^<]*)</title>').Groups[1].Value
$kv = @{}
foreach ($m in [regex]::Matches($title, '(\w+)=([^|]*)')) { $kv[$m.Groups[1].Value] = $m.Groups[2].Value.Trim() }
$errPart = if ($title -match 'RT\|([^|]*)') { $Matches[1] } else { '?' }

Write-Host "`n=== 展示页运行时校验（拆分模式）===" -ForegroundColor Cyan
Write-Host "  探针: $title`n"

$fail = 0
function Chk($name, $ok, $extra = '') {
  if ($ok) { Write-Host ("  ✓ {0}{1}" -f $name, $extra) -ForegroundColor Green }
  else { Write-Host ("  ✗ {0}{1}" -f $name, $extra) -ForegroundColor Red; $script:fail++ }
}
$n = { param($k) if ($kv.ContainsKey($k) -and $kv[$k] -match '^\d+$') { [int]$kv[$k] } else { -1 } }

Chk '无 JS 报错' ($errPart -eq 'noerr') " ($errPart)"
Chk 'data.json 加载成功（条目渲染出来）' ((& $n 'items') -gt 0) " ($($kv['items']) 条)"
Chk '加载提示已隐藏' (($kv['bootHidden'] -eq 'none') -or ($kv['bootHidden'] -eq 'gone')) " (display=$($kv['bootHidden']))"
Chk '默认打开今天这个日期' ($kv['dateSel'] -eq $kv['todayKey']) " (默认 $($kv['dateSel']) / 今天 $($kv['todayKey']))"
Chk '停在今天时地址不带 ?d=' ($kv['search'] -eq '(empty)') " (地址 $($kv['search']))"
Chk '「今天」按钮高亮' ($kv['todayOn'] -eq 'yes')
Chk '上下一天按钮都在' ($kv['hasPrev'] -and $kv['hasNext'])
Chk '有分类 / 类型 chips' ($kv['chips'] -match '\S' -and $kv['chips'] -ne '(missing) || (missing)')
Chk '有节日卡片' ((& $n 'fesCards') -gt 0) " ($($kv['fesCards']) 张)"
Chk '下一天能跳过去' ($kv['stepChanged'] -eq 'ok' -and (& $n 'itemsAfterStep') -gt 0) `
  " (跳到 $($kv['stepTo'])，$($kv['itemsAfterStep']) 条)"
Chk 'URL 的 ?d= 跟随跳转' ($kv['urlAfterStep'] -eq $kv['stepTo']) " (?d=$($kv['urlAfterStep']))"
Chk '「今天」按钮能跳回来' ($kv['backToToday'] -eq 'ok') " (地址 $($kv['searchBack']))"

Write-Host "  · 当天: $($kv['dayTitle'])"
Write-Host "  · 统计卡: $($kv['stats'])"

Write-Host ""
if ($fail -eq 0) { Write-Host "✅ 展示页运行时校验全部通过" -ForegroundColor Green }
else { Write-Host "❌ $fail 项失败" -ForegroundColor Red }
if ($fail -ne 0) { exit 1 }
