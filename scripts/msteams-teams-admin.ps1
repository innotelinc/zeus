# ═══════════════════════════════════════════════════════════════════
# Zeus — MS Teams Direct Routing, Teams-admin side
#
# Pairs with pbx/cerulean-msteams.sh: once the SBC is up (DNS + RSA-2048
# cert + Asterisk PJSIP transport/endpoint on 5061), this script finishes
# the tenant side that only Teams admin center / Teams PowerShell can do:
#
#   1. SBC gateway   — New/Set-CsOnlinePSTNGateway (FQDN, SIP port 5061)
#   2. PSTN usage    — Set-CsOnlinePstnUsage @{add=...}
#   3. Voice route   — New/Set-CsOnlineVoiceRoute (number pattern, usage,
#                      gateway list)
#   4. (optional)    — voice routing policy + grant + phone number
#                      assignment for a user (Direct Routing)
#
# MICROSOFT GRAPH NOTE: none of this is exposed in Microsoft Graph — SBC
# gateways, voice routes and PSTN usages are only manageable through the
# Teams PowerShell module (MicrosoftTeams), which is what this script
# drives. Graph is limited to call-record telemetry (monitoring), not
# configuration.
#
# Requirements:
#   - MicrosoftTeams PowerShell module:  Install-Module MicrosoftTeams -Scope CurrentUser -Force
#   - Connected account: Teams Administrator (or Voice Administrator) role
#   - SBC FQDN must match the gateway exactly (teams.zeus.innotel.us)
#
# Usage (run from a machine with pwsh — Windows, macOS, or Linux):
#   ./scripts/msteams-teams-admin.ps1 -Fqdn teams.zeus.innotel.us -TenantId 00000000-0000-0000-0000-000000000000 -WhatIf
#   ./scripts/msteams-teams-admin.ps1 -Fqdn teams.zeus.innotel.us -TenantId 00000000-0000-0000-0000-000000000000
#   # + user enablement (user needs a Teams Phone license):
#   ./scripts/msteams-teams-admin.ps1 -Fqdn teams.zeus.innotel.us -TenantId ... `
#       -VoiceRoutingPolicyName "Zeus Voice" -UserPrincipalName user@zeus.innotel.us `
#       -PhoneNumber +15125550123
#
# Every value falls back to an env var (TEAMS_*), matching the repo's
# pbx.env convention. Idempotent — safe to re-run.
# ═══════════════════════════════════════════════════════════════════

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # SBC FQDN as configured by pbx/cerulean-msteams.sh (must resolve publicly)
    [string]$Fqdn = $env:TEAMS_SBC_FQDN,

    # SIP signaling port the SBC listens on (wizard configures 5061)
    [int]$SipSignalingPort = 5061,

    # Create/enable the gateway (MS default is disabled — we enable it)
    [switch]$EnableGateway,

    # Send SIP OPTIONS keep-alives so Teams marks the SBC Active
    [switch]$SendSipOptions,

    # Media bypass (only if your network is fully routable to Teams media)
    [switch]$MediaBypass,

    # Forward P-Asserted-Identity to the SBC (billing/identity transparency)
    [switch]$ForwardPai,

    # Forward History-Info/Referred-By to the SBC
    [switch]$ForwardCallHistory,

    # Max concurrent sessions (0 = unlimited)
    [int]$MaxConcurrentSessions = 0,

    # Voice route name (global scope; unique per tenant)
    [string]$RouteName = $env:TEAMS_ROUTE_NAME,

    # Regex matching the numbers this route handles (default: US E.164)
    [string]$NumberPattern = $env:TEAMS_NUMBER_PATTERN,

    # PSTN usage string linking the route to the routing policy
    [string]$PstnUsage = $env:TEAMS_PSTN_USAGE,

    # Route priority (lowest wins when multiple routes match)
    [int]$Priority = 0,

    # Optional: voice routing policy to create/grant
    [string]$VoiceRoutingPolicyName = $env:TEAMS_VOICE_ROUTING_POLICY,

    # Optional: user to enable for Direct Routing (needs Teams Phone license)
    [string]$UserPrincipalName = $env:TEAMS_USER_UPN,

    # Optional: phone number to assign (E.164, e.g. +15125550123); when
    # omitted but -UserPrincipalName is set, only Enterprise Voice is enabled
    [string]$PhoneNumber = $env:TEAMS_USER_PHONE,

    # Tenant ID for Connect-MicrosoftTeams (skipped when already connected)
    [string]$TenantId = $env:TEAMS_TENANT_ID
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── defaults (env fallbacks for optional params) ──────────────────────
if (-not $RouteName) { $RouteName = 'Zeus-Direct-Routing' }
if (-not $NumberPattern) { $NumberPattern = '^\+1[2-9]\d{9}$' }
if (-not $PstnUsage) { $PstnUsage = 'Zeus-Direct-Routing' }

function Write-Step([string]$msg) { Write-Host "── $msg ──" -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "  $msg [OK]" }

# ── validation ───────────────────────────────────────────────────────
if (-not $Fqdn) {
    throw "Fqdn is required — pass -Fqdn or set TEAMS_SBC_FQDN (e.g. teams.zeus.innotel.us)"
}
if ($Fqdn -notmatch '\.') {
    throw "Fqdn '$Fqdn' must be a fully qualified domain name containing a dot"
}
try { $null = [regex]::new($NumberPattern) }
catch { throw "NumberPattern '$NumberPattern' is not a valid regex: $($_.Exception.Message)" }

if ($PhoneNumber -and -not $UserPrincipalName) {
    throw "-PhoneNumber requires -UserPrincipalName (assign the number to a user)"
}

# ── connection ───────────────────────────────────────────────────────
Write-Step "Teams connection"
if (-not (Get-Module -Name MicrosoftTeams -ErrorAction SilentlyContinue)) {
    Import-Module MicrosoftTeams -ErrorAction Stop
}
try {
    $null = Get-CsOnlinePSTNGateway -ErrorAction Stop
    Write-OK "already connected to Microsoft Teams"
}
catch {
    $connectArgs = @{}
    if ($TenantId) { $connectArgs.TenantId = $TenantId }
    Write-Host "  connecting to Microsoft Teams (interactive sign-in)..."
    Connect-MicrosoftTeams @connectArgs
    Write-OK "connected"
}

# ── 1. SBC gateway (idempotent create/update) ────────────────────────
Write-Step "SBC gateway: $Fqdn : $SipSignalingPort"
$gatewayParams = @{
    Fqdn                 = $Fqdn
    SipSignalingPort     = $SipSignalingPort
    Enabled              = [bool]$EnableGateway
    SendSipOptions       = [bool]$SendSipOptions
    MediaBypass          = [bool]$MediaBypass
    ForwardPai           = [bool]$ForwardPai
    ForwardCallHistory   = [bool]$ForwardCallHistory
    MaxConcurrentSessions = $MaxConcurrentSessions
    Description          = "Zeus MS Teams Direct Routing SBC (cerulean-msteams)"
}
$existingGateway = Get-CsOnlinePSTNGateway -Identity $Fqdn -ErrorAction SilentlyContinue
if ($existingGateway) {
    Write-Host "  gateway exists — updating"
    Set-CsOnlinePSTNGateway @gatewayParams
} else {
    Write-Host "  gateway does not exist — creating (enabled: $EnableGateway)"
    New-CsOnlinePSTNGateway @gatewayParams
}
Write-OK "gateway $Fqdn configured (SIP $SipSignalingPort)"

# ── 2. PSTN usage (idempotent add) ───────────────────────────────────
Write-Step "PSTN usage: $PstnUsage"
$usages = @((Get-CsOnlinePstnUsage).Usage)
if ($usages -contains $PstnUsage) {
    Write-OK "usage '$PstnUsage' already present"
} else {
    Set-CsOnlinePstnUsage -Identity global -Usage @{ add = $PstnUsage }
    Write-OK "usage '$PstnUsage' added"
}

# ── 3. Voice route (idempotent create/update) ────────────────────────
Write-Step "Voice route: $RouteName"
$routeParams = @{
    Identity          = $RouteName
    NumberPattern     = $NumberPattern
    OnlinePstnUsages  = @{ add = $PstnUsage }
    OnlinePstnGatewayList = @{ replace = $Fqdn }
    Priority          = $Priority
    Description       = "Zeus Direct Routing via $Fqdn (pattern $NumberPattern)"
}
$existingRoute = Get-CsOnlineVoiceRoute -Identity $RouteName -ErrorAction SilentlyContinue
if ($existingRoute) {
    Write-Host "  route exists — updating pattern/gateway/priority"
    Set-CsOnlineVoiceRoute @routeParams
} else {
    Write-Host "  route does not exist — creating"
    New-CsOnlineVoiceRoute @routeParams
}
Write-OK "route '$RouteName' → $Fqdn (pattern $NumberPattern)"

# ── 4. Optional: routing policy + user enablement ────────────────────
if ($VoiceRoutingPolicyName) {
    Write-Step "Voice routing policy: $VoiceRoutingPolicyName"
    $policyParams = @{
        Identity         = $VoiceRoutingPolicyName
        OnlinePstnUsages = @{ add = $PstnUsage }
    }
    $existingPolicy = Get-CsOnlineVoiceRoutingPolicy -Identity $VoiceRoutingPolicyName -ErrorAction SilentlyContinue
    if ($existingPolicy) {
        Write-Host "  policy exists — adding usage"
        Set-CsOnlineVoiceRoutingPolicy @policyParams
    } else {
        Write-Host "  policy does not exist — creating"
        New-CsOnlineVoiceRoutingPolicy @policyParams
    }
    Write-OK "policy '$VoiceRoutingPolicyName' ready"
}

if ($UserPrincipalName) {
    Write-Step "User: $UserPrincipalName"
    if ($PhoneNumber) {
        # Assigning a Direct Routing number auto-enables Enterprise Voice
        Set-CsPhoneNumberAssignment -Identity $UserPrincipalName -PhoneNumber $PhoneNumber -PhoneNumberType DirectRouting
        Write-OK "phone $PhoneNumber assigned (Direct Routing, Enterprise Voice enabled)"
    } else {
        Set-CsPhoneNumberAssignment -Identity $UserPrincipalName -EnterpriseVoiceEnabled $true
        Write-OK "Enterprise Voice enabled"
    }
    if ($VoiceRoutingPolicyName) {
        Grant-CsOnlineVoiceRoutingPolicy -Identity $UserPrincipalName -PolicyName $VoiceRoutingPolicyName
        Write-OK "voice routing policy '$VoiceRoutingPolicyName' granted"
    }
}

# ── summary ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host " MS Teams Direct Routing — tenant side configured"
Write-Host "   Gateway : $Fqdn : $SipSignalingPort"
Write-Host "   Usage   : $PstnUsage"
Write-Host "   Route   : $RouteName (priority $Priority)"
if ($VoiceRoutingPolicyName) { Write-Host "   Policy  : $VoiceRoutingPolicyName" }
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host ""
Write-Host "Next: the SBC must complete a SIP OPTIONS handshake on 5061/tcp to"
Write-Host "show 'Active' in Teams admin center → Voice → Direct Routing. Verify"
Write-Host "5061 is open from Microsoft's SIP ranges, then test a call."