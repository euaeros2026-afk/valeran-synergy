import { useState } from 'react'

export default function Login({ supabase }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setError(error.message); setLoading(false) }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #0d1b3e 0%, #0a1628 50%, #050e1a 100%)',
      padding: '20px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: '20px',
        padding: '48px 40px', width: '100%', maxWidth: '380px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '24px'
      }}>

        {/* REAL SV LOGO — matches the uploaded image exactly */}
        <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width="90" height="90">
          {/* Black background */}
          <rect width="120" height="120" fill="#000000" rx="12"/>
          {/* S letter — large serif */}
          <text x="8" y="82" fontFamily="Georgia, 'Times New Roman', serif" fontSize="74"
                fontWeight="700" fill="white" letterSpacing="-2">S</text>
          {/* V letter — large serif, offset right */}
          <text x="52" y="82" fontFamily="Georgia, 'Times New Roman', serif" fontSize="74"
                fontWeight="700" fill="white" letterSpacing="-2">V</text>
          {/* Diagonal slash through V — thin line */}
          <line x1="58" y1="95" x2="108" y2="55" stroke="white" strokeWidth="1.5" opacity="0.9"/>
        </svg>

        {/* Brand */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'white', fontSize: '20px', fontWeight: '700', letterSpacing: '0.5px' }}>
            Synergy Ventures
          </div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '12px', marginTop: '4px', letterSpacing: '1px', textTransform: 'uppercase' }}>
            Field Intelligence System
          </div>
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '11px', marginTop: '2px' }}>
            Canton Fair 2026 · Powered by Valeran
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            type="email" placeholder="Email address" value={email}
            onChange={e => setEmail(e.target.value)} required
            style={{
              padding: '14px 16px', borderRadius: '10px', fontSize: '15px',
              border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)',
              color: 'white', outline: 'none', width: '100%', boxSizing: 'border-box'
            }}
          />
          <input
            type="password" placeholder="Password" value={password}
            onChange={e => setPassword(e.target.value)} required
            style={{
              padding: '14px 16px', borderRadius: '10px', fontSize: '15px',
              border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)',
              color: 'white', outline: 'none', width: '100%', boxSizing: 'border-box'
            }}
          />
          <button type="submit" disabled={loading} style={{
            padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: '600',
            background: loading ? 'rgba(255,255,255,0.1)' : 'white', color: '#0d1b3e',
            border: 'none', cursor: loading ? 'not-allowed' : 'pointer', marginTop: '4px',
            transition: 'all 0.2s', letterSpacing: '0.3px'
          }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        {error && (
          <div style={{
            color: '#ff6b6b', fontSize: '13px', textAlign: 'center',
            background: 'rgba(255,107,107,0.1)', padding: '10px 14px',
            borderRadius: '8px', border: '1px solid rgba(255,107,107,0.2)', width: '100%',
            boxSizing: 'border-box'
          }}>{error}</div>
        )}

        <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: '11px', textAlign: 'center' }}>
          Access restricted to registered partners only.
        </div>
      </div>
    </div>
  )
}
