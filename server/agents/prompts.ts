import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, Bot, Chat, ChatMessage, Project, Skill } from '../../shared/types';
import { DATA } from '../config';

export function memoryFile(botId: string) {
  return path.join(DATA.memory, `${botId}.md`);
}

export function readMemory(botId: string): string {
  try {
    return fs.readFileSync(memoryFile(botId), 'utf8');
  } catch {
    return '';
  }
}

export function appendMemory(botId: string, note: string) {
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(memoryFile(botId), `- ${date}：${note.replace(/\n+/g, ' ').trim()}\n`);
}

const PERMISSION_NOTE: Record<Bot['permission'], string> = {
  auto: '你可以自主修改文件和运行命令；标记为需要确认的操作会先请求用户批准。',
  edits: '你可以直接修改项目内的文件；大多数命令会先请求用户批准（常用的安全命令除外）。',
  ask: '你的每次修改和命令都需要用户批准，所以请把改动集中、说明清楚。',
  review: '你的操作由一位 AI 审查员实时把关，高风险操作会被拦下或转给用户确认。',
  plan: '你是只读角色：只能阅读和分析，不能修改文件或运行有副作用的命令。请把结论和方案直接写在回复里。',
};

/** Stable part of the system prompt, appended to Claude Code's own. */
export function buildSystemAppend(opts: { bot: Bot; chat: Chat; project: Project | null; team: Bot[]; skills: Skill[] }): string {
  const { bot, chat, project, team, skills } = opts;
  const lines: string[] = [];
  lines.push(`# 你的身份`);
  lines.push(
    `你是「${bot.name}」（${bot.title}），VibeCrew Web 开发小队的一员。VibeCrew 是运行在用户电脑上的 AI 机器人团队应用：用户像发短信一样和你们聊天，旁边有实时的网页预览、文件、终端面板。`,
  );
  lines.push('', '## 角色说明', bot.description.trim() || '（未填写，按通用 Web 开发助手工作）');

  const members = team.filter((b) => chat.botIds.includes(b.id));
  if (chat.kind === 'group') {
    lines.push('', `## 团队（群聊「${chat.title}」的成员）`);
    for (const m of members) lines.push(`- @${m.name}：${m.title}${m.id === bot.id ? '（你自己）' : ''}`);
    lines.push(
      '',
      '协作规则：',
      '- 群聊里用户和所有队友都能看到你的回复。',
      '- 需要队友接手时，在回复里写「@名字」并说清楚要做什么、改哪里、怎样算完成；系统会把消息转给对方。只在真正需要时 @，不要客套地 @ 人，也不要 @ 你自己。',
      '- 队友完成的工作不要重复做；有分歧时说明理由，必要时请用户决定。',
    );
  } else {
    lines.push('', '## 当前对话', '这是你和用户的单聊，其他队友看不到这里的消息。如果需要多人协作，可以建议用户建一个群聊。');
    const others = team.filter((b) => b.id !== bot.id);
    if (others.length) lines.push(`团队里的其他成员：${others.map((b) => `${b.name}（${b.title}）`).join('、')}。`);
  }

  lines.push('', '## 工作环境');
  if (project) {
    lines.push(`- 项目：${project.name}，目录 ${project.path}（就是你的工作目录）`);
    if (project.framework) lines.push(`- 技术栈：${project.framework}`);
  } else {
    lines.push('- 当前对话还没有绑定项目。');
  }
  lines.push(
    '- 你修改文件后，用户的预览会自动刷新（静态页面热刷新，框架项目由开发服务器热更新）。',
    '- VibeCrew 提供的工具（mcp__crew__*）：',
    '  - preview_screenshot：用真实浏览器截图查看页面效果（可选 desktop/tablet/mobile、整页、某个元素）。改完界面一定要看一眼。',
    '  - preview_console：打开页面收集控制台报错和失败的网络请求。',
    '  - browser_act：像用户一样操作页面（点击、输入、按键、跳转、断言文字），页面状态在多次调用间保留。',
    '  - dev_server：启动 / 停止 / 重启开发服务器、查看日志。预览依赖它。',
    '  - remember：把值得长期记住的事（用户偏好、项目约定、踩过的坑）写进你的长期记忆。',
    '  - notify_user：给用户发一条通知（例如定时任务里发现了问题）。',
    '- 不要用 Bash 直接运行 `npm run dev`、`vite`、`next dev` 这类常驻命令，用 dev_server 管理，它会自动接入预览。',
    `- 权限：${PERMISSION_NOTE[bot.permission]}`,
  );

  lines.push(
    '',
    '## 沟通方式',
    '- 用用户使用的语言回复（默认简体中文），像同事发消息一样简洁：先说结论或做了什么，再补充必要细节。',
    '- 做完一件事给出简短汇报：改了哪些文件、效果如何、有什么需要用户留意的。不要长篇大论，不要重复粘贴大段代码。',
    '- 遇到需要用户决定的事（会删除数据、对外发布或推送、花钱、方向性的选择），停下来问用户。',
    '- 用户消息里的 <selected_element>、<browser_console>、<recorded_steps> 等块，是用户在预览中选中的元素、捕获的控制台日志和录制的操作，请据此精确定位。',
  );

  if (skills.length) {
    lines.push('', '## 用户可以使用的技能（斜杠命令）');
    lines.push(skills.map((s) => `/${s.name} ${s.title}`).join('；'));
  }

  const memory = readMemory(bot.id).trim();
  lines.push('', '## 你的长期记忆', memory ? memory.slice(-6000) : '（还没有。遇到值得记住的事时用 remember 工具记下来。）');
  return lines.join('\n');
}

function attachmentBlock(a: Attachment): string | null {
  switch (a.kind) {
    case 'element': {
      const styles = Object.entries(a.styles || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      return [
        `<selected_element page="${a.page}">`,
        `selector: ${a.selector}`,
        a.component ? `component: ${a.component}` : '',
        a.source ? `source: ${a.source}` : '',
        a.text ? `text: ${a.text}` : '',
        `size: ${a.rect.w}×${a.rect.h} at (${a.rect.x}, ${a.rect.y})`,
        styles ? `styles: ${styles}` : '',
        `html: ${a.html}`,
        `</selected_element>`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'console':
      return [`<browser_console page="${a.page}">`, ...a.entries.map((e) => `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ''}`), `</browser_console>`].join('\n');
    case 'file':
      return `<file_reference path="${a.path}" />`;
    case 'recording':
      return [
        `<recorded_steps start_page="${a.page}">`,
        ...a.steps.map(
          (s, i) =>
            `${i + 1}. ${s.type}${s.selector ? ` ${s.selector}` : ''}${s.text ? ` 「${s.text}」` : ''}${s.value !== undefined ? ` = ${s.value}` : ''}${s.key ? ` key=${s.key}` : ''}${s.url ? ` → ${s.url}` : ''}`,
        ),
        `</recorded_steps>`,
      ].join('\n');
    default:
      return null;
  }
}

export function renderUserMessage(m: ChatMessage): string {
  if (m.role === 'system') return `【系统消息】${m.text}`;
  const blocks = (m.attachments || []).map(attachmentBlock).filter(Boolean) as string[];
  const images = (m.attachments || []).filter((a) => a.kind === 'image').length;
  const parts = [(m.prompt || m.text).trim()];
  if (images) parts.push(`（附带 ${images} 张图片）`);
  if (blocks.length) parts.push(blocks.join('\n\n'));
  return parts.filter(Boolean).join('\n\n');
}

/** The user-turn prompt: fresh context plus everything the bot has not seen yet. */
export function buildTurnPrompt(opts: {
  bot: Bot;
  chat: Chat;
  unseen: ChatMessage[];
  names: Map<string, string>;
  context: string[];
  trigger: ChatMessage['trigger'];
  routineName?: string;
}): string {
  const { bot, chat, unseen, names, context, trigger } = opts;
  const out: string[] = [];
  if (context.length) out.push(`<context>\n${context.join('\n')}\n</context>`);
  if (trigger?.type === 'routine') out.push(`【定时任务「${opts.routineName || ''}」自动触发，用户可能不在电脑前。完成后简要汇报；只有发现需要用户处理的问题时才用 notify_user。】`);
  if (chat.kind === 'dm' || unseen.every((m) => m.role !== 'bot')) {
    out.push(unseen.map(renderUserMessage).join('\n\n---\n\n') || '（继续）');
  } else {
    const lines = unseen.map((m) => {
      if (m.role === 'user') return `【用户】\n${renderUserMessage(m)}`;
      if (m.role === 'system') return `【系统】${m.text}`;
      return `【@${names.get(m.botId || '') || '队友'}】\n${m.text.trim() || '（没有文字回复）'}`;
    });
    out.push(`群聊「${chat.title}」中你上次发言之后的新消息：\n\n${lines.join('\n\n')}`);
    const by = trigger?.type === 'mention' && trigger.by ? names.get(trigger.by) : null;
    out.push(by ? `（${by} 在上面 @ 了你，${bot.name}，请处理与你相关的部分。）` : `（轮到你了，${bot.name}。）`);
  }
  return out.join('\n\n');
}
