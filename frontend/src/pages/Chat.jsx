import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'

const API = import.meta.env.VITE_API_URL || ''

function SVLogo({ size=36 }) {
  return <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" width={size} height={size} style={{borderRadius:'8px',flexShrink:0}}><rect width="120" height="120" fill="#000" rx="8"/><text x="8" y="82" fontFamily="Georgia,serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">S</text><text x="52" y="82" fontFamily="Georgia,serif" fontSize="74" fontWeight="700" fill="white" letterSpacing="-2">V</text><line x1="58" y1="95" x2="108" y2="55" stroke="white" strokeWidth="1.5" opacity="0.9"/></svg>
}

const COLORS = {alexander:'#e8a045',ina:'#7c6af7',konstantin:'#4ade80',slavi:'#fb7185',valeran:'#4ade80'}
function nameColor(n){if(!n)return'#888';var k=n.toLowerCase();for(var key in COLORS){if(k.includes(key))return COLORS[key]}return'#888'}
function initials(n){if(!n)return'?';var p=n.trim().split(' ');return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.slice(0,2).toUpperCase()}
function Avatar({name,size=28}){return <div style={{width:size,height:size,borderRadius:'50%',background:nameColor(name),display:'flex',alignItems:'center',justifyContent:'center',fontSize:size*0.38,fontWeight:'700',color:'#000',flexShrink:0}}>{initials(name)}</div>}

export default function Chat({ supabase, partner }) {
  const [messages,setMessages]=useState([])
  const [input,setInput]=useState('')
  const [sending,setSending]=useState(false)
  const [recording,setRecording]=useState(false)
  const [presence,setPresence]=useState([])
  const [typing,setTyping]=useState([])
  const [stats,setStats]=useState({products:0,suppliers:0,meetings:0})
  const [error,setError]=useState(null)
  const [tab,setTab]=useState('chat')
  const [replyTo,setReplyTo]=useState(null)  // {id, content, senderName}
  const [showEmoji,setShowEmoji]=useState(false)
  const mediaRef=useRef(null),bottomRef=useRef(null),fileRef=useRef(null),cameraRef=useRef(null),inputRef=useRef(null)
  const pingRef=useRef(null),typingTimer=useRef({}),broadcastCh=useRef(null),myTempIds=useRef(new Set())

  // The logged-in user's name Ã¢ÂÂ single source of truth
  const myName = (partner&&partner.name)||''

  useEffect(()=>{
    loadMessages();loadPresence();loadStats();pingPresence()
    pingRef.current=setInterval(()=>{pingPresence();loadPresence()},30000)

    // New messages via realtime
    const msgCh=supabase.channel('chat_msgs_v4')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'chat_messages'},payload=>{
        const m=payload.new
        if(m.session_id!=='team-chat')return
        // Tag as mine: telegram_user matches myName exactly (case-insensitive)
        const tagged=Object.assign({},m,{
          _mine:m.role==='user'&&myNameRef.current&&(m.telegram_user||'').toLowerCase()===myNameRef.current.toLowerCase()
        })
        setMessages(prev=>{
          if(prev.find(x=>x.id===m.id))return prev
          // Remove temp placeholder with same content that I sent
          const filtered=prev.filter(x=>{
            if(!String(x.id).startsWith('tmp-'))return true
            if(!myTempIds.current.has(x.id))return true
            return x.content!==m.content
          })
          return [...filtered,tagged]
        })
      }).subscribe()

    // Typing broadcasts
    const bCh=supabase.channel('typing_team_chat',{config:{broadcast:{self:false}}})
      .on('broadcast',{event:'typing'},payload=>{
        const name=payload.payload&&payload.payload.name
        if(!name)return
        if(myNameRef.current&&name.toLowerCase()===myNameRef.current.toLowerCase())return
        setTyping(prev=>prev.includes(name)?prev:[...prev,name])
        clearTimeout(typingTimer.current[name])
        typingTimer.current[name]=setTimeout(()=>setTyping(prev=>prev.filter(n=>n!==name)),3500)
      }).subscribe()
    broadcastCh.current=bCh

    window.addEventListener('beforeunload',markOffline)
    return()=>{clearInterval(pingRef.current);supabase.removeChannel(msgCh);supabase.removeChannel(bCh);window.removeEventListener('beforeunload',markOffline);markOffline()}
  },[])

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'})},[messages,tab])

  async function getToken(){const{data:{session}}=await supabase.auth.getSession();return session?.access_token}
  async function pingPresence(){const t=await getToken();if(!t)return;fetch(API+'/api/presence/ping',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({platform:'web'})}).catch(()=>{})}
  async function markOffline(){const t=await getToken();if(!t)return;fetch(API+'/api/presence/offline',{method:'POST',headers:{Authorization:'Bearer '+t},keepalive:true}).catch(()=>{})}
  async function loadPresence(){const t=await getToken();if(!t)return;const r=await fetch(API+'/api/presence',{headers:{Authorization:'Bearer '+t}}).catch(()=>null);if(r&&r.ok){const d=await r.json();setPresence(d.presence||[])}}
  async function loadStats(){const t=await getToken();if(!t)return;try{const[pr,sr,mr]=await Promise.all([fetch(API+'/api/products',{headers:{Authorization:'Bearer '+t}}),fetch(API+'/api/suppliers',{headers:{Authorization:'Bearer '+t}}),fetch(API+'/api/meetings',{headers:{Authorization:'Bearer '+t}})]);const[pd,sd,md]=await Promise.all([pr.json(),sr.json(),mr.json()]);setStats({products:(pd.products||[]).length,suppliers:(sd.suppliers||[]).length,meetings:(md.meetings||[]).length})}catch(e){}}

  async function loadMessages(){
    const t=await getToken()
    const r=await fetch(API+'/api/chat/messages?limit=60&session_id=team-chat',{headers:{Authorization:'Bearer '+t}}).catch(()=>null)
    if(r&&r.ok){const d=await r.json();if(d.messages){
      // Tag historical messages as mine if telegram_user === myName
      setMessages(d.messages.map(m=>Object.assign({},m,{
        _mine:m.role==='user'&&myNameRef.current&&(m.telegram_user||'').toLowerCase()===myNameRef.current.toLowerCase()
      })))
    }}
  }

  function handleInputChange(e){
    setInput(e.target.value)
    if(e.target.value.trim()&&broadcastCh.current){
      broadcastCh.current.send({type:'broadcast',event:'typing',payload:{name:myName||'Someone'}})
    }
  }

  function insertEmoji(emoji){
    const el=inputRef.current
    if(el){
      const start=el.selectionStart||input.length
      const end=el.selectionEnd||input.length
      const newVal=input.slice(0,start)+emoji+input.slice(end)
      setInput(newVal)
      setTimeout(()=>{el.focus();el.setSelectionRange(start+emoji.length,start+emoji.length)},0)
    } else {
      setInput(p=>p+emoji)
    }
    setShowEmoji(false)
  }

  function isValeran(msg){return msg.role==='assistant'}
  function isMine(msg){
    if(isValeran(msg))return false
    // _mine is set at load time and on realtime delivery Ã¢ÂÂ most reliable
    if(msg._mine)return true
    // Temp messages added optimistically are always ours
    if(myTempIds.current.has(msg.id))return true
    return false
  }
  function senderName(msg){if(isValeran(msg))return'Valeran';return msg.telegram_user||myName||'Partner'}
  function formatTime(ts){return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}

  async function sendMessage(){
    var text=input.trim();if(!text||sending)return
    setError(null);setSending(true);setInput('')
    var isAI=/^(valeran|valera|ÃÂ²ÃÂ°ÃÂ»ÃÂµÃÂÃÂ°)[,s!?.]/i.test(text)
    var tempId='tmp-'+Date.now();myTempIds.current.add(tempId)
    setMessages(p=>[...p,{id:tempId,role:'user',content:fullText,telegram_user:myName,_mine:true,created_at:new Date().toISOString()}])
    try{
      const t=await getToken()
      if(isAI){
        const r=await fetch(API+'/api/chat/message',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({text:fullText,session_id:'team-chat'})})
        const d=await r.json()
        setMessages(p=>p.filter(m=>m.id!==tempId)) // realtime delivers real msg
        if(d.reply)setMessages(p=>[...p,{id:'va-'+Date.now(),role:'assistant',content:d.reply,_mine:false,created_at:new Date().toISOString()}])
      }else{
        await fetch(API+'/api/chat/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({text:fullText,session_id:'team-chat'})})
        setMessages(p=>p.filter(m=>m.id!==tempId)) // realtime delivers real msg
      }
    }catch(e){setError('Error sending');setMessages(p=>p.filter(m=>m.id!==tempId));myTempIds.current.delete(tempId)}
    finally{setSending(false)}
  }

  async function sendPhoto(file){
    setSending(true);setError(null);const t=await getToken()
    const fd=new FormData();fd.append('photo',file)
    if(input.trim()){fd.append('caption',input);setInput('')}
    var tempId='tmp-ph-'+Date.now();myTempIds.current.add(tempId)
    setMessages(p=>[...p,{id:tempId,role:'user',content:'Ã°ÂÂÂ· '+file.name,telegram_user:myName,_mine:true,created_at:new Date().toISOString()}])
    try{
      const r=await fetch(API+'/api/chat/photo',{method:'POST',headers:{Authorization:'Bearer '+t},body:fd})
      const d=await r.json()
      setMessages(p=>{const f=p.filter(m=>m.id!==tempId);f.push({id:'ph-u-'+Date.now(),role:'user',content:'Ã°ÂÂÂ· '+file.name,telegram_user:myName,_mine:true,created_at:new Date().toISOString()});if(d.reply)f.push({id:'ph-a-'+Date.now(),role:'assistant',content:d.reply,_mine:false,created_at:new Date().toISOString()});return f})
    }catch(e){setError('Photo error');setMessages(p=>p.filter(m=>m.id!==tempId))}finally{setSending(false)}
  }

  async function sendFile(file){
    setSending(true);setError(null);const t=await getToken()
    const fd=new FormData();fd.append('file',file)
    var tempId='tmp-f-'+Date.now();myTempIds.current.add(tempId)
    setMessages(p=>[...p,{id:tempId,role:'user',content:'Ã°ÂÂÂ '+file.name+' Ã¢ÂÂ analysing...',telegram_user:myName,_mine:true,created_at:new Date().toISOString()}])
    try{
      const r=await fetch(API+'/api/catalogue/upload',{method:'POST',headers:{Authorization:'Bearer '+t},body:fd})
      const d=await r.json()
      setMessages(p=>{const f=p.filter(m=>m.id!==tempId);f.push({id:'f-u-'+Date.now(),role:'user',content:'Ã°ÂÂÂ '+file.name,telegram_user:myName,_mine:true,created_at:new Date().toISOString()});if(d.message)f.push({id:'f-a-'+Date.now(),role:'assistant',content:d.message,_mine:false,created_at:new Date().toISOString()});return f})
    }catch(e){setError('File error');setMessages(p=>p.filter(m=>m.id!==tempId))}finally{setSending(false)}
  }

  function handleFilePicked(e){const file=e.target.files&&e.target.files[0];if(!file)return;e.target.value='';if(file.type.startsWith('image/'))sendPhoto(file);else sendFile(file)}

  async function startRecording(){
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true})
      const rec=new MediaRecorder(stream);const chunks=[]
      rec.ondataavailable=e=>chunks.push(e.data)
      rec.onstop=async()=>{
        const blob=new Blob(chunks,{type:'audio/webm'});const t=await getToken()
        const fd=new FormData();fd.append('audio',blob,'voice.webm')
        setSending(true);var tempId='tmp-v-'+Date.now();myTempIds.current.add(tempId)
        setMessages(p=>[...p,{id:tempId,role:'user',content:'Ã°ÂÂÂ¤ ...',telegram_user:myName,_mine:true,created_at:new Date().toISOString()}])
        try{
          const r=await fetch(API+'/api/chat/voice',{method:'POST',headers:{Authorization:'Bearer '+t},body:fd})
          const d=await r.json()
          setMessages(p=>{const f=p.filter(m=>m.id!==tempId);if(d.transcript)f.push({id:'v-u-'+Date.now(),role:'user',content:'Ã°ÂÂÂ¤ "'+d.transcript+'"',telegram_user:myName,_mine:true,created_at:new Date().toISOString()});if(d.reply)f.push({id:'v-a-'+Date.now(),role:'assistant',content:d.reply,_mine:false,created_at:new Date().toISOString()});return f})
        }catch(e){setError('Voice error')}finally{setSending(false);stream.getTracks().forEach(t=>t.stop())}
      }
      mediaRef.current=rec;rec.start();setRecording(true)
    }catch(e){setError('Microphone denied')}
  }
  function stopRecording(){mediaRef.current?.stop();setRecording(false)}

  const onlineCount=presence.filter(p=>p.is_online).length

  return (
    <div className="chat-page">
      <div className="chat-header">
        <SVLogo size={36}/>
        <div className="chat-header-info">
          <div className="chat-header-name">Synergy Ventures</div>
          <div className="chat-header-status">{onlineCount>0?onlineCount+' online':'Canton Fair 2026'}</div>
        </div>
        <div style={{display:'flex',gap:6}}>
          <button onClick={()=>setTab('chat')} style={{background:tab==='chat'?'rgba(255,255,255,0.15)':'none',border:'1px solid rgba(255,255,255,0.15)',color:'white',borderRadius:8,padding:'4px 10px',fontSize:12,cursor:'pointer'}}>Chat</button>
          <button onClick={()=>setTab('dashboard')} style={{background:tab==='dashboard'?'rgba(255,255,255,0.15)':'none',border:'1px solid rgba(255,255,255,0.15)',color:'white',borderRadius:8,padding:'4px 10px',fontSize:12,cursor:'pointer'}}>Info</button>
        </div>
      </div>

      {presence.length>0&&(
        <div className="presence-bar">
          {presence.map(p=>(
            <div key={p.email} className={'presence-pill '+(p.is_online?'online':'offline')}>
              <span className={'presence-dot '+(p.is_online?'online':'offline')}/>
              {p.name||p.email.split('@')[0]}
            </div>
          ))}
        </div>
      )}

      {tab==='dashboard'&&(
        <div className="dashboard">
          <div className="dash-stats">
            <div className="dash-stat"><div className="dash-stat-num">{stats.products}</div><div className="dash-stat-label">Products</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{stats.suppliers}</div><div className="dash-stat-label">Suppliers</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{stats.meetings}</div><div className="dash-stat-label">Meetings</div></div>
            <div className="dash-stat"><div className="dash-stat-num">{onlineCount}</div><div className="dash-stat-label">Online</div></div>
          </div>
          <div className="dash-card"><div className="dash-card-title">Canton Fair 2026 ÃÂ· 139th Session</div>
            {[{phase:'Phase 1',dates:'Apr 15-19',cats:'Electronics, Hardware, Lighting, Tools',color:'#e8a045'},{phase:'Phase 2',dates:'Apr 23-27',cats:'Home Goods, Ceramics, Furniture, Gifts',color:'#7c6af7'},{phase:'Phase 3',dates:'May 1-5',cats:'Fashion, Textiles, Toys, Personal Care',color:'#4ade80'}].map(ph=>(
              <div key={ph.phase} style={{display:'flex',gap:12,marginBottom:12,alignItems:'flex-start'}}>
                <div style={{width:4,borderRadius:4,background:ph.color,alignSelf:'stretch',flexShrink:0}}/>
                <div><div style={{fontSize:13,fontWeight:700,color:ph.color}}>{ph.phase} ÃÂ· {ph.dates}</div><div style={{fontSize:11,color:'rgba(255,255,255,0.5)',marginTop:2}}>{ph.cats}</div></div>
              </div>))}
          </div>
          <div className="dash-card"><div className="dash-card-title">Team</div>
            {[{name:'Alexander Oslan',role:'Owner ÃÂ· Strategy',lang:'EN'},{name:'Ina Kanaplianikava',role:'Partner ÃÂ· Quality',lang:'RU'},{name:'Konstantin Khoch',role:'Partner ÃÂ· Negotiations',lang:'RU'},{name:'Konstantin Ganev',role:'Partner ÃÂ· Logistics',lang:'BG'},{name:'Slavi Mikinski',role:'Observer ÃÂ· Remote',lang:'BG'}].map(m=>{
              var online=presence.find(p=>p.name&&p.name.toLowerCase().includes(m.name.split(' ')[0].toLowerCase())&&p.is_online)
              return(<div key={m.name} style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}><Avatar name={m.name} size={32}/><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{m.name}</div><div style={{fontSize:11,color:'rgba(255,255,255,0.45)'}}>{m.role} ÃÂ· {m.lang}</div></div><div style={{fontSize:10,padding:'2px 8px',borderRadius:20,background:online?'rgba(74,222,128,0.15)':'rgba(255,255,255,0.06)',color:online?'#4ade80':'rgba(255,255,255,0.3)',border:'1px solid '+(online?'rgba(74,222,128,0.3)':'transparent')}}>{online?'Ã¢ÂÂ online':'offline'}</div></div>)
            })}
          </div>
          <div className="dash-card"><div className="dash-card-title">Venue</div>
            <div className="dash-info-row"><span>Ã°ÂÂÂ</span><span>Pazhou Complex, No.380 Yuejiang Zhong Rd, Guangzhou</span></div>
            <div className="dash-info-row"><span>Ã°ÂÂÂ¡Ã¯Â¸Â</span><span>April: 22-28C, humid, rain - bring umbrella</span></div>
            <div className="dash-info-row"><span>Ã°ÂÂÂ</span><span>CFTC: 4000-888-999 / +86-20-28-888-999</span></div>
          </div>
          <div className="dash-card"><div className="dash-card-title">Margin Formula</div>
            <div style={{fontSize:12,color:'rgba(255,255,255,0.6)',lineHeight:1.7}}>
              <div>Landed = buy x 1.12 (freight) x 1.035 (duty)</div>
              <div>Net margin = (sell - landed - 15% fees - 10% ads) / sell</div>
              <div style={{color:'#4ade80',fontWeight:600,marginTop:4}}>Target: &gt;35% | Example: $4 buy, EUR18 sell = 51%</div>
            </div>
          </div>
        </div>
      )}

      {tab==='chat'&&(
        <>
          <div className="messages-list">
            <div style={{textAlign:'center',fontSize:11,color:'rgba(255,255,255,0.2)',padding:'6px 0'}}>"Valeran, ..." for AI &nbsp;ÃÂ·&nbsp; your messages on the right</div>

            {messages.map(msg=>{
              var mine=isMine(msg), val=isValeran(msg), name=senderName(msg)
              return(
                <div key={msg.id} style={{display:'flex',flexDirection:'column',alignItems:mine?'flex-end':'flex-start',marginBottom:10}}>
                  {!mine&&(
                    <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:3,paddingLeft:4}}>
                      {val?<SVLogo size={18}/>:<Avatar name={name} size={18}/>}
                      <span style={{fontSize:11,fontWeight:600,color:val?'#4ade80':nameColor(name)}}>{name}</span>
                    </div>
                  )}
                  <div style={{display:'flex',alignItems:'flex-end',gap:4,flexDirection:mine?'row-reverse':'row'}}>
                    <div className={'bubble '+(mine?'me-bubble':val?'valeran-bubble':'them-bubble')} style={{maxWidth:'78%',borderRadius:mine?'16px 4px 16px 16px':'4px 16px 16px 16px'}}>
                      {val?<ReactMarkdown>{msg.content||''}</ReactMarkdown>:<span>{msg.content}</span>}
                    </div>
                    <button onClick={()=>{setReplyTo({id:msg.id,content:msg.content,senderName:senderName(msg)});inputRef.current&&inputRef.current.focus()}} title="Reply" style={{background:'none',border:'none',color:'rgba(255,255,255,0.25)',cursor:'pointer',fontSize:14,padding:'0 2px',flexShrink:0,opacity:0,transition:'opacity 0.15s'}} className="reply-btn">↩</button>
                  </div>
                  <div style={{fontSize:10,color:'rgba(255,255,255,0.3)',marginTop:2,paddingRight:mine?4:0,paddingLeft:mine?0:4}}>{formatTime(msg.created_at)}</div>
                </div>
              )
            })}

            {sending&&<div style={{display:'flex',flexDirection:'column',alignItems:'flex-start',marginBottom:10}}><div style={{display:'flex',alignItems:'center',gap:5,marginBottom:3,paddingLeft:4}}><SVLogo size={18}/><span style={{fontSize:11,fontWeight:600,color:'#4ade80'}}>Valeran</span></div><div className="bubble valeran-bubble typing"><span/><span/><span/></div></div>}
            {typing.length>0&&<div style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'rgba(255,255,255,0.4)',paddingLeft:4}}><div className="typing-dots"><span/><span/><span/></div><span>{typing.join(', ')} {typing.length===1?'is':'are'} typingÃ¢ÂÂ¦</span></div>}
            {error&&<div className="chat-error">Ã¢ÂÂ Ã¯Â¸Â {error}</div>}
            <div ref={bottomRef}/>
          </div>

          {/* Reply preview */}
          {replyTo&&(
            <div style={{background:'rgba(255,255,255,0.06)',borderLeft:'3px solid #e8a045',padding:'6px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:12,color:'rgba(255,255,255,0.7)'}}>
              <div><span style={{color:'#e8a045',fontWeight:600}}>{replyTo.senderName}</span>&nbsp;·&nbsp;{replyTo.content.slice(0,60)}{replyTo.content.length>60?'...':''}</div>
              <button onClick={()=>setReplyTo(null)} style={{background:'none',border:'none',color:'rgba(255,255,255,0.4)',cursor:'pointer',fontSize:16,lineHeight:1}}>×</button>
            </div>
          )}
          {/* Emoji picker */}
          {showEmoji&&(
            <div style={{background:'#1a2a4a',border:'1px solid rgba(255,255,255,0.1)',borderRadius:12,padding:'10px 12px',display:'flex',flexWrap:'wrap',gap:6,maxHeight:160,overflowY:'auto'}}>
              {['😊','😂','👍','❤️','🔥','✅','👌','💪','🎯','📦','💰','🏭','🤝','⚡','🇨🇳','🇪🇺','📊','💡','🚀','😅','🙏','👏','😎','🤔','💯','⭐','📸','🎉','😮','👋'].map(e=>(
                <button key={e} onClick={()=>insertEmoji(e)} style={{background:'none',border:'none',cursor:'pointer',fontSize:22,padding:'2px',borderRadius:4,lineHeight:1}}>{e}</button>
              ))}
            </div>
          )}
          <div className="chat-input-bar">
            <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.txt,.xlsx,.xls,.csv,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp" style={{display:'none'}} onChange={handleFilePicked}/>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handleFilePicked}/>
            <button className="input-action-btn" onClick={()=>fileRef.current?.click()} title="Attach"><AttachIcon/></button>
            <button className="input-action-btn" onClick={()=>cameraRef.current?.click()} title="Camera"><CameraIcon/></button>
            <input className="chat-input" value={input} onChange={handleInputChange} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&sendMessage()} placeholder={'"Valeran, Ã¢ÂÂ¦" for AI ÃÂ· or just chat'} disabled={recording}/>
            <button className={'input-action-btn mic-btn '+(recording?'recording':'')} onMouseDown={startRecording} onMouseUp={stopRecording} onTouchStart={e=>{e.preventDefault();startRecording()}} onTouchEnd={e=>{e.preventDefault();stopRecording()}} title="Hold to record"><MicIcon/></button>
            <button className="input-action-btn" onClick={()=>setShowEmoji(p=>!p)} title="Emoji" style={{position:'relative'}}>😊</button>
            {input.trim()&&<button className="send-btn" onClick={sendMessage} disabled={sending}><SendIcon/></button>}
          </div>
        </>
      )}
    </div>
  )
}

function AttachIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>}
function CameraIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>}
function MicIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>}
function SendIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>}