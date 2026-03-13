import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL

export default function Suppliers({ supabase, partner, onSelect }) {
  const [suppliers, setSuppliers] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const token = (await supabase.auth.getSession()).data.session.access_token
    const res = await fetch(`${API}/api/suppliers?limit=100`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json()
    setSuppliers(data.suppliers || [])
    setLoading(false)
  }

  const filtered = suppliers.filter(s =>
    !search || s.company_name?.toLowerCase().includes(search.toLowerCase()) ||
    s.hall?.toLowerCase().includes(search.toLowerCase()) ||
    s.factory_city?.toLowerCase().includes(search.toLowerCase())
  )

  function scoreColor(score) {
    if (!score) return '#3d4155'
    if (score >= 4) return '#5a9e6f'
    if (score >= 3) return '#e8a045'
    return '#c05a5a'
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Suppliers</div>
        <div className="page-sub">{suppliers.length} logged this fair</div>
      </div>

      <div className="search-bar-wrap">
        <div className="search-bar">
          <SearchIcon />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, hall, city..."
          />
          {search && <button onClick={() => setSearch('')}>✕</button>}
        </div>
      </div>

      {loading ? <div className="list-loading"><div className="loading-ring" /></div> : (
        <div className="supplier-list">
          {filtered.length === 0 && (
            <div className="empty-state">No suppliers yet. Start chatting with Valeran to log them.</div>
          )}
          {filtered.map(s => (
            <div key={s.id} className="supplier-card" onClick={() => onSelect(s.id)}>
              <div className="supplier-card-left">
                <div className="supplier-initials">{initials(s.company_name)}</div>
              </div>
              <div className="supplier-card-body">
                <div className="supplier-card-name">{s.company_name}</div>
                <div className="supplier-card-meta">
                  {[s.hall && `Hall ${s.hall}`, s.booth_number && `Booth ${s.booth_number}`, s.factory_city].filter(Boolean).join(' · ')}
                </div>
                <div className="supplier-card-tags">
                  {s.oem_available && <span className="tag tag-green">OEM</span>}
                  {s.odm_available && <span className="tag tag-blue">ODM</span>}
                  {s.alibaba_trade_assurance && <span className="tag tag-amber">Trade Assurance</span>}
                  {s.currently_selling_eu && <span className="tag tag-purple">Sells EU</span>}
                </div>
              </div>
              <div className="supplier-card-right">
                {s.overall_supplier_score && (
                  <div className="score-badge" style={{ color: scoreColor(s.overall_supplier_score) }}>
                    {s.overall_supplier_score.toFixed(1)}
                  </div>
                )}
                <div className="product-count">{s.products?.[0]?.count || 0} products</div>
                <ChevronIcon />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}
function SearchIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> }
function ChevronIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg> }
