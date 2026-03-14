import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL || ''

function SVLogo({ size = 36 }) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width={size} height={size} style={{ borderRadius: '8px', flexShrink: 0 }}>
      <rect width="120" height="120" fill="#000" rx="8"/>
      <text x="8" y="82" fontFamily="Georgia,serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">S</text>
      <text x="52" y="82" fontFamily="Georgia,serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">V</text>
      <line x1="58" y1="95" x2="108" y2="55" stroke="white" strokeWidth="1.5" opacity="0.9"/>
    </svg>
  )
}

const TEAM_COLORS = { alexander: '#e8a045', ina: '#7c6af7', konstantin: '#4ade80', slavi: '#fb7185', valeran: '#4ade80' }
function getMemberColor(name) {
  if (!name) return '#888'
  var k = name.toLowerCase()
  for (var key in TEAM_COLORS) { if (k.indexOf(key) > -1) return TEAM_COLORS[key] }
  return '#888'
}
function getInitials(name) {
  if (!name) return '?'
  var parts = name.trim().split(' ')
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0,2).toUpperCase()
}
function Avatar({ name, size = 28 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: getMemberColor(name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.38, fontWeight: '700', color: '#000', flexShrink: 0 }}>
      {getInitials(name)}
    </div>
  )
}

export default function Chat({ supabase, partner }) {
  const [messages,  setMessages]  = useState([])
  const [input,     setInput]     = useState('')
  const [sending,   setSending]   = useState(false)
  const [recording, setRecording] = useState(false)
  const [presence,  setPresence]  = useState([])
  const [typing,    setTyping]    = useState([]) // names of people typing
  const [stats,     setStats]     = useState({ products: 0, suppliers: 0, meetings: 0 })
  const [error,     setError]     = useState(null)
  const [tab,       setTab]       = useState('chat')
  const mediaRef    = useRef(null)
  const bottomRef   = useRef(null)
  const fileRef     = useRef(null)
  const cameraRef   = useRef(null)
  const pingRef     = useRef(null)
  const typingRef   = useRef(null)
  const broadcastRef = useRef(null)

  const myName = (partner && partner.name) || 'Me'

  useEffect(() => {
    loadMessages()
    loadPresence()
    loadStats()
    pingPresence()
    pingRef.current = setInterval(() => { pingPresence(); loadPresence() }, 30000)

    // ---- REALTIME: new messages ----
    // Key fix: realtime delivers the real message â we NEVER add it manually after send
    const msgChannel = supabase.channel('chat_messages_v2')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
        const m = payload.new
        if (m.session_id !== 'team-chat') return
        // If this message was sent by us, register its real DB id
        const mName = (m.telegram_user || '').toLowerCase().trim()
        const myN   = myName.toLowerCase().trim()
        if (m.role === 'user' && (mName === myN || (mName !== '' && myN.indexOf(mName.split(' ')[0]) > -1))) {
          myMsgIds.current.add(m.id)
        }
        setMessages(prev => {
          if (prev.find(x => x.id === m.id)) return prev
          const filtered = prev.filter(x => {
            if (!x.id || !x.id.toString().startsWith('tmp-')) return true
            const age = Date.now() - new Date(x.created_at).getTime()
            return !(x.content === m.content && age < 10000)
          })
          return [...filtered, m]
        })
      })
      .subscribe()

    // ---- BROADCAST: typing indicators ----
    const broadcastChannel = supabase.channel('typing_team_chat', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, payload => {
        const name = payload.payload && payload.payload.name
        if (!name) return
        const nameLower = name.toLowerCase()
        const myLower = myName.toLowerCase()
        // Don't show our own typing
        if (nameLower === myLower || myLower.indexOf(nameLower.split(' ')[0]) > -1) return
        setTyping(prev => prev.includes(name) ? prev : [...prev, name])
        setTimeout(() => setTyping(prev => prev.filter(n => n !== name)), 3500)
      })
      .subscribe()
    broadcastRef.current = broadcastChannel

    window.addEventListener('beforeunload', markOffline)
    return () => {
      clearInterval(pingRef.current)
      clearTimeout(typingRef.current)
      supabase.removeChannel(msgChannel)
      supabase.removeChannel(broadcastChannel)
      window.removeEventListener('beforeunload', markOffline)
      markOffline()
    }
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, tab])

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }
  async function pingPresence() {
    const t = await getToken(); if (!t) return
    fetch(API + '/api/presence/ping', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ platform: 'web' }) }).catch(() => {})
  }
  async function markOffline() {
    const t = await getToken(); if (!t) return
    fetch(API + '/api/presence/offline', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, keepalive: true }).catch(() => {})
  }
  async function loadPresence() {
    const t = await getToken(); if (!t) return
    const r = await fetch(API + '/api/presence', { headers: { Authorization: 'Bearer ' + t } }).catch(() => null)
    if (r && r.ok) { const d = await r.json(); setPresence(d.presence || []) }
  }
  async function loadStats() {
    const t = await getToken(); if (!t) return
    try {
      const [pr, sr, mr] = await Promise.all([
        fetch(API + '/api/products',  { headers: { Authorization: 'Bearer ' + t } }),
        fetch(API + '/api/suppliers', { headers: { Authorization: 'Bearer ' + t } }),
        fetch(API + '/api/meetings',  { headers: { Authorization: 'Bearer ' + t } })
      ])
      const [pd, sd, md] = await Promise.all([pr.json(), sr.json(), mr.json()])
      setStats({ products: (pd.products||[]).length, suppliers: (sd.suppliers||[]).length, meetings: (md.meetings||[]).length })
    } catch(e) {}
  }
  async function loadMessages() {
    const t = await getToken()
    const r = await fetch(API + '/api/chat/messages?limit=60&session_id=team-chat', { headers: { Authorization: 'Bearer ' + t } }).catch(() => null)
    if (r && r.ok) { const d = await r.json(); if (d.messages) setMessages(d.messages) }
  }

  // Broadcast typing to others
  function broadcastTyping() {
    if (broadcastRef.current) {
      broadcastRef.current.send({ type: 'broadcast', event: 'typing', payload: { name: myName } })
    }
  }

  function handleInputChange(e) {
    setInput(e.target.value)
    // Debounce typing broadcasts
    clearTimeout(typingRef.current)
    if (e.target.value.trim()) {
      broadcastTyping()
      typingRef.current = setTimeout(broadcastTyping, 1500)
    }
  }

  function isValeranMsg(msg) { return msg.role === 'assistant' }
  function getSenderName(msg) {
    if (isValeranMsg(msg)) return 'Valeran'
    return msg.telegram_user || myName
  }
  // Track IDs of messages sent by this user in this session
  const myMsgIds = useRef(new Set())
  
  function isMe(msg) {
    if (isValeranMsg(msg)) return false
    // Check our local sent-message registry first (most reliable)
    if (msg.id && myMsgIds.current.has(msg.id)) return true
    // Temp messages (not yet confirmed) are always ours
    if (msg.id && msg.id.toString().startsWith('tmp-')) return true
    // Compare sender name
    var sender = (msg.telegram_user || '').toLowerCase().trim()
    var me = myName.toLowerCase().trim()
    return sender === me || (sender !== '' && me !== '' && (sender === me || me.indexOf(sender.split(' ')[0]) > -1))
  }

  // ---- SEND â key rule: add temp optimistic message, let realtime replace it ----
  async function sendMessage() {
    var text = input.trim(); if (!text || sending) return
    setError(null); setSending(true); setInput('')
    var isValeranCall = /^valeran[,\s!?]/i.test(text) || /^valera[,\s!?]/i.test(text) || /^\u0432\u0430\u043b\u0435\u0440\u0430/i.test(text)

    // Add optimistic temp message (will be replaced by realtime with real DB id)
    var tempId = 'tmp-' + Date.now()
    setMessages(p => [...p, { id: tempId, role: 'user', content: text, telegram_user: myName, created_at: new Date().toISOString() }])

    try {
      const t = await getToken()
      if (isValeranCall) {
        // Valeran call â AI responds
        const r = await fetch(API + '/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
          body: JSON.stringify({ text, session_id: 'team-chat' })
        })
        const d = await r.json()
        // Remove temp â realtime will deliver the real user message
        // Valeran reply comes via realtime too (saved in processMessage)
        setMessages(p => p.filter(m => m.id !== tempId))
        // If for some reason realtime didn't deliver Valeran's reply, add it manually
        if (d.reply) {
          setTimeout(() => {
            setMessages(p => {
              if (p.find(m => m.role === 'assistant' && m.content === d.reply)) return p
              return [...p, { id: 'local-a-' + Date.now(), role: 'assistant', content: d.reply, created_at: new Date().toISOString() }]
            })
          }, 1000)
        }
      } else {
        // Team message â just save, realtime delivers it
        await fetch(API + '/api/chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
          body: JSON.stringify({ text, session_id: 'team-chat' })
        })
        // Remove temp â realtime will deliver the real message
        setMessages(p => p.filter(m => m.id !== tempId))
      }
    } catch(e) {
      setError('Error sending')
      setMessages(p => p.filter(m => m.id !== tempId))
    } finally { setSending(false) }
  }

  async function sendPhoto(file) {
    setSending(true); setError(null)
    const t = await getToken()
    const fd = new FormData(); fd.append('photo', file)
    if (input.trim()) { fd.append('caption', input); setInput('') }
    var tempId = 'tmp-ph-' + Date.now()
    setMessages(p => [...p, { id: tempId, role: 'user', content: 'ð· ' + file.name, telegram_user: myName, created_at: new Date().toISOString() }])
    try {
      const r = await fetch(API + '/api/chat/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd })
      const d = await r.json()
      setMessages(p => {
        const f = p.filter(m => m.id !== tempId)
        f.push({ id: 'local-ph-' + Date.now(), role: 'user', content: 'ð· ' + file.name, telegram_user: myName, created_at: new Date().toISOString() })
        if (d.reply) f.push({ id: 'local-a-' + Date.now(), role: 'assistant', content: d.reply, created_at: new Date().toISOString() })
        return f
      })
    } catch(e) { setError('Photo error'); setMessages(p => p.filter(m => m.id !== tempId)) }
    finally { setSending(false) }
  }

  async function sendFile(file) {
    setSending(true); setError(null)
    const t = await getToken()
    const fd = new FormData(); fd.append('file', file)
    var tempId = 'tmp-f-' + Date.now()
    setMessages(p => [...p, { id: tempId, role: 'user', content: 'ð ' + file.name + ' â analysing...', telegram_user: myName, created_at: new Date().toISOString() }])
    try {
      const r = await fetch(API + '/api/catalogue/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd })
      const d = await r.json()
      setMessages(p => {
        const f = p.filter(m => m.id !== tempId)
        f.push({ id: 'local-f-' + Date.now(), role: 'user', content: 'ð ' + file.name, telegram_user: myName, created_at: new Date().toISOString() })
        if (d.message) f.push({ id: 'local-fa-' + Date.now(), role: 'assistant', content: d.message, created_at: new Date().toISOString() })
        return f
      })
    } catch(e) { setError('File error'); setMessages(p => p.filter(m => m.id !== tempId)) }
    finally { setSending(false) }
  }

  function handleFilePicked(e) {
    const file = e.target.files && e.target.files[0]; if (!file) return
    e.target.value = ''
    if (file.type.startsWith('image/')) sendPhoto(file); else sendFile(file)
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream); const chunks = []
      rec.ondataavailable = e => chunks.push(e.data)
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const t = await getToken()
        const fd = new FormData(); fd.append('audio', blob, 'voice.webm')
        setSending(true)
        var tempId = 'tmp-v-' + Date.now()
        setMessages(p => [...p, { id: tempId, role: 'user', content: 'ð¤ ...', telegram_user: myName, created_at: new Date().toISOString() }])
        try {
          const r = await fetch(API + '/api/chat/voice', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd })
          const d = await r.json()
          setMessages(p => {
            const f = p.filter(m => m.id !== tempId)
            if (d.transcript) f.push({ id: 'v-u-' + Date.now(), role: 'user', content: 'ð¤ "' + d.transcript + '"', telegram_user: myName, created_at: new Date().toISOString() })
            if (d.reply) f.push({ id: 'v-a-' + Date.now(), role: 'assistant', content: d.reply, created_at: new Date().toISOString() })
            return f
          })
        } catch(e) { setError('Voice error') }
        finally { setSending(false); stream.getTracks().forEach(t => t.stop()) }
      }
      mediaRef.current = rec; rec.start(); setRecording(true)
    } catch(e) { setError('Microphone denied') }
  }
  function stopRecording() { mediaRef.current?.stop(); setRecording(false) }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const onlineCount = presence.filter(p => p.is_online).length

  return (
    <div className="chat-page">
      {/* HEADER */}
      <div className="chat-header">
        <SVLogo size={36} />
        <div className="chat-header-info">
          <div className="chat-header-name">Synergy Ventures</div>
          <div className="chat-header-status">{onlineCount > 0 ? onlineCount + ' online' : 'Canton Fair 2026'}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setTab('chat')} style={{ background: tab==='chat' ? 'rgba(255,255,255,0.15)' : 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'white', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Chat</button>
          <button onClick={() => setTab('dashboard')} style={{ background: tab==='dashboard' ? 'rgba(255,255,255,0.15)' : 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'white', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Info</button>
        </div>
      </div>

      {/* PRESENCE STRIP */}
      {presence.length > 0 && (
        <div className="presence-bar">
          {presence.map(p => (
            <div key={p.email} className={'presence-pill ' + (p.is_online ? 'online' : 'offline')}>
              <span className={'presence-dot ' + (p.is_online ? 'online' : 'offline')} />
              {p.name || p.email.split('@')[0]}
            </div>
          ))}
        </div>
      )}

      {/* ===== DASHBOARD ===== */}
      {tab === 'dashboard' && (
        <div className="dashboard">
          <div className="dash-stats">
            <div className="dash-stat"><div className="dash-stat-num">{stats.products}</div><div className="dash-stat-label">Products</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{stats.suppliers}</div><div className="dash-stat-label">Suppliers</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{stats.meetings}</div><div className="dash-stat-label">Meetings</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{onlineCount}</div><div className="dash-stat-label">Online</div></div>
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Canton Fair 2026 Â· 139th Session</div>
            {[
              { phase: 'Phase 1', dates: 'Apr 15â19', cats: 'Electronics, Hardware, Lighting, Tools, Smart Home', color: '#e8a045' },
              { phase: 'Phase 2', dates: 'Apr 23â27', cats: 'Home Goods, Ceramics, Furniture, Gifts, Garden', color: '#7c6af7' },
              { phase: 'Phase 3', dates: 'May 1â5',   cats: 'Fashion, Textiles, Toys, Personal Care, Food',  color: '#4ade80' },
            ].map(ph => (
              <div key={ph.phase} style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-start' }}>
                <div style={{ width: 4, borderRadius: 4, background: ph.color, alignSelf: 'stretch', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: ph.color }}>{ph.phase} Â· {ph.dates}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{ph.cats}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Team</div>
            {[
              { name: 'Alexander Oslan',      role: 'Owner Â· Strategy',         lang: 'EN' },
              { name: 'Ina Kanaplianikava',   role: 'Partner Â· Quality',         lang: 'RU' },
              { name: 'Konstantin Khoch',     role: 'Partner Â· Negotiations',    lang: 'RU' },
              { name: 'Konstantin Ganev',     role: 'Partner Â· Logistics',       lang: 'BG' },
              { name: 'Slavi Mikinski',       role: 'Observer Â· Remote',         lang: 'BG' },
            ].map(m => {
              var online = presence.find(p => p.name && p.name.toLowerCase().indexOf(m.name.split(' ')[0].toLowerCase()) > -1 && p.is_online)
              return (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <Avatar name={m.name} size={32} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{m.role} Â· {m.lang}</div>
                  </div>
                  <div style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: online ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.06)', color: online ? '#4ade80' : 'rgba(255,255,255,0.3)', border: '1px solid ' + (online ? 'rgba(74,222,128,0.3)' : 'transparent') }}>
                    {online ? 'â online' : 'offline'}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Venue & Contacts</div>
            <div className="dash-info-row"><span>ð</span><span>Pazhou Complex, No.380 Yuejiang Zhong Rd, Guangzhou</span></div>
            <div className="dash-info-row"><span>ð¡ï¸</span><span>April: 22â28Â°C, humid, frequent rain â bring umbrella</span></div>
            <div className="dash-info-row"><span>ð</span><span>CFTC: 4000-888-999 (CN) / +86-20-28-888-999</span></div>
            <div className="dash-info-row"><span>ð</span><span>cantonfair.org.cn Â· Canton Fair APP</span></div>
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Margin Formula</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7 }}>
              <div>Landed = buy Ã 1.12 (freight) Ã 1.035 (duty)</div>
              <div>Net = (sell â landed â 15% fees â 10% ads) Ã· sell</div>
              <div style={{ color: '#4ade80', fontWeight: 600, marginTop: 4 }}>Target: &gt;35% Â· Example: buy $4 â sell â¬18 â margin 51% â</div>
            </div>
          </div>
        </div>
      )}

      {/* ===== CHAT ===== */}
      {tab === 'chat' && (
        <>
          <div className="messages-list">
            <div style={{ textAlign:'center', fontSize:11, color:'rgba(255,255,255,0.2)', padding:'6px 0' }}>
              "Valeran, ..." â AI Â· Everything else â team chat
            </div>

            {messages.map(msg => {
              var mine   = isMe(msg)
              var valMsg = isValeranMsg(msg)
              var sender = getSenderName(msg)
              return (
                <div key={msg.id} className={'message-row ' + (mine ? 'me' : valMsg ? 'valeran' : 'them')}>
                  {!mine && (
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                      {valMsg ? <SVLogo size={20} /> : <Avatar name={sender} size={20} />}
                      <span style={{ fontSize:11, fontWeight:600, color: valMsg ? '#4ade80' : getMemberColor(sender) }}>{sender}</span>
                    </div>
                  )}
                  <div className={'bubble ' + (mine ? 'me-bubble' : valMsg ? 'valeran-bubble' : 'them-bubble')}>
                    {valMsg ? <ReactMarkdown>{msg.content || ''}</ReactMarkdown> : <span>{msg.content}</span>}
                  </div>
                  <div className={'msg-time ' + (mine ? 'right' : '')}>{formatTime(msg.created_at)}</div>
                </div>
              )
            })}

            {/* Valeran typing (AI thinking) */}
            {sending && (
              <div className="message-row valeran">
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                  <SVLogo size={20} /><span style={{ fontSize:11, fontWeight:600, color:'#4ade80' }}>Valeran</span>
                </div>
                <div className="bubble valeran-bubble typing"><span/><span/><span/></div>
              </div>
            )}

            {/* Team typing indicators */}
            {typing.length > 0 && (
              <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', padding:'2px 4px', display:'flex', alignItems:'center', gap:6 }}>
                <div className="typing-dots"><span/><span/><span/></div>
                {typing.join(', ')} {typing.length === 1 ? 'is' : 'are'} typingâ¦
              </div>
            )}

            {error && <div className="chat-error">â ï¸ {error}</div>}
            <div ref={bottomRef} />
          </div>

          {/* INPUT BAR */}
          <div className="chat-input-bar">
            <input ref={fileRef} type="file" accept="image/*,video/*,.pdf,.doc,.docx,.txt,.xlsx,.csv" style={{ display:'none' }} onChange={handleFilePicked} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display:'none' }} onChange={handleFilePicked} />
            <button className="input-action-btn" onClick={() => fileRef.current?.click()} title="Attach"><AttachIcon /></button>
            <button className="input-action-btn" onClick={() => cameraRef.current?.click()} title="Camera"><CameraIcon /></button>
            <input className="chat-input" value={input}
              onChange={handleInputChange}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder='Message team Â· "Valeran, â¦" for AI'
              disabled={recording} />
            <button className={'input-action-btn mic-btn ' + (recording ? 'recording' : '')}
              onMouseDown={startRecording} onMouseUp={stopRecording}
              onTouchStart={e => { e.preventDefault(); startRecording() }}
              onTouchEnd={e => { e.preventDefault(); stopRecording() }}
              title="Hold to record"><MicIcon /></button>
            {input.trim() && <button className="send-btn" onClick={sendMessage} disabled={sending}><SendIcon /></button>}
          </div>
        </>
      )}
    </div>
  )
}

function AttachIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> }
function CameraIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> }
function MicIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> }
function SendIcon()   { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> }
