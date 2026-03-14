import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL || ''

function SVLogo({ size = 42 }) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width={size} height={size} style={{ borderRadius: '10px', flexShrink: 0 }}>
      <rect width="120" height="120" fill="#000" rx="10"/>
      <text x="8" y="82" fontFamily="Georgia, serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">S</text>
      <text x="52" y="82" fontFamily="Georgia, serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">V</text>
      <line x1="58" y1="95" x2="108" y2="55" stroke="white" strokeWidth="1.5" opacity="0.9"/>
    </svg>
  )
}

export default function Chat({ supabase, partner }) {
  const [messages,  setMessages]  = useState([])
  const [input,     setInput]     = useState('')
  const [sending,   setSending]   = useState(false)
  const [recording, setRecording] = useState(false)
  const [presence,  setPresence]  = useState([])
  const [error,     setError]     = useState(null)
  const mediaRef   = useRef(null)
  const bottomRef  = useRef(null)
  const fileRef    = useRef(null)   // gallery/docs
  const cameraRef  = useRef(null)   // camera only
  const pingRef    = useRef(null)

  useEffect(() => {
    loadMessages()
    loadPresence()

    // Ping presence every 30s
    pingPresence()
    pingRef.current = setInterval(pingPresence, 30000)

    // Realtime chat subscription
    const ch = supabase.channel('chat_live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
        setMessages(prev => prev.find(m => m.id === payload.new.id) ? prev : [...prev, payload.new])
      })
      .subscribe()

    // Realtime presence subscription
    const ph = supabase.channel('presence_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'partner_presence' }, () => loadPresence())
      .subscribe()

    // Mark offline on unload
    window.addEventListener('beforeunload', markOffline)
    return () => {
      clearInterval(pingRef.current)
      supabase.removeChannel(ch)
      supabase.removeChannel(ph)
      window.removeEventListener('beforeunload', markOffline)
      markOffline()
    }
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  async function pingPresence() {
    const token = await getToken()
    if (!token) return
    fetch(API + '/api/presence/ping', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ platform: 'web' }) }).catch(() => {})
  }

  async function markOffline() {
    const token = await getToken()
    if (!token) return
    navigator.sendBeacon ? navigator.sendBeacon(API + '/api/presence/offline') :
      fetch(API + '/api/presence/offline', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, keepalive: true }).catch(() => {})
  }

  async function loadPresence() {
    const token = await getToken()
    if (!token) return
    const r = await fetch(API + '/api/presence', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null)
    if (!r || !r.ok) return
    const d = await r.json()
    setPresence(d.presence || [])
  }

  async function loadMessages() {
    const token = await getToken()
    const r = await fetch(API + '/api/chat/messages?limit=60', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null)
    if (!r || !r.ok) return
    const d = await r.json()
    if (d.messages) setMessages(d.messages)
  }

  // ---- SEND TEXT ----
  async function sendMessage(text) {
    if (!text?.trim() || sending) return
    setError(null); setSending(true)
    const tempId = 'tmp-' + Date.now()
    setMessages(p => [...p, { id: tempId, role: 'user', content: text, created_at: new Date().toISOString() }])
    setInput('')
    try {
      const token = await getToken()
      const r = await fetch(API + '/api/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ text }) })
      const d = await r.json()
      setMessages(p => {
        const f = p.filter(m => m.id !== tempId)
        f.push({ id: 'u-' + Date.now(), role: 'user', content: text, created_at: new Date().toISOString() })
        if (d.reply) f.push({ id: 'a-' + Date.now(), role: 'assistant', content: d.reply, created_at: new Date().toISOString() })
        return f
      })
      if (d.error) setError(d.error)
    } catch(e) {
      setError('Connection error')
      setMessages(p => p.filter(m => m.id !== tempId))
    } finally { setSending(false) }
  }

  // ---- SEND PHOTO (camera or gallery image) ----
  async function sendPhoto(file) {
    setSending(true); setError(null)
    const token = await getToken()
    const fd = new FormData()
    fd.append('photo', file)
    if (input.trim()) { fd.append('caption', input); setInput('') }
    const tempId = 'tmp-ph-' + Date.now()
    setMessages(p => [...p, { id: tempId, role: 'user', content: '📷 ' + file.name, created_at: new Date().toISOString() }])
    try {
      const r = await fetch(API + '/api/chat/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
      const d = await r.json()
      setMessages(p => {
        const f = p.filter(m => m.id !== tempId)
        f.push({ id: 'u-p-' + Date.now(), role: 'user', content: '📷 ' + file.name, created_at: new Date().toISOString() })
        if (d.reply) f.push({ id: 'a-p-' + Date.now(), role: 'assistant', content: d.reply, created_at: new Date().toISOString() })
        return f
      })
    } catch(e) { setError('Photo upload failed'); setMessages(p => p.filter(m => m.id !== tempId)) }
    finally { setSending(false) }
  }

  // ---- SEND DOCUMENT / FILE ----
  async function sendFile(file) {
    setSending(true); setError(null)
    const token = await getToken()
    const fd = new FormData()
    fd.append('file', file)
    const tempId = 'tmp-f-' + Date.now()
    setMessages(p => [...p, { id: tempId, role: 'user', content: '📎 ' + file.name + ' — analysing...', created_at: new Date().toISOString() }])
    try {
      const r = await fetch(API + '/api/catalogue/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
      const d = await r.json()
      setMessages(p => {
        const f = p.filter(m => m.id !== tempId)
        f.push({ id: 'u-f-' + Date.now(), role: 'user', content: '📎 ' + file.name, created_at: new Date().toISOString() })
        if (d.message) f.push({ id: 'a-f-' + Date.now(), role: 'assistant', content: d.message, created_at: new Date().toISOString() })
        return f
      })
    } catch(e) { setError('File upload failed'); setMessages(p => p.filter(m => m.id !== tempId)) }
    finally { setSending(false) }
  }

  // ---- HANDLE FILE PICKER (smart routing: image → photo, other → doc) ----
  function handleFilePicked(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    e.target.value = ''
    const isImage = file.type.startsWith('image/')
    if (isImage) sendPhoto(file)
    else sendFile(file)
  }

  // ---- VOICE RECORDING ----
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = e => chunks.push(e.data)
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const token = await getToken()
        const fd = new FormData(); fd.append('audio', blob, 'voice.webm')
        setSending(true)
        const tempId = 'tmp-v-' + Date.now()
        setMessages(p => [...p, { id: tempId, role: 'user', content: '🎤 ...', created_at: new Date().toISOString() }])
        try {
          const r = await fetch(API + '/api/chat/voice', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
          const d = await r.json()
          setMessages(p => {
            const f = p.filter(m => m.id !== tempId)
            if (d.transcript) f.push({ id: 'v-u-' + Date.now(), role: 'user', content: '🎤 "' + d.transcript + '"', created_at: new Date().toISOString() })
            if (d.reply) f.push({ id: 'v-a-' + Date.now(), role: 'assistant', content: d.reply, created_at: new Date().toISOString() })
            return f
          })
        } catch(e) { setError('Voice error') }
        finally { setSending(false) }
        stream.getTracks().forEach(t => t.stop())
      }
      mediaRef.current = rec; rec.start(); setRecording(true)
    } catch(e) { setError('Microphone access denied') }
  }
  function stopRecording() { mediaRef.current?.stop(); setRecording(false) }

  function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  function isValeran(m) { return m.role === 'assistant' }

  return (
    <div className="chat-page">
      {/* HEADER */}
      <div className="chat-header">
        <SVLogo size={42} />
        <div className="chat-header-info">
          <div className="chat-header-name">Valeran</div>
          <div className="chat-header-status">Canton Fair 2026 · AI Assistant</div>
        </div>
        <div className="online-dot" title="Valeran online" />
      </div>

      {/* PRESENCE BAR */}
      {presence.length > 0 && (
        <div className="presence-bar">
          {presence.map(p => (
            <div key={p.email} className={'presence-pill ' + (p.is_online ? 'online' : 'offline')} title={p.email}>
              <span className={'presence-dot ' + (p.is_online ? 'online' : 'offline')} />
              <span>{p.name || p.email.split('@')[0]}</span>
            </div>
          ))}
        </div>
      )}

      {/* MESSAGES */}
      <div className="messages-list">
        {messages.map(msg => (
          <div key={msg.id} className={'message-row ' + (isValeran(msg) ? 'valeran' : 'me')}>
            {isValeran(msg) && <div className="msg-sender valeran-name">Valeran</div>}
            <div className={'bubble ' + (isValeran(msg) ? 'valeran-bubble' : 'me-bubble')}>
              {isValeran(msg) ? <ReactMarkdown>{msg.content || ''}</ReactMarkdown> : <span>{msg.content}</span>}
            </div>
            <div className={'msg-time ' + (!isValeran(msg) ? 'right' : '')}>{formatTime(msg.created_at)}</div>
          </div>
        ))}
        {sending && (
          <div className="message-row valeran">
            <div className="bubble valeran-bubble typing"><span/><span/><span/></div>
          </div>
        )}
        {error && <div className="chat-error">⚠️ {error}</div>}
        <div ref={bottomRef} />
      </div>

      {/* INPUT BAR */}
      <div className="chat-input-bar">
        {/* Hidden file inputs */}
        <input ref={fileRef} type="file"
          accept="image/*,video/*,.pdf,.doc,.docx,.txt,.xlsx,.xls,.csv"
          style={{ display: 'none' }} onChange={handleFilePicked} />
        <input ref={cameraRef} type="file"
          accept="image/*" capture="environment"
          style={{ display: 'none' }} onChange={handleFilePicked} />

        {/* Attachment button — opens gallery+docs picker */}
        <button className="input-action-btn" onClick={() => fileRef.current?.click()} title="Attach file or photo">
          <AttachIcon />
        </button>

        {/* Camera button — opens camera directly */}
        <button className="input-action-btn" onClick={() => cameraRef.current?.click()} title="Take photo">
          <CameraIcon />
        </button>

        <input className="chat-input" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage(input)}
          placeholder='Say "Valeran, …"'
          disabled={sending || recording} />

        {/* Mic — hold to record */}
        <button
          className={'input-action-btn mic-btn ' + (recording ? 'recording' : '')}
          onMouseDown={startRecording} onMouseUp={stopRecording}
          onTouchStart={e => { e.preventDefault(); startRecording() }}
          onTouchEnd={e => { e.preventDefault(); stopRecording() }}
          title="Hold to record voice">
          <MicIcon />
        </button>

        {input.trim() && (
          <button className="send-btn" onClick={() => sendMessage(input)} disabled={sending}>
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}

function AttachIcon()  { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> }
function CameraIcon()  { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> }
function MicIcon()     { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> }
function SendIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> }
