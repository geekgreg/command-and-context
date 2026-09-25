# Shared launcher for headless Edge runs (screenshots, DOM dumps). Dot-sourced by shot.ps1 and dom.ps1.
#
# Headless Edge renders WebGL in software (SwiftShader) on the CPU, which can swamp the whole machine,
# especially when several agents do it at once. Every run therefore:
#   - waits its turn: only ONE headless browser at a time, machine-wide (named mutex)
#   - runs inside a Windows Job Object: below-normal priority, CPU hard-capped, and every process in it is
#     killed when this script exits, even if the script itself is killed (no orphaned browsers)
#   - has a hard timeout
#   - first sweeps up leftovers from older runs (only our own cnc-* temp profiles, never your normal browser)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CncJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IOC { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)]
    struct CPU { public uint ControlFlags; public uint CpuRate; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, int len);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CPU info, int len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [StructLayout(LayoutKind.Sequential)]
    struct ACCT { public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCT info, int len, IntPtr ret);
    static IntPtr job;
    // Processes currently alive in the job, this PowerShell included (-1 if not confined).
    public static int Active() {
        if (job == IntPtr.Zero) return -1;
        ACCT a;
        return QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero) ? (int)a.ActiveProcesses : -1;
    }
    // Put this process (and therefore every process it starts) in a job: kill-on-close, below-normal
    // priority, and a hard cap of cpuPercent of the whole machine. Returns a note about what applied.
    public static string Confine(int cpuPercent) {
        if (job != IntPtr.Zero) return "already confined";
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return "no job object";
        var ext = new EXT();
        ext.Basic.LimitFlags = 0x2000 | 0x20;          // KILL_ON_JOB_CLOSE | PRIORITY_CLASS
        ext.Basic.PriorityClass = 0x4000;               // BELOW_NORMAL_PRIORITY_CLASS
        bool limits = SetInformationJobObject(job, 9, ref ext, Marshal.SizeOf(typeof(EXT)));
        var cpu = new CPU { ControlFlags = 0x1 | 0x4, CpuRate = (uint)(Math.Max(5, Math.Min(100, cpuPercent)) * 100) };   // ENABLE | HARD_CAP
        bool capped = SetInformationJobObject(job, 15, ref cpu, Marshal.SizeOf(typeof(CPU)));
        bool assigned = AssignProcessToJobObject(job, GetCurrentProcess());
        return "limits=" + limits + " cpuCap=" + capped + " assigned=" + assigned;
    }
}
'@

# Chrome first: Edge quietly signs every new profile (even a throwaway one) into the Windows user's
# Microsoft account. Edge is only the fallback, and it runs InPrivate with sync disabled.
function Get-CncEdgePath {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# Kill browsers left behind by earlier runs. Only matches our own throwaway profiles (cnc-shot-*, cnc-dom-*,
# cnc-cdp-*, cnc-dump-*), so a normal Edge window or another tool's browser is never touched.
function Clear-CncHeadlessLeftovers {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '[\\/]cnc-(shot|dom|cdp|dump)-' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction Stop } catch { } }
  Get-ChildItem $env:TEMP -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^cnc-(shot|dom|cdp|dump)-' -and $_.LastWriteTime -lt (Get-Date).AddMinutes(-2) } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue }
}

# Run headless Edge once with the given extra arguments (the URL last). Returns stdout if -CaptureStdout.
function Invoke-CncHeadless {
  param(
    [Parameter(Mandatory = $true)][string[]]$EdgeArgs,
    [string]$Kind = 'shot',
    [int]$Width = 1280,
    [int]$Height = 720,
    [int]$TimeoutSec = 180,
    [int]$CpuPercent = 25,
    [switch]$CaptureStdout,
    [switch]$KeepProfile          # debugging only: leave the temp profile for inspection
  )
  $edge = Get-CncEdgePath
  if (-not $edge) { throw 'No Edge or Chrome found' }

  $mutex = New-Object System.Threading.Mutex($false, 'CncHeadlessEdge')
  $got = $false
  try { $got = $mutex.WaitOne([TimeSpan]::FromMinutes(10)) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  if (-not $got) { throw 'Another headless render has held the lock for 10+ minutes; try again later.' }
  $profileDir = Join-Path $env:TEMP ("cnc-$Kind-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    Clear-CncHeadlessLeftovers
    $note = [CncJob]::Confine($CpuPercent)
    if ($note -notmatch 'assigned=True') { Write-Warning "headless: could not fully confine the browser ($note)" }

    # --inprivate: a throwaway profile must never sign in to the user's Microsoft account or start syncing
    # (Edge otherwise copies synced bookmarks/extensions into it). --edge-skip-compat-layer-relaunch: Edge
    # otherwise relaunches itself at startup, so the process we started isn't the browser that keeps running.
    $base = @(
      '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--renderer-process-limit=1',
      '--edge-skip-compat-layer-relaunch', '--inprivate', '--incognito',
      "--window-size=$Width,$Height", "--user-data-dir=$profileDir"
    )
    $quote = { param($a) if ($a -match '[\s&"^|<>]') { '"' + ($a -replace '"', '\"') + '"' } else { $a } }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $edge
    $psi.Arguments = (($base + $EdgeArgs) | ForEach-Object { & $quote $_ }) -join ' '
    $psi.UseShellExecute = $false                      # CreateProcess from this process, so the job applies
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = [bool]$CaptureStdout
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $outTask = if ($CaptureStdout) { $p.StandardOutput.ReadToEndAsync() } else { $null }
    # Done means the launched process AND everything else in the job has exited (if Edge still relaunched
    # itself, the process we started is only a launcher). This script is the one expected survivor.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $null = $p.WaitForExit($TimeoutSec * 1000)
    while ([CncJob]::Active() -gt 1 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (-not $p.HasExited -or [CncJob]::Active() -gt 1) {
      try { $p.Kill() } catch { }
      Clear-CncHeadlessLeftovers
      throw "headless run timed out after $TimeoutSec s (browser killed)"
    }
    if ($outTask) { return $outTask.Result }
  } finally {
    Clear-CncHeadlessLeftovers
    if (-not $KeepProfile) { Remove-Item $profileDir -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue }
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
  }
}
