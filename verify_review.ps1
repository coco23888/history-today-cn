# 复核页运行时校验：无头 Chrome 真渲染 /__probe.html（同源把复核页写进本页再探针检查），确认
#   1) 没有 JS 报错，默认打开的是「今天」这一天
#   2) 默认只列「待人工复核」条目（AI 直通被收起）
#   3) 点「全部」chip 真的列出全部条目（曾经 180 条只列 24 条）
#   4) 点上一天/下一天能跳日期，并且写进 URL 的 ?d=
# 前置：复核服务已启动（python server/review_server.py）
# 用法: pwsh -File onthisday\verify_review.ps1
param(
  [string]$Url = 'http://127.0.0.1:8770/__probe.html',
  [string]$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
)
$ErrorActionPreference = 'Stop'
$domFile = Join-Path $env:TEMP 'dsh_review_dom.txt'
# 每次都用全新 profile：否则 Chrome 会恢复上次会话的地址（带上 ?d=），干扰「默认是不是今天」的判断
$prof = Join-Path $env:TEMP ('dsh_review_prof_' + [guid]::NewGuid().ToString('N').Substring(0, 8))

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

Write-Host "`n=== 复核页运行时校验 ===" -ForegroundColor Cyan
Write-Host "  探针: $title`n"

$fail = 0
function Chk($name, $ok, $extra = '') {
  if ($ok) { Write-Host ("  ✓ {0}{1}" -f $name, $extra) -ForegroundColor Green }
  else { Write-Host ("  ✗ {0}{1}" -f $name, $extra) -ForegroundColor Red; $script:fail++ }
}
$n = { param($k) if ($kv.ContainsKey($k) -and $kv[$k] -match '^\d+$') { [int]$kv[$k] } else { -1 } }

Chk '无 JS 报错' ($errPart -eq 'noerr') " ($errPart)"
Chk '默认打开今天这个日期' ($kv['date0'] -eq $kv['todayKey']) " (默认 $($kv['date0']) / 今天 $($kv['todayKey']) / 地址 $($kv['search']))"
Chk '停在今天时地址不带 ?d=' ($kv['search'] -eq '(empty)') " (地址 $($kv['search']))"
Chk '有「今天」跳转按钮' ($kv['today0'] -eq 'yes')
Chk '默认收起 AI 直通条目' ((& $n 'defAuto') -eq 0) " (默认 $(if($kv['def']) {$kv['def']} else {'?'}) 条中 auto=$($kv['defAuto']))"
# 默认列表 = 待复核 + 已人工标记（这两类都要列出来），只有 AI 直通被收起
Chk '默认列表 = 待复核 + 已标记' ((& $n 'def') -eq ((& $n 'chipNeedN') + (& $n 'chipDoneN'))) `
  " (默认 $($kv['def']) = 待复核 $($kv['chipNeedN']) + 已标记 $($kv['chipDoneN']))"

Chk '点「全部」后列出全部条目' ((& $n 'allBtn') -gt (& $n 'def')) " ($($kv['def']) -> $($kv['allBtn']))"
Chk '点「全部」后不再有被隐藏的直通条目' ((& $n 'allBtnAuto') -gt 0) " (auto=$($kv['allBtnAuto']))"
Chk '点「全部」会自动勾上「显示 AI 直通」' ($kv['allBtnChecked'] -eq 'on')
Chk '点「全部」后出现「⚡ 自动通过」徽章' ((& $n 'allPill') -gt 0) " ($($kv['allPill']) 个)"
Chk '点「待复核」只剩待复核条目' ((& $n 'needBtn') -gt 0 -and (& $n 'needBtnAuto') -eq 0) `
  " ($($kv['needBtn']) 条，其中 auto=$($kv['needBtnAuto']))"
Chk '点「AI 直通」只剩直通条目' ((& $n 'autoBtn') -gt 0 -and (& $n 'autoBtnNeed') -eq 0) `
  " ($($kv['autoBtn']) 条，其中待复核徽章=$($kv['autoBtnNeed']))"
Chk '点「已标记」只剩人工标记过的条目' ((& $n 'doneBtn') -eq (& $n 'chipDoneN') -and (& $n 'doneBtnAuto') -eq 0) `
  " ($($kv['doneBtn']) 条 / chip 说 $($kv['chipDoneN'])，其中直通=$($kv['doneBtnAuto']))"

Chk '下一天能跳过去' ($kv['stepTo'] -ne $kv['stepFrom'] -and $kv['stepTo'] -ne '?') " ($($kv['stepFrom']) -> $($kv['stepTo']))"
Chk 'URL 的 ?d= 跟随跳转' ($kv['urlAfter'] -eq $kv['stepTo']) " (?d=$($kv['urlAfter']))"
Chk '上一天能跳回来' ($kv['backToToday'] -eq 'ok') " (回到 $($kv['stepBack']))"

Write-Host "  · 当天: $($kv['title0'])"
Write-Host "  · AI 判定 chips: $($kv['chips'])"
Write-Host "  · 节日卡片: $($kv['fesCount']) 张"
Write-Host "  · 统计卡: $($kv['stats'])"

Write-Host ""
if ($fail -eq 0) { Write-Host "✅ 复核页运行时校验全部通过" -ForegroundColor Green }
else { Write-Host "❌ $fail 项失败" -ForegroundColor Red }
if ($fail -ne 0) { exit 1 }
