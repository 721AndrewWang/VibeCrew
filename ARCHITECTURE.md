# Crew 的架构

这份文档讲 Crew 由哪几块组成、一条消息怎么变成机器人的回复，以及几个容易踩坑的设计决定。使用说明看 [README](README.md)，开发流程看 [CONTRIBUTING](CONTRIBUTING.md)。

## 总览

```
┌──────────── 桌面应用（Electron，desktop/main.cjs）─────────────┐
│  托盘、窗口、开机自启、图标；把服务作为子进程启动并加载界面     │
└───────────────┬────────────────────────────────────────────────┘
                │ spawn（ELECTRON_RUN_AS_NODE）
┌───────────────▼──────────── 服务（server/，Node + Express）─────┐
│  api.ts      REST 接口（请求形状由 schemas.ts 把关）             │
│  index.ts    HTTP + WebSocket 入口                              │
│  orchestrator/ 排队、群聊路由、@ 接力、权限审批                  │
│  agents/     机器人会话：Claude Agent SDK query() → 系统 claude │
│  workspaces/ git worktree 独立工作区：创建、自动提交、合并       │
│  preview     预览服务器（静态 / 反向代理 + 注入脚本）            │
│  store       ~/.crew 下的 JSON 存储                             │
│  bus ──────► WebSocket 广播 ServerEvent                         │
└───────────────┬────────────────────────────────────────────────┘
                │ REST + WebSocket（同源，默认只听 127.0.0.1）
┌───────────────▼──────────── 界面（web/，React + Vite）──────────┐
│  store.ts    全局状态（useSyncExternalStore），处理服务端事件    │
│  components/ 聊天、输入框、右侧「电脑」（预览、文件、终端、改动）│
└────────────────────────────────────────────────────────────────┘
shared/  前后端共用的类型（types.ts）和 logo 定义（logos.ts）
```

## 一条消息的旅程

1. 界面 `POST /api/chats/:id/messages`，`orchestrator.sendUserMessage` 存下消息，决定由谁回复：被 @ 的机器人；群聊里没人被 @ 时由负责人回复。
2. 每个对话一个队列，同一时间只跑一轮（`withChatLocked`）。新工作区的准备命令跑完之前，消息会先排着（`holdTurns`）。
3. `agents/session.ts` 的 `BotSession` 为每个「对话 × 机器人」保持一个 Claude Agent SDK 会话，可以续上之前的上下文。它调用的是本机安装的 `claude` 命令行（`vendor/sdk-binary-stub` 替掉了 SDK 自带的 240MB 二进制）。
4. SDK 的流式事件交给 `agents/stream.ts` 整理成聊天消息的各个部分（文字、思考、工具调用、审批卡片），通过 `bus` 广播；`index.ts` 把它们推给每个 WebSocket 连接。
5. 一轮结束时记下改了哪些文件（可以撤销）、用了哪个模型、上下文用量（输入框旁的小圆环）。在独立工作区里，这一轮的改动会自动提交到分支。
6. 机器人的回复里 @ 了队友，就接力给队友，次数有上限，防止来回打转。

## 权限

权限级别定义在 `shared/types.ts`，判断逻辑在 `agents/permissions.ts`，审批流程在 `orchestrator/permissionGate.ts`：

| 级别 | Claude Code 的模式 | Crew 额外做的事 |
| --- | --- | --- |
| 只读 `plan` | plan | 对话里的设置也改不动它 |
| 每步确认 `ask` | default | 每个工具调用都在聊天里弹审批卡片 |
| 自动改文件 `edits` | acceptEdits | 无害的命令（`cd`、`pwd`、`cat`…）直接放行 |
| AI 审查员 `review` | auto | 由 Claude Code 的分类器把关 |
| 全自动 `auto` | default | `canUseTool` 一律放行 |

不管哪个级别，下面两层都会生效：

- **禁止的操作**（设置里的 `denyRules`）：既写进 SDK 的 `permissions.deny`，又由一个不带 matcher 的 PreToolUse hook 再拦一次，所以全自动下也跑不了。
- **必须确认的操作**（每个机器人的规则，加上项目的 `askRules`）：一定弹审批卡片。复合命令（`a && b`）要每一段都匹配「自动允许」才放行。

## 数据

所有数据都在 `CREW_HOME`（默认 `~/.crew`）：

```
settings.json  设置（含模型服务商的 Key，只存本机）
bots.json  chats.json  projects.json  routines.json
messages/      每个对话一个消息文件
turns/         每一轮的改动快照（用于撤销）
memory/        机器人的长期记忆
skills/        自定义技能
worktrees/     独立工作区的 git worktree
uploads/       上传的图片和附件
logs/          桌面版的服务日志（server.log）
```

- `store.ts` 的写入都是「先写临时文件再改名」，并且合并在一起延后写；退出时 `flushAll()` 把没写完的写完。
- `settings.json` 里的 `schemaVersion` 记录数据的格式版本。改了存储格式就在 `server/migrations.ts` 里加一条迁移，启动时按顺序补跑，跑之前把 JSON 文件备份到 `backups/`。数据比当前 Crew 还新时拒绝启动，而不是悄悄写坏它。
- `config.ts` 的 `migrateFromVibeCrew` 负责把旧名字的数据（`~/.vibecrew`、`~/VibeCrewProjects`）搬过来；它决定数据目录在哪，所以跑在版本迁移之前。
- 机器人每一轮的进展每 3 秒落一次盘。Crew 被强杀后重启，那一轮标成「中断」，写到一半的内容保留；独立工作区里没提交的改动会先提交到分支上。
- 测试必须把 `CREW_HOME` 和 `CREW_PROJECTS` 指到临时目录，绝不能碰真实数据（`tests/helpers/server.ts` 已经这样做了）。

## 独立工作区

一个对话可以在自己的 git worktree 和 `crew/` 开头的分支里工作，机器人、预览、文件、终端都用这份副本。

- 新建时会带上 git 不管、但干活需要的本地文件：`.env`、`CLAUDE.md`、`.claude/` 里的设置和 hook、`.git/info/exclude` 里列出的文件。依赖目录、缓存和工具的临时状态不带。只有 worktree 里 `git check-ignore` 确认被忽略的文件才会复制，所以不会弄脏 `git status`。
- 项目可以配置准备命令、提交信息要求、不加 AI 署名，以及必须确认的操作。
- 合并时把分支压成一个提交合进主分支。项目有提交信息要求时必须手写提交信息（可以用 `claude -p` 生成草稿）。

## 预览

`preview.ts` 为每个项目起一个预览服务器：静态网站直接提供文件（不提供隐藏文件），有开发服务器的就反向代理过去。返回的 HTML 会注入 `inject/preview-inject.js`，它通过 postMessage 和 Crew 窗口通信，负责控制台捕获、导航跟踪、圈选元素、录制演示和热刷新。这个脚本跑在别人的页面里，所以故意写成保守的 `function` + `var` 风格（lint 规则对它单独放宽了）。

## 桌面应用

`desktop/main.cjs` 是 Electron 主进程：用登录 shell 的环境变量启动打包好的服务（`dist-server/server.mjs`），等它就绪后在窗口里加载界面；托盘、开机自启、Dock 和窗口图标（跟随设置里选的 logo）也在这里。`desktop/install.mjs` 打包 AppImage 装到 `~/Applications`，并写好菜单项和图标。

## 几个设计决定

- **用本机的 `claude`，不用 SDK 自带的二进制**：省 240MB，版本跟着用户自己的 Claude Code 升级。
- **Biome 而不是 ESLint**：项目用的是 TypeScript 7（原生版），没有 JS API，typescript-eslint 跑不起来。
- **路由用地址栏的 hash（`#/chat/<id>`）**：每个对话一条历史记录，浏览器的前进后退可以切换对话，链接也能直接打开某个对话。
- **测试用系统 Chrome**：Playwright 不下载浏览器，CI 用 runner 自带的 Chrome。
