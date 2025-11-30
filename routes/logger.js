const express = require('express');
const router = express.Router();
const db = require('../db');

// webhook ที่ LINE/DF ส่งเข้ามา
router.post('/', async (req, res) => {
  const body = req.body || {};
  const data = body.payload?.data || {};
  const message = data.message || {};
  const userId = data.source?.userId || null;
  const text = message.text || '';

  // ตัวอย่าง intent/response (คุณเปลี่ยนให้ตรงกับของจริง)
  const df = body.df || {};           // สมมติคุณแนบผล DetectIntent
  const intent = df.intentName || null;
  const isFallback = intent === 'Default Fallback Intent' ? 1 : 0;
  const params = df.parameters || {};
  const confidence = df.intentConfidence ?? null;
  const responseText = df.responseText || '';
  const latency = df.latencyMs ?? null;

  const loc = message.location || {};
  const lat = loc.latitude ?? null;
  const lng = loc.longitude ?? null;

  try {
    await db.query(
      `INSERT INTO df_interactions
         (channel, user_id, session_id, intent, is_fallback, query_text,
          parameters, response_text, confidence, latency_ms,
          location_lat, location_lng, extra)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [
        'line',
        userId,
        df.sessionId || null,
        intent,
        isFallback,
        text,
        JSON.stringify(params),
        responseText,
        confidence,
        latency,
        lat,
        lng,
        JSON.stringify({ raw: body }).slice(0, 65000)
      ]
    );
  } catch (e) {
    await db.query(
      `INSERT INTO df_errors
          (session_id, user_id, error_type, error_msg, payload)
       VALUES (?, ?, ?, ?, CAST(? AS JSON))`,
      [df.sessionId || null, userId, 'DB_INSERT', String(e.message || e), JSON.stringify(body)]
    );
  }

  res.json({ ok: true });
});

module.exports = router;
