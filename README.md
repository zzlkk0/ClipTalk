# ClipTalk

**Real-time shared workspace for remote machines.** A self-hosted web application that bridges your PC and remote server with synchronized clipboard, instant chat, and drag-and-drop file transfer — all through a single browser tab on each side.

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js >= 18">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/status-active-success" alt="Active">
</p>

---

## Why ClipTalk?

You have a remote server you can only reach via screen sharing (VNC/RDP). The server has a browser. You need to move text and files between your PC and the server quickly. Email? Too slow. SCP? Too many steps. USB? Not possible.

**ClipTalk gives you a shared web workspace:** open it on both machines, and everything syncs instantly.

---

## Features

### Core
| Feature | Description |
|---------|-------------|
| 📋 **Live Clipboard Sync** | Type or paste on either side — the other sees it in real time |
| 💬 **Persistent Chat** | Instant messaging with scrollable history (last 500 messages saved to disk) |
| 📁 **Drag & Drop File Transfer** | Drop files on the page, they upload to the server and appear on the other side. Supports multi-file uploads up to 500MB each |

### Multi-User System
| Feature | Description |
|---------|-------------|
| 👤 **User Registration** | Self-service signup at `/register.html` |
| ✅ **Admin Approval** | Configurable: auto-approve new users or require manual admin approval |
| 🔑 **Per-User Login** | Each user has their own username + password (bcrypt-hashed) |
| 🛡️ **Admin Panel** | Full user management UI: approve, reject, disable, enable, delete users |

### Internationalization
| Language | Coverage |
|----------|----------|
| 🇨🇳 **Chinese (zh-CN)** | Full — login, register, workspace, admin panel |
| 🇬🇧 **English (en)** | Full — all pages, all labels |

Click the 🌐 button in the top bar to switch languages at any time.

---

## Security

ClipTalk is designed for internal/private network use. Security features include:

| Layer | Protection |
|-------|-----------|
| **Session Auth** | HttpOnly session cookies with 8-hour expiry, regenerated on login to prevent session fixation |
| **Password Hashing** | bcrypt with 12 salt rounds — even if the database is compromised, passwords are irrecoverable |
| **Rate Limiting** | Global: 100 req/min. Login endpoint: 5 attempts per 15-minute window (configurable) |
| **SQL Injection** | SQLite via parameterized queries (better-sqlite3) |
| **XSS Protection** | Content Security Policy via Helmet.js, plus HTML entity escaping on all user input |
| **Clickjacking** | CSP `frame-ancestors: 'none'` — the page cannot be embedded in iframes |
| **Input Validation** | Username: 3–20 alphanumeric chars. Password: ≥6 chars. File upload: path sanitization against directory traversal |
| **Security Headers** | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses |

> **Note**: HTTPS is recommended for production. Run behind nginx/Caddy with Let's Encrypt, or use the built-in SSH tunnel approach (see below).

---

## Architecture

```
ClipTalk/
├── server.js              # Express + Socket.IO server (HTTP)
├── db.js                  # SQLite user database module
├── admin-cli.js           # Command-line admin tool
├── i18n/
│   ├── zh-CN.json         # Chinese language pack
│   └── en.json            # English language pack
├── public/
│   ├── login.html         # Login page with language switcher
│   ├── register.html      # Self-service registration
│   ├── admin3.html        # Admin management panel
│   └── index.html         # Main workspace UI (3-panel layout)
├── uploads/               # Uploaded files (gitignored)
├── database/
│   └── users.db           # SQLite database (gitignored)
├── config.json            # Server configuration (gitignored — see below)
└── package.json
```

### Tech Stack

- **Backend**: Node.js + Express + Socket.IO
- **Database**: SQLite via better-sqlite3 (zero-config, single-file)
- **Auth**: express-session + bcryptjs
- **Security**: Helmet.js, express-rate-limit
- **i18n**: JSON-based, client-side dynamic loading
- **File Upload**: multer

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- npm

### 1. Clone & Install

```bash
git clone https://github.com/zzlkk0/ClipTalk.git
cd ClipTalk
npm install
```

### 2. Create Config

Copy the sample and edit:

```bash
cp config.sample.json config.json
```

Or create `config.json` manually:

```json
{
  "port": 8000,
  "passwordHash": "(generated automatically on first run)",
  "sessionSecret": "(generated automatically on first run)",
  "maxLoginAttempts": 5,
  "loginWindowMinutes": 15,
  "rateLimitWindowMs": 60000,
  "rateLimitMax": 100
}
```

> On first run, the server auto-generates `sessionSecret` and creates an admin account. No manual config needed — just start the server.

### 3. Start

```bash
node server.js
```

### 4. Open

- **Server side**: `http://localhost:8000`
- **PC side**: `http://<server-ip>:8000`

Default admin credentials:
- **Username**: `admin`
- **Password**: `admin46666`

> ⚠️ Change the admin password immediately after first login (Admin Panel → Settings).

### 5. Open Firewall (if accessing from other machines)

```bash
sudo ufw allow 8000/tcp
```

If you're on a cloud provider (AWS, Alibaba Cloud, etc.), also add the port in the security group console.

---

## Usage

### Normal User Flow

1. Open the login page → click "注册" (Register)
2. Create an account with username + password
3. Wait for admin approval (or auto-approval if enabled)
4. Log in → use clipboard sync, chat, and file transfer

### Admin Flow

1. Log in as `admin`
2. Click "管理" (Admin) in the top bar
3. **Users tab**: view all users, disable/enable, delete
4. **Pending tab**: approve or reject new registrations
5. **Settings tab**: toggle approval mode, toggle registration, change admin password

### CLI Admin Tool

```bash
# List all users
node admin-cli.js list-users

# Change admin password
node admin-cli.js change-password <new-password>

# Approve a pending user
node admin-cli.js approve <username>

# Toggle auto-approval
node admin-cli.js set-approval auto
node admin-cli.js set-approval manual

# Toggle registration
node admin-cli.js set-registration false
```

### SSH Tunnel (No Firewall Config Needed)

If you can't open port 8000, tunnel through SSH from your PC:

```bash
ssh -L 8000:localhost:8000 user@your-server-ip
```

Then open `http://localhost:8000` on your PC. The server browser uses `http://localhost:8000` directly.

---

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `8000` | HTTP server port |
| `maxLoginAttempts` | `5` | Max failed logins before rate limit |
| `loginWindowMinutes` | `15` | Rate limit cooldown window |
| `rateLimitWindowMs` | `60000` | Global rate limit window (ms) |
| `rateLimitMax` | `100` | Max requests per window |

Settings controlled via Admin Panel (stored in SQLite):
- `approval_mode`: `"auto"` or `"manual"`
- `registration_enabled`: `"true"` or `"false"`

---

## Project Structure Notes

```
public/
├── login.html       # Handles auth + language switching
├── register.html    # Self-registration with validation
├── admin3.html      # Admin dashboard (users, settings, password)
└── index.html       # Main 3-panel workspace (clipboard | chat | files)

i18n/
├── zh-CN.json       # All UI strings in Chinese
└── en.json          # All UI strings in English
```

Files excluded from git:
- `config.json` — contains session secret and password hash
- `database/users.db` — user data (auto-created)
- `uploads/` — uploaded files
- `history.json` — chat history

---

## License

MIT — see [LICENSE](LICENSE) file.

---

## Contributing

Issues and pull requests welcome. Please ensure:
- Backward compatibility with existing config.json format
- Both language files are updated when adding new UI strings
- No credentials or secrets in commits
