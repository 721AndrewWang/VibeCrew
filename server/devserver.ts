import { type ChildProcess, spawn } from 'node:child_process';
import type { DevServerState, Project } from '../shared/types';
import { bus } from './bus';
import { cleanEnv } from './config';
import { devCommand, getProject, needsInstall, packageManager } from './projects';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_RE = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+):(\d{2,5})(\/[^\s'"]*)?/i;
const MAX_LOG = 200_000;

class DevServer {
  state: DevServerState;
  private proc: ChildProcess | null = null;
  private log = '';
  private stopping = false;
  private urlTimer: NodeJS.Timeout | null = null;

  constructor(public projectId: string) {
    this.state = { projectId, status: 'stopped' };
  }

  private set(patch: Partial<DevServerState>) {
    this.state = { ...this.state, ...patch };
    bus.emit({ t: 'devserver', state: this.state });
  }

  private append(data: string) {
    this.log += data;
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG / 2);
    bus.emit({ t: 'devserver_log', projectId: this.projectId, data });
  }

  logs(tail = 20_000): string {
    return this.log.slice(-tail);
  }

  private spawnStep(command: string, project: Project): ChildProcess {
    this.append(`\x1b[36m$ ${command}\x1b[0m\r\n`);
    const child = spawn('bash', ['-c', command], {
      cwd: project.path,
      env: cleanEnv({ FORCE_COLOR: '1', BROWSER: 'none', NO_UPDATE_NOTIFIER: '1' }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf: Buffer) => {
      const text = buf.toString('utf8');
      this.append(text.replace(/(?<!\r)\n/g, '\r\n'));
      if (this.state.status === 'starting' && !this.state.url) {
        const plain = text.replace(ANSI, '');
        for (const line of plain.split('\n')) {
          const m = line.match(URL_RE);
          if (!m) continue;
          // Prefer the "Local:" address over "Network:" ones.
          if (/network/i.test(line) && !/local/i.test(line)) continue;
          const host = /^(0\.0\.0\.0|\[::1?\])$/.test(m[2]) ? 'localhost' : m[2];
          this.onUrl(`${m[1]}://${host}:${m[3]}${m[4] || '/'}`);
          break;
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    return child;
  }

  private onUrl(url: string) {
    if (this.urlTimer) clearTimeout(this.urlTimer);
    this.urlTimer = null;
    this.set({ status: 'running', url, error: undefined });
  }

  async start(): Promise<DevServerState> {
    if (this.proc && (this.state.status === 'running' || this.state.status === 'starting' || this.state.status === 'installing')) return this.state;
    const project = getProject(this.projectId);
    const command = devCommand(project);
    if (!command) {
      this.set({ status: 'error', error: '没有找到启动命令（package.json 里没有 dev/start 脚本）。静态网页不需要开发服务器。' });
      return this.state;
    }
    this.stopping = false;
    this.log = '';
    if (needsInstall(project)) {
      const pm = packageManager(project.path);
      this.set({ status: 'installing', command, url: undefined, error: undefined });
      const ok = await new Promise<boolean>((resolve) => {
        const child = this.spawnStep(`${pm} install`, project);
        this.proc = child;
        child.on('exit', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
      if (this.stopping) return this.state;
      if (!ok) {
        this.proc = null;
        this.set({ status: 'error', error: '依赖安装失败，请查看开发服务器日志' });
        return this.state;
      }
    }
    this.set({ status: 'starting', command, url: undefined, error: undefined });
    const child = this.spawnStep(command, project);
    this.proc = child;
    this.urlTimer = setTimeout(() => {
      if (this.state.status === 'starting') this.append('\r\n\x1b[33m[Crew] 没能从输出中识别到访问地址，可以在浏览器地址栏手动输入，例如 http://localhost:3000\x1b[0m\r\n');
    }, 45_000);
    child.on('exit', (code, signal) => {
      if (this.proc !== child) return;
      this.proc = null;
      if (this.urlTimer) clearTimeout(this.urlTimer);
      if (this.stopping) this.set({ status: 'stopped', url: undefined });
      else this.set({ status: 'error', url: undefined, error: `开发服务器已退出（${signal || `code ${code}`}），请查看日志` });
      this.append(`\r\n\x1b[90m[进程已退出 ${signal || code}]\x1b[0m\r\n`);
    });
    child.on('error', (e) => {
      this.set({ status: 'error', error: e.message });
    });
    return this.state;
  }

  /** Uses a URL the user typed when the output did not reveal one. */
  setUrl(url: string) {
    this.set({ status: this.proc ? 'running' : this.state.status, url });
  }

  async stop(): Promise<void> {
    const child = this.proc;
    this.stopping = true;
    if (!child || child.pid === undefined) {
      this.set({ status: 'stopped', url: undefined });
      return;
    }
    const pid = child.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
    this.set({ status: 'stopped', url: undefined });
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}

const servers = new Map<string, DevServer>();

export function devServer(projectId: string): DevServer {
  let s = servers.get(projectId);
  if (!s) {
    s = new DevServer(projectId);
    servers.set(projectId, s);
  }
  return s;
}

/** Stops a project's dev server and drops it (its workspace was removed). */
export async function disposeDevServer(projectId: string) {
  const s = servers.get(projectId);
  if (!s) return;
  await s.stop();
  servers.delete(projectId);
}

export function devServerStates(): DevServerState[] {
  return [...servers.values()].map((s) => s.state).filter((s) => s.status !== 'stopped');
}

export async function stopAllDevServers() {
  await Promise.all([...servers.values()].map((s) => s.stop()));
}
