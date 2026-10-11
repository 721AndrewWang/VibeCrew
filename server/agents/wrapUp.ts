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
  if (remindedAt !== null) return `[Crew] This turn's context has reached ${k}k tokens. Wrap up now: write down what is done, what is left, and where the next step starts, then end this turn.`;
  return [
    `[Crew] This turn's context has reached ${k}k tokens. From here on, every tool call re-reads the whole context, so each one costs more than the last. Finish the step in hand and wrap up; do not start new subtasks:`,
    '1. Make sure all changes are saved. If something is half done, say exactly where you stopped.',
    '2. In one reply, write down what is done, what is left, and where the next step starts (files, commands, things to watch for).',
    '3. In a group chat, hand back as usual (@ the lead or whoever takes over). In a direct chat, tell the user a one-line reply is enough to continue.',
    'The next turn starts a new session with the recent messages and picks up from your summary.',
  ].join('\n');
}
