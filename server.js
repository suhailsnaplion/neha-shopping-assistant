const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname)));

const OPENAI_KEY = process.env.OPENAI_KEY;
const SARVAM_KEY = process.env.SARVAM_KEY;

const ONES = ['zero','one','two','three','four','five','six','seven',
  'eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen',
  'sixteen','seventeen','eighteen','nineteen'];
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

function num2words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n/10)] + (n%10 ? '-'+ONES[n%10] : '');
  if (n < 1000) return ONES[Math.floor(n/100)]+' hundred'+(n%100?' '+num2words(n%100):'');
  return num2words(Math.floor(n/1000))+' thousand'+(n%1000?' '+num2words(n%1000):'');
}

function yearToWords(y) {
  const century = Math.floor(y / 100); // 19 or 20
  const decade  = y % 100;
  const cw = century === 19 ? 'nineteen' : (century === 20 ? 'twenty' : num2words(century));
  if (decade === 0) return century === 20 ? 'two thousand' : cw + ' hundred';
  if (decade < 10)  return century === 20 && decade < 10 ? 'two thousand '+ONES[decade] : cw+' oh '+ONES[decade];
  return cw + ' ' + num2words(decade);
}

function fixPronunciation(text) {
  return text
    .replace(/₹/g, 'rupees ')
    .replace(/\bK\b/g, ' thousand')
    // Years 1900–2099 — read naturally ("twenty fifteen", "two thousand one")
    .replace(/\b((?:19|20)\d{2})\b(?!\s*(?:GB|MB|MP|W|mAh|Hz|inch|cm|mm|m\b))/gi,
      (_, y) => yearToWords(parseInt(y)))
    // Specs like "8GB", "256GB", "50MP", "5000mAh" — keep as-is (num only)
    // Standalone 2–3 digit numbers not attached to units — leave for Sarvam preprocessing
    ;
}

// Streaming chat — tokens sent as SSE so client starts TTS before full JSON arrives
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 480,
        stream: true,
        messages: req.body.messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      return res.end();
    }

    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const chunk = JSON.parse(raw);
          const token = chunk.choices?.[0]?.delta?.content ?? '';
          if (token) res.write(`data: ${JSON.stringify(token)}\n\n`);
        } catch (e) { /* skip malformed chunks */ }
      }
    }
    res.end();
  } catch (e) {
    console.error('/api/chat error:', e);
    try { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); } catch (_) {}
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text, lang } = req.body;
    const cleaned = fixPronunciation(text);
    const langCode = (lang === 'hi') ? 'hi-IN' : 'en-IN';

    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': SARVAM_KEY
      },
      body: JSON.stringify({
        inputs: [cleaned],
        target_language_code: langCode,
        speaker: 'simran',
        model: 'bulbul:v3',
        pace: 1.04,
        speech_sample_rate: 22050,
        output_audio_codec: 'mp3',
        enable_preprocessing: true
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Sarvam TTS error:', err);
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const base64Audio = data.audios?.[0];
    if (!base64Audio) {
      console.error('Sarvam returned no audio:', JSON.stringify(data));
      return res.status(500).json({ error: 'No audio in Sarvam response' });
    }

    const buf = Buffer.from(base64Audio, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) {
    console.error('/api/tts error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`Aria running → http://localhost:${PORT}`));
