// A Worker's report as a Details row under a Router reply (ADR 103): the gist in the chat, the
// full report one click away. A snapshot, so it outlives the Worker; UI only, never in a prompt.

import type { ReportDetail, Worker } from '../../shared/types';
import { REPORT_CHARS, reportGist } from './profiles';

export function reportDetail(w: Worker, bot: string, landing?: string): ReportDetail | null {
  if (!w.report) return null;
  const text = w.report.text || '';
  return {
    workerId: w.id,
    title: w.title,
    bot,
    status: w.report.status,
    gist: reportGist(text) || (w.report.status === 'done' ? 'Finished without a written report.' : `Ended (${w.report.status}).`),
    report: text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS)}\n\n… (cut; the rest is in the Worker's transcript)` : text,
    ...(landing ? { landing } : {}),
    at: w.report.at,
  };
}
