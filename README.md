# Crew — 你的 Web 开发 AI 小队

Crew 是一个运行在你自己电脑上的「AI 机器人团队」应用，专门为 Web 开发提效。
它参考了 xAI 的 **Grokbot**：每个机器人都有名字、角色和自己的“电脑”，你像发短信一样和它们聊天，它们可以在群聊里互相 @ 接力、按时间表自动干活、需要你拍板时停下来等你确认。
不同的是，Crew 的“电脑”就是你的项目文件夹：右侧实时显示网页预览、文件、终端和改动。机器人由你本机的 **Claude Code**（Claude Agent SDK）驱动。

## 和 Grokbot 的功能对照

| Grokbot | Crew |
| --- | --- |
| 有名字、角色的 Bot（Name / Title / Description） | 机器人：名字（用于 @）、头像、角色说明（系统提示词）、模型（分高/中/便宜档）、思考强度、权限级别、只能修改的路径、每月预算；内置角色各有不同的配置，比如审查员只读、测试员只改测试、文案用便宜模型 |
| 每个 Bot 有自己的云电脑（浏览器、文件、终端） | 每个对话绑定一个项目：**实时预览浏览器**、文件树 + 代码编辑器、真实终端、改动记录；还可以开「独立工作区」，拥有自己的 Git 分支和工作目录 |
| iMessage 式聊天 | iMessage 式聊天，流式输出，工具调用折叠成“做了 N 个操作” |
| 群聊、@ 提及、Bot 之间互相交接 | 群聊：没 @ 人时由负责人回复；机器人回复里 @ 队友会自动接力（有上限防止死循环）；@ 群外机器人会把它拉进群 |
| Routines 定时 / 事件触发 | 定时任务：每 N 分钟、每天定点、Cron、**你保存文件后**、**Git 提交后** |
| Skills / 斜杠命令 | 技能：输入 `/` 调用，内置 14 个 Web 开发技能，可自定义 |
| Teach a task（录屏教学） | **录制演示**：在预览里操作一遍，保存成技能或让机器人写成 E2E 测试 |
| 审批闸门、审查 Agent、允许/阻止名单 | 5 级权限（全自动 / 自动改文件 / 每步确认 / AI 审查员 / 只读）+「自动允许」和「必须确认」规则；需要确认时在聊天里弹卡片 |
| 插件 / MCP / 多账号连接 | 插件库（Context7 文档、Playwright、Chrome DevTools、shadcn/ui、Figma、GitHub）+ 自定义 MCP |
| 手机上看 Bot 的屏幕、接管 | 手机访问：同一局域网扫码打开，随时看进度、点批准 |
| 长期记忆 | 每个机器人有长期记忆，`remember` 工具写入，跨对话可见 |

## Web 开发专属的提效功能

- **圈选元素**：在预览里点一下页面元素，选择器、样式、文字、源码位置（React/Vue/Svelte 开发模式）自动附加到消息里，直接说“把这个按钮改大一点”。
- **控制台一键修复**：预览里的报错、警告、失败的网络请求会被捕获，点「发给机器人修复」。
- **机器人能“看见”页面**：机器人用无头 Chrome 截图（桌面 / 平板 / 手机）检查自己的改动，还能像用户一样点击、输入来测试流程。
- **每轮改动可撤销**：机器人每一轮改了哪些文件都有记录，可以看 diff、一键撤销；右侧还能直接 Git 提交。
- **独立工作区（借鉴 vibe-kanban）**：对话可以在自己的 Git 分支里工作（git worktree）。机器人、预览、文件、终端都用这份副本，几个对话同时改同一个项目也互不干扰；每一轮自动提交到分支，在「改动」里看和主分支的差异，一键合并回去（压成一个提交）。主分支有新提交可以同步进来，有冲突可以交给机器人解决。
  - git 之外的本地文件会带进新工作区：`.env`、`CLAUDE.md` / `AGENTS.md`、`.claude/` 里的设置、hook 和技能，以及你写在 `.git/info/exclude` 里的文件（依赖目录和缓存不带）。
  - 项目「设置」里可以配：**新工作区准备命令**（比如装依赖，跑完机器人才开始）、**提交信息要求**（机器人照着写；合并时必须按它写，可以一键「生成」）、**提交不加 AI 署名**、**必须确认的操作**（对这个项目里的所有机器人生效）。
- **开发服务器托管**：自动识别 `npm run dev` 等命令，缺依赖自动安装，预览自动接入热更新；静态网页保存即刷新。
- **截图 / 粘贴图片 / 语音输入**：把设计稿贴进来让机器人还原（`/clone-ui`），或者直接说话。

## 运行要求

- Node.js 22.12 或更高（开发时使用 Node 24）
- Linux 上还需要 C/C++ 编译工具：终端组件 node-pty 在 Linux 上没有预编译包，`npm install` 会现场编译（缺少时整个安装会失败）。Ubuntu：`sudo apt install build-essential python3`
- 已安装 [Claude Code](https://docs.claude.com/en/docs/claude-code)：`npm i -g @anthropic-ai/claude-code`
  - 并且**登录过**：在终端运行 `claude auth login`（订阅账号或 Console 账号都可以）
  - 或者在 Crew 的「设置」里改用 Anthropic API Key，或者 DeepSeek、Kimi、智谱 GLM 等其他模型服务商（见下文）
- Google Chrome 或 Chromium（用于机器人截图和浏览器测试；没有也能用，只是这两个功能不可用）
- 沙盒（推荐开着）在 Linux 上需要 `bubblewrap` 和 `socat`：`sudo apt install bubblewrap socat`。缺了的话机器人照样能干活，只是命令没有被隔离，设置页会提醒你
- 桌面应用（AppImage）还需要 FUSE 2：Ubuntu 24.04 上是 `libfuse2t64`
- Linux / macOS（Windows 未测试）

### 使用其他模型服务商

机器人一直由 Claude Code 驱动，但背后的模型可以换成其他服务商的：在「设置 → 模型连接」里选「使用其他模型服务商」，挑一家、填上 Key，点「测试连接」确认能用，再保存。

| 服务商 | 说明 |
| --- | --- |
| DeepSeek、Kimi、智谱 GLM、通义千问（阿里云百炼）、MiniMax | 国内直连，按各家的价格计费 |
| OpenRouter | 一个 Key 用几百种模型（Claude、GPT、Gemini…），需要能访问海外网络 |
| Ollama | 在自己电脑上跑开源模型，不需要 Key（需要 Ollama 0.14 以上） |
| 自定义 | 任何兼容 Anthropic Messages API 的地址，比如 LiteLLM、公司内部网关 |

- 地址和推荐的模型来自各家的 Claude Code 接入说明，都可以改；每个机器人也能在自己的设置里单独选模型。
- Key 只保存在本机的 `~/.crew/settings.json`，只会发给你选的服务商；这时 Claude Code 也不会再向 Anthropic 发送统计数据。
- Claude Code 是为 Claude 模型优化的，换成其他模型后效果和稳定性取决于那个模型（联网搜索这类功能可能用不了）。

## 安装与启动

```bash
npm install
npm run app
```

`npm run app` 会构建界面并启动服务，然后自动打开 <http://localhost:4321>。以后只需要 `npm start`（界面已构建过）。

第一次启动会自动创建：一个示例项目（`~/CrewProjects/my-first-site`）、默认的 4 人小队（Chief / Pixel / Probe / Lens）和一个「Web 小队」群聊。

开发模式（改 Crew 自己的代码时用）：

```bash
npm run dev
```

然后打开 <http://localhost:5173>。

## 桌面应用（推荐）

Crew 可以打包成独立的桌面应用（Electron + AppImage），放进应用列表，像普通软件一样双击打开：

```bash
npm run desktop:install
```

它会构建 `~/Applications/Crew.AppImage`，并注册应用菜单和图标。之后在「显示应用」里搜索 **Crew**，右键可以「固定到 Dock」。

- **关闭窗口 ≠ 退出**：窗口会隐藏到托盘，机器人和定时任务继续在后台工作；从托盘菜单或 `Ctrl+Q` 彻底退出（会停止所有机器人）。
- **开机自启**：托盘菜单或「设置 → 桌面应用」里打开，登录后只在托盘里后台运行。
- **和命令行共用**：数据都在 `~/.crew`。如果你已经用 `npm start` 启动了服务，桌面应用会直接连上它，退出应用时不会停掉那个服务。
- **更新**：改了代码后再运行一次 `npm run desktop:install`。如果 Crew 正在托盘里运行，要先从托盘「退出」再重新打开才会用上新版本（安装时会提醒你）。
- **卸载**：`npm run desktop:uninstall`（保留 `~/.crew` 里的数据和你的项目）。
- **日志**：`~/.crew/logs/server.log`，也可以从托盘菜单打开。
- **换图标**：「设置 → 外观 → 应用图标」有 6 个 logo 可选，窗口、托盘和 Dock 上的图标会跟着换（Dock 偶尔要重新打开应用或重新登录才刷新）。
- **其他命令**：`npm run desktop` 从源码直接运行桌面版；`npm run desktop:pack` 只打包到 `release/`；logo 的图形定义在 `shared/logos.ts`，改了之后用 `npm run icons` 重新生成各尺寸图标。

### 关于沙盒

Ubuntu 23.10 起默认限制了 Chromium 沙盒需要的用户命名空间，所以和大多数 Electron 应用一样，AppImage 版 Crew 以 `--no-sandbox` 运行。

想开启沙盒，可以改用系统安装：把应用放到 root 拥有的 `/opt/Crew`，并加一条只针对这个路径的 AppArmor 规则（和 Ubuntu 对 Google Chrome 的做法一样）。先打包，再用 sudo 安装：

```bash
npm run desktop:pack
```

```bash
sudo desktop/install-system.sh
```

```bash
npm run desktop:install
```

之后菜单会启动 `/opt/Crew/crew`，「设置 → 桌面应用」里会显示「沙盒已开启」。每次更新代码后都要再运行一次 `sudo desktop/install-system.sh`。用 `sudo desktop/install-system.sh --remove` 撤销。

### 常见问题

- **双击没反应**：AppImage 需要 FUSE 2。Ubuntu 24.04 请安装 `libfuse2t64`（`sudo apt install libfuse2t64`），安装脚本发现缺少时会提示。
- **看日志**：`~/.crew/logs/server.log`，或者托盘菜单 →「查看服务日志」。

## 使用小贴士

- **找对人**：群聊里直接说需求，Chief 会拆解并 @ 队友；想指定某人就 `@Pixel`；`@所有人` 让每个人都回复。
- **新话题**：切换到不相关的任务时点标题栏的 ↻「开始新话题」，机器人会忘掉旧上下文，更快也更省用量。
- **权限**：刚开始建议用默认的「自动改文件」；审批卡片上点「总是允许」会把规则加进机器人的白名单。
- **撤销**：每条机器人消息下面的「改动了 N 个文件」可以查看和撤销；由命令（比如 `npm install`）造成的改动无法自动撤销。
- **并行做几件事**：新建群聊时打开「在独立分支中工作」，或者点对话右上角的项目按钮开启。每个对话一个 `vc/…` 分支，做完在右侧「改动」里合并回主分支，合并时主目录里未提交的改动不会被覆盖（会提示你先处理）。
  - 需要：项目是 Git 仓库（新建的项目自动就是）、Git 2.38 或更新、设置过 git 的用户名和邮箱（`git config --global user.name` / `user.email`）。
  - 工作区放在 `~/.crew/worktrees/`，第一次预览时会自动安装依赖，被 git 忽略的 `.env` 文件会复制过去。
  - 关闭工作区时，还没合并的改动会留在它的分支里，不会丢；删除对话也一样。
- **技能**：`/landing 咖啡店`、`/responsive`、`/fix-console`、`/polish`、`/review`、`/commit`……在「技能」页可以修改或新增。
- **定时任务**：比如「每天 9 点让 Probe 跑一遍 `/fix-console`」，或者「每次 Git 提交后让 Lens `/review`」。
- **只用浏览器时**：也可以在 Chrome 地址栏右侧点「安装 Crew」，得到一个独立窗口（不过推荐上面的桌面应用，它有托盘和开机自启）。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `CREW_PORT` | 服务端口，默认 4321 |
| `CREW_HOME` | 数据目录，默认 `~/.crew`（设置、聊天记录、技能、记忆、改动快照） |
| `CREW_PROJECTS` | 新项目的默认父目录，默认 `~/CrewProjects` |
| `CREW_CLAUDE_PATH` | 指定 `claude` 可执行文件 |
| `CREW_CHROME_PATH` | 指定 Chrome/Chromium 可执行文件 |
| `CREW_FAKE_AGENT=1` | 演示模式：不调用模型，用脚本模拟机器人（开发界面时用） |

桌面版第一次运行或打包时会下载 Electron（约 110MB）和 AppImage 工具，默认走 npmmirror 镜像（这台机器上比 GitHub 快十倍左右）。可以用 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量换成其他镜像。

### 关于 Claude Code 可执行文件

Claude Agent SDK 默认会下载一个约 240MB 的内置 Claude Code 二进制。为了省下这次下载，`package.json` 用 `overrides` 把它替换成了一个空的占位包，Crew 会直接调用你已经安装的 `claude` 命令（版本跟随你自己的更新）。
如果你想改用 SDK 自带的二进制，删掉 `package.json` 里的 `overrides` 后重新 `npm install` 即可（只对 `npm start` 有效；桌面版不打包这个 240MB 的二进制，始终使用本机的 `claude`）。

## 安全说明

- 服务默认只监听 `127.0.0.1`。只有本机、同源的页面能调用接口；开启「手机访问」后，其他设备需要带访问令牌的链接（二维码里就是）。
- 机器人以你的用户身份在你的电脑上运行命令。请根据信任程度设置权限级别，并保留「必须确认」规则（默认包含 `git push`、`sudo`、`rm -rf`、`npm publish`、部署命令）。
- 「设置 → 沙盒」默认开启：机器人运行的命令被关在 Claude Code 的沙盒里，只能写项目目录，网络只能连本机和你允许的域名（项目设置里可以追加）。机器人自己关不掉它。「禁止的操作」是按命令文字匹配的，只能防误操作，不是安全边界。沙盒里的命令访问本机服务（比如开发服务器）要加 `env -u no_proxy -u NO_PROXY`，机器人知道这一点。
- 预览服务器不会提供项目里的隐藏文件（如 `.env`）。

## 目录结构

```
desktop/           桌面应用：Electron 主进程、托盘、加载页、打包与安装脚本、图标生成、AppArmor 规则
server/            Node 服务（Express + WebSocket）
  agents/          机器人引擎：会话、流式事件、权限、提示词、自定义工具、改动记录
  orchestrator/    排队、群聊路由、@ 接力、审批
  preview.ts       预览服务器（静态 / 反向代理 + 注入脚本）
  inject/          注入到预览页面的脚本（圈选、控制台、录制、热刷新）
  devserver.ts     开发服务器托管
  routines.ts      定时任务与事件触发
  workspaces/      独立工作区：git worktree、自动提交、合并、同步
  browser.ts       无头 Chrome（截图、控制台、页面操作）
  log.ts           服务端日志
web/               React 界面（Vite）
shared/            前后端共享的类型和 logo 定义
tests/             单元、集成、浏览器和桌面应用测试
```

## 参与开发

架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)，开发流程、测试和代码风格见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。提交前运行：

```bash
npm run check
```
