'use strict';
var supabaseJs = require('@supabase/supabase-js');
var supabase = supabaseJs.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
var GROUP_ID  = process.env.TELEGRAM_GROUP_ID || '';
var TG_BASE   = 'https://api.telegram.org/bot' + BOT_TOKEN;

async function tgSend(chatId, text, extra) {
  extra = extra || {};
  try {
    var body = Object.assign({ chat_id: chatId, text: text, parse_mode: 'Markdown' }, extra);
    var r = await fetch(TG_BASE + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  } catch(e) { console.error('[tg] send error:', e.message); }
}

async function sendWelcomeMessage() {
  try {
    var existing = await supabase.from('chat_messages').select('id').eq('content', '__VALERAN_WELCOME_SENT__').limit(1);
    if (existing.data && existing.data.length > 0) return { skipped: true };

    var msgEN = 'Hello everyone — I am Valeran, the AI assistant for Synergy Ventures at Canton Fair 2026.\n\n' +
      'What I do:\n' +
      '- Product research: find suppliers, compare EU prices, calculate margins\n' +
      '- Photo search: send me a product photo, I identify it and find sources\n' +
      '- Daily reports: evening summary and morning briefing automatically\n' +
      '- Schedule: track all supplier meetings across all 3 phases\n' +
      '- Personal assistant: translations, weather, calculations, anything\n\n' +
      'How to talk to me: start your message with Valeran, in any language (EN/RU/BG)\n' +
      'Web app: app.synergyventures.eu\n\n' +
      'Currently in TESTING MODE — we are preparing for Canton Fair April 15. Please test me and point out any mistakes.';

    var msgBG = 'Здравейте — аз съм Valeran, AI асистентът на Synergy Ventures за Кантонския панаир 2026.\n\n' +
      'Какво правя:\n' +
      '- Проучване на продукти: намирам доставчици, сравнявам ЕС цени, изчислявам маржове\n' +
      '- Търсене по снимка: изпратете ми снимка на продукт, ще го идентифицирам\n' +
      '- Ежедневни доклади: вечерно резюме и сутрешен брифинг автоматично\n' +
      '- Асистент: преводи, прогноза за времето, изчисления, всичко\n\n' +
      'Как да говорите с мен: започнете с Valeran, на всеки език (BG/EN/RU)\n' +
      'Уеб приложение: app.synergyventures.eu\n\n' +
      'Сега сме в ТЕСТОВ РЕЖИМ — подготвяме се за Кантонския панаир от 15 април. Моля, тествайте ме и посочвайте грешките ми.';

    await tgSend(GROUP_ID, msgEN);
    await new Promise(function(r) { setTimeout(r, 1500); });
    await tgSend(GROUP_ID, msgBG);

    await supabase.from('chat_messages').insert({ content: '__VALERAN_WELCOME_SENT__', role: 'system', partner_id: null, session_id: null });
    return { sent: true };
  } catch(e) {
    console.error('[tg] welcome error:', e.message);
    return { error: e.message };
  }
}

async function sendReportToTelegram(report) {
  if (!GROUP_ID || !report) return;
  var titleEN = report.title || 'Report';
  var textEN  = titleEN + '\n\n' + (report.content_en || '');
  var chunks  = splitMsg(textEN, 4000);
  for (var i = 0; i < chunks.length; i++) {
    await tgSend(GROUP_ID, chunks[i]);
    await new Promise(function(r) { setTimeout(r, 600); });
  }
  if (report.content_bg) {
    var textBG = titleEN + ' (BG)\n\n' + report.content_bg;
    var bgChunks = splitMsg(textBG, 4000);
    for (var j = 0; j < bgChunks.length; j++) {
      await tgSend(GROUP_ID, bgChunks[j]);
      await new Promise(function(r) { setTimeout(r, 600); });
    }
  }
  if (report.id) {
    await supabase.from('reports').update({ sent_to_telegram: true }).eq('id', report.id);
  }
}

function splitMsg(text, max) {
  var chunks = [];
  while (text.length > max) {
    var split = text.lastIndexOf('\n', max);
    var end   = split > 0 ? split : max;
    chunks.push(text.slice(0, end));
    text = text.slice(end + 1);
  }
  if (text) chunks.push(text);
  return chunks;
}

module.exports = {
  sendReportToTelegram: sendReportToTelegram,
  sendWelcomeMessage: sendWelcomeMessage,
  tgSend: tgSend
};