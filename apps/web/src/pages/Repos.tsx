import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, createAnalysis, listPulls, listRepos, type PullSummary, type RepoSummary } from '../api.js';
import { AuthBadge, SignInPrompt } from '../auth.js';

/** Load state that tells "needs sign-in" and "endpoint missing" apart from other failures. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<ApiError | Error | null>(null);
  useEffect(() => {
    let alive = true; setData(null); setErr(null);
    load().then((d) => alive && setData(d), (e) => alive && setErr(e));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, err };
}

function Problem({ err, what }: { err: Error; what: string }) {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 401) return <SignInPrompt message={`Sign in with GitHub to see ${what}.`} />;
  if (status === 404) return <p className="muted">{what[0]!.toUpperCase() + what.slice(1)} are not available on this server yet.</p>;
  return <p className="error-text" role="alert">Couldn’t load {what}: {err.message}</p>;
}

function Page({ title, children, back }: { title: string; children: React.ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="home">
      <div className="home__top"><h1><Link to="/" className="brand">◐ Lens</Link></h1><AuthBadge /></div>
      {back && <p><Link to={back.to}>← {back.label}</Link></p>}
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Repos() {
  const { data, err } = useLoad<RepoSummary[]>(listRepos, []);
  return (
    <Page title="Repositories" back={{ to: '/', label: 'Home' }}>
      {err && <Problem err={err} what="repositories" />}
      {!data && !err && <div className="spinner" aria-label="Loading" />}
      {data && !data.length && <p className="muted">No repositories yet.</p>}
      {!!data?.length && (
        <ul className="recent">
          {data.map((r) => (
            <li key={`${r.owner}/${r.name}`}>
              <Link to={`/r/${r.owner}/${r.name}`}>{r.owner}/{r.name}</Link>
              {r.private && <span className="chip">private</span>}
              {r.analysesCount != null && <span className="muted small">{r.analysesCount} analyses</span>}
              {r.pushedAt && <span className="muted small">pushed {new Date(r.pushedAt).toLocaleDateString()}</span>}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

export function RepoPulls() {
  const { owner = '', repo = '' } = useParams();
  const nav = useNavigate();
  const { data, err } = useLoad<PullSummary[]>(() => listPulls(owner, repo), [owner, repo]);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionErr, setActionErr] = useState<Error | null>(null);
  const analyze = async (p: PullSummary) => {
    setBusy(p.number); setActionErr(null);
    try { nav(`/a/${(await createAnalysis(p.url)).id}`); } catch (e) { setActionErr(e as Error); setBusy(null); }
  };
  return (
    <Page title={`${owner}/${repo}`} back={{ to: '/repos', label: 'Repos' }}>
      {err && <Problem err={err} what="pull requests" />}
      {actionErr && <Problem err={actionErr} what="analyses" />}
      {!data && !err && <div className="spinner" aria-label="Loading" />}
      {data && !data.length && <p className="muted">No open pull requests.</p>}
      {!!data?.length && (
        <ul className="recent">
          {data.map((p) => (
            <li key={p.number}>
              <a href={p.url} target="_blank" rel="noreferrer">#{p.number} {p.title}</a>
              {p.author && <span className="muted small">{p.author}</span>}
              {p.updatedAt && <span className="muted small">{new Date(p.updatedAt).toLocaleDateString()}</span>}
              {p.analysis && <span className={`chip chip--${p.analysis.status}`}>{p.analysis.status}</span>}
              {p.analysis
                ? <Link className="btn btn--small" to={`/a/${p.analysis.id}`}>Open</Link>
                : <button className="btn btn--small btn--primary" disabled={busy === p.number} onClick={() => analyze(p)}>{busy === p.number ? 'Starting…' : 'Analyze'}</button>}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
