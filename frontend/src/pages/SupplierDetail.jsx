import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL

export default function SupplierDetail({ id, supabase, partner, onBack }) {
  const [supplier, setSupplier] = useState(null)
  const [products, setProducts] = useState([])
  const [meetings, setMeetings] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('products')

  useEffect(() => { load() }, [id])

  async function load() {
    setLoading(true)
    const token = (await supabase.auth.getSession()).data.session.access_token
    const res = await fetch(`${API}/api/suppliers/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json()
    setSupplier(data.supplier)
    setProducts(data.products || [])
    setMeetings(data.meetings || [])
    setLoading(false)
  }

  async function updateStatus(productId, status) {
    const token = (await supabase.auth.getSession()).data.session.access_token
    await fetch(`${API}/api/products/${productId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status })
    })
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, status } : p))
  }

  if (loading) return <div className="loading"><div className="loading-ring" /></div>
  if (!supplier) return <div className="page"><div className="empty-state">Supplier not found</div></div>

  const s = supplier

  return (
    <div className="page supplier-detail">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>‹ Back</button>
        <div className="detail-hero">
          <div className="supplier-initials large">{initials(s.company_name)}</div>
          <div className="detail-hero-info">
            <div className="detail-name">{s.company_name}</div>
            <div className="detail-meta">
              {[s.hall && `Hall ${s.hall}`, s.booth_number && `Booth ${s.booth_number}`].filter(Boolean).join(' · ')}
            </div>
            <div className="detail-tags">
              {s.oem_available && <span className="tag tag-green">OEM</span>}
              {s.odm_available && <span className="tag tag-blue">ODM</span>}
              {s.alibaba_trade_assurance && <span className="tag tag-amber">Trade Assurance</span>}
              {s.knows_eu_market && <span className="tag tag-purple">Knows EU</span>}
              {s.currently_selling_eu && <span className="tag tag-purple">Sells EU</span>}
            </div>
          </div>
          {s.overall_supplier_score && (
            <div className="detail-score">{s.overall_supplier_score.toFixed(1)}<span>/5</span></div>
          )}
        </div>

        {/* Contact strip */}
        <div className="contact-strip">
          <div className="contact-item">
            <div className="contact-icon"><PersonIcon /></div>
            <div>
              <div className="contact-name">{s.contact_name || 'No contact'}</div>
              <div className="contact-role">{s.contact_title || '—'}</div>
            </div>
          </div>
          {s.contact_phone && (
            <a className="contact-item link" href={`tel:${s.contact_phone}`}>
              <div className="contact-icon"><PhoneIcon /></div>
              <div>
                <div className="contact-name">{s.contact_phone}</div>
                <div className="contact-role">Tap to call</div>
              </div>
            </a>
          )}
          {s.contact_wechat && (
            <div className="contact-item">
              <div className="contact-icon"><span style={{fontSize:'16px'}}>💬</span></div>
              <div>
                <div className="contact-name">{s.contact_wechat}</div>
                <div className="contact-role">WeChat ID</div>
              </div>
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="tab-bar">
          {['products', 'details', 'meetings'].map(t => (
            <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="detail-body">
        {tab === 'products' && (
          <div className="products-tab">
            {products.length === 0 && <div className="empty-state">No products logged yet for this supplier.</div>}
            {products.map(p => (
              <div key={p.id} className="product-card-full">
                {p.thumbnail_url && <img src={p.thumbnail_url} className="product-thumb" alt={p.product_name} />}
                <div className="product-card-body">
                  <div className="product-card-top">
                    <div>
                      <div className="product-name">{p.product_name}</div>
                      <div className="product-cat">{p.category_auto || p.category_confirmed}</div>
                    </div>
                    <div className={`status-pill status-${p.status}`}>{p.status}</div>
                  </div>
                  {p.key_features?.length > 0 && (
                    <div className="product-features">{p.key_features.slice(0, 3).join(' · ')}</div>
                  )}
                  <div className="product-prices">
                    <div className="price-block">
                      <div className="price-label">Ex-works</div>
                      <div className="price-cn">
                        ¥{p.exworks_price_cny_min}{p.exworks_price_cny_max ? `–${p.exworks_price_cny_max}` : ''}
                      </div>
                    </div>
                    <div className="price-divider" />
                    <div className="price-block">
                      <div className="price-label">MOQ</div>
                      <div className="price-cn">{p.moq_negotiated || p.moq_standard || '?'} units</div>
                    </div>
                    <div className="price-divider" />
                    <div className="price-block">
                      <div className="price-label">EU avg</div>
                      <div className="price-eu">€{p.eu_avg_price_eur || '?'}</div>
                    </div>
                    {p.gross_margin_estimate && (
                      <>
                        <div className="price-divider" />
                        <div className="price-block">
                          <div className="price-label">Margin</div>
                          <div className={`price-eu ${p.gross_margin_estimate > 40 ? 'good' : p.gross_margin_estimate > 25 ? 'ok' : 'low'}`}>
                            ~{p.gross_margin_estimate}%
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Compliance flags */}
                  <div className="compliance-row">
                    {p.ce_status && <span className={`comp-tag ${p.ce_status === 'held' ? 'green' : p.ce_status === 'obtainable' ? 'amber' : 'red'}`}>CE: {p.ce_status}</span>}
                    {p.sample_cost_usd && <span className="comp-tag neutral">Sample: ${p.sample_cost_usd}</span>}
                  </div>

                  {/* Review insights */}
                  {p.eu_review_insights?.top_complaints?.length > 0 && (
                    <div className="review-insight complaint">
                      ⚠️ Buyers complain: {p.eu_review_insights.top_complaints[0]}
                    </div>
                  )}
                  {p.eu_review_insights?.questions_to_ask_supplier?.length > 0 && (
                    <div className="review-insight question">
                      💬 Ask: {p.eu_review_insights.questions_to_ask_supplier[0]}
                    </div>
                  )}

                  {/* Score dots */}
                  {p.total_score && (
                    <div className="score-row">
                      <span className="score-label">Score</span>
                      <div className="score-dots">
                        {[1, 2, 3, 4, 5].map(i => (
                          <div key={i} className={`score-dot ${p.total_score >= i ? 'fill' : p.total_score >= i - 0.5 ? 'half' : ''}`} />
                        ))}
                      </div>
                      <span className="score-val">{p.total_score}/5</span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="product-actions">
                    <button className={`action-btn ${p.status === 'shortlisted' ? 'active-green' : ''}`}
                      onClick={() => updateStatus(p.id, p.status === 'shortlisted' ? 'reviewing' : 'shortlisted')}>
                      {p.status === 'shortlisted' ? '★ Shortlisted' : '☆ Shortlist'}
                    </button>
                    <button className={`action-btn ${p.status === 'rejected' ? 'active-red' : ''}`}
                      onClick={() => updateStatus(p.id, p.status === 'rejected' ? 'reviewing' : 'rejected')}>
                      {p.status === 'rejected' ? '✕ Rejected' : 'Reject'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'details' && (
          <div className="details-tab">
            <InfoSection title="Company">
              <InfoRow label="Factory location" value={[s.factory_city, s.factory_province].filter(Boolean).join(', ')} />
              <InfoRow label="Distance from Guangzhou" value={s.factory_distance_guangzhou} />
              <InfoRow label="Years in business" value={s.years_in_business} />
              <InfoRow label="Annual capacity" value={s.annual_production_capacity} />
            </InfoSection>
            <InfoSection title="Commercial terms">
              <InfoRow label="Payment terms" value={s.payment_terms?.join(', ')} />
              <InfoRow label="Incoterms" value={s.incoterms?.join(', ')} />
              <InfoRow label="Alibaba Trade Assurance" value={s.alibaba_trade_assurance ? '✓ Yes' : 'No'} />
              <InfoRow label="Alibaba Gold Supplier" value={s.alibaba_gold_supplier ? `✓ ${s.alibaba_years} years` : 'No'} />
            </InfoSection>
            <InfoSection title="EU market">
              <InfoRow label="Export experience" value={s.export_experience ? 'Yes' : 'Not confirmed'} />
              <InfoRow label="Knows EU market" value={s.knows_eu_market ? 'Yes' : 'Not confirmed'} />
              <InfoRow label="Currently sells in EU" value={s.currently_selling_eu ? 'Yes' : 'Not confirmed'} />
              <InfoRow label="EU brands" value={s.eu_brands_supplied?.join(', ')} />
            </InfoSection>
            <InfoSection title="Certifications">
              <InfoRow label="CE mark" value={s.has_ce ? '✓' : '—'} />
              <InfoRow label="RoHS" value={s.has_rohs ? '✓' : '—'} />
              <InfoRow label="ISO" value={s.has_iso ? '✓' : '—'} />
              <InfoRow label="Other" value={s.other_certifications?.join(', ')} />
            </InfoSection>
            {s.notes && (
              <InfoSection title="Team notes">
                <div className="notes-text">{s.notes}</div>
              </InfoSection>
            )}
          </div>
        )}

        {tab === 'meetings' && (
          <div className="meetings-tab">
            {meetings.length === 0 && <div className="empty-state">No meetings scheduled with this supplier.</div>}
            {meetings.map(m => (
              <div key={m.id} className="meeting-card">
                <div className="meeting-time">{m.meeting_date} · {m.meeting_time?.slice(0, 5)}</div>
                <div className="meeting-title">{m.title}</div>
                {m.location && <div className="meeting-loc">📍 {m.location}</div>}
                {m.agenda && <div className="meeting-agenda">{m.agenda}</div>}
                <div className={`meeting-status status-${m.status}`}>{m.status}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function InfoSection({ title, children }) {
  return (
    <div className="info-section">
      <div className="info-section-title">{title}</div>
      {children}
    </div>
  )
}

function InfoRow({ label, value }) {
  if (!value) return null
  return (
    <div className="info-row">
      <div className="info-label">{label}</div>
      <div className="info-value">{value}</div>
    </div>
  )
}

function initials(name) { return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() }
function PersonIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> }
function PhoneIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.15 10.4"/></svg> }
