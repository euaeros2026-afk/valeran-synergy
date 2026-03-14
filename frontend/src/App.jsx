import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import Login from './pages/Login'
import Chat from './pages/Chat'
import Suppliers from './pages/Suppliers'
import Reports from './pages/Reports'
import Search from './pages/Search'
import Schedule from './pages/Schedule'
import SupplierDetail from './pages/SupplierDetail'
import './App.css'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export default function App() {
  const [session, setSession] = useState(null)
  const [partner, setPartner] = useState(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState('chat')
  const [selectedSupplierId, setSelectedSupplierId] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadPartner(session.user.email)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadPartner(session.user.email)
      else { setPartner(null); setPage('chat') }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function loadPartner(email) {
    const { data } = await supabase.from('partner_profiles').select('*').eq('email', email).single()
    setPartner(data)
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  if (loading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#0d1b3e' }}>
      <div style={{ width:'40px', height:'40px', border:'3px solid rgba(255,255,255,0.1)', borderTopColor:'white', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
    </div>
  )

  if (!session) return <Login supabase={supabase} />

  const nav = [
    { id: 'chat',      label: 'Chat',      icon: ChatIcon },
    { id: 'reports',   label: 'Reports',   icon: ReportIcon },
    { id: 'suppliers', label: 'Suppliers', icon: SuppliersIcon },
    { id: 'schedule',  label: 'Schedule',  icon: CalIcon },
    { id: 'search',    label: 'Search',    icon: SearchIcon },
  ]

  function renderPage() {
    if (selectedSupplierId) {
      return <SupplierDetail id={selectedSupplierId} supabase={supabase} partner={partner} onBack={() => setSelectedSupplierId(null)} />
    }
    switch (page) {
      case 'chat':      return <Chat      supabase={supabase} partner={partner} />
      case 'reports':   return <Reports   supabase={supabase} partner={partner} />
      case 'suppliers': return <Suppliers supabase={supabase} partner={partner} onSelect={setSelectedSupplierId} />
      case 'schedule':  return <Schedule  supabase={supabase} partner={partner} />
      case 'search':    return <Search    supabase={supabase} partner={partner} />
      default:          return <Chat      supabase={supabase} partner={partner} />
    }
  }

  return (
    <div className="app">
      <div className="page-content">{renderPage()}</div>
      {!selectedSupplierId && (
        <nav className="bottom-nav">
          {nav.map(n => (
            <button key={n.id} className={`nav-btn ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
              <n.icon /><span>{n.label}</span>
            </button>
          ))}
          <button className="nav-btn" onClick={signOut} title="Sign out">
            <SignOutIcon /><span>Sign out</span>
          </button>
        </nav>
      )}
    </div>
  )
}

function ChatIcon()      { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> }
function ReportIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/></svg> }
function SuppliersIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> }
function CalIcon()       { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg> }
function SearchIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> }
function SignOutIcon()   { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> }
