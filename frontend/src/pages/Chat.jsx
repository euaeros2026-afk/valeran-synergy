import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL

export default function Chat({ supabase, partner }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sessionInfo, setSessionInfo] = useState(null)
  const [todayCount, setTodayCount] = useState(0)
  const [recording, setRecording] = useState(false)
  const mediaRef = useRef(null)
  const bottomRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => {
    loadMessages()
    loadSessionInfo()
    // Real-time subscription
    const channel = supabase
      .channel('messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
        setMessages(prev => [...prev, payload.new])
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadMessages() {
    const token = (await supabase.auth.getSession()).data.session.access_token
    const res = await fetch(`${API}/api/chat/messages?limit=60`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json()
    setMessages(data.messages || [])
  }

  async function loadSessionInfo() {
    const today = new Date().toISOString().split('T')[0]
    const { data: session } = await supabase
      .from('fair_sessions').select('*')
      .lte('start_date', today).gte('end_date', today).single()
    setSessionInfo(session)

    const { count } = await supabase
      .from('products').select('*', { count: 'exact', head: true })
      .gte('created_at', today)
    setTodayCount(count || 0)
  }

  async function sendMessage(text, type = 'text', extra = {}) {
    if (!text.trim() && type === 'text') return
    setSending(true)

    // Optimistic UI — add user message immediately
    const tempMsg = {
      id: 'temp-' + Date.now(),
      sender_type: 'partner',
      content: text,
      message_type: type,
      created_at: new Date().toISOString(),
      partners: { full_name: partner?.full_name, display_name: partner?.display_name }
    }
    setMessages(prev => [...prev, tempMsg])
    setInput('')

    try {
      const token = (await supabase.auth.getSession()).data.session.access_token
      const res = await fetch(`${API}/api/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text, ...extra })
      })
      const data = await res.json()

      // Replace temp with real, add Valeran reply if any
      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== tempMsg.id)
        const withRealMsg = [...filtered]
        if (data.responded && data.reply) {
          withRealMsg.push({
            id: 'v-' + Date.now(),
            sender_type: 'valeran',
            content: data.reply,
            message_type: 'text',
            created_at: new Date().toISOString()
          })
        }
        return withRealMsg
      })

      if (data.entityRefs && Object.keys(data.entityRefs).length) {
        setTodayCount(c => c + 1)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setSending(false)
    }
  }

  async function sendPhoto(file) {
    setSending(true)
    const token = (await supabase.auth.getSession()).data.session.access_token
    const fd = new FormData()
    fd.append('photo', file)
    fd.append('caption', input || '')

    // Optimistic
    const tempMsg = {
      id: 'temp-photo-' + Date.now(),
      sender_type: 'partner',
      content: input || '📷 Photo',
      message_type: 'photo',
      created_at: new Date().toISOString(),
      partners: { full_name: partner?.full_name }
    }
    setMessages(prev => [...prev, tempMsg])
    setInput('')

    try {
      const res = await fetch(`${API}/api/chat/photo`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
      })
      const data = await res.json()
      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== tempMsg.id)
        if (data.responded && data.reply) {
          filtered.push({
            id: 'vp-' + Date.now(), sender_type: 'valeran',
            content: data.reply, message_type: 'text',
            created_at: new Date().toISOString()
          })
        }
        return filtered
      })
    } catch (e) { console.error(e) }
    finally { setSending(false) }
  }

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream)
    const chunks = []
    recorder.ondataavailable = e => chunks.push(e.data)
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' })
      const token = (await supabase.auth.getSession()).data.session.access_token
      const fd = new FormData()
      fd.append('audio', blob, 'voice.webm')
      setSending(true)
      try {
        const res = await fetch(`${API}/api/chat/voice`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
        })
        const data = await res.json()
        if (data.transcript) {
          const tempMsg = {
            id: 'v-msg-' + Date.now(), sender_type: 'partner',
            content: `🎤 "${data.transcript}"`, message_type: 'voice',
            created_at: new Date().toISOString(),
            partners: { full_name: partner?.full_name }
          }
          setMessages(prev => {
            const msgs = [...prev, tempMsg]
            if (data.responded && data.reply) {
              msgs.push({
                id: 'vr-' + Date.now(), sender_type: 'valeran',
                content: data.reply, message_type: 'text',
                created_at: new Date().toISOString()
              })
            }
            return msgs
          })
        }
      } finally { setSending(false) }
      stream.getTracks().forEach(t => t.stop())
    }
    mediaRef.current = recorder
    recorder.start()
    setRecording(true)
  }

  function stopRecording() {
    mediaRef.current?.stop()
    setRecording(false)
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function groupMessages() {
    const groups = []
    let lastDate = null
    for (const msg of messages) {
      const d = new Date(msg.created_at).toLocaleDateString()
      if (d !== lastDate) { groups.push({ type: 'date', date: d, id: 'date-' + d }); lastDate = d }
      groups.push({ type: 'message', ...msg })
    }
    return groups
  }

  return (
    <div className="chat-page">
      <div className="chat-header">
        <div className="valeran-avatar">V</div>
        <div className="chat-header-info">
          <div className="chat-header-name">Valeran</div>
          <div className="chat-header-status">
            {sessionInfo ? `${sessionInfo.name} · ${todayCount} items today` : 'Listening · say "Valeran" to activate'}
          </div>
        </div>
        <div className="online-dot" />
      </div>

      <div className="messages-list">
        {groupMessages().map(item => {
          if (item.type === 'date') {
            return <div key={item.id} className="date-divider">{item.date}</div>
          }
          const isValeran = item.sender_type === 'valeran'
          const isMe = item.sender_id === partner?.id
          return (
            <div key={item.id} className={`message-row ${isValeran ? 'valeran' : isMe ? 'me' : 'them'}`}>
              {!isMe && !isValeran && (
                <div className="msg-sender">{item.partners?.display_name || item.partners?.full_name}</div>
              )}
              {isValeran && <div className="msg-sender valeran-name">Valeran</div>}
              <div className={`bubble ${isValeran ? 'valeran-bubble' : isMe ? 'me-bubble' : 'them-bubble'}`}>
                {isValeran
                  ? <ReactMarkdown>{item.content}</ReactMarkdown>
                  : <span>{item.content}</span>
                }
              </div>
              <div className={`msg-time ${isMe ? 'right' : ''}`}>{formatTime(item.created_at)}</div>
            </div>
          )
        })}
        {sending && (
          <div className="message-row valeran">
            <div className="bubble valeran-bubble typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-bar">
        <input
          ref={fileRef} type="file" accept="image/*" capture="environment"
          style={{ display: 'none' }}
          onChange={e => e.target.files[0] && sendPhoto(e.target.files[0])}
        />
        <button className="input-action-btn" onClick={() => fileRef.current?.click()}>
          <CameraIcon />
        </button>
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage(input)}
          placeholder='Message or say "Valeran..."'
          disabled={sending || recording}
        />
        <button
          className={`input-action-btn mic-btn ${recording ? 'recording' : ''}`}
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onTouchStart={startRecording}
          onTouchEnd={stopRecording}
        >
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

function CameraIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> }
function MicIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> }
function SendIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> }
