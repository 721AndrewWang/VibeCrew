// Claude Code may defer MCP tools behind its ToolSearch tool (a placeholder in the tool list, the
// tool loaded on demand). Crew's own servers set alwaysLoad, so their tools are always on offer. The
// Router and the Watchdog have no other tools at all (ADR 002, ADR 006): for them tool search only
// adds a placeholder tool, so it is turned off in their environment and their tool list is exactly
// their crew_router / crew_watchdog tools.
export const NO_TOOL_SEARCH: Record<string, string> = { ENABLE_TOOL_SEARCH: 'false' };
