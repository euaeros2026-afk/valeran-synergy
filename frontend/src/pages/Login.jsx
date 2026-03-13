import { useState } from 'react'

export default function Login({ supabase }) {
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [mode, setMode] = useState('signin')
    const [message, setMessage] = useState(null)

  async function handleSubmit(e) {
        e.preventDefault()
        setLoading(true)
        setError(null)
        setMessage(null)
        if (mode === 'signin') {
                const { error } = await supabase.auth.signInWithPassword({ email, password })
                if (error) { setError(error.message); setLoading(false) }
        } else {
                const { error } = await supabase.auth.signUp({ email, password })
                if (error) { setError(error.message) }
                else { setMessage('Check your email to confirm, then sign in.') }
                setLoading(false)
        }
  }

  return (
        <div className="login-page">
              <div className="login-card">
                      <div className="sv-logo">
                                <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" width="72" height="72">
                                            <circle cx="40" cy="40" r="40" fill="#0d1b3e"/>
                                            <circle cx="40" cy="40" r="36" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
                                            <text x="19" y="52" fontFamily="Georgia, serif" fontSize="36" fontWeight="700" fill="white" letterSpacing="-1">S</text>text>
                                            <text x="39" y="52" fontFamily="Georgia, serif" fontSize="36" fontWeight="700" fill="rgba(255,255,255,0.85)" letterSpacing="-1">V</text>text>
                                            <line x1="16" y1="57" x2="64" y2="57" stroke="#e8a045" strokeWidth="1.5" opacity="0.7"/>
                                </svg>svg>
                      </div>div>
                      <div className="login-brand">
                                <div className="login-title">Synergy Ventures</div>div>
                                <div className="login-valeran">powered by Valeran</div>div>
                      </div>div>
                      <div className="login-tagline">Canton Fair 2025 - Field Intelligence System</div>div>
                      <form onSubmit={handleSubmit} style={{width:'100%',display:'flex',flexDirection:'column',gap:'12px',marginTop:'8px'}}>
                                <input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required style={{padding:'12px 16px',borderRadius:'8px',border:'1px solid rgba(255,255,255,0.15)',background:'rgba(255,255,255,0.07)',color:'white',fontSize:'15px',outline:'none'}}/>
                                <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required style={{padding:'12px 16px',borderRadius:'8px',border:'1px solid rgba(255,255,255,0.15)',background:'rgba(255,255,255,0.07)',color:'white',fontSize:'15px',outline:'none'}}/>
                                <button type="submit" className="google-btn" disabled={loading} style={{justifyContent:'center'}}>
                                  {loading ? <span className="login-spinner"/> : (mode==='signin'?'Sign In':'Create Account')}
                                </button>button>
                      </form>form>
                {error && <div className="login-error">{error}</div>div>}
                {message && <div className="login-error" style={{color:'#4iamdpeo8r0t' ,{b oursdeeSrtCaotleo r}: 'f#r4oamd e'8r0e'a}c}t>'{
                  m
                  eesxspaogret} <d/edfiavu>l}t
                f u n c t i o n< dLiovg isnt(y{l es=u{p{ambaarsgei n}T)o p{:
              ' 1 2cpoxn's,tf o[nltoSaidzien:g',1 3spext'L,ocaodlionrg:]' r=g buas(e2S5t5a,t2e5(5f,a2l5s5e,)0
              . 4 )c'o,ncsutr s[oerr:r'opro,i nsteetrE'r}r}o ro]n C=l iucske=S{t(a)t=e>({nsueltlM)o
              d e (cmoondset= =[=e'msaiigln,i ns'e?t'Esmiaginlu]p '=: 'ussiegSntiant'e)(;'s'e)t
              E r rcoorn(sntu l[lp)a;sssewtoMreds,s asgeet(Pnauslslw)o}r}d>]
                =   u s e S t a t e{(m'o'd)e
              = = =c'osnisgtn i[nm'o?d'eN,e esde taMno daec]c o=u nuts?e SStiagtne (u'ps'i:g'nAilnr'e)a
              d y  choanvset  a[nm eascscaoguen,t ?s eStiMgens siang'e}]
                =   u s e S t a<t/ed(invu>l
              l ) 
               
                   a s y<ndci vf ucnlcatsisoNna mhea=n"dlloegSiunb-mniott(ee")> A{c
                     c e s s  er.epsrterviecntteDde ftaou lrte(g)i
              s t e r esde tpLaoratdnienrgs( tornuley).
              < / d i vs>e
              t E r r o r (<n/udlilv)>
              
                      s<e/tdMievs>s
              a g e)(
              n}ull)
                  if (mode === 'signin') {
                          const { error } = await supabase.auth.signInWithPassword({ email, password })
                    if (error) { setError(error.message); setLoading(false) }
                } else {
                        const { error } = await supabase.auth.signUp({ email, password })
                    if (error) { setError(error.message) }
                    else { setMessage('Check your email to confirm, then sign in.') }
                    setLoading(false)
                }
                }
              
                return (
                  <div className="login-page">
                        <div className="login-card">
                                <div className="sv-logo">
                                          <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" width="72" height="72">
                                                      <circle cx="40" cy="40" r="40" fill="#0d1b3e"/>
                                                      <circle cx="40" cy="40" r="36" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
                                                      <text x="19" y="52" fontFamily="Georgia, serif" fontSize="36" fontWeight="700" fill="white" letterSpacing="-1">S</text>text>
                                                      <text x="39" y="52" fontFamily="Georgia, serif" fontSize="36" fontWeight="700" fill="rgba(255,255,255,0.85)" letterSpacing="-1">V</text>text>
                                                      <line x1="16" y1="57" x2="64" y2="57" stroke="#e8a045" strokeWidth="1.5" opacity="0.7"/>
                                          </svg>svg>
                                </div>div>
                                <div className="login-brand">
                                          <div className="login-title">Synergy Ventures</div>div>
                                          <div className="login-valeran">powered by Valeran</div>div>
                                </div>div>
                                <div className="login-tagline">Canton Fair 2025 - Field Intelligence System</div>div>
                                <form onSubmit={handleSubmit} style={{width:'100%',display:'flex',flexDirection:'column',gap:'12px',marginTop:'8px'}}>
                                          <input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required style={{padding:'12px 16px',borderRadius:'8px',border:'1px solid rgba(255,255,255,0.15)',background:'rgba(255,255,255,0.07)',color:'white',fontSize:'15px',outline:'none'}}/>
                                          <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required style={{padding:'12px 16px',borderRadius:'8px',border:'1px solid rgba(255,255,255,0.15)',background:'rgba(255,255,255,0.07)',color:'white',fontSize:'15px',outline:'none'}}/>
                                          <button type="submit" className="google-btn" disabled={loading} style={{justifyContent:'center'}}>
                                            {loading ? <span className="login-spinner"/> : (mode==='signin'?'Sign In':'Create Account')}
                                          </button>button>
                                </form>form>
                          {error && <div className="login-error">{error}</div>div>}
                          {message && <div className="login-error" style={{color:'#4ade80',borderColor:'#4ade80'}}>{message}</div>div>}
                                <div style={{marginTop:'12px',fontSize:'13px',color:'rgba(255,255,255,0.4)',cursor:'pointer'}} onClick={()=>{setMode(mode==='signin'?'signup':'signin');setError(null);setMessage(null)}}>
                                  {mode==='signin'?'Need an account? Sign up':'Already have an account? Sign in'}
                                </div>div>
                                <div className="login-note">Access restricted to registered partners only.</div>div>
                        </div>div>
                  </div>div>
                )
                }</div>
