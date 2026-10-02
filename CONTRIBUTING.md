# 参与开发

先读 [ARCHITECTURE.md](ARCHITECTURE.md)，了解各个部分怎么配合。

## 准备

- Node 24（见 `.nvmrc`，最低 22.12）。Linux 上还要有 C/C++ 编译工具，node-pty 需要现场编译。
- 已安装 Google Chrome：浏览器测试直接用它，不另外下载浏览器。其他位置的 Chrome 用 `CREW_CHROME_PATH` 指定。
- 可选：安装 Claude Code 命令行（`claude`）。没装的话，驱动真实命令行的那几个集成测试会自动跳过。

```bash
npm install
npm run dev        # 服务 + Vite，打开 http://localhost:5173
```

开发界面时可以加 `CREW_FAKE_AGENT=1`，用脚本模拟机器人，不调用模型。

## 常用命令

| 命令 | 做什么 |
| --- | --- |
| `npm run typecheck` | 类型检查：服务、界面、测试 |
| `npm run lint` | Biome：检查格式和 lint，不改文件 |
| `npm run format` | Biome：格式化，并应用安全的自动修复 |
| `npm test` | 单元测试和集成测试（Vitest） |
| `npm run test:e2e` | 浏览器端到端测试（Playwright，会先构建界面） |
| `npm run test:desktop` | 打包桌面版，然后测试它（慢，只在改了 `desktop/` 时跑） |
| `npm run check` | 类型检查 + lint + `npm test`，提交前跑这个 |
| `npm run ci` | `check` 加上端到端测试，和 CI 跑的一样 |

## 测试

```
tests/
  unit/         纯函数：权限规则、logo、界面工具函数、日志
  integration/  启动真实的服务（演示模式或真实 claude + 本地假模型接口），通过 HTTP 测试
  e2e/          在 Chrome 里操作界面
  desktop/      启动打包好的桌面应用
  helpers/      startServer、假模型接口、git 工具
```

- **不能碰真实数据。** `startServer()` 会给每个服务一个临时的 `CREW_HOME`，并清掉 `CLAUDE*`、`ANTHROPIC_*`、`CREW_*` 环境变量。自己新写的测试也要这样做。
- 需要模型回复时，用 `tests/helpers/mockProvider.ts` 起一个本地的 Anthropic 兼容接口，把真实的 `claude` 命令行接过去。不需要账号或 Key，也不会产生费用。
- e2e 测试用 `tests/e2e/fixtures.ts` 里的 `crew` fixture，每个测试一个独立的服务。页面上出现报错，测试就算失败。用 `openChat(page, crew, id)` 通过地址打开对话，用 `.chat-item[data-chat="<id>"]` 点侧边栏里的对话，别按标题文字匹配（标题可能互相包含）。
- 修 bug 时先写一个能复现它的测试。

## 代码风格

- 格式和 lint 都交给 Biome（`biome.jsonc`）：单引号、两个空格缩进、行宽 200。不要用 Prettier，它会按 80 列重排整个文件。
- 关掉某条规则要写原因：全局关掉的写在 `biome.jsonc` 里；只关一处的用 `// biome-ignore lint/<规则>: <原因>`。
- 注释少而准：写「为什么」，不写「做了什么」。
- 服务端的诊断输出用 `server/log.ts`：`const log = logger('模块名')`，不要直接用 `console.*`。日志多少由 `CREW_LOG_LEVEL` 控制。
- 界面上给用户看的文字用中文；代码、注释、提交信息用英文。
- 界面是黑白灰的：用线条图标（lucide），不用彩色 emoji。

## 改存储格式

存储在 `~/.crew` 下的 JSON 有版本号（`settings.json` 的 `schemaVersion`）。改了格式就这样做：

1. 在 `server/migrations.ts` 的 `MIGRATIONS` 里加一条，`version` 比上一条大 1，`run(home)` 直接改文件（启动时各个 store 还没读文件）。
2. 给它写一个单元测试：准备旧格式的目录，跑 `migrate`，断言新格式。
3. 读取旧字段的兼容代码可以删掉，迁移已经保证了格式。

迁移前会自动备份 JSON 文件到 `~/.crew/backups/`。

## 提交

- 一个提交只做一件事。提交信息用英文祈使句，标题不超过 72 个字符，需要的话空一行写正文，讲清楚为什么改。
- 提交前跑一遍 `npm run check`。
- 用户能感觉到的变化，记到 [CHANGELOG.md](CHANGELOG.md) 的「未发布」下面。

## 发版

1. 把 CHANGELOG 里「未发布」的内容挪到新版本号下面，写上日期。
2. `npm version <patch|minor|major> --no-git-tag-version`，提交，再打 `v<版本号>` 标签并推送。
3. 推送标签后，GitHub Actions 的 Release 流程会构建 AppImage、挂到 GitHub Release 上，发布说明取自 CHANGELOG 里对应的那一节（标签必须和 package.json 的版本一致）。
4. 本机要用新版的话 `npm run desktop:install`。
5. 发布后可以验证 GitHub 打的包：下载 `Crew-<版本>.AppImage`，`--appimage-extract` 解包，然后 `CREW_DESKTOP_EXE=<解包目录>/squashfs-root/crew npx playwright test -c tests/desktop/playwright.config.ts`。
