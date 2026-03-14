import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL || ''

function SVLogo({ size = 44 }) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width={size} height={size} style={{ borderRadius: '10px', flexShrink: 0 }}>
      <rect width="120" height="120" fill="#000000" rx="10"/>
      <text x="8" y="82" fontFamily="Georgia, 'Times New Roman', serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">S</text>
      <text x="52" y="82" fontFamily="Georgia, 'Times New Roman', serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">V</text>
      <line x1="58" y1="95" x2="108" y2="55" stroke="white" strokeWidth="1.5" opacity="0.9"/>
    </svg>
  )
}

export default function Chat({ supabase, partner }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sessionInfo, setSessionInfo] = useState(null)
  const [todayCount, setTodayCount] = useState(0)
  const [error, setError] = useState(null)
  const [recording, setRecording] = useState(false)
  const mediaRef = useRef(null)
  const bottomRef = useRef(null)
  const fileRef  = useRef(null)

  useEffect(() => {
    loadMessages()
    loadSessionInfo()
    // Realtime: subscribe to new messages
    const channel = supabase
      .channel('chat_messages_live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
        setMessages(prev => {
          if (prev.find(m => m.id === payload.new.id)) return prev
          return [...prev, payload.new]
        })
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  async function loadMessages() {
    try {
      const token = await getToken()
      const res = await fetch(`${API}/api/chat/messages?limit=60`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.messages) setMessages(data.messages)
    } catch (e) { console.error('loadMessages:', e) }
  }

  async function loadSessionInfo() {
    try {
      const today = new Date().toISOString().split('T')[0]
      const { data: session } = await supabase.from('fair_sessions').select('*').lte('start_date', today).gte('end_date', today).single()
      setSessionInfo(session)
      const { count } = await supabase.from('products').select('*', { count: 'exact', head: true }).gte('created_at', today)
      setTodayCount(count || 0)
    } catch (e) { /* no active session */ }
  }

  async function sendMessage(text) {
    if (!text?.trim()) return
    setError(null)
    setSending(true)

    const tempId = 'temp-' + Date.now()
    setMessages(prev => [...prev, { id: tempId, role: 'user', content: text, created_at: new Date().toISOString() }])
    setInput('')

    try {
      const token = await getToken()
      const res = await fetch(`${API}/api/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text })
      })
      const data = await res.json()

      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== tempId)
        filtered.push({ id: 'u-' + Date.now(), role: 'user', content: text, created_at: new Date().toISOString() })
        if (data.reply) filtered.push({ id: 'a-' + Date.now(), role: 'assistant', content: data.reply, created_at: new Date().toISOString() })
        return filtered
      })
      if (data.error) setError(data.error)
    } catch (e) {
      setError('Connection error — please try again')
      setMessages(prev => prev.filter(m => m.id !== tempId))
    } finally {
      setSending(false)
    }
  }

  async function sendPhoto(file) {
    setSending(true); setError(null)
    const token = await getToken()
    const fd = new FormData()
    fd.append('photo', file)
    if (input) fd.append('caption', input)
    const tempId = 'temp-ph-' + Date.now()
    setMessages(prev => [...prev, { id: tempId, role: 'user', content: input || '📷 Photo', created_at: new Date().toISOString() }])
    setInput('')
    try {
      const res = await fetch(`${API}/api/chat/photo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
      const data = await res.json()
      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== tempId)
        filtered.push({ id: 'u-p-' + Date.now(), role: 'user', content: '📷 Photo', created_at: new Date().toISOString() })
        if (data.reply) filtered.push({ id: 'a-p-' + Date.now(), role: 'assistant', content: data.reply, created_at: new Date().toISOString() })
        return filtered
      })
    } catch (e) { setError('Photo upload failed') }
    finally { setSending(false) }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks = []
      recorder.ondataavailable = e => chunks.push(e.data)
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const token = await getToken()
        const fd = new FormData(); fd.append('audio', blob, 'voice.webm')
        setSending(true)
        try {
          const res = await fetch(`${API}/api/chat/voice`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
          const data = await res.json()
          if (data.transcript) {
            setMessages(prev => {
              const msgs = [...prev, { id: 'v-u-' + Date.now(), role: 'user', content: '🎤 "' + data.transcript + '"', created_at: new Date().toISOString() }]
              if (data.reply) msgs.push({ id: 'v-a-' + Date.now(), role: 'assistant', content: data.reply, created_at: new Date().toISOString() })
              return msgs
            })
          }
        } finally { setSending(false) }
        stream.getTracks().forEach(t => t.stop())
      }
      mediaRef.current = recorder; recorder.start(); setRecording(true)
    } catch (e) { setError('Microphone access denied') }
  }

  function stopRecording() { mediaRef.current?.stop(); setRecording(false) }
  function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  function isValeran(msg) { return msg.role === 'assistant' || msg.sender_type === 'valeran' }

  return (
    <div className="chat-page">
      {/* Header with real SV logo */}
      <div className="chat-header">
        <SVLogo size={42} />
        <div className="chat-header-info">
          <div className="chat-header-name">Valeran</div>
          <div className="chat-header-status">
            {sessionInfo ? `${sessionInfo.name} · ${todayCount} items today` : 'Ready — say "Valeran," to activate'}
          </div>
        </div>
        <div className="online-dot" />
      </div>

      {/* Messages */}
      <div className="messages-list">
        {messages.map(msg => (
          <div key={msg.id} className={`message-row ${isValeran(msg) ? 'valeran' : 'me'}`}>
            {isValeran(msg) && <div className="msg-sender valeran-name">Valeran</div>}
            <div className={`bubble ${isValeran(msg) ? 'valeran-bubble' : 'me-bubble'}`}>
              {isValeran(msg)
                ? <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
                : <span>{msg.content}</span>
              }
            </div>
            <div className={`msg-time ${!isValeran(msg) ? 'right' : ''}`}>{formatTime(msg.created_at)}</div>
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

      {/* Input bar */}
      <div className="chat-input-bar">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display:'none' }}
          onChange={e => e.target.files[0] && sendPhoto(e.target.files[0])} />
        <button className="input-action-btn" onClick={() => fileRef.current?.click()}><CameraIcon/></button>
        <input
          className="chat-input" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage(input)}
          placeholder='Say "Valeran, …" to ask something'
          disabled={sending || recording}
        />
        <button
          className={`input-action-btn mic-btn ${recording ? 'recording' : ''}`}
          onMouseDown={startRecording} onMouseUp={stopRecording}
          onTouchStart={startRecording} onTouchEnd={stopRecording}
        ><MicIcon/></button>
        {input.trim() && <button className="send-btn" onClick={() => sendMessage(input)} disabled={sending}><SendIcon/></button>}
      </div>
    </div>
  )
}

function CameraIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> }
function MicIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> }
function SendIcon()   { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> }
