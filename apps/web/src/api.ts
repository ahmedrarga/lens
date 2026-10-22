import type { ChangeGraph } from '@lens/core';

export type AnalysisStatus = 'pending' | 'running' | 'done' | 'failed';
export interface Analysis {
  id: string;
  prUrl: string;
  status: AnalysisStatus;
  error?: string;
  progress?: unknown;
  graph?: ChangeGraph;
}
export interface AnalysisSummary { id: string; prUrl: string; status: AnalysisStatus; title?: string; createdAt: string }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); if (b?.error) msg = typeof b.error === 'string' ? b.error : b.error.message ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const createAnalysis = (prUrl: string) =>
  fetch('/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prUrl }) }).then((r) => json<{ id: string }>(r));
export const getAnalysis = (id: string, signal?: AbortSignal) => fetch(`/api/analyses/${encodeURIComponent(id)}`, { signal }).then((r) => json<Analysis>(r));
export const listAnalyses = () => fetch('/api/analyses').then((r) => json<AnalysisSummary[]>(r));

/** `progress` has no fixed shape yet: render strings, {stage|message|step, percent|pct}, or fall back to JSON. */
export function formatProgress(p: unknown): string {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (typeof p === 'number') return `${Math.round(p <= 1 ? p * 100 : p)}%`;
  if (typeof p === 'object') {
    const o = p as Record<string, unknown>;
    const label = [o.stage, o.step, o.message, o.phase].find((v) => typeof v === 'string') as string | undefined;
    const pct = [o.percent, o.pct, o.fraction].find((v) => typeof v === 'number') as number | undefined;
    if (label || pct != null) return [label, pct != null ? `${Math.round(pct <= 1 ? pct * 100 : pct)}%` : ''].filter(Boolean).join(' · ');
    return JSON.stringify(p);
  }
  return String(p);
}
