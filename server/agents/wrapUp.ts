// Inside one turn every tool call re-reads the whole context, so a long task gets dearer with each
// step: most of Crew's cache cost came from a few turns of 100+ calls that grew past 200k tokens.
// Past a size the bot is asked, once and then again every WRAP_UP_AGAIN tokens, to finish the step
// in hand and hand back with a summary; its next turn starts a new session from that summary.

/** After the first reminder, the next one comes this many tokens later. */
export const WRAP_UP_AGAIN = 40_000;

/** The reminder to add after a tool call, or null. `remindedAt` is the size at the last one this turn. */
export function wrapUpNote(used: number, limit: number, remindedAt: number | null): string | null {
  if (!(limit > 0) || used < limit) return null;
  if (remindedAt !== null && used < remindedAt + WRAP_UP_AGAIN) return null;
  const k = Math.round(used / 1000);
  if (remindedAt !== null) return `【Crew】这一轮的上下文已经到 ${k}k token，请现在就收尾：写下做完了什么、还剩什么、下一步从哪里开始，然后结束这一轮。`;
  return [
    `【Crew】这一轮的上下文已经到 ${k}k token。之后每调用一次工具都要把整段上下文重读一遍，越往后越贵。请把手上这一步做完就收尾，不要再开新的子任务：`,
    '1. 确认改动都已保存；做到一半的地方说清楚停在哪里。',
    '2. 用一条回复写清：做完了什么、还剩什么、下一步从哪里开始（文件、命令、要注意的地方）。',
    '3. 群聊里照常交回（@ 负责人或接手的人）；单聊里告诉用户回一句就能接着做。',
    '下一轮会换成新会话，带上最近的消息，从你的总结接着做。',
  ].join('\n');
}
