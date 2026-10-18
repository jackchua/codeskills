import { useCallback, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api } from './api'
import { useAsync } from './components/ui'
import { CommandPalette, usePaletteHotkey } from './components/CommandPalette'
import { Overview } from './pages/Overview'
import { Milestones } from './pages/Milestones'
import { MilestoneDetail } from './pages/MilestoneDetail'
import { Commits } from './pages/Commits'
import { CommitDetail } from './pages/CommitDetail'
import { Structure } from './pages/Structure'
import { Commands } from './pages/Commands'
import { Features } from './pages/Features'
import { FeatureDetail } from './pages/FeatureDetail'
import { Approvals } from './pages/Approvals'

export default function App() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const open = useCallback(() => setPaletteOpen(true), [])
  usePaletteHotkey(open)

  const { data } = useAsync(() => api.overview(), [])
  const h = data?.health
  const reg = data?.registry

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <b>◈ CUI</b>
          <span>{data?.meta?.product || 'project'}</span>
        </div>

        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Overview
        </NavLink>
        <NavLink to="/milestones" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Milestones
          <span className="count">{h ? `${h.milestones_done}/${h.milestones_total}` : ''}</span>
        </NavLink>
        <NavLink to="/features" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Features
          <span className="count" style={reg && !reg.ok && reg.summary ? { color: 'var(--red)' } : undefined}>
            {reg?.summary?.total ? (reg.ok ? `${reg.summary.passing}/${reg.summary.total - reg.summary.retired}` : '✗') : ''}
          </span>
        </NavLink>
        <NavLink to="/approvals" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Approvals
          <span className="count" style={h?.approvals_pending ? { color: 'var(--yellow)' } : undefined}>
            {h?.approvals_pending || ''}
          </span>
        </NavLink>
        <NavLink to="/commits" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Commits <span className="count">{h?.commits_total ?? ''}</span>
        </NavLink>
        <NavLink to="/structure" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Structure
          <span className="count">{h && !h.blueprint_locked ? '⚠' : ''}</span>
        </NavLink>
        <NavLink to="/commands" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          Commands
        </NavLink>

        <button className="nav-item" style={{ textAlign: 'left', border: 'none', background: 'none' }}
                onClick={open}>
          Search <span className="count">⌘K</span>
        </button>

        <div className="spacer" />
        <div className="hint">
          <kbd>⌘K</kbd> search everything runnable.<br />
          Commit with <code>/ship</code> so it lands here.
        </div>
      </nav>

      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/milestones" element={<Milestones />} />
          <Route path="/milestones/:key" element={<MilestoneDetail />} />
          <Route path="/features" element={<Features />} />
          <Route path="/features/:id" element={<FeatureDetail />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/commits" element={<Commits />} />
          <Route path="/commits/:sha" element={<CommitDetail />} />
          <Route path="/structure" element={<Structure />} />
          <Route path="/commands" element={<Commands />} />
        </Routes>
      </main>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
