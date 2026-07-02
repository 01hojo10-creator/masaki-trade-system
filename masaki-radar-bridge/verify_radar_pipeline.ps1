param(

  [ValidateSet('FullPublic','ViewerOnly')]

  [string]$Mode = 'FullPublic',

  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),

  [string]$BaseUrl = 'https://01hojo10-creator.github.io/masaki-trade-system'

)



$ErrorActionPreference = 'Continue'

$script:Failed = 0

$script:Warnings = 0

$BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$RootDir = Split-Path -Parent $BridgeDir

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'



function Mark($ok, $message) {

  if ($ok) {

    Write-Host "OK  $message"

  } else {

    Write-Host "NG  $message"

    $script:Failed = 1

  }

}



function Warn($message) {

  Write-Host "WARN $message"

  $script:Warnings += 1

}



function Info($message) {

  Write-Host "INFO $message"

}



function Count-Items($value) {

  if ($null -eq $value) { return 0 }

  return @($value).Count

}



function Count-EntryValid($json) {

  $count = 0

  foreach ($row in @($json.focus) + @($json.watch)) {

    if ($null -eq $row) { continue }

    $action = [string]($row.finalAction)

    if (-not $action) { $action = [string]($row.entryStatus) }

    if ($action -match 'ENTRY_VALID') { $count += 1 }

  }

  return $count

}



function Get-JsonFile($label, $path) {

  if (-not (Test-Path -LiteralPath $path)) {

    Mark $false "$label missing path=$path"

    return $null

  }

  try {

    $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop

    Mark $true "$label parse=OK path=$path"

    return $json

  } catch {

    Mark $false "$label parse=NG path=$path error=$($_.Exception.Message)"

    return $null

  }

}



function Get-JsonUrl($label, $url, [switch]$Optional) {

  try {

    $res = Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 20

    try {

      $json = $res.Content | ConvertFrom-Json -ErrorAction Stop

      Mark $true "$label http=$($res.StatusCode) parse=OK bytes=$($res.Content.Length)"

      return $json

    } catch {

      if ($Optional) { Warn "$label http=$($res.StatusCode) parse=NG error=$($_.Exception.Message)" } else { Mark $false "$label http=$($res.StatusCode) parse=NG error=$($_.Exception.Message)" }

      return $null

    }

  } catch {

    $status = 'ERR'

    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }

    if ($Optional) { Warn "$label http=$status error=$($_.Exception.Message)" } else { Mark $false "$label http=$status error=$($_.Exception.Message)" }

    return $null

  }

}



function Get-TextUrl($label, $url) {

  try {

    $res = Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 20

    Mark ($res.StatusCode -eq 200) "$label http=$($res.StatusCode) bytes=$($res.Content.Length)"

    return $res.Content

  } catch {

    $status = 'ERR'

    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }

    Mark $false "$label http=$status error=$($_.Exception.Message)"

    return $null

  }

}



function Report-JsonState($label, $json) {

  if (-not $json) { return }

  $focusCount = if ($null -ne $json.focusCount) { $json.focusCount } else { Count-Items $json.focus }

  $watchCount = if ($null -ne $json.watchCount) { $json.watchCount } else { Count-Items $json.watch }

  $entryValid = Count-EntryValid $json

  Write-Host "$label marketDate=$($json.marketDate) generatedAt=$($json.generatedAt) timestamp=$($json.timestamp) runId=$($json.runId) dailyNotificationPath=$($json.dailyNotificationPath) focusCount=$focusCount watchCount=$watchCount ENTRY_VALIDCount=$entryValid"

}



function Report-DailyState($label, $json) {

  if (-not $json) { return }

  $reportNames = ''

  if ($json.reports) { $reportNames = ($json.reports.PSObject.Properties.Name -join ',') }

  Write-Host "$label marketDate=$($json.marketDate) updatedAt=$($json.updatedAt) runId=$($json.runId) reports=$reportNames"

  Mark ([bool]$json.reports) "$label has reports object"

  if ($json.reports -and -not ($json.reports.PSObject.Properties.Name -contains 'preClose')) {

    Warn "$label.preClose missing (not generated)"

  }

  foreach ($slot in @('morning','midday','preClose','evening','night')) {

    $entry = $null

    if ($json.reports -and ($json.reports.PSObject.Properties.Name -contains $slot)) { $entry = $json.reports.$slot }

    if ($entry) {

      Write-Host "$label.$slot runId=$($entry.runId) marketDate=$($entry.marketDate) focusCount=$($entry.focusCount) watchCount=$($entry.watchCount) notificationType=$($entry.notificationType)"

      Mark ($null -ne $entry.focusCount -and $null -ne $entry.watchCount) "$label.$slot has focus/watch counts"

    }

  }

}



function Token-State {

  $process = [bool][Environment]::GetEnvironmentVariable('GITHUB_TOKEN','Process')

  $user = [bool][Environment]::GetEnvironmentVariable('GITHUB_TOKEN','User')

  $machine = [bool][Environment]::GetEnvironmentVariable('GITHUB_TOKEN','Machine')

  $hkcu = $false

  $hklm = $false

  try { $hkcu = [bool](Get-ItemProperty -Path 'HKCU:\Environment' -Name 'GITHUB_TOKEN' -ErrorAction SilentlyContinue).GITHUB_TOKEN } catch {}

  try { $hklm = [bool](Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name 'GITHUB_TOKEN' -ErrorAction SilentlyContinue).GITHUB_TOKEN } catch {}

  [pscustomobject]@{ Process=$process; User=$user; Machine=$machine; HKCU=$hkcu; HKLM=$hklm; Any=($process -or $user -or $machine -or $hkcu -or $hklm) }

}



function Check-Tasks($mode) {

  try {

    $tasks = Get-ScheduledTask | Where-Object { $_.TaskName -match '(MasakiMarketRadar|Publish|Radar|Bridge|holiday)' }

    foreach ($task in $tasks) {

      $info = $null

      try { $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop } catch {}

      $actions = ($task.Actions | ForEach-Object { ($_.Execute + ' ' + $_.Arguments).Trim() }) -join ' | '

      $triggers = ($task.Triggers | ForEach-Object { $_.StartBoundary }) -join ','

      Write-Host "TASK name=$($task.TaskName) enabled=$($task.Settings.Enabled) state=$($task.State) user=$($task.Principal.UserId) lastRun=$($info.LastRunTime) lastResult=$($info.LastTaskResult) nextRun=$($info.NextRunTime) trigger=$triggers action=$actions"

    }

    if ($mode -eq 'ViewerOnly') {

      $publishTasks = @($tasks | Where-Object { $_.TaskName -match 'MasakiMarketRadar_Publish' -and $_.Settings.Enabled })

      Mark ($publishTasks.Count -eq 0) 'ViewerOnly has no enabled local publish tasks'

    } else {

      $publish1230 = @($tasks | Where-Object { $_.TaskName -eq 'MasakiMarketRadar_Publish_1230' -and $_.Settings.Enabled })

      Mark ($publish1230.Count -ge 1) 'FullPublic has enabled MasakiMarketRadar_Publish_1230 task'

    }

  } catch {

    Mark $false "scheduled task check failed error=$($_.Exception.Message)"

  }

}



Write-Host "verify_radar_pipeline mode=$Mode date=$Date stamp=$stamp"



$publicLatest = Get-JsonUrl 'public masaki-radar-latest.json' "$BaseUrl/masaki-radar-latest.json?v=$stamp" -Optional:($Mode -eq 'ViewerOnly')

$publicChatgpt = Get-JsonUrl 'public chatgpt-radar-report.json' "$BaseUrl/chatgpt-radar-report.json?v=$stamp"

$dailyPath = "reports/radar-notifications-$Date.json"

if ($publicChatgpt -and $publicChatgpt.dailyNotificationPath) { $dailyPath = [string]$publicChatgpt.dailyNotificationPath }

$publicDaily = Get-JsonUrl 'public daily notification JSON' "$BaseUrl/${dailyPath}?v=$stamp"

$viewerHtml = Get-TextUrl 'notification viewer HTML' "$BaseUrl/radar_notification_viewer.html?v=$stamp"



Report-JsonState 'PUBLIC_LATEST' $publicLatest

Report-JsonState 'PUBLIC_CHATGPT' $publicChatgpt

Report-DailyState 'PUBLIC_DAILY' $publicDaily



if ($publicChatgpt) {

  Mark ($publicChatgpt.marketDate -eq $Date) 'public chatgpt marketDate equals check date'

  Mark ([string]$publicChatgpt.dailyNotificationPath -eq $dailyPath) 'public chatgpt dailyNotificationPath is readable target'

}

if ($publicDaily) {

  Mark ($publicDaily.marketDate -eq $Date) 'public daily marketDate equals check date'

}

if ($publicLatest) {

  if ($Mode -eq 'FullPublic') {

    Mark ($publicLatest.marketDate -eq $Date) 'public latest marketDate equals check date'

  } elseif ($publicLatest.marketDate -ne $Date) {

    Warn "ViewerOnly ignores public latest freshness; publicLatestMarketDate=$($publicLatest.marketDate)"

  }

}



if ($Mode -eq 'FullPublic') {

  $localLatest = Get-JsonFile 'local latest' (Join-Path $BridgeDir 'latest\masaki-radar-latest.json')

  $lock = Get-JsonFile 'publish lock' (Join-Path $BridgeDir '.radar_publish_lock.json')

  $localChatgpt = Get-JsonFile 'local bridge chatgpt-radar-report.json' (Join-Path $BridgeDir 'chatgpt-radar-report.json')

  $localDaily = Get-JsonFile 'local bridge daily notification JSON' (Join-Path $BridgeDir "reports\radar-notifications-$Date.json")



  Report-JsonState 'LOCAL_LATEST' $localLatest

  Report-JsonState 'LOCAL_CHATGPT' $localChatgpt

  Report-DailyState 'LOCAL_DAILY' $localDaily



  if ($localLatest) {

    Mark ($localLatest.marketDate -eq $Date) 'local latest marketDate equals check date'

    Mark ((Count-Items $localLatest.focus) -gt 0 -and (Count-Items $localLatest.watch) -gt 0) 'local latest has Focus/Watch rows'

  }

  if ($lock) {

    Write-Host "LOCK locked=$($lock.locked) targetRunId=$($lock.targetRunId) createdAtLocal=$($lock.createdAtLocal)"

    Mark ([bool]$lock.locked) 'publish lock locked=true'

    if ($localLatest) { Mark ($lock.targetRunId -eq $localLatest.runId) 'publish lock targetRunId matches local latest runId' }

  }

  if ($localChatgpt -and $localLatest) {

    Mark ($localChatgpt.marketDate -eq $localLatest.marketDate) 'local chatgpt marketDate matches local latest'

    Mark ($localChatgpt.runId -eq $localLatest.runId) 'local chatgpt runId matches local latest'

  }

  if ($publicChatgpt -and $localLatest) {

    Mark ($publicChatgpt.runId -eq $localLatest.runId) 'public chatgpt runId matches local latest'

  }

  if ($publicLatest -and $localLatest) {

    Mark ($publicLatest.runId -eq $localLatest.runId) 'public latest runId matches local latest'

  }

  try {

    $health = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 5

    $healthJson = $health.Content | ConvertFrom-Json -ErrorAction Stop

    Mark ($health.StatusCode -eq 200) 'Bridge /health HTTP 200'

    Write-Host "HEALTH ok=$($healthJson.ok) publishLocked=$($healthJson.publishLocked) publishLockTargetRunId=$($healthJson.publishLockTargetRunId)"

    if ($localLatest) { Mark ($healthJson.publishLockTargetRunId -eq $localLatest.runId) 'Bridge health publishLockTargetRunId matches local latest' }

  } catch {

    Mark $false "Bridge /health unavailable error=$($_.Exception.Message)"

  }

}



Check-Tasks $Mode



$token = Token-State

Write-Host ("GITHUB_TOKEN Process={0} User={1} Machine={2} HKCU={3} HKLM={4}" -f ($(if($token.Process){'PRESENT'}else{'MISSING'})), ($(if($token.User){'PRESENT'}else{'MISSING'})), ($(if($token.Machine){'PRESENT'}else{'MISSING'})), ($(if($token.HKCU){'PRESENT'}else{'MISSING'})), ($(if($token.HKLM){'PRESENT'}else{'MISSING'})))

if ($Mode -eq 'FullPublic') {

  Mark $token.Any 'FullPublic GITHUB_TOKEN available from process/user/machine scope'

} else {

  if ($token.Any) { Warn 'ViewerOnly does not need GITHUB_TOKEN; token is present in at least one scope' } else { Mark $true 'ViewerOnly GITHUB_TOKEN not present' }

}



if ($publicDaily) {

  Info "VIEWER inferredDate=$($publicDaily.marketDate) inferredJson=$dailyPath"

  Mark ($publicDaily.marketDate -eq $Date) 'Viewer inferred display date equals check date'

}

Warn 'Viewer console error/warning requires browser automation; this PowerShell mode performs HTTP/JSON checks only'

Write-Host "SUMMARY failed=$script:Failed warnings=$script:Warnings mode=$Mode"

exit $script:Failed

