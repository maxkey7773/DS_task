// index.js — DomStroy Task Management (Replit-ready)
const express = require('express');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const FormData = require('form-data');

const app = express();
const db = new Database('database.db');
const PORT = process.env.PORT || 3000;

// Config: set TELEGRAM_BOT_TOKEN in Replit secrets
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PROJECT_URL = process.env.PROJECT_URL || (process.env.REPL_URL ? `https://${process.env.REPL_URL}` : `https://${process.env.REPL_SLUG || 'domstroy'}.${process.env.REPL_OWNER ? process.env.REPL_OWNER + '.repl.co' : 'repl.co'}`);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ensure uploads folder
if(!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, './uploads/'); },
  filename: function (req, file, cb) { cb(null, Date.now() + '_' + file.originalname.replace(/\s+/g,'_')); }
});
const upload = multer({ storage });

// Initialize DB
function initDb(){
  db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE, password TEXT, role TEXT, telegram_id TEXT, points INTEGER DEFAULT 0, theme_color TEXT DEFAULT '#2563eb'
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT, description TEXT, created_by TEXT, deadline TEXT, repeat_type TEXT DEFAULT 'none', is_group INTEGER DEFAULT 0, status TEXT DEFAULT 'Pending', created_at TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS task_members (
    id TEXT PRIMARY KEY, task_id TEXT, user_id TEXT, status TEXT DEFAULT 'pending'
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS chat (
    id TEXT PRIMARY KEY, task_id TEXT, sender_id TEXT, message TEXT, file_path TEXT, file_name TEXT, sent_at TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();

  const s = db.prepare('SELECT value FROM settings WHERE key = ?').get('daily_digest');
  if(!s) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('daily_digest','on');
}
initDb();

// Telegram helpers
async function sendTelegram(chatId, text) {
  if(!BOT_TOKEN || !chatId) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    return await axios.post(url, { chat_id: chatId, text, parse_mode:'HTML' });
  } catch(e) {
    console.error('Telegram send error:', e.response ? e.response.data : e.message);
  }
}
async function sendTelegramDocument(chatId, filePath, caption) {
  if(!BOT_TOKEN || !chatId) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    if(caption) form.append('caption', caption);
    form.append('document', fs.createReadStream(filePath));
    const headers = form.getHeaders();
    return await axios.post(url, form, { headers });
  } catch(e) {
    console.error('Telegram document error:', e.response ? e.response.data : e.message);
  }
}

// util
function nowISO(){ return new Date().toISOString(); }

// ========== AUTH & USERS ==========
app.post('/api/login', (req,res) => {
  const { phone, password } = req.body;
  if(!phone || !password) return res.status(400).json({ error: 'Phone va parol kerak' });
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if(!user) return res.status(401).json({ error: 'Noto`g`ri login yoki parol' });
  const ok = bcrypt.compareSync(password, user.password);
  if(!ok) return res.status(401).json({ error: 'Noto`g`ri login yoki parol' });
  delete user.password;
  res.json(user);
});

app.get('/api/users', (req,res) => {
  const rows = db.prepare('SELECT id,name,phone,role,telegram_id,points,theme_color FROM users').all();
  res.json(rows);
});

app.post('/api/users', (req,res) => {
  const { name, phone, password, role, telegram_id } = req.body;
  if(!name || !phone || !password || !role) return res.status(400).json({ error:'data yetarli emas' });
  try {
    const id = uuidv4();
    const hashed = bcrypt.hashSync(password,8);
    db.prepare('INSERT INTO users (id,name,phone,password,role,telegram_id) VALUES (?,?,?,?,?,?)').run(id,name,phone,hashed,role,telegram_id||'');
    const user = db.prepare('SELECT id,name,phone,role,telegram_id,points,theme_color FROM users WHERE id = ?').get(id);
    res.json(user);
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// Manager adds worker by phone (returns password)
app.post('/api/add-worker', (req,res) => {
  const { name, phone, managerId } = req.body;
  if(!name || !phone) return res.status(400).json({ error:'name va phone kerak' });
  const rawPass = Math.random().toString(36).slice(-8) + Math.floor(Math.random()*90+10);
  const id = uuidv4(); const hashed = bcrypt.hashSync(rawPass,8);
  try {
    db.prepare('INSERT INTO users (id,name,phone,password,role) VALUES (?,?,?,?,?)').run(id,name,phone,hashed,'Employee');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const msg = `Assalomu alaykum ${name}!\nSiz DomStroy tizimiga qo'shildingiz.\nLogin: ${phone}\nParol: ${rawPass}\nIlovaga kirish: ${PROJECT_URL}`;
    if(user.telegram_id) sendTelegram(user.telegram_id, msg);
    res.json({ id: user.id, phone: user.phone, password: rawPass });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ========== TASKS ==========
app.post('/api/task', (req,res) => {
  // create new task (can be group)
  const { title, description, created_by, deadline, repeat_type, members } = req.body;
  if(!title || !created_by || !deadline || !members || !members.length) return res.status(400).json({ error: 'majburiy maydonlar' });
  const id = uuidv4(); const created_at = nowISO();
  const is_group = members.length > 1 ? 1 : 0;
  db.prepare('INSERT INTO tasks (id,title,description,created_by,deadline,repeat_type,is_group,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,title,description||'',created_by,deadline,repeat_type||'none',is_group,created_at);
  const insertMem = db.prepare('INSERT INTO task_members (id,task_id,user_id,status) VALUES (?,?,?,?)');
  members.forEach(uId => insertMem.run(uuidv4(), id, uId, 'pending'));
  // notify members via Telegram
  members.forEach(uId => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uId);
    const creator = db.prepare('SELECT name FROM users WHERE id = ?').get(created_by);
    const text = `Yangi vazifa: ${title}\nTayinlagan: ${creator ? creator.name : 'System'}\nMuddat: ${deadline}\n${PROJECT_URL}`;
    if(u && u.telegram_id) sendTelegram(u.telegram_id, text);
  });
  res.json({ ok:true, id });
});

app.get('/api/tasks', (req,res) => {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  // attach members array
  const result = rows.map(t => {
    const members = db.prepare('SELECT tm.user_id, tm.status, u.name FROM task_members tm LEFT JOIN users u ON u.id=tm.user_id WHERE tm.task_id=?').all(t.id);
    return {...t, members};
  });
  res.json(result);
});

app.get('/api/task/:id', (req,res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if(!t) return res.status(404).json({ error:'not found' });
  const members = db.prepare('SELECT tm.user_id, tm.status, u.name FROM task_members tm LEFT JOIN users u ON u.id=tm.user_id WHERE tm.task_id=?').all(req.params.id);
  const chat = db.prepare('SELECT * FROM chat WHERE task_id = ? ORDER BY sent_at ASC').all(req.params.id);
  res.json({ task:t, members, chat });
});

// update member status (user marks their part done)
app.put('/api/task/:id/member-status', (req,res) => {
  const taskId = req.params.id; const { userId, status } = req.body;
  if(!userId || !status) return res.status(400).json({ error:'userId va status kerak' });
  db.prepare('UPDATE task_members SET status = ? WHERE task_id = ? AND user_id = ?').run(status, taskId, userId);
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM task_members WHERE task_id = ? AND status != 'done'`).get(taskId).c;
  if(pending === 0) {
    // all done => mark task Done and create next occurrence if repeat_type != none
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('Done', taskId);
    if(t.repeat_type && t.repeat_type !== 'none') {
      // compute next deadline
      const cur = new Date(t.deadline);
      let next = new Date(cur);
      if(t.repeat_type === 'daily') next.setDate(cur.getDate()+1);
      if(t.repeat_type === 'weekly') next.setDate(cur.getDate()+7);
      if(t.repeat_type === 'monthly') next.setMonth(cur.getMonth()+1);
      const nid = uuidv4();
      db.prepare('INSERT INTO tasks (id,title,description,created_by,deadline,repeat_type,is_group,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(nid, t.title, t.description, t.created_by, next.toISOString().slice(0,10), t.repeat_type, t.is_group, nowISO());
      // copy members
      const members = db.prepare('SELECT user_id FROM task_members WHERE task_id = ?').all(taskId);
      members.forEach(m => db.prepare('INSERT INTO task_members (id,task_id,user_id,status) VALUES (?,?,?,?)').run(uuidv4(), nid, m.user_id, 'pending'));
    }
  }
  res.json({ ok:true });
});

// Delete task
app.delete('/api/task/:id', (req,res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM chat WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM task_members WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  res.json({ ok:true });
});

// ========== CHAT & FILE UPLOAD ==========
app.post('/api/upload/:task_id', upload.single('file'), (req,res) => {
  const taskId = req.params.task_id;
  const { user_id } = req.body;
  const file = req.file;
  const id = uuidv4();
  const now = nowISO();
  db.prepare('INSERT INTO chat (id,task_id,sender_id,message,file_path,file_name,sent_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, taskId, user_id, '', file ? file.path : null, file ? file.originalname : null, now);
  // notify members/creator and forward file via Telegram
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const members = db.prepare('SELECT u.* FROM task_members tm JOIN users u ON u.id=tm.user_id WHERE tm.task_id = ?').all(taskId);
  const creator = db.prepare('SELECT * FROM users WHERE id = ?').get(task.created_by);
  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  const recipients = new Set(members.map(m => m.id)); if(creator) recipients.add(creator.id);
  const text = `${sender ? sender.name : 'Kimdir'} fayl yubordi: ${file.originalname}\nVazifa: ${task.title}`;
  for(const rId of recipients){
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(rId);
    if(u && u.telegram_id) {
      sendTelegram(u.telegram_id, text);
      if(file) sendTelegramDocument(u.telegram_id, file.path, `Fayl: ${file.originalname} — ${task.title}`);
    }
  }
  res.json({ ok:true, file: file ? file.filename : null });
});

app.post('/api/chat/:task_id', (req,res) => {
  const taskId = req.params.task_id;
  const { user_id, message } = req.body;
  const id = uuidv4();
  const now = nowISO();
  db.prepare('INSERT INTO chat (id,task_id,sender_id,message,sent_at) VALUES (?,?,?,?,?)').run(id,taskId,user_id,message||'',now);
  // notify others
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const members = db.prepare('SELECT u.* FROM task_members tm JOIN users u ON u.id=tm.user_id WHERE tm.task_id = ?').all(taskId);
  const creator = db.prepare('SELECT * FROM users WHERE id = ?').get(task.created_by);
  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  const text = `${sender ? sender.name : 'Kimdir'}: ${message}\nVazifa: ${task.title}`;
  const recipients = new Set(members.map(m => m.id)); if(creator) recipients.add(creator.id);
  for(const rId of recipients){
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(rId);
    if(u && u.telegram_id) sendTelegram(u.telegram_id, text);
  }
  res.json({ ok:true });
});

app.get('/api/chat/:task_id', (req,res) => {
  const taskId = req.params.task_id;
  const rows = db.prepare('SELECT * FROM chat WHERE task_id = ? ORDER BY sent_at ASC').all(taskId);
  res.json(rows);
});

// ========== THEME & SETTINGS ==========
app.post('/api/theme', (req,res) => {
  const { userId, color } = req.body;
  if(!userId) return res.status(400).json({ error:'userId kerak' });
  db.prepare('UPDATE users SET theme_color = ? WHERE id = ?').run(color, userId);
  res.json({ ok:true });
});
app.get('/api/theme/:userId', (req,res) => {
  const u = db.prepare('SELECT theme_color FROM users WHERE id = ?').get(req.params.userId);
  res.json(u || { theme_color:'#2563eb' });
});

app.post('/api/settings/digest', (req,res) => {
  const { value } = req.body; if(!value) return res.status(400).json({ error:'value kerak' });
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('daily_digest', value);
  res.json({ ok:true });
});
app.get('/api/settings/digest', (req,res) => {
  const s = db.prepare('SELECT value FROM settings WHERE key = ?').get('daily_digest'); res.json({ value: s ? s.value : 'on' });
});

// ========== CSV EXPORT ==========
app.get('/api/export/tasks', (req,res) => {
  const rows = db.prepare('SELECT t.*, u1.name as created_by_name FROM tasks t LEFT JOIN users u1 ON u1.id=t.created_by').all();
  const csvWriter = createCsvWriter({ path: 'tasks.csv', header: Object.keys(rows[0] || {}).map(k=>({ id:k, title:k })) });
  csvWriter.writeRecords(rows).then(()=> res.download('tasks.csv')).catch(e=> res.status(500).json({ error: String(e) }));
});
app.get('/api/export/leaderboard', (req,res) => {
  const rows = db.prepare('SELECT id,name,phone,role,points FROM users ORDER BY points DESC').all();
  const csvWriter = createCsvWriter({ path: 'leaderboard.csv', header: Object.keys(rows[0] || {}).map(k=>({ id:k, title:k })) });
  csvWriter.writeRecords(rows).then(()=> res.download('leaderboard.csv')).catch(e=> res.status(500).json({ error: String(e) }));
});

// ========== SCHEDULED: Daily digest ==========
cron.schedule('0 4 * * *', async () => {
  // Runs at 04:00 UTC (09:00 Tashkent)
  try {
    const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('daily_digest');
    if(!setting || setting.value !== 'on') return;
    const users = db.prepare('SELECT * FROM users').all();
    for(const u of users){
      if(!u.telegram_id) continue;
      const pending = db.prepare("SELECT COUNT(*) AS c FROM task_members tm JOIN tasks t ON t.id=tm.task_id WHERE tm.user_id = ? AND t.status != 'Done'").get(u.id).c;
      const overdue = db.prepare("SELECT COUNT(*) AS c FROM task_members tm JOIN tasks t ON t.id=tm.task_id WHERE tm.user_id = ? AND date(t.deadline) < date('now') AND t.status != 'Done'").get(u.id).c;
      const points = u.points || 0;
      const text = `Salom, ${u.name}!\n📋 Bajarilmagan: ${pending}\n❌ Kechikkan: ${overdue}\n💯 Ball: ${points}\n\nPlatforma: ${PROJECT_URL}`;
      await sendTelegram(u.telegram_id, text);
    }
    // Managers summary
    const managers = db.prepare("SELECT * FROM users WHERE role IN ('Manager','Admin')").all();
    for(const m of managers){
      if(!m.telegram_id) continue;
      const pending = db.prepare("SELECT COUNT(*) AS c FROM task_members tm JOIN tasks t ON t.id=tm.task_id WHERE t.status != 'Done'").get().c;
      const overdue = db.prepare("SELECT COUNT(*) AS c FROM task_members tm JOIN tasks t ON t.id=tm.task_id WHERE date(t.deadline) < date('now') AND t.status != 'Done'").get().c;
      const avg = db.prepare("SELECT AVG(points) as a FROM users").get().a || 0;
      const text = `Assalomu alaykum, ${m.name}!\n⏳ Bajarilmagan: ${pending}\n❌ Kechikkan: ${overdue}\n💯 O'rtacha ball: ${Math.round(avg)}\n\nPlatforma: ${PROJECT_URL}`;
      await sendTelegram(m.telegram_id, text);
    }
  } catch(e) { console.error('Daily digest error', e); }
});

// ========== START ==========
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
