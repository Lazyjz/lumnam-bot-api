// //ปัจจุบัน
// const express = require('express');
// const bodyParser = require('body-parser');
// const cors = require('cors');
// require('dotenv').config();
// const path = require('path');

// const app = express();
// const port = 3001;

// const attractionRoute = require('./routes/attraction');
// // const categoryRoute = require('./routes/category');
// //const TourRouteRoute = require('./routes/TourRoute');

// const loggerRoutes = require('./routes/logger');


// app.use(cors());
// app.use(bodyParser.json());
// app.use('/uploads', express.static(path.join(__dirname, '../tourism-admin-main/uploads')));

// app.use((req, res, next) => {
//   res.setHeader('Content-Type', 'application/json; charset=utf-8');
//   next();
// });

// console.log('[BOOT] CONTACT_EMAIL set:', !!process.env.CONTACT_EMAIL);

// // Webhook
// app.use('/webhook', attractionRoute);
// app.use('/log', loggerRoutes);
// // app.use('/webhook', categoryRoute);
// //app.use('/webhook', TourRouteRoute);


// app.listen(port, () => {
//   console.log(`Server is running on port ${port}`);
// });

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();

// ⚠️ แก้จุดที่ 1: ให้ใช้ Port จาก Render ถ้าไม่มีค่อยใช้ 3001
const port = process.env.PORT || 3001; 

// ตรวจสอบว่าไฟล์โค้ดหลักของคุณชื่อ attraction.js และอยู่ในโฟลเดอร์ routes ใช่ไหม
const attractionRoute = require('./routes/attraction'); 
const loggerRoutes = require('./routes/logger');

app.use(cors());
app.use(bodyParser.json());

// ⚠️ แก้จุดที่ 2: Comment บรรทัดนี้ออก เพราะบน Render ไม่มีโฟลเดอร์นี้ 
// และเราดึงรูปจากเว็บจริง (HostAtom) แทนแล้ว
// app.use('/uploads', express.static(path.join(__dirname, '../tourism-admin-main/uploads')));

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

console.log('[BOOT] CONTACT_EMAIL set:', !!process.env.CONTACT_EMAIL);

// Webhook
app.use('/webhook', attractionRoute);
app.use('/log', loggerRoutes);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

