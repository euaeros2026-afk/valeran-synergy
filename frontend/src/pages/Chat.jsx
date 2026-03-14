import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL || ''

function SVLogo({ size=36 }) {
  return <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width={size} height={size} style={{borderRadius:'8px',flexShrink:0}}><rect width="120" height="120" fill="#000" rx="8"/><text x="8" y="82" fontFamily="Georgia,serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">S</text><text x="52" y="82" fontFamily="Georgia,serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">V</text><line x1="58" y1="95" x2="108" y2="55" stroke="white" strokeWidth="1.5" opacity="0.9"/></svg>
}
const COLORS = {alexander:'#e8a045',ina:'#7c6af7',konstantin:'#4ade80',slavi:'#fb7185'}
function nameColor(n){if(!n)return'#888';var k=n.toLowerCase();for(var key in COLORS){if(k.includes(key))return COLORS[key]}return'#888'}
function initials(n){if(!n)return'?';var p=n.trim().split(' ');return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.slice(0,2).toUpperCase()}
function Avatar({name,size=28}){return <div style={{width:size,height:size,borderRadius:'50%',background:nameColor(name),display:'flex',alignItems:'center',justifyContent:'center',fontSize:size*0.38,fontWeight:'700',color:'#000',flexShrink:0}}>{initials(name)}</div>}

// Global — readable by all callbacks without closure issues
window.__valeranUser = window.__valeranUser || ''

export default function Chat({ supabase, partner }) {
  const [messages,  setMessages]  = useState([])
  const [input,     setInput]     = useState('')
  const [sending,   setSending]   = useState(false)
  const [recording, setRecording] = useState(false)
  const [presence,  setPresence]  = useState([])
  const [typing,    setTyping]    = useState([])
  const [stats,     setStats]     = useState({products:0,suppliers:0,meetings:0})
  const [error,     setError]     = useState(null)
  const [tab,       setTab]       = useState('chat')
  const [replyTo,   setReplyTo]   = useState(null)
  const [showEmoji, setShowEmoji] = useState(false)

  const mediaRef    = useRef(null)
  const bottomRef   = useRef(null)
  const fileRef     = useRef(null)
  const cameraRef   = useRef(null)
  const inputRef    = useRef(null)
  const pingRef     = useRef(null)
  const typingTimers = useRef({})
  const bcastRef    = useRef(null)

  // Keep global in sync — no closure capture needed
  const myName = (partner && partner.name) || ''
  window.__valeranUser = myName

  useEffect(() => {
    loadMessages()
    loadPresence()
    loadStats()
    pingPresence()
    pingRef.current = setInterval(() => { pingPresence(); loadPresence() }, 30000)

    // REALTIME: read window.__valeranUser — never stale, no closure
    const ch = supabase.channel('sv_chat_v6')
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'chat_messages' }, function(payload) {
        var m = payload.new
        if (m.session_id !== 'team-chat') return
        setMessages(function(prev) {
          // Already in list by ID?
          if (prev.find(function(x){ return x.id === m.id })) return prev
          // Replace matching temp (my temp for this exact content)
          var me = (window.__valeranUser || '').toLowerCase()
          var sender = (m.telegram_user || '').toLowerCase()
          var isMyMsg = m.role === 'user' && me && sender === me
          if (isMyMsg) {
            // Replace temp placeholder with real DB message
            var replaced = prev.map(function(x) {
              if (x._tmp && x.content === m.content) return Object.assign({}, m, {_mine: true})
              return x
            })
            // If we didn't find a temp to replace, just add it
            if (!replaced.find(function(x){ return x.id === m.id })) {
              return replaced.concat([Object.assign({}, m, {_mine: true})])
            }
            return replaced
          }
          // Someone else's message — just add it
          return prev.concat([m])
        })
      })
      .subscribe()

    // Typing
    var bCh = supabase.channel('typing_sv_v2', { config:{ broadcast:{ self:false } } })
      .on('broadcast', { event:'typing' }, function(payload) {
        var name = payload.payload && payload.payload.name
        if (!name) return
        var me = window.__valeranUser || ''
        if (me && name.toLowerCase() === me.toLowerCase()) return
        setTyping(function(prev){ return prev.includes(name) ? prev : prev.concat([name]) })
        clearTimeout(typingTimers.current[name])
        typingTimers.current[name] = setTimeout(function(){
          setTyping(function(prev){ return prev.filter(function(n){ return n !== name }) })
        }, 3500)
      })
      .subscribe()
    bcastRef.current = bCh

    window.addEventListener('beforeunload', markOffline)
    return function() {
      clearInterval(pingRef.current)
      supabase.removeChannel(ch)
      supabase.removeChannel(bCh)
      window.removeEventListener('beforeunload', markOffline)
      markOffline()
    }
  }, [])

  useEffect(function(){ bottomRef.current && bottomRef.current.scrollIntoView({ behavior:'smooth' }) }, [messages, tab])

  async function getToken() { var s = await supabase.auth.getSession(); return s.data.session && s.data.session.access_token }
  async function pingPresence() { var t=await getToken();if(!t)return;fetch(API+'/api/presence/ping',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({platform:'web'})}).catch(function(){}) }
  async function markOffline() { var t=await getToken();if(!t)return;fetch(API+'/api/presence/offline',{method:'POST',headers:{Authorization:'Bearer '+t},keepalive:true}).catch(function(){}) }
  async function loadPresence() { var t=await getToken();if(!t)return;var r=await fetch(API+'/api/presence',{headers:{Authorization:'Bearer '+t}}).catch(function(){return null});if(r&&r.ok){var d=await r.json();setPresence(d.presence||[])} }
  async function loadStats() { var t=await getToken();if(!t)return;try{var r=await Promise.all([fetch(API+'/api/products',{headers:{Authorization:'Bearer '+t}}),fetch(API+'/api/suppliers',{headers:{Authorization:'Bearer '+t}}),fetch(API+'/api/meetings',{headers:{Authorization:'Bearer '+t}})]);var d=await Promise.all(r.map(function(x){return x.json()}));setStats({products:(d[0].products||[]).length,suppliers:(d[1].suppliers||[]).length,meetings:(d[2].meetings||[]).length})}catch(e){} }
  async function loadMessages() {
    var t=await getToken()
    var r=await fetch(API+'/api/chat/messages?limit=60&session_id=team-chat',{headers:{Authorization:'Bearer '+t}}).catch(function(){return null})
    if(!r||!r.ok)return
    var d=await r.json()
    if(!d.messages)return
    var me=(window.__valeranUser||'').toLowerCase()
    setMessages(d.messages.map(function(m){
      return Object.assign({},m,{ _mine: m.role==='user' && me && (m.telegram_user||'').toLowerCase()===me })
    }))
  }

  function handleInput(e) {
    setInput(e.target.value)
    if (e.target.value.trim() && bcastRef.current) {
      bcastRef.current.send({ type:'broadcast', event:'typing', payload:{ name: window.__valeranUser||'Someone' } })
    }
  }

  function insertEmoji(e2) {
    var el=inputRef.current
    if(el){var s=el.selectionStart||input.length,end=el.selectionEnd||input.length;setInput(function(v){return v.slice(0,s)+e2+v.slice(end)});setTimeout(function(){el.focus();el.setSelectionRange(s+e2.length,s+e2.length)},0)}else{setInput(function(v){return v+e2})}
    setShowEmoji(false)
  }

  function isMine(m) { return !!m._mine }
  function isValeran(m) { return m.role==='assistant' }
  function getSender(m) { return isValeran(m)?'Valeran':(m.telegram_user||window.__valeranUser||'Partner') }
  function fmt(ts) { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) }

  function addTemp(content) {
    var t={ id:'tmp-'+Date.now(), role:'user', content:content, telegram_user:window.__valeranUser||'', _mine:true, _tmp:true, created_at:new Date().toISOString() }
    setMessages(function(p){ return p.concat([t]) })
    return t
  }
  function addAI(reply) {
    setMessages(function(p){ return p.concat([{id:'ai-'+Date.now(),role:'assistant',content:reply,_mine:false,created_at:new Date().toISOString()}]) })
  }

  async function sendMessage() {
    var text=input.trim();if(!text||sending)return
    setError(null);setSending(true);setInput('');setShowEmoji(false)
    var full=text
    if(replyTo){full='[Reply to '+replyTo.senderName+': "'+replyTo.content.slice(0,60)+(replyTo.content.length>60?'...':'')+'"]
'+text;setReplyTo(null)}
    var isAI=/^(valeran|valera|валера)[,s!?.]/i.test(text)
    addTemp(full)
    try{
      var t=await getToken()
      if(isAI){
        var r=await fetch(API+'/api/chat/message',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({text:full,session_id:'team-chat'})})
        var d=await r.json()
        if(d.reply)addAI(d.reply)
      }else{
        await fetch(API+'/api/chat/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({text:full,session_id:'team-chat'})})
      }
    }catch(e){setError('Send failed')}
    finally{setSending(false)}
  }

  async function sendPhoto(file){
    setSending(true);setError(null);var t=await getToken()
    var fd=new FormData();fd.append('photo',file)
    if(input.trim()){fd.append('caption',input);setInput('')}
    addTemp('📷 '+file.name)
    try{var r=await fetch(API+'/api/chat/photo',{method:'POST',headers:{Authorization:'Bearer '+t},body:fd});var d=await r.json();if(d.reply)addAI(d.reply)}catch(e){setError('Photo failed')}
    finally{setSending(false)}
  }
  async function sendFile(file){
    setSending(true);setError(null);var t=await getToken()
    var fd=new FormData();fd.append('file',file)
    addTemp('📎 '+file.name+' — analysing...')
    try{var r=await fetch(API+'/api/catalogue/upload',{method:'POST',headers:{Authorization:'Bearer '+t},body:fd});var d=await r.json();if(d.message)addAI(d.message)}catch(e){setError('File failed')}
    finally{setSending(false)}
  }
  function onFile(e){var f=e.target.files&&e.target.files[0];if(!f)return;e.target.value='';if(f.type.startsWith('image/'))sendPhoto(f);else sendFile(f)}

  async function startRec(){
    try{
      var stream=await navigator.mediaDevices.getUserMedia({audio:true})
      var rec=new MediaRecorder(stream);var chunks=[]
      rec.ondataavailable=function(e){chunks.push(e.data)}
      rec.onstop=async function(){
        var blob=new Blob(chunks,{type:'audio/webm'});var t=await getToken()
        var fd=new FormData();fd.append('audio',blob,'v.webm')
        setSending(true);addTemp('🎤 ...')
        try{var r=await fetch(API+'/api/chat/voice',{method:'POST',headers:{Authorization:'Bearer '+t},body:fd});var d=await r.json();if(d.transcript){setMessages(function(p){var f=[].concat(p);for(var i=f.length-1;i>=0;i--){if(f[i]._tmp&&f[i].content==='🎤 ...'){f[i]=Object.assign({},f[i],{content:'🎤 "'+d.transcript+'"'});break}}return f})}if(d.reply)addAI(d.reply)}catch(e){setError('Voice failed')}finally{setSending(false);stream.getTracks().forEach(function(t){t.stop()})}
      }
      mediaRef.current=rec;rec.start();setRecording(true)
    }catch(e){setError('Mic denied')}
  }
  function stopRec(){mediaRef.current&&mediaRef.current.stop();setRecording(false)}

  var onlineCount=presence.filter(function(p){return p.is_online}).length

  var EMOJIS=['😊','😂','👍','❤️','🔥','✅','👌','💪','🎯','📦','💰','🏭','🤝','⚡','🇨🇳','🇪🇺','📊','💡','🚀','😅','🙏','👏','😎','🤔','💯','⭐','📸','🎉','😮','👋']

  return (
    <div className="chat-page">
      <div className="chat-header">
        <SVLogo size={36}/>
        <div className="chat-header-info">
          <div className="chat-header-name">Synergy Ventures</div>
          <div className="chat-header-status">{onlineCount>0?onlineCount+' online':'Canton Fair 2026'}</div>
        </div>
        <div style={{display:'flex',gap:6}}>
          <button onClick={function(){setTab('chat')}} style={{background:tab==='chat'?'rgba(255,255,255,0.15)':'none',border:'1px solid rgba(255,255,255,0.15)',color:'white',borderRadius:8,padding:'4px 10px',fontSize:12,cursor:'pointer'}}>Chat</button>
          <button onClick={function(){setTab('dash')}} style={{background:tab==='dash'?'rgba(255,255,255,0.15)':'none',border:'1px solid rgba(255,255,255,0.15)',color:'white',borderRadius:8,padding:'4px 10px',fontSize:12,cursor:'pointer'}}>Dashboard</button>
        </div>
      </div>

      {presence.length>0 && (
        <div className="presence-bar">
          {presence.map(function(p){return(
            <div key={p.email} className={'presence-pill '+(p.is_online?'online':'offline')}>
              <span className={'presence-dot '+(p.is_online?'online':'offline')}/>
              {p.name||p.email.split('@')[0]}
            </div>
          )})}
        </div>
      )}

      {tab==='dash' && (
        <div className="dashboard">
          <div className="dash-stats">
            <div className="dash-stat"><div className="dash-stat-num">{stats.products}</div><div className="dash-stat-label">Products</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{stats.suppliers}</div><div className="dash-stat-label">Suppliers</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{stats.meetings}</div><div className="dash-stat-label">Meetings</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{onlineCount}</div><div className="dash-stat-label">Online</div></div>
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Canton Fair 2026</div>
            {[{ph:'Phase 1',d:'Apr 15-19',c:'Electronics · Hardware · Lighting · Tools',col:'#e8a045'},{ph:'Phase 2',d:'Apr 23-27',c:'Home Goods · Ceramics · Furniture · Gifts',col:'#7c6af7'},{ph:'Phase 3',d:'May 1-5',c:'Fashion · Textiles · Toys · Personal Care',col:'#4ade80'}].map(function(p){return(
              <div key={p.ph} style={{display:'flex',gap:10,padding:'8px 0',borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                <div style={{width:3,borderRadius:2,background:p.col,flexShrink:0}}/>
                <div><div style={{fontWeight:700,fontSize:13,color:p.col}}>{p.ph} <span style={{fontWeight:400,color:'rgba(255,255,255,0.45)'}}>· {p.d}</span></div><div style={{fontSize:11,color:'rgba(255,255,255,0.4)',marginTop:2}}>{p.c}</div></div>
              </div>
            )})}
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Team</div>
            {[{n:'Alexander Oslan',r:'Owner · EN'},{n:'Ina Kanaplianikava',r:'Partner · RU'},{n:'Konstantin Khoch',r:'Partner · RU'},{n:'Konstantin Ganev',r:'Partner · BG'},{n:'Slavi Mikinski',r:'Observer · BG'}].map(function(m){
              var on=presence.find(function(p){return p.is_online&&p.name&&p.name.toLowerCase().includes(m.n.split(' ')[0].toLowerCase())})
              return(<div key={m.n} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid rgba(255,255,255,0.05)'}}><Avatar name={m.n} size={30}/><div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{m.n}</div><div style={{fontSize:11,color:'rgba(255,255,255,0.4)'}}>{m.r}</div></div><div style={{width:7,height:7,borderRadius:'50%',flexShrink:0,background:on?'#4ade80':'rgba(255,255,255,0.15)',boxShadow:on?'0 0 6px #4ade80':'none'}}/></div>)
            })}
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Venue</div>
            <div className="dash-info-row"><span>📍</span><span>Pazhou Complex, No.380 Yuejiang Zhong Rd, Guangzhou</span></div>
            <div className="dash-info-row"><span>🌦</span><span>April: 22-28°C, humid, rain — bring umbrella</span></div>
            <div className="dash-info-row"><span>📞</span><span>CFTC: 4000-888-999 · +86-20-28-888-999</span></div>
            <div className="dash-info-row"><span>🌐</span><span>cantonfair.org.cn · Canton Fair APP</span></div>
          </div>
          <div className="dash-card">
            <div className="dash-card-title">Margin Target &gt;35%</div>
            <div style={{fontSize:12,color:'rgba(255,255,255,0.55)',lineHeight:1.8}}>
              <div>Landed = buy × 1.12 (freight) × 1.035 (duty)</div>
              <div>Net = (sell − landed − 15% fees − 10% ads) ÷ sell</div>
              <div style={{marginTop:6,padding:'6px 10px',background:'rgba(74,222,128,0.08)',borderRadius:8,border:'1px solid rgba(74,222,128,0.2)',color:'#4ade80',fontWeight:600}}>Example: buy $4 → sell €18 → margin 51% ✅</div>
            </div>
          </div>
        </div>
      )}

      {tab==='chat' && (
        <React.Fragment>
          <div className="messages-list">
            <div style={{textAlign:'center',fontSize:11,color:'rgba(255,255,255,0.2)',padding:'6px 0'}}>"Valeran, ..." for AI · your messages on the right</div>
            {messages.map(function(msg){
              var mine=isMine(msg), val=isValeran(msg), name=getSender(msg)
              return(
                <div key={msg.id} style={{display:'flex',flexDirection:'column',alignItems:mine?'flex-end':'flex-start',marginBottom:10}}>
                  {!mine&&(<div style={{display:'flex',alignItems:'center',gap:5,marginBottom:3,paddingLeft:4}}>{val?<SVLogo size={18}/>:<Avatar name={name} size={18}/>}<span style={{fontSize:11,fontWeight:600,color:val?'#4ade80':nameColor(name)}}>{name}</span></div>)}
                  <div style={{display:'flex',alignItems:'flex-end',gap:4,flexDirection:mine?'row-reverse':'row'}}>
                    <div className={'bubble '+(mine?'me-bubble':val?'valeran-bubble':'them-bubble')} style={{maxWidth:'78%',borderRadius:mine?'16px 4px 16px 16px':'4px 16px 16px 16px'}}>
                      {val?<ReactMarkdown>{msg.content||''}</ReactMarkdown>:<span>{msg.content}</span>}
                    </div>
                    <button onClick={function(){setReplyTo({id:msg.id,content:msg.content,senderName:getSender(msg)});inputRef.current&&inputRef.current.focus()}} className="reply-btn" style={{background:'none',border:'none',cursor:'pointer',fontSize:13,color:'rgba(255,255,255,0)',padding:'0 2px',flexShrink:0,transition:'color .15s'}}>↩</button>
                  </div>
                  <div style={{fontSize:10,color:'rgba(255,255,255,0.3)',marginTop:2,paddingLeft:mine?0:4,paddingRight:mine?4:0}}>{fmt(msg.created_at)}</div>
                </div>
              )
            })}
            {sending&&(<div style={{display:'flex',flexDirection:'column',alignItems:'flex-start',marginBottom:10}}><div style={{display:'flex',alignItems:'center',gap:5,marginBottom:3,paddingLeft:4}}><SVLogo size={18}/><span style={{fontSize:11,fontWeight:600,color:'#4ade80'}}>Valeran</span></div><div className="bubble valeran-bubble typing"><span/><span/><span/></div></div>)}
            {typing.length>0&&(<div style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'rgba(255,255,255,0.4)',paddingLeft:4}}><div className="typing-dots"><span/><span/><span/></div><span>{typing.join(', ')} {typing.length===1?'is':'are'} typing…</span></div>)}
            {error&&<div className="chat-error">⚠️ {error}</div>}
            <div ref={bottomRef}/>
          </div>

          {replyTo&&(<div style={{background:'rgba(255,255,255,0.06)',borderLeft:'3px solid #e8a045',padding:'6px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:12,color:'rgba(255,255,255,0.7)',flexShrink:0}}><div><span style={{color:'#e8a045',fontWeight:600}}>{replyTo.senderName}</span> · {replyTo.content.slice(0,55)}{replyTo.content.length>55?'...':''}</div><button onClick={function(){setReplyTo(null)}} style={{background:'none',border:'none',color:'rgba(255,255,255,0.5)',cursor:'pointer',fontSize:20,lineHeight:1,padding:'0 4px'}}>×</button></div>)}
          {showEmoji&&(<div style={{background:'#1a2a4a',border:'1px solid rgba(255,255,255,0.1)',borderRadius:12,padding:'10px 12px',display:'flex',flexWrap:'wrap',gap:6,maxHeight:150,overflowY:'auto',flexShrink:0}}>{EMOJIS.map(function(e2){return(<button key={e2} onClick={function(){insertEmoji(e2)}} style={{background:'none',border:'none',cursor:'pointer',fontSize:22,padding:'2px',borderRadius:4,lineHeight:1}}>{e2}</button>)})}</div>)}

          <div className="chat-input-bar">
            <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.txt,.xlsx,.xls,.csv,.pptx,.ppt" style={{display:'none'}} onChange={onFile}/>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={onFile}/>
            <button className="input-action-btn" onClick={function(){fileRef.current&&fileRef.current.click()}} title="Attach"><AttachIcon/></button>
            <button className="input-action-btn" onClick={function(){cameraRef.current&&cameraRef.current.click()}} title="Camera"><CameraIcon/></button>
            <input ref={inputRef} className="chat-input" value={input} onChange={handleInput} onKeyDown={function(e){if(e.key==='Enter'&&!e.shiftKey)sendMessage()}} placeholder='"Valeran, …" for AI · or just chat' disabled={recording}/>
            <button className="input-action-btn" onClick={function(){setShowEmoji(function(p){return!p})}} style={{fontSize:18}} title="Emoji">😊</button>
            <button className={'input-action-btn mic-btn '+(recording?'recording':'')} onMouseDown={startRec} onMouseUp={stopRec} onTouchStart={function(e){e.preventDefault();startRec()}} onTouchEnd={function(e){e.preventDefault();stopRec()}} title="Hold to record"><MicIcon/></button>
            {input.trim()&&<button className="send-btn" onClick={sendMessage} disabled={sending}><SendIcon/></button>}
          </div>
        </React.Fragment>
      )}
    </div>
  )
}

function AttachIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>}
function CameraIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>}
function MicIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>}
function SendIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>}
