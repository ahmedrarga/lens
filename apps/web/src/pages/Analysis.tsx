import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChangeGraph } from '@lens/core';
import { formatProgress, getAnalysis, type Analysis } from '../api.js';
import { Workspace } from '../components/Workspace.js';

/** The sample is a separate chunk: it is only fetched on /sample. */
export function SamplePage() {
  return <FixturePage name="sample" banner="sample" />;
}

type Loader = () => Promise<{ default: unknown }>;
const fixtures: Record<string, Loader> = import.meta.env.DEV
  ? import.meta.glob<{ default: unknown }>('../../../../fixtures/golden/*.json')
  : import.meta.glob<{ default: unknown }>('../../../../fixtures/golden/sample.json');

/** Loads fixtures/golden/<name>.json. /sample is public; /fixture/:name is dev-only (see App). */
export function FixturePage({ name: forced, banner }: { name?: string; banner?: string }) {
  const params = useParams();
  const name = forced ?? params.name ?? '';
  const [graph, setGraph] = useState<ChangeGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = fixtures[`../../../../fixtures/golden/${name}.json`];
    setGraph(null); setErr(null);
    if (!load) { setErr(`No fixture named "${name}"`); return; }
    load().then((m) => setGraph(m.default as ChangeGraph), (e) => setErr(String(e)));
  }, [name]);
  if (err) return <div className="center-page"><h2>{err}</h2><Link to="/">Back home</Link></div>;
  if (!graph) return <div className="center-page" aria-busy="true"><div className="spinner" aria-hidden="true" /></div>;
  return <Workspace graph={graph} banner={banner ?? `fixture: ${name}`} storageKey={`fixture:${name}`} />;
}

export function AnalysisPage() {
  const { id = '' } = useParams();
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>; const ctl = new AbortController();
    setA(null); setErr(null);
    const tick = async () => {
      try {
        const next = await getAnalysis(id, ctl.signal);
        if (!alive) return;
        setA(next); setErr(null);
        if (next.status === 'pending' || next.status === 'running') timer = setTimeout(tick, 1500);
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message);
        timer = setTimeout(tick, 3000); // transient API errors: keep trying
      }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); ctl.abort(); };
  }, [id]);

  if (a?.status === 'done' && a.graph) return <Workspace graph={a.graph} storageKey={id} />;
  return (
    <div className="center-page" role="status" aria-live="polite">
      <Link to="/" className="brand">◐ Lens</Link>
      {a?.status === 'failed' ? (
        <>
          <h2>Analysis failed</h2>
          <pre className="error-box">{a.error ?? 'Unknown error'}</pre>
          <p><a href={a.prUrl}>{a.prUrl}</a></p>
          <Link className="btn" to="/">Try another PR</Link>
        </>
      ) : a?.status === 'done' ? (
        <><h2>Analysis finished without a graph</h2><p className="muted">The API reported done but returned no graph.</p></>
      ) : (
        <>
          <div className="spinner" aria-hidden="true" />
          <h2>{a ? (a.status === 'running' ? 'Analyzing…' : 'Queued…') : err ? 'Waiting for the API…' : 'Loading…'}</h2>
          {a && <p className="muted">{a.prUrl}</p>}
          {a?.progress != null && <p>{formatProgress(a.progress)}</p>}
          {err && <p className="error-text">{err}</p>}
        </>
      )}
    </div>
  );
}
