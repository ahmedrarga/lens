import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChangeGraph } from '@lens/core';
import sampleJson from '../../../../fixtures/golden/sample.json';
import { formatProgress, getAnalysis, type Analysis } from '../api.js';
import { Workspace } from '../components/Workspace.js';

const sample = sampleJson as unknown as ChangeGraph;

export function SamplePage() {
  return <Workspace graph={sample} banner="sample" />;
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

  if (a?.status === 'done' && a.graph) return <Workspace graph={a.graph} />;
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
