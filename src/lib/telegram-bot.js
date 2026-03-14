// ============================================================
// VALERAN TELEGRAM BOT — Webhook-only, serverless-safe
// Pure REST API calls. No polling. No welcome on startup.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID  = process.env.TELEGRAM_GROUP_ID;
const TG_BASE   = 'https://api.telegram.org/bot' + BOT_TOKEN;

async function tgSend(chatId, text, extra = {}) {
  try {
    const r = await fetch(TG_BASE + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra })
    });
    return r.json();
  } catch (e) {
    console.error('tgSend error:', e.message);
  }
}

// Welcome message — exported, called ONCE manually via /api/welcome
async function sendWelcomeMessage() {
  try {
    const { data: existing } = await supabase
      .from('chat_messages').select('id')
      .eq('content', '__VALERAN_WELCOME_SENT__').limit(1);
    if (existing && existing.length > 0) return { skipped: true, reason: 'already sent' };

    const msgEN = `👋 *Hi everyone — I'm Valeran*, the intelligence system for Synergy Ventures at Canton Fair 2026.

Here's what I do:
🔍 *Product research* — calculate margins, find suppliers on Alibaba/1688, compare EU competition
📸 *Photo search* — send me a photo of any product, I'll identify it and find sources
📊 *Daily reports* — evening summary + morning briefing posted here automatically
🗓 *Schedule* — I track supplier meetings across all 3 phases
💬 *Personal assistant* — ask me anything: translations, calculations, research

*How to talk to me:* Start your message with "Valeran," — in any language (EN/RU/BG)
*Web app:* app.synergyventures.eu — log in with your email

*Testing period now* — please reply to this message with your email address so I can link your profile.

Let's make this the most productive Canton Fair yet. 🚀`;

    const msgBG = `👋 *Здравейте — аз съм Valeran*, интелигентната система на Synergy Ventures за Кантонския панаир 2026.

Ето какво правя:
🔍 *Проучване на продукти* — изчислявам маржове, намирам доставчици, сравнявам конкуренцията в ЕС
📸 *Търсене по снимка* — изпратете ми снимка на продукт, ще го идентифицирам
📊 *Ежедневни доклади* — вечерно резюме + сутрешен брифинг тук автоматично
🗓 *График* — следя срещите с доставчици
💬 *Личен асистент* — питайте ме всичко

*Как да говорите с мен:* Започнете с "Valeran," на всеки език
*Уеб приложение:* app.synergyventures.eu

Да направим този панаир най-успешния досега. 🚀`;

    await tgSend(GROUP_ID, msgEN);
    await new Promise(r => setTimeout(r, 1500));
    await tgSend(GROUP_ID, msgBG);

    await supabase.from('chat_messages').insert({
      content: '__VALERAN_WELCOME_SENT__',
      role: 'system', partner_id: null, session_id: null
    });

    return { sent: true };
  } catch (e) {
    console.error('Welcome error:', e.message);
    return { error: e.message };
  }
}

async function sendReportToTelegram(report) {
  if (!GROUP_ID || !report) return;
  const chunks = splitMsg(`📋 *${report.title || 'Report'}*\n\n${report.content_en || ''}`, 4000);
  for (const chunk of chunks) { await tgSend(GROUP_ID, chunk); await sleep(600); }
  if (report.content_bg) {
    const bgChunks = splitMsg(`🇧🇬 *${report.title} (BG)*\n\n${report.content_bg}`, 4000);
    for (const chunk of bgChunks) { await tgSend(GROUP_ID, chunk); await sleep(600); }
  }
  if (report.id) await supabase.from('reports').update({ sent_to_telegram: true }).eq('id', report.id);
}

function splitMsg(text, max) {
  const chunks = [];
  while (text.length > max) {
    const split = text.lastIndexOf('\n', max);
    chunks.push(text.slice(0, split > 0 ? split : max));
    text = text.slice((split > 0 ? split : max) + 1);
  }
  if (text) chunks.push(text);
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { sendReportToTelegram, sendWelcomeMessage, tgSend };
