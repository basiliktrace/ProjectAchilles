<#
.SYNOPSIS
    End-to-end test of scripts/Install-ProjectAchilles.ps1.

.DESCRIPTION
    Runs the real installer, unmodified, through all ten phases against a
    throwaway fake repository in the temp directory. git, docker, the HTTP
    health check and Read-Host are replaced by global functions: PowerShell
    runs a function in preference to a cmdlet or an .exe of the same name, so
    nothing is installed, built or started, and the prompts are answered from
    a script.

    Run it under both Windows PowerShell 5.1 (powershell.exe) and PowerShell 7
    (pwsh). The installer has to work on 5.1, which ships with Windows, and
    5.1-only breakage (e.g. a three-argument Join-Path) does not show up
    under pwsh. CI: .github/workflows/windows-installer.yml.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-WindowsInstaller.ps1
#>
param(
    [string]$Installer = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Install-ProjectAchilles.ps1'),
    [string]$EnvExample = (Join-Path (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'backend') '.env.example')
)
$ErrorActionPreference = 'Stop'
"PowerShell $($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition)"

$script:fail = 0
function Check($name, [bool]$ok) { if ($ok) { "  PASS $name" } else { "  FAIL $name"; $script:fail = 1 } }

# ---- static checks ------------------------------------------------------------
# Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252. A UTF-8
# character such as an em dash then decodes to bytes that include 0x94, which
# PowerShell treats as a closing quote mark.
""
"== static"
$bytes = [IO.File]::ReadAllBytes($Installer)
$nonAscii = @($bytes | Where-Object { $_ -gt 0x7F }).Count
Check 'installer is pure ASCII' ($nonAscii -eq 0)
$tokens = $null; $parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
Check 'installer parses' ($parseErrors.Count -eq 0)
foreach ($e in $parseErrors) { "     | line $($e.Extent.StartLineNumber): $($e.Message)" }

# ---- mocks ------------------------------------------------------------------
$global:Answers = New-Object System.Collections.Queue
$global:DockerCalls = New-Object System.Collections.ArrayList
function global:Read-Host {
    param([Parameter(Position = 0)][string]$Prompt, [switch]$AsSecureString)
    if ($global:Answers.Count -eq 0) { throw "unscripted prompt: $Prompt" }
    $a = [string]$global:Answers.Dequeue()
    if ($AsSecureString) { return (ConvertTo-SecureString $a -AsPlainText -Force) }
    return $a
}
function global:git { $global:LASTEXITCODE = 0; 'git version 2.47.0.windows.1 (mock)' }
function global:docker {
    [void]$global:DockerCalls.Add(($args -join ' '))
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { 'Docker version 27.3.1 (mock)' }
    elseif ($args[0] -eq 'compose' -and $args[1] -eq 'version') { 'Docker Compose version v2.29.7 (mock)' }
}
function global:Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
function global:Clear-Host { }   # no console in CI or over ssh

# ---- helpers ----------------------------------------------------------------
function Bytes($p) { [IO.File]::ReadAllBytes($p) }
function HasBom($p) { $b = Bytes $p; $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF }
function HasCR($p) { (Bytes $p) -contains 13 }
function EnvMap($p) {
    $m = @{}
    foreach ($l in [IO.File]::ReadAllLines($p)) {
        if ($l -match '^([A-Z_]+)=(.*)$') { $m[$Matches[1]] = $Matches[2] }
    }
    $m
}
$crlf = "#!/bin/sh`r`necho hi`r`n"

$root = Join-Path ([IO.Path]::GetTempPath()) ('pa-installer-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'backend') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'frontend') | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'docker-compose.yml'), "services: {}`n")
Copy-Item $EnvExample (Join-Path (Join-Path $root 'backend') '.env.example')
[IO.File]::WriteAllText((Join-Path (Join-Path $root 'frontend') 'docker-entrypoint.sh'), $crlf)
[IO.File]::WriteAllText((Join-Path $root 'start.sh'), $crlf)
$backendEnv = Join-Path (Join-Path $root 'backend') '.env'
$rootEnv = Join-Path $root '.env'

function Invoke-Installer([string]$name, [string[]]$answers, [hashtable]$params) {
    $global:Answers.Clear(); foreach ($a in $answers) { $global:Answers.Enqueue($a) }
    $global:DockerCalls.Clear()
    $log = Join-Path $root "$name.log"
    Push-Location $root
    try {
        $global:LASTEXITCODE = 0
        & $Installer -NoOpen @params *> $log
        $code = $LASTEXITCODE
    }
    catch {
        $code = "threw: $($_.Exception.Message)"
    }
    finally { Pop-Location }
    ""
    "== scenario: $name (exit $code)"
    Check 'installer exits 0' ($code -eq 0)
    if ($code -ne 0 -and (Test-Path $log)) { Get-Content $log | Select-Object -Last 8 | ForEach-Object { "     | $_" } }
    Check 'all scripted answers consumed' ($global:Answers.Count -eq 0)
}

$pub = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k'

# 1. Fresh install, every prompt answered, Elasticsearch skipped (the default).
Invoke-Installer 'fresh' @($pub, 'sk_test_fresh', '', '', 'n') @{}
if (Test-Path $backendEnv) {
    $b = EnvMap $backendEnv
    Check 'backend/.env has the publishable key' ($b['CLERK_PUBLISHABLE_KEY'] -eq $pub)
    Check 'backend/.env has the secret key' ($b['CLERK_SECRET_KEY'] -eq 'sk_test_fresh')
    Check 'secrets generated' ($b['SESSION_SECRET'].Length -ge 40 -and $b['ENCRYPTION_SECRET'].Length -ge 40)
    Check 'TESTS_REPO_URL is the real library' ($b['TESTS_REPO_URL'] -eq 'https://github.com/ubercylon8/f0_library.git')
    Check 'backend/.env has no BOM' (-not (HasBom $backendEnv))
    # No CR check here: backend/.env starts as a copy of .env.example, which a
    # default Git for Windows clone (core.autocrlf=true) checks out as CRLF.
    # That is harmless: Docker Compose's env_file parser strips the CRs.
}
else { Check 'backend/.env written' $false }
if (Test-Path $rootEnv) {
    Check 'root .env key = backend key' ((EnvMap $rootEnv)['CLERK_PUBLISHABLE_KEY'] -eq $pub)
    Check 'root .env has no BOM' (-not (HasBom $rootEnv))
    Check 'root .env has no CR' (-not (HasCR $rootEnv))
}
else { Check 'root .env written' $false }
Check 'entrypoint CRLF fixed' (-not (HasCR (Join-Path (Join-Path $root 'frontend') 'docker-entrypoint.sh')))
Check 'root *.sh CRLF fixed' (-not (HasCR (Join-Path $root 'start.sh')))
Check 'docker compose up -d --build called' ($global:DockerCalls -contains 'compose up -d --build')

# 2. Re-run and keep the existing config (the menu default).
Remove-Item $rootEnv -ErrorAction SilentlyContinue
Invoke-Installer 'keep' @('') @{}
Check 'keep: root .env re-created with the key' ((Test-Path $rootEnv) -and (EnvMap $rootEnv)['CLERK_PUBLISHABLE_KEY'] -eq $pub)
Check 'keep: docker compose up called, no ES profile' ($global:DockerCalls -contains 'compose up -d --build')

# 3. Reconfigure: keep the publishable key, new secret, local Elasticsearch.
if (-not (Test-Path $backendEnv)) { 'ABORT: no backend/.env, later scenarios need it'; 'RESULT: FAIL'; exit 1 }
$secretBefore = (EnvMap $backendEnv)['SESSION_SECRET']
Invoke-Installer 'reconfigure' @('2', '', 'sk_test_new', '1', '', 'n') @{}
$b = EnvMap $backendEnv
Check 'reconfigure: pub key kept' ($b['CLERK_PUBLISHABLE_KEY'] -eq $pub)
Check 'reconfigure: secret updated' ($b['CLERK_SECRET_KEY'] -eq 'sk_test_new')
Check 'reconfigure: SESSION_SECRET kept' ($b['SESSION_SECRET'] -eq $secretBefore)
Check 'reconfigure: local ES node' ($b['ELASTICSEARCH_NODE'] -eq 'http://elasticsearch:9200')
Check 'reconfigure: compose with ES profile' ($global:DockerCalls -contains 'compose --profile elasticsearch up -d --build')

# 4. Re-run after choosing local Elasticsearch and keep: ES must still start.
Invoke-Installer 'keep-local-es' @('') @{}
Check 'keep-local-es: compose with ES profile' ($global:DockerCalls -contains 'compose --profile elasticsearch up -d --build')

# 5. -Quick with the keys as parameters and -Force: no prompts at all.
Invoke-Installer 'quick-force' @() @{ Quick = $true; Force = $true; ClerkPublishableKey = 'pk_test_quick'; ClerkSecretKey = 'sk_test_quick' }
Check 'quick: root .env key updated' ((EnvMap $rootEnv)['CLERK_PUBLISHABLE_KEY'] -eq 'pk_test_quick')
Check 'quick: backup of previous backend/.env made' (@(Get-ChildItem (Join-Path $root 'backend') -Filter '.env.backup.*' -Force).Count -ge 1)

""
if ($script:fail) {
    "logs and fake repo kept for inspection: $root"
    'RESULT: FAIL'
}
else {
    Remove-Item $root -Recurse -Force
    'RESULT: PASS'
}
exit $script:fail
