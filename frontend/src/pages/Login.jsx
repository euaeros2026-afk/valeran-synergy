import { useState } from 'react'
export default function Login({ supabase }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setError(error.message); setLoading(false) }
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="sv-logo">
          <svg viewBox="0 0 80 80" width="72" height="72"><circle cx="40" cy="40" r="40" fill="#0d1b3e"/><text x="19" y="52" fontFamily="Georgia" fontSize="36" fontWeight="700" fill="white">S</text><text x="39" y="52" fontFamily="Georgia" fontSize="36" fontWeight="700" fill="rgba(255,255,255,0.85)">V</text><line x1="16" y1="57" x2="64" y2="57" stroke="#e8a045" strokeWidth="1.5"/></svg>
        </div>
        <div className="login-brand"><div className="login-title">Synergy Ventures</div><div className="login-valeran">powered by Valeran</div></div>
        <div className="login-tagline">Canton Fair 2025 - Field Intelligence System</div>
        <form onSubmit={handleSubmit} style={{width:'100%',display:'flex',flexDirection:'column',gap:'12px',marginTop:'8px'}}>
          <input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required style={{padding:'12px 16px',borderRadius:'8px',border:'1px solid rgba(255,255,255,0.15)',background:'rgba(255,255,255,0.07)',color:'white',fontSize:'15px',outline:'none'}}/>
          <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required style={{padding:'12px 16px',borderRadius:'8px',border:'1px solid rgba(255,255,255,0.15)',background:'rgba(255,255,255,0.07)',color:'white',fontSize:'15px',outline:'none'}}/>
          <button type="submit" className="google-btn" disabled={loading} style={{justifyContent:'center'}}>{loading ? 'Signing in...' : 'Sign In'}</button>
        </form>
        {error && <div className="login-error">{error}</div>}
        <div className="login-note">Access restricted to registered partners only.</div>
      </div>
    </div>
  )
}
