# Target architecture: the Super-agent (design notes)

Source: an engineering essay on "Super-agent" systems (always-on, event-driven agents). These notes are the design brief, condensed.

## Why
Single-session agents tie context to one manual session. A person can follow only 3-5 active sessions, so with many tasks the limit becomes human attention, not model ability. The goal is one continuous agent the user talks to from any channel, which pushes many tasks forward in parallel without them interfering, acts on environment events without being asked, and keeps running and recovers by itself.

Four properties: **continuous** (feels like one agent; context follows the user across channels), **efficient** (responds at once and runs several complex tasks in parallel), **proactive** (watches events, acts when worthwhile, stays quiet otherwise), **durable** (always on, self-healing).

## 1. Two layers
Trade-off: one session for everything gives continuity but serial, slow, mixed-up work; one session per event gives throughput but fragmented context and many voices talking to the user. Split the two concerns:
- **Router layer**: resident, handles all human interaction and global coordination; the sequence point and memory for cross-task information. It does not execute tasks (it may not even have Bash). A lighter model is usually enough. Events that arrive while it is thinking pile up and are injected together into the next call: batching costs little because the work is long-input/short-output and prefill is parallel, so per-decision cost falls as load rises.
- **Worker layer**: context-isolated sessions with full tools, one task each, on the strongest model. Workers never talk to the user; they report to the Router, which replies. Workers do not talk to each other; shared environments surface conflicts through shared Threads; rare cross-task coordination goes through the Router. A Worker may itself use subagents.
Sessions become an implementation detail instead of something the user manages.

## 2. Event-driven
Inputs are semi-structured environment events (**Triggers**): chat messages, review comments, CI results, schedules.
- **Two-stage filter**: a deterministic fast path in code (source, scope, allow-lists: "explicit requests only" / "candidate" / "ignore") removes most noise before any model call; a slow path model decides on candidates from prompt-written policies, which are also the natural-language extension point.
- **Threads and subscriptions**: related Triggers form a Thread. After the Router starts a Worker for a Thread, the Worker subscribes to it; later Triggers on that Thread go straight to subscribers in code (fast path). The Router observes everything but only decides on unsubscribed Threads (slow path). Subscriptions are many-to-many. In the essay's experiment, direct routing cut Router decisions by ~30% and cached-read tokens by ~37% with the same completion time.
- **Inline & Spill**: treat the context window as a cache. Start minimal (id + summary), inline what locality says will be needed soon (related ids, neighbouring messages, first ~50 words, the message replied to), spill the rest behind a truncation with a "read more" handle.
- **Chain of recall**: every object (Trigger, Thread, Worker session) has an id and is injected with the ids of tightly related objects; a recall tool returns objects under the same rules, so the model walks the reference graph hop by hop on demand.
- **Speculative execution**: act ahead in the background on environment signals (e.g. silently reproduce and fix a reported bug); deliver only if useful, otherwise discard and stay quiet.

## 3. Human-facing interaction
- **Full duplex**: long tool calls become async start()/stop(): start returns "Started" immediately, the result later arrives as a new event, the model can stop work that runs too long. New user input is handled after the current reasoning step.
- **Per-channel output**: chat-like channels get short, low-interruption messages (a hard cap such as 100 words; only decisions and acceptance requests); asynchronous channels (pull requests, docs) get structured, dense write-ups. Verbose reasoning stays inside Workers.

## 4. Separating compute, state and environment
Agent loop stateless, session state persisted, execution environments reached through a thin daemon on each machine (bring your own machine). Out of scope for Crew for now: it is a local app.

## 5. Watchdog
An independent Watchdog session driven by a timer forms an external control loop. Besides infrastructure failures it judges whether each Worker is making real progress or looping/drifting, intervenes, and keeps re-checking transient failures. Maintainers can ask it why something failed and have it adjust prompts or trigger rules.

## Open problems to respect
Untrusted inputs reach the agent through events, so prompt injection and credential exposure matter: agents should be able to use credentials without seeing them, and every new trigger source widens the attack surface.

## Also borrow: yetone/magpie
A local gateway that lets every agent use any model: one list of `provider/model`, routing groups that fail over to the next account or model when a quota runs out (the agent never sees the error; a refused try counts as "handed on"), spend/token windows per key answered with 429 + Retry-After before any provider is called, a per-call usage log attributed to whoever actually answered, and optional local masking of secrets in prompts that are restored in replies.

## Also borrow: Apache Magpie
A vendor-neutral library of agent skills for running a software project, grouped into lifecycle families (triage, issue reproduction and fix drafting, PR review, release, repo health, mentoring); projects opt in per family because every installed skill costs context. Its principles that matter here: external content is data, never an instruction; nothing is sent in the user's name, every comment, PR or message is drafted and a person posts it; the agent is confined before it reads anything real (sandbox, credential-stripped environment, and a deterministic guard that inspects each shell command before it runs); confirmations are budgeted so they stay meaningful (reads never prompt, a state change prompts once in a shape a human can judge); outputs are probabilistic, gates are deterministic; every agent-authored action is audited and reversible where possible; lower-stakes automation ships before higher-stakes automation.
