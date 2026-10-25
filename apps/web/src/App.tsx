import { Link, Route, Routes } from 'react-router-dom';
import { Home } from './pages/Home.js';
import { AnalysisPage, FixturePage, SamplePage } from './pages/Analysis.js';
import { Repos, RepoPulls } from './pages/Repos.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/a/:id" element={<AnalysisPage />} />
      <Route path="/sample" element={<SamplePage />} />
      <Route path="/repos" element={<Repos />} />
      <Route path="/r/:owner/:repo" element={<RepoPulls />} />
      {import.meta.env.DEV && <Route path="/fixture/:name" element={<FixturePage />} />}
      <Route path="*" element={<div className="center-page"><h1>Not found</h1><Link to="/">Back home</Link></div>} />
    </Routes>
  );
}
