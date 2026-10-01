import type { Skill } from '../../shared/types';

type BuiltinSkill = Omit<Skill, 'builtin' | 'updatedAt'>;

/**
 * Built-in slash commands. `{{args}}` is replaced by whatever the user types after the command.
 * Users can override any of these from the Skills page.
 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: 'landing',
    title: '生成落地页',
    icon: '🚀',
    argsHint: '产品或主题描述',
    description: '从零做一个完整、精美、响应式的落地页',
    body: `为「{{args}}」制作一个精美、完整的落地页。

要求：
1. 先快速看一下项目结构和技术栈；没有框架就用纯 HTML/CSS/JS，有框架就遵循现有写法。
2. 包含：导航栏、Hero（主标题 + 副标题 + 主次 CTA）、卖点/功能区、社会证明（用户评价或 logo 墙）、价格方案、FAQ、页脚。文案要具体，不要 lorem ipsum。
3. 视觉：现代、克制、层次清晰；统一的配色、字号和间距体系；适度的动效（hover、滚动淡入），并尊重 prefers-reduced-motion。
4. 响应式：手机、平板、桌面都要好看。可访问性：语义化标签、足够的对比度、图片 alt、键盘可用。
5. 完成后用 preview_screenshot 分别检查 desktop 和 mobile，修正发现的问题，再简要汇报。`,
  },
  {
    name: 'component',
    title: '创建组件',
    icon: '🧩',
    argsHint: '组件描述，如：带搜索的下拉选择框',
    description: '按项目现有风格实现一个可复用组件',
    body: `实现组件：{{args}}

要求：
- 遵循项目现有的框架、目录结构、命名和样式方案。
- 组件要可复用：合理的 props/参数、默认值、受控/非受控（如适用）。
- 覆盖交互状态：hover、focus（可见的焦点样式）、disabled、loading、空状态、错误状态。
- 可访问性：正确的语义与 ARIA、键盘操作。
- 在一个现有页面（或新建的演示页）里放一个使用示例，用 preview_screenshot 确认效果。`,
  },
  {
    name: 'responsive',
    title: '响应式检查',
    icon: '📱',
    argsHint: '页面路径（可选，默认当前页面）',
    description: '在手机/平板/桌面三种尺寸下截图检查并修复布局问题',
    body: `对页面 {{args}} 做响应式检查并修复问题（没写路径就检查当前预览页面和首页）。

步骤：
1. 分别用 preview_screenshot 以 mobile、tablet、desktop 三种设备截图（必要时 fullPage）。
2. 找出问题：横向滚动/溢出、文字过小或挤压、按钮点击区域太小、图片变形、元素重叠、导航在手机上不可用、间距失衡等。
3. 逐个修复（优先用流式布局、clamp()、合适的断点），再次截图确认。
4. 汇报：每个尺寸发现了什么、改了什么。`,
  },
  {
    name: 'fix-console',
    title: '修复控制台报错',
    icon: '🩺',
    argsHint: '页面路径（可选）',
    description: '打开页面收集控制台错误和失败请求，逐个修复',
    body: `检查并修复预览页面的控制台问题。页面：{{args}}（没写就检查当前页面和首页）。

1. 用 preview_console 打开页面，收集错误、警告和失败的网络请求。
2. 按影响排序，找到根因并修复（不要用 try/catch 吞掉错误来“修复”）。
3. 重新运行 preview_console 确认问题消失，且没有引入新问题。
4. 汇报修复了哪些问题、各自的原因。`,
  },
  {
    name: 'polish',
    title: '界面精修',
    icon: '💅',
    argsHint: '要精修的页面或区域（可选）',
    description: '打磨间距、字体、对齐、配色和微交互，让界面更有品质感',
    body: `对 {{args}}（没写就是当前预览页面）做一轮界面精修。

先用 preview_screenshot 仔细观察，然后改进：
- 间距节奏：统一的间距刻度，区块之间留白充足，元素对齐。
- 字体排版：清晰的字号层级、合适的行高和字重、中文与英文数字的搭配。
- 配色：主色克制使用，文本对比度达标，边框/分割线柔和。
- 细节：圆角与阴影一致、按钮和链接有 hover/active/focus 状态、过渡动画自然。
- 保持现有功能和结构不变。
改完再截图对比，列出主要改动。`,
  },
  {
    name: 'dark-mode',
    title: '添加暗色模式',
    icon: '🌙',
    argsHint: '',
    description: '基于 CSS 变量实现浅色/暗色主题和切换按钮',
    body: `为项目添加暗色模式。{{args}}

- 把颜色整理成 CSS 变量（或项目已有的主题方案，如 Tailwind 的 dark: 变体）。
- 默认跟随系统 prefers-color-scheme，并提供一个切换按钮，选择保存在 localStorage，首屏不闪烁。
- 检查所有页面在暗色下的对比度、图片/图标、阴影和边框。
- 用 preview_screenshot 查看两种主题下的效果。`,
  },
  {
    name: 'a11y',
    title: '可访问性审查',
    icon: '♿',
    argsHint: '页面路径（可选）',
    description: '检查并修复语义、对比度、键盘操作、ARIA 等问题',
    body: `对 {{args}}（没写就是当前页面）做可访问性审查并修复。

检查：语义化标签与标题层级、图片 alt、表单 label 与错误提示、颜色对比度（WCAG AA）、键盘可操作性与可见的焦点样式、ARIA 使用是否正确、动效与 prefers-reduced-motion、页面 lang 属性。
先列出问题（按严重程度），再逐一修复，最后说明还有哪些需要人工确认的地方。`,
  },
  {
    name: 'seo',
    title: 'SEO 优化',
    icon: '🔎',
    argsHint: '网站主题/关键词（可选）',
    description: 'meta、Open Graph、结构化数据、语义结构、性能相关 SEO',
    body: `为网站做 SEO 优化。补充信息：{{args}}

- 每个页面的 title、description、canonical；Open Graph 和 Twitter Card；favicon。
- 合理的标题层级（每页一个 h1）、语义化结构、图片 alt、友好的链接文字。
- 适合的 JSON-LD 结构化数据（Organization / WebSite / Product / FAQ 等按需）。
- robots.txt 和 sitemap.xml（静态站点可直接生成）。
- 列出改动，以及需要用户补充的真实信息（域名、品牌名等）。`,
  },
  {
    name: 'perf',
    title: '性能优化',
    icon: '⚡',
    argsHint: '重点页面（可选）',
    description: '找出加载和运行时的性能瓶颈并优化',
    body: `对项目做一轮性能优化。重点：{{args}}

检查并优化：图片（尺寸、格式、懒加载、宽高占位防止布局偏移）、字体加载、首屏关键资源、JS 体积与拆分、不必要的重渲染或重排、第三方脚本、缓存策略。
先说明发现的主要瓶颈和预期收益，再动手；改完用 preview_console 确认没有报错。`,
  },
  {
    name: 'clone-ui',
    title: '按图还原界面',
    icon: '🖼️',
    argsHint: '补充说明（请同时附上截图/设计稿）',
    description: '根据附带的截图或设计稿高保真还原页面',
    body: `请根据我附带的截图/设计稿，高保真地实现这个界面。{{args}}

- 仔细观察布局结构、间距、字号、字重、颜色、圆角、阴影和图标，尽量 1:1 还原。
- 用项目现有技术栈实现，结构语义化，并做好响应式（设计稿没给的尺寸按合理方式适配）。
- 实现后用 preview_screenshot 截图，与设计稿逐区域对比，至少迭代一轮修正差异。`,
  },
  {
    name: 'e2e',
    title: '编写端到端测试',
    icon: '🧪',
    argsHint: '要测试的用户流程',
    description: '为关键流程编写并运行 Playwright 测试',
    body: `为以下流程编写端到端测试：{{args}}

- 如果项目还没有 Playwright，先安装并创建最小配置（baseURL 指向开发服务器）。
- 优先使用基于角色和文字的定位（getByRole、getByText），少用脆弱的 CSS 选择器。
- 覆盖正常路径和至少一个异常路径。
- 运行测试直到通过；如果发现的是产品 bug，说明问题并 @相关队友，而不是改测试去迁就 bug。`,
  },
  {
    name: 'challenge',
    title: '对抗审查',
    icon: '⚖️',
    argsHint: '重点（可选）',
    description: '让 Skeptic 只看需求和改动，尽力证伪；可以作为合并前的门槛',
    body: `@Skeptic 对当前的改动做一次对抗审查：尽力证明它是错的，只认能复现的反例。重点：{{args}}（没写就按你的流程全面试）。`,
  },
  {
    name: 'review',
    title: '审查改动',
    icon: '🔍',
    argsHint: '范围（可选，默认未提交的改动）',
    description: '审查最近的改动，找出 bug、安全和可维护性问题',
    body: `审查代码改动。范围：{{args}}（没写就审查 git 中未提交的改动；不是 git 仓库就审查最近修改的文件）。

关注正确性、边界情况、安全（XSS、注入、密钥泄露）、性能、可访问性、一致性和可维护性。
按「必须修复 / 建议 / 可选」分组列出，每条带文件和行号、问题说明和修改建议。先不要直接改代码。`,
  },
  {
    name: 'commit',
    title: '整理并提交',
    icon: '📦',
    argsHint: '提交说明（可选）',
    description: '检查改动，写清晰的提交信息并 git commit',
    body: `把当前改动整理成提交。补充说明：{{args}}

1. 运行 git status 和 git diff 了解改动；如果不是 git 仓库，先询问我是否要 git init。
2. 确认没有误加的文件（node_modules、.env、构建产物、大文件等），必要时补充 .gitignore。
3. 如果改动包含几件不相关的事，按主题拆成多个提交。
4. 使用清晰的提交信息（简洁的标题 + 必要的说明），然后提交。
5. 不要 push，除非我明确要求。`,
  },
  {
    name: 'explain',
    title: '讲解项目',
    icon: '📖',
    argsHint: '想了解的部分（可选）',
    description: '梳理项目结构、技术栈、数据流和运行方式',
    body: `帮我快速理解这个项目。重点：{{args}}

说明：技术栈与依赖、目录结构、页面/路由、关键组件与数据流、如何运行和构建、值得注意的问题或技术债。尽量简洁，用列表，关键处给出文件路径。不要修改任何文件。`,
  },
];
