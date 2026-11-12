# Downloads the AI models into .\models (run once, needs internet). Built into Windows; nothing to install.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$models = Join-Path $root 'models'

function New-Client {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = [Net.WebRequest]::DefaultWebProxy
  if ($wc.Proxy) { $wc.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
  $wc.Headers.Add('User-Agent', 'RoleplayRoom-downloader')
  return $wc
}

Write-Host ''
Write-Host '  Roleplay Room - model download'
Write-Host '  ------------------------------'
Write-Host '  Listening : Whisper large-v3-turbo   (always)'
Write-Host '  Voice     : Kokoro                   (always)'
Write-Host '  Optional  : Chatterbox expressive voice (~1.5 GB) - only Ministral 3 3B fits beside it'
Write-Host ''
Write-Host '  Thinking models - all fit on an 8 GB card at full speed:'
$THINK = [ordered]@{
  '1' = @('Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC', 'Ministral 3 3B      fastest measured on 8 GB')
  '2' = @('Hermes-3-Llama-3.2-3B-q4f16_1-MLC', 'Hermes 3 (Llama 3B) roleplay-tuned, fast')
  '3' = @('Phi-4-mini-instruct-q4f16_1-MLC', 'Phi-4 mini          smarter, 20 words/s')
}
foreach ($k in $THINK.Keys) { Write-Host ("    {0}  {1}" -f $k, $THINK[$k][1]) }
Write-Host '    A  All three (~7 GB)  [default]'
$ans = Read-Host '  Type numbers separated by commas (e.g. 1,3), or press Enter for all'
$picked = if ($ans -match '\d') { @($ans -split '[,\s]+' | Where-Object { $THINK.Contains($_) } | ForEach-Object { $THINK[$_][0] }) } else { @($THINK.Values | ForEach-Object { $_[0] }) }
if (-not $picked.Count) { $picked = @($THINK.Values | ForEach-Object { $_[0] }) }
$cbxAns = Read-Host '  Download Chatterbox, the expressive voice? (y/N)'
Write-Host ''

# repo -> files to keep (root config files always come along)
$jobs = @(
  @{ repo = 'onnx-community/whisper-large-v3-turbo'; keep = @('onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx') },
  @{ repo = 'onnx-community/Kokoro-82M-v1.0-ONNX'; keep = @('onnx/model.onnx', 'onnx/model_quantized.onnx', 'voices/') },
  @{ repo = 'Xenova/all-MiniLM-L6-v2'; keep = @('onnx/model_quantized.onnx') }
)
foreach ($m in $picked) { $jobs += @{ repo = "mlc-ai/$m"; keep = @('*') } }
$CBX = @{ repo = 'onnx-community/chatterbox-ONNX'; keep = @('onnx/embed_tokens.onnx', 'onnx/speech_encoder.onnx', 'onnx/language_model_q4f16.onnx', 'onnx/conditional_decoder.onnx') }
if ($cbxAns -match '^[yY]') { $jobs += $CBX }

# ---- Offer to remove models from earlier versions that the clean build doesn't use.
function Get-SizeGB($path) { $b = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; if (-not $b) { $b = 0 }; return [math]::Round($b / 1GB, 2) }
$keepRepos = @($jobs | ForEach-Object { $_.repo }) + @($THINK.Values | ForEach-Object { "mlc-ai/$($_[0])" }) + @($CBX.repo)
$old = @()
if (Test-Path $models) {
  foreach ($org in Get-ChildItem -LiteralPath $models -Directory) {
    foreach ($repo in Get-ChildItem -LiteralPath $org.FullName -Directory) {
      $name = "$($org.Name)/$($repo.Name)"
      if ($keepRepos -notcontains $name) { $old += @{ name = $name; path = $repo.FullName; gb = (Get-SizeGB $repo.FullName) } }
    }
  }
  # Unused files inside the kept models (e.g. the 2.5 GB full-precision turbo encoder).
  foreach ($j in $jobs) {
    if ($j.keep -contains '*') { continue }
    $onnx = Join-Path $models (("$($j.repo)/resolve/main/onnx") -replace '/', '\')
    if (-not (Test-Path $onnx)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $onnx -File) {
      $rel = "onnx/$($f.Name)"
      $used = $false; foreach ($k in $j.keep) { if ($rel.StartsWith($k)) { $used = $true } }
      if (-not $used) { $old += @{ name = "$($j.repo)/$rel"; path = $f.FullName; gb = [math]::Round($f.Length / 1GB, 2) } }
    }
  }
}
if ($old.Count) {
  $sum = 0; foreach ($o in $old) { $sum += $o.gb }
  Write-Host ("  Found {0} item(s) from earlier versions that this build no longer uses ({1:N1} GB):" -f $old.Count, $sum)
  foreach ($o in $old) { Write-Host ("    {0,6:N2} GB  {1}" -f $o.gb, $o.name) }
  $del = Read-Host '  Delete them to free the space? (y/N)'
  if ($del -match '^[yY]') {
    foreach ($o in $old) { Remove-Item -LiteralPath $o.path -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host '  Deleted.' -ForegroundColor Green
  }
  Write-Host ''
}

$plan = @()
foreach ($j in $jobs) {
  Write-Host "  Listing $($j.repo) ..."
  $wc = New-Client
  $tree = $wc.DownloadString("https://huggingface.co/api/models/$($j.repo)/tree/main?recursive=true") | ConvertFrom-Json
  $files = @($tree) | Where-Object { $_.type -eq 'file' }
  foreach ($k in $j.keep) {
    if ($k -ne '*' -and -not ($files | Where-Object { $_.path.StartsWith($k) })) { Write-Host "    warning: nothing found for $k" -ForegroundColor Yellow }
  }
  foreach ($f in $files) {
    $p = $f.path
    $want = $false
    if ($j.keep -contains '*') { $want = $p -ne '.gitattributes' -and $p -notmatch '\.md$' }
    elseif ($p -notmatch '/') { $want = $p -notmatch '\.(md|png|jpg|gif)$' -and $p -ne '.gitattributes' }
    else { foreach ($k in $j.keep) { if ($p.StartsWith($k)) { $want = $true } } }
    if ($want) { $plan += @{ repo = $j.repo; path = $p; size = [int64]$f.size } }
  }
}

$total = [int64]0; foreach ($f in $plan) { $total += $f.size }
Write-Host ("  {0} files, {1:N2} GB total. Already-downloaded files are skipped." -f $plan.Count, ($total / 1GB))
$i = 0; $failed = 0
foreach ($f in $plan) {
  $i++
  $dest = Join-Path $models (("$($f.repo)/resolve/main/$($f.path)") -replace '/', '\')
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $f.size)) { continue }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Write-Host ("  [{0}/{1}] {2}/{3} ({4:N0} MB)" -f $i, $plan.Count, $f.repo, $f.path, ($f.size / 1MB))
  $ok = $false
  foreach ($try in 1..3) {
    try {
      $wc = New-Client
      $wc.DownloadFile("https://huggingface.co/$($f.repo)/resolve/main/$($f.path)", "$dest.part")
      Move-Item -Force "$dest.part" $dest
      $ok = $true; break
    } catch { Write-Host "    retrying ($($_.Exception.Message))" -ForegroundColor Yellow; Start-Sleep -Seconds 3 }
  }
  if (-not $ok) { $failed++; Write-Host '    FAILED' -ForegroundColor Red }
}

Write-Host ''
if ($failed) { Write-Host "  $failed file(s) failed. Run this again to retry just those." -ForegroundColor Red }
else { Write-Host '  All models downloaded. Double-click "Start Roleplay Room.bat" - no internet needed from now on.' -ForegroundColor Green }
Read-Host '  Press Enter to close'
