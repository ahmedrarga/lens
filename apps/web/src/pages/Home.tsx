import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createAnalysis, listAnalyses, type AnalysisSummary } from '../api.js';
import { AuthBadge, SignInPrompt } from '../auth.js';

const PR_RE = /^https?:\/\/(github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+|[^/\s]+\/\S+\/-\/merge_requests\/\d+)/;

export function Home() {
  const nav = useNavigate();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [recent, setRecent] = useState<AnalysisSummary[] | null>(null);
  const [recentErr, setRecentErr] = useState(false);

  useEffect(() => { listAnalyses().then(setRecent).catch(() => setRecentErr(true)); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!PR_RE.test(v)) { setErr('Enter a GitHub pull request or GitLab merge request URL, e.g. https://github.com/owner/repo/pull/123 or https://gitlab.com/group/project/-/merge_requests/45'); return; }
    setBusy(true); setErr(null);
    try { nav(`/a/${(await createAnalysis(v)).id}`); } catch (x) {
      if (x instanceof ApiError && x.status === 401) { setNeedSignIn(true); setErr(null); } else setErr((x as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="home__top"><h1>◐ Lens</h1><AuthBadge /></div>
      <p className="tagline">Review AI-written PRs by navigating a graph of the change, not by reading a diff.</p>
      <form onSubmit={submit} className="home__form">
        <label htmlFor="pr">Pull request / merge request URL (GitHub or GitLab)</label>
        <div className="row">
          <input id="pr" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="GitHub PR or GitLab MR URL" aria-invalid={!!err} aria-describedby={err ? 'pr-err' : undefined} autoFocus />
          <button className="btn btn--primary" disabled={busy}>{busy ? 'Starting…' : 'Analyze'}</button>
        </div>
        {needSignIn && <SignInPrompt message="You need to sign in to analyze pull requests." />}
        {err && <p id="pr-err" className="error-text" role="alert">{err}</p>}
      </form>
      <p><Link to="/repos">Repos →</Link> · <Link to="/sample">Open sample →</Link> <span className="muted">(a fixture PR, works without the backend)</span></p>

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
