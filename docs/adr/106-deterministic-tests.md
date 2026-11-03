# ADR 106: Deterministic, faster tests

Status: accepted (test suite only: no change to Crew itself)

## Context

On the integrated branch (ADR 011) `npx vitest run` passed most of the time, took about 225 s on a 4-CPU machine, and failed now and then for reasons that had nothing to do with the code under test. Running the untouched base repeatedly, under the default settings and under more parallel load, and reading every fixed wait in `tests/`, turned up four kinds of cause:

1. **Assertions on the installed CLI's whole tool list.** Three real-CLI tests compared the tools a request offered with an exact list: the Router is offered nothing but its own tools (`two-layer`), the slow path's and the shadow router's bare calls are offered none (`triggers`, `routing`). A newer Claude Code adds tools of its own (`DeferredToolPlaceholder`, `ToolSearch`), and those three fail with it although Crew did nothing different. Four more (`prompt-slimming`, `recall-cli`, `learn-skills`, `channel-norms`) picked "the bot's own request" as "the request that offers any tool", which a side call with a placeholder tool would also match.
2. **A test clock that tests could outrun.** `shiftClock(ms)` wrote the offset to a file the server reads every 50 ms and returned at once; tests slept 200 ms after moving the clock forward and nothing after moving it back. In `wave2-seams`, the test after the stuck-Worker test moved the clock back and at once polled GitHub: when that poll still ran on the clock ten minutes ahead, the poller's cursor was saved ten minutes in the future, so a comment posted by a later test read as already seen and was never published. "settles a GitHub-channel Worker a restart cut off" then timed out after 20 s: once in 4 full runs, twice in 5 full runs at 12 workers, and in 2 of 6 runs of the file under parallel load. (Commit bb065d9 had made that test poll until the comment shows up, which could not help: the comment was never going to show up.)
3. **Teardown races.** `stop()` sent SIGTERM to the server's process group, waited up to 10 s for it and removed the folder whether it was gone or not, with retries. Commands Crew runs in groups of their own (background jobs, dev servers, setup and check commands) were never waited for, and a Claude Code session still flushing its transcript made the removal fail with `ENOTEMPTY`. Commit bcfaa19 added the retries; four files also slept 1-3 s in `afterAll`, or removed the folder themselves and swallowed the error.
4. **Fixed sleeps standing in for events.** The 30 s start-up limit was 120 polls of 250 ms. Tests slept for a debounced save before a crash (600 ms), for the file watcher to start (1.5 s), for a turn to reach its first step (800 ms, 2.5 s), and 4.5 s for the 4 s after a turn in which file changes count as the bots' own. Under load the last one failed for a different reason: `injection`'s outside-edit case waited for *any* outside-edit notice, so when an unrelated one was already in the chat it went on at once, started the bot's turn, and its own edit then arrived while the project was busy, was taken for the bot's own and never reached the model (1 of 4 runs at 12 workers).

## Decision

Fix each cause where it is, in the test helpers and the tests; change nothing in Crew.

| Cause | Fix | Where |
| --- | --- | --- |
| 1. Tool lists | Assert on what Crew controls: the MCP tools it adds (`mcpTools`), and that none of Claude Code's acting tools (`actingTools`: Bash, Read, Edit, Write, …) reach a session Crew starts without built-in tools. Pick the bot's own request by "offers Crew's tools" (`fromCrewSession`). The Router test still requires its three tools and no other MCP tool; it no longer fails on a placeholder the CLI adds. | `tests/helpers/mockProvider.ts`; `two-layer`, `triggers`, `routing`, `prompt-slimming`, `recall-cli`, `learn-skills`, `channel-norms` |
| 2. Test clock | The preloaded clock acknowledges each offset it takes in `<file>.ack`; `shiftClock()` is async and resolves once the acknowledgement matches. Both files are written whole (rename). The sleeps after moving the clock are gone. | `tests/helpers/clock.ts`, `tests/helpers/server.ts`; `super-agent-flow`, `wave2-seams` |
| 3. Teardown | Each server's environment carries `CREWTEST_ROOT=<its folder>`, which Crew passes on to everything it starts (`cleanEnv` drops only `CREW_*` and credentials). `stop()` lets the server shut down on SIGTERM (5 s), then kills whatever still carries the marker, is in its process group or descends from either, and waits until all of it has exited (reading `/proc`; elsewhere the group alone); only then is the folder removed, without retries. It throws, naming the processes, if they would not exit. `kill()` still takes down the group only, as a crash does, so restart tests keep their orphans for the restarted server to find. Servers still running when a test file's worker exits are killed. The `afterAll` sleeps and swallowed removals are gone. | `tests/helpers/server.ts`; `github-channel`, `speculative`, `wave2-seams`, `injection` |
| 4. Fixed sleeps | Start-up waits for the `Local:` line and for the process's exit as events, and fails after 50 s (below the 60 s hook timeout) with the server's output. The tests wait for the state they mean: the context size in `chats.json` before a crash (`rotation`); a probe under `.claude/` reported by the watcher's `files_changed` event (`outside-edits`); the turn's first finished tool call (`super-agent-flow`, `full-duplex`); the outside-edit notice that quotes the test's own payload (`injection`). The 4 s "the bots' own" window is crossed with the test clock instead of 4.5 s of real time (`injection`, `triggers`). In `wave2-seams`, a 9 s sleep that checked a cut-off command never makes its late write now ends when the command's process group is gone (already waited for), since nothing of it can write after that; a 1.5 s sleep after an awaited poll is gone. | the tests named |
| Speed | Test files run three per CPU, at most one per GB of memory and at most 16 (`vitest.config.ts`): an integration file spends most of its time waiting on its server, the demo agent's pacing or Claude Code. `--maxWorkers` overrides it. | `vitest.config.ts` |

Sleeps that remain check that something does **not** happen (no further message after a Stop, no `gh` call while the channel is off, no model call from a switched-off feature): there is no event for nothing happening, and a slow machine only makes them pass more surely. Two `say()` helpers (`stall`, `auto-challenge`) still wait 1.5 s and 0.8 s after the chat goes idle, for the tail of a chain (a stall wake-up or Skeptic being brought in) that Crew enqueues after the bot's status is already idle; the API has no signal for "the chain is over", and adding one is a change to Crew, left for later.

## Results

Same machine (4 CPUs, 16 GB), the installed Claude Code 2.1.317, `npx vitest run` (925 tests pass, the 3 sandbox tests skip: bubblewrap and socat are not installed).

| | Base (`superagent-wave2`) | After |
| --- | --- | --- |
| Wall-clock, default settings | 221-229 s (4 runs, mean 225 s; 3 workers) | 61-66 s (5 runs, mean 64 s; 12 workers) |
| Wall-clock, 3 workers (`--maxWorkers=3`) | 221-229 s | 192 s (1 run) |
| Red runs, default settings | 1 of 4 (`wave2-seams`) | 0 of 5 |
| Red runs at 12 workers (`--maxWorkers=12`) | 2 of 5 (`wave2-seams` both times) | 0 of 5 |
| Tests that fail with a CLI that adds a placeholder tool | 3 | 0 |
| Tests found flaky or fragile (causes 1-4) | 6 that failed (3 on a newer CLI, 1 in `wave2-seams`, 2 in `injection`, the second depending on the first), and 4 teardowns relying on sleeps and retries | 0 seen |

The placeholder row was measured by making the mock provider list an extra `DeferredToolPlaceholder` on every request (a local change, not committed) and running the real-CLI files with the old and the new assertions.

Where the time went: a server starts in about 0.6 s and stops in about 25 ms, so per-file fixtures are not the cost; the demo agent's pacing (25 ms per streamed chunk, 300 ms per tool call) and real Claude Code turns are. Removing fixed sleeps saves about 30 s of serial time; running files in parallel saves the rest. The longest files (`learn-skills`, `workspaces`, `full-duplex`, `subscriptions`, about 30-36 s each under load) now bound the wall-clock.

## Not changed

- No test was skipped, weakened or deleted; no dependency was added. `tests/integration/sandbox.test.ts` is unchanged (its three tests skip here: bubblewrap and socat are not installed, so Crew reports the sandbox unavailable).
- Crew's code is unchanged. The demo agent's pacing stays as it is: speeding it up would shrink the windows in which tests stop a turn or send a message mid-turn.

## Left for later

- A "chain is over" signal (for example a chat's busy state in `/bootstrap`) would let the `stall` and `auto-challenge` helpers wait for the event instead of 1.5 s and 0.8 s.
- Several unit tests leave small folders in the temp directory (`crew-migrate-*`, `crew-spec-*`, `crew-jsonl-*`, `crew-trace-*`, `crew-friction-*`, about 14 per run).
- Splitting the four longest integration files would bring the wall-clock down further on machines with many CPUs.
- Default bots enable the `context7` plugin, so real-CLI tests start `npx -y @upstash/context7-mcp`, which needs the network; it has not failed a test here, but it is outside the tests' control.
