// Reports.jsx
import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL

export function Reports({ supabase, partner }) {
  const [reports, setReports] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lang, setLang] = useState('en')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const token = (await supabase.auth.getSession()).data.session.access_token
    const res = await fetch(`${API}/api/reports`, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    const r = data.reports || []
    setReports(r)
    if (r.length) setSelected(r[0])
    setLoading(false)
  }

  async function generateReport(type) {
    const token = (await supabase.auth.getSession()).data.session.access_token
    const res = await fetch(`${API}/api/reports/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type })
    })
    const data = await res.json()
    if (data.report) { setReports(prev => [data.report, ...prev]); setSelected(data.report) }
  }

  if (loading) return <div className="loading"><div className="loading-ring" /></div>

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Reports</div>
        <div className="report-gen-btns">
          <button className="gen-btn" onClick={() => generateReport('evening')}>Generate Evening</button>
          <button className="gen-btn" onClick={() => generateReport('morning')}>Generate Morning</button>
        </div>
      </div>

      <div className="report-tabs-horiz">
        {reports.map(r => (
          <button key={r.id} className={`report-tab-btn ${selected?.id === r.id ? 'active' : ''}`}
            onClick={() => setSelected(r)}>
            <div className="rtb-type">{r.report_type}</div>
            <div className="rtb-date">{r.report_date}</div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="report-content">
          <div className="report-content-header">
            <div className="report-content-title">{selected.title}</div>
            <div className="lang-switcher">
              <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
              <button className={lang === 'bg' ? 'active' : ''} onClick={() => setLang('bg')}>BG</button>
            </div>
          </div>
          {selected.stats && (
            <div className="stats-row">
              <StatBox val={selected.stats.products_logged} label="Products" />
              <StatBox val={selected.stats.suppliers_met} label="Suppliers" />
              <StatBox val={selected.stats.meetings_tomorrow} label="Meetings tmrw" />
            </div>
          )}
          <div className="report-body-md">
            <ReactMarkdown>{lang === 'bg' ? selected.content_bg : selected.content_en}</ReactMarkdown>
          </div>
        </div>
      )}

      {reports.length === 0 && (
        <div className="empty-state">No reports yet. They generate automatically at 21:30 each evening.</div>
      )}
    </div>
  )
}

function StatBox({ val, label }) {
  return (
    <div className="stat-box">
      <div className="stat-val">{val ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export default Reports
