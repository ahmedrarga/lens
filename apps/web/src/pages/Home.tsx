import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createAnalysis, listAnalyses, type AnalysisSummary } from '../api.js';

const PR_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

export function Home() {
  const nav = useNavigate();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<AnalysisSummary[] | null>(null);
  const [recentErr, setRecentErr] = useState(false);

  useEffect(() => { listAnalyses().then(setRecent).catch(() => setRecentErr(true)); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!PR_RE.test(v)) { setErr('Enter a GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123'); return; }
    setBusy(true); setErr(null);
    try { nav(`/a/${(await createAnalysis(v)).id}`); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };

  return (
    <div className="home">
      <h1>◐ Lens</h1>
      <p className="tagline">Review AI-written PRs by navigating a graph of the change, not by reading a diff.</p>
      <form onSubmit={submit} className="home__form">
        <label htmlFor="pr">GitHub pull request URL</label>
        <div className="row">
          <input id="pr" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" aria-invalid={!!err} aria-describedby={err ? 'pr-err' : undefined} autoFocus />
          <button className="btn btn--primary" disabled={busy}>{busy ? 'Starting…' : 'Analyze'}</button>
        </div>
        {err && <p id="pr-err" className="error-text" role="alert">{err}</p>}
      </form>
      <p><Link to="/sample">Open sample →</Link> <span className="muted">(a fixture PR, works without the backend)</span></p>

      <section aria-labelledby="recent-h">
        <h2 id="recent-h">Recent analyses</h2>
        {recentErr && <p className="muted">Couldn’t reach the API, so no history. The sample above still works.</p>}
        {recent && !recent.length && <p className="muted">Nothing analyzed yet.</p>}
        {!!recent?.length && (
          <ul className="recent">
            {recent.map((r) => (
              <li key={r.id}>
                <Link to={`/a/${r.id}`}>{r.title ?? r.prUrl}</Link>
                <span className={`chip chip--${r.status}`}>{r.status}</span>
                <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
