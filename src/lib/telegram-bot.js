// ============================================================
// VALERAN TELEGRAM BOT — Webhook mode (serverless-safe)
// No polling. No auto-start. No welcome spam.
// All sends use the Telegram Bot REST API directly.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID  = process.env.TELEGRAM_GROUP_ID;
const TG_API    = 'https://api.telegram.org/bot' + BOT_TOKEN;

// ============================================================
// CORE SEND HELPER
// ============================================================
async function tgSend(chatId, text, options = {}) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown', ...options };
  const r = await fetch(TG_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ============================================================
// WELCOME MESSAGE — called once, manually, never on startup
// ============================================================
const WELCOME_EN = `👋 Hi everyone — I'm *Valeran*, your Canton Fair AI assistant for Synergy Ventures.

🔍 *Product research* — send me a photo or name, I'll find suppliers and calculate margins.
📊 *Daily reports* — morning briefing + evening summary posted here automatically.
🗓 *Schedule* — I track all your supplier meetings across all 3 phases.
💬 *Always available* — just start your message with "Valeran," and I'll respond.

*Web app:* app.synergyventures.eu — log in with your team email.`;

const WELCOME_BG = `👋 Здравейте — аз съм *Valeran*, вашият AI асистент за Кантонския панаир.

🔍 *Проучване на продукти* — изпратете снимка или наименование, ще намеря доставчици и ще изчисля маржовете.
📊 *Ежедневни доклади* — сутрешен брифинг + вечерно резюме, публикувани тук автоматично.
🗓 *График* — следя всички срещи с доставчици.
💬 *Винаги на линия* — започнете съобщението с "Valeran," и ще отговоря.

*Уеб приложение:* app.synergyventures.eu`;

async function sendWelcomeMessage() {
  try {
    // Check if already sent
    const { data: existing } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('content', '__VALERAN_WELCOME_SENT__')
      .limit(1);

    if (existing && existing.length > 0) {
      console.log('Welcome already sent — skipping');
      return { skipped: true };
    }

    await tgSend(GROUP_ID, WELCOME_EN);
    await new Promise(r => setTimeout(r, 1500));
    await tgSend(GROUP_ID, WELCOME_BG);

    // Mark as sent
    await supabase.from('chat_messages').insert({
      content: '__VALERAN_WELCOME_SENT__',
      role: 'system',
      partner_id: null,
      session_id: null
    });

    console.log('✅ Welcome message sent');
    return { sent: true };
  } catch (err) {
    console.error('Welcome message error:', err.message);
    return { error: err.message };
  }
}

// ============================================================
// SEND REPORT TO GROUP
// ============================================================
async function sendReportToTelegram(report) {
  if (!GROUP_ID || !report) return;

  const text = `📋 *${report.title || 'Report'}*\n\n${report.content_en || report.content || ''}`;

  // Telegram max 4096 chars — split if needed
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await tgSend(GROUP_ID, chunk);
    await sleep(600);
  }

  // Bulgarian version for remote partner
  if (report.content_bg) {
    const bgText = `🇧🇬 *${report.title} (BG)*\n\n${report.content_bg}`;
    const bgChunks = splitMessage(bgText, 4000);
    for (const chunk of bgChunks) {
      await tgSend(GROUP_ID, chunk);
      await sleep(600);
    }
  }

  // Mark sent
  if (report.id) {
    await supabase.from('reports').update({ sent_to_telegram: true }).eq('id', report.id);
  }
}

// ============================================================
// SEND REPLY TO A SPECIFIC MESSAGE
// ============================================================
async function sendTelegramReply(chatId, text, replyToMessageId) {
  return tgSend(chatId, text, { reply_to_message_id: replyToMessageId });
}

// ============================================================
// HELPERS
// ============================================================
function splitMessage(text, maxLen) {
  const chunks = [];
  while (text.length > maxLen) {
    const split = text.lastIndexOf('\n', maxLen);
    const end = split > 0 ? split : maxLen;
    chunks.push(text.slice(0, end));
    text = text.slice(end + 1);
  }
  if (text) chunks.push(text);
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { sendReportToTelegram, sendWelcomeMessage, sendTelegramReply, tgSend };
