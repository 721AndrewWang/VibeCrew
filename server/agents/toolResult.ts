// What Crew's own tool handlers return, before Claude Code sees it as an MCP tool result. The
// Router's, the Watchdog's, the background-job and the GitHub tools share it.

export type ToolResult = { text: string; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export const ok = (text: string): ToolResult => ({ text });
export const fail = (text: string): ToolResult => ({ text, isError: true });

/** A string argument, or '' for anything else the model sent. */
export const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** A finite number argument, or undefined. */
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A handler's result as an MCP tool result. */
export const mcpResult = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], isError: r.isError || undefined });
