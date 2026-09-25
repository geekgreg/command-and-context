// Docker awareness: published host ports -> container names/projects, plus rough CPU per container.
// Container ports become container ships; compose projects dock at their repo's island.
import { execFile } from 'node:child_process';

function docker(args, timeout) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function labels(str) {
  const out = {};
  for (const part of String(str || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export class Docker {
  constructor() {
    this.byPort = new Map();   // host port -> container info
    this.cpu = new Map();      // container name -> cpu fraction (0..n)
    this.available = null;
    this.nextPs = 0;
    this.nextStats = 0;
    this.running = false;
  }

  async poll() {
    if (this.running) return;
    const now = Date.now();
    if (now < this.nextPs) return;
    this.running = true;
    try {
      const out = await docker(['ps', '--format', '{{json .}}'], 12_000);
      if (out == null) {
        // A slow or failed `docker ps` on a busy machine must not strip container identities (ships
        // would sail off and re-dock under new ids). Keep the last map until it fails repeatedly.
        this.failures = (this.failures || 0) + 1;
        if (this.failures >= 3 || this.available !== true) {
          this.available = false;
          this.byPort.clear();
          this.nextPs = now + 60_000;
        } else {
          this.nextPs = now + 5_000;
        }
        return;
      }
      this.failures = 0;
      this.available = true;
      this.nextPs = now + 10_000;
      const map = new Map();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let c;
        try { c = JSON.parse(line); } catch { continue; }
        const lab = labels(c.Labels);
        const info = {
          name: c.Names, image: c.Image, status: c.Status, state: c.State,
          project: lab['com.docker.compose.project'] || lab['com.supabase.cli.project'] || null,
          service: lab['com.docker.compose.service'] || null,
          workingDir: lab['com.docker.compose.project.working_dir'] || null,
        };
        // "0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp"
        for (const m of String(c.Ports || '').matchAll(/:(\d+)(?:-(\d+))?->(\d+)/g)) {
          const from = +m[1], to = m[2] ? +m[2] : from;
          for (let p = from; p <= to && p - from < 64; p++) map.set(p, { ...info, containerPort: +m[3] });
        }
      }
      this.byPort = map;
      if (now >= this.nextStats && map.size) {
        this.nextStats = now + 20_000;
        this.pollStats().catch(() => {}); // ~2 s; not awaited so poll() resolves as soon as ports are known
      }
    } finally {
      this.running = false;
    }
  }

  async pollStats() {
    const stats = await docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}'], 12_000);
    if (!stats) return;
    const cpu = new Map();
    for (const line of stats.split('\n')) {
      const [name, pct] = line.split('\t');
      if (name && pct) cpu.set(name.trim(), (parseFloat(pct) || 0) / 100);
    }
    this.cpu = cpu;
  }
}
