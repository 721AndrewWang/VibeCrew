import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { isLogoId } from '../shared/logos';
import type { Attachment, Bootstrap, RecordedStep } from '../shared/types';
import { APP_VERSION, lanAddress } from './config';
import { bus } from './bus';
import { bots, chats, messages, projects, routines, settings, type Settings } from './store';
import { MODEL_OPTIONS, PLUGINS, BOT_TEMPLATES } from './data/catalog';
import {
  allProjects,
  createProject,
  decorate,
  getProject,
  git,
  gitStatus,
  HttpError,
  listDir,
  openExistingProject,
  projectTemplates,
  readProjectFile,
  resolveInProject,
  updateProject,
  writeProjectFile,
} from './projects';
import { assertWorkspaceIdle, createBot, createGroup, deleteBot, deleteChat, updateBot, updateChat } from './entities';
import { botStatuses, invalidateAllSessions, invalidateProject, resetChat, resolveApproval, sendUserMessage, setPreviewPage, stopChat } from './orchestrator';
import { skills, recordingToSkillBody } from './skills';
import { deleteRoutine, runRoutine, saveRoutine } from './routines';
import { devServer, devServerStates } from './devserver';
import { ensurePreview, previewInfos, restartPreviews } from './preview';
import { hasPty, listTerminals } from './terminal';
import { hasBrowser, screenshot } from './browser';
import { saveUpload, uploadFile, IMAGE_MIMES } from './uploads';
import { authStatus, checkAuth, testConnection } from './claudeAuth';
import { PROVIDER_PRESETS } from './data/providers';
import { listTurns, loadTurn, revertTurn, turnFileDiff } from './agents/recorder';
import { readMemory, memoryFile } from './agents/prompts';
import { abortSync, commitWorkspace, createWorkspace, mergeWorkspace, removeWorkspace, resolveConflicts, suggestCommitMessage, syncWorkspace, workspaceDiff, workspaceStatus } from './workspaces';

export function lanUrl(): string | undefined {
  const s = settings.get();
  const ip = lanAddress();
  if (!s.lanEnabled || !ip) return undefined;
  return `http://${ip}:${s.port}/?token=${encodeURIComponent(s.token)}`;
}

function bootstrap(): Bootstrap {
  return {
    version: APP_VERSION,
    settings: settings.public(),
    bots: bots.all().sort((a, b) => a.createdAt - b.createdAt),
    chats: chats.all(),
    projects: allProjects().map(decorate),
    skills: skills.list(),
    routines: routines.all(),
    templates: BOT_TEMPLATES,
    plugins: PLUGINS,
    statuses: botStatuses(),
    devServers: devServerStates(),
    previews: previewInfos(),
    models: MODEL_OPTIONS,
    providers: PROVIDER_PRESETS,
    features: { pty: hasPty, browser: hasBrowser() },
    auth: authStatus(),
    lanUrl: lanUrl(),
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Connection fields from a request body (Settings page), applied over the saved settings. */
function connectionPatch(b: Record<string, unknown>, cur: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  if (b.authMode === 'claude-code' || b.authMode === 'api-key' || b.authMode === 'provider') patch.authMode = b.authMode;
  if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey.trim();
  if (typeof b.baseUrl === 'string') patch.baseUrl = b.baseUrl.trim();
  if (b.provider && typeof b.provider === 'object') {
    const p = b.provider as Record<string, unknown>;
    patch.provider = {
      preset: str(p.preset) || cur.provider.preset,
      baseUrl: str(p.baseUrl).trim().replace(/\/+$/, ''),
      model: str(p.model).trim(),
      fastModel: str(p.fastModel).trim(),
    };
  }
  if (typeof b.providerToken === 'string' && b.providerToken.trim()) patch.providerToken = b.providerToken.trim();
  return patch;
}

/**
 * Where a recorded turn happened: the chat's workspace at the time, or its project folder. Never
 * another folder: restoring a workspace's snapshots over the project folder would clobber it.
 */
function turnProject(chatId: string, turnId: string) {
  return projects.get(loadTurn(chatId, turnId)?.projectId);
}

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '25mb' }));

  // `app` and `pid` let the desktop shell tell its own server apart from anything else on the port.
  r.get('/health', (_req, res) => res.json({ ok: true, app: 'crew', version: APP_VERSION, pid: process.pid }));
  r.get('/bootstrap', (_req, res) => res.json(bootstrap()));

  // ------------------------------------------------------------ auth & settings
  r.get('/auth', async (req, res) => res.json(await checkAuth(req.query.refresh === '1')));

  r.patch('/settings', async (req, res) => {
    const b = req.body || {};
    const cur = settings.get();
    const patch: Partial<typeof cur> = connectionPatch(b, cur);
    if (typeof b.defaultModel === 'string') patch.defaultModel = b.defaultModel.trim();
    if (typeof b.lanEnabled === 'boolean') patch.lanEnabled = b.lanEnabled;
    if (typeof b.projectsRoot === 'string' && b.projectsRoot.trim()) patch.projectsRoot = path.resolve(b.projectsRoot.trim().replace(/^~(?=$|\/)/, os.homedir()));
    if (['auto', 'edits', 'ask', 'review', 'plan'].includes(b.defaultPermission)) patch.defaultPermission = b.defaultPermission;
    if (typeof b.maxHops === 'number') patch.maxHops = Math.max(0, Math.min(30, Math.round(b.maxHops)));
    if (isLogoId(b.logo)) patch.logo = b.logo;
    if (Array.isArray(b.denyRules)) {
      const rules = b.denyRules.map((r: unknown) => (typeof r === 'string' ? r.trim().slice(0, 300) : '')).filter(Boolean);
      patch.denyRules = [...new Set<string>(rules)].slice(0, 100);
    }
    if (b.pluginSecrets && typeof b.pluginSecrets === 'object') {
      const next = { ...cur.pluginSecrets };
      for (const [k, v] of Object.entries(b.pluginSecrets)) {
        if (typeof v === 'string' && v) next[k] = v;
        else delete next[k];
      }
      patch.pluginSecrets = next;
    }
    const lanChanged = patch.lanEnabled !== undefined && patch.lanEnabled !== cur.lanEnabled;
    settings.update(patch);
    bus.emit({ t: 'settings', settings: settings.public() });
    // Claude Code gets the deny list when a session starts.
    if (patch.denyRules) invalidateAllSessions();
    if (patch.authMode || patch.apiKey !== undefined || patch.provider || patch.providerToken) void checkAuth(true);
    if (lanChanged) {
      await restartPreviews();
      bus.emit({ t: 'notify', title: '手机访问', body: patch.lanEnabled ? '已开启，重启 Crew 后生效（主服务需要重新监听局域网地址）' : '已关闭，重启后生效', level: 'info' });
    }
    res.json({ settings: settings.public(), lanUrl: lanUrl() });
  });

  // Tries the connection as entered on the Settings page (not saved yet): one tiny prompt.
  r.post('/settings/test-connection', async (req, res) => {
    const cur = settings.get();
    res.json(await testConnection({ ...cur, ...connectionPatch(req.body || {}, cur) }));
  });

  r.get('/lan', async (_req, res) => {
    const url = lanUrl();
    res.json({ url, qr: url ? await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }) : null, pluginSecretKeys: Object.keys(settings.get().pluginSecrets || {}) });
  });

  // ------------------------------------------------------------ bots
  r.post('/bots', (req, res) => res.json(createBot(req.body || {})));
  r.patch('/bots/:id', (req, res) => res.json(updateBot(req.params.id, req.body || {})));
  r.delete('/bots/:id', (req, res) => {
    deleteBot(req.params.id);
    res.json({ ok: true });
  });
  r.get('/bots/:id/memory', (req, res) => res.json({ text: readMemory(req.params.id) }));
  r.put('/bots/:id/memory', (req, res) => {
    if (!bots.get(req.params.id)) throw new HttpError(404, '机器人不存在');
    fs.writeFileSync(memoryFile(req.params.id), str(req.body?.text));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ chats
  r.post('/chats', (req, res) => res.json(createGroup(req.body || {})));
  r.patch('/chats/:id', (req, res) => res.json(updateChat(req.params.id, req.body || {})));
  r.delete('/chats/:id', (req, res) => {
    deleteChat(req.params.id);
    res.json({ ok: true });
  });
  r.get('/chats/:id/messages', (req, res) => {
    if (!chats.get(req.params.id)) throw new HttpError(404, '对话不存在');
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const list = messages.list(req.params.id, { beforeSeq: before, limit: limit + 1 });
    res.json({ messages: list.slice(-limit), hasMore: list.length > limit });
  });
  r.post('/chats/:id/messages', (req, res) => {
    const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as Attachment[]).slice(0, 20) : undefined;
    res.json(sendUserMessage(req.params.id, { text: str(req.body?.text), attachments }));
  });
  r.post('/chats/:id/stop', async (req, res) => {
    await stopChat(req.params.id);
    res.json({ ok: true });
  });
  r.post('/chats/:id/reset', (req, res) => {
    resetChat(req.params.id);
    res.json({ ok: true });
  });
  r.post('/chats/:id/read', (req, res) => {
    const c = chats.get(req.params.id);
    if (c && c.unread) {
      c.unread = 0;
      chats.set(c);
      bus.emit({ t: 'chat', chat: c });
    }
    res.json({ ok: true });
  });
  r.get('/chats/:id/turns', (req, res) => res.json(listTurns(req.params.id)));
  r.get('/chats/:id/turns/:turnId/diff', (req, res) => {
    const d = turnFileDiff(req.params.id, req.params.turnId, str(req.query.path));
    if (!d) throw new HttpError(404, '没有这个文件的记录');
    let current: string | null | undefined;
    const project = turnProject(req.params.id, req.params.turnId);
    if (project) {
      try {
        current = fs.readFileSync(resolveInProject(project, d.path), 'utf8');
      } catch {
        current = null;
      }
    }
    res.json({ ...d, current });
  });
  r.post('/chats/:id/turns/:turnId/revert', (req, res) => {
    const chat = chats.get(req.params.id);
    const project = turnProject(req.params.id, req.params.turnId);
    if (!chat || !project) throw new HttpError(400, '这一轮改动所在的项目或工作区已经不在了');
    const result = revertTurn(chat.id, req.params.turnId, project.path, !!req.body?.force);
    if (!result.conflicts.length) {
      const msg = messages.get(chat.id, result.turn.messageId);
      if (msg?.changes) {
        msg.changes.reverted = true;
        messages.put(msg);
        bus.emit({ t: 'msg', msg });
      }
    }
    res.json({ reverted: result.reverted, conflicts: result.conflicts, skipped: result.skipped });
  });

  // ------------------------------------------------------------ isolated workspaces
  r.get('/chats/:id/workspace', async (req, res) => res.json(await workspaceStatus(req.params.id)));
  r.post('/chats/:id/workspace', async (req, res) => res.json(decorate(await createWorkspace(req.params.id))));
  r.delete('/chats/:id/workspace', async (req, res) => {
    await removeWorkspace(req.params.id, req.query.deleteBranch === '1');
    res.json({ ok: true });
  });
  r.get('/chats/:id/workspace/diff', async (req, res) => res.json({ diff: await workspaceDiff(req.params.id, str(req.query.path)) }));
  r.post('/chats/:id/workspace/merge', async (req, res) => res.json(await mergeWorkspace(req.params.id, str(req.body?.message) || undefined)));
  r.post('/chats/:id/workspace/commit-message', async (req, res) => res.json({ message: await suggestCommitMessage(req.params.id) }));
  r.post('/chats/:id/workspace/sync', async (req, res) => res.json(await syncWorkspace(req.params.id)));
  r.post('/chats/:id/workspace/resolve', async (req, res) => res.json(await resolveConflicts(req.params.id)));
  r.post('/chats/:id/workspace/abort', async (req, res) => {
    await abortSync(req.params.id);
    res.json({ ok: true });
  });

  r.post('/approvals/:id', (req, res) => {
    const d = str(req.body?.decision);
    const ok = resolveApproval(req.params.id, { allow: d === 'allow' || d === 'always', always: d === 'always', message: str(req.body?.message) || undefined });
    if (!ok) throw new HttpError(410, '这个请求已经失效了');
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ projects
  r.get('/projects/templates', (_req, res) => res.json(projectTemplates()));
  r.post('/projects', async (req, res) => {
    const b = req.body || {};
    if (b.mode === 'open') res.json(decorate(openExistingProject(str(b.path), str(b.name) || undefined)));
    else res.json(decorate(await createProject({ name: str(b.name), template: str(b.template) || 'static', parentDir: str(b.parentDir) || undefined })));
  });
  r.patch('/projects/:id', (req, res) => {
    const p = updateProject(req.params.id, req.body || {});
    // Rules and commit settings reach the bots through their sessions.
    invalidateProject(p.id);
    res.json(decorate(p));
  });
  r.delete('/projects/:id', async (req, res) => {
    if (getProject(req.params.id).workspace) throw new HttpError(400, '这是某个对话的独立工作区，请在那个对话里关闭它');
    // Unbinding closes the chats' workspaces: not while a bot works in one.
    for (const c of chats.all()) if (c.projectId === req.params.id) assertWorkspaceIdle(c);
    await devServer(req.params.id).stop();
    for (const c of chats.all()) if (c.projectId === req.params.id) updateChat(c.id, { projectId: null });
    projects.delete(req.params.id);
    bus.emit({ t: 'project_deleted', id: req.params.id });
    res.json({ ok: true });
  });
  r.get('/projects/:id/tree', (req, res) => res.json(listDir(getProject(req.params.id), str(req.query.path))));
  r.get('/projects/:id/file', (req, res) => res.json(readProjectFile(getProject(req.params.id), str(req.query.path))));
  r.put('/projects/:id/file', (req, res) => {
    writeProjectFile(getProject(req.params.id), str(req.body?.path), str(req.body?.content));
    res.json({ ok: true });
  });
  r.get('/projects/:id/raw', (req, res) => {
    const abs = resolveInProject(getProject(req.params.id), str(req.query.path));
    res.sendFile(abs, { dotfiles: 'allow' });
  });
  r.post('/projects/:id/preview', async (req, res) => res.json(await ensurePreview(req.params.id)));
  r.post('/projects/:id/preview-page', (req, res) => {
    setPreviewPage(req.params.id, str(req.body?.path) || '/');
    res.json({ ok: true });
  });
  r.post('/projects/:id/dev/:action', async (req, res) => {
    getProject(req.params.id);
    const ds = devServer(req.params.id);
    const a = req.params.action;
    if (a === 'start') await ds.start();
    else if (a === 'stop') await ds.stop();
    else if (a === 'restart') await ds.restart();
    else if (a === 'url') ds.setUrl(str(req.body?.url));
    else throw new HttpError(400, '未知操作');
    res.json(ds.state);
  });
  r.get('/projects/:id/dev/logs', (req, res) => res.json({ logs: devServer(req.params.id).logs(60_000), state: devServer(req.params.id).state }));
  r.get('/projects/:id/terminals', (req, res) => res.json(listTerminals(req.params.id)));
  r.get('/projects/:id/git', async (req, res) => res.json(await gitStatus(getProject(req.params.id))));
  r.get('/projects/:id/git/diff', async (req, res) => {
    const p = getProject(req.params.id);
    const file = str(req.query.path);
    const out = await git(p, ['diff', 'HEAD', '--', file]).catch(() => '');
    if (out) return res.json({ diff: out });
    // Untracked file: show it as all-new.
    try {
      const content = fs.readFileSync(resolveInProject(p, file), 'utf8');
      res.json({ diff: `--- /dev/null\n+++ b/${file}\n` + content.split('\n').map((l) => '+' + l).join('\n') });
    } catch {
      res.json({ diff: '' });
    }
  });
  r.post('/projects/:id/git/commit', async (req, res) => {
    const p = getProject(req.params.id);
    const message = str(req.body?.message).trim();
    if (!message) throw new HttpError(400, '请填写提交说明');
    // In a workspace: under the chat's lock, and never with unresolved conflicts.
    if (p.workspace) {
      await commitWorkspace(p.workspace.chatId, message);
      return res.json(await gitStatus(p));
    }
    const st = await gitStatus(p);
    if (!st.repo) await git(p, ['init', '-q']);
    await git(p, ['add', '-A']);
    await git(p, ['commit', '-q', '-m', message]);
    res.json(await gitStatus(p));
  });
  r.post('/projects/:id/screenshot', async (req, res) => {
    const device = ['desktop', 'tablet', 'mobile'].includes(req.body?.device) ? req.body.device : 'desktop';
    const shot = await screenshot({ projectId: req.params.id, path: str(req.body?.path) || '/', device, fullPage: !!req.body?.fullPage });
    res.json(saveUpload(shot.png, 'image/png', `预览截图 ${str(req.body?.path) || '/'}`));
  });

  // Folder picker for "open an existing project".
  r.get('/fs', (req, res) => {
    const dir = path.resolve(str(req.query.path).replace(/^~(?=$|\/)/, os.homedir()) || os.homedir());
    let entries: { name: string; path: string; isProject: boolean }[] = [];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => {
          const full = path.join(dir, e.name);
          const isProject = ['package.json', 'index.html', '.git'].some((f) => fs.existsSync(path.join(full, f)));
          return { name: e.name, path: full, isProject };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      throw new HttpError(400, `无法读取文件夹：${(e as Error).message}`);
    }
    res.json({ path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), home: os.homedir(), entries });
  });

  // ------------------------------------------------------------ skills
  r.post('/skills', (req, res) => res.json(skills.save(req.body || {}, str(req.body?.previousName) || undefined)));
  r.delete('/skills/:name', (req, res) => {
    skills.remove(req.params.name);
    res.json({ ok: true });
  });
  r.post('/skills/from-recording', (req, res) => {
    const b = req.body || {};
    const steps = (Array.isArray(b.steps) ? b.steps : []) as RecordedStep[];
    if (!steps.length) throw new HttpError(400, '没有录制到任何操作');
    res.json(
      skills.save({
        name: str(b.name),
        title: str(b.title) || str(b.name),
        icon: '🎬',
        description: str(b.goal) || `复现录制于 ${str(b.page) || '/'} 的操作`,
        argsHint: '补充说明（可选）',
        body: recordingToSkillBody(steps, str(b.page) || '/', str(b.goal)),
      }),
    );
  });

  // ------------------------------------------------------------ routines
  r.post('/routines', (req, res) => res.json(saveRoutine(req.body || {})));
  r.patch('/routines/:id', (req, res) => {
    const cur = routines.get(req.params.id);
    if (!cur) throw new HttpError(404, '任务不存在');
    res.json(saveRoutine({ ...cur, ...(req.body || {}), id: cur.id }));
  });
  r.delete('/routines/:id', (req, res) => {
    deleteRoutine(req.params.id);
    res.json({ ok: true });
  });
  r.post('/routines/:id/run', (req, res) => {
    const cur = routines.get(req.params.id);
    if (!cur) throw new HttpError(404, '任务不存在');
    runRoutine(cur, 'manual');
    res.json(routines.get(cur.id));
  });

  // ------------------------------------------------------------ uploads
  r.post('/uploads', (req, res) => {
    const mime = str(req.body?.mime);
    if (!IMAGE_MIMES.has(mime)) throw new HttpError(400, '只支持 PNG、JPEG、GIF、WebP 图片');
    const buf = Buffer.from(str(req.body?.data), 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) throw new HttpError(400, '图片为空或超过 15MB');
    res.json(saveUpload(buf, mime, str(req.body?.name) || 'image'));
  });
  r.get('/uploads/:file', (req, res) => {
    const abs = uploadFile(req.params.file);
    if (!abs) throw new HttpError(404, 'not found');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.basename(abs), { root: path.dirname(abs) });
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status || 500;
    const message = (err as Error)?.message || String(err);
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: message });
  });
  return r;
}
