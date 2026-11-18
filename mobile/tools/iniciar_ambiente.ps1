<#
.SYNOPSIS
  Reinicia Django + NestJS + Expo (sempre em modo túnel) do zero e mostra
  o QR code direto no terminal — não depende de qual rede Wi-Fi o PC ou o
  celular estão usando, nem se são a mesma rede.

  Por que sempre túnel, nunca LAN: já vimos nesta rede (e em outras
  parecidas) isolamento de clientes no Wi-Fi (AP isolation), bloqueio de
  porta pro firewall, e mudança de IP a cada troca de rede — todos
  problemas que o modo túnel (ngrok, com o backend acessível via proxy
  dentro do próprio Metro em /api-proxy) simplesmente não tem, porque tudo
  passa pela internet, não pela rede local. O único custo é a URL do túnel
  mudar a cada reinício deste script (a conta ngrok configurada já garante
  um domínio fixo entre reinícios, então nem isso costuma mudar).

.USAGE
  Rode este script sempre que trocar de rede, reiniciar o PC, ou se os
  serviços pararem de responder por qualquer motivo:

      powershell -ExecutionPolicy Bypass -File "mobile\tools\iniciar_ambiente.ps1"
#>

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
$raiz = (Resolve-Path "$PSScriptRoot\..\..").Path

Write-Host "== Parando processos antigos ==" -ForegroundColor Yellow
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'expo|nest|sync-backend' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='ngrok.exe'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'manage\.py.*runserver' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

Write-Host "== Iniciando Django (0.0.0.0:8000) ==" -ForegroundColor Yellow
Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "Set-Location '$raiz\Controladoria'; `$py = if (Test-Path .venv\Scripts\python.exe) { '.venv\Scripts\python.exe' } else { 'python' }; & `$py manage.py runserver 0.0.0.0:8000"
)

Write-Host "== Iniciando NestJS (0.0.0.0:3333) ==" -ForegroundColor Yellow
Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "Set-Location '$raiz\mobile\sync-backend'; npm run start:dev"
)

Write-Host "Aguardando o NestJS subir..." -ForegroundColor DarkGray
$nestOk = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $conexao = Get-NetTCPConnection -LocalPort 3333 -State Listen -ErrorAction SilentlyContinue
  if ($conexao) { $nestOk = $true; break }
}
if (-not $nestOk) {
  Write-Host "AVISO: NestJS não confirmou porta 3333 a tempo — confira a janela dele." -ForegroundColor Red
}

Write-Host "== Iniciando Expo (modo túnel) ==" -ForegroundColor Yellow
$expoLog = "$env:TEMP\expo_iniciar_ambiente.log"
Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "Set-Location '$raiz\mobile\app'; npx expo start --tunnel 2>&1 | Tee-Object -FilePath '$expoLog'"
)

Write-Host "Aguardando o túnel do Expo conectar (pode levar até 1 minuto)..." -ForegroundColor DarkGray
$hostUri = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $manifesto = Invoke-RestMethod -Uri "http://localhost:8081/" -TimeoutSec 3 -ErrorAction Stop
    $candidato = $manifesto.extra.expoClient.hostUri
    if ($candidato -and $candidato -notmatch '^(127\.0\.0\.1|localhost)') {
      $hostUri = $candidato
      break
    }
  } catch {}
}

if (-not $hostUri) {
  Write-Host ""
  Write-Host "O túnel não conectou a tempo. Últimas linhas do log do Expo:" -ForegroundColor Red
  if (Test-Path $expoLog) { Get-Content $expoLog -Tail 15 }
  Write-Host ""
  Write-Host "Se aparecer 'ngrok tunnel took too long to connect', só rode este" -ForegroundColor Red
  Write-Host "script de novo (é instabilidade transitória, já vimos acontecer antes)." -ForegroundColor Red
  exit 1
}

$expUrl = "exp://$hostUri"
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " Pronto! Escaneie no Expo Go:" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
# Usa o venv do Django se existir (é onde o `qrcode` está instalado).
$pyQr = if (Test-Path "$raiz\Controladoria\.venv\Scripts\python.exe") { "$raiz\Controladoria\.venv\Scripts\python.exe" } else { 'python' }
& $pyQr "$raiz\mobile\tools\print_qr.py" $expUrl
Write-Host ""
Write-Host "Backend acessível via proxy do Metro em: https://$hostUri/api-proxy" -ForegroundColor DarkGray
