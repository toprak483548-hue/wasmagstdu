require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const webpush = require("web-push");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET en az 32 karakter olmalı ve Render Environment bölümünde tanımlanmalı.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "wss:", "https:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: "draft-7", legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: "draft-7", legacyHeaders: false });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").split(";")[0].trim();
    const allowed = /^(image\/(jpeg|png|webp|gif)|video\/mp4|audio\/(webm|ogg|mpeg|mp4)|application\/pdf|text\/plain|application\/(zip|vnd\.openxmlformats-officedocument\..+))$/i;
    const ok = allowed.test(mime);
    cb(ok ? null : new Error("Bu dosya türüne izin verilmiyor."), ok);
  }
});

const online = new Map(); // userId -> active socket count
const pushReady = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushReady) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(40) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      title VARCHAR(60),
      is_group BOOLEAN DEFAULT FALSE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      role VARCHAR(12) NOT NULL DEFAULT 'member',
      PRIMARY KEY(chat_id, user_id)
    );
    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS role VARCHAR(12) NOT NULL DEFAULT 'member';
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(160) NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_media_id BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE chats c SET created_by=(SELECT cm.user_id FROM chat_members cm WHERE cm.chat_id=c.id ORDER BY cm.joined_at,cm.user_id LIMIT 1)
      WHERE c.is_group=true AND c.created_by IS NULL;
    UPDATE chat_members cm SET role='admin' FROM chats c
      WHERE c.id=cm.chat_id AND c.is_group=true AND c.created_by=cm.user_id AND cm.role='member';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(16) NOT NULL DEFAULT 'text';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id BIGINT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to BIGINT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS media_files (
      id BIGSERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      purpose VARCHAR(16) NOT NULL DEFAULT 'message',
      mime_type VARCHAR(120) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      emoji VARCHAR(16) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(message_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS statuses (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      caption VARCHAR(500) NOT NULL DEFAULT '',
      media_id BIGINT REFERENCES media_files(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS messages_chat_sender_idx ON messages(chat_id,sender_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS statuses_expiry_idx ON statuses(expires_at DESC);
    CREATE INDEX IF NOT EXISTS media_owner_idx ON media_files(owner_id);
  `);
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d", issuer: "mesaj-app" });
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Oturum geçersiz. Yeniden giriş yap." });
  }
}
async function isMember(chatId, userId) {
  const r = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, userId]);
  return r.rowCount > 0;
}
async function memberIds(chatId) {
  const r = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
  return r.rows.map(x => Number(x.user_id));
}
async function pushUser(userId, payload) {
  if (!pushReady) return;
  const r = await pool.query("SELECT id,subscription FROM push_subscriptions WHERE user_id=$1", [userId]);
  await Promise.all(r.rows.map(async row => {
    try { await webpush.sendNotification(row.subscription, JSON.stringify(payload)); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [row.id]);
    }
  }));
}
function cleanUser(row) {
  return {
    id: Number(row.id), username: row.username, display_name: row.display_name,
    bio: row.bio || "", avatar_url: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null,
    last_seen: row.last_seen || null
  };
}
function messageQueryExtra() {
  return `
    SELECT m.id,m.chat_id,m.sender_id,m.body,m.message_type,m.media_id,m.file_name,
      m.reply_to,m.edited_at,m.deleted_at,m.created_at,u.username,u.display_name,
      (SELECT json_agg(json_build_object('emoji',r.emoji,'count',r.cnt,'mine',r.mine))
       FROM (SELECT emoji,COUNT(*)::int AS cnt,BOOL_OR(user_id=$2) AS mine
             FROM message_reactions WHERE message_id=m.id GROUP BY emoji) r) AS reactions,
      (SELECT json_build_object('id',rm.id,'body',CASE WHEN rm.deleted_at IS NULL THEN rm.body ELSE 'Mesaj silindi' END,
        'sender_name',ru.display_name)
       FROM messages rm JOIN users ru ON ru.id=rm.sender_id WHERE rm.id=m.reply_to) AS reply
      ,EXISTS(SELECT 1 FROM chat_members cm WHERE cm.chat_id=m.chat_id AND cm.user_id<>$2 AND cm.last_read_at>=m.created_at) AS read_by_peer,
      (m.delivered_at IS NOT NULL) AS delivered
    FROM messages m JOIN users u ON u.id=m.sender_id`;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "mesaj-app" }));
function configuredIceServers() {
  const fallback = [{ urls: "stun:stun.l.google.com:19302" }];
  if (!process.env.RTC_ICE_SERVERS) return fallback;
  try {
    const parsed = JSON.parse(process.env.RTC_ICE_SERVERS);
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(x => !x || !x.urls)) return fallback;
    return parsed.slice(0, 8);
  } catch {
    console.error("RTC_ICE_SERVERS JSON olarak okunamadı; varsayılan STUN kullanılacak.");
    return fallback;
  }
}
app.get("/api/config", (_req, res) => res.json({
  pushEnabled: pushReady,
  maxUploadBytes: 8 * 1024 * 1024,
  rtcIceServers: configuredIceServers(),
  endToEndEncryption: false
}));
app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const displayName = String(req.body.displayName || "").trim();
    const password = String(req.body.password || "");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: "Kullanıcı adı 3-24 karakter olmalı; harf, sayı ve _ kullan." });
    if (displayName.length < 2 || displayName.length > 40) return res.status(400).json({ error: "Ad 2-40 karakter olmalı." });
    if (password.length < 10 || password.length > 72) return res.status(400).json({ error: "Şifre en az 10 karakter olmalı." });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query("INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id,username,display_name,bio,last_seen,avatar_media_id", [username, displayName, hash]);
    const user = cleanUser(result.rows[0]);
    res.json({ token: signToken(user), user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Bu kullanıcı adı zaten alınmış." });
    console.error(e); res.status(500).json({ error: "Kayıt sırasında hata oluştu." });
  }
});
app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const r = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
    const row = r.rows[0];
    await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [row.id]);
    const user = cleanUser(row);
    res.json({ token: signToken(user), user });
  } catch (e) { console.error(e); res.status(500).json({ error: "Giriş yapılamadı." }); }
});
app.get("/api/me", auth, async (req, res) => {
  const r = await pool.query("SELECT id,username,display_name,bio,avatar_media_id,last_seen FROM users WHERE id=$1", [req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  res.json(cleanUser(r.rows[0]));
});
app.patch("/api/me", auth, async (req, res) => {
  const displayName = String(req.body.displayName || "").trim();
  const bio = String(req.body.bio || "").trim();
  const avatarMediaId = req.body.avatarMediaId ? Number(req.body.avatarMediaId) : null;
  if (displayName.length < 2 || displayName.length > 40 || bio.length > 160) return res.status(400).json({ error: "Ad 2-40, açıklama en fazla 160 karakter olmalı." });
  if (avatarMediaId) {
    const m = await pool.query("SELECT id FROM media_files WHERE id=$1 AND owner_id=$2 AND purpose='avatar'", [avatarMediaId, req.user.id]);
    if (!m.rowCount) return res.status(400).json({ error: "Profil fotoğrafı bulunamadı." });
  }
  const r = await pool.query("UPDATE users SET display_name=$1,bio=$2,avatar_media_id=COALESCE($3,avatar_media_id) WHERE id=$4 RETURNING id,username,display_name,bio,avatar_media_id,last_seen", [displayName, bio, avatarMediaId, req.user.id]);
  res.json(cleanUser(r.rows[0]));
});
app.get("/api/users", auth, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 30);
  if (q.length < 2) return res.json([]);
  const r = await pool.query("SELECT id,username,display_name,bio,avatar_media_id,last_seen FROM users WHERE id<>$1 AND (username LIKE $2 OR LOWER(display_name) LIKE $2) ORDER BY username LIMIT 20", [req.user.id, `%${q}%`]);
  res.json(r.rows.map(cleanUser));
});

app.get("/api/chats", auth, async (req, res) => {
  const includeArchived = req.query.archived === "1";
  const r = await pool.query(`
    SELECT c.id,c.title,c.is_group,c.created_at,mine.archived,mine.muted,
      (SELECT CASE WHEN msg.deleted_at IS NOT NULL THEN 'Mesaj silindi' WHEN msg.body<>'' THEN msg.body WHEN msg.message_type='image' THEN 'Fotoğraf' WHEN msg.message_type='video' THEN 'Video' WHEN msg.message_type='audio' THEN 'Sesli mesaj' WHEN msg.message_type='file' THEN 'Dosya' ELSE '' END FROM messages msg WHERE msg.chat_id=c.id ORDER BY msg.created_at DESC LIMIT 1) AS last_message,
      (SELECT msg.message_type FROM messages msg WHERE msg.chat_id=c.id ORDER BY msg.created_at DESC LIMIT 1) AS last_message_type,
      (SELECT msg.created_at FROM messages msg WHERE msg.chat_id=c.id ORDER BY msg.created_at DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*)::int FROM messages unread WHERE unread.chat_id=c.id AND unread.sender_id<>$1 AND unread.created_at>COALESCE(mine.last_read_at,'epoch'::timestamptz) AND unread.deleted_at IS NULL) AS unread_count,
      (SELECT COALESCE(json_agg(json_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'bio',u.bio,'avatar_url',CASE WHEN u.avatar_media_id IS NULL THEN NULL ELSE '/api/media/'||u.avatar_media_id END,'last_seen',u.last_seen)), '[]'::json)
       FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chat_id=c.id AND u.id<>$1) AS members
    FROM chats c JOIN chat_members mine ON mine.chat_id=c.id
    WHERE mine.user_id=$1 AND mine.archived=$2
    ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE chat_id=c.id),c.created_at) DESC
  `, [req.user.id, includeArchived]);
  res.json(r.rows.map(c => ({ ...c, id: Number(c.id), unread_count: Number(c.unread_count) })));
});
app.post("/api/chats/direct", auth, async (req, res) => {
  try {
    const otherId = Number(req.body.userId);
    if (!Number.isInteger(otherId) || otherId === req.user.id) return res.status(400).json({ error: "Geçersiz kullanıcı." });
    const exists = await pool.query("SELECT id FROM users WHERE id=$1", [otherId]);
    if (!exists.rowCount) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    const old = await pool.query(`SELECT c.id FROM chats c JOIN chat_members a ON a.chat_id=c.id AND a.user_id=$1 JOIN chat_members b ON b.chat_id=c.id AND b.user_id=$2 WHERE c.is_group=false AND (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id=c.id)=2 LIMIT 1`, [req.user.id, otherId]);
    if (old.rowCount) return res.json({ id: Number(old.rows[0].id) });
    const c = await pool.query("INSERT INTO chats(is_group) VALUES(false) RETURNING id");
    const chatId = Number(c.rows[0].id);
    await pool.query("INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2),($1,$3)", [chatId, req.user.id, otherId]);
    io.in(`user:${req.user.id}`).socketsJoin(`chat:${chatId}`);
    io.in(`user:${otherId}`).socketsJoin(`chat:${chatId}`);
    res.json({ id: chatId });
  } catch (e) { console.error(e); res.status(500).json({ error: "Sohbet oluşturulamadı." }); }
});
app.post("/api/chats/group", auth, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number).filter(Number.isInteger))].filter(id => id !== req.user.id);
    if (title.length < 2 || title.length > 60) return res.status(400).json({ error: "Grup adı 2-60 karakter olmalı." });
    if (ids.length < 1 || ids.length > 30) return res.status(400).json({ error: "En az 1, en fazla 30 kişi seç." });
    const found = await pool.query("SELECT id FROM users WHERE id=ANY($1::int[])", [ids]);
    if (found.rowCount !== ids.length) return res.status(400).json({ error: "Kullanıcı listesinde geçersiz kişi var." });
    const c = await pool.query("INSERT INTO chats(title,is_group,created_by) VALUES($1,true,$2) RETURNING id", [title, req.user.id]);
    const chatId = Number(c.rows[0].id);
    const all = [req.user.id, ...ids];
    for (const id of all) {
      await pool.query("INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,$3)", [chatId, id, id === req.user.id ? "admin" : "member"]);
      io.in(`user:${id}`).socketsJoin(`chat:${chatId}`);
    }
    res.json({ id: chatId });
  } catch (e) { console.error(e); res.status(500).json({ error: "Grup oluşturulamadı." }); }
});
app.patch("/api/chats/:id/preferences", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  if (!await isMember(chatId, req.user.id)) return res.status(403).json({ error: "Bu sohbete erişimin yok." });
  const archived = typeof req.body.archived === "boolean" ? req.body.archived : null;
  const muted = typeof req.body.muted === "boolean" ? req.body.muted : null;
  await pool.query("UPDATE chat_members SET archived=COALESCE($1,archived),muted=COALESCE($2,muted) WHERE chat_id=$3 AND user_id=$4", [archived, muted, chatId, req.user.id]);
  res.json({ ok: true });
});

app.get("/api/chats/:id/members", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  if (!await isMember(chatId, req.user.id)) return res.status(403).json({ error: "Bu sohbete erişimin yok." });
  const chat = await pool.query("SELECT id,title,is_group,created_by FROM chats WHERE id=$1", [chatId]);
  if (!chat.rowCount || !chat.rows[0].is_group) return res.status(400).json({ error: "Bu sohbet bir grup değil." });
  const members = await pool.query(`SELECT u.id,u.username,u.display_name,u.bio,
    CASE WHEN u.avatar_media_id IS NULL THEN NULL ELSE '/api/media/'||u.avatar_media_id END AS avatar_url,
    cm.role,cm.joined_at FROM chat_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.chat_id=$1 ORDER BY CASE WHEN cm.role='admin' THEN 0 ELSE 1 END,cm.joined_at,u.display_name`, [chatId]);
  res.json({ ...chat.rows[0], id: Number(chat.rows[0].id), created_by: Number(chat.rows[0].created_by),
    is_admin: members.rows.some(m => Number(m.id) === Number(req.user.id) && m.role === "admin"),
    members: members.rows.map(m => ({ ...m, id: Number(m.id) })) });
});
app.patch("/api/chats/:id/group", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  const title = String(req.body.title || "").trim();
  if (title.length < 2 || title.length > 60) return res.status(400).json({ error: "Grup adı 2-60 karakter olmalı." });
  const c = await pool.query(`UPDATE chats SET title=$1 WHERE id=$2 AND is_group=true
    AND EXISTS(SELECT 1 FROM chat_members WHERE chat_id=$2 AND user_id=$3 AND role='admin') RETURNING id,title`, [title, chatId, req.user.id]);
  if (!c.rowCount) return res.status(403).json({ error: "Grup adını yalnızca yöneticiler değiştirebilir." });
  io.to(`chat:${chatId}`).emit("chat:updated", { chatId, title });
  res.json({ ok: true, ...c.rows[0] });
});
app.post("/api/chats/:id/members", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const admin = await pool.query("SELECT 1 FROM chat_members cm JOIN chats c ON c.id=cm.chat_id WHERE cm.chat_id=$1 AND cm.user_id=$2 AND cm.role='admin' AND c.is_group=true", [chatId, req.user.id]);
  if (!admin.rowCount) return res.status(403).json({ error: "Yalnızca grup yöneticileri katılımcı ekleyebilir." });
  if (!Number.isInteger(userId) || userId === req.user.id) return res.status(400).json({ error: "Geçersiz katılımcı." });
  const user = await pool.query("SELECT id FROM users WHERE id=$1", [userId]);
  if (!user.rowCount) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  const existing = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, userId]);
  if (existing.rowCount) return res.status(409).json({ error: "Bu kişi zaten grupta." });
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id=$1", [chatId]);
  if (count.rows[0].n >= 31) return res.status(400).json({ error: "Bir grup en fazla 31 katılımcı içerebilir." });
  await pool.query("INSERT INTO chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [chatId, userId]);
  io.in(`user:${userId}`).socketsJoin(`chat:${chatId}`);
  io.to(`chat:${chatId}`).emit("chat:members", { chatId });
  res.json({ ok: true });
});
app.delete("/api/chats/:id/members/:userId", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  const userId = Number(req.params.userId);
  const chat = await pool.query("SELECT is_group,created_by FROM chats WHERE id=$1", [chatId]);
  if (!chat.rowCount || !chat.rows[0].is_group) return res.status(404).json({ error: "Grup bulunamadı." });
  const member = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, userId]);
  if (!member.rowCount) return res.status(404).json({ error: "Katılımcı bulunamadı." });
  const selfLeaving = userId === Number(req.user.id);
  const admin = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2 AND role='admin'", [chatId, req.user.id]);
  if (!selfLeaving && !admin.rowCount) return res.status(403).json({ error: "Katılımcıları yalnızca yöneticiler çıkarabilir." });
  if (!selfLeaving && member.rows[0].role === "admin") return res.status(400).json({ error: "Başka bir yöneticiyi buradan çıkaramazsın." });
  if (selfLeaving && member.rows[0].role === "admin") {
    const otherAdmin = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND role='admin' AND user_id<>$2", [chatId, userId]);
    if (!otherAdmin.rowCount) {
      const nextAdmin = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id<>$2 ORDER BY joined_at,user_id LIMIT 1", [chatId, userId]);
      if (nextAdmin.rowCount) await pool.query("UPDATE chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2", [chatId, nextAdmin.rows[0].user_id]);
    }
  }
  await pool.query("DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, userId]);
  io.in(`user:${userId}`).socketsLeave(`chat:${chatId}`);
  const remaining = await pool.query("SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id=$1", [chatId]);
  if (!remaining.rows[0].n) await pool.query("DELETE FROM chats WHERE id=$1", [chatId]);
  else io.to(`chat:${chatId}`).emit("chat:members", { chatId });
  res.json({ ok: true, left: selfLeaving });
});

app.post("/api/media", auth, uploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Dosya seçilmedi." });
    const purpose = ["message", "avatar", "status"].includes(req.body.purpose) ? req.body.purpose : "message";
    if (purpose === "status" && !req.file.mimetype.startsWith("image/")) return res.status(400).json({ error: "Durum için fotoğraf seç." });
    if (purpose === "avatar" && !req.file.mimetype.startsWith("image/")) return res.status(400).json({ error: "Profil için fotoğraf seç." });
    const fileName = String(req.file.originalname || "dosya").replace(/[\r\n"\\/]/g, "_").slice(0, 255);
    const r = await pool.query("INSERT INTO media_files(owner_id,purpose,mime_type,file_name,file_data) VALUES($1,$2,$3,$4,$5) RETURNING id", [req.user.id, purpose, req.file.mimetype, fileName, req.file.buffer]);
    res.json({ id: Number(r.rows[0].id), url: `/api/media/${r.rows[0].id}`, fileName, mimeType: req.file.mimetype, size: req.file.size });
  } catch (e) { console.error(e); res.status(500).json({ error: "Dosya yüklenemedi." }); }
});
app.get("/api/media/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(`
    SELECT f.file_data,f.mime_type,f.file_name,f.purpose,f.owner_id
    FROM media_files f WHERE f.id=$1 AND (
      f.purpose='avatar' OR
      (f.purpose='status' AND EXISTS(SELECT 1 FROM statuses s WHERE s.media_id=f.id AND s.expires_at>NOW()
        AND (s.user_id=$2 OR EXISTS(SELECT 1 FROM chat_members mine JOIN chat_members other ON other.chat_id=mine.chat_id
          WHERE mine.user_id=$2 AND other.user_id=s.user_id)))) OR
      (f.purpose='message' AND EXISTS(SELECT 1 FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id WHERE m.media_id=f.id AND cm.user_id=$2))
    )`, [id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Dosya bulunamadı." });
  const f = r.rows[0];
  const safeName = encodeURIComponent(f.file_name).replace(/['()!*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  res.set({ "Content-Type": f.mime_type, "Content-Disposition": `inline; filename*=UTF-8''${safeName}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.send(f.file_data);
});

app.get("/api/chats/:id/messages", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  if (!await isMember(chatId, req.user.id)) return res.status(403).json({ error: "Bu sohbete erişimin yok." });
  const q = String(req.query.q || "").trim().slice(0, 100);
  const extra = messageQueryExtra();
  const r = await pool.query(`${extra} WHERE m.chat_id=$1 AND ($3='' OR m.body ILIKE '%'||$3||'%') ORDER BY m.created_at DESC LIMIT 100`, [chatId, req.user.id, q]);
  await pool.query("UPDATE chat_members SET last_read_at=NOW(),archived=false WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
  await pool.query("UPDATE messages SET delivered_at=COALESCE(delivered_at,NOW()) WHERE chat_id=$1 AND sender_id<>$2 AND delivered_at IS NULL AND deleted_at IS NULL", [chatId, req.user.id]);
  const results = r.rows.reverse();
  io.to(`chat:${chatId}`).emit("chat:read", { chatId, userId: req.user.id, at: new Date().toISOString() });
  res.json(results.map(m => ({ ...m, id: Number(m.id), chat_id: Number(m.chat_id), sender_id: Number(m.sender_id), media_id: m.media_id ? Number(m.media_id) : null, reply_to: m.reply_to ? Number(m.reply_to) : null, reactions: m.reactions || [] })));
});
async function sendMessage(req, res) {
  try {
    const chatId = Number(req.params.id);
    const body = String(req.body.body || "").trim();
    const type = ["text", "image", "video", "audio", "file"].includes(req.body.type) ? req.body.type : "text";
    const mediaId = req.body.mediaId ? Number(req.body.mediaId) : null;
    const replyTo = req.body.replyTo ? Number(req.body.replyTo) : null;
    if (!Number.isInteger(chatId) || (type === "text" && (!body || body.length > 4000)) || (type !== "text" && !mediaId && !body)) return res.status(400).json({ error: "Mesaj içeriği geçersiz." });
    if (!await isMember(chatId, req.user.id)) return res.status(403).json({ error: "Bu sohbete erişimin yok." });
    if (mediaId) {
      const media = await pool.query("SELECT id,purpose,owner_id,mime_type,file_name FROM media_files WHERE id=$1 AND owner_id=$2 AND purpose='message'", [mediaId, req.user.id]);
      if (!media.rowCount) return res.status(400).json({ error: "Yüklenen dosya bulunamadı." });
      req.body.fileName = media.rows[0].file_name;
    }
    if (replyTo) {
      const reply = await pool.query("SELECT id FROM messages WHERE id=$1 AND chat_id=$2", [replyTo, chatId]);
      if (!reply.rowCount) return res.status(400).json({ error: "Yanıtlanan mesaj bulunamadı." });
    }
    const r = await pool.query("INSERT INTO messages(chat_id,sender_id,body,message_type,media_id,file_name,reply_to) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,chat_id,sender_id,body,message_type,media_id,file_name,reply_to,created_at,edited_at,deleted_at,delivered_at", [chatId, req.user.id, body, type, mediaId, req.body.fileName || null, replyTo]);
    const u = await pool.query("SELECT username,display_name FROM users WHERE id=$1", [req.user.id]);
    const members = await pool.query("SELECT cm.user_id,cm.muted FROM chat_members cm WHERE cm.chat_id=$1 AND cm.user_id<>$2", [chatId, req.user.id]);
    const wasDelivered = members.rows.some(row => (online.get(Number(row.user_id)) || 0) > 0);
    if (wasDelivered) await pool.query("UPDATE messages SET delivered_at=NOW() WHERE id=$1", [r.rows[0].id]);
    const msg = { ...r.rows[0], delivered: wasDelivered, read_by_peer: false, id: Number(r.rows[0].id), chat_id: Number(r.rows[0].chat_id), sender_id: Number(r.rows[0].sender_id), media_id: mediaId, username: u.rows[0].username, display_name: u.rows[0].display_name, reactions: [] };
    io.to(`chat:${chatId}`).emit("message:new", msg);
    const preview = type === "text" ? body.slice(0, 100) : ({ image: "Fotoğraf", video: "Video", audio: "Sesli mesaj", file: "Dosya" }[type]);
    for (const m of members.rows) {
      if (!m.muted) pushUser(Number(m.user_id), { title: u.rows[0].display_name, body: preview, url: `/?chat=${chatId}`, chatId });
    }
    res.json(msg);
  } catch (e) { console.error(e); res.status(500).json({ error: "Mesaj gönderilemedi." }); }
}
app.post("/api/chats/:id/messages", auth, messageLimiter, sendMessage);
app.patch("/api/messages/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body.body || "").trim();
  if (!body || body.length > 4000) return res.status(400).json({ error: "Mesaj 1-4000 karakter olmalı." });
  const r = await pool.query("UPDATE messages SET body=$1,edited_at=NOW() WHERE id=$2 AND sender_id=$3 AND message_type='text' AND deleted_at IS NULL RETURNING id,chat_id,body,edited_at", [body, id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Düzenlenecek mesaj bulunamadı." });
  io.to(`chat:${r.rows[0].chat_id}`).emit("message:updated", { ...r.rows[0], id: Number(r.rows[0].id) });
  res.json({ ok: true, ...r.rows[0] });
});
app.delete("/api/messages/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query("UPDATE messages SET body='',deleted_at=NOW(),media_id=NULL WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL RETURNING id,chat_id", [id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Silinecek mesaj bulunamadı." });
  io.to(`chat:${r.rows[0].chat_id}`).emit("message:deleted", { id: Number(r.rows[0].id), chatId: Number(r.rows[0].chat_id) });
  res.json({ ok: true });
});
app.post("/api/messages/:id/reactions", auth, async (req, res) => {
  const id = Number(req.params.id);
  const emoji = String(req.body.emoji || "").trim();
  if (!/^(❤️|😂|👍|😮|😢|🙏|🔥|👏)$/.test(emoji)) return res.status(400).json({ error: "Emoji desteklenmiyor." });
  const m = await pool.query("SELECT chat_id FROM messages WHERE id=$1 AND deleted_at IS NULL", [id]);
  if (!m.rowCount || !await isMember(m.rows[0].chat_id, req.user.id)) return res.status(404).json({ error: "Mesaj bulunamadı." });
  await pool.query("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=EXCLUDED.emoji", [id, req.user.id, emoji]);
  const a = await pool.query("SELECT emoji,COUNT(*)::int AS count,BOOL_OR(user_id=$2) AS mine FROM message_reactions WHERE message_id=$1 GROUP BY emoji", [id, req.user.id]);
  io.to(`chat:${m.rows[0].chat_id}`).emit("message:reactions", { id, chatId: Number(m.rows[0].chat_id), reactions: a.rows });
  res.json(a.rows);
});
app.post("/api/chats/:id/read", auth, async (req, res) => {
  const chatId = Number(req.params.id);
  if (!await isMember(chatId, req.user.id)) return res.status(403).json({ error: "Bu sohbete erişimin yok." });
  await pool.query("UPDATE chat_members SET last_read_at=NOW(),archived=false WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
  await pool.query("UPDATE messages SET delivered_at=COALESCE(delivered_at,NOW()) WHERE chat_id=$1 AND sender_id<>$2 AND delivered_at IS NULL AND deleted_at IS NULL", [chatId, req.user.id]);
  io.to(`chat:${chatId}`).emit("chat:read", { chatId, userId: req.user.id, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post("/api/statuses", auth, async (req, res) => {
  const caption = String(req.body.caption || "").trim().slice(0, 500);
  const mediaId = req.body.mediaId ? Number(req.body.mediaId) : null;
  if (!caption && !mediaId) return res.status(400).json({ error: "Metin veya fotoğraf ekle." });
  if (mediaId) {
    const f = await pool.query("SELECT id FROM media_files WHERE id=$1 AND owner_id=$2 AND purpose='status'", [mediaId, req.user.id]);
    if (!f.rowCount) return res.status(400).json({ error: "Durum fotoğrafı bulunamadı." });
  }
  const r = await pool.query("INSERT INTO statuses(user_id,caption,media_id) VALUES($1,$2,$3) RETURNING id,caption,media_id,created_at,expires_at", [req.user.id, caption, mediaId]);
  const contacts = await pool.query(`SELECT DISTINCT other.user_id FROM chat_members mine
    JOIN chat_members other ON other.chat_id=mine.chat_id
    WHERE mine.user_id=$1 AND other.user_id<>$1`, [req.user.id]);
  io.to(`user:${req.user.id}`).emit("status:new", { userId: req.user.id });
  for (const contact of contacts.rows) io.to(`user:${contact.user_id}`).emit("status:new", { userId: req.user.id });
  res.json(r.rows[0]);
});
app.get("/api/statuses", auth, async (req, res) => {
  await pool.query("DELETE FROM statuses WHERE expires_at<=NOW()");
  await pool.query("DELETE FROM media_files f WHERE f.purpose='status' AND NOT EXISTS(SELECT 1 FROM statuses s WHERE s.media_id=f.id)");
  const r = await pool.query(`SELECT s.id,s.user_id,s.caption,s.media_id,s.created_at,s.expires_at,u.username,u.display_name,u.avatar_media_id
    FROM statuses s JOIN users u ON u.id=s.user_id WHERE s.expires_at>NOW()
      AND (s.user_id=$1 OR EXISTS(SELECT 1 FROM chat_members mine JOIN chat_members other ON other.chat_id=mine.chat_id
        WHERE mine.user_id=$1 AND other.user_id=s.user_id))
    ORDER BY s.created_at DESC`, [req.user.id]);
  const grouped = new Map();
  for (const s of r.rows) {
    if (!grouped.has(s.user_id)) grouped.set(s.user_id, { userId: Number(s.user_id), username: s.username, displayName: s.display_name, avatarUrl: s.avatar_media_id ? `/api/media/${s.avatar_media_id}` : null, items: [] });
    grouped.get(s.user_id).items.push({ id: Number(s.id), caption: s.caption, mediaUrl: s.media_id ? `/api/media/${s.media_id}` : null, createdAt: s.created_at, expiresAt: s.expires_at });
  }
  res.json([...grouped.values()]);
});
app.delete("/api/statuses/:id", auth, async (req, res) => {
  const r = await pool.query("DELETE FROM statuses WHERE id=$1 AND user_id=$2 RETURNING id", [Number(req.params.id), req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Durum bulunamadı." });
  res.json({ ok: true });
});

app.get("/api/push/public-key", auth, (_req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null }));
app.post("/api/push/subscribe", auth, async (req, res) => {
  if (!pushReady) return res.status(503).json({ error: "Push bildirimleri henüz yapılandırılmadı." });
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth) return res.status(400).json({ error: "Bildirim aboneliği geçersiz." });
  await pool.query("INSERT INTO push_subscriptions(user_id,endpoint,subscription) VALUES($1,$2,$3) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,subscription=EXCLUDED.subscription", [req.user.id, sub.endpoint, sub]);
  res.json({ ok: true });
});
app.delete("/api/push/subscribe", auth, async (req, res) => {
  await pool.query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [req.user.id, req.body.endpoint]);
  res.json({ ok: true });
});

function requireSocketMember(socket, chatId) {
  return isMember(Number(chatId), Number(socket.user.id));
}
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token || "", JWT_SECRET);
    next();
  } catch { next(new Error("Oturum geçersiz.")); }
});
io.on("connection", async socket => {
  const userId = Number(socket.user.id);
  socket.join(`user:${userId}`);
  const oldCount = online.get(userId) || 0;
  online.set(userId, oldCount + 1);
  socket.emit("presence:list", { userIds: [...online.keys()] });
  if (oldCount === 0) {
    await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]).catch(() => {});
    io.emit("presence:update", { userId, online: true });
  }
  const memberships = await pool.query("SELECT chat_id FROM chat_members WHERE user_id=$1", [userId]).catch(() => ({ rows: [] }));
  for (const row of memberships.rows) socket.join(`chat:${row.chat_id}`);
  socket.on("typing", async data => {
    const chatId = Number(data?.chatId);
    if (await requireSocketMember(socket, chatId)) socket.to(`chat:${chatId}`).emit("typing", { chatId, userId, active: Boolean(data.active) });
  });
  socket.on("call:invite", async data => {
    const chatId = Number(data?.chatId);
    if (!await requireSocketMember(socket, chatId)) return;
    const ids = await memberIds(chatId);
    if (ids.length !== 2) return socket.emit("call:error", { message: "Aramalar şimdilik birebir sohbetlerde kullanılabilir." });
    const targetId = ids.find(id => id !== userId);
    io.to(`user:${targetId}`).emit("call:incoming", { from: userId, chatId, mode: data.mode === "video" ? "video" : "audio", offer: data.offer });
  });
  socket.on("call:answer", async data => {
    const chatId = Number(data?.chatId);
    if (await requireSocketMember(socket, chatId)) socket.to(`chat:${chatId}`).emit("call:answered", { from: userId, chatId, answer: data.answer });
  });
  socket.on("call:ice", async data => {
    const chatId = Number(data?.chatId);
    if (await requireSocketMember(socket, chatId)) socket.to(`chat:${chatId}`).emit("call:ice", { from: userId, chatId, candidate: data.candidate });
  });
  socket.on("call:end", async data => {
    const chatId = Number(data?.chatId);
    if (await requireSocketMember(socket, chatId)) socket.to(`chat:${chatId}`).emit("call:ended", { from: userId, chatId });
  });
  socket.on("disconnect", async () => {
    const count = Math.max(0, (online.get(userId) || 1) - 1);
    if (count === 0) {
      online.delete(userId);
      const lastSeen = new Date().toISOString();
      await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]).catch(() => {});
      io.emit("presence:update", { userId, online: false, lastSeen });
    } else online.set(userId, count);
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Dosya en fazla 8 MB olabilir." : "Dosya yükleme sınırı aşıldı." });
  if (err) return res.status(400).json({ error: err.message || "İstek işlenemedi." });
  res.status(500).json({ error: "Beklenmeyen sunucu hatası." });
});

initDb().then(() => server.listen(PORT, () => console.log(`Mesaj uygulaması ${PORT} portunda hazır.`))).catch(err => {
  console.error("Veritabanı başlatılamadı:", err);
  process.exit(1);
});
