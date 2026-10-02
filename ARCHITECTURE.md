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
3. `agents/session.ts` 的 `BotSession` 为每个「对话 × 机器人」保持一个 Claude Agent SDK 会话，可以续上之前的上下文。开了 `freshSession` 的机器人（验收、审查类角色）每轮新开会话：续上的会话每次调用都要重读全部历史，对只看当前状态的角色这部分钱白花。其余机器人的会话超过 `rotateAtTokens`（默认 6 万 token）后，下一轮也换成新会话，带上最近 12 条消息（`rotateSession` + `recapPrompt`）。它调用的是本机安装的 `claude` 命令行（`vendor/sdk-binary-stub` 替掉了 SDK 自带的 240MB 二进制）。
4. SDK 的流式事件交给 `agents/stream.ts` 整理成聊天消息的各个部分（文字、思考、工具调用、审批卡片），通过 `bus` 广播；`index.ts` 把它们推给每个 WebSocket 连接。
5. 一轮结束时记下改了哪些文件（可以撤销）、用了哪个模型、上下文用量（输入框旁的小圆环），以及这一轮在 Claude Code 会话记录里的位置（`meta.trace`：会话 id + 时间窗）。在独立工作区里，这一轮的改动会自动提交到分支。
6. 「轨迹」（`server/trace.ts`）按需读 `~/.claude/projects/<cwd>/<session>.jsonl`，把时间窗内的行整理成时间线：同一次 API 调用的几行（思考、文字、工具调用）合成一步，附上 token 用量；工具结果和发出的提示各一步。Crew 不复制这份记录，所以它被清理了轨迹就没了，界面会直说。
7. 机器人的回复里 @ 了队友，就接力给队友，次数有上限，防止来回打转。
8. 会话是续上的，发过的内容一直留在上下文里，所以每轮只发新东西：环境信息第一次全发，之后按「标签：值」比对只发变化（`contextDelta`）；群聊里较早的长消息压成一行摘要，机器人用 `chat_history` 按编号取全文。

## 权限

权限级别定义在 `shared/types.ts`，判断逻辑在 `agents/permissions.ts`，审批流程在 `orchestrator/permissionGate.ts`：

| 级别 | Claude Code 的模式 | Crew 额外做的事 |
| --- | --- | --- |
| 只读 `plan` | plan | 对话里的设置也改不动它 |
| 每步确认 `ask` | default | 每个工具调用都在聊天里弹审批卡片 |
| 自动改文件 `edits` | acceptEdits | 无害的命令（`cd`、`pwd`、`cat`…）直接放行 |
| AI 审查员 `review` | auto | 由 Claude Code 的分类器把关 |
| 全自动 `auto` | default | `canUseTool` 一律放行 |

另外每个机器人可以有「只能修改的路径」（`editScope`，相对项目的 glob）：范围外的 Edit/Write 直接拒绝并让它 @ 队友，这是角色分工的硬约束而不是提示词。每月预算（`monthlyBudgetUsd`）按 Claude Code 报告的每轮费用累计（`server/usage.ts`），用完后 `runTurn` 直接跳过这个机器人的回合并在对话里说明一次。

不管哪个级别，下面三层都会生效：

- **沙盒**（`server/sandbox.ts`）：开着的时候，每个会话都带上 Claude Code 的 `sandbox` 选项，命令在 bubblewrap 里跑，网络只到本机加允许的域名（全局列表 + 项目列表）。`allowUnsandboxedCommands: false`，机器人不能用 `dangerouslyDisableSandbox` 跳出去；`autoAllowBashIfSandboxed: false`，Crew 自己的审批逻辑照常生效。这是唯一按「能不能连上」而不是「命令长什么样」来判断的一层，所以也是唯一算得上安全边界的一层。沙盒里所有连接都走 Claude Code 的代理（代理持有允许列表，`strictAllowlist` 让不在列表上的主机直接被拒，不会变成一个可能被放行的询问）；但沙盒自带的 `no_proxy` 让回环和内网地址走直连，而直连在隔离的网络命名空间里什么都连不上，所以要访问本机或局域网的服务，命令前要加 `env -u no_proxy -u NO_PROXY`（提示词里已经告诉机器人了）。机器不满足依赖时（Linux 要 bubblewrap 和 socat）设置页会提示，机器人在没有沙盒的情况下运行。

- **禁止的操作**（设置里的 `denyRules`）：既写进 SDK 的 `permissions.deny`，又由一个不带 matcher 的 PreToolUse hook 再拦一次，所以全自动下也跑不了。
- **必须确认的操作**（每个机器人的规则，加上项目的 `askRules`）：一定弹审批卡片。复合命令（`a && b`）要每一段都匹配「自动允许」才放行。

## 聊天之外的改动

机器人只知道聊天里说过的话。`server/outsideEdits.ts` 监听项目文件：变化发生时如果没有机器人在这个项目里干活（`projectBusy`）、Crew 自己也没在写（`quietWrites.ts`：工作区的 git 操作、准备命令、撤销一轮会把项目标成「安静」，结束后再多 4 秒）、也不是在装依赖，就等 3 秒把这一批改动合成一条系统消息（`notice: 'outside-edit'`），发到所有在这个项目上的对话。文本文件会给出改了哪几行：和 Crew 上次看到的内容比，没看到过就和 git 里最后一次提交比。盲审的机器人也能看到这类消息。

## 对抗审查

建造（Pixel 等）、验收（Probe）、审查（Lens）都在找支持证据，而且后一个会看到前一个的结论，容易互相背书。Skeptic 是专门找反面证据的一环，设计上有四点（`server/review.ts`、`blindPrompt`）：

- **隔离**（Skeptic 和 Lens 都是）：`blindReview` 的机器人每轮只拿到用户的消息和改动的 diff（独立工作区相对 base 的全部改动；普通项目是未提交的改动，没有就是最后一次提交）。队友的消息只告诉它条数，`chat_history` 也只返回用户的消息。再加上每轮新会话，作者的推理影响不到它。
- **只认证据**：能复现的反例才算推翻，推理和猜测记为「没法验证」；精确率优先。
- **只读**：只能写 `tests/challenge/**`，修复交还给作者。
- **可以自动触发**：项目开了 `autoChallenge`，一串回合结束、聊天空闲时，用固定规则（改了哪些文件、改了多少行）判断要不要请 Skeptic；每个请求最多两次，同一个状态不审第二遍（`server/autoChallenge.ts`）。
- **可作为门槛**：它的结论（`结论：…` 那一行）记在独立工作区上，带着它看到的提交。项目开了 `requireChallenge`，合并时要求结论针对当前提交、而且没有推翻。

模型跟随默认（Opus 5.5）。研究里「模型修不好自己的错」主要来自作者的推理留在上下文里，隔离已经切断了这一点；Chief 自己写的改动和 Skeptic 用同一个模型，盲点可能重叠，这是已知的取舍。

## 群聊路由（影子模式）

群聊里没 @ 人的消息都先给负责人（通常是最贵的模型），哪怕只是一句小改动。`server/router.ts` 按 JEV-as-a-Judge（Li 等，2026）的做法准备一个「有把握就接受、没把握就上交」的便宜第一关，但目前只记录不执行：

- **便宜的判断只用在能从字面读出答案的地方**：「这条该谁接」看请求本身就能判断；「代码对不对」要推导，论文里便宜的判断在这类问题上差 7～28 个点，所以路由从不判断代码。
- **两种顺序取平均**：候选人正着列一次、倒着列一次，对齐后平均概率，抵消「偏爱第一个」的位置偏差。
- **标签来自真实结果**：负责人自己做了，标签就是负责人；交给了一位队友，就是那位；交给好几位，不算。
- **门槛用本地标签和下限选**：攒够 100 条有结果的记录后，选最小的门槛，使超过门槛的决定的准确率 95% 下限（Wilson）不低于 90%。论文显示，用下限而不是点估计选门槛，能把「掉两个点以上」的风险从约 45% 降到约 5%。
- 一次性调用都是「裸」的：不带工具、不带 Claude Code 的系统提示、不读设置和 MCP。

## 改进建议（轻量的自我改进）

完整的自我改进需要一套评测来判断改得好不好，没有评测就会制造「假进步」。Crew 不自动改自己，而是把人当评测（`server/improve.ts`）：

1. **证据包**：团队现在的设置、最近 60 轮（费用、模型、状态、审批及其原因、出错的工具、证伪结论）、被推翻的原文、用户最近的话、以前的建议和决定（账本）。
2. **提议**：一次 `claude -p`（Sonnet）返回 JSON 建议。约束照搬 RRSI 的思路：每次最多 3 条，每条一个机器人的一个字段，角色说明一次最多改 8 行，必须引用真实的轮次，宁可不提。
3. **检查**：机器人存在、新值过 `BotPatch` 校验、和现在不同、证据真的存在、证据来自至少两个不同的用户请求（第一次真跑时三条建议全出自同一次事故，这条就是为此加的）、不和待定或被拒绝的重复。没通过的直接丢掉并说明原因。
4. **决定**：用户可以先改（新值按 `BotPatch` 同样校验，模型原来的值存为 `original`），再接受（应用到机器人；如果这项设置在提议之后被手动改过，建议作废）、拒绝（可写理由）或撤回。拒绝理由和「模型提的 → 用户改成的」都会进下一次分析的账本。
5. **效果**：接受之后，比较改动前后同样数量轮次的平均费用、被推翻次数和出错次数。这只是观察，不是对照实验，任务不同会有偏差。

账本存在 `~/.crew/improvements.json`。

## 从经验里学

借鉴 Hermes Agent 的学习闭环，但每一步都要人批准（论文 Practice Makes Unsafe 发现，自动从成功经验写技能、自动生效的系统，全部写出过不安全的技能）：

- **记忆提醒**：一轮工具调用 ≥5 次，同一会话的下一轮提示末尾加一句提醒（`MEMORY_NUDGE`），只记用户说的和亲自验证过的。换了新会话或盲审角色不提醒。
- **学成技能**（`server/learnSkills.ts`）：候选是完成了、工具 ≥5 次、之后没被推翻、还没起草过的轮次，免费列出来；起草要点一下，用一次 Sonnet。草稿先过固定的安全检查（禁止规则、「忽略指令」类的话直接拦；需要确认的命令、沙盒外的地址标出来），再作为一条「新技能」建议进改进建议面板，接受才写进技能目录，撤回就删掉。

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
