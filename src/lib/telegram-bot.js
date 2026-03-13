// ============================================================
// VALERAN TELEGRAM BOT
// Connects to "Canton Fair - Aeros Team" group
// Receives messages, passes to Valeran core, sends replies
// Also delivers evening/morning reports
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { processMessage, generateEveningReport, generateMorningReport } = require('./valeran-core');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CANTON_FAIR_GROUP_ID = process.env.TELEGRAM_GROUP_ID;

// ============================================================
// STARTUP — SEND WELCOME MESSAGE ON FIRST RUN
// ============================================================
const WELCOME_EN = `👋 Hi everyone — I'm *Valeran*, the intelligence system built for our Canton Fair mission.

Here's what I do for the team:

🔍 *Product research* — I scan Alibaba, 1688, AliExpress and EU marketplaces continuously, calculate margins, and flag the best opportunities before we even land in Guangzhou.

📸 *Photo search* — see something interesting at the fair? Send me a photo right here and I'll identify the product, find suppliers, and give you a price comparison in seconds.

📊 *Daily reports* — every morning and evening I'll post a summary of the best products found, supplier notes, and meeting highlights.

🗓️ *Meetings* — I track all your supplier appointments so nothing gets missed across all 3 phases.

💬 *Always here* — ask me anything about a supplier, product, or category.

*Your next step:* Open app.synergyventures.eu and sign in with your Google account. Takes 30 seconds.

Let's make this the most productive Canton Fair yet. 🚀`;

const WELCOME_BG = `👋 Здравейте — аз съм *Valeran*, системата за разузнаване, изградена за нашата мисия на Кантонския панаир.

Ето какво правя за екипа:

🔍 *Проучване на продукти* — сканирам Alibaba, 1688, AliExpress и европейски платформи непрекъснато, изчислявам маржовете и маркирам най-добрите възможности.

📸 *Търсене по снимка* — видяхте нещо интересно на панаира? Изпратете ми снимка тук и за секунди ще идентифицирам продукта, ще намеря доставчици и ще дам сравнение на цените.

📊 *Ежедневни доклади* — всяка сутрин и вечер публикувам обобщение с най-добрите намерени продукти, бележки за доставчици и резюме на срещите.

🗓️ *Срещи* — следя всички срещи с доставчици, за да не се пропусне нищо.

💬 *Винаги тук* — питайте ме всичко за доставчик, продукт или категория.

*Следваща стъпка:* Отворете app.synergyventures.eu и влезте с Google акаунта си. Отнема 30 секунди.

Да направим този панаир най-успешния досега. 🚀`;

async function sendWelcomeMessage() {
  try {
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('content', '__VALERAN_WELCOME_SENT__')
      .limit(1);

    if (existing && existing.length > 0) return; // Already sent

    await bot.sendMessage(CANTON_FAIR_GROUP_ID, WELCOME_EN, { parse_mode: 'Markdown' });
    await new Promise(r => setTimeout(r, 2000));
    await bot.sendMessage(CANTON_FAIR_GROUP_ID, WELCOME_BG, { parse_mode: 'Markdown' });

    // Mark as sent
    await supabase.from('messages').insert({
      content: '__VALERAN_WELCOME_SENT__',
      role: 'system',
      partner_id: null,
      session_id: null
    });

    console.log('✅ Valeran welcome message sent to group');
  } catch (err) {
    console.error('Welcome message error:', err.message);
  }
}

// Send welcome after 3 seconds (let bot fully initialize)
setTimeout(sendWelcomeMessage, 3000);


// ============================================================
// RESOLVE PARTNER FROM TELEGRAM USER ID
// ============================================================
async function resolvePartner(telegramUserId) {
  const { data: partner } = await supabase
    .from('partners')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
    .single();
  return partner;
}

// ============================================================
// GET ACTIVE FAIR SESSION
// ============================================================
async function getActiveSession() {
  const today = new Date().toISOString().split('T')[0];
  const { data: session } = await supabase
    .from('fair_sessions')
    .select('*')
    .lte('start_date', today)
    .gte('end_date', today)
    .single();
  return session;
}

// ============================================================
// HANDLE INCOMING TEXT MESSAGES
// ============================================================
bot.on('message', async (msg) => {
  try {
    // Only process messages from the Canton Fair group
    if (String(msg.chat.id) !== String(CANTON_FAIR_GROUP_ID)) {
      // Also handle private messages to Valeran bot
      if (msg.chat.type !== 'private') return;
    }

    const partner = await resolvePartner(msg.from.id);
    if (!partner) return; // Unknown user — ignore

    const session = await getActiveSession();

    // Handle voice messages
    if (msg.voice) {
      await bot.sendChatAction(msg.chat.id, 'typing');
      // Transcribe via Google Speech-to-Text
      const transcription = await transcribeVoice(msg.voice.file_id);
      if (transcription) {
        const result = await processMessage({
          text: transcription,
          partnerId: partner.id,
          sessionId: session?.id,
          messageType: 'voice'
        });
        if (result.responded) {
          await bot.sendMessage(msg.chat.id, `🎤 "${transcription}"\n\n${result.reply}`, {
            reply_to_message_id: msg.message_id
          });
        } else if (result.entityRefs && Object.keys(result.entityRefs).length > 0) {
          // Silent confirmation — small acknowledgment
          await bot.sendMessage(msg.chat.id, '✓', { reply_to_message_id: msg.message_id });
        }
      }
      return;
    }

    // Handle photo messages
    if (msg.photo) {
      const caption = msg.caption || '';
      const photoFileId = msg.photo[msg.photo.length - 1].file_id;
      const photoUrl = await getFileUrl(photoFileId);

      await bot.sendChatAction(msg.chat.id, 'typing');

      const result = await processMessage({
        text: caption || '[Photo submitted]',
        partnerId: partner.id,
        sessionId: session?.id,
        messageType: 'photo',
        mediaUrl: photoUrl
      });

      if (result.responded) {
        await bot.sendMessage(msg.chat.id, result.reply, { reply_to_message_id: msg.message_id });
      } else {
        await bot.sendMessage(msg.chat.id, '📷 Saved', { reply_to_message_id: msg.message_id });
      }
      return;
    }

    // Handle text messages
    if (msg.text) {
      // Skip bot commands handled elsewhere
      if (msg.text.startsWith('/')) return;

      await bot.sendChatAction(msg.chat.id, 'typing');

      const result = await processMessage({
        text: msg.text,
        partnerId: partner.id,
        sessionId: session?.id,
        messageType: 'text'
      });

      if (result.responded) {
        await bot.sendMessage(msg.chat.id, result.reply, {
          reply_to_message_id: msg.message_id,
          parse_mode: 'Markdown'
        });
      } else if (result.entityRefs && Object.keys(result.entityRefs).length > 0) {
        // Something was logged — quiet tick
        await bot.sendMessage(msg.chat.id, '✓ logged', { reply_to_message_id: msg.message_id });
      }
    }

  } catch (err) {
    console.error('Bot message error:', err);
  }
});

// ============================================================
// BOT COMMANDS
// ============================================================
bot.onText(/\/status/, async (msg) => {
  const session = await getActiveSession();
  const today = new Date().toISOString().split('T')[0];
  const { count: products } = await supabase.from('products').select('*', { count: 'exact', head: true }).gte('created_at', today);
  const { count: suppliers } = await supabase.from('suppliers').select('*', { count: 'exact', head: true }).gte('created_at', today);

  const text = session
    ? `📊 *Canton Fair ${session.name}*\nToday: ${products || 0} products · ${suppliers || 0} suppliers`
    : '📊 No active fair session today';

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/shortlist/, async (msg) => {
  const { data: products } = await supabase
    .from('products')
    .select('product_name, total_score, category_auto, gross_margin_estimate')
    .eq('status', 'shortlisted')
    .order('total_score', { ascending: false })
    .limit(10);

  if (!products?.length) {
    await bot.sendMessage(msg.chat.id, 'No shortlisted products yet.');
    return;
  }

  const list = products.map((p, i) =>
    `${i + 1}. *${p.product_name}* — score ${p.total_score || '?'}/5 · margin ~${p.gross_margin_estimate || '?'}%`
  ).join('\n');

  await bot.sendMessage(msg.chat.id, `🏆 *Shortlist*\n\n${list}`, { parse_mode: 'Markdown' });
});

// ============================================================
// SEND REPORT TO GROUP
// ============================================================
async function sendReportToTelegram(report) {
  if (!CANTON_FAIR_GROUP_ID) return;

  const text = `📋 *${report.title}*\n\n${report.content_en}`;

  // Split if too long for Telegram (4096 char limit)
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await bot.sendMessage(CANTON_FAIR_GROUP_ID, chunk, { parse_mode: 'Markdown' });
    await sleep(500);
  }

  // Send Bulgarian version
  if (report.content_bg) {
    const bgText = `🇧🇬 *${report.title} (BG)*\n\n${report.content_bg}`;
    const bgChunks = splitMessage(bgText, 4000);
    for (const chunk of bgChunks) {
      await bot.sendMessage(CANTON_FAIR_GROUP_ID, chunk, { parse_mode: 'Markdown' });
      await sleep(500);
    }
  }

  await supabase.from('reports').update({ sent_to_telegram: true }).eq('id', report.id);
}

// ============================================================
// HELPERS
// ============================================================
async function getFileUrl(fileId) {
  const file = await bot.getFile(fileId);
  return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

async function transcribeVoice(fileId) {
  // Google Speech-to-Text integration
  const { SpeechClient } = require('@google-cloud/speech');
  const speech = new SpeechClient();
  const audioUrl = await getFileUrl(fileId);

  const [response] = await speech.recognize({
    audio: { uri: audioUrl },
    config: {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 16000,
      languageCode: 'en-US',
      alternativeLanguageCodes: ['ru-RU', 'bg-BG']
    }
  });

  return response.results?.map(r => r.alternatives[0].transcript).join(' ') || null;
}

function splitMessage(text, maxLen) {
  const chunks = [];
  while (text.length > maxLen) {
    const split = text.lastIndexOf('\n', maxLen);
    chunks.push(text.slice(0, split > 0 ? split : maxLen));
    text = text.slice(split > 0 ? split + 1 : maxLen);
  }
  if (text) chunks.push(text);
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { bot, sendReportToTelegram };
