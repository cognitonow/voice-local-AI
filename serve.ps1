# Roleplay Room local server. Uses only what's built into Windows; nothing to install.
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.wasm' = 'application/wasm'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.md' = 'text/plain; charset=utf-8'
  '.vrm' = 'application/octet-stream'; '.glb' = 'model/gltf-binary'
}

$listener = $null; $port = $null
foreach ($p in 8080..8099) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host 'Could not open a local port (8080-8099).'; Read-Host 'Press Enter to close'; exit 1 }

$url = "http://localhost:$port/"
Write-Host ''
Write-Host "  Roleplay Room is running at $url"
Write-Host '  Keep this window open while you use it. Close it to stop.'
Write-Host ''
if ($env:RR_NO_BROWSER -ne '1') { Start-Process $url }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))
    $charRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($root, 'characters'))
    # Saving / deleting recorded voice lines: only characters/<id>/voice/<name>.wav, nothing else.
    if ($req.HttpMethod -eq 'PUT' -or $req.HttpMethod -eq 'DELETE') {
      $okPath = $rel -match '^characters/[A-Za-z0-9_-]+/voice/[A-Za-z0-9_.-]+\.wav$' -and $full.StartsWith($charRoot, [StringComparison]::OrdinalIgnoreCase)
      # A new character: characters/<id>/character.md may be created, never overwritten or deleted.
      $newChar = $req.HttpMethod -eq 'PUT' -and $rel -match '^characters/[a-z0-9][a-z0-9_-]{0,40}/character\.md$' -and $full.StartsWith($charRoot, [StringComparison]::OrdinalIgnoreCase)
      if ($newChar) {
        if ([IO.File]::Exists($full)) { $res.StatusCode = 409 }
        elseif ($req.ContentLength64 -gt 1MB) { $res.StatusCode = 413 }
        else {
          [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full)) | Out-Null
          $fs = [IO.File]::Create($full)
          try { $req.InputStream.CopyTo($fs) } finally { $fs.Dispose() }
          $res.StatusCode = 201
        }
      }
      elseif (-not $okPath) { $res.StatusCode = 403 }
      elseif ($req.HttpMethod -eq 'DELETE') {
        if ([IO.File]::Exists($full)) { [IO.File]::Delete($full); $res.StatusCode = 200 } else { $res.StatusCode = 404 }
      } else {
        if ($req.ContentLength64 -gt 50MB) { $res.StatusCode = 413 }
        else {
          [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full)) | Out-Null
          $tmp = "$full.part"
          $fs = [IO.File]::Create($tmp)
          try { $req.InputStream.CopyTo($fs) } finally { $fs.Dispose() }
          Move-Item -LiteralPath $tmp -Destination $full -Force
          $res.StatusCode = 200
        }
      }
    }
    elseif ($full.TrimEnd('\','/').StartsWith($charRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Directory]::Exists($full)) {
      # Folder listing for the character loader: {"files":["mabel.md", ...]}
      $names = @(Get-ChildItem -LiteralPath $full -File | ForEach-Object { $_.Name })
      $dirs = @(Get-ChildItem -LiteralPath $full -Directory | ForEach-Object { $_.Name })
      $q = { param($x) '"' + ($x -replace '\\','\\' -replace '"','\"') + '"' }
      $json = '{"files":[' + (($names | ForEach-Object { & $q $_ }) -join ',') + '],"dirs":[' + (($dirs | ForEach-Object { & $q $_ }) -join ',') + ']}'
      $bytes = [Text.Encoding]::UTF8.GetBytes($json)
      $res.ContentType = 'application/json; charset=utf-8'
      $res.Headers.Add('Cache-Control', 'no-cache'); $res.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin'); $res.Headers.Add('Cross-Origin-Embedder-Policy', 'require-corp'); $res.Headers.Add('Cross-Origin-Resource-Policy', 'same-origin')
      $res.ContentLength64 = $bytes.Length
      if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    }
    elseif (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($full)) {
      $res.StatusCode = 404
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
      $res.Headers.Add('Cache-Control', 'no-cache'); $res.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin'); $res.Headers.Add('Cross-Origin-Embedder-Policy', 'require-corp'); $res.Headers.Add('Cross-Origin-Resource-Policy', 'same-origin')
      $fs = [IO.File]::OpenRead($full)
      try {
        $res.ContentLength64 = $fs.Length
        if ($req.HttpMethod -ne 'HEAD') { $fs.CopyTo($res.OutputStream, 1048576) }
      } finally { $fs.Dispose() }
    }
  } catch {
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.Close() } catch { }
  }
}
