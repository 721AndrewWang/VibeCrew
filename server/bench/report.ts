// The bench's HTML report (ADR 101): one self-contained file, charts drawn as inline SVG, no script
// and nothing loaded from elsewhere. Hovering a mark shows its value (an SVG <title>); every chart's
// numbers are also in the tables below it. Colours follow the configuration, never its rank.

import type { BenchResult } from './index';
import type { ConfigSummary } from './metrics';
import { ROLES } from './session';
import type { ConfigId } from './sim';

const SLOT: Record<ConfigId, string> = { 'super-agent': 'a', 'no-direct': 'b', 'single-neutral': 'c', 'single-delegate': 'd' };

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/** "(a) Super-agent" -> "(a)": the legend names them. */
const short = (label: string): string => label.split(' ')[0];

/** Tick labels: short, but 0.25 stays 0.25. */
const tick = (n: number) => (Math.abs(n) >= 1000 ? fmt(n) : String(Math.round(n * 100) / 100));

const signed = (n: number | null, unit: string) => (n === null ? '–' : `${n > 0 ? '+' : ''}${n}${unit}`);

/** Round tick values covering [0, max]. */
export function ticks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(Math.round((out[out.length - 1] + step) * 1e6) / 1e6);
  return out;
}

interface Bar {
  config: ConfigId;
  label: string;
  value: number | null;
}

/** A horizontal bar chart, one bar per configuration: bars start at zero, values at their ends. */
export function barChart(title: string, unit: string, bars: Bar[]): string {
  const W = 360;
  const left = 36;
  const right = 52;
  const row = 26;
  const top = 8;
  const H = top + bars.length * row + 26;
  const max = Math.max(0, ...bars.map((b) => b.value ?? 0));
  const tk = ticks(max, 3);
  const x = (v: number) => left + ((W - left - right) * v) / tk[tk.length - 1];
  const grid = tk
    .map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - 22}"/><text class="tick" x="${x(t)}" y="${H - 8}" text-anchor="middle">${esc(tick(t))}</text>`)
    .join('');
  const marks = bars
    .map((b, i) => {
      const y = top + i * row + 5;
      const h = 14;
      const label = `<text class="cat" x="${left - 8}" y="${y + h / 2 + 4}" text-anchor="end">${esc(b.label)}</text>`;
      if (b.value === null) return `${label}<text class="val" x="${left + 4}" y="${y + h / 2 + 4}">no data</text>`;
      const x1 = Math.max(x(b.value), left + 1);
      const r = Math.min(4, (x1 - left) / 2);
      const path = `M${left},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + h - r} Q${x1},${y + h} ${x1 - r},${y + h} H${left} Z`;
      return `${label}<path class="f-${SLOT[b.config]}" d="${path}"><title>${esc(`${b.label}: ${fmt(b.value)} ${unit}`)}</title></path><text class="val" x="${x1 + 6}" y="${y + h / 2 + 4}">${esc(fmt(b.value))}</text>`;
    })
    .join('');
  return figure(title, unit, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}<line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${H - 22}"/>${marks}</svg>`);
}

export interface Series {
  config: ConfigId;
  name: string;
  points: [number, number][];
  /** Draw a line through the points (else only markers). */
  line?: boolean;
  step?: boolean;
  markers?: boolean;
  /** Per-point hover text. */
  tips?: string[];
}

/** A line or scatter chart with one y-axis, starting at zero. */
export function xyChart(o: { title: string; unit: string; xLabel: string; yLabel: string; series: Series[]; xMax?: number; yMax?: number }): string {
  const W = 640;
  const H = 300;
  const m = { l: 56, r: 120, t: 12, b: 44 };
  const all = o.series.flatMap((s) => s.points);
  if (!all.length) return figure(o.title, o.unit, '<p class="note">No data.</p>');
  const xt = ticks(o.xMax ?? Math.max(...all.map((p) => p[0])), 5);
  const yt = ticks(o.yMax ?? Math.max(...all.map((p) => p[1])), 4);
  const X = (v: number) => m.l + ((W - m.l - m.r) * v) / xt[xt.length - 1];
  const Y = (v: number) => H - m.b - ((H - m.t - m.b) * v) / yt[yt.length - 1];
  const grid = [
    ...yt.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(tick(t))}</text>`),
    ...xt.map((t) => `<text class="tick" x="${X(t)}" y="${H - m.b + 16}" text-anchor="middle">${esc(tick(t))}</text>`),
    `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`,
    `<text class="axis-label" x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">${esc(o.xLabel)}</text>`,
    `<text class="axis-label" transform="translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">${esc(o.yLabel)}</text>`,
  ].join('');
  const labels: { y: number; s: Series }[] = [];
  const marks = o.series
    .map((s) => {
      const k = SLOT[s.config];
      let out = '';
      if (s.line && s.points.length > 1) {
        const d = s.points
          .map((p, i) => {
            if (i === 0) return `M${X(p[0])},${Y(p[1])}`;
            return s.step ? `H${X(p[0])} V${Y(p[1])}` : `L${X(p[0])},${Y(p[1])}`;
          })
          .join(' ');
        out += `<path class="k-${k} line" d="${d}"/>`;
      }
      if (s.markers !== false)
        out += s.points
          .map((p, i) => `<circle class="f-${k} dot" cx="${X(p[0])}" cy="${Y(p[1])}" r="4"><title>${esc(s.tips?.[i] ?? `${s.name}: ${fmt(p[0], 2)}, ${fmt(p[1], 2)}`)}</title></circle>`)
          .join('');
      const last = s.points[s.points.length - 1];
      if (last && s.name) labels.push({ y: Y(last[1]), s });
      return out;
    })
    .join('');
  // Direct labels at the right edge, nudged apart so they never overlap.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
  const direct = labels.map((l) => `<text class="direct" x="${W - m.r + 8}" y="${l.y + 4}">${esc(l.s.name)}</text>`).join('');
  return figure(o.title, o.unit, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}">${grid}${marks}${direct}</svg>`);
}

function figure(title: string, unit: string, body: string): string {
  return `<figure class="chart"><figcaption><span class="t">${esc(title)}</span>${unit ? ` <span class="u">${esc(unit)}</span>` : ''}</figcaption>${body}</figure>`;
}

function legend(summaries: ConfigSummary[]): string {
  return `<ul class="legend">${summaries.map((s) => `<li><span class="sw f-${SLOT[s.config]}"></span>${esc(s.label)} <span class="muted">${esc(s.description)}</span></li>`).join('')}</ul>`;
}

function table(head: string[], rows: (string | number | null)[][]): string {
  return `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c ?? '–')}</th>` : `<td>${esc(typeof c === 'number' ? fmt(c) : (c ?? '–'))}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

const CSS = `
:root{color-scheme:light;--surface:#fcfcfb;--panel:#f4f3f0;--text:#0b0b0b;--text-2:#52514e;--muted:#7a7974;--grid:#e4e3df;--axis:#b9b8b2;
--c-a:#2a78d6;--c-b:#eb6834;--c-c:#1baf7a;--c-d:#eda100}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--surface:#1a1a19;--panel:#232321;--text:#f0efec;--text-2:#c3c2b7;--muted:#8f8e86;--grid:#2f2f2c;--axis:#55544f;
--c-a:#3987e5;--c-b:#d95926;--c-c:#199e70;--c-d:#c98500}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--panel:#232321;--text:#f0efec;--text-2:#c3c2b7;--muted:#8f8e86;--grid:#2f2f2c;--axis:#55544f;
--c-a:#3987e5;--c-b:#d95926;--c-c:#199e70;--c-d:#c98500}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}
p{margin:6px 0;color:var(--text-2)}.muted,.note{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.tile{background:var(--panel);border-radius:8px;padding:12px}.tile .v{font-size:24px;font-weight:600}.tile .k{color:var(--text-2);font-size:13px}
.legend{list-style:none;padding:0;margin:12px 0;display:flex;flex-wrap:wrap;gap:6px 18px}.legend li{display:flex;align-items:center;gap:6px}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px}
.chart{margin:0;background:var(--panel);border-radius:8px;padding:12px}.chart svg{width:100%;height:auto;display:block}
figcaption .t{font-weight:600}figcaption .u{color:var(--muted)}
svg text{fill:var(--text-2);font-size:11px}svg .val,svg .direct{fill:var(--text);font-size:11px}svg .cat{fill:var(--text);font-size:12px}
svg .axis-label{fill:var(--muted)}.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.line{fill:none;stroke-width:2}.dot{stroke:var(--panel);stroke-width:2}
.f-a{fill:var(--c-a);background:var(--c-a)}.f-b{fill:var(--c-b);background:var(--c-b)}.f-c{fill:var(--c-c);background:var(--c-c)}.f-d{fill:var(--c-d);background:var(--c-d)}
.k-a{stroke:var(--c-a)}.k-b{stroke:var(--c-b)}.k-c{stroke:var(--c-c)}.k-d{stroke:var(--c-d)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:5px 8px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap}th:first-child,thead th:first-child{text-align:left}
thead th{color:var(--text-2);font-weight:600}
code{font-size:12px}
`;

/** The wave-2 arms against (a), from the same workload (ADR 011); nothing when none ran. */
function armsSection(r: BenchResult): string {
  const base = r.summaries.find((s) => s.config === 'super-agent');
  if (!r.arms?.length || !base) return '';
  const rows = [base, ...r.arms];
  const spec = r.arms.find((s) => s.arm === 'speculative')?.arms.speculative;
  const gh = r.arms.find((s) => s.arm === 'github')?.arms.github;
  return `<h2>Wave-2 arms</h2>
<p>Configuration (a) with one feature switched each: speculative runs, the GitHub channel, and the Router without per-channel output. See <code>docs/adr/011-wave2-integration.md</code>.</p>
${table(
  ['Run', 'Completion p50 (min)', 'Router decisions', 'Router calls', 'Straight to Workers', 'Context read', 'Router replies', 'Words per reply', 'Reports under Details', 'Refused replies'],
  rows.map((s) => [
    s.label,
    s.completionMin.p50,
    s.coordinator.decided,
    s.coordinator.calls,
    s.coordinator.direct,
    s.tokens.contextRead,
    s.arms.channel.replies,
    s.arms.channel.replies ? Math.round((s.arms.channel.words / s.arms.channel.replies) * 10) / 10 : null,
    s.arms.channel.detailsAttached,
    s.arms.channel.refused,
  ]),
)}${
  spec
    ? table(
        ['Speculative runs', 'Failing CI signals', 'Started', 'Fixes ready', 'Skipped (by gate)', 'Speculative context read'],
        [
          [
            'speculative',
            spec.signals,
            spec.started,
            spec.ready,
            Object.entries(spec.skipped)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ') || 'none',
            r.arms.find((s) => s.arm === 'speculative')?.tokens.byRole.speculative.contextRead ?? null,
          ],
        ],
      )
    : ''
}${gh ? table(['GitHub channel', 'Check events', 'Straight to the task’s Workers', 'Deliveries'], [['github', gh.checks, gh.direct, gh.deliveries]]) : ''}`;
}

export function renderReport(r: BenchResult): string {
  const S = r.summaries;
  const bars = (pick: (s: ConfigSummary) => number | null) => S.map((s) => ({ config: s.config, label: short(s.label), value: pick(s) }));
  const d = r.directRouting;
  const tiles = d
    ? `<div class="tiles">
<div class="tile"><div class="v">${esc(signed(d.routerDecisionsPct, '%'))}</div><div class="k">Router decisions, (a) vs (b)</div></div>
<div class="tile"><div class="v">${esc(signed(d.routerContextReadPct, '%'))}</div><div class="k">Router context read (cached-read analogue), (a) vs (b)</div></div>
<div class="tile"><div class="v">${esc(signed(d.totalContextReadPct, '%'))}</div><div class="k">All sessions' context read, (a) vs (b)</div></div>
<div class="tile"><div class="v">${esc(signed(d.completionP50DeltaMin, ' min'))}</div><div class="k">Completion p50, (a) vs (b)</div></div>
</div>`
    : '';

  const cdf = xyChart({
    title: 'Completion time, cumulative',
    unit: '(share of completed requests)',
    xLabel: 'minutes from request to the user being told it is done',
    yLabel: 'share of requests',
    yMax: 1,
    series: r.runs
      .filter((run) => !run.arm)
      .map((run) => {
        const v = run.requests
          .filter((q) => q.completionMs !== undefined && !q.stopped)
          .map((q) => q.completionMs! / 60_000)
          .sort((a, b) => a - b);
        return {
          config: run.config,
          name: short(run.label),
          line: true,
          step: true,
          markers: false,
          points: [[0, 0] as [number, number], ...v.map((x, i) => [Math.round(x * 10) / 10, (i + 1) / v.length] as [number, number])],
        };
      }),
  });

  const routerRuns = r.runs.filter((x) => x.coordinator.role === 'router' && !x.arm);
  const scatter = xyChart({
    title: 'Router batch size vs arrival rate, per turn',
    unit: '(markers: turns; line: mean per rate bin)',
    xLabel: 'Router-bound events per minute in the window before the turn',
    yLabel: 'events in the batch',
    series: routerRuns.flatMap((run) => {
      const bins = r.batchByRate.find((b) => b.config === run.config)?.bins || [];
      const name = short(run.label);
      return [
        {
          config: run.config,
          name: '',
          markers: true,
          points: run.turns.map((t) => [Math.round(t.ratePerMin * 100) / 100, t.size] as [number, number]),
          tips: run.turns.map((t) => `${name} turn at ${(t.at / 60_000).toFixed(1)} min: ${t.size} events, ${t.ratePerMin.toFixed(2)}/min`),
        },
        { config: run.config, name: `${name} mean`, line: true, markers: false, points: bins.map((b) => [b.rate, b.meanBatch] as [number, number]) },
      ];
    }),
  });

  const sweepSeries = (pick: (p: BenchResult['sweep'][number]) => number | null) =>
    (['super-agent', 'no-direct'] as const)
      .map((config) => {
        const pts = r.sweep.filter((p) => p.config === config && pick(p) !== null).sort((a, b) => a.arrivalPerMin - b.arrivalPerMin);
        const found = S.find((s) => s.config === config);
        const label = found ? short(found.label) : config;
        return {
          config,
          name: label,
          line: true,
          points: pts.map((p) => [p.arrivalPerMin, pick(p)!] as [number, number]),
          tips: pts.map((p) => `${label} at time scale ${p.timeScale}: ${p.arrivalPerMin}/min → ${fmt(pick(p), 2)}`),
        };
      })
      .filter((s) => s.points.length);
  const sweep = r.sweep.length
    ? `<div class="grid2">${xyChart({ title: 'Mean Router batch size vs load', unit: '(time-scale sweep)', xLabel: 'Router-bound events per minute', yLabel: 'events per Router turn', series: sweepSeries((p) => p.meanBatch) })}${xyChart(
        {
          title: 'Router context read per decision vs load',
          unit: '(tokens)',
          xLabel: 'Router-bound events per minute',
          yLabel: 'tokens read per event decided',
          series: sweepSeries((p) => p.contextReadPerDecision),
        },
      )}</div>${table(
        ['Run', 'Time scale', 'Events/min', 'Mean batch', 'Decisions per call', 'Context read per decision', 'Completion p50 (min)'],
        r.sweep.map((p) => [
          short(S.find((s) => s.config === p.config)?.label || p.config),
          String(p.timeScale),
          p.arrivalPerMin,
          p.meanBatch,
          p.decisionsPerCall,
          p.contextReadPerDecision,
          p.completionP50Min,
        ]),
      )}`
    : '<p class="note">The time-scale sweep was skipped (reduced mode or <code>--no-sweep</code>).</p>';

  const o = r.options;
  const counts = Object.entries(r.workload.counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crew ablation bench</title><style>${CSS}</style></head>
<body><main>
<h1>Crew Super-agent ablation bench</h1>
<p>Seed ${esc(o.seed)} · ${esc(r.workload.counts.request + r.workload.counts['follow-up'] + r.workload.counts.stop + r.workload.counts.chatter + r.workload.counts.ci)} events over ${esc(r.workload.spanMin)} simulated minutes (${esc(counts)}) · time scale ${esc(o.timeScale)}.
Simulated offline on a virtual clock with Crew's own routing rules and a scripted model; see <code>docs/adr/101-ablation-bench.md</code>. Times are simulated; tokens are estimated (4 characters per token).</p>
${tiles}
${legend(S)}
<h2>Completion and responsiveness</h2>
<div class="grid2">
${barChart(
  'Completion time p50',
  'minutes',
  bars((s) => s.completionMin.p50),
)}
${barChart(
  'Completion time p95',
  'minutes',
  bars((s) => s.completionMin.p95),
)}
${barChart(
  'Acknowledgement p50',
  'seconds',
  bars((s) => s.ackSec.p50),
)}
${barChart(
  'Acknowledgement p95',
  'seconds',
  bars((s) => s.ackSec.p95),
)}
</div>
${cdf}
<h2>Coordinator load</h2>
<p>The coordinator is the Router in (a) and (b), and the lead bot in (c) and (d). Decisions are the events it took in its turns (Crew's <code>Chat.router.decided</code>).</p>
<div class="grid2">
${barChart(
  'Coordinator decisions',
  'events',
  bars((s) => s.coordinator.decided),
)}
${barChart(
  'Coordinator model calls',
  'calls',
  bars((s) => s.coordinator.calls),
)}
${barChart(
  'Coordinator context read',
  'tokens',
  bars((s) => s.tokens.coordinatorContextRead),
)}
${barChart(
  'Events routed straight to Workers',
  'events',
  bars((s) => s.coordinator.direct),
)}
</div>
<h2>Tokens (estimated), all sessions</h2>
<div class="grid2">
${barChart(
  'Injected',
  'tokens',
  bars((s) => s.tokens.injected),
)}
${barChart(
  'Context read over all calls',
  'tokens',
  bars((s) => s.tokens.contextRead),
)}
</div>
${table(
  ['Configuration', ...ROLES.flatMap((role) => [`${role} calls`, `${role} injected`, `${role} read`])],
  S.map((s) => [s.label, ...ROLES.flatMap((role) => [s.tokens.byRole[role].calls, s.tokens.byRole[role].injected, s.tokens.byRole[role].contextRead])]),
)}
<h2>Router batch size vs arrival rate</h2>
<p>Events that arrive while the Router thinks wait and go into its next turn together (design notes §1). Per turn, and across a sweep of time scales (a smaller scale is a busier chat; model latency does not scale).</p>
${routerRuns.length ? scatter : '<p class="note">No configuration with a Router ran.</p>'}
${sweep}
<h2>All numbers</h2>
${table(
  [
    'Configuration',
    'Requests',
    'Completed',
    'Stopped',
    'Unfinished',
    'p50 (min)',
    'p95 (min)',
    'Ack p50 (s)',
    'Ack p95 (s)',
    'Decisions',
    'Turns',
    'Calls',
    'Mean batch',
    'Direct',
    'Rotations',
    'Executors',
    'Ends at (min)',
  ],
  S.map((s) => [
    s.label,
    s.requests.total,
    s.requests.completed,
    s.requests.stopped,
    s.requests.unfinished,
    s.completionMin.p50,
    s.completionMin.p95,
    s.ackSec.p50,
    s.ackSec.p95,
    s.coordinator.decided,
    s.coordinator.turns,
    s.coordinator.calls,
    s.coordinator.meanBatch,
    s.coordinator.direct,
    s.coordinator.rotations,
    s.executors,
    s.endMin,
  ]),
)}
<h2>Stop requests</h2>
${table(
  ['Configuration', 'Stops', 'Too late (already finished)', 'Latency p50 (s)', 'Latency max (s)', 'Work after the stop (min)'],
  S.map((s) => [s.label, s.stops.count, s.stops.tooLate, s.stops.latencySecP50, s.stops.latencySecMax, s.stops.wastedMin]),
)}
<h2>Environment events</h2>
<p>CI results and Workers' merges through Crew's fast path, the event filter (slow path), and back to the filter when a Worker never read them.</p>
${table(
  ['Configuration', 'Outcome', 'Events'],
  S.flatMap((s) => Object.entries(s.triggers).map(([k, v]) => [s.label, k, v])),
)}
${armsSection(r)}
<h2>Assumptions</h2>
${table(
  ['Parameter', 'Value'],
  [
    ['Work step (min, before time scaling)', o.sim.stepMin ?? null],
    ['Work step output (tokens)', o.sim.workResultTokens ?? null],
    ['Harness tokens per Claude Code session', o.sim.harnessTokens?.claudeCode ?? null],
    ['Harness tokens per Router session', o.sim.harnessTokens?.router ?? null],
    ['Rotate a session at (tokens)', o.sim.rotateAtTokens ?? null],
    ['Workers per chat / jobs per chat', o.sim.maxWorkers ?? null],
    ['Start-up of a Worker or sub-task (ms)', o.sim.startupMs ?? null],
    ['Model call overhead (ms)', o.latency.overheadMs],
    ['Per context token read (ms)', o.latency.readMsPerToken],
    ['Per new input token (ms)', o.latency.newMsPerToken],
    ['Per output token (ms)', o.latency.outMsPerToken],
    [
      'Latency factor by role',
      Object.entries(o.latency.roleFactor)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
    ],
  ],
)}
</main></body></html>
`;
}
