import { useState, useRef } from 'react'

const API = import.meta.env.VITE_API_URL

export default function Search({ supabase, partner }) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('both') // both | text | photo
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [previewImg, setPreviewImg] = useState(null)
  const fileRef = useRef(null)
  const photoFile = useRef(null)

  async function runSearch() {
    if (!query && !photoFile.current) return
    setLoading(true)
    const token = (await supabase.auth.getSession()).data.session.access_token
    const fd = new FormData()
    if (query) fd.append('query', query)
    if (photoFile.current && mode !== 'text') fd.append('image', photoFile.current)

    const res = await fetch(`${API}/api/search`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
    })
    const data = await res.json()
    setResults(data)
    setLoading(false)
  }

  function onPhotoSelect(file) {
    photoFile.current = file
    setPreviewImg(URL.createObjectURL(file))
    if (mode === 'text') setMode('both')
  }

  return (
    <div className="page search-page">
      <div className="page-header">
        <div className="page-title">Product Search</div>
        <div className="page-sub">EU + China · text and photo</div>
      </div>

      <div className="search-section">
        <div className="search-mode-row">
          {['both', 'text', 'photo'].map(m => (
            <button key={m} className={`mode-btn ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
              {m === 'both' ? 'Text + Photo' : m === 'text' ? 'Text only' : 'Photo only'}
            </button>
          ))}
        </div>

        {mode !== 'photo' && (
          <input
            className="search-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
            placeholder="Describe product e.g. HEPA air purifier USB-C..."
          />
        )}

        {mode !== 'text' && (
          <div className="photo-drop" onClick={() => fileRef.current?.click()}>
            {previewImg
              ? <img src={previewImg} className="photo-preview" alt="Product" />
              : <>
                  <CameraIcon />
                  <span>Tap to photograph product</span>
                  <span className="photo-sub">Vision AI identifies it automatically</span>
                </>
            }
            <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={e => e.target.files[0] && onPhotoSelect(e.target.files[0])} />
          </div>
        )}

        <button className="search-btn" onClick={runSearch} disabled={loading || (!query && !photoFile.current)}>
          {loading ? 'Searching...' : 'Search EU + China'}
        </button>
      </div>

      {results && (
        <div className="search-results">
          {results.vision_labels?.length > 0 && (
            <div className="vision-labels">
              <span className="vision-label-head">AI identified: </span>
              {results.vision_labels.map(l => <span key={l} className="vision-label">{l}</span>)}
            </div>
          )}

          {results.internal?.length > 0 && (
            <div className="results-section">
              <div className="results-section-title">In your database</div>
              {results.internal.map(p => (
                <ResultCard key={p.id} name={p.product_name} source={p.suppliers?.company_name}
                  price={p.eu_avg_price_eur ? `€${p.eu_avg_price_eur} EU avg` : null}
                  badge="your supplier" badgeColor="green" />
              ))}
            </div>
          )}

          {results.eu?.length > 0 && (
            <div className="results-section">
              <div className="results-section-title">EU competitors</div>
              {results.eu.map((r, i) => (
                <ResultCard key={i} name={r.name} source={r.platform}
                  price={r.price_eur ? `€${r.price_eur}` : null}
                  meta={r.review_count ? `${r.rating}★ · ${r.review_count.toLocaleString()} reviews` : null}
                  badge={`${r.match_pct || ''}% match`} badgeColor="blue" />
              ))}
            </div>
          )}

          {results.china?.length > 0 && (
            <div className="results-section">
              <div className="results-section-title">China sources</div>
              {results.china.map((r, i) => (
                <ResultCard key={i} name={r.supplier_name} source={r.platform}
                  price={r.price_usd_min ? `$${r.price_usd_min}–${r.price_usd_max} · MOQ ${r.moq}` : null}
                  badge={r.trade_assurance ? 'Trade Assurance' : null} badgeColor="amber" />
              ))}
            </div>
          )}

          {!results.internal?.length && !results.eu?.length && !results.china?.length && (
            <div className="empty-state">No results found. Try different search terms or a clearer photo.</div>
          )}
        </div>
      )}
    </div>
  )
}

function ResultCard({ name, source, price, meta, badge, badgeColor }) {
  return (
    <div className="result-card">
      <div className="result-card-body">
        <div className="result-name">
          {name}
          {badge && <span className={`result-badge badge-${badgeColor}`}>{badge}</span>}
        </div>
        {source && <div className="result-source">{source}</div>}
        {price && <div className="result-price">{price}</div>}
        {meta && <div className="result-meta">{meta}</div>}
      </div>
    </div>
  )
}

function CameraIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="28" height="28"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> }
