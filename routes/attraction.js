const express = require('express');
const router = express.Router();
const db = require('../db'); // MySQL connection

// ====== LOGGING HELPERS ======
async function saveError(sessionId, userId, type, err, payload) {
  try {
    await db.query(
      `INSERT INTO df_errors (session_id, user_id, error_type, error_msg, payload)
       VALUES (?, ?, ?, ?, CAST(? AS JSON))`,
      [sessionId || null, userId || null, type, String(err?.message || err), JSON.stringify(payload || {}).slice(0, 65000)]
    );
  } catch (_) {}
}

// สรุปข้อความตอบกลับ (ดึง fulfillmentText ถ้ามี / หรือ serialize สั้น ๆ)
function summarizeReply(body) {
  try {
    if (!body) return '';
    // Dialogflow ES อาจส่ง fulfillmentText/fulfillmentMessages
    if (body.fulfillmentText) return String(body.fulfillmentText).slice(0, 1000);
    if (Array.isArray(body.fulfillmentMessages)) {
      const texts = [];
      for (const m of body.fulfillmentMessages) {
        if (m?.text?.text?.length) texts.push(m.text.text.join(' '));
      }
      if (texts.length) return texts.join(' | ').slice(0, 1000);
    }
    return JSON.stringify(body).slice(0, 1000);
  } catch { return ''; }
}

// ดึง userId / lat,lng แบบปลอดภัย
function pickUserAndLoc(req) {
  const od = req.body?.originalDetectIntentRequest?.payload;
  const userId = od?.data?.source?.userId
              || od?.data?.events?.[0]?.source?.userId
              || od?.events?.[0]?.source?.userId
              || null;

  // ใช้ฟังก์ชัน extractLatLng ที่คุณมีอยู่แล้ว
  const { lat, lng } = extractLatLng(req) || {};
  return { userId, lat, lng };
}

// บันทึก 1 interaction
async function logInteractionFromReq(req, replyBody) {
  try {
    const qr = req.body?.queryResult || {};
    const intent = qr?.intent?.displayName || null;
    const sessionId = req.body?.session || null;
    const queryText = qr?.queryText || '';
    const confidence = qr?.intentDetectionConfidence ?? null;
    const params = qr?.parameters || {};
    const responseText = summarizeReply(replyBody);

    const od = req.body?.originalDetectIntentRequest?.payload;
    const userId =
      od?.data?.source?.userId ||
      od?.data?.events?.[0]?.source?.userId ||
      od?.events?.[0]?.source?.userId || null;

    const { lat, lng } = extractLatLng(req) || {};
    const isFallback = intent === 'Default Fallback Intent' ? 1 : 0;

    // ❗ ใส่เฉพาะคอลัมน์ 13 ตัวด้านล่างให้ตรงกับ 13 ค่าใน VALUES
    await db.query(
      `INSERT INTO df_interactions
       (channel, user_id, session_id, intent, is_fallback, query_text,
        parameters, response_text, confidence, latency_ms,
        location_lat, location_lng, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'line',
        userId,
        sessionId,
        intent,
        isFallback,
        queryText,
        JSON.stringify(params || {}),
        responseText,
        confidence,
        null,                  // latency_ms (จะค่อยเติมทีหลังได้)
        lat ?? null,
        lng ?? null,
        JSON.stringify({ od: req.body?.originalDetectIntentRequest || null })
      ]
    );

    console.log('[LOG] insert OK:', { intent, userId, sessionId });
  } catch (err) {
    console.warn('[LOG] insert failed:', err?.message || err);
    await saveError(req.body?.session, null, 'LOG_INSERT', err, { body: req.body, reply: replyBody });
  }
}


//////////////////โค้ดเดิม
// ===== Helpers =====
//const fetch = global.fetch || ((...a) => import('node-fetch').then(({default:f}) => f(...a)));
const fetch = global.fetch || (async (...a) => import('node-fetch').then(({default: f}) => f(...a)));
//const BASE_URL = 'https://uncorrelatively-hyacinthine-lou.ngrok-free.dev'; //เปลี่ยนตรงนี้
//const BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://trainroute-lagoon.com';

const toImageUrl = (p) => {
  const clean = String(p || '').replace(/^\/?uploads\//, '');
  return `${BASE_URL}/uploads/${encodeURIComponent(clean)}`;
};

const buildColumns = (rows) =>
  rows.slice(0, 10).map(r => ({
    thumbnailImageUrl: toImageUrl(r.Attraction_Img),
    title: (r.Attraction_Name || '').substring(0, 40),
    text: (r.Attraction_Description || '').substring(0, 60),
    actions: [{ type: 'message', label: 'ดูเพิ่มเติม', text: `รายละเอียด ${r.Attraction_Name}` }]
  }));


// ===== Helper: ค้นหาสถานที่จาก "ข้อความ" ให้ทนช่องว่าง/สระ/วรรณยุกต์บางส่วน =====
// ===== Helper: ตัดวรรณยุกต์และช่องว่าง (ใช้กับ MySQL 5.7 ได้) =====
function normalizeThaiLite(s='') {
  return String(s)
    .replace(/\s+/g, '')                                // ตัดช่องว่าง
    .replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, ''); // ตัดสระ/วรรณยุกต์
}

// ===== Helper: สร้าง expression SQL สำหรับ "ตัดวรรณยุกต์/ช่องว่าง" =====
function stripMarksSQL(expr = 'Attraction_Name') {
  const rm = [
    '\u0E31','\u0E34','\u0E35','\u0E36','\u0E37','\u0E38','\u0E39','\u0E3A',
    '\u0E47','\u0E48','\u0E49','\u0E4A','\u0E4B','\u0E4C','\u0E4D','\u0E4E',
    ' ' // ช่องว่าง
  ];
  return rm.reduce((sql, ch) => `REPLACE(${sql}, '${ch}', '')`, expr);
}

// ===== ฟังก์ชันค้นหาชื่อสถานที่แบบหลวม =====
async function searchAttractionsLoose(db, keyword, limit = 10) {
  const kwNorm = normalizeThaiLite(keyword);
  if (!kwNorm) return [];

  const col = stripMarksSQL('Attraction_Name'); // เช่น REPLACE(REPLACE(Attraction_Name, ' ', ''), '่', '')
  const [rows] = await db.query(
    `
    SELECT Attraction_ID, Attraction_Name, Attraction_Description, Attraction_Img
    FROM attraction
    WHERE ${col} LIKE CONCAT('%', ?, '%')
    ORDER BY LENGTH(Attraction_Name) ASC
    LIMIT ?
    `,
    [kwNorm, limit]
  );

  return rows || [];
}


// การ์ด carousel สำหรับ "รายการสถานที่" (ปุ่ม → 'รายละเอียด <ชื่อ>')
function buildAttractionListColumns(rows) {
  return rows.slice(0, 10).map(r => ({
    thumbnailImageUrl: toImageUrl(r.Attraction_Img),
    title: (r.Attraction_Name || '').substring(0, 40),
    text:  (r.Attraction_Description || '-').substring(0, 60),
    actions: [{ type: 'message', label: 'ดูเพิ่มเติม', text: `รายละเอียด ${r.Attraction_Name}` }]
  }));
}


//////////เทศกาล///////
const FALLBACK_FEST_IMG = 'https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_1_cafe.png';

// แปลง path ใน DB → URL รูป (ใช้ของเดิม)
const toFestImg = (p) => {
  const clean = String(p || '').replace(/^\/?uploads\//, '').trim();
  const url = `${BASE_URL}/uploads/${encodeURIComponent(clean)}`;
  return /^https?:\/\//i.test(url) ? url : FALLBACK_FEST_IMG;
};

// Flex bubbles (10 ใบ/หน้า) + ปุ่ม "ดูเพิ่มเติม" ยิง FestivalDetail <id>
const buildFestivalBubbles = (rows) => rows.slice(0, 10).map(r => ({
  type: "bubble",
  hero: {
    type: "image",
    url: toFestImg(r.Festival_Img),
    size: "full",
    aspectRatio: "20:13",
    aspectMode: "cover"
  },
  body: {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    contents: [
      { type: "text", text: r.Festival_Name || '-', weight: "bold", size: "lg", wrap: true },
      { type: "text", text: (r.Festival_description || '-').substring(0, 200), size: "sm", color: "#555555", wrap: true },
    ]
  },
  footer: {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    contents: [
      {
        type: "button",
        style: "primary",
        color: "#32ca32ff",
        action: { type: "message", label: "ดูเพิ่มเติม", text: `รายละเอียดเทศกาล ${r.Festival_Name}` }
      }
    ]
  }
}));

// helper แบ่งหน้า 10 ใบ/ครั้ง (จำกัดตาม LINE)
const chunk10 = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
};



///////////////


  // === Flex helper: รวมหมวดหมู่พร้อมรูป ===
  // ===== Helper: Flex Bubble ของหมวดหมู่ (รองรับโหมด “แนะนำ”) =====
const buildCategoryFlexBubbles = (cats, province, district, { isRecommended = false } = {}) => {
  const chunk = (arr, size = 10) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
  const groups = chunk(cats, 10);

  return groups.map(group => ({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: group.map(r => ({
        type: "box",
        layout: "vertical",
        margin: "md",
        spacing: "sm",
        contents: [
          {
            type: "image",
            url: toImageUrl(r.Category_Img),
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          },
          {
            type: "text",
            text: r.Category_Name || "-",
            weight: "bold",
            size: "md",
            wrap: true,
            margin: "sm"
          },
          {
            type: "button",
            style: "primary",
            color: "#32ca32ff",
            action: {
              type: "message",
              label: "ดูเพิ่มเติม",
              // ✅ โหมด "แนะนำ" จะยิง intent แนะนำแทน
              text: (isRecommended
                ? `สถานที่แนะนำ หมวด ${r.Category_Name} ${district || province || ''}`
                : `ที่เที่ยว ${r.Category_Name} ${district || province || ''}`
              ).trim()
            }
          }
        ]
      }))
    }
  }));
};

    // === Flex: การ์ดรายละเอียดสถานที่ ===
  const buildAttractionDetailBubble = (r) => ({
    type: "bubble",
    hero: {
      type: "image",
      url: toImageUrl(r.Attraction_Img),
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover"
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: r.Attraction_Name || "-", weight: "bold", size: "lg", wrap: true },
        { type: "text", text: r.Attraction_Description || "-", size: "sm", color: "#555555", wrap: true },
        ...(r.Contact_Info ? [{
          type: "box",
          layout: "baseline",
          margin: "md",
          contents: [
            { type: "text", text: "โทร", size: "sm", color: "#888888", flex: 2 },
            { type: "text", text: String(r.Contact_Info), size: "sm", color: "#333333", flex: 5, wrap: true }
          ]
        }] : [])
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        ...(r.Contact_Info ? [{
          type: "button",
          style: "primary",
          action: { type: "uri", label: "โทรเลย", uri: `tel:${String(r.Contact_Info).replace(/\s+/g, '')}` }
        }] : []),
        {
          type: "button",
          style: "secondary",
          action: { type: "message", label: "ดูสถานที่ใกล้เคียง", text: `ที่เที่ยว ใกล้ฉัน` }
        }
      ]
    }
  });

  const normalizeUrl = (u = '') => {
  const url = String(u || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url.replace(/^\/+/, '');
};

// Flex: การ์ดลิงก์ที่เกี่ยวข้อง (ใช้รูปเฉพาะของแต่ละลิงก์จาก U_Img)
const buildUsefulLinkBubbles = (rows) =>
  rows.slice(0, 10).map(r => ({
    type: "bubble",
    hero: {
      type: "image",
      url: toImageUrl(r.U_Img),       // ✅ ใช้รูปจากคอลัมน์ U_Img
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover"
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: r.U_Name || "-", weight: "bold", size: "lg", wrap: true },
        { type: "text", text: (r.U_Description || "-").substring(0, 200), size: "sm", color: "#555555", wrap: true }
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          action: { type: "uri", label: "เปิดเว็บไซต์", uri: normalizeUrl(r.U_Link) } // ✅ กดแล้วไปหน้าเว็บ
        }
      ]
    }
  }));

  // ===== Helpers สำหรับ TourRoute =====
const normalizeThai = s => String(s || '').trim().replace(/\s+/g, ' ');

// ทำความสะอาดชื่อประเภทเส้นทางที่อาจติดคำอื่นมา เช่น "เส้นทางท่องเที่ยววันเดียวก็เที่ยวได้ สงขลา"
function cleanRouteType(raw) {
  if (!raw) return '';
  let t = normalizeThai(raw);
  t = t.replace(/^เส้นทางท่องเที่ยว\s*/i, ''); // ตัด prefix ที่ไม่ใช่ชื่อประเภท
  // ตัดส่วนท้ายที่เป็นจังหวัด/อำเภอ
  t = t.replace(/\s+(จังหวัด|จ\.|อำเภอ|อ\.|ตำบล|ต\.)\s*.+$/i, '');
  t = t.replace(/\s+(ที่ไหน|ในพื้นที่|ในเขต).+$/i, '');
  const m = {
    'one day trip': 'วันเดียวก็เที่ยวได้',
    '1 day trip': 'วันเดียวก็เที่ยวได้',
    'วันเดียว': 'วันเดียวก็เที่ยวได้',
    'ทริปวันเดียว': 'วันเดียวก็เที่ยวได้',
    'ครอบครัว': 'Family Trip แสนอบอุ่น',
    'สายธรรมชาติ': 'เส้นทางท่องเที่ยวสายรักธรรมชาติ',
    'รักธรรมชาติ': 'เส้นทางท่องเที่ยวสายรักธรรมชาติ',
    'สายรักธรรมชาติ': 'เส้นทางท่องเที่ยวสายรักธรรมชาติ',
    '2วัน': '',
    'สองวัน': '',
    '1วัน': '',
    'หนึ่งวัน': '',
    };
    const low = t.toLowerCase();
  if (m[low]) t = m[low];
  return t.trim();
}

// ===== Helpers: จัดการชื่ออำเภอ/ค้นหาอำเภอจากข้อความ =====
const stripDistrictPrefix = (s='') => String(s||'').replace(/^อำเภอ|^อ\.|^เขต|^เทศบาล/i, '').trim();

// คืนรายชื่ออำเภอที่ชื่อ “ตรง/คล้าย” กับข้อความที่ผู้ใช้พิมพ์ (พร้อมจังหวัด)
async function findDistrictCandidates(text, provinceHint='') {
  const t = (text || '').replace(/\s+/g, '');
  if (!t) return [];
  let sql = `
    SELECT d.District_ID, d.District_Name, p.Province_ID, p.Province_Name
    FROM district d
    JOIN province p ON d.Province_ID = p.Province_ID
    WHERE REPLACE(d.District_Name,' ','') <> ''
  `;
  const vals = [];
  if (provinceHint) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; vals.push(provinceHint); }
  const [rows] = await db.query(sql, vals);
  const cleanHit = rows
    .map(r => ({ ...r, Clean: stripDistrictPrefix(r.District_Name).replace(/\s+/g,'') }))
    .filter(r => t.includes(r.Clean) || r.Clean.includes(t));
  return cleanHit.slice(0, 10);
}

// ส่ง “Flex/Carousel หมวดหมู่” ที่มีจริงในพื้นที่ที่ระบุ
// ===== Helper: ตอบ Flex หมวดหมู่ตามพื้นที่ (รองรับโหมด "แนะนำ") =====
function isGenericCategory(c) {
  if (!c) return true;
  const t = String(c).trim();
  const GENERIC = ['ที่เที่ยว','เที่ยว','สถานที่','สถานที่ท่องเที่ยว','ที่ท่องเที่ยว','แหล่งท่องเที่ยว'];
  return GENERIC.includes(t);
}


async function respondWithCategoriesForArea(req, res, { province = '', district = '', isRecommended = false }) {
  // ดึงหมวดหมู่
  const [cats] = isRecommended
    ? await db.query(`
        SELECT DISTINCT c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order
        FROM category c
        JOIN attraction a ON c.Category_ID = a.Category_ID
        JOIN district  d ON a.District_ID  = d.District_ID
        JOIN province  p ON d.Province_ID  = p.Province_ID
        WHERE a.\`Reccomendation_Attraction\` = 1
          ${district ? "AND d.District_Name  LIKE CONCAT('%', ?, '%')" : ""}
          ${province ? "AND p.Province_Name LIKE CONCAT('%', ?, '%')" : ""}
        ORDER BY c.Sort_Order ASC, c.Category_Name ASC
      `, [
        ...(district ? [district] : []),
        ...(province ? [province] : [])
      ])
    : await db.query(`
        SELECT DISTINCT c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order
        FROM category c
        JOIN attraction a ON c.Category_ID = a.Category_ID
        JOIN district  d ON a.District_ID  = d.District_ID
        JOIN province  p ON d.Province_ID  = p.Province_ID
        WHERE c.Sort_Order BETWEEN 1 AND 20
          ${district ? "AND d.District_Name  LIKE CONCAT('%', ?, '%')" : ""}
          ${province ? "AND p.Province_Name LIKE CONCAT('%', ?, '%')" : ""}
        ORDER BY c.Sort_Order ASC, c.Category_Name ASC
      `, [
        ...(district ? [district] : []),
        ...(province ? [province] : [])
      ]);

  if (!cats.length) {
    return res.json({
      fulfillmentMessages: [
        { text: { text: [`ยังไม่พบหมวดหมู่ในอำเภอ ${district || '-'} ${province ? `จ.${province}` : ''}`] } }
      ],
      outputContexts: [ setCtx(req, 'awaiting_district', 0) ] // ✅ ล้าง context
    });
  }

  const bubbles = buildCategoryFlexBubbles(cats, province, district, { isRecommended });
  return res.json({
    fulfillmentMessages: [{
      payload: {
        line: {
          type: "flex",
          altText: `${isRecommended ? 'เลือกหมวด “แนะนำ”' : 'เลือกหมวดที่เที่ยว'}${district ? ` อ.${district}` : (province ? ` จ.${province}` : '')}`,
          contents: { type: "carousel", contents: bubbles }
        }
      }
    }],
    outputContexts: [ setCtx(req, 'awaiting_district', 0) ] // ✅ ล้าง context ทันที
  });
}

//สถานที่-หมวดหมู่-ใกล้ฉัน//
async function respondWithAttractionsForCategoryArea(req, res, { category, province = '', district = '' }) {
  if (!category) {
    return res.json({
      fulfillmentMessages: [{ text: { text: ['ยังไม่ได้ระบุหมวดหมู่ค่ะ'] } }],
      outputContexts: [ setCtx(req, 'awaiting_district', 0) ]
    });
  }

  let sql = `
    SELECT a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
    FROM attraction a
    JOIN category c ON a.Category_ID = c.Category_ID
    JOIN district d ON a.District_ID = d.District_ID
    JOIN province p ON d.Province_ID = p.Province_ID
    WHERE c.Category_Name LIKE CONCAT('%', ?, '%')
  `;
  const vals = [category];
  if (district) { sql += ` AND d.District_Name LIKE CONCAT('%', ?, '%')`; vals.push(district); }
  if (province) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; vals.push(province); }

  const [rows] = await db.query(sql, vals);
  if (!rows.length) {
    return res.json({
      fulfillmentMessages: [{ text: { text: [`ยังไม่พบ "${category}" ใน${district?`อ.${district} `:''}${province?`จ.${province}`:''}`] } }],
      outputContexts: [ setCtx(req, 'awaiting_district', 0) ]
    });
  }

  return res.json({
    fulfillmentMessages: [{
      payload: {
        line: {
          type: 'template',
          altText: `หมวด ${category}${district?` อ.${district}`:''}${province?` จ.${province}`:''}`,
          template: { type: 'carousel', columns: buildColumns(rows) }
        }
      }
    }],
    outputContexts: [ setCtx(req, 'awaiting_district', 0) ] // เคลียร์ context
  });
}


// ===== Helper: แปลงข้อความเป็นจำนวน "วัน" (รองรับเลขไทย/คำไทยพื้นฐาน)
function parseTripDaysFromText(text='') {
  const t = String(text).replace(/\s+/g, '');
  if (!t) return null;

  const mNum = t.match(/(\d+)\s*วัน/);           // "3วัน" "ทริป2วัน"
  if (mNum) return Number(mNum[1]);

  const map = {
    'หนึ่งวัน': 1, '1วัน': 1, 'วันเดียว': 1, 'วันเดียวก็เที่ยวได้': 1,
    'สองวัน': 2, '2วัน': 2, 'สอง': 2,
    'สามวัน': 3, '3วัน': 3, 'สาม': 3,
    'สี่วัน': 4, '4วัน': 4, 'สี่': 4
  };
  for (const [k,v] of Object.entries(map)) {
    if (t.includes(k)) return v;
  }
  return null;
}

function moveDaysOutOfPhrase(phrase='', currentDays=null) {
  const d = parseTripDaysFromText(phrase); // ฟังก์ชันของคุณมีอยู่แล้ว
  if (!d) return { days: currentDays ?? null, type: phrase.trim() };
  // ตัดคำที่สื่อจำนวนวันออกจากวลี
  const rest = phrase
    .replace(/(\d+)\s*วัน/g, '')
    .replace(/วันเดียว|หนึ่งวัน/g, '')
    .replace(/สองวัน/g, '')
    .replace(/สามวัน/g, '')
    .replace(/สี่วัน/g, '')
    .trim();
  return { days: d, type: rest };
}


// แปลงชื่อเดือน (ไทยเต็ม/ไทยย่อ/อังกฤษ/อังกฤษย่อ) -> เลขเดือน 1-12
function monthNameToNum(s = '') {
  const t = String(s).trim().toLowerCase();
  if (!t) return null;

  const map = {
    'มกราคม':1,'ม.ค.':1,'มค':1,'jan':1,'january':1,
    'กุมภาพันธ์':2,'ก.พ.':2,'กพ':2,'feb':2,'february':2,
    'มีนาคม':3,'มี.ค.':3,'มีค':3,'mar':3,'march':3,
    'เมษายน':4,'เม.ย.':4,'เมย':4,'apr':4,'april':4,
    'พฤษภาคม':5,'พ.ค.':5,'พค':5,'may':5,
    'มิถุนายน':6,'มิ.ย.':6,'มิย':6,'jun':6,'june':6,
    'กรกฎาคม':7,'ก.ค.':7,'กค':7,'jul':7,'july':7,
    'สิงหาคม':8,'ส.ค.':8,'สค':8,'aug':8,'august':8,
    'กันยายน':9,'ก.ย.':9,'กย':9,'sep':9,'september':9,
    'ตุลาคม':10,'ต.ค.':10,'ตค':10,'oct':10,'october':10,
    'พฤศจิกายน':11,'พ.ย.':11,'พย':11,'nov':11,'november':11,
    'ธันวาคม':12,'ธ.ค.':12,'ธค':12,'dec':12,'december':12
  };
  return map[t] || null;
}

// เผื่อผู้ใช้พิมพ์เป็นประโยค “เทศกาลเดือนตุลาคม”
function guessMonthFromText(text='') {
  const m = String(text).match(/เดือน\s*([ก-๙a-z\.]+)/i);
  return m ? monthNameToNum(m[1]) : null;
}


////
const extractLatLng = (req) => {
  try {
    const od = req.body?.originalDetectIntentRequest?.payload;
    const p  = req.body?.queryResult?.parameters || {};
    const q  = String(req.body?.queryResult?.queryText || '');
    const c  = [];

    // 0) จาก parameters ตรงๆ (กรณีมี entity lat/long)
    if (Number(p.latitude) && Number(p.longitude)) {
      c.push({ lat: Number(p.latitude), lng: Number(p.longitude) });
    }

    // 1) LINE มาตรฐาน
    const ev0 = od?.data?.events?.[0];
    const mEv = ev0?.message;
    if (mEv?.type === 'location' && Number(mEv.latitude) && Number(mEv.longitude)) {
      c.push({ lat: Number(mEv.latitude), lng: Number(mEv.longitude) });
    }

    // 2) บางแอดอปเตอร์วางไว้ที่ data.message
    const m = od?.data?.message;
    if (m?.type === 'location' && Number(m.latitude) && Number(m.longitude)) {
      c.push({ lat: Number(m.latitude), lng: Number(m.longitude) });
    }

    // 3) รูปแบบ nested: message.location
    const nests = [
      od?.data?.message?.location,
      od?.data?.events?.[0]?.message?.location,
      od?.message?.location,
      od?.events?.[0]?.message?.location
    ].filter(Boolean);
    for (const x of nests) {
      if (Number(x?.latitude) && Number(x?.longitude)) {
        c.push({ lat: Number(x.latitude), lng: Number(x.longitude) });
      }
    }

    // 4) postback กรณีพิเศษ (บาง UI/LIFF ส่งมาแบบนี้)
    const pb = od?.data?.postback;
    if (pb?.params && Number(pb.params.latitude) && Number(pb.params.longitude)) {
      c.push({ lat: Number(pb.params.latitude), lng: Number(pb.params.longitude) });
    }
    // postback.data อาจเป็น JSON string
    if (typeof pb?.data === 'string') {
      try {
        const j = JSON.parse(pb.data);
        if (Number(j.latitude) && Number(j.longitude)) {
          c.push({ lat: Number(j.latitude), lng: Number(j.longitude) });
        }
      } catch {}
    }

    // 5) วางไว้ดื้อๆบน data
    if (Number(od?.data?.latitude) && Number(od?.data?.longitude)) {
      c.push({ lat: Number(od.data.latitude), lng: Number(od.data.longitude) });
    }

    // 6) เผื่อผู้ใช้พิมพ์ "6.99, 100.5" เอง
    const re = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/;
    const mText = q.match(re);
    if (mText) {
      c.push({ lat: Number(mText[1]), lng: Number(mText[2]) });
    }

    // คืนค่าที่แรกที่ valid
    const hit = c.find(k => Number.isFinite(k.lat) && Number.isFinite(k.lng));
    return hit || { lat: null, lng: null };
  } catch {
    return { lat: null, lng: null };
  }
};



const UA_EMAIL = process.env.CONTACT_EMAIL || '';

const fetchWithTimeout = (url, { timeoutMs = 3500, ...opts } = {}) =>
  Promise.race([
    fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('FETCH_TIMEOUT')), timeoutMs))
  ]);

const reverseGeocode = async (lat, lng) => {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1&accept-language=th`;
    const res = await fetchWithTimeout(url, {
      timeoutMs: 3500,
      headers: { 'User-Agent': `LumNamBot/1.0 (contact: ${UA_EMAIL})` }
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = await res.json();
    const a = data?.address || {};
    const district = a.county || a.state_district || a.city_district || a.town || a.city || a.suburb || null;
    const province = a.state || a.region || null;
    return { district, province };
  } catch (e) {
    console.warn('[reverseGeocode] fallback:', e.message);
    return { district: null, province: null };
  }
};


// context helpers
const sessionId = (req) => req.body.session; 
const ctxName = (req, short) => `${sessionId(req)}/contexts/${short}`;
const getCtx = (req, short) => (req.body.queryResult.outputContexts || []).find(c => c.name.endsWith(`/contexts/${short}`));

const wantNearMe = (text='') =>
  text.includes('ใกล้ฉัน') || text.includes('ใกล้ๆ') || text.includes('แถวนี้') || text.includes('ใกล้ตัว');

function setCtx(req, short, lifespan, params = {}) {
  return {
    name: ctxName(req, short),
    lifespanCount: lifespan,
    parameters: params
  };
}



router.post('/', async (req, res) => {

  // === ติดสปาย res.json เพื่อ log ทุก response ===
  if (!res.__loggerPatched) {
    const _json = res.json.bind(res);
    res.json = async (payload) => {
      // บันทึก interaction (ทำแบบ best-effort; ล้มเหลือก็แค่ log error ไม่พัง flow)
      try { await logInteractionFromReq(req, payload); } catch (e) {
        console.warn('[LOGGER] error:', e?.message || e);
      }
      return _json(payload);
    };
    res.__loggerPatched = true;
  }

  //////////////โค้ดเดิม

  let intentName = req.body.queryResult.intent.displayName;
  const params = req.body.queryResult.parameters;
  const queryText = req.body.queryResult.queryText;
  const od = req.body?.originalDetectIntentRequest?.payload;
  

  {
  const q = String(queryText || '').trim();

  
  // รูปแบบ: "เส้นทางท่องเที่ยว ประเภท XXX ..." หรือ "เส้นทางท่องเที่ยวXXX ..."
  const m = q.match(/^เส้นทางท่องเที่ยว\s*(?:ประเภท)?\s+(.+)$/i);
    if (m) {
      // ทำความสะอาดชื่อประเภทเผื่อมีคำจังหวัด/อำเภอติดท้าย
      const rt = cleanRouteType(m[1]);
      req.body.queryResult.parameters.RouteType  = rt;      // ตั้งค่าให้ intent ใช้ต่อ
      req.body.queryResult.parameters.Route_Type = rt;      // เผื่อ DF ใช้ชื่อคีย์นี้
      intentName = 'TourRoute';
    }
  }


  // ===== Force FestivalDetail even if DF mapped to Fallback =====
  {
    const q = String(queryText || '').trim();

    // 1) กรณีผู้ใช้กดปุ่มที่ส่งข้อความ FestivalDetail <id>
    let m = q.match(/^FestivalDetail\s+(.+)$/i);
    if (m) {
      const token = m[1].trim();
      if (/^\d+$/.test(token)) {
        req.body.queryResult.parameters.festival_id = Number(token);
      } else {
        req.body.queryResult.parameters.FestivalName = token;
      }
      intentName = 'FestivalDetail';
    }

    // 2) ดักข้อความไทย เช่น "รายละเอียดเทศกาล 4" หรือ "รายละเอียดเทศกาล กินเจหาดใหญ่"
    if (intentName === 'Default Fallback Intent') {
      m = q.match(/^รายละเอียด\s*เทศกาล\s+(.+)$/i);
      if (m) {
        const token = m[1].trim();
        if (/^\d+$/.test(token)) {
          req.body.queryResult.parameters.festival_id = Number(token);
        } else {
          req.body.queryResult.parameters.FestivalName = token;
        }
        intentName = 'FestivalDetail';
      }
    }
    if (intentName === 'FestivalDetail')
      console.log('[SWITCHED → FestivalDetail]', req.body.queryResult.parameters);
  }

  
  



  // ถ้าผู้ใช้พิมพ์ "ใกล้ฉัน/ใกล้ๆ/แถวนี้/ใกล้ตัว" ให้เคลียร์ near_station_ctx ตั้งแต่ต้น
if (wantNearMe(String(queryText || ''))) {
  req.body.queryResult.outputContexts = [
    ...(req.body.queryResult.outputContexts || []).filter(c => !c.name.endsWith('/contexts/near_station_ctx')),
    setCtx(req, 'near_station_ctx', 0)
  ];
}

  

  // "QUICK NAME MATCH ของชื่อสถานที่ขอรายละเอียด
  {
    const q = String(queryText || '').trim();
    const looksLikeName =
      q && q.length >= 2 && q.length <= 40 &&
      !/ใกล้ฉัน|สถานี|เส้นทาง|หมวด|จังหวัด|อำเภอ|เทศกาล/.test(q);

    if (looksLikeName && intentName === 'Default Fallback Intent') {
      try {
        const rows = await searchAttractionsLoose(db, q, 10);
        if (rows.length) {
          return res.json({
            fulfillmentMessages: [{
              payload: {
                line: {
                  type: 'template',
                  altText: 'เลือกสถานที่ที่ต้องการ',
                  template: { type: 'carousel', columns: buildAttractionListColumns(rows) }
                }
              }
            }]
          });
        }
      } catch (e) {
        console.warn('[QUICK-NAME-MATCH] error:', e?.message || e);
      }
    }
  }
  
  //  {
  //   const msgType =
  //     od?.data?.events?.[0]?.message?.type ||
  //     od?.data?.message?.type ||
  //     od?.events?.[0]?.message?.type ||
  //     od?.message?.type;

  //   if (intentName === 'OnLineLocation' && msgType !== 'location') {
  //     return res.json({
  //       fulfillmentMessages: [
  //         { text: { text: ['ยังไม่ได้รับพิกัด ลองกดปุ่ม “แชร์ตำแหน่ง” อีกครั้งนะ'] } }
  //       ],
  //       outputContexts: [{ name: ctxName(req, 'awaiting_location'), lifespanCount: 3 }]
  //     });
  //   }
  // }

  console.log("intentName:", intentName);
  console.log("queryText:", queryText);
  console.log("parameters:", params);
  console.log('[RAW ODR]', JSON.stringify(req.body?.originalDetectIntentRequest, null, 2));
  

  const typeA = od?.data?.message?.type;
  const typeB = od?.data?.events?.[0]?.message?.type;
  console.log('[HIT WEBHOOK]', new Date().toISOString(), typeA || typeB || 'unknown');
  console.log('[TYPE]', od?.data?.message?.type || od?.data?.events?.[0]?.message?.type);
    if (od?.data?.message?.type === 'location' || od?.data?.events?.[0]?.message?.type === 'location') {
      console.log('[LOCATION PAYLOAD]', JSON.stringify(od?.data, null, 2));
    }
  
  ///////////แก้ตรงนี้11//////
  console.log('[FULL BODY]', JSON.stringify(req.body, null, 2));
  console.log('[OD PAYLOAD]', JSON.stringify(req.body?.originalDetectIntentRequest?.payload, null, 2));

  ///////////แก้ตรงนี้11//////
  // {
  //   const waiting = getCtx(req, 'awaiting_location');  // เรากำลังรอพิกัดอยู่ไหม?
  //   const msgType =
  //     od?.data?.events?.[0]?.message?.type ||
  //     od?.data?.message?.type ||
  //     od?.events?.[0]?.message?.type ||
  //     od?.message?.type;

  //   // ถ้ากำลังรอพิกัด แต่ข้อความที่เข้ามาไม่ใช่ location → ทวงอีกครั้ง
  //   if (waiting && msgType !== 'location') {
  //     const category =
  //       waiting?.parameters?.category ||
  //       (Array.isArray(params?.category) ? params.category?.[0] : params?.category) ||
  //       'สถานที่';

  //     return res.json({
  //       fulfillmentMessages: [
  //         { text: { text: [`ยังไม่ได้รับพิกัดนะ ลองกด “แชร์ตำแหน่ง” เพื่อหา ${category} ใกล้ๆ`] } },
  //         { payload: { line: {
  //             type: 'text',
  //             text: 'กดปุ่มด้านล่างเพื่อแชร์ตำแหน่ง',
  //             quickReply: { items: [{ type: 'action', action: { type: 'location', label: 'แชร์ตำแหน่ง' } }] }
  //         } } }
  //       ],
  //       // คง context ไว้เพื่อรอรอบถัดไป
  //       outputContexts: [{
  //         name: ctxName(req, 'awaiting_location'),
  //         lifespanCount: 3,
  //         parameters: { category }
  //       }]
  //     });
  //   }
  // }


// ===== เมื่อกำลัง "รอผู้ใช้ตอบอำเภอ" (โหมดใกล้ฉันแบบไม่แชร์พิกัด) =====
    { 
      const waitDist = getCtx(req, 'awaiting_district');
      // ข้ามการดัก ถ้าเป็น flow สถานี/เส้นทาง หรือค้นชื่อสถานที่/เทศกาล
      const skipAwaitingDistrict =
        intentName === 'AttractionsNearStation' ||
        intentName === 'TourRoute' ||
        intentName === 'RouteDetail' ||
        intentName === 'ListFestivals' ||
        //intentName === 'FestivalDetail' ||
        /สถานี|รถไฟ/.test(String(req.body?.queryResult?.queryText || ''));

      if (waitDist && !skipAwaitingDistrict) {

    const userText = String(req.body?.queryResult?.queryText || '').trim();
    const provinceHint = String(waitDist?.parameters?.Province || '').trim();
    const isRecommended = String(waitDist?.parameters?.mode || '').toLowerCase() === 'recommend';

    // ✅ ถ้ามี category มาแล้ว (แปลว่า user กดหมวดจาก Flex card) → ปล่อยให้ intent หลักทำงานต่อไป
    const pickedCategory = Array.isArray(req.body?.queryResult?.parameters?.category)
      ? req.body.queryResult.parameters.category[0]
      : req.body?.queryResult?.parameters?.category;

    const GENERIC = ['ที่เที่ยว','เที่ยว','สถานที่','สถานที่ท่องเที่ยว','ที่ท่องเที่ยว','แหล่งท่องเที่ยว'];
    if (pickedCategory && !GENERIC.includes(String(pickedCategory).trim())) {
      // ข้ามบล็อกนี้ไป ปล่อยให้ intent หลักทำงาน
    } else {

      // 🔍 หาอำเภอที่ตรงกับข้อความ
      const cands = await findDistrictCandidates(userText, provinceHint);

      if (!cands.length) {
        return res.json({
          fulfillmentMessages: [
            { text: { text: [
              provinceHint
                ? `ระบุอำเภอในจังหวัด ${provinceHint} อีกครั้งได้ไหมคะ (เช่น "อำเภอเมือง", "ควนขนุน")`
                : 'ระบุอำเภอที่คุณอยู่ได้ไหมคะ (เช่น "อำเภอเมืองหาดใหญ่", "ควนขนุน")'
            ] } }
          ],
          outputContexts: [ setCtx(req, 'awaiting_district', 3, { Province: provinceHint, mode: isRecommended ? 'recommend' : 'category' }) ]
        });
      }

      if (cands.length > 1) {
        const items = cands.map(r => ({
          type: 'action',
          action: {
            type: 'message',
            label: `อ.${stripDistrictPrefix(r.District_Name)} จ.${r.Province_Name}`,
            text: `อำเภอ ${stripDistrictPrefix(r.District_Name)} จังหวัด ${r.Province_Name}`
          }
        }));
        return res.json({
          fulfillmentMessages: [
            { text: { text: ['พบหลายอำเภอที่เป็นไปได้ เลือกหนึ่งรายการค่ะ'] } },
            { payload: { line: { type: 'text', text: 'เลือกอำเภอ:', quickReply: { items: items.slice(0,13) } } } }
          ],
          outputContexts: [ setCtx(req, 'awaiting_district', 3, { Province: provinceHint, mode: isRecommended ? 'recommend' : 'category' }) ]
        });
      }

      // ✅ ถ้าระบุอำเภอได้ชัด → ตอบ Flex แล้วเคลียร์ context ทันที
      const hit = cands[0];
      const districtName = stripDistrictPrefix(hit.District_Name);

      // ✅ อ่านหมวดจาก context (กันโดน Dialogflow เขียนทับ)
      const ctxCategory =
        (waitDist?.parameters?.asked_category && String(waitDist.parameters.asked_category).trim()) ||
        (Array.isArray(waitDist?.parameters?.category) && waitDist.parameters.category[0]) ||
        (waitDist?.parameters?.category && String(waitDist.parameters.category).trim()) || '';

      // ✅ ถ้ามีหมวด (และไม่ใช่คำทั่วไป) → แสดงสถานที่ในหมวดนั้นทันที
      if (ctxCategory && !isGenericCategory(ctxCategory) &&
          String(waitDist?.parameters?.mode) === 'category') {
        return respondWithAttractionsForCategoryArea(req, res, {
          category: ctxCategory,
          province: hit.Province_Name,
          district: districtName
        });
      }

      // เดิม: ถ้าไม่มีหมวด → แสดงหมวดหมู่ในพื้นที่
      return respondWithCategoriesForArea(req, res, {
        province: hit.Province_Name,
        district: districtName,
        isRecommended
      });

    }
  }
}

// ===== handle LINE location first (works even if fired via Fallback/LINE_LOCATION) =====
const awaiting = getCtx(req, 'awaiting_location');
const { lat: _lat, lng: _lng } = extractLatLng(req);

if (_lat && _lng) {
  try {
    const category =
      awaiting?.parameters?.category ||
      (Array.isArray(params?.category) ? params.category?.[0] : params?.category) ||
      null;

    if (!category) {
      return res.json({
        fulfillmentMessages: [
          { text: { text: ['รับตำแหน่งแล้ว อยากหาอะไรใกล้ๆ (เช่น วัด, ร้านอาหาร, คาเฟ่)?'] } }
        ],
        outputContexts: [{ name: ctxName(req, 'awaiting_location'), lifespanCount: 3 }]
      });
    }

    // ⬇️ พยายาม reverse ก่อน (มี timeout แล้ว)
    const { district, province } = await reverseGeocode(_lat, _lng);
    const districtName = district ? district.replace(/^อำเภอ|^เขต/, '').trim() : null;

    if (districtName) {
      // ปกติ: ค้นหาในอำเภอเดียวกัน
      const [rows] = await db.query(`
        SELECT a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
        FROM attraction a
        JOIN category c ON a.Category_ID = c.Category_ID
        JOIN district d ON a.District_ID = d.District_ID
        WHERE c.Category_Name LIKE CONCAT('%', ?, '%')
          AND d.District_Name LIKE CONCAT('%', ?, '%')
      `, [category, districtName]);

      if (rows.length) {
        return res.json({
          fulfillmentMessages: [{
            payload: { line: {
              type: 'template',
              altText: `${category} ในอำเภอเดียวกับคุณ (${districtName}${province ? `, ${province}` : ''})`,
              template: { type: 'carousel', columns: buildColumns(rows) }
            } }
          }]
        });
      }
      // ถ้าในอำเภอไม่เจอ → ตกลงไปหารัศมีด้านล่าง
    }

    // ⬇️ Fallback รัศมี 15 กม. (ทำงานทั้งกรณีไม่มีอำเภอ หรืออำเภอหาแล้วว่าง)
    const [nearRows] = await db.query(`
      SELECT a.Attraction_Name, a.Attraction_Description, a.Attraction_Img,
             (6371 * ACOS(
               COS(RADIANS(?)) * COS(RADIANS(a.Latitude)) *
               COS(RADIANS(a.Longitude) - RADIANS(?)) +
               SIN(RADIANS(?)) * SIN(RADIANS(a.Latitude))
             )) AS distance_km
      FROM attraction a
      JOIN category c ON a.Category_ID = c.Category_ID
      WHERE c.Category_Name LIKE CONCAT('%', ?, '%')
      HAVING distance_km <= 15
      ORDER BY distance_km ASC
      LIMIT 10
    `, [_lat, _lng, _lat, category]);

    if (!nearRows.length) {
      return res.json({
        fulfillmentMessages: [{ text: { text: [`บริเวณนี้ยังไม่พบ "${category}" ในรัศมี ~15 กม.`] } }],
        outputContexts: [{ name: ctxName(req, 'awaiting_location'), lifespanCount: 0 }]
      });
    }

    return res.json({
      fulfillmentMessages: [{
        payload: { line: {
          type: 'template',
          altText: `${category} ใกล้คุณ (ภายใน ~15 กม.)`,
          template: { type: 'carousel', columns: buildColumns(nearRows) }
        } }
      }]
    });

  } catch (e) {
    console.error('[location handler] error:', e);
    return res.json({ fulfillmentMessages: [{ text: { text: ['มีข้อผิดพลาดในการค้นหาตามตำแหน่ง'] } }] });
  }
}


    // ถ้า Dialogflow ยิงมาจาก intent OnLineLocation ชัดเจน
  if (intentName === 'OnLineLocation' && !_lat && !_lng) {
    // กันกรณี intent โดนยิงแต่ payload ไม่มี lat/lng
    return res.json({ fulfillmentMessages: [{ text: { text: ['ยังไม่ได้รับพิกัด ลองแชร์อีกครั้งนะ'] } }] });
  }
  // ถ้าเป็น OnLineLocation และ extractLatLng ได้ lat/lng แล้ว
  // โค้ดจะวิ่งเข้า if (_lat && _lng) ด้านบนอัตโนมัติ (ไม่ต้องทำอะไรเพิ่ม)


  // === NEW helpers ===
  const chunk = (arr, size = 10) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const buildCategoryColumns = (rows, province, district) =>
    rows.slice(0, 10).map(r => ({
      thumbnailImageUrl: toImageUrl(r.Category_Img),
      title: (r.Category_Name || '').substring(0, 40),
      // ค้นในพื้นที่ไหน
      text: district ? `อ.${district}` : (province ? `จ.${province}` : 'เลือกดูสถานที่'),
      actions: [
        {
          type: 'message',
          label: 'ดูเพิ่มเติม',
          // ส่งประโยคให้ Dialogflow map เข้า Intent ListCategoryAttractions
          // (ต้องมี entity ของ category/province/district อยู่แล้ว)
          text: `ที่เที่ยว ${r.Category_Name} ${district || province || ''}`.trim()
        }
      ]
    }));

      // การ์ดเลือกหมวดหมู่ โชว์ข้อความว่าใกล้สถานีอะไร และอยู่ อ./จ. ไหน
  const buildCategoryColumnsForStation = (rows, stationName, province, district) =>
    rows.slice(0, 10).map(r => ({
      thumbnailImageUrl: toImageUrl(r.Category_Img),
      title: (r.Category_Name || '').substring(0, 40),
      text: `ใกล้สถานี ${stationName}\nอ.${district}${province ? ` จ.${province}` : ''}`,
      actions: [
        {
          type: 'message',
          label: 'ดูเพิ่มเติม',
          // ให้ผู้ใช้กดแล้วไป Intent: ListCategoryAttractions
          // เราไม่ต้องส่งจังหวัด/อำเภอในข้อความ เพราะจะอ่านจาก context
          text: `ที่เที่ยว ${r.Category_Name}`
        }
      ]
    }));

      //การ์ดแสดงสถานีทั้งหมด 
    const buildStationColumns = (rows) =>
    rows.slice(0, 10).map(r => ({
      thumbnailImageUrl: toImageUrl(r.Station_Img),
      title: (r.Station_Name || '').substring(0, 40),
      text: (`อ.${r.District_Name} จ.${r.Province_Name}`).substring(0, 60),
      // กดแล้วเรียก intent เดิม แต่ใส่ชื่อสถานีไปด้วย
      actions: [{ type: 'message', label: 'ดูเพิ่มเติม', text: `ขอที่เที่ยวใกล้สถานี${r.Station_Name}` }]
    }));


    ////tourRoute
  const FALLBACK_ROUTE_IMG ='https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_1_cafe.png';
  
  const buildRouteTypeBubbles = (types, provinceName, districtName, tripDays) => {
  const chunk = (arr, size = 10) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const groups = chunk(types, 10);
  const daySuffix = tripDays ? ` ${tripDays} วัน` : '';

  return groups.map(group => ({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: group.map(r => {
        const imgUrl = r.Rtype_img ? toImageUrl(r.Rtype_img) : FALLBACK_ROUTE_IMG;
        return {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "image", url: imgUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
            { type: "text", text: r.RType_Name || "-", weight: "bold", size: "md", wrap: true },
            {
              type: "button",
              style: "primary",
              color: "#32ca32ff",
              action: {
                type: "message",
                label: "ดูเพิ่มเติม",
                text: `เส้นทางท่องเที่ยว ประเภท ${r.RType_Name}${daySuffix} ${districtName || provinceName || ''}`.trim()
              }
            }
          ]
        };
      })
    }
  }));
};



      // ====== Intent: แสดงการ์ด "หมวดหมู่ทั้งหมด" สำหรับจังหวัด ======
  if (intentName === 'ListProvinceAttractions') {
    const getOne = v => Array.isArray(v) ? v[0] : v;
    const province = getOne(params.Province) || getOne(params.province) || '';

    if (!province) {
      return res.json({
        fulfillmentMessages: [{ text: { text: ['กรุณาระบุจังหวัดที่ต้องการค้นหา'] } }]
      });
    }

    try {
      // ดึงหมวดหมู่ทั้งหมด
      const [cats] = await db.query(`
        SELECT Category_Name, Category_Img, Sort_Order
        FROM category
        WHERE Sort_Order BETWEEN 1 AND 20
        ORDER BY Sort_Order ASC, Category_Name ASC
      `);

      if (!cats.length) {
        return res.json({
          fulfillmentMessages: [{ text: { text: ['ยังไม่มีข้อมูลหมวดหมู่'] } }]
        });
      }

      // // LINE carousel จำกัด 10 ใบ/ข้อความ → แบ่งหน้า
      // const pages = chunk(cats, 10);
      // const fms = pages.map((page, idx) => ({
      //   payload: {
      //     line: {
      //       type: 'template',
      //       altText: `เลือกหมวดที่เที่ยว จ.${province} (${idx + 1}/${pages.length})`,
      //       template: {
      //         type: 'carousel',
      //         // ส่ง province เข้าไปให้แสดงใต้การ์ด และประกอบเป็นข้อความปุ่ม
      //         columns: buildCategoryColumns(page, province, null)
      //       }
      //     }
      //   }
      // }));

      // // ข้อความช่วยใช้งาน ต่อท้ายครั้งเดียว
      // fms.push({ text: { text: ['กด “ดูเพิ่มเติม” เพื่อดูสถานที่ในหมวดนั้น ๆ ของจังหวัดนี้'] } });

      // return res.json({ fulfillmentMessages: fms });

      const bubbles = buildCategoryFlexBubbles(cats, province, null);
        return res.json({
          fulfillmentMessages: [{
            payload: {
              line: {
                type: "flex",
                altText: `เลือกหมวดที่เที่ยว จ.${province}`,
                contents: { type: "carousel", contents: bubbles }
              }
            }
          }]
        });


    } catch (error) {
      console.error('[ListProvinceAttractions] error:', error);
      return res.json({
        fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงหมวดหมู่'] } }]
      });
    }
  }


    
    // ====== Intent: การ์ด "หมวดหมู่ทั้งหมด" ตามจังหวัด/อำเภอ ======
  if (intentName === 'ListCategoriesHere') {
    // รับได้ทั้งตัวพิมพ์เล็ก/ใหญ่ และทั้งแบบ array/เดี่ยว
    const getOne = v => Array.isArray(v) ? v[0] : v;
    const province = (getOne(params.Province) || getOne(params.province) || '').trim();
    const district = (getOne(params.District) || getOne(params.district) || '').trim();

    try {
      // ดึงหมวดหมู่ทั้งหมด
      const [cats] = await db.query(`
        SELECT DISTINCT c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order
        FROM category c
        JOIN attraction a ON c.Category_ID = a.Category_ID
        JOIN district d ON a.District_ID = d.District_ID
        JOIN province p ON d.Province_ID = p.Province_ID
        WHERE c.Sort_Order BETWEEN 1 AND 20
          ${district ? "AND d.District_Name LIKE CONCAT('%', ?, '%')" : ""}
          ${province ? "AND p.Province_Name LIKE CONCAT('%', ?, '%')" : ""}
        ORDER BY c.Sort_Order ASC, c.Category_Name ASC
      `, 
        [
          ...(district ? [district] : []),
          ...(province ? [province] : [])
        ]
      );


      if (!cats.length) {
        return res.json({
          fulfillmentMessages: [{ text: { text: ['ยังไม่มีข้อมูลหมวดหมู่'] } }]
        });
      }

      // // LINE carousel จำกัด 10 ใบ/ข้อความ → แบ่งหน้า
      // const pages = chunk(cats, 10);
      // const fms = pages.map((page, idx) => ({
      //   payload: {
      //     line: {
      //       type: 'template',
      //       altText: `เลือกหมวดที่เที่ยว${
      //         district ? ` อ.${district}` : (province ? ` จ.${province}` : '')
      //       } (${idx + 1}/${pages.length})`,
      //       template: {
      //         type: 'carousel',
      //         // แสดงจังหวัด/อำเภอใต้การ์ด และฝังลงในข้อความปุ่ม “ดูเพิ่มเติม”
      //         columns: buildCategoryColumns(page, province, district)
      //       }
      //     }
      //   }
      // }));

      // // ข้อความช่วยใช้งาน ต่อท้ายครั้งเดียว
      // fms.push({ text: { text: ['กด “ดูเพิ่มเติม” เพื่อดูสถานที่ในหมวดนั้น ๆ ของพื้นที่ที่เลือก'] } });

      // return res.json({ fulfillmentMessages: fms });

      const bubbles = buildCategoryFlexBubbles(cats, province, district);
      return res.json({
        fulfillmentMessages: [{
          payload: {
            line: {
              type: "flex",
              altText: `เลือกหมวดที่เที่ยว${district ? ` อ.${district}` : (province ? ` จ.${province}` : '')}`,
              contents: { type: "carousel", contents: bubbles }
            }
          }
        }]
      });


    } catch (e) {
      console.error('[ListCategoriesHere] error:', e);
      return res.json({
        fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงหมวดหมู่'] } }]
      });
    }
  }


  // ====== Intent: แสดงสถานที่ท่องเที่ยวตามหมวดหมู่ + จังหวัด + อำเภอ (โหมดใกล้ฉันแบบ "ถามอำเภอ") ======
if (intentName === 'ListCategoryAttractions') {
  const getOne = v => Array.isArray(v) ? v[0] : v;

  const rawCategory = getOne(params.category);
  const nearMe = wantNearMe(queryText);

  let province = (getOne(params.Province) || getOne(params.province) || '').trim();
  let district = (getOne(params.District) || getOne(params.district) || '').trim();

  if (nearMe) {
      province = '';
      district = '';
    }

  // ===== helpers สำหรับ intent นี้ =====
  const isGenericCategory = (c) => {
    if (!c) return true;
    const t = String(c).trim();
    const GENERIC = ['ที่เที่ยว','เที่ยว','สถานที่','สถานที่ท่องเที่ยว','ที่ท่องเที่ยว','แหล่งท่องเที่ยว'];
    return GENERIC.includes(t);
  };
  async function resolveDistrictFromText(text, provinceHint) {
    const t = (text || '').replace(/\s+/g, '');
    let sql = `SELECT d.District_Name
               FROM district d
               JOIN province p ON d.Province_ID = p.Province_ID
               WHERE REPLACE(d.District_Name,' ','') <> ''`;
    const vals = [];
    if (provinceHint) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; vals.push(provinceHint); }
    const [all] = await db.query(sql, vals);
    const hit = (all || []).find(row => t.includes(stripDistrictPrefix(row.District_Name)));
    return hit ? stripDistrictPrefix(hit.District_Name) : '';
  }

  // ทำความสะอาดค่า
  district = stripDistrictPrefix(district);
  if (!district) {
    district = await resolveDistrictFromText(queryText, province);
  }
  const category = isGenericCategory(rawCategory) ? '' : rawCategory;

  // helper สร้างคอลัมน์ "หมวดหมู่"
  const toCategoryColumns = (rows) =>
    rows.slice(0, 10).map(r => ({
      thumbnailImageUrl: r.Category_Img || 'https://via.placeholder.com/1024x684?text=Category',
      title: (r.Category_Name || 'หมวดหมู่').substring(0, 40),
      text: (r.Category_Description || 'ดูสถานที่ในหมวดนี้').substring(0, 60),
      actions: [{ type: 'message', label: 'ดูเพิ่มเติม', text: r.Category_Name }]
    }));

  try {
    // ---------- โหมด "ใกล้ฉัน" (ไม่ขอพิกัด — ขอชื่ออำเภอแทน) ----------
    if (nearMe) {
      const tips = (province && province.trim())
        ? `กรุณาพิมพ์ชื่ออำเภอในจังหวัด${province} (เช่น อำเภอเมือง, ควนขนุน)`
        : `กรุณาพิมพ์ชื่ออำเภอที่คุณอยู่ (เช่น หาดใหญ่, ควนขนุน)`;

      return res.json({
        fulfillmentMessages: [{ text: { text: [tips] } }],
        outputContexts: [
          setCtx(req, 'near_station_ctx', 0),
          setCtx(req, 'awaiting_district', 3, {
            category: rawCategory || '',
            asked_category: rawCategory || '',
            Province: '',
            mode: 'category'   // สำหรับ ListCategoryAttractions
          })
        ]
      });
    }

    // =========================
    // โหมดจังหวัด / อำเภอ (ไม่มีหมวดหมู่)
    // =========================

    // A) มีจังหวัด แต่ไม่มีหมวด/อำเภอ → แสดง "หมวดหมู่ทั้งหมด" ในจังหวัดนั้น
    if (province && !district && !category) {
      const [rows] = await db.query(`
        SELECT DISTINCT c.Category_ID, c.Category_Name, c.Category_Img
        FROM category c
        JOIN attraction a ON a.Category_ID = c.Category_ID
        JOIN district d ON a.District_ID = d.District_ID
        JOIN province p ON d.Province_ID = p.Province_ID
        WHERE p.Province_Name LIKE CONCAT('%', ?, '%')
      `, [province]);

      if (!rows.length) {
        return res.json({ fulfillmentMessages: [{ text: { text: [`ไม่พบหมวดหมู่ในจังหวัด ${province}`] } }] });
      }
      return res.json({
        fulfillmentMessages: [{
          payload: { line: { type: 'template', altText: `หมวดหมู่ในจังหวัด ${province}`,
            template: { type: 'carousel', columns: toCategoryColumns(rows) } } }
        }]
      });
    }

    // B) มีอำเภอ (จะมี/ไม่มีจังหวัดก็ได้) และไม่มีหมวด → แสดงหมวดที่อำเภอนั้นมี
    if (district && !category) {
      let catSql = `
        SELECT DISTINCT c.Category_ID, c.Category_Name, c.Category_Img
        FROM category c
        JOIN attraction a ON a.Category_ID = c.Category_ID
        JOIN district d ON a.District_ID = d.District_ID
        JOIN province p ON d.Province_ID = p.Province_ID
        WHERE d.District_Name LIKE CONCAT('%', ?, '%')
      `;
      const catVals = [district];
      if (province) { catSql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; catVals.push(province); }

      const [rows] = await db.query(catSql, catVals);
      if (!rows.length) {
        return res.json({
          fulfillmentMessages: [{ text: { text: [`ไม่พบหมวดหมู่ในอำเภอ ${district}${province ? ` จังหวัด ${province}` : ''}`] } }]
        });
      }
      return res.json({
        fulfillmentMessages: [{
          payload: { line: { type: 'template',
            altText: `หมวดหมู่ในอำเภอ ${district}${province ? `, จังหวัด ${province}` : ''}`,
            template: { type: 'carousel', columns: toCategoryColumns(rows) } } }
        }]
      });
    }

    // =========================
    // โหมดปกติ (มีหมวดแล้ว) → แสดง "สถานที่"
    // =========================
    let sql = `
      SELECT a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
      FROM attraction a
      JOIN category c ON a.Category_ID = c.Category_ID
      JOIN district d ON a.District_ID = d.District_ID
      JOIN province p ON d.Province_ID = p.Province_ID
      WHERE c.Category_Name LIKE CONCAT('%', ?, '%')
    `;
    const values = [category];

    if (province && province.trim()) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; values.push(province); }
    if (district && district.trim()) { sql += ` AND d.District_Name LIKE CONCAT('%', ?, '%')`; values.push(district); }

    const [rows] = await db.query(sql, values);
    if (!rows.length) {
      return res.json({
        fulfillmentMessages: [{ text: { text: [`ไม่พบหมวด "${category}" ${province ? `ในจังหวัด ${province}` : ''} ${district ? `อำเภอ ${district}` : ''}`] } }]
      });
    }

    return res.json({
      fulfillmentMessages: [{
        payload: { line: { type: 'template',
          altText: `สถานที่ท่องเที่ยวหมวด "${category}"`,
          template: { type: 'carousel', columns: buildColumns(rows) } } }
      }]
    });

  } catch (error) {
    console.error('[ListCategoryAttractions] error:', error);
    return res.json({ fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงข้อมูล'] } }] });
  }
}




// ====== Intent: เส้นทางท่องเที่ยว ======
if (intentName === 'TourRoute') {
  const getOne = v => Array.isArray(v) ? v[0] : v;

  let provinceName = (getOne(params.Province) || getOne(params.province) || '').trim();
  let districtName = (getOne(params.District) || getOne(params.district) || '').trim();
  // ดึงจำนวนวันจากพารามิเตอร์/ข้อความ “เฉพาะรอบนี้”
  let tripDays = getOne(params.day) || parseTripDaysFromText(queryText);

  // ผู้ใช้พูดถึงจำนวนวันชัดเจนไหม (เช่น "1 วัน", "วันเดียว", "2 วัน")
  const saidDaysExplicit = /(\d+)\s*วัน|วันเดียว|หนึ่งวัน|สองวัน|สามวัน|สี่วัน/i
    .test(String(queryText || ''));

  // ถ้ารอบนี้ผู้ใช้ไม่ได้พูดเรื่องจำนวนวันเลย → เมินค่าค้างใน context ให้เป็น null
  if (!saidDaysExplicit && !getOne(params.day)) {
    tripDays = null;
  } else if (!tripDays) {
    tripDays = null; // กันค่าพิกล
  }

  // (ทางเลือก) ถ้าถามกว้างๆ เช่น "แนะนำเส้นทางท่องเที่ยวหน่อย" ให้บังคับไม่กรองวัน
  const genericAsk = /^(แนะนำ)?\s*เส้นทาง(?:การ)?ท่องเที่ยว(หน่อย)?$/i
    .test(String(queryText || '').trim());
  if (genericAsk) tripDays = null;

  // ---- หา "ประเภทเส้นทาง" จาก entity/ข้อความ
  let routeTypeName = (getOne(params.RouteType) || getOne(params.route_type) ||  getOne(params['Route_Type']) || '').trim();
  if (!routeTypeName && queryText) {
    // รองรับทั้งมี/ไม่มีคำว่า "ประเภท"
    const m = String(queryText).match(/^เส้นทางท่องเที่ยว\s*(?:ประเภท)?\s+(.+)$/i);
    if (m) routeTypeName = cleanRouteType(m[1].trim());
  }

  // ---- เผื่อผู้ใช้พิมพ์ จ./อ. ไว้ในข้อความ (ไม่ได้ติด entity)
  if (!provinceName && queryText) {
    const mp = queryText.match(/(?:จ\.|จังหวัด)\s*([^\s]+)/);
    if (mp) provinceName = mp[1].trim();
  }
  if (!districtName && queryText) {
    const md = queryText.match(/(?:อ\.|อำเภอ)\s*([^\s]+)/);
    if (md) districtName = md[1].trim();
  }

  // ---- ทำความสะอาดชื่อประเภท (กันเคสมีคำจังหวัด/อำเภอติดท้าย)
  routeTypeName = cleanRouteType(routeTypeName);

  console.log('[ROUTE DEBUG]', {
  provinceName, districtName, tripDays, routeTypeName
  });

  {
    const m = moveDaysOutOfPhrase(routeTypeName, tripDays);
    tripDays = m.days;
    routeTypeName = m.type; // อาจกลายเป็น '' ถ้าผู้ใช้พูดแค่ "2วัน"
  }
  // ถ้า routeTypeName ยังพ่วงชื่อจังหวัด/อำเภอมาแบบไม่มีคำนำหน้า ให้ตัดด้วย
  if (provinceName && routeTypeName.endsWith(provinceName)) {
    routeTypeName = routeTypeName.replace(new RegExp(`\\s*${provinceName}$`), '').trim();
  }
  if (districtName && routeTypeName.endsWith(districtName)) {
    routeTypeName = routeTypeName.replace(new RegExp(`\\s*${districtName}$`), '').trim();
  }

  try {
    // 1) ยังไม่ระบุ "ประเภท" → แสดง “ประเภทเส้นทางที่มีอยู่จริงในพื้นที่” (ถ้าระบุ จ./อ. มา)
    if (!routeTypeName) {
      let typeSql = `
        SELECT DISTINCT rt.RType_ID, rt.RType_Name, rt.Rtype_img
        FROM route_type rt
        JOIN route r             ON r.RType_ID    = rt.RType_ID
        JOIN route_attraction ra ON ra.Route_ID   = r.Route_ID
        JOIN attraction a        ON a.Attraction_ID = ra.Attraction_ID
        JOIN district d          ON d.District_ID = a.District_ID
        JOIN province p          ON p.Province_ID = d.Province_ID
        WHERE 1=1
      `;

      const tVals = [];
      if (tripDays) { typeSql += ` AND r.Trip_Days = ?`; tVals.push(tripDays); }

      if (provinceName) { typeSql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; tVals.push(provinceName); }
      if (districtName) { typeSql += ` AND d.District_Name  LIKE CONCAT('%', ?, '%')`; tVals.push(districtName); }
      typeSql += ` ORDER BY rt.RType_ID ASC`;

      const [types] = (provinceName || districtName)
        ? await db.query(typeSql, tVals)
        : await db.query(
            `SELECT DISTINCT rt.RType_ID, rt.RType_Name, rt.Rtype_img
            FROM route_type rt
            JOIN route r ON r.RType_ID = rt.RType_ID
            ${tripDays ? 'WHERE r.Trip_Days = ?' : ''}
            ORDER BY rt.RType_ID ASC`,
            tripDays ? [tripDays] : []
          )


      if (!types.length) {
        return res.json({ fulfillmentMessages: [{
          text: { text: [
            provinceName || districtName
              ? `ยังไม่พบประเภทเส้นทางที่มีในพื้นที่${districtName ? ` อ.${districtName}` : ''}${provinceName ? ` จ.${provinceName}` : ''}`
              : 'ยังไม่มีข้อมูลประเภทเส้นทาง'
          ] }
        }] });
      }

      const bubbles = buildRouteTypeBubbles(types, provinceName, districtName, tripDays);

      return res.json({
        fulfillmentMessages: [{
          payload: { line: { type: "flex", altText: "เลือกประเภทเส้นทางท่องเที่ยว", contents: { type: "carousel", contents: bubbles } } }
        }],
        // เก็บพื้นที่ไว้ให้ RouteDetail ใช้กรองตอนกด "ดูเพิ่มเติม"
        outputContexts: [{
          name: ctxName(req, 'route_area_ctx'),
          lifespanCount: 5,
          parameters: { province_name: provinceName || '', district_name: districtName || '' , trip_days: saidDaysExplicit ? (tripDays || null) : null }
        }]
      });
    }

    if (!tripDays) {
      const ctx = getCtx(req, 'route_area_ctx');
      if (ctx?.parameters?.trip_days) tripDays = Number(ctx.parameters.trip_days) || null;
    }

    // 2) ระบุประเภทแล้ว → ดึง “รายการเส้นทาง” ตามเงื่อนไข
    let sql = `
      SELECT DISTINCT
        r.Route_ID, r.Route_Name, r.Description_Route, r.Route_Img, r.Trip_Days,
        rt.RType_Name
      FROM route r
      JOIN route_type rt       ON r.RType_ID    = rt.RType_ID
      JOIN route_attraction ra ON r.Route_ID    = ra.Route_ID
      JOIN attraction a        ON ra.Attraction_ID = a.Attraction_ID
      JOIN district d          ON a.District_ID = d.District_ID
      JOIN province p          ON d.Province_ID = p.Province_ID
      WHERE rt.RType_Name LIKE CONCAT('%', ?, '%')
    `;
    const values = [routeTypeName];

    if (provinceName) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; values.push(provinceName); }
    if (districtName) { sql += ` AND d.District_Name  LIKE CONCAT('%', ?, '%')`; values.push(districtName); }
    if (tripDays)     { sql += ` AND r.Trip_Days = ?`;                          values.push(tripDays); }

    sql += ` ORDER BY r.Route_ID DESC LIMIT 30`;

    const [routes] = await db.query(sql, values);

    // ไม่พบ → ถ้าไม่ได้ล็อกพื้นที่ ให้ fallback ค้นทั้งระบบด้วย “ประเภทที่ทำความสะอาดแล้ว”
    if (!routes.length) {
      if (!provinceName && !districtName) {
        const [fallbackRoutes] = await db.query(`
          SELECT DISTINCT
            r.Route_ID, r.Route_Name, r.Description_Route, r.Route_Img, r.Trip_Days,
            rt.RType_Name
          FROM route r
          JOIN route_type rt ON r.RType_ID = rt.RType_ID
          WHERE rt.RType_Name LIKE CONCAT('%', ?, '%')
          ORDER BY r.Route_ID DESC LIMIT 30
        `, [routeTypeName]);

        if (!fallbackRoutes.length) {
          return res.json({ fulfillmentMessages: [{ text: { text: [`ยังไม่พบเส้นทางในประเภท "${routeTypeName}"`] } }] });
        }

        return res.json({
          fulfillmentMessages: [{
            payload: {
              line: {
                type: "flex",
                altText: `เส้นทาง (${routeTypeName})`,
                contents: {
                  type: "carousel",
                  contents: fallbackRoutes.map(r => {
                    const clean = String(r.Route_Img || '').replace(/^\/+/, '').trim();
                    const imageUrl = `${BASE_URL}/uploads/${encodeURIComponent(clean)}`;
                    return {
                      type: "bubble",
                      hero: { type: "image", url: imageUrl || FALLBACK_ROUTE_IMG, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
                      body: {
                        type: "box", layout: "vertical", contents: [
                          { type: "text", text: r.Route_Name, weight: "bold", size: "lg", wrap: true },
                          { type: "text", text: r.RType_Name || "-", size: "sm", color: "#2f3e5c", wrap: true },
                          { type: "text", text: r.Description_Route || "-", size: "sm", color: "#555555", wrap: true }
                        ]
                      },
                      footer: {
                        type: "box", layout: "vertical", contents: [
                          // ปุ่มไป RouteDetail (จะใช้ context กรอง จ./อ. หากมี)
                          { type: "button", style: "primary",
                            action: { type: "message", label: "ดูเพิ่มเติม", text: `RouteDetail ${r.Route_ID}` } }
                        ]
                      }
                    };
                  })
                }
              }
            }
          }],
          outputContexts: [{
            name: ctxName(req, 'route_area_ctx'),
            lifespanCount: 5,
            parameters: { province_name: provinceName || '', district_name: districtName || '' , trip_days: saidDaysExplicit ? (tripDays || null) : null }
          }]
        });
      }

      // แจ้งไม่พบในพื้นที่ที่ระบุ
      return res.json({
        fulfillmentMessages: [{ text: { text: [
          `ไม่พบเส้นทางในประเภท "${routeTypeName}"${provinceName?` ในจ.${provinceName}`:''}${districtName?` อ.${districtName}`:''}${tripDays?` (${tripDays} วัน)`:''}`
        ] } }]
      });
    }

    // มีรายการ → Flex แสดงเส้นทาง
    const bubbles = routes.map(r => {
      const clean = String(r.Route_Img || '').replace(/^\/+/, '').trim();
      const imageUrl = `${BASE_URL}/uploads/${encodeURIComponent(clean)}`;
      return {
        type: "bubble",
        hero: { type: "image", url: imageUrl || FALLBACK_ROUTE_IMG, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: r.Route_Name, weight: "bold", size: "lg", wrap: true },
            { type: "text", text: r.RType_Name || "-", size: "sm", color: "#2f3e5c", wrap: true },
            { type: "text", text: r.Description_Route || "-", size: "sm", color: "#555555", wrap: true }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            // ปุ่มไป RouteDetail (ใช้ route_id เดียวกัน และใช้ จ./อ. จาก context)
            { type: "button", style: "primary",
              action: { type: "message", label: "ดูเพิ่มเติม", text: `RouteDetail ${r.Route_ID}` } }
          ]
        }
      };
    });

    return res.json({
      fulfillmentMessages: [{
        payload: { line: { type: "flex", altText: `เส้นทาง (${routeTypeName})`, contents: { type: "carousel", contents: bubbles } } }
      }],
      // เก็บ จ./อ. ไว้ใน context → RouteDetail จะเอาไปกรอง attraction ของ route เดียวกัน
      outputContexts: [{
        name: ctxName(req, 'route_area_ctx'),
        lifespanCount: 5,
        parameters: { province_name: provinceName || '', district_name: districtName || '' , trip_days: tripDays || null }
      }]
    });

  } catch (error) {
    console.error('[TourRoute] error:', error);
    return res.json({ fulfillmentMessages: [{ text: { text: ["เกิดข้อผิดพลาดในการประมวลผลข้อมูล"] } }] });
  }
}



  // ===== Intent: แสดงสถานที่ทั้งหมดในเส้นทาง =====
if (intentName === 'RouteDetail') {
  const getOne = v => Array.isArray(v) ? v[0] : v;

  // route_id จาก param หรือจากข้อความ "RouteDetail 123"
  let routeId = getOne(params.route_id);
  if (!routeId && queryText) {
    const m = String(queryText).match(/RouteDetail\s+(\d+)/i);
    if (m) routeId = m[1];
  }
  if (!routeId) {
    return res.json({ fulfillmentMessages: [{ text: { text: ['ไม่พบรหัสเส้นทางที่ต้องการ'] } }] });
  }

  // พื้นที่ที่ต้องการกรอง
  let provinceName = (getOne(params.Province) || getOne(params.province) || '').trim();
  let districtName = (getOne(params.District) || getOne(params.district) || '').trim();

  // ดึงจาก context ที่ TourRoute ตั้งไว้
  const areaCtx = getCtx(req, 'route_area_ctx');
  if (!provinceName && areaCtx?.parameters?.province_name) {
    provinceName = String(areaCtx.parameters.province_name).trim();
  }
  if (!districtName && areaCtx?.parameters?.district_name) {
    districtName = String(areaCtx.parameters.district_name).trim();
  }

  // เผื่อผู้ใช้พิมพ์ จ./อ. ต่อท้ายเอง
  if (queryText && !provinceName) {
    const mp = queryText.match(/(?:จ\.|จังหวัด)\s*([^\s]+)/);
    if (mp) provinceName = mp[1].trim();
  }
  if (queryText && !districtName) {
    const md = queryText.match(/(?:อ\.|อำเภอ)\s*([^\s]+)/);
    if (md) districtName = md[1].trim();
  }

  try {
    // คิวรีดึงสถานที่ในเส้นทาง + เงื่อนไขพื้นที่ (ถ้ามี)
    let sql = `
      SELECT a.Attraction_ID, a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
      FROM route_attraction ra
      JOIN attraction a ON ra.Attraction_ID = a.Attraction_ID
      JOIN district d   ON a.District_ID   = d.District_ID
      JOIN province p   ON d.Province_ID   = p.Province_ID
      WHERE ra.Route_ID = ?
    `;
    const vals = [routeId];
    if (provinceName) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; vals.push(provinceName); }
    if (districtName) { sql += ` AND d.District_Name LIKE CONCAT('%', ?, '%')`; vals.push(districtName); }
    sql += ` ORDER BY ra.Route_ID ASC`;

    let [rows] = await db.query(sql, vals);

    // ถ้า “กรองพื้นที่แล้วไม่เจอ” ให้ fallback เป็นแสดงทั้งหมดใน route นั้น
    if (!rows.length && (provinceName || districtName)) {
      [rows] = await db.query(`
        SELECT a.Attraction_ID, a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
        FROM route_attraction ra
        JOIN attraction a ON ra.Attraction_ID = a.Attraction_ID
        WHERE ra.Route_ID = ?
        ORDER BY a.Attraction_ID ASC
      `, [routeId]);
    }

    if (!rows.length) {
      return res.json({ fulfillmentMessages: [{ text: { text: ['ไม่พบสถานที่ในเส้นทางนี้'] } }] });
    }

    // การ์ด carousel แสดงสถานที่
    return res.json({
      fulfillmentMessages: [{
        payload: {
          line: {
            type: 'template',
            altText: `สถานที่ท่องเที่ยวในเส้นทาง ${routeId}${districtName?` อ.${districtName}`:''}${provinceName?` จ.${provinceName}`:''}`,
            template: { type: 'carousel', columns: buildColumns(rows) }
          }
        }
      }]
    });

  } catch (error) {
    console.error('[RouteDetail] error:', error);
    return res.json({
      fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงข้อมูลสถานที่ของเส้นทาง'] } }]
    });
  }
}



      // ====== Intent: ขอเทศกาล “ตามพื้นที่/ช่วงเวลา” ======
  if (intentName === 'ListFestivals') {
  const getOne = v => Array.isArray(v) ? v[0] : v;

  const province = (getOne(params.Province) || getOne(params.province) || '').trim();
  const district = (getOne(params.District) || getOne(params.district) || '').trim();
  const theDate  = (getOne(params.date) || getOne(params.Date) || '').trim();

  //รับชื่อเดือนจากพารามิเตอร์หรือเดาจากข้อความ
  let monthRaw = '';
  let monthNum = null;

  // ถ้ามีค่า Month จาก Dialogflow (จะเป็น object มี startDate/endDate)
  if (params.Month && typeof params.Month === 'object') {
    try {
      const startDate = new Date(params.Month.startDate);
      monthNum = startDate.getMonth() + 1; // เดือน 0–11 → +1
      monthRaw = startDate.toLocaleString('th-TH', { month: 'long' });
    } catch (e) {
      console.error('[Month parse error]', e);
    }
  } else {
    // fallback เผื่อพิมพ์เอง เช่น "เดือนตุลาคม"
    const raw = (getOne(params.month) || '').trim();
    monthNum = monthNameToNum(raw) || guessMonthFromText(queryText);
    monthRaw = raw;
  }

  // โหมดเริ่มต้น: เทศกาลที่กำลังจะมาถึง
  let sql = `
    SELECT Festival_ID, Festival_Name, Festival_description, Start_date, End_date, Festival_Img
    FROM festival
    WHERE 1=1
  `;
  const values = [];

  // จังหวัด/อำเภอ (ถ้ามี)
  // if (province) {
  //   sql += ` AND EXISTS (
  //     SELECT 1 FROM province p
  //     WHERE p.Province_ID = festival.Province_ID
  //       AND p.Province_Name LIKE CONCAT('%', ?, '%')
  //   )`;
  //   values.push(province);
  // }
  // if (district) {
  //   sql += ` AND EXISTS (
  //     SELECT 1 FROM district d
  //     WHERE d.District_ID = festival.District_ID
  //       AND d.District_Name LIKE CONCAT('%', ?, '%')
  //   )`;
  //   values.push(district);
  // }

  // ✅ ถ้ามีวันที่เจาะจง → เลือกเทศกาลที่ “คร่อม” วันนั้น
  if (theDate) {
    sql += ` AND ? BETWEEN Start_date AND End_date`;
    values.push(theDate);
  } else if (monthNum) {
    // ✅ ถ้าถามเป็น “เดือน” → เลือกเทศกาลที่ช่วงจัดงานทับซ้อนกับเดือนนั้น (อิงปีปัจจุบัน)
    // firstDay = YYYY-MM-01, lastDay = LAST_DAY(firstDay)
    sql += `
      AND Start_date <= LAST_DAY(DATE(CONCAT(YEAR(CURDATE()), '-', LPAD(?,2,'0'), '-01')))
      AND End_date   >= DATE(CONCAT(YEAR(CURDATE()), '-', LPAD(?,2,'0'), '-01'))
    `;
    values.push(monthNum, monthNum);
  } else {
    // เดิม: ไม่มีทั้งวันและเดือน → แสดงเฉพาะที่ยังไม่จบวันนี้
    sql += ` AND End_date >= CURDATE()`;
  }

  sql += ` ORDER BY Start_date ASC LIMIT 30`;

  try {
    const [rows] = await db.query(sql, values);
    if (!rows.length) {
      const monthLabel = monthRaw || (monthNum ? `เดือนที่ ${monthNum}` : '');
      return res.json({
        fulfillmentMessages: [
          { text: { text: [
            `ไม่พบเทศกาลที่ตรงเงื่อนไข${
              province?` ใน จ.${province}`:''}${
              district?` อ.${district}`:''}${
              theDate?` ณ วันที่ ${theDate}`:''}${
              monthNum?` ใน${monthLabel}`:''
            }`
          ] } }
        ]
      });
    }

    const pages = chunk10(rows);
    const fms = pages.map((page, idx) => ({
      payload: {
        line: {
          type: "flex",
          altText: `เทศกาล/งานประเพณี (${idx + 1}/${pages.length})`,
          contents: { type: "carousel", contents: buildFestivalBubbles(page) }
        }
      }
    }));
    return res.json({ fulfillmentMessages: fms });

  } catch (e) {
    console.error('[ListFestivals] error:', e);
    return res.json({ fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงข้อมูลเทศกาล'] } }] });
  }
}





  // ====== Intent: รายละเอียดเทศกาล ======
if (intentName === 'FestivalDetail') {
  const getOne = v => Array.isArray(v) ? v[0] : v;

  // รับได้ทั้ง param และข้อความ "FestivalDetail 123"
  let festId = getOne(params.festival_id) || null;
  let festName = (getOne(params.FestivalName) || '').trim();

  if (!festId && queryText) {
    const mId = String(queryText).match(/FestivalDetail\s+(\d+)/i);
    if (mId) festId = mId[1];
  }

  try {
    let rows, sql, vals;
    if (festId) {
      sql = `
        SELECT Festival_ID, Festival_Name, Festival_description, Start_date, End_date, Festival_Img
        FROM festival
        WHERE Festival_ID = ?
        LIMIT 1
      `;
      vals = [festId];
    } else if (festName) {
      sql = `
        SELECT Festival_ID, Festival_Name, Festival_description, Start_date, End_date, Festival_Img
        FROM festival
        WHERE Festival_Name LIKE CONCAT('%', ?, '%')
        ORDER BY Start_date DESC
        LIMIT 1
      `;
      vals = [festName];
    } else {
      return res.json({ fulfillmentMessages: [{ text: { text: ['กรุณาระบุชื่อหรือตัวเลขรหัสเทศกาล'] } }] });
    }

    [rows] = await db.query(sql, vals);
    if (!rows.length) {
      return res.json({ fulfillmentMessages: [{ text: { text: ['ไม่พบข้อมูลเทศกาล'] } }] });
    }

    const f = rows[0];
    const bubble = {
      type: "bubble",
      hero: { type: "image", url: toFestImg(f.Festival_Img), size: "full", aspectRatio: "20:13", aspectMode: "cover" },
      body: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          { type: "text", text: f.Festival_Name || '-', weight: "bold", size: "lg", wrap: true },
          { type: "text", text: (f.Festival_description || '-').substring(0, 450), size: "sm", color: "#555555", wrap: true },
          { type: "text", text: `ช่วงจัดงาน: ${f.Start_date} ถึง ${f.End_date}`, size: "xs", color: "#888888", wrap: true }
        ]
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", contents: [
          {
            type: "button",
            style: "secondary",
            action: { type: "message", label: "ดูเทศกาลอื่นๆ", text: "ขอเทศกาล" }
          }
        ]
      }
    };

    return res.json({
      fulfillmentMessages: [{
        payload: { line: { type: "flex", altText: f.Festival_Name, contents: bubble } }
      }]
    });

  } catch (e) {
    console.error('[FestivalDetail] error:', e);
    return res.json({ fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงรายละเอียดเทศกาล'] } }] });
  }
}



    // ====== Intent: ขอที่เที่ยว "ใกล้สถานีรถไฟ..." -> แสดงหมวดก่อน ======
    if (intentName === 'AttractionsNearStation') {
    const getOne = v => Array.isArray(v) ? v[0] : v;
    const stationName = (getOne(params.StationName) || '').trim();
    const q = String(queryText || '').trim();
    let tripDays = getOne(params.day) || parseTripDaysFromText(q);

    const saidDaysExplicit = /(\d+)\s*วัน|วันเดียว|หนึ่งวัน|สองวัน|สามวัน|สี่วัน/i.test(q);
    if (!saidDaysExplicit && !getOne(params.day)) {
      tripDays = null;
    } else if (!tripDays) {
      tripDays = null;
    }


    const clearAwait = setCtx(req, 'awaiting_district', 0);
    // อธิบายเหตุผลเมื่อผู้ใช้ถามว่า "ทำไม/เหตุผล/เพราะอะไร"
    {
      const whyAsk = /ทำไม|เหตุผล|เพราะอะไร/.test(q);
      const stCtx = getCtx(req, 'near_station_ctx');
      if (whyAsk && stCtx?.parameters?.station_name) {
        const stName   = stCtx.parameters.station_name;
        const distName = stCtx.parameters.district_name;
        return res.json({
          fulfillmentMessages: [{
            text: { text: [
              `ขออภัยค่ะสามารถแสดงเฉพาะข้อมูลใน "อำเภอเดียวกับสถานี" เพื่อให้ใกล้จริงและตรงพื้นที่ค่ะ ` +
              `(ตอนนี้คืออำเภอ ${distName} ใกล้สถานี ${stName}) ` +
              `ถ้าอยากดูอำเภอข้างเคียง ระบุชื่ออำเภอเพิ่มได้เลยค่ะ`
            ] }
          }],
          outputContexts: [ stCtx ]
        });
      }
    }



    // ----- ตรวจโหมด "เส้นทาง" + ดึงชื่อประเภทเส้นทาง (ถ้ามี) -----
    const routeTypeFromParam =
      (getOne(params.RouteType) || getOne(params.route_type) || getOne(params.Route_Type) || '').trim();

    // รองรับรูป: "เส้นทาง(การ)ท่องเที่ยว [ประเภท] ใกล้สถานี..."
    const mRoute = q.match(/^เส้นทาง(?:การ)?ท่องเที่ยว\s*(?:ประเภท)?\s*(.+?)\s*(?:ใกล้สถานี|แถวสถานี|ใกล้)/i);
    let routeTypeWanted = cleanRouteType(routeTypeFromParam || (mRoute ? mRoute[1] : ''));

    // ย้าย "จำนวนวัน" ออกจากชื่อประเภท (ถ้ามี)
    {
      const m = moveDaysOutOfPhrase(routeTypeWanted, tripDays);
      tripDays = m.days;           // อัปเดตจำนวนวันจากวลี
      routeTypeWanted = m.type;    // ล้างคำจำพวก "2วัน/วันเดียว" ออกจากประเภท
    }
    console.log('[NEAR-STATION ROUTE DEBUG]', {
      stationName, tripDays, routeTypeWanted
    });

    // เป็น “โหมดเส้นทาง” ถ้าพบคำว่าเส้นทาง หรือมี routeTypeWanted
    
    const isRouteQuery = !!routeTypeWanted || /เส้นทาง(?:การ)?ท่องเที่ยว/.test(q);


    // ถ้าเป็นโหมดเส้นทาง → ไม่ดึง category จาก entity แม้ผู้ใช้จะพิมพ์คำกว้าง ๆ อย่าง “กิน/คาเฟ่”
    let categoryFromEntity = (!isRouteQuery ? (getOne(params.category) || '').trim() : '');
    

    try {
      // ----- โหมด 1: ไม่ได้ระบุชื่อสถานี -> แสดงการ์ดสถานีทั้งหมด -----
      if (!stationName) {
        const [rows] = await db.query(`
          SELECT s.Station_ID, s.Station_Name, s.Station_Img,
                d.District_Name, p.Province_Name
          FROM train_station s
          JOIN district d ON s.District_ID = d.District_ID
          JOIN province p ON d.Province_ID = p.Province_ID
          ORDER BY p.Province_Name, d.District_Name, s.Station_Name
        `);

        if (!rows.length) {
          return res.json({ fulfillmentMessages: [{ text: { text: ['ยังไม่มีข้อมูลสถานีรถไฟ'] } }] });
        }

        const pages = chunk(rows, 10);
        const fms = pages.map((page, idx) => ({
          payload: {
            line: {
              type: 'template',
              altText: `เลือกสถานีรถไฟ (${idx + 1}/${pages.length})`,
              template: { type: 'carousel', columns: buildStationColumns(page) }
            }
          }
        }));
        fms.push({ text: { text: ['แตะ “ดูเพิ่มเติม” ที่สถานี แล้วเลือกหมวดหมู่ถัดไป'] } });

        return res.json({
          fulfillmentMessages: fms,
          outputContexts: [ clearAwait ]   // ✅ ล้าง context ค้าง
        });
      }


      // ----- โหมด 2: ระบุชื่อสถานี -> ตั้ง context แล้วแสดงหมวดหมู่หรือ "ประเภทเส้นทาง" -----
    const [stRows] = await db.query(`
      SELECT s.Station_ID, s.Station_Name, s.Station_Img, s.District_ID,
            d.District_Name, p.Province_Name, p.Province_ID
      FROM train_station s
      JOIN district d ON s.District_ID = d.District_ID
      JOIN province p ON d.Province_ID = p.Province_ID
      WHERE s.Station_Name LIKE CONCAT('%', ?, '%')
      ORDER BY FIELD(s.Station_Name, ?) DESC
      LIMIT 1
    `, [stationName, stationName]);

    if (!stRows.length) {
      
      return res.json({
        fulfillmentMessages: [ { text: { text: [`ไม่พบสถานีชื่อ ${stationName}`] } } ],
        outputContexts: [ nearCtx, clearAwait /* อื่น ๆ ถ้ามี */ ]
      });
    }
    

    const st = stRows[0];

    // ✅ เก็บ context ของสถานี (ใช้ซ้ำได้ทั้งโหมดหมวดหมู่ และโหมดเส้นทาง)
    const nearCtx = {
      name: ctxName(req, 'near_station_ctx'),
      lifespanCount: 5,
      parameters: {
        station_id: String(st.Station_ID),
        station_name: st.Station_Name,
        district_id: String(st.District_ID),
        district_name: st.District_Name,
        province_name: st.Province_Name,
        trip_days: tripDays || null
      }
    };

    // ============== PRIORITY A: โหมด "เส้นทางใกล้สถานี..." ==============
    if (isRouteQuery) {
      // ถ้าไม่มี routeType จากข้อความ "และ" ข้อความรอบนี้พูดถึง 'ใกล้สถานี' → ห้ามดึงจาก context
      const mentionsStation = /(?:ใกล้สถานี|แถวสถานี)/.test(q);
      if (!routeTypeWanted) {
        if (!mentionsStation) {
          const ctx = getCtx(req, 'route_area_ctx');
          routeTypeWanted = cleanRouteType(ctx?.parameters?.Route_Type || '');
        } else {
          // ผู้ใช้ถามใกล้สถานีแต่ไม่ได้บอกประเภท → บังคับให้ขึ้นรายการ "ประเภทเส้นทาง" ให้เลือก
          routeTypeWanted = '';
        }
      }

      // ยังไม่ได้ประเภท → โชว์ “ประเภทเส้นทางที่มีในพื้นที่สถานี”
      if (!routeTypeWanted) {
        let typeSql = `
          SELECT DISTINCT rt.RType_ID, rt.RType_Name, rt.Rtype_img
          FROM route_type rt
          JOIN route r             ON r.RType_ID    = rt.RType_ID
          JOIN route_attraction ra ON ra.Route_ID   = r.Route_ID
          JOIN attraction a        ON a.Attraction_ID = ra.Attraction_ID
          JOIN district d          ON d.District_ID = a.District_ID
          WHERE d.District_ID = ?
        `;
        let typeVals = [st.District_ID];

        if (tripDays) { 
          typeSql += ` AND r.Trip_Days = ?`;
          typeVals.push(tripDays);
        }
        typeSql += ` ORDER BY rt.RType_ID ASC`;
        
        let [types] = await db.query(typeSql, typeVals);

        // if (!types.length) {
        //   typeSql = `
        //     SELECT DISTINCT rt.RType_ID, rt.RType_Name, rt.Rtype_img
        //     FROM route_type rt
        //     JOIN route r             ON r.RType_ID    = rt.RType_ID
        //     JOIN route_attraction ra ON ra.Route_ID   = r.Route_ID
        //     JOIN attraction a        ON a.Attraction_ID = ra.Attraction_ID
        //     JOIN district d          ON d.District_ID = a.District_ID
        //     WHERE d.Province_ID = ?
        //   `;
        //   typeVals = [st.Province_ID];
          
        //   if (tripDays) { 
        //     typeSql += ` AND r.Trip_Days = ?`;
        //     typeVals.push(tripDays);
        //   }
        //   typeSql += ` ORDER BY rt.RType_ID ASC`;

        //   [types] = await db.query(typeSql, typeVals);
        // }

        if (!types.length) {
          return res.json({
            fulfillmentMessages: [{ text: { text: [`ยังไม่พบ “ประเภทเส้นทาง” ใกล้สถานี ${st.Station_Name}`] } }],
            outputContexts: [nearCtx]
          });
        }

        const bubbles = buildRouteTypeBubbles(types, st.Province_Name, st.District_Name, tripDays);
        return res.json({
          fulfillmentMessages: [{
            payload: {
              line: {
                type: "flex",
                altText: `เลือกประเภทเส้นทาง ใกล้สถานี${st.Station_Name}`,
                contents: { type: "carousel", contents: bubbles }
              }
            }
          }],
          outputContexts: [
            nearCtx,
            {
              name: ctxName(req, 'route_area_ctx'),
              lifespanCount: 5,
              parameters: {
                province_name: st.Province_Name || '',
                district_name: st.District_Name || '',
                trip_days: saidDaysExplicit ? (tripDays || null) : null
              }
            }
          ]
        });
      }

      // ----- มีประเภทแล้ว → ลิสต์ “เส้นทาง” ในอำเภอของสถานี (ไม่เจอค่อยขยายเป็นทั้งจังหวัด)
      let sql = `
        SELECT DISTINCT r.Route_ID, r.Route_Name, r.Description_Route, r.Route_Img, r.Trip_Days,
                        rt.RType_Name
        FROM route r
        JOIN route_type rt       ON r.RType_ID    = rt.RType_ID
        JOIN route_attraction ra ON r.Route_ID    = ra.Route_ID
        JOIN attraction a        ON ra.Attraction_ID = a.Attraction_ID
        JOIN district d          ON a.District_ID = d.District_ID
        WHERE rt.RType_Name LIKE CONCAT('%', ?, '%')
          AND d.District_ID = ?
      `;
      let vals = [routeTypeWanted, st.District_ID];

      if (tripDays) { 
        sql += ` AND r.Trip_Days = ?`;
        vals.push(tripDays);
      }

      sql += ` ORDER BY r.Route_ID DESC LIMIT 30`;
      let [routes] = await db.query(sql, vals);

      // if (!routes.length) {
      //   sql = `
      //     SELECT DISTINCT r.Route_ID, r.Route_Name, r.Description_Route, r.Route_Img, r.Trip_Days,
      //                     rt.RType_Name
      //     FROM route r
      //     JOIN route_type rt       ON r.RType_ID    = rt.RType_ID
      //     JOIN route_attraction ra ON r.Route_ID    = ra.Route_ID
      //     JOIN attraction a        ON ra.Attraction_ID = a.Attraction_ID
      //     JOIN district d          ON a.District_ID = d.District_ID
      //     WHERE rt.RType_Name LIKE CONCAT('%', ?, '%')
      //       AND d.Province_ID = ?
      //   `;
      //   vals = [routeTypeWanted, st.Province_ID];

      //   if (tripDays) {
      //     sql += ` AND r.Trip_Days = ?`;
      //     vals.push(tripDays);
      //   }

      //   sql += ` ORDER BY r.Route_ID DESC LIMIT 30`;
      //   [routes] = await db.query(sql, vals);
      // }

      if (!routes.length) {
        return res.json({
          fulfillmentMessages: [{ text: { text: [`ยังไม่พบเส้นทางประเภท "${routeTypeWanted}" ใกล้สถานี ${st.Station_Name}`] } }],
          outputContexts: [nearCtx]
        });
      }

      const bubbles = routes.map(r => {
        const clean = String(r.Route_Img || '').replace(/^\/+/, '').trim();
        const imageUrl = `${BASE_URL}/uploads/${encodeURIComponent(clean)}` || FALLBACK_ROUTE_IMG;
        return {
          type: "bubble",
          hero: { type: "image", url: imageUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
          body: {
            type: "box", layout: "vertical", contents: [
              { type: "text", text: r.Route_Name, weight: "bold", size: "lg", wrap: true },
              { type: "text", text: r.RType_Name || "-", size: "sm", color: "#2f3e5c", wrap: true },
              { type: "text", text: r.Description_Route || "-", size: "sm", color: "#555555", wrap: true }
            ]
          },
          footer: {
            type: "box", layout: "vertical", contents: [
              { type: "button", style: "primary",
                action: { type: "message", label: "ดูเพิ่มเติม", text: `RouteDetail ${r.Route_ID}` } }
            ]
          }
        };
      });

      return res.json({
        fulfillmentMessages: [{
          payload: {
            line: {
              type: "flex",
              altText: `เส้นทาง (${routeTypeWanted}) ใกล้สถานี${st.Station_Name}`,
              contents: { type: "carousel", contents: bubbles }
            }
          }
        }],
        outputContexts: [
          nearCtx,
          {
            name: ctxName(req, 'route_area_ctx'),
            lifespanCount: 5,
            parameters: {
              province_name: st.Province_Name || '',
              district_name: st.District_Name || '',
              Route_Type: routeTypeWanted,
              trip_days: saidDaysExplicit ? (tripDays || null) : null
            }
          }
        ]
      });
    }
    

        // ===== ถ้าผู้ใช้พิมพ์ "(หมวดหมู่)ใกล้สถานี..." =====
    // 1) จับหลังคำบอกหมวดโดยตรง เพื่อกันข้อความทั่วไป เช่น "ขอที่เที่ยว"
    let m = q.match(/^(?:ขอ\s*)?(?:ที่เที่ยว|หมวด(?:หมู่)?)\s*(.+?)\s*ใกล้สถานี/i);

    // 2) fallback ทั่วไป แต่กันคำว่า "เส้นทางท่องเที่ยว" ไม่ให้โดนจับเป็นหมวด
    if (!m) m = q.match(/^(?!เส้นทาง(?:การ)?ท่องเที่ยว)(.+?)\s*ใกล้สถานี/i);

    let category = categoryFromEntity || (m ? m[1] : '').trim();

    category = category
    .replace(/^(ขอ|หา|มี|อยาก(?:ไป)?|ช่วย(?:แนะนำ)?|แนะนำ)\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

    // กันกรณีเผลอจับ "เส้นทางท่องเที่ยว" มาเป็นหมวด
    if (/^เส้นทาง(?:การ)?ท่องเที่ยว$/i.test(category)) {
      category = '';
    }

    // 3) normalize และกัน "คำทั่วไป" ไม่ให้นับเป็นหมวด
    category = category.replace(/^ขอ\s*/, '').replace(/\s{2,}/g, ' ').trim();
    const GENERIC_CATS = new Set([
      'ที่เที่ยว','เที่ยว','สถานที่','สถานที่ท่องเที่ยว','ที่ท่องเที่ยว','แหล่งท่องเที่ยว',
      'ขอที่เที่ยว','หาที่เที่ยว','มีที่เที่ยว','อยากเที่ยว','อยากได้ที่เที่ยว','อยากไปเที่ยว','ขอสถานที่ท่องเที่ยวในหาดใหญ่'
    ]);

    const catNoSpace = category.replace(/\s+/g, '');
    const genericNoSpace = ['หาที่เที่ยว','มีที่เที่ยว','อยากเที่ยว','อยากได้ที่เที่ยว','อยากไปเที่ยว']
      .some(s => catNoSpace.includes(s.replace(/\s+/g,'')));

    if (GENERIC_CATS.has(category) || genericNoSpace) category = '';
        
    if (category && stationName) {
        
        // ดึงอำเภอของสถานีจากฐานข้อมูล
        const [locRows] = await db.query(`
          SELECT d.District_Name, p.Province_Name
          FROM train_station s
          JOIN district d ON s.District_ID = d.District_ID
          JOIN province p ON d.Province_ID = p.Province_ID
          WHERE s.Station_Name LIKE CONCAT('%', ?, '%')
          LIMIT 1
        `, [stationName]);

        if (!locRows.length) {
          return res.json({ fulfillmentMessages: [{ text: { text: [`ไม่พบข้อมูลสถานี ${stationName}`] } }] });
        }

        const { District_Name, Province_Name } = locRows[0];

        // ดึงสถานที่ในอำเภอเดียวกัน + หมวดที่ระบุ
        const [rows] = await db.query(`
          SELECT a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
          FROM attraction a
          JOIN category c ON a.Category_ID = c.Category_ID
          JOIN district d ON a.District_ID = d.District_ID
          JOIN province p ON d.Province_ID = p.Province_ID
          WHERE c.Category_Name LIKE CONCAT('%', ?, '%')
            AND d.District_Name LIKE CONCAT('%', ?, '%')
          ORDER BY a.Attraction_ID ASC
          LIMIT 10
        `, [category, District_Name]);

        if (!rows.length) {
          return res.json({
            fulfillmentMessages: [
              { text: { text: [`ยังไม่พบหมวด "${category}" ใกล้สถานี${stationName}`] } }
            ]
          });
        }

        // สร้างการ์ด carousel แสดงสถานที่ในอำเภอนั้น
        return res.json({
          fulfillmentMessages: [{
            payload: {
              line: {
                type: 'template',
                altText: `${category} ใกล้สถานี${stationName} (อ.${District_Name} จ.${Province_Name})`,
                template: { type: 'carousel', columns: buildColumns(rows) }
              }
            }
          }]
        });
      }


    // ============== B) โหมดปกติ (หมวดหมู่สถานที่ใกล้สถานี) ==============
    /**
     * (โค้ดเดิมของคุณ) ดึงหมวดหมู่ที่มีจริงในอำเภอ ถ้าไม่เจอให้ fallback ไปจังหวัด
     * แล้วใช้ buildCategoryFlexBubbles แสดง
     */
    let catSql = `
      SELECT
        c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order,
        COUNT(*) AS AttrCount
      FROM attraction a
      JOIN category c ON a.Category_ID = c.Category_ID
      WHERE a.District_ID = ?
      GROUP BY c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order
      HAVING COUNT(*) > 0
      ORDER BY c.Sort_Order ASC, c.Category_Name ASC
      LIMIT 20
    `;
    let catVals = [st.District_ID];
    let [cats] = await db.query(catSql, catVals);

    // if (!cats.length) {
    //   catSql = `
    //     SELECT
    //       c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order,
    //       COUNT(*) AS AttrCount
    //     FROM attraction a
    //     JOIN category c ON a.Category_ID = c.Category_ID
    //     JOIN district d ON a.District_ID = d.District_ID
    //     WHERE d.Province_ID = ?
    //     GROUP BY c.Category_ID, c.Category_Name, c.Category_Img, c.Sort_Order
    //     HAVING COUNT(*) > 0
    //     ORDER BY c.Sort_Order ASC, c.Category_Name ASC
    //     LIMIT 20
    //   `;
    //   catVals = [st.Province_ID];
    //   [cats] = await db.query(catSql, catVals);
    // }

    if (!cats.length) {
      return res.json({
        fulfillmentMessages: [{ text: { text: [`ยังไม่พบหมวดหมู่ที่มีสถานที่ ใกล้สถานี ${st.Station_Name}`] } }],
        outputContexts: [nearCtx]
      });
    }

    const bubbles = buildCategoryFlexBubbles(cats, st.Province_Name, st.District_Name);
    return res.json({
      fulfillmentMessages: [{
        payload: {
          line: {
            type: "flex",
            altText: `เลือกหมวดที่เที่ยว ใกล้สถานี${st.Station_Name}`,
            contents: { type: "carousel", contents: bubbles }
          }
        }
      }],
      outputContexts: [nearCtx]
    });



    } catch (e) {
      console.error('[AttractionsNearStation] error:', e);
      return res.json({ fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงข้อมูลสถานีรถไฟ'] } }] });
    }
  }


    if (intentName === 'FindAttractionByName') {
  const getOne = v => Array.isArray(v) ? v[0] : v;

  

  // ✅ รองรับหลายคีย์จาก DF: AttractionName / attraction_name / attraction
  let name =
    (getOne(params.AttractionName) ||
     getOne(params.attraction_name) ||
     getOne(params.attraction) ||
     '').trim();

  // ถ้า DF ไม่แมปชื่อมา ให้ลองดึงจากข้อความ และตัด "รายละเอียด" ออก
  if (!name && queryText) {
    const q = String(queryText).trim();
    const m = q.match(/^รายละเอียด\s*(.+)$/i);
    name = (m ? m[1] : q).trim();
  }

  if (!name) {
    return res.json({ fulfillmentMessages: [{ text: { text: ['พิมพ์ชื่อสถานที่ที่ต้องการดูข้อมูลได้เลยค่ะ'] } }] });
  }

  try {
    const rows = await searchAttractionsLoose(db, name, 10);
    if (!rows.length) {
      return res.json({ fulfillmentMessages: [{ text: { text: ['ยังไม่พบสถานที่ชื่อนี้ ลองพิมพ์ใหม่อีกครั้งค่ะ'] } }] });
    }
    if (rows.length === 1) {
      const only = rows[0];
      req.body.queryResult.parameters = { ...params, AttractionName: only.Attraction_Name };
      intentName = 'AttractionDetail'; // ปล่อยให้ไปต่อที่บล็อกด้านล่าง
    } else {
      return res.json({
        fulfillmentMessages: [{
          payload: { line: { type: 'template', altText: 'เลือกสถานที่ที่ต้องการ',
            template: { type: 'carousel', columns: buildAttractionListColumns(rows) } } }
        }]
      });
    }
  } catch (e) {
    console.error('[FindAttractionByName] error:', e);
    return res.json({ fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการค้นหาสถานที่'] } }] });
  }
}




    // ====== Intent: รายละเอียดสถานที่ ======
  if (intentName === 'AttractionDetail') {
    const getOne = v => Array.isArray(v) ? v[0] : v;

    let name = (
      getOne(params.AttractionName) ||
      getOne(params.attraction) ||
      getOne(params.attraction_name) || ""
    ).trim();
    if (!name && queryText) {
      const m = String(queryText).match(/รายละเอียด\s+(.+)/i);
      if (m) name = m[1].trim();
    }

    if (!name) {
      return res.json({ fulfillmentMessages: [{ text: { text: ["กรุณาระบุชื่อสถานที่"] } }] });
    }

    try {
      const [rows] = await db.query(`
        SELECT Attraction_Name, Attraction_Description, Attraction_Img, Contact_Info,
              Latitude, Longitude            
        FROM attraction
        WHERE Attraction_Name LIKE CONCAT('%', ?, '%')
        ORDER BY LENGTH(Attraction_Name) ASC
        LIMIT 1
      `, [name]);

      if (!rows.length) {
        return res.json({ fulfillmentMessages: [{ text: { text: ["ไม่พบรายละเอียดสถานที่ที่ขอ"] } }] });
      }

      const r = rows[0];

      const lat = Number(r.Latitude);
      const lng = Number(r.Longitude);
      const hasCoord = Number.isFinite(lat) && Number.isFinite(lng);

      // ลิงก์นำทางไปยังพิกัดนั้น (เปิดได้ทั้งแอปหรือเว็บ)
      const navUrl = hasCoord
        ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.Attraction_Name)}`;

      // ทำความสะอาด/จำกัดความยาว
      const cleanDesc = String(r.Attraction_Description || '-')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')  // <— เพิ่ม: ลบ control chars
        .substring(0, 300);
      const cleanTel  = String(r.Contact_Info || '').replace(/[^\d+]/g, '');

      // ⬇️⬇️⬇️ เพิ่ม "fallback image" ตรงนี้
      const FALLBACK_IMG = 'https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_1_cafe.png';
      const rawImg = toImageUrl(r.Attraction_Img);

      async function canUseImage(url) {
        try {
          const r = await fetch(url, { method: 'HEAD' });
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          return r.ok && ct.startsWith('image/');
        } catch {
          return false;
        }
      }

      let heroUrl = FALLBACK_IMG;
      if (rawImg && /^https?:\/\//i.test(rawImg) && await canUseImage(rawImg)) {
        heroUrl = rawImg;
      }


      const imageBlock = {
        type: "image",
        url: heroUrl,            // ใช้ heroUrl เดิม
        size: "full",
        aspectRatio: "20:13",    // จะเปลี่ยนเป็น "16:9" ก็ได้ถ้าอยากลอง
        aspectMode: "cover"
      };

      const bubble = {
        type: "bubble",
        // ลบ hero ออกไปชั่วคราว
        body: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            imageBlock,  // 👈 รูปมาเป็น content แรกใน body
            { type: "text", text: r.Attraction_Name || "-", weight: "bold", size: "lg", wrap: true },
            { type: "text", text: cleanDesc, size: "sm", color: "#555555", wrap: true },
            ...(cleanTel ? [{
              type: "box",
              layout: "vertical",
              margin: "md",
              contents: [
                { type: "text", text: "โทร", size: "sm", color: "#888888" },
                { type: "text", text: cleanTel, size: "sm", color: "#333333", wrap: true }
              ]
            }] : [])
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
          {
            type: "button",
            style: "primary",
            color: "#32ca32ff",                     
            action: { type: "uri", label: "นำทาง", uri: navUrl }
          },
          ...(cleanTel ? [{
            type: "button",
            style: "secondary",
            color: "#c4c9c694",               
            action: { type: "uri", label: "โทรเลย", uri: `tel:${cleanTel}` }
          }] : [])
          ]
        }
      };
      

      return res.json({
        fulfillmentMessages: [
          { text: { text: [`รายละเอียด: ${r.Attraction_Name}`] } },
          { payload: { line: { type: "flex", altText: `รายละเอียด: ${r.Attraction_Name}`, contents: bubble } } }
        ]
      });


    } catch (e) {
      console.error('[AttractionDetail] error:', e);
      return res.json({ fulfillmentMessages: [{ text: { text: ["เกิดข้อผิดพลาดในการดึงรายละเอียดสถานที่"] } }] });
    }
  }


    // ====== Intent: UsefulLink (ลิงก์ที่เกี่ยวข้อง) ======
  if (intentName === 'UsefulLink') {
    try {
      const [rows] = await db.query(`
        SELECT U_ID, U_Name, U_Description, U_Link, U_Img
        FROM useful_link
        ORDER BY U_ID ASC
        LIMIT 50
      `);

      if (!rows.length) {
        return res.json({
          fulfillmentMessages: [{ text: { text: ['ยังไม่มีรายการลิงก์ที่เกี่ยวข้อง'] } }]
        });
      }

      // LINE Flex ส่งได้ครั้งละ 10 bubble → chunk รายการ
      const chunk = (arr, size = 10) => {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
      };
      const pages = chunk(rows, 10);

      const fms = pages.map((page, idx) => ({
        payload: {
          line: {
            type: "flex",
            altText: `ลิงก์ที่เกี่ยวข้อง (${idx + 1}/${pages.length})`,
            contents: { type: "carousel", contents: buildUsefulLinkBubbles(page) }
          }
        }
      }));

      return res.json({ fulfillmentMessages: fms });

    } catch (e) {
      console.error('[UsefulLink] error:', e);
      return res.json({
        fulfillmentMessages: [{ text: { text: ['เกิดข้อผิดพลาดในการดึงข้อมูลลิงก์ที่เกี่ยวข้อง'] } }]
      });
    }
  }

// ====== Intent: สถานที่ "แนะนำ" (โหมดใกล้ฉันแบบ "ถามอำเภอ") ======
if (intentName === 'ListRecommendedAttractions') {
  try {
    const getOne = v => Array.isArray(v) ? v[0] : v;

    const rawCategory = getOne(params.category) || '';
    let province = (getOne(params.Province) || getOne(params.province) || '').trim();
    let district = (getOne(params.District) || getOne(params.district) || '').trim();

    // ใกล้ฉัน?
    const nearMe = wantNearMe(queryText);

    if (nearMe) {
      province = '';
      district = '';
    }



    // ล้างคำนำหน้า "อำเภอ/เขต/เทศบาล"
    district = stripDistrictPrefix(district);

    // เดาอำเภอจากข้อความ ถ้ายังว่าง
    async function resolveDistrictFromText(text, provinceHint) {
      const t = (text || '').replace(/\s+/g, '');
      let sql = `SELECT d.District_Name
                 FROM district d
                 JOIN province p ON d.Province_ID = p.Province_ID
                 WHERE REPLACE(d.District_Name,' ','') <> ''`;
      const vals = [];
      if (provinceHint) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; vals.push(provinceHint); }
      const [all] = await db.query(sql, vals);
      const hit = (all || []).find(row => t.includes(stripDistrictPrefix(row.District_Name)));
      return hit ? stripDistrictPrefix(hit.District_Name) : '';
    }
    if (!district) {
      district = await resolveDistrictFromText(queryText, province);
    }

    // ===== Helper: คาร์รูเซล "หมวดหมู่" =====
    function buildCategoryColumns(rows, areaLabel='ในพื้นที่') {
      return rows.slice(0, 10).map(row => {
        const img = toImageUrl(row.Category_Img);
        const title = row.Category_Name?.substring(0, 40) || 'หมวดหมู่';
        const text  = `มีสถานที่แนะนำ ${row.AttrCount} แห่ง ${areaLabel}`.substring(0, 60);
        const nextMsg =
          province && district
            ? `สถานที่แนะนำ หมวด ${row.Category_Name} ในอำเภอ${district} จังหวัด${province}`
            : province
              ? `สถานที่แนะนำ หมวด ${row.Category_Name} ในจังหวัด${province}`
              : district
                ? `สถานที่แนะนำ หมวด ${row.Category_Name} ในอำเภอ${district}`
                : `สถานที่แนะนำ หมวด ${row.Category_Name}`;
        return {
          thumbnailImageUrl: img,
          title,
          text,
          actions: [{ type: 'message', label: 'ดูสถานที่ในหมวดนี้', text: nextMsg }]
        };
      });
    }

    // ===== โหมด "ใกล้ฉัน" (ไม่ใช้พิกัด, ขออำเภอ) =====
    if (nearMe) {
      const tips = (province && province.trim())
        ? `กรุณาพิมพ์ชื่ออำเภอในจังหวัด${province} (เช่น อำเภอเมือง, ควนขนุน)`
        : `กรุณาพิมพ์ชื่ออำเภอที่คุณอยู่ (เช่น อำเภอเมืองหาดใหญ่, ควนขนุน)`;

      return res.json({
        fulfillmentMessages: [{ text: { text: [tips] } }],
        outputContexts: [
          setCtx(req, 'near_station_ctx', 0),
          setCtx(req, 'awaiting_district', 3, {
            category: rawCategory || '',
            asked_category: rawCategory || '',
            Province: '',
            mode: 'recommend'
          })
        ]
      });
    }

    // ===== โหมด "แสดงหมวดหมู่ก่อน" (มีจังหวัด/อำเภอ แต่ยังไม่ระบุหมวด) =====
    if (!rawCategory && (province?.trim() || district?.trim())) {
      let catSql = `
        SELECT c.Category_ID, c.Category_Name, c.Category_Img, COUNT(*) AS AttrCount
        FROM attraction a
        JOIN category c  ON a.Category_ID = c.Category_ID
        JOIN district d  ON a.District_ID = d.District_ID
        JOIN province p  ON d.Province_ID = p.Province_ID
        WHERE a.\`Reccomendation_Attraction\` = 1
      `;
      const catVals = [];
      if (province?.trim()) { catSql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; catVals.push(province); }
      if (district?.trim()) { catSql += ` AND d.District_Name LIKE CONCAT('%', ?, '%')`; catVals.push(district); }
      catSql += `
        GROUP BY c.Category_ID, c.Category_Name, c.Category_Img
        ORDER BY AttrCount DESC, c.Category_Name ASC
        LIMIT 20
      `;

      const [catRows] = await db.query(catSql, catVals);
      if (!catRows.length) {
        return res.json({ fulfillmentMessages: [{ text: { text: ['ยังไม่พบหมวดหมู่ของสถานที่ “แนะนำ” ในพื้นที่นี้'] } }] });
      }

      const areaLabel =
        province && district ? `ในอำเภอ${district} จังหวัด${province}` :
        province ? `ในจังหวัด${province}` :
        district ? `ในอำเภอ${district}` : 'ในพื้นที่';

      const columns = buildCategoryColumns(catRows, areaLabel);
      return res.json({
        fulfillmentMessages: [{
          payload: {
            line: {
              type: 'template',
              altText: `หมวดหมู่สถานที่แนะนำ ${areaLabel}`,
              template: { type: 'carousel', imageAspectRatio: 'rectangle', imageSize: 'cover', columns }
            }
          }
        }]
      });
    }

    // ===== โหมดปกติ (ลิสต์สถานที่ตามเงื่อนไข) =====
    let sql = `
      SELECT a.Attraction_Name, a.Attraction_Description, a.Attraction_Img
      FROM attraction a
      JOIN category c ON a.Category_ID = c.Category_ID
      JOIN district d ON a.District_ID = d.District_ID
      JOIN province p ON d.Province_ID = p.Province_ID
      WHERE a.\`Reccomendation_Attraction\` = 1
    `;
    const vals = [];
    if (rawCategory) { sql += ` AND c.Category_Name LIKE CONCAT('%', ?, '%')`; vals.push(rawCategory); }
    if (province?.trim()) { sql += ` AND p.Province_Name LIKE CONCAT('%', ?, '%')`; vals.push(province); }
    if (district?.trim()) { sql += ` AND d.District_Name LIKE CONCAT('%', ?, '%')`; vals.push(district); }

    const [rows] = await db.query(sql, vals);
    if (!rows.length) {
      return res.json({ fulfillmentMessages: [{ text: { text: ['ยังไม่พบสถานที่ “แนะนำ” ตามเงื่อนไขที่ให้มา'] } }] });
    }

    const columns = rows.slice(0, 10).map(r => ({
      thumbnailImageUrl: toImageUrl(r.Attraction_Img),
      title: (r.Attraction_Name || '').substring(0, 40),
      text: (r.Attraction_Description || 'สถานที่แนะนำ').substring(0, 60),
      actions: [{ type: 'message', label: 'ดูรายละเอียด', text: `รายละเอียด ${r.Attraction_Name}` }]
    }));

    return res.json({
      fulfillmentMessages: [{
        payload: {
          line: {
            type: 'template',
            altText: 'สถานที่ท่องเที่ยวแนะนำ',
            template: { type: 'carousel', imageAspectRatio: 'rectangle', imageSize: 'cover', columns }
          }
        }
      }]
    });

  } catch (err) {
    console.error('[ListRecommendedAttractions] error:', err);
    return res.json({
      fulfillmentMessages: [{ text: { text: ['ขออภัย ระบบขัดข้องชั่วคราว ลองพิมพ์อีกครั้งได้เลยนะคะ'] } }]
    });
  }
}




  // ====== Intent อื่น ๆ ======
  return res.json({
    fulfillmentMessages: [
      { text: { text: ['ฉันยังไม่เข้าใจคำถามนี้'] } }
    ]
  });

});

module.exports = router;