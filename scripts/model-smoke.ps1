# Windows HTTP diagnostic: one synthetic request, no retry, no secret output.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
if (-not $env:MODEL_API_KEY -and $env:MODEL_SMOKE_DRY_RUN -ne 'true') { throw 'MISSING_MODEL_API_KEY' }
$testRequest = @{
  model = 'glm-4.7'
  messages = @(
    @{ role = 'system'; content = '你是沟通表达助手。只返回JSON，结构为 {"replies":[{"text":"建议1"},{"text":"建议2"},{"text":"建议3"}],"warnings":[]}。三条建议不同，每条不超过240字。不编造事实、经历或时间安排。不输出Markdown。' }
    @{ role = 'user'; content = '合成验收场景：对方说“周末你一定要陪我去，我都答应别人了。”已知事实：我不想参加这次活动。目标：温和拒绝并保持边界，不虚构加班、生病等理由。' }
  )
  stream = $false
  max_tokens = 1024
  thinking = @{ type = 'disabled' }
  response_format = @{ type = 'json_object' }
}
$testTimer = [System.Diagnostics.Stopwatch]::StartNew()
try {
  [byte[]]$body = if ($env:MODEL_SMOKE_BODY_BASE64) { [Convert]::FromBase64String($env:MODEL_SMOKE_BODY_BASE64) } else { [System.Text.Encoding]::UTF8.GetBytes(($testRequest | ConvertTo-Json -Depth 8 -Compress)) }
  if ($env:MODEL_SMOKE_DRY_RUN -eq 'true') {
    $decoded = [System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    @{ dryRun = $true; byteArray = $body -is [byte[]]; model = $decoded.model;
      outputEncoding = [Console]::OutputEncoding.WebName; chineseRoundTrip = $decoded.messages[0].content.Contains('沟通') } | ConvertTo-Json
    exit 0
  }
  $response = Invoke-RestMethod -Uri 'https://open.bigmodel.cn/api/paas/v4/chat/completions' -Method Post -TimeoutSec 22 -ContentType 'application/json; charset=utf-8' -Headers @{ Authorization = "Bearer $env:MODEL_API_KEY" } -Body $body
  if ($env:MODEL_SMOKE_RAW -eq 'true') {
    @{ status = 200; body = ($response | ConvertTo-Json -Depth 20 -Compress) } | ConvertTo-Json -Depth 3 -Compress
    exit 0
  }
  $output = $response.choices[0].message.content | ConvertFrom-Json
  $valid = $response.choices[0].finish_reason -eq 'stop' -and @($output.replies).Count -eq 3
  @{ ok = $valid; httpStatus = 200; model = 'glm-4.7'; elapsedMs = $testTimer.ElapsedMilliseconds;
     output = $output; usage = $response.usage;
     scope = 'Standalone Windows HTTP diagnostic only; not a cloud/mini-program integration test.' } | ConvertTo-Json -Depth 10
} catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($env:MODEL_SMOKE_RAW -eq 'true') {
    @{ status = $status; body = ''; errorType = $_.Exception.GetType().Name } | ConvertTo-Json -Compress
    exit 0
  }
  # ErrorDetails and provider response bodies may contain sensitive text; do not print them.
  @{ ok = $false; httpStatus = $status; elapsedMs = $testTimer.ElapsedMilliseconds;
     errorType = $_.Exception.GetType().Name } | ConvertTo-Json
  exit 1
}
