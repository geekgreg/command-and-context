# Command & Context - Windows system probe.
#
# A long-lived helper spawned by server/system.js. It compiles a small C# class once, then answers
# one request per line on stdin with one JSON line on stdout:
#
#   request:  snap #<request id> <comma-separated extra pids to inspect>
#   response: {"id":..,"t":..,"cpu":..,"mem":..,"tcpOk":..,"tcp6Ok":..,"procs":[[pid,ppid,"name"],..],"info":{..},"listen":[..],"est":[..]}
#
# The id is echoed back so replies can be paired with requests (a request without one gets a reply
# without one). tcpOk / tcp6Ok are false when the IPv4 / IPv6 TCP table could not be read: its listeners
# and connections are then unknown, not absent.
#
# Everything comes from cheap native calls (toolhelp snapshot, GetExtendedTcpTable, GetProcessTimes)
# instead of WMI, so polling every couple of seconds costs a few milliseconds. Command lines and
# working directories are read from the PEB, but only for dev-tool processes (node, python, bash,
# claude, ...) and descendants of Claude sessions. System processes are never opened.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CncProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PBI
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    class MEMSTAT
    {
        public uint dwLength = 64;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [DllImport("kernel32.dll")] static extern bool GetProcessIoCounters(IntPtr h, out IO_COUNTERS c);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, uint reserved);
    [DllImport("kernel32.dll")] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In, Out] MEMSTAT m);

    const long EPOCH_FT = 116444736000000000L;

    // Processes whose command line / working directory we are willing to read.
    static readonly HashSet<string> DeepNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "node.exe", "bun.exe", "deno.exe", "python.exe", "python3.exe", "pythonw.exe", "py.exe", "uv.exe",
        "php.exe", "php-cgi.exe", "ruby.exe", "rails.exe", "puma.exe", "java.exe", "javaw.exe", "dotnet.exe",
        "go.exe", "air.exe", "cargo.exe", "nginx.exe", "httpd.exe", "caddy.exe", "postgres.exe", "pg_ctl.exe",
        "redis-server.exe", "mongod.exe", "mysqld.exe", "mariadbd.exe", "hugo.exe", "esbuild.exe", "workerd.exe",
        "wrangler.exe", "uvicorn.exe", "gunicorn.exe", "flask.exe", "bash.exe", "sh.exe", "zsh.exe",
        "pwsh.exe", "powershell.exe", "cmd.exe", "claude.exe", "wslrelay.exe", "com.docker.backend.exe",
        "docker.exe", "ollama.exe", "ollama app.exe", "lmstudio.exe", "streamlit.exe", "jupyter.exe", "jupyter-lab.exe"
    };

    // Never touched, whatever else happens.
    static readonly HashSet<string> Denied = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
        "lsaiso.exe", "svchost.exe", "spoolsv.exe", "msmpeng.exe", "memory compression", "secure system", "fontdrvhost.exe"
    };

    class Info { public long Created; public long Cpu; public long Io; public string Cmd; public string Cwd; public bool CmdTried; }
    static readonly Dictionary<string, Info> cache = new Dictionary<string, Info>();
    static long lastIdle, lastKernel, lastUser;

    static IntPtr ReadPtr(IntPtr h, IntPtr addr)
    {
        var b = new byte[8]; IntPtr r;
        if (!ReadProcessMemory(h, addr, b, (IntPtr)8, out r)) return IntPtr.Zero;
        return (IntPtr)BitConverter.ToInt64(b, 0);
    }

    static string ReadUnicodeString(IntPtr h, IntPtr addr, int max)
    {
        var us = new byte[16]; IntPtr r;
        if (!ReadProcessMemory(h, addr, us, (IntPtr)16, out r)) return null;
        int len = BitConverter.ToUInt16(us, 0);
        IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
        if (len <= 0 || buf == IntPtr.Zero) return null;
        if (len > max) len = max;
        var sb = new byte[len];
        if (!ReadProcessMemory(h, buf, sb, (IntPtr)len, out r)) return null;
        return Encoding.Unicode.GetString(sb);
    }

    static void ReadPeb(IntPtr h, Info info, bool wantCmd)
    {
        bool wow;
        if (IsWow64Process(h, out wow) && wow) return; // 32-bit targets keep a separate PEB; skip them.
        var pbi = new PBI(); int ret;
        if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return;
        IntPtr pp = ReadPtr(h, pbi.PebBaseAddress + 0x20);
        if (pp == IntPtr.Zero) return;
        string cwd = ReadUnicodeString(h, pp + 0x38, 2048);
        if (cwd != null) info.Cwd = cwd;
        if (wantCmd) info.Cmd = ReadUnicodeString(h, pp + 0x70, 8192);
    }

    static Info Inspect(uint pid)
    {
        IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);            // QUERY_INFORMATION | VM_READ
        bool canRead = h != IntPtr.Zero;
        if (!canRead) h = OpenProcess(0x1000, false, pid);                 // QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return null;
        try
        {
            long c, e, k, u;
            if (!GetProcessTimes(h, out c, out e, out k, out u)) return null;
            string key = pid + ":" + c;
            Info info;
            if (!cache.TryGetValue(key, out info))
            {
                info = new Info();
                info.Created = (c - EPOCH_FT) / 10000;
                cache[key] = info;
            }
            info.Cpu = (k + u) / 10000;
            // I/O bytes (sockets included): a tiny page load barely moves CPU but always moves these.
            IO_COUNTERS io;
            if (GetProcessIoCounters(h, out io)) info.Io = (long)(io.ReadBytes + io.WriteBytes + io.OtherBytes);
            if (canRead)
            {
                bool wantCmd = !info.CmdTried;
                info.CmdTried = true;
                try { ReadPeb(h, info, wantCmd); } catch { }
            }
            return info;
        }
        finally { CloseHandle(h); }
    }

    static void Esc(StringBuilder sb, string s)
    {
        if (s == null) { sb.Append("null"); return; }
        sb.Append('"');
        foreach (char ch in s)
        {
            if (ch == '"') sb.Append("\\\"");
            else if (ch == '\\') sb.Append("\\\\");
            else if (ch < 0x20 || ch > 0x7e) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        sb.Append('"');
    }

    struct TcpRow { public string Addr; public int LocalPort; public int RemotePort; public int State; public uint Pid; }

    static int Port(uint raw) { return (int)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF)); }

    // null when the table could not be read: the caller reports that as "unknown", never as "no ports".
    static List<TcpRow> ReadTcp(int af)
    {
        var rows = new List<TcpRow>();
        int size = 0;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 5, 0);
            size += 4096;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                uint rc = GetExtendedTcpTable(buf, ref size, false, af, 5, 0);
                if (rc == 122) continue; // grew between calls
                if (rc != 0) return null;
                int n = Marshal.ReadInt32(buf);
                int rowSize = af == 2 ? 24 : 56;
                for (int i = 0; i < n; i++)
                {
                    IntPtr row = buf + 4 + i * rowSize;
                    var t = new TcpRow();
                    if (af == 2)
                    {
                        t.State = Marshal.ReadInt32(row, 0);
                        var a = new byte[4]; Marshal.Copy(row + 4, a, 0, 4);
                        t.Addr = new System.Net.IPAddress(a).ToString();
                        t.LocalPort = Port((uint)Marshal.ReadInt32(row, 8));
                        t.RemotePort = Port((uint)Marshal.ReadInt32(row, 16));
                        t.Pid = (uint)Marshal.ReadInt32(row, 20);
                    }
                    else
                    {
                        var a = new byte[16]; Marshal.Copy(row, a, 0, 16);
                        t.Addr = new System.Net.IPAddress(a).ToString();
                        t.LocalPort = Port((uint)Marshal.ReadInt32(row, 20));
                        t.RemotePort = Port((uint)Marshal.ReadInt32(row, 44));
                        t.State = Marshal.ReadInt32(row, 48);
                        t.Pid = (uint)Marshal.ReadInt32(row, 52);
                    }
                    rows.Add(t);
                }
                return rows;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        return null;
    }

    public static string Snapshot(int[] extraPids)
    {
        var sb = new StringBuilder(64 * 1024);
        long now = (DateTime.UtcNow.ToFileTimeUtc() - EPOCH_FT) / 10000;

        // --- processes
        var ppid = new Dictionary<uint, uint>();
        var names = new Dictionary<uint, string>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        if (snap != (IntPtr)(-1))
        {
            try
            {
                var e = new PROCESSENTRY32W();
                e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                if (Process32FirstW(snap, ref e))
                {
                    do { ppid[e.th32ProcessID] = e.th32ParentProcessID; names[e.th32ProcessID] = e.szExeFile; }
                    while (Process32NextW(snap, ref e));
                }
            }
            finally { CloseHandle(snap); }
        }
        var children = new Dictionary<uint, List<uint>>();
        foreach (var kv in ppid)
        {
            List<uint> l;
            if (!children.TryGetValue(kv.Value, out l)) { l = new List<uint>(); children[kv.Value] = l; }
            l.Add(kv.Key);
        }

        // --- tcp
        var tcp = ReadTcp(2);
        var tcp6 = ReadTcp(23);
        bool tcpOk = tcp != null, tcp6Ok = tcp6 != null;
        if (tcp == null) tcp = new List<TcpRow>();
        if (tcp6 != null) tcp.AddRange(tcp6);
        var listenKeys = new HashSet<string>();
        var listeners = new List<TcpRow>();
        var listenPorts = new HashSet<int>();
        foreach (var t in tcp)
        {
            if (t.State != 2) continue;
            if (listenKeys.Add(t.Addr + "|" + t.LocalPort + "|" + t.Pid)) { listeners.Add(t); listenPorts.Add(t.LocalPort); }
        }
        var est = new Dictionary<string, List<int>>(); // "port:pid" -> remote ports
        foreach (var t in tcp)
        {
            if (t.State != 5 || !listenPorts.Contains(t.LocalPort)) continue;
            string k = t.LocalPort + ":" + t.Pid;
            List<int> l;
            if (!est.TryGetValue(k, out l)) { l = new List<int>(); est[k] = l; }
            l.Add(t.RemotePort);
        }

        // --- which processes deserve a closer look
        var sessionRoots = new HashSet<uint>();
        if (extraPids != null) foreach (int p in extraPids) sessionRoots.Add((uint)p);
        Func<uint, bool> underSession = (pid) => {
            uint cur = pid;
            for (int i = 0; i < 16; i++)
            {
                if (sessionRoots.Contains(cur)) return true;
                uint up;
                if (!ppid.TryGetValue(cur, out up) || up == cur || up == 0) return false;
                cur = up;
            }
            return false;
        };
        Func<uint, bool> allowed = (pid) => {
            string n;
            if (pid <= 4 || !names.TryGetValue(pid, out n)) return false;
            if (Denied.Contains(n)) return false;
            return DeepNames.Contains(n) || underSession(pid);
        };
        var deep = new HashSet<uint>();
        foreach (uint p in sessionRoots) if (allowed(p)) deep.Add(p);
        foreach (var t in listeners)
        {
            if (!allowed(t.Pid)) continue;
            deep.Add(t.Pid);
            uint cur = t.Pid; // ancestors, so ownership can be traced back to a session
            for (int i = 0; i < 12; i++)
            {
                uint up;
                if (!ppid.TryGetValue(cur, out up) || up == cur || up <= 4) break;
                if (!allowed(up)) break;
                deep.Add(up); cur = up;
            }
            var stack = new Stack<uint>(); stack.Push(t.Pid); int guard = 0; // descendants, for CPU totals
            while (stack.Count > 0 && guard++ < 200)
            {
                List<uint> kids;
                if (!children.TryGetValue(stack.Pop(), out kids)) continue;
                foreach (uint kid in kids) if (allowed(kid) && deep.Add(kid)) stack.Push(kid);
            }
        }
        // Session descendants too: shells and servers Claude started that are not listening (yet).
        foreach (uint root in sessionRoots)
        {
            var stack = new Stack<uint>(); stack.Push(root); int guard = 0;
            while (stack.Count > 0 && guard++ < 400)
            {
                List<uint> kids;
                if (!children.TryGetValue(stack.Pop(), out kids)) continue;
                foreach (uint kid in kids) if (allowed(kid) && deep.Add(kid)) stack.Push(kid);
            }
        }

        // --- system load
        double cpu = -1;
        long idle, kern, user;
        if (GetSystemTimes(out idle, out kern, out user))
        {
            long di = idle - lastIdle, dk = kern - lastKernel, du = user - lastUser;
            if (lastKernel != 0 && dk + du > 0) cpu = Math.Max(0, Math.Min(1, 1.0 - (double)di / (dk + du)));
            lastIdle = idle; lastKernel = kern; lastUser = user;
        }
        var mem = new MEMSTAT();
        GlobalMemoryStatusEx(mem);

        // --- emit
        sb.Append("{\"t\":").Append(now);
        sb.Append(",\"cpu\":").Append(cpu.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        sb.Append(",\"mem\":").Append((mem.dwMemoryLoad / 100.0).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture));
        sb.Append(",\"tcpOk\":").Append(tcpOk ? "true" : "false");
        sb.Append(",\"tcp6Ok\":").Append(tcp6Ok ? "true" : "false");
        sb.Append(",\"procs\":[");
        bool first = true;
        foreach (var kv in names)
        {
            if (!first) sb.Append(','); first = false;
            sb.Append('[').Append(kv.Key).Append(',').Append(ppid[kv.Key]).Append(',');
            Esc(sb, kv.Value);
            sb.Append(']');
        }
        sb.Append("],\"info\":{");
        first = true;
        foreach (uint pid in deep)
        {
            Info info = null;
            try { info = Inspect(pid); } catch { }
            if (info == null) continue;
            if (!first) sb.Append(','); first = false;
            sb.Append('"').Append(pid).Append("\":{\"c\":").Append(info.Created).Append(",\"k\":").Append(info.Cpu).Append(",\"io\":").Append(info.Io);
            sb.Append(",\"cmd\":"); Esc(sb, info.Cmd);
            sb.Append(",\"cwd\":"); Esc(sb, info.Cwd);
            sb.Append('}');
        }
        sb.Append("},\"listen\":[");
        first = true;
        foreach (var t in listeners)
        {
            if (!first) sb.Append(','); first = false;
            sb.Append('['); Esc(sb, t.Addr); sb.Append(',').Append(t.LocalPort).Append(',').Append(t.Pid).Append(']');
        }
        sb.Append("],\"est\":[");
        first = true;
        foreach (var kv in est)
        {
            if (!first) sb.Append(','); first = false;
            var parts = kv.Key.Split(':');
            sb.Append('[').Append(parts[0]).Append(',').Append(parts[1]).Append(",[");
            for (int i = 0; i < kv.Value.Count && i < 64; i++) { if (i > 0) sb.Append(','); sb.Append(kv.Value[i]); }
            sb.Append("]]");
        }
        sb.Append("]}");

        // Forget cached info for processes that are gone (the key embeds the creation time).
        if (cache.Count > 2000)
        {
            var stale = new List<string>();
            foreach (var k in cache.Keys) { var p = k.Split(':'); if (!names.ContainsKey(uint.Parse(p[0]))) stale.Add(k); }
            foreach (var k in stale) cache.Remove(k);
        }
        return sb.ToString();
    }
}
'@

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'quit') { break }
    $extra = New-Object System.Collections.Generic.List[int]
    $id = $null
    $parts = $line.Split(' ')
    for ($i = 1; $i -lt $parts.Length; $i++) {
        $tok = $parts[$i]
        if (-not $tok) { continue }
        if ($tok.StartsWith('#')) { $n = 0; if ([int]::TryParse($tok.Substring(1), [ref]$n)) { $id = $n } }
        else { foreach ($p in $tok.Split(',')) { $n = 0; if ([int]::TryParse($p, [ref]$n)) { $extra.Add($n) } } }
    }
    try {
        $json = [CncProbe]::Snapshot($extra.ToArray())
    } catch {
        $msg = ($_.Exception.Message -replace '[\\"]', "'") -replace '[\r\n]+', ' '
        $json = '{"error":"' + $msg + '"}'
    }
    # Echo the request id so the server can pair replies with requests (and drop anything unexpected).
    if ($null -ne $id) { $json = '{"id":' + $id + ',' + $json.Substring(1) }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}
