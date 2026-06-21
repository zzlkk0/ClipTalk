const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const multer = require('multer');
const db = require('./db');

// ─── 配置 ───────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = config.port || 8000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const I18N_DIR = path.join(__dirname, 'i18n');
const MAX_MESSAGES = 500;
const MAX_FILE_SIZE = 500 * 1024 * 1024;

// ─── 数据库初始化 ───────────────────────────────
db.init();

// ── Express & HTTP ────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Helmet ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:  ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc:     ["'self'", "data:"],
      fontSrc:    ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  xFrameOptions: false,            // CSP frame-ancestors 替代
  xXssProtection: false,           // 现代浏览器不再需要
  strictTransportSecurity: false,  // HTTP 模式下不需要
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));

// 显式追加 Content-Type charset
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  next();
});

// API 响应统一加 Cache-Control
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// 静态资源缓存
app.use((req, res, next) => {
  if (req.path.match(/\.(js|css|png|svg|ico)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } else if (req.path.match(/\.html$/) || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// ─── 速率限制 ───────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs || 60000,
  max: config.rateLimitMax || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
});
const loginLimiter = rateLimit({
  windowMs: (config.loginWindowMinutes || 15) * 60 * 1000,
  max: config.maxLoginAttempts || 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

app.use(globalLimiter);
app.use(express.json({ limit: '1mb' }));

// ─── Session ────────────────────────────────────
const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, httpOnly: true, sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

// ─── 语言加载 ───────────────────────────────────
function loadLang(lang) {
  try {
    const file = path.join(I18N_DIR, (lang === 'en' ? 'en' : 'zh-CN') + '.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'zh-CN.json'), 'utf8'));
  }
}

function getLang(req) {
  return (req.session && req.session.lang) || 'zh-CN';
}

// ─── 认证中间件 ─────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.status(403).send('Forbidden');
}

// ─── 页面路由 ───────────────────────────────────
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// ─── i18n API ───────────────────────────────────
app.get('/api/i18n/:lang', (req, res) => {
  const lang = req.params.lang === 'en' ? 'en' : 'zh-CN';
  res.json(loadLang(lang));
});

app.post('/api/lang', (req, res) => {
  const lang = req.body.lang === 'en' ? 'en' : 'zh-CN';
  if (req.session) req.session.lang = lang;
  res.json({ ok: true, lang });
});

// ─── 认证 API ───────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: !username ? 'empty_username' : 'empty_password' });
  }

  const user = db.verifyUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'wrong' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'disabled' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'pending' });
  }

  db.updateLastLogin(user.id);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'server_error' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.lang = user.language || 'zh-CN';
    res.json({ ok: true, role: user.role, redirect: '/' });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json(user);
});

// ─── 注册 API ───────────────────────────────────
app.post('/api/register', (req, res) => {
  const regEnabled = db.getSetting('registration_enabled');
  if (regEnabled !== 'true') {
    return res.status(403).json({ error: 'registration_closed' });
  }

  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'empty_username' });
  if (!password) return res.status(400).json({ error: 'empty_password' });
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return res.status(400).json({ error: 'username_format' });
  if (password.length < 6) return res.status(400).json({ error: 'password_short' });

  const existing = db.getUserByUsername(username);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const user = db.createUser(username, password);
  const approvalMode = db.getSetting('approval_mode');
  res.json({
    ok: true,
    status: user.status,
    autoApproved: approvalMode === 'auto'
  });
});

// ─── 管理员 API ─────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.listUsers());
});

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  res.json(db.getStats());
});

app.post('/api/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const r = db.approveUser(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const r = db.rejectUser(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/status', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const r = db.setUserStatus(req.params.id, status);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const r = db.deleteUser(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// 修改管理员密码
app.post('/api/admin/change-password', requireAuth, requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'empty_fields' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'password_short' });
  }
  const user = db.getUserById(req.session.userId);
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(currentPassword, db.getUserByUsername(user.username)?.password_hash || '')) {
    return res.status(401).json({ error: 'wrong_password' });
  }
  db.changePassword(req.session.userId, newPassword);
  res.json({ ok: true });
});

// 系统设置
app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({
    approval_mode: db.getSetting('approval_mode'),
    registration_enabled: db.getSetting('registration_enabled'),
  });
});

app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const { approval_mode, registration_enabled } = req.body;
  if (approval_mode && ['auto', 'manual'].includes(approval_mode)) {
    db.setSetting('approval_mode', approval_mode);
  }
  if (registration_enabled !== undefined) {
    db.setSetting('registration_enabled', registration_enabled ? 'true' : 'false');
  }
  res.json({ ok: true });
});

// ─── 受保护静态文件 ─────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', requireAuth, express.static(UPLOADS_DIR));

// ─── 文件上传 ───────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${Date.now()}_${path.basename(safeName)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: 10 } });

app.post('/upload', requireAuth, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'no_files' });
  }
  const uploaded = req.files.map(f => ({
    name: f.filename,
    originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    size: f.size,
    time: Date.now()
  }));
  files.push(...uploaded);
  files.sort((a, b) => b.time - a.time);
  saveHistory();

  const fileNames = uploaded.map(f => f.originalName).join(', ');
  io.emit('files-updated', files);
  addMessage({ type: 'system', text: `📎 ${fileNames}`, time: Date.now(), files: uploaded });
  io.emit('chat-message', messages[messages.length - 1]);
  res.json({ ok: true, files: uploaded });
});

app.get('/api/files', requireAuth, (req, res) => {
  refreshFiles();
  res.json(files);
});

app.delete('/api/files/:name', requireAuth, (req, res) => {
  const safeName = path.basename(req.params.name);
  const filePath = path.join(UPLOADS_DIR, safeName);
  try {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
    fs.unlinkSync(filePath);
    files = files.filter(f => f.name !== safeName);
    saveHistory();
    io.emit('files-updated', files);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 应用状态 ───────────────────────────────────
let clipboardText = '';
let messages = [];
let files = [];

if (fs.existsSync(HISTORY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    messages = data.messages || [];
    clipboardText = data.clipboardText || '';
    files = data.files || [];
  } catch (e) {}
}

function refreshFiles() {
  const existing = new Map();
  try {
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      const fullPath = path.join(UPLOADS_DIR, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        const match = name.match(/^(\d+)_(.+)$/);
        existing.set(name, {
          name, originalName: match ? match[2] : name,
          size: stat.size, time: stat.mtime.getTime()
        });
      }
    }
  } catch (e) {}
  const valid = new Set(existing.keys());
  files = files.filter(f => valid.has(f.name));
  for (const [name, info] of existing) {
    if (!files.find(f => f.name === name)) files.push(info);
  }
  files.sort((a, b) => b.time - a.time);
}
refreshFiles();

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify({ messages, clipboardText, files }, null, 2)); } catch (e) {}
}

function addMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  saveHistory();
}

// ─── Socket.IO (WSS) ────────────────────────────
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e6,
  connectTimeout: 10000,
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (socket.request.session && socket.request.session.userId) {
    return next();
  }
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  const username = socket.request.session.username || '?';
  console.log(`[+] ${username} (${socket.id.slice(0,6)})`);

  socket.emit('init', { clipboardText, messages, files });
  socket.emit('user-info', {
    username: socket.request.session.username,
    role: socket.request.session.role,
    lang: socket.request.session.lang || 'zh-CN',
  });

  socket.on('clipboard-update', (text) => {
    if (typeof text !== 'string' || text.length > 500000) return;
    clipboardText = text;
    saveHistory();
    socket.broadcast.emit('clipboard-update', text);
  });

  socket.on('chat-message', (msg) => {
    if (!msg || typeof msg.text !== 'string' || msg.text.length > 10000) return;
    const message = {
      type: 'user',
      text: msg.text.substring(0, 10000),
      time: Date.now(),
      from: username,
    };
    addMessage(message);
    io.emit('chat-message', message);
  });

  socket.on('refresh-files', () => {
    refreshFiles();
    socket.emit('files-updated', files);
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${username}`);
  });
});

// ─── 启动 ───────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  🔒 共享工作区 v2 — 多用户版                ║');
  console.log(`║  HTTP:     http://0.0.0.0:${PORT}               ║`);
  console.log(`║  本机:     http://localhost:${PORT}             ║`);
  console.log('║  管理员:   admin / admin46666                ║');
  console.log('║  管理面板: /admin.html                       ║');
  console.log('╚══════════════════════════════════════════════╝');
});
