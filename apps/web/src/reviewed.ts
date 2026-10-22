import { useCallback, useEffect, useState } from 'react';

const key = (analysisKey: string) => `lens:reviewed:${analysisKey}`;
export function loadReviewed(analysisKey: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key(analysisKey)) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
export function saveReviewed(analysisKey: string, s: ReadonlySet<string>) {
  try { localStorage.setItem(key(analysisKey), JSON.stringify([...s])); } catch { /* private mode / quota: keep in memory */ }
}

/** Reviewed node ids, persisted per analysis. */
export function useReviewed(analysisKey: string) {
  const [set, setSet] = useState<Set<string>>(() => loadReviewed(analysisKey));
  useEffect(() => setSet(loadReviewed(analysisKey)), [analysisKey]);
  const toggle = useCallback((id: string) => {
    setSet((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); saveReviewed(analysisKey, n); return n; });
  }, [analysisKey]);
  return { reviewed: set as ReadonlySet<string>, toggle };
}
