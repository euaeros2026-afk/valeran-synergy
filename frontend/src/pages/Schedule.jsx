import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL

export default function Schedule({ supabase, partner }) {
  const [meetings, setMeetings] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0])

  useEffect(() => { load() }, [selectedDate])

  async function load() {
    setLoading(true)
    const token = (await supabase.auth.getSession()).data.session.access_token
    const res = await fetch(`${API}/api/meetings?date=${selectedDate}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json()
    setMeetings(data.meetings || [])
    setLoading(false)
  }

  async function markComplete(id) {
    const token = (await supabase.auth.getSession()).data.session.access_token
    await fetch(`${API}/api/meetings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'completed' })
    })
    setMeetings(prev => prev.map(m => m.id === id ? { ...m, status: 'completed' } : m))
  }

  // Generate next 7 days
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i - 1)
    return d.toISOString().split('T')[0]
  })

  return (
    <div className="page schedule-page">
      <div className="page-header">
        <div className="page-title">Schedule</div>
        <div className="page-sub">Meetings & factory visits</div>
      </div>

      <div className="date-strip">
        {days.map(d => {
          const dt = new Date(d)
          const isToday = d === new Date().toISOString().split('T')[0]
          return (
            <button key={d} className={`date-btn ${selectedDate === d ? 'active' : ''}`}
              onClick={() => setSelectedDate(d)}>
              <div className="date-btn-day">{dt.toLocaleDateString('en', { weekday: 'short' })}</div>
              <div className="date-btn-num">{dt.getDate()}</div>
              {isToday && <div className="today-dot" />}
            </button>
          )
        })}
      </div>

      {loading ? <div className="loading-inline"><div className="loading-ring small" /></div> : (
        <div className="meetings-list">
          {meetings.length === 0 && (
            <div className="empty-state">
              No meetings on this day. Tell Valeran to log one:<br />
              <em>"Valeran, meeting with Mr. Chen at Hall 9 B14 tomorrow at 10am"</em>
            </div>
          )}
          {meetings.map(m => (
            <div key={m.id} className={`meeting-item status-${m.status}`}>
              <div className="meeting-time-col">
                <div className="meeting-time-val">{m.meeting_time?.slice(0, 5)}</div>
              </div>
              <div className="meeting-body">
                <div className="meeting-title">{m.title}</div>
                {m.suppliers && <div className="meeting-supplier">{m.suppliers.company_name}</div>}
                {m.location && <div className="meeting-loc">📍 {m.location}</div>}
                {m.agenda && <div className="meeting-agenda">{m.agenda}</div>}
                {m.contact_name && <div className="meeting-contact">Contact: {m.contact_name}{m.contact_phone ? ` · ${m.contact_phone}` : ''}</div>}
              </div>
              <div className="meeting-actions">
                {m.status !== 'completed' && (
                  <button className="complete-btn" onClick={() => markComplete(m.id)}>✓</button>
                )}
                <div className={`meeting-status-dot dot-${m.status}`} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
