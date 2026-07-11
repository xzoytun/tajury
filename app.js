// 🌐 Core Modules
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const app = express();
const axios = require('axios');
const cron = require('node-cron');
// const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');
const fetch = require('node-fetch');

// 📁 Direktori
const UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';
const BACKUP_DIR = '/root/BotVPN2/backups';
const DB_PATH = path.resolve('./sellvpn.db');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 🛠️ Load Config
const vars =
JSON.parse(
fs.readFileSync('./.vars.json', 'utf8')
);

const {
BOT_TOKEN,
USER_ID,
GROUP_ID,
ADMIN_EMAIL, 
PORT = 50123,
NAMA_STORE = 'GabutStore',
DATA_QRIS,
MERCHANT_ID,
API_KEY,
PAKASIR_API_KEY,
PAKASIR_PROJECT_SLUG,
PAKASIR_WEBHOOK_URL,

JWT_SECRET
} = vars;

const MIN_DEPOSIT_AMOUNT = Number(vars.MIN_DEPOSIT_AMOUNT) || 2000;

const jwt = require('jsonwebtoken');

const { OAuth2Client } =
require('google-auth-library');

const googleClient =
new OAuth2Client(
'480091956294-njvigllpnbqmh6p11nij99eavv101u3e.apps.googleusercontent.com'
);

// 🖼️ URL foto yang tampil di setiap menu bot
const MENU_IMAGE = 'https://raw.githubusercontent.com/joytun21/joy/main/image/mediaxtrimer.png';
// ✅ Cache file_id setelah foto pertama terkirim → pakai file_id (bukan URL) agar tidak re-download
let cachedMenuPhotoFileId = null;

// 📦 Tools & Libraries
const util = require('util');
const QRISPayment = require('qris-payment');
const QRCode = require('qrcode');
const execAsync = util.promisify(exec); // ✅ Satu definisi saja
const dns = require('dns').promises;
const FormData = require('form-data');

// 📝 Logger (didefinisikan lebih awal agar bisa dipakai di seluruh file)
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}
logger.info('Bot initialized');

// 🧠 Admin List
const rawAdmin = USER_ID;
const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];

// 💬 Pakasir Client
const { PakasirClient } = require('pakasir-client');
const pakasir = new PakasirClient({
  project: PAKASIR_PROJECT_SLUG,
  apiKey: PAKASIR_API_KEY
});

// 📡 Express Middleware (✅ Satu kali saja)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 💬 Telegram
const { Telegraf, session } = require('telegraf');
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// 🗄️ SQLite Init
// 1. Inisialisasi Koneksi Database
let db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error('Kesalahan koneksi SQLite3:', err.message);
  } else {
    logger.info(`Terhubung ke SQLite3 di path: ${DB_PATH}`);
  }
});

// 2. Konfigurasi "Mesin" Database (Langsung jalankan Pragma)
// Kita pakai db.serialize agar urutan eksekusinya pasti
db.serialize(() => {
  db.run("PRAGMA busy_timeout = 5000;"); // Tunggu 5 detik jika locked
  db.run("PRAGMA journal_mode = WAL;");   // Mode kencang
  db.run("PRAGMA synchronous = NORMAL;"); // Aman & Cepat
});

// 3. Promisify DB Methods (Biar bisa pakai await)
const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

// ===========================
// 🗄️ Inisialisasi Tabel DB
// ===========================
db.serialize(() => {

  // Tabel Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    saldo INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    reseller_level TEXT DEFAULT 'silver',
    has_trial INTEGER DEFAULT 0,
    username TEXT,
    first_name TEXT,
    last_trial_date TEXT,
    trial_count_today INTEGER DEFAULT 0
  )`);

  // Tabel Reseller Sales
  db.run(`CREATE TABLE IF NOT EXISTS reseller_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER,
    buyer_id INTEGER,
    akun_type TEXT,
    username TEXT,
    komisi INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Akun Aktif
  db.run(`CREATE TABLE IF NOT EXISTS akun_aktif (
    username TEXT PRIMARY KEY,
    jenis TEXT
  )`);

  // Tabel Invoice Log
  db.run(`CREATE TABLE IF NOT EXISTS invoice_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    layanan TEXT,
    akun TEXT,
    hari INTEGER,
    harga INTEGER,
    komisi INTEGER,
    protocol TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Pending Deposit (QRIS lama)
  db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
    unique_code TEXT PRIMARY KEY,
    user_id INTEGER,
    amount INTEGER,
    original_amount INTEGER,
    timestamp INTEGER,
    status TEXT,
    qr_message_id INTEGER
  )`);

  // Tabel Pending Deposit Pakasir
  db.run(`CREATE TABLE IF NOT EXISTS pending_deposits_pakasir (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    order_id TEXT UNIQUE,
    amount INTEGER,
    status TEXT DEFAULT 'pending',
    payment_method TEXT,
    payment_data TEXT,
    expired_at TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Trial Logs
  db.run(`CREATE TABLE IF NOT EXISTS trial_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    jenis TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Server
  db.run(`CREATE TABLE IF NOT EXISTS Server (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT,
    auth TEXT,
    harga INTEGER,
    nama_server TEXT,
    quota INTEGER,
    iplimit INTEGER,
    batas_create_akun INTEGER,
    total_create_akun INTEGER DEFAULT 0,
    isp TEXT,
    lokasi TEXT
  )`);

  // Tabel Akun
  db.run(`CREATE TABLE IF NOT EXISTS akun (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    jenis TEXT,
    username TEXT,
    server_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Transaksi
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount INTEGER,
    type TEXT,
    reference_id TEXT,
    timestamp INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  )`);

  // Tabel Transfer Saldo
  db.run(`CREATE TABLE IF NOT EXISTS saldo_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    amount INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Log Transfer
  db.run(`CREATE TABLE IF NOT EXISTS transfer_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    jumlah INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Topup Log
  db.run(`CREATE TABLE IF NOT EXISTS topup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    amount INTEGER,
    reference TEXT,
    metode TEXT,
    created_at TEXT
  )`);

  // Tabel Reseller Events
  db.run(`CREATE TABLE IF NOT EXISTS reseller_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama_event TEXT,
    target_penjualan INTEGER,
    bonus_saldo INTEGER,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER DEFAULT 1
  )`);

  // Tabel Reseller Event Progress
  db.run(`CREATE TABLE IF NOT EXISTS reseller_event_progress (
    user_id INTEGER,
    event_id INTEGER,
    current_sales INTEGER DEFAULT 0,
    is_claimed INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, event_id)
  )`);

  // Tabel Reseller Upgrade Log
  db.run(`CREATE TABLE IF NOT EXISTS reseller_upgrade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    amount INTEGER,
    level TEXT,
    created_at TEXT
  )`);

  // Tabel Log Pencabutan Reseller Otomatis
  db.run(`CREATE TABLE IF NOT EXISTS reseller_cabut_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    first_name TEXT,
    saldo_terakhir INTEGER,
    reseller_since TEXT,
    hari_berjalan INTEGER,
    alasan TEXT DEFAULT 'Saldo < Rp 30.000 selama 60 hari',
    dicabut_at TEXT DEFAULT (datetime('now'))
  )`);

  // Tabel Reseller Sales Archive
  db.run(`CREATE TABLE IF NOT EXISTS reseller_sales_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER,
    buyer_id INTEGER,
    akun_type TEXT,
    username TEXT,
    komisi INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    archived_at TEXT
  )`);

  // Tabel Auto-Delete Messages
  db.run(`CREATE TABLE IF NOT EXISTS pending_delete_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    delete_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`, (err) => {
    if (err) logger.error("❌ Gagal membuat tabel pending_delete_messages: " + err.message);
    else logger.info("✅ Semua tabel DB siap.");
  });

  // Tabel Weekly Bonus Claims
  db.run(`CREATE TABLE IF NOT EXISTS weekly_bonus_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    claimed_date TEXT NOT NULL,
    claimed_at DATETIME DEFAULT (datetime('now')),
    reference TEXT,
    UNIQUE(user_id, claimed_date)
  )`, (err) => {
    if (err) logger.error('ERR init weekly_bonus_claims table:', err.message);
    else logger.info('weekly_bonus_claims table ready');
  });

  // Tabel PPOB Transactions
  db.run(`CREATE TABLE IF NOT EXISTS ppob_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ref_id TEXT UNIQUE,
    sku TEXT,
    target TEXT,
    price INTEGER,
    status TEXT DEFAULT 'PENDING',
    sn TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
});
//tabel web
db.run(`
CREATE TABLE IF NOT EXISTS web_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT,
  protocol TEXT,
  username TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`CREATE TABLE IF NOT EXISTS web_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    avatar TEXT,
    role TEXT DEFAULT 'user',
    balance INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.run(`CREATE TABLE IF NOT EXISTS vpn_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.run(`
CREATE TABLE IF NOT EXISTS web_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email TEXT,
    product_name TEXT,
    product_type TEXT,
    username TEXT,
    password TEXT,
    server_name TEXT,
    expired_at TEXT,
    result TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS topup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    amount INTEGER DEFAULT 0,
    metode TEXT,
    reference TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
// Jalankan ini sekali saja setelah database berhasil terhubung (connected)
db.run(`ALTER TABLE web_users ADD COLUMN last_login TEXT`, (err) => {
  if (err) {
    // Kalau eror karena kolomnya ternyata sudah ada, abaikan saja
    if (err.message.includes("duplicate column name")) {
      console.log("Kolom last_login sudah siap digunakan.");
    } else {
      console.error("Gagal migrasi database:", err.message);
    }
  } else {
    console.log("Berhasil menambahkan kolom last_login ke tabel web_users!");
  }
});

db.run(`
  ALTER TABLE web_orders
  ADD COLUMN price INTEGER DEFAULT 0
`, (err) => {

  if (
    err &&
    !err.message.includes('duplicate column name')
  ) {

    console.error(
      'Gagal tambah column price:',
      err.message
    );

  } else {

    console.log(
      '✅ Column price ready'
    );

  }

});
db.serialize(() => {

    // TAMBAH KOLOM protocol
    db.run(`
        ALTER TABLE Server
        ADD COLUMN protocol TEXT DEFAULT 'SSH'
    `, (err) => {

        if(err){
            console.log('protocol sudah ada');
        }else{
            console.log('kolom protocol berhasil dibuat');
        }

    });

    // TAMBAH KOLOM is_admin
    db.run(`
        ALTER TABLE web_users
        ADD COLUMN is_admin INTEGER DEFAULT 0
    `, (err) => {

        if(err){
            console.log('is_admin sudah ada');
        }else{
            console.log('kolom is_admin berhasil dibuat');
        }

    });

    // AUTO ADMIN
    db.run(`
        UPDATE web_users
        SET is_admin = 1
        WHERE email = ?
    `, [ADMIN_EMAIL]);

});
// ==================================================
// 🔄 AUTO MIGRATION WEB_ORDERS
// ==================================================

db.all(
  "PRAGMA table_info(web_orders)",
  (err, tableInfo) => {

    if (err) {
      return console.error(
        "Gagal cek struktur web_orders:",
        err
      );
    }

    const columns =
    tableInfo.map(col => col.name);

    // =========================
    // EMAIL
    // =========================
    if (!columns.includes('email')) {

      console.log(
        "Migrasi: tambah kolom email"
      );

      db.run(
        "ALTER TABLE web_orders ADD COLUMN email TEXT"
      );

    }

    // =========================
    // PASSWORD
    // =========================
    if (!columns.includes('password')) {

      console.log(
        "Migrasi: tambah kolom password"
      );

      db.run(
        "ALTER TABLE web_orders ADD COLUMN password TEXT"
      );

    }

    // =========================
    // SERVER NAME
    // =========================
    if (!columns.includes('server_name')) {

      console.log(
        "Migrasi: tambah kolom server_name"
      );

      db.run(
        "ALTER TABLE web_orders ADD COLUMN server_name TEXT"
      );

    }

    // =========================
    // EXPIRED AT
    // =========================
    if (!columns.includes('expired_at')) {

      console.log(
        "Migrasi: tambah kolom expired_at"
      );

      db.run(
        "ALTER TABLE web_orders ADD COLUMN expired_at TEXT"
      );

    }

    console.log(
      "Migrasi web_orders selesai"
    );

  }
);
// --- Digiflazz Helpers ---
const crypto = require('crypto');
const { DIGIFLAZZ_USERNAME, DIGIFLAZZ_API_KEY, DIGIFLAZZ_BASE_URL } = vars;

function generateDigiSig(suffix) {
  return crypto.createHash('md5')
    .update(DIGIFLAZZ_USERNAME + DIGIFLAZZ_API_KEY + suffix)
    .digest('hex');
}

async function fetchDigiflazz(endpoint, payload = {}) {
  try {
    const response = await axios.post(`${DIGIFLAZZ_BASE_URL}${endpoint}`, {
      username: DIGIFLAZZ_USERNAME,
      ...payload
    }, { timeout: 15000 });

    return response.data;
  } catch (error) {
    // Jika error dari server Digiflazz (misal 400 Bad Request)
    if (error.response) {
      logger.error(`Digiflazz API Error: ${JSON.stringify(error.response.data)}`);
      return error.response.data; // Kembalikan agar bisa dibaca message-nya
    }
    logger.error(`Network Error: ${error.message}`);
    return null;
  }
}
let digiPriceCache = {
  data: null,
  lastUpdated: 0
};
const CACHE_TIMEOUT = 10 * 60 * 1000; // Cache berlaku 10 menit
async function getDigiProducts() {
  const now = Date.now();
  
  if (digiPriceCache.data && (now - digiPriceCache.lastUpdated < CACHE_TIMEOUT)) {
    return { status: 'success', data: digiPriceCache.data };
  }

  const result = await fetchDigiflazz('/price-list', {
    cmd: 'prepaid',
    sign: generateDigiSig('PriceList')
  });

  // Jika Digiflazz mengembalikan data produk (berupa Array)
  if (result && Array.isArray(result.data)) {
    digiPriceCache.data = result.data;
    digiPriceCache.lastUpdated = now;
    return { status: 'success', data: result.data };
  }
  
  // Jika gagal, ambil pesan errornya
  const errorMsg = result?.data?.message || "Koneksi ke Digiflazz terputus.";
  return { status: 'error', message: errorMsg };
}
async function digiflazzRequest(endpoint, payload = {}) {
  try {
    const username = DIGIFLAZZ_USERNAME.trim();
    const apiKey = DIGIFLAZZ_API_KEY.trim();
    
    // ATURAN SIGNATURE DIGIFLAZZ:
    // 1. Kalau Transaksi: md5(username + api_key + ref_id)
    // 2. Kalau Cek Saldo: md5(username + api_key + "depo")
    
    let refIdForSign = "";
    if (endpoint === 'cek-saldo') {
        refIdForSign = "depo"; // Digiflazz wajib pake kata 'depo' buat cek saldo
    } else {
        refIdForSign = payload.ref_id; 
    }

    const sign = crypto.createHash('md5')
      .update(username + apiKey + refIdForSign)
      .digest('hex');

    const data = {
      username: username,
      sign: sign,
      ...payload
    };

    // ✅ FIX #9: Hindari double slash jika BASE_URL sudah berakhir '/'
    const digiBase = (DIGIFLAZZ_BASE_URL || '').replace(/\/$/, '');
    const response = await axios.post(`${digiBase}/${endpoint}`, data, {
      timeout: 15000
    });

    return response.data.data;
  } catch (err) {
    if (err.response) {
       logger.error("Digiflazz Error Respon: " + JSON.stringify(err.response.data));
    } else {
       logger.error("Digiflazz Error Message: " + err.message);
    }
    return null;
  }
}
// ===========================
// 🔄 Migrasi Kolom (ALTER TABLE)
// Dijalankan setelah serialize selesai, agar tabel sudah pasti ada
// Semua error "duplicate column name" diabaikan secara aman
// ===========================
function safeAlter(sql) {
  db.run(sql, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      logger.warn(`⚠️ ALTER TABLE: ${err.message}`);
    }
  });
}

;

// Migrasi kolom untuk fitur auto-cabut reseller
safeAlter("ALTER TABLE users ADD COLUMN reseller_since TEXT");
safeAlter("ALTER TABLE users ADD COLUMN warned_h7 INTEGER DEFAULT 0");
safeAlter("ALTER TABLE users ADD COLUMN warned_h3 INTEGER DEFAULT 0");

// ===========================
// 🔄 Cache Global
// ===========================
let cacheTotalUser = 0;

const updateGlobalCache = async () => {
  try {
    const res = await dbGetAsync('SELECT COUNT(*) AS total FROM users');
    cacheTotalUser = res?.total || 0;
    logger.info(`📊 Cache User diperbarui: ${cacheTotalUser} Member`);
  } catch (e) {
    logger.error("❌ Gagal update cache user: " + e.message);
  }
};

const cacheStatus = {
  jumlahServer: 0,
  jumlahPengguna: 0,
  lastUpdated: 0
};

// ===========================
// 🔧 Helper
// ===========================
const escapeMarkdownV2 = (text) => {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
};

/**
 * Escape HTML special characters for use in HTML parse_mode messages.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mask a username for privacy: show first 2 chars, replace rest with '*'.
 */
function maskUsername(uname) {
  if (!uname) return uname;
  if (uname.length <= 2) return uname;
  return uname.slice(0, 2) + '*'.repeat(uname.length - 2); // Ganti 'x' jadi '*'
}

/**
 * Mask a numeric user ID for privacy: show first 3 and last 2 digits, replace middle with '*'.
 */
function maskUserId(id) {
  const s = String(id);
  if (s.length <= 5) return '*'.repeat(s.length); // Ganti 'x' jadi '*'
  return s.slice(0, 3) + '*'.repeat(s.length - 5) + s.slice(-2); // Ganti 'x' jadi '*'
}

/**
 * Title-case a string (first letter uppercase, rest lowercase).
 */
function toTitleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function maskEmail(email = '') {

  if (!email.includes('@')) {
    return email;
  }

  const [name, domain] = email.split('@');

  const visible =
    name.slice(0, 2);

  const masked =
    '*'.repeat(
      Math.max(name.length - 2, 0)
    );

  return `${visible}${masked}@${domain}`;

}
// ===========================
// 🤖 Telegram Middleware
// ===========================

// Middleware 1: Auto-register user
bot.use(async (ctx, next) => {
  try {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name || null;

    try {
      const existing = await dbGetAsync(
        "SELECT user_id FROM users WHERE user_id = ?",
        [userId]
      );

      if (!existing) {
        await dbRunAsync(
          `INSERT OR IGNORE INTO users (user_id, username, first_name, saldo, role)
           VALUES (?, ?, ?, 0, 'user')`,
          [userId, username, firstName]
        );
        logger.info(`🆕 Auto-registered user ${userId} (via middleware)`);
      } else {
        dbRunAsync(
          `UPDATE users SET username = ?, first_name = ? WHERE user_id = ?`,
          [username, firstName, userId]
        ).catch(() => {});
      }
    } catch (dbErr) {
      logger.error('DB Middleware Error: ' + dbErr.message);
    }
  } catch (e) {
    logger.warn('Middleware ensure-user error: ' + (e?.message || e));
  }
  return next();
});

// Middleware 2: Blokir perintah dari grup
bot.use(async (ctx, next) => {
  if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    if (ctx.message?.text?.startsWith('/')) {
      try {
        await ctx.reply('⚠️ Perintah bot tidak bisa digunakan di dalam grup.\nSilakan chat bot secara pribadi.');
      } catch (e) {}
      return;
    }
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCbQuery('⚠️ Bot tidak bisa digunakan dari grup.', { show_alert: true }).catch(() => {});
      } catch (e) {}
      return;
    }
  }
  return next();
});

// ===========================
// ⏱️ Cron Jobs
// ===========================

// Backup otomatis tiap 1 jam
cron.schedule('0 * * * *', async () => {
  logger.info('⏳ [Cron] Memulai backup database otomatis berkala...');
  try {
    if (typeof telegramAutoBackup !== 'function') {
      throw new Error('Fungsi telegramAutoBackup tidak ditemukan.');
    }
    await telegramAutoBackup();
    logger.info('✅ [Cron] Backup otomatis selesai.');
  } catch (error) {
    logger.error(`❌ [Cron] Backup otomatis gagal: ${error.message}`);
    // ✅ FIX #8: Gunakan adminIds[0] yang sudah pasti string (USER_ID bisa array)
    const adminChatId = adminIds[0];
    if (adminChatId) {
      bot.telegram.sendMessage(
        adminChatId,
        `⚠️ *Alert Backup Gagal*\nJam ${new Date().getHours()}:00\nError: \`${error.message}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }
}, { scheduled: true, timezone: "Asia/Jakarta" });

// Nonaktifkan event kadaluarsa tiap tengah malam
cron.schedule('0 0 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  await dbRunAsync("UPDATE reseller_events SET is_active = 0 WHERE end_date < ?", [today]);
  logger.info("🧹 Cron: Event kadaluarsa dinonaktifkan.");
});

// Restart harian jam 04:00
cron.schedule('0 4 * * *', () => {
  logger.warn('🌀 Restart harian bot (jadwal 04:00)...');
  exec('pm2 restart sellvpn', async (err) => {
    if (err) {
      logger.error('❌ Gagal restart via PM2:', err.message);
    } else {
      logger.info('✅ Bot berhasil direstart oleh scheduler harian.');
      const restartMsg = `♻️ Bot di-restart otomatis (jadwal harian).\n🕓 Waktu: ${new Date().toLocaleString('id-ID')}`;
      try {
        await bot.telegram.sendMessage(GROUP_ID || adminIds[0], restartMsg);
      } catch (e) {
        logger.warn('⚠️ Gagal kirim notifikasi restart:', e.message);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Kirim warning ke reseller yang mendekati batas 60 hari — jam 09:00 WIB
// H-7 (hari ke-53 s/d 56) dan H-3 (hari ke-57 s/d 59)
// ─────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  logger.info('⏳ [Cron] Memulai pengecekan warning reseller (H-7 & H-3)...');
  try {
    // Warning H-7
    const warnH7 = await dbAllAsync(`
      SELECT user_id, username, first_name, saldo, reseller_since
      FROM users
      WHERE role = 'reseller'
        AND saldo < 30000
        AND reseller_since IS NOT NULL
        AND warned_h7 = 0
        AND (julianday('now') - julianday(reseller_since)) >= 53
        AND (julianday('now') - julianday(reseller_since)) < 57
    `);
    for (const user of (warnH7 || [])) {
      try {
        const namaUser    = user.first_name || user.username || `ID ${user.user_id}`;
        const saldoFmt    = Number(user.saldo || 0).toLocaleString('id-ID');
        const hariJalan   = Math.floor((Date.now() - new Date(user.reseller_since).getTime()) / 86400000);
        const hariSisa    = Math.max(0, 60 - hariJalan);
        const deadlineDate = new Date(user.reseller_since);
        deadlineDate.setDate(deadlineDate.getDate() + 60);
        const deadlineFmt = deadlineDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
        const pesan =
          `⚠️ <b>PERINGATAN — Status Reseller Hampir Dicabut</b>\n\n` +
          `Halo <b>${escapeHtml(namaUser)}</b>,\n\n` +
          `Saldo kamu saat ini <b>Rp ${saldoFmt}</b>, masih di bawah batas minimum <b>Rp 30.000</b>.\n\n` +
          `🗓 Status reseller kamu akan otomatis <b>dicabut dalam ±${hariSisa} hari</b> ` +
          `(sekitar <b>${deadlineFmt}</b>) jika saldo tidak segera ditambah.\n\n` +
          `Segera lakukan top up agar status reseller kamu tetap aktif!\n` +
          `Ketuk /start → Deposit untuk top up sekarang.`;
        await bot.telegram.sendMessage(user.user_id, pesan, { parse_mode: 'HTML' })
          .catch((e) => logger.warn(`⚠️ Gagal kirim warning H-7 ke ${user.user_id}: ${e.message}`));
        await dbRunAsync("UPDATE users SET warned_h7 = 1 WHERE user_id = ?", [user.user_id]);
        logger.info(`📢 [Cron] Warning H-7 terkirim ke reseller ${user.user_id}`);
      } catch (e) {
        logger.error(`❌ [Cron] Gagal proses warning H-7 user ${user.user_id}: ${e.message}`);
      }
    }
    // Warning H-3
    const warnH3 = await dbAllAsync(`
      SELECT user_id, username, first_name, saldo, reseller_since
      FROM users
      WHERE role = 'reseller'
        AND saldo < 30000
        AND reseller_since IS NOT NULL
        AND warned_h3 = 0
        AND (julianday('now') - julianday(reseller_since)) >= 57
        AND (julianday('now') - julianday(reseller_since)) < 60
    `);
    for (const user of (warnH3 || [])) {
      try {
        const namaUser    = user.first_name || user.username || `ID ${user.user_id}`;
        const saldoFmt    = Number(user.saldo || 0).toLocaleString('id-ID');
        const hariJalan   = Math.floor((Date.now() - new Date(user.reseller_since).getTime()) / 86400000);
        const hariSisa    = Math.max(0, 60 - hariJalan);
        const deadlineDate = new Date(user.reseller_since);
        deadlineDate.setDate(deadlineDate.getDate() + 60);
        const deadlineFmt = deadlineDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
        const pesan =
          `🚨 <b>PERINGATAN TERAKHIR — Status Reseller Hampir Dicabut!</b>\n\n` +
          `Halo <b>${escapeHtml(namaUser)}</b>,\n\n` +
          `Ini adalah <b>peringatan terakhir</b>!\n\n` +
          `Saldo kamu saat ini <b>Rp ${saldoFmt}</b>, masih di bawah batas minimum <b>Rp 30.000</b>.\n\n` +
          `🗓 Status reseller kamu akan <b>dicabut otomatis dalam ±${hariSisa} hari</b> ` +
          `(sekitar <b>${deadlineFmt}</b>).\n\n` +
          `⚡ <b>Segera top up sekarang</b> sebelum terlambat!\n` +
          `Ketuk /start → Deposit untuk top up sekarang.`;
        await bot.telegram.sendMessage(user.user_id, pesan, { parse_mode: 'HTML' })
          .catch((e) => logger.warn(`⚠️ Gagal kirim warning H-3 ke ${user.user_id}: ${e.message}`));
        await dbRunAsync("UPDATE users SET warned_h3 = 1 WHERE user_id = ?", [user.user_id]);
        logger.info(`📢 [Cron] Warning H-3 terkirim ke reseller ${user.user_id}`);
      } catch (e) {
        logger.error(`❌ [Cron] Gagal proses warning H-3 user ${user.user_id}: ${e.message}`);
      }
    }
    const totalWarn = (warnH7?.length || 0) + (warnH3?.length || 0);
    logger.info(totalWarn === 0
      ? '✅ [Cron] Tidak ada warning yang perlu dikirim.'
      : `🏁 [Cron] Selesai. Warning H-7: ${warnH7?.length || 0}, Warning H-3: ${warnH3?.length || 0}.`
    );
  } catch (err) {
    logger.error(`❌ [Cron] Error cron warning reseller: ${err.message}`);
  }
}, { scheduled: true, timezone: "Asia/Jakarta" });

// ─────────────────────────────────────────────────────────────
// Cek & cabut reseller otomatis setiap hari jam 03:00 WIB
// Syarat: saldo < 30.000 DAN sudah >= 60 hari sejak reseller_since
// ─────────────────────────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  logger.info('⏳ [Cron] Memulai pengecekan cabut reseller otomatis...');
  try {
    const toDowngrade = await dbAllAsync(`
      SELECT user_id, username, first_name, saldo, reseller_since
      FROM users
      WHERE role = 'reseller'
        AND saldo < 30000
        AND reseller_since IS NOT NULL
        AND (julianday('now') - julianday(reseller_since)) >= 60
    `);
    if (!toDowngrade || toDowngrade.length === 0) {
      logger.info('✅ [Cron] Tidak ada reseller yang perlu dicabut.');
      return;
    }
    logger.info(`🔍 [Cron] Ditemukan ${toDowngrade.length} reseller akan di-downgrade.`);
    for (const user of toDowngrade) {
      try {
        await dbRunAsync(
          "UPDATE users SET role = 'user', reseller_level = NULL, reseller_since = NULL, warned_h7 = 0, warned_h3 = 0 WHERE user_id = ?",
          [user.user_id]
        );
        const hariJalanLog = user.reseller_since
          ? Math.floor((Date.now() - new Date(user.reseller_since).getTime()) / 86400000)
          : null;
        await dbRunAsync(
          `INSERT INTO reseller_cabut_log (user_id, username, first_name, saldo_terakhir, reseller_since, hari_berjalan, alasan, dicabut_at)
           VALUES (?, ?, ?, ?, ?, ?, 'Saldo < Rp 30.000 selama 60 hari', datetime('now'))`,
          [user.user_id, user.username || null, user.first_name || null, user.saldo || 0, user.reseller_since || null, hariJalanLog]
        ).catch((e) => logger.warn(`⚠️ Gagal insert reseller_cabut_log: ${e.message}`));
        const namaUserRaw  = user.first_name || user.username || `ID ${user.user_id}`;
        const namaUser     = namaUserRaw;
        const namaUserGrup = maskUsername(namaUserRaw);
        const saldoFmt     = Number(user.saldo || 0).toLocaleString('id-ID');
        const upgradeSince = user.reseller_since
          ? new Date(user.reseller_since).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' })
          : '-';
        const pesanUser =
          `🔻 <b>Status Reseller Dicabut</b>\n\n` +
          `Halo <b>${escapeHtml(namaUser)}</b>,\n\n` +
          `Status reseller kamu telah <b>dicabut secara otomatis</b> karena saldo kamu ` +
          `berada di bawah <b>Rp 30.000</b> selama 60 hari sejak tanggal upgrade (<b>${upgradeSince}</b>).\n\n` +
          `💰 Saldo terakhir: <b>Rp ${saldoFmt}</b>\n\n` +
          `Untuk menjadi reseller kembali, silakan top up saldo dan lakukan upgrade ulang. ` +
          `Ketuk /start untuk memulai.`;
        await bot.telegram.sendMessage(user.user_id, pesanUser, { parse_mode: 'HTML' })
          .catch((e) => logger.warn(`⚠️ Gagal kirim notif cabut reseller ke ${user.user_id}: ${e.message}`));
        if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
          const pesanGrup =
            `🔻 <b>AUTO-CABUT RESELLER</b>\n\n` +
            `👤 User  : <b>${escapeHtml(namaUserGrup)}</b>\n` +
            `🆔 ID    : <code>${maskUserId(user.user_id)}</code>\n` +
            `📅 Sejak : ${upgradeSince}\n` +
            `💰 Saldo : Rp ${saldoFmt}\n` +
            `📌 Alasan: Saldo &lt; Rp 30.000 selama 60 hari`;
          // ✅ FIX #12: Guard GROUP_ID sebelum kirim notif cron cabut reseller
          if (GROUP_ID) {
            await bot.telegram.sendMessage(GROUP_ID, pesanGrup, { parse_mode: 'HTML' })
              .catch((e) => logger.warn(`⚠️ Gagal kirim notif cabut reseller ke grup: ${e.message}`));
          }
        }
        logger.info(`✅ [Cron] Reseller ${user.user_id} (${user.username || '-'}) berhasil di-downgrade.`);
      } catch (innerErr) {
        logger.error(`❌ [Cron] Gagal downgrade user ${user.user_id}: ${innerErr.message}`);
      }
    }
    logger.info(`🏁 [Cron] Selesai. Total di-downgrade: ${toDowngrade.length} reseller.`);
  } catch (err) {
    logger.error(`❌ [Cron] Error auto-cabut reseller: ${err.message}`);
  }
}, { scheduled: true, timezone: "Asia/Jakarta" });

// Auto-delete pesan terjadwal (setiap 20 detik)
cron.schedule('*/20 * * * * *', async () => {
  const now = Date.now();
  try {
    const rows = await dbAllAsync(
      `SELECT id, chat_id, message_id FROM pending_delete_messages
       WHERE deleted = 0 AND delete_at <= ?`,
      [now]
    );

    for (const row of rows) {
      try {
        await bot.telegram.deleteMessage(row.chat_id, row.message_id);
      } catch (e) { /* Pesan mungkin sudah dihapus */ }

      await dbRunAsync(
        `UPDATE pending_delete_messages SET deleted = 1 WHERE id = ?`,
        [row.id]
      );
    }
  } catch (err) {
    logger.error("Auto-delete worker error: " + err.message);
  }
});

// ===========================
// 📂 Load Modules
// ===========================
const { createzivpn } = require('./modules/createZIVPN');
const { renewzivpn }  = require('./modules/renewZIVPN');

const { createssh }         = require('./modules/createSSH');
const { createvmess }       = require('./modules/createVMESS');
const { createvless }       = require('./modules/createVLESS');
const { createtrojan }      = require('./modules/createTROJAN');
const { createshadowsocks } = require('./modules/createSHADOWSOCKS');

const { renewssh }         = require('./modules/renewSSH');
const { renewvmess }       = require('./modules/renewVMESS');
const { renewvless }       = require('./modules/renewVLESS');
const { renewtrojan }      = require('./modules/renewTROJAN');
const { renewshadowsocks } = require('./modules/renewSHADOWSOCKS');

const { deletessh }         = require('./modules/deletessh');
const { deletevmess }       = require('./modules/deletevmess');
const { deletevless }       = require('./modules/deletevless');
const { deletetrojan }      = require('./modules/deletetrojan');
const { deleteshadowsocks } = require('./modules/deleteshadowsocks');
const { deletezivpn }       = require('./modules/deletezivpn');


const {
    createsshWeb,
    createvmessWeb,
    createvlessWeb,
    createtrojanWeb,
    createshadowsocksWeb
} = require('./modulweb/apicreate-web');
const {
  createsshTrialWeb,
  createvmessTrialWeb,
  createvlessTrialWeb,
  createtrojanTrialWeb,
  createshadowsocksTrialWeb
} = require('./modulweb/apitrial-web');
// ===========================
// 🔑 State Management
// ===========================
const userState = {};
global.adminState = {};
// ✅ FIX #2: Inisialisasi global state agar tidak crash
global.pendingDeposits        = global.pendingDeposits        || {};
global.depositState           = global.depositState           || {};
global.processedTransactions  = global.processedTransactions  || new Set();
logger.info('User state initialized');

// ==========================================
// 🔧 HELPERS & UTILITIES
// ==========================================

// ---- Tanggal ----
function getExpiryDate(createdAt, days) {
  const date = new Date(createdAt);
  date.setDate(date.getDate() + parseInt(days));
  return date.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

async function getTodayIso() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---- Telegram Safe Send/Edit ----
async function safeSend(bot, chatId, message, extra = {}) {
  try {
    await bot.telegram.sendMessage(chatId, message, extra);
  } catch (err) {
    logger.warn(`⚠️ Gagal kirim ke ${chatId}: ${err.message}`);
  }
}



// ---- Channel ID Normalizer ----
function normalizeChannelId(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^https?:\/\/t\.me\//i, '');
  return s;
}

// ==========================================
// 🗄️ DATABASE UTILS
// ==========================================

// Bersihkan reseller_sales yang resellernya tidak ada di tabel users
function cleanupOrphanResellers() {
  db.all(
    `SELECT DISTINCT reseller_id FROM reseller_sales
     WHERE reseller_id NOT IN (SELECT user_id FROM users)`,
    (err, rows) => {
      if (err) return logger.error("❌ Gagal cek reseller yatim:", err.message);
      if (!rows.length) return logger.info("✅ Tidak ada reseller yatim.");

      const orphanIds  = rows.map(r => r.reseller_id);
      const placeholders = orphanIds.map(() => '?').join(',');
      logger.info("⚠️ Reseller yatim ditemukan: " + orphanIds.join(', '));

      db.run(
        `DELETE FROM reseller_sales WHERE reseller_id IN (${placeholders})`,
        orphanIds,
        function (err) {
          if (err) return logger.error("❌ Gagal hapus reseller yatim:", err.message);
          logger.info(`✅ ${this.changes} baris reseller_sales dibersihkan.`);
        }
      );
    }
  );
}

// Reconnect DB paksa (misal setelah restore backup)
async function reestablishDbConnection() {
  logger.warn('↻ Memperbarui koneksi database...');
  try {
    if (db && typeof db.close === 'function') {
      await new Promise((resolve) => {
        db.close((err) => {
          logger.info(err ? 'ℹ️ Koneksi DB lama sudah tertutup.' : '✔️ Koneksi DB lama ditutup.');
          resolve();
        });
      });
    }

    // Hapus sisa WAL/SHM agar tidak corrupt
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch (_) {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch (_) {}

    // Buka koneksi baru & simpan ke variabel global
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error('❌ Gagal membuka ulang koneksi DB:', err.message);
      } else {
        db.configure("busyTimeout", 5000);
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA synchronous = NORMAL;");
        logger.info(`✔️ Koneksi database diperbarui: ${DB_PATH}`);
      }
    });

    return true;
  } catch (err) {
    logger.error('❌ FATAL saat re-establish DB:', err.message);
    return false;
  }
}

// ---- Migrasi: kolom tambahan yang belum tentu ada di DB lama ----
// (Hanya untuk kolom yang TIDAK ada di CREATE TABLE awal, misal upgrade schema)
async function runMigrations() {
  const migrations = [
    // Tambahkan entry baru di sini jika ada schema upgrade ke depan
    // Format: { table, column, definition }
    { table: 'invoice_log',  column: 'config_text', definition: 'TEXT' },
    { table: 'invoice_log',  column: 'expired_at',  definition: "TEXT GENERATED ALWAYS AS (date(created_at, '+' || hari || ' days')) VIRTUAL" },
  ];

  for (const m of migrations) {
    try {
      await dbRunAsync(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
      logger.info(`✅ Migrasi: kolom '${m.column}' ditambahkan ke '${m.table}'.`);
    } catch (err) {
      if (err.message.includes('duplicate column name') || err.message.includes('already exists')) {
        logger.info(`ℹ️ Migrasi: '${m.column}' di '${m.table}' sudah ada, dilewati.`);
      } else {
        logger.error(`❌ Migrasi gagal (${m.table}.${m.column}): ${err.message}`);
      }
    }
  }

  // Migrasi: update reference_id yang masih NULL
  try {
    const rows = await dbAllAsync(
      "SELECT id, user_id, type, timestamp FROM transactions WHERE reference_id IS NULL"
    );
    for (const row of rows) {
      const referenceId = `account-${row.type}-${row.user_id}-${row.timestamp}`;
      await dbRunAsync("UPDATE transactions SET reference_id = ? WHERE id = ?", [referenceId, row.id]);
    }
    if (rows.length) logger.info(`🔄 Migrasi reference_id: ${rows.length} baris diperbarui.`);
  } catch (err) {
    logger.error('Migrasi reference_id error: ' + err.message);
  }

  logger.info('✅ Semua migrasi selesai.');
}

// ==========================================
// 👤 USER HELPERS
// ==========================================

async function getUserDetails(userId) {
  try {
    const row = await dbGetAsync(
      'SELECT saldo, role, reseller_level FROM users WHERE user_id = ?',
      [userId]
    );
    return row || { saldo: 0, role: 'user', reseller_level: 'silver' };
  } catch (e) {
    logger.error('getUserDetails error: ' + e.message);
    return { saldo: 0, role: 'user', reseller_level: 'silver' };
  }
}

async function hasEverTrial(userId) {
  const row = await dbGetAsync(
    'SELECT COUNT(*) AS c FROM trial_logs WHERE user_id = ?', [userId]
  );
  return (row?.c || 0) > 0;
}

async function hasEverTopup(userId) {
  const row = await dbGetAsync(
    'SELECT COUNT(*) AS c FROM topup_log WHERE user_id = ?', [userId]
  );
  return (row?.c || 0) > 0;
}

// ---- Trial Logic ----
async function canTakeTrial(userId) {
  const user = await dbGetAsync(
    'SELECT role, last_trial_date, trial_count_today FROM users WHERE user_id = ?',
    [userId]
  );
  if (!user) return { allowed: false, reason: 'USER_NOT_FOUND' };

  const role = user.role || 'user';
  
  // 1. Jika dia member biasa ('user'), cek apakah sudah PERNAH trial seumur hidup
  if (role === 'user') {
    const everTrial = await dbGetAsync(
      'SELECT COUNT(*) AS c FROM trial_logs WHERE user_id = ?', 
      [userId]
    );
    if ((everTrial?.c || 0) > 0) {
      return { allowed: false, reason: 'MEMBER_ONLY_ONCE' }; // Langsung kick, gak boleh trial lagi!
    }
    // Jika belum pernah sama sekali, kasih jatah 1
    return { allowed: true, trialCount: 0, maxTrial: 1, role, last: null };
  }

  // 2. Jika dia Admin atau Reseller Aktif, berlakukan limit harian (20 akun/hari)
  const maxTrial = 20;
  const last     = user.last_trial_date;
  const currentCount = user.trial_count_today || 0;

  if (!last) return { allowed: true, trialCount: 0, maxTrial, role, last: null };

  const nowWIB  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const lastWIB = new Date(`${last}T00:00:00+07:00`);
  const diffDays = Math.floor((nowWIB - lastWIB) / (1000 * 60 * 60 * 24));

  if (diffDays >= 1) {
    // Reset hitungan hari baru untuk reseller/admin
    return { allowed: true, trialCount: 0, maxTrial, role, last };
  }

  return { allowed: currentCount < maxTrial, trialCount: currentCount, maxTrial, role, last };
}

async function claimTrialAtomic(userId) {
  const check = await canTakeTrial(userId);
  if (!check.allowed) return { ok: false, reason: 'LIMIT_REACHED' };

  const today    = new Date().toISOString().split('T')[0];
  const newCount = check.trialCount + 1;

  await dbRunAsync(
    'UPDATE users SET trial_count_today = ?, last_trial_date = ? WHERE user_id = ?',
    [newCount, today, userId]
  );
  return { ok: true, trialKe: newCount };
}

// ---- Event Progress ----
async function updateEventProgress(userId, days) {
  try {
    const MIN_DAYS = 15;
    if (parseInt(days) < MIN_DAYS) return;

    const activeEvent = await dbGetAsync(
      "SELECT * FROM reseller_events WHERE is_active = 1 AND date('now') <= end_date LIMIT 1"
    );
    if (!activeEvent) return;

    await dbRunAsync(`
      INSERT INTO reseller_event_progress (user_id, event_id, current_sales)
      VALUES (?, ?, 1)
      ON CONFLICT(user_id, event_id)
      DO UPDATE SET current_sales = current_sales + 1
      WHERE is_claimed = 0
        AND current_sales < (SELECT target_penjualan FROM reseller_events WHERE id = ?)
    `, [userId, activeEvent.id, activeEvent.id]);

    logger.info(`[EVENT] Progres User ${userId} diupdate.`);
  } catch (err) {
    logger.error('❌ Error update event progress: ' + err.message);
  }
}

// ---- Auto-Delete Helper ----
async function addPendingDelete(chatId, messageId, deleteAt) {
  await dbRunAsync(
    `INSERT INTO pending_delete_messages (chat_id, message_id, delete_at, deleted)
     VALUES (?, ?, ?, 0)`,
    [chatId, messageId, deleteAt]
  );
}

// ==========================================
// 📄 RENDER PAGES (UI Telegram)
// ==========================================

async function renderRenewPage(ctx, userId, page) {
  const itemsPerPage = 10;
  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery('Memperbarui daftar...').catch(() => {});
    }

    const dbAccounts = await dbAllAsync(
      `SELECT i.akun, i.protocol, s.id AS server_id, s.nama_server, s.domain, s.auth
       FROM invoice_log i
       INNER JOIN Server s ON i.layanan = s.nama_server
       WHERE i.user_id = ?
         AND date(i.created_at, '+' || i.hari || ' days') >= date('now')
       GROUP BY LOWER(i.akun), i.protocol, s.id
       ORDER BY i.id DESC`,
      [userId]
    );

    if (!dbAccounts.length) {
      return safeMenuSend(ctx,
        '<b>⚠️ TIDAK ADA AKUN AKTIF</b>\nKamu tidak memiliki akun yang aktif atau semua akun sudah expired.',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'send_main_menu' }]] } }
      );
    }

    // Validasi live ke VPS, dikelompokkan per server untuk efisiensi
    const validAccounts  = [];
    const serverGroups   = dbAccounts.reduce((acc, item) => {
      if (!acc[item.server_id]) acc[item.server_id] = { info: item, accounts: [] };
      acc[item.server_id].accounts.push(item);
      return acc;
    }, {});

    // ✅ FIX #10: Jalankan validasi semua server secara PARALLEL (bukan serial)
    const serverCheckPromises = Object.values(serverGroups).map(async ({ info: server, accounts }) => {
      try {
        const protocols = [...new Set(accounts.map(a => (a.protocol || 'ssh').toLowerCase()))];
        const protoResults = await Promise.all(protocols.map(async (proto) => {
          try {
            const res = await axios.get(`http://${server.domain}:5888/list`, {
              params: { type: proto, auth: server.auth },
              timeout: 8000
            });
            if (res.data?.status === 'success' && Array.isArray(res.data.data)) {
              const serverUsernames = res.data.data.map(line => {
                const match = line.match(/User:\s*([^\s|]+)/i) || line.match(/^([^\s|]+)/);
                return match ? match[1].toLowerCase().trim() : line.toLowerCase().trim();
              });
              return accounts.filter(a =>
                (a.protocol || 'ssh').toLowerCase() === proto &&
                serverUsernames.includes(a.akun.toLowerCase().trim())
              );
            }
            return [];
          } catch {
            // Proto gagal → kembalikan akun DB sebagai cadangan
            return accounts.filter(a => (a.protocol || 'ssh').toLowerCase() === proto);
          }
        }));
        return protoResults.flat();
      } catch {
        // Server down → tampilkan data DB sebagai cadangan
        return accounts;
      }
    });
    const allValid = await Promise.all(serverCheckPromises);
    validAccounts.push(...allValid.flat());

    if (!validAccounts.length) {
      return safeMenuSend(ctx,
        '<b>⚠️ AKUN TIDAK DITEMUKAN</b>\nAkun kamu terdeteksi sudah tidak ada di server.',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'send_main_menu' }]] } }
      );
    }

    const totalPages  = Math.ceil(validAccounts.length / itemsPerPage);
    const currentPage = Math.min(Math.max(page, 1), totalPages);
    const paginatedItems = validAccounts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    const buttons = paginatedItems.map(item => ([{
      text: `👤 ${item.akun} | ${item.nama_server}`,
      callback_data: `res_ren:${(item.protocol || 'ssh').toLowerCase()}:${item.akun}:${item.server_id}`
    }]));

    const navRow = [];
    if (currentPage > 1)          navRow.push({ text: '◀️ Prev', callback_data: `ren_page_${currentPage - 1}` });
    if (currentPage < totalPages)  navRow.push({ text: 'Next ▶️', callback_data: `ren_page_${currentPage + 1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: '🔙 KEMBALI', callback_data: 'send_main_menu' }]);

    await safeMenuSend(ctx,
      `<b>🔄 RENEW AKUN AKTIF (LIVE)</b>\n` +
      `Pilih akun yang ingin diperpanjang:\n\n` +
      `<i>Halaman ${currentPage} / ${totalPages}</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('renderRenewPage error: ' + err.message);
  }
}

async function renderDeletePage(ctx, userId, page) {
  const itemsPerPage = 10;
  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery('Mengecek data ke server...').catch(() => {});
    }

    // 1. Ambil data dari DB dulu (Akun < 24 jam)
    const dbAccounts = await dbAllAsync(
      `SELECT i.akun, i.protocol, s.id AS server_id, s.nama_server, s.domain, s.auth
       FROM invoice_log i
       INNER JOIN Server s ON i.layanan = s.nama_server
       WHERE i.user_id = ?
         AND i.hari > 0
         AND (strftime('%s', 'now') - strftime('%s', i.created_at)) / 3600 < 24
       GROUP BY LOWER(i.akun), i.protocol, s.id
       ORDER BY i.id DESC`,
      [userId]
    );

    if (!dbAccounts.length) {
      return safeMenuSend(ctx, 
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n<b>⚠️ TIDAK ADA AKUN</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n<blockquote>Garansi refund 24 jam sudah habis atau tidak ada akun baru.</blockquote>`, 
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'send_main_menu' }]] } }
      );
    }

    // 2. Validasi ke API Server secara Paralel (Biar Cepat)
    const validAccounts = [];
    const serverPromises = dbAccounts.map(async (item) => {
      try {
        const res = await axios.get(`http://${item.domain}:5888/list`, {
          params: { type: item.protocol.toLowerCase(), auth: item.auth },
          timeout: 5000 // Timeout 5 detik saja biar gak kelamaan
        });

        if (res.data?.status === "success" && Array.isArray(res.data.data)) {
          // Cek apakah username ada di dalam list data dari server
          const exists = res.data.data.some(line => 
            line.toLowerCase().includes(item.akun.toLowerCase().trim())
          );
          if (exists) return item;
        }
      } catch (e) {
        // Jika server down, tetap tampilkan agar user bisa hapus (biar gak rugi)
        return item;
      }
      return null;
    });

    const results = await Promise.all(serverPromises);
    validAccounts.push(...results.filter(acc => acc !== null));

    if (!validAccounts.length) {
      return safeMenuSend(ctx, 
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n<b>⚠️ AKUN TIDAK DITEMUKAN</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━\n<blockquote>Akun sudah terhapus di server atau data tidak sinkron.</blockquote>`, 
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'send_main_menu' }]] } }
      );
    }

    // 3. Tampilkan dengan gaya <blockquote> dan Garansi
    const totalPages  = Math.ceil(validAccounts.length / itemsPerPage);
    const currentPage = Math.min(Math.max(page, 1), totalPages);
    const paginatedItems = validAccounts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

    const buttons = paginatedItems.map(item => ([{
      text: `🗑️ [${item.protocol.toUpperCase()}] ${item.akun}`,
      callback_data: `del_ask:${item.protocol.toLowerCase()}:${item.akun}:${item.server_id}`
    }]));

    const navRow = [];
    if (currentPage > 1) navRow.push({ text: '◀️ Prev', callback_data: `del_page_${currentPage - 1}` });
    if (currentPage < totalPages) navRow.push({ text: 'Next ▶️', callback_data: `del_page_${currentPage + 1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: '🔙 KEMBALI', callback_data: 'send_main_menu' }]);

    const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━
 <b>🗑️ DELETE & REFUND SYSTEM</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>User ID :</b> <code>${userId}</code>
📊 <b>Daftar Akun :</b>
<blockquote>Pilih akun yang ingin dihapus. Saldo otomatis kembali 100% ke akun Anda.</blockquote>
⚠️ <b>Catatan:</b>
<blockquote>Hanya muncul jika umur akun &lt; 24 jam.</blockquote>
<i>Halaman ${currentPage} / ${totalPages}</i>
`.trim();

    await safeMenuSend(ctx, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });

  } catch (err) {
    logger.error('renderDeletePage error: ' + err.message);
    ctx.reply("❌ Database/API sedang sibuk. Coba lagi nanti.").catch(() => {});
  }
}
// ==========================================
// 🌐 EXPRESS WEBSITE
// ==========================================
app.use(express.static('public'));

// ==========================================
// 🌐 EXPRESS ENDPOINTS
// ==========================================
// --- WEBHOOK DIGIFLAZZ ---
app.post('/webhook/digiflazz', async (req, res) => {
  try {
    const payload = req.body;
    const d = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    
    if (!d || !d.ref_id) return res.status(400).send('No Data');

    const { ref_id, status, sn, message } = d;
    const statusLower = status.toLowerCase();

    const maskTarget = (num) => {
      const s = String(num);
      if (s.length < 8) return s; 
      return s.slice(0, 4) + '*****' + s.slice(-3);
    };

    const trx = await dbGetAsync('SELECT * FROM ppob_transactions WHERE ref_id = ?', [ref_id]);
    
    if (trx) {
      const oldStatus = trx.status ? trx.status.toUpperCase() : 'PENDING';

      await dbRunAsync('UPDATE ppob_transactions SET status = ?, sn = ? WHERE ref_id = ?', [status.toUpperCase(), sn || '', ref_id]);

      const isWeb = trx.source === 'web';
      
      // ⏱️ FIX JAM ASIA/JAKARTA (Garansi sinkron dengan waktu lokal VPS)
      const formatter = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
      const timestamp = formatter.format(new Date()).replace(',', '').replace(/\./g, ':');

      const targetSensor = maskTarget(trx.target);
      let groupMsg = '';

      // Inisialisasi variabel data user untuk group notification
      let maskedTelegramUser = '-';
      let maskedId = '-';
      let maskedWebEmail = '-';

      if (isWeb) {
        const webUser = await dbGetAsync('SELECT email FROM web_users WHERE id = ?', [trx.web_user_id]);
        maskedWebEmail = maskEmail(webUser ? webUser.email : 'user@web.com');
      } else if (trx.user_id) {
        const trxUser = await dbGetAsync(
          'SELECT username, first_name FROM users WHERE user_id = ?',
          [trx.user_id]
        );
        const rawName = trxUser?.username || trxUser?.first_name || `ID ${trx.user_id}`;
        maskedTelegramUser = escapeHtml(maskUsername(rawName));
        maskedId = maskUserId(trx.user_id);
      }

      // -------------------------------------------------------
      // 🟢 SUKSES
      // -------------------------------------------------------
      if (statusLower === 'sukses' || statusLower === 'success') {
        
        if (!isWeb && trx.user_id) {
          const msgUser = `<b>✅ TRANSAKSI SUKSES!</b>\n\n📦 Produk: <b>${trx.sku}</b>\n🎯 Tujuan: <code>${trx.target}</code>\n🎟 SN: <code>${sn}</code>\n\n<i>Terima kasih telah bertransaksi!</i>`;
          await bot.telegram.sendMessage(trx.user_id, msgUser, { parse_mode: 'HTML' }).catch(() => {});
        }

        if (GROUP_ID) {
          if (isWeb) {
            groupMsg = `
━━━━━━━━━━━━━━━━━━━━━
<b>✅ PEMBELIAN PPOB SUCCESS (WEB)</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>📦 <b>Produk :</b> ${trx.sku}
🎯 <b>Tujuan :</b> <code>${targetSensor}</code>
💰 <b>Harga  :</b> Rp ${trx.price.toLocaleString('id-ID')}
📋 <b>Ref ID :</b> <code>${ref_id}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━
📧 <b>User  :</b> <code>${maskedWebEmail}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>
`.trim();

          } else {
            groupMsg = `
━━━━━━━━━━━━━━━━━━━━━
<b>✅ PEMBELIAN PPOB SUCCESS (BOT)</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>📦 <b>Produk :</b> ${trx.sku}
🎯 <b>Tujuan :</b> <code>${targetSensor}</code>
💰 <b>Harga  :</b> Rp ${trx.price.toLocaleString('id-ID')}
📋 <b>Ref ID :</b> <code>${ref_id}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> <code>${maskedTelegramUser}</code>
🆔 <b>ID    :</b> <code>${maskedId}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>
`.trim();
          }

          await bot.telegram.sendMessage(GROUP_ID, groupMsg, { parse_mode: 'HTML' })
            .catch((e) => logger.error(`❌ Gagal kirim notif PPOB sukses ke grup: ${e.message}`));
        }
      }

      // -------------------------------------------------------
      // 🔴 GAGAL (REFUND)
      // -------------------------------------------------------
      else if (statusLower === 'gagal' || statusLower === 'failure' || statusLower === 'gagal_provider') {
        
        if (oldStatus !== 'GAGAL') { 
          
          if (isWeb) {
            await dbRunAsync('UPDATE web_users SET balance = balance + ? WHERE id = ?', [trx.price, trx.web_user_id]);
          } else {
            await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [trx.price, trx.user_id]);
            
            const msgUser = `<b>❌ TRANSAKSI GAGAL</b>\n\nProduk: ${trx.sku}\nAlasan: ${message}\n✅ Saldo Rp ${trx.price.toLocaleString('id-ID')} dikembalikan.`;
            await bot.telegram.sendMessage(trx.user_id, msgUser, { parse_mode: 'HTML' }).catch(() => {});
          }

          if (GROUP_ID) {
            if (isWeb) {
              groupMsg = `
━━━━━━━━━━━━━━━━━━━━━
<b>❌ PEMBELIAN PPOB GAGAL (WEB)</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>📦 <b>Produk :</b> ${trx.sku}
🎯 <b>Tujuan :</b> <code>${targetSensor}</code>
📋 <b>Ref ID :</b> <code>${ref_id}</code>
📝 <b>Alasan :</b> ${message || 'Dibatalkan Provider'}
🛡️ <b>Status :</b> <b>REFUNDED ✅</b></blockquote>
━━━━━━━━━━━━━━━━━━━━━
📧 <b>User  :</b> <code>${maskedWebEmail}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>
`.trim();

            } else {
              groupMsg = `
━━━━━━━━━━━━━━━━━━━━━
<b>❌ PEMBELIAN PPOB GAGAL (BOT)</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>📦 <b>Produk :</b> ${trx.sku}
🎯 <b>Tujuan :</b> <code>${targetSensor}</code>
📋 <b>Ref ID :</b> <code>${ref_id}</code>
📝 <b>Alasan :</b> ${message || 'Dibatalkan Provider'}
🛡️ <b>Status :</b> <b>REFUNDED ✅</b></blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> <code>${maskedTelegramUser}</code>
🆔 <b>ID    :</b> <code>${maskedId}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>
`.trim();
            }

            await bot.telegram.sendMessage(GROUP_ID, groupMsg, { parse_mode: 'HTML' })
              .catch((e) => logger.error(`❌ Gagal kirim notif PPOB gagal ke grup: ${e.message}`));
          }
        }
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    logger.error('Webhook Digiflazz Error: ' + err.message);
    res.status(500).send('Error');
  }
});

app.post('/webhook/pakasir', async (req, res) => {

  try {

    const payload = req.body;

    logger.info(
      `Webhook received: ${JSON.stringify(payload)}`
    );

    if (
      !payload?.order_id ||
      !payload?.amount ||
      !payload?.status
    ) {

      return res.status(400).json({
        error: 'Invalid webhook payload structure.'
      });

    }

    // proses webhook
    await handlePakasirWebhook(payload, bot);

    return res.json({
      success: true
    });

  } catch (err) {

    logger.error(
      'Webhook Pakasir Error: ' +
      (err?.message || err)
    );

    return res.status(500).json({
      success: false
    });

  }

});

app.get('/topup-success', async (req, res) => {
  try {
    // Menangkap order_id yang dilempar balik oleh Pakasir di URL
    // Contoh dari Pakasir: /topup-success?order_id=WEB-123-1718466123
    const orderId = req.query.order_id || req.query.orderId;

    if (!orderId) {
      // Fallback jika diakses langsung tanpa order_id
      return res.sendFile(path.join(__dirname, 'public', 'topup-success.html'));
    }

    // Ambil data dari database berdasarkan order_id untuk mengambil jumlah amount aslinya
    db.get(
      `SELECT amount FROM pending_deposits_pakasir WHERE order_id = ?`,
      [orderId],
      (err, row) => {
        if (err || !row) {
          // Jika tidak ketemu di DB, kirim file html biasa tanpa parameter tambahan
          return res.sendFile(path.join(__dirname, 'public', 'topup-success.html'));
        }

        // Ambil nominal amount-nya
        const amount = row.amount;

        // Redirect secara internal atau biarkan frontend membaca window.location.search
        // Kita langsung kirim filenya saja, karena frontend nanti bisa membaca query string di browser
        return res.sendFile(path.join(__dirname, 'public', 'topup-success.html'));
      }
    );
  } catch (err) {
    console.error(err);
    res.sendFile(path.join(__dirname, 'public', 'topup-success.html'));
  }
});

// --- FUNGSI RENDER LAPORAN PPOB ADMIN ---
async function renderAdminPPOB(ctx, page) {
  const limit = 5; // Tampilkan 5 data per halaman biar gak kepanjangan di HP
  const offset = (page - 1) * limit;

  try {
    // 1. Ambil Total Data buat hitung total halaman
    const totalData = await dbGetAsync("SELECT COUNT(*) as count FROM ppob_transactions");
    const totalPages = Math.ceil(totalData.count / limit);

    // 2. Ambil Data per halaman dengan LEFT JOIN agar nama user web & bot langsung dapat
    const rows = await dbAllAsync(
      `SELECT t.*, 
              u.username AS tg_username, u.first_name AS tg_first_name,
              w.email AS web_email
       FROM ppob_transactions t
       LEFT JOIN users u ON t.user_id = u.user_id
       LEFT JOIN web_users w ON t.web_user_id = w.id
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    if (!rows || rows.length === 0) {
      return ctx.reply("📭 Belum ada transaksi PPOB.");
    }

    let report = `<b>📊 LAPORAN PPOB GLOBAL</b>\n`;
    report += `<i>Halaman ${page} dari ${totalPages}</i>\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    rows.forEach((r, i) => {
      const num = offset + i + 1;
      const statusIcon = r.status.toLowerCase() === 'sukses' ? '✅' : (r.status.toLowerCase() === 'gagal' ? '❌' : '⏳');
      
      // 👤 LOGIKA DETEKSI USER (BOT vs WEB)
      let infoUser = 'Tidak diketahui';
      if (r.source === 'web') {
        // Jika dari web, tampilkan email user webnya
        infoUser = r.web_email ? `${r.web_email} (Web)` : `Web User ID ${r.web_user_id}`;
      } else {
        // Jika dari bot, tampilkan username, first_name, atau user_id Telegramnya
        const tgName = r.tg_username || r.tg_first_name;
        infoUser = tgName ? `${tgName} (${r.user_id})` : `${r.user_id}`;
      }

      // Memformat waktu dari data database 'created_at' agar akurat ke WIB (UTC+7)
      let waktuTrx = 'Tidak diketahui';
      if (r.created_at) {
        let rawDate = r.created_at;
        if (!rawDate.endsWith('Z') && !rawDate.includes('UTC') && !rawDate.includes('+')) {
          rawDate = rawDate.replace(' ', 'T') + 'Z';
        }

        const dateObj = new Date(rawDate);

        if (!isNaN(dateObj.getTime())) {
          waktuTrx = dateObj.toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            hour12: false,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).replace(/\./g, ':') + ' WIB';
        } else {
          waktuTrx = r.created_at;
        }
      }

      report += `${num}. ${statusIcon} <b>${r.status}</b>\n`;
      report += `<blockquote>`;
      report += `👤 <b>User  :</b> <code>${escapeHtml(infoUser)}</code>\n`; // Menghindari crash parse HTML jika email mengandung karakter khusus
      report += `📦 <b>Item  :</b> ${r.sku}\n`;
      report += `🎯 <b>Dest  :</b> <code>${r.target}</code>\n`;
      report += `🆔 <b>Ref   :</b> <code>${r.ref_id}</code>\n`;
      report += `🕒 <b>Waktu :</b> <code>${waktuTrx}</code>`; 
      report += `</blockquote>\n`;
    });

    report += `━━━━━━━━━━━━━━━━━━━━━`;

    // 3. Buat Tombol Navigasi
    const buttons = [];
    const navRow = [];
    
    if (page > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `cekppob_page_${page - 1}` });
    }
    if (page < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `cekppob_page_${page + 1}` });
    }
    
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔄 Refresh', callback_data: `cekppob_page_${page}` }]);

    const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } };

    await safeMenuSend(ctx, report, options);

  } catch (err) {
    logger.error('Error renderAdminPPOB: ' + err.message);
    ctx.reply("❌ Gagal memuat laporan.");
  }
}

// --- ACTION HANDLER UNTUK TOMBOL ---
bot.action(/^cekppob_page_(\d+)$/, async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!adminIds.includes(adminId)) return ctx.answerCbQuery("🚫 Akses Ditolak");
  
  const page = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`Memuat Halaman ${page}...`);
  return renderAdminPPOB(ctx, page);
});
// ==========================================
// 🤖 TELEGRAM ACTION: Check Join Channel
// ==========================================

const REQUIRED_CHANNEL = GROUP_ID || null;

bot.action('check_join_channel', async (ctx) => {
  try {
    const userId  = ctx.from.id;
    const channel = normalizeChannelId(REQUIRED_CHANNEL);

    if (!channel) {
      return ctx.answerCbQuery('⚠️ Group belum dikonfigurasi. Hubungi admin.', { show_alert: true });
    }

    let member;
    try {
      member = await bot.telegram.getChatMember(channel, userId);
    } catch (err) {
      logger.warn('getChatMember error: ' + (err.message || err));
      return ctx.answerCbQuery('⚠️ Gagal cek keanggotaan. Coba lagi nanti.', { show_alert: true });
    }

    const status = member?.status || 'left';
    if (['creator', 'administrator', 'member', 'restricted'].includes(status)) {
      await ctx.answerCbQuery('✅ Terima kasih, verifikasi berhasil!');
      return sendMainMenu(ctx);
    }

    await ctx.answerCbQuery('🚫 Kamu belum bergabung di group kami.', { show_alert: true });
  } catch (err) {
    logger.error('Error check_join_channel: ' + (err.message || err));
  }
});

// ==========================================
// 🚀 STARTUP CALLS
// ==========================================

// Jalankan saat bot pertama kali naik
(async () => {
  await runMigrations();
  cleanupOrphanResellers();
  await updateGlobalCache();
})();

// Handler Tambah Saldo via ID (Khusus Admin)
bot.command('add', async (ctx) => {
  const adminId = String(ctx.from.id);
  
  // Pastikan adminIds sudah terdefinisi di app.js kamu (dari vars.USER_ID)
  if (!adminIds.includes(adminId)) return;

  const args = ctx.message.text.split(' ');
  
  // Validasi format: /add [ID] [JUMLAH]
  if (args.length < 3) {
    return ctx.reply('❌ **Format Salah!**\n\n' +
                     'Gunakan format: `/add [ID_USER] [JUMLAH]`\n' +
                     'Contoh: `/add 12345678 50000`', { parse_mode: 'Markdown' });
  }

  const targetId = args[1];
  const amount = parseInt(args[2]);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('⚠️ Masukkan nominal saldo yang valid (angka saja).');
  }

  try {
    // 1. Update saldo di tabel users
    const result = await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetId]);
    // Reset flag warning + perpanjang 60 hari jika saldo reseller >= 30.000 dan top up >= 20.000
    if (amount >= 20000) await dbRunAsync("UPDATE users SET warned_h7 = 0, warned_h3 = 0, reseller_since = datetime('now') WHERE user_id = ? AND saldo >= 30000 AND role = 'reseller'", [targetId]).catch(() => {});

    if (result.changes === 0) {
      return ctx.reply('❌ **Gagal!** User ID `' + targetId + '` tidak ditemukan di database.', { parse_mode: 'Markdown' });
    }

    // 2. Ambil data terbaru untuk konfirmasi
    const user = await dbGetAsync('SELECT username, first_name, saldo FROM users WHERE user_id = ?', [targetId]);
    const name = user.username ? `@${user.username}` : (user.first_name || targetId);

    // 3. Balasan ke Admin
    ctx.reply(`✅ **BERHASIL TAMBAH SALDO**\n\n` +
              `👤 User: ${name}\n` +
              `🆔 ID: <code>${targetId}</code>\n` +
              `💰 Masuk: Rp ${amount.toLocaleString('id-ID')}\n` +
              `💳 Total Saldo: Rp ${user.saldo.toLocaleString('id-ID')}`, { parse_mode: 'HTML' });

    // 4. Notifikasi ke User (Opsional tapi disarankan)
    bot.telegram.sendMessage(targetId, `🎉 **Saldo Berhasil Ditambahkan!**\n\n` +
                                     `Admin telah menambahkan saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* ke akun Anda.\n` +
                                     `Sisa saldo Anda sekarang: *Rp ${user.saldo.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' })
    .catch(() => logger.warn(`Gagal kirim notif ke user ${targetId}`));

  } catch (err) {
    logger.error('Error add saldo manual: ' + err.message);
    ctx.reply('❌ Terjadi kesalahan saat memproses database.');
  }
});
//PPOB
bot.command('cekppob', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!adminIds.includes(adminId)) return;

  // Kita panggil fungsi render halaman 1
  return renderAdminPPOB(ctx, 1);
});
// Handler Kurangi Saldo via ID (Khusus Admin)
bot.command('kurang', async (ctx) => {
  const adminId = String(ctx.from.id);
  
  // Pastikan adminIds sesuai dengan config kamu
  if (!adminIds.includes(adminId)) return;

  const args = ctx.message.text.split(' ');
  
  // Validasi format: /kurang [ID] [JUMLAH]
  if (args.length < 3) {
    return ctx.reply('❌ **Format Salah!**\n\n' +
                     'Gunakan format: `/kurang [ID_USER] [JUMLAH]`\n' +
                     'Contoh: `/kurang 12345678 5000`', { parse_mode: 'Markdown' });
  }

  const targetId = args[1];
  const amount = parseInt(args[2]);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('⚠️ Masukkan nominal saldo yang valid (angka saja).');
  }

  try {
    // 1. Cek dulu saldo user sekarang, jangan sampai minus kalau tidak diinginkan
    const userBefore = await dbGetAsync('SELECT saldo, username, first_name FROM users WHERE user_id = ?', [targetId]);
    
    if (!userBefore) {
      return ctx.reply('❌ **Gagal!** User ID `' + targetId + '` tidak ditemukan.', { parse_mode: 'Markdown' });
    }

    if (userBefore.saldo < amount) {
      return ctx.reply(`⚠️ **Saldo Tidak Cukup!**\n\nSaldo user saat ini: Rp ${userBefore.saldo.toLocaleString('id-ID')}\nJumlah yang ingin dikurangi: Rp ${amount.toLocaleString('id-ID')}`);
    }

    // 2. Eksekusi pengurangan saldo
    await dbRunAsync('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [amount, targetId]);
    
    // 3. Ambil data terbaru
    const userAfter = await dbGetAsync('SELECT saldo FROM users WHERE user_id = ?', [targetId]);
    const name = userBefore.username ? `@${userBefore.username}` : (userBefore.first_name || targetId);

    // 4. Balasan ke Admin
    ctx.reply(`✅ **BERHASIL KURANGI SALDO**\n\n` +
              `👤 User: ${name}\n` +
              `🆔 ID: <code>${targetId}</code>\n` +
              `🔻 Berkurang: Rp ${amount.toLocaleString('id-ID')}\n` +
              `💳 Sisa Saldo: Rp ${userAfter.saldo.toLocaleString('id-ID')}`, { parse_mode: 'HTML' });

    // 5. Notifikasi ke User
    bot.telegram.sendMessage(targetId, `⚠️ **Saldo Anda Telah Dikurangi**\n\n` +
                                     `Admin telah mengurangi saldo akun Anda sebesar *Rp ${amount.toLocaleString('id-ID')}*.\n` +
                                     `Sisa saldo Anda sekarang: *Rp ${userAfter.saldo.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' })
    .catch(() => logger.warn(`Gagal kirim notif ke user ${targetId}`));

  } catch (err) {
    logger.error('Error kurang saldo: ' + err.message);
    ctx.reply('❌ Terjadi kesalahan saat memproses database.');
  }
});

// Override /start dan /menu untuk mewajibkan join GROUP_ID
bot.command(['start', 'menu'], async (ctx) => {
  const chatType = ctx.chat.type;

  // 🚫 Blokir /start di GROUP
  if (chatType === 'group' || chatType === 'supergroup') {
    try {
      await ctx.reply('⚠️ Perintah ini tidak dapat digunakan di dalam grup.\nSilakan chat bot secara pribadi.');
      
      await ctx.telegram.sendMessage(
        ctx.from.id,
        '👋 Silakan gunakan bot lewat private chat.\nKetik /start untuk memulai.'
      );
    } catch (e) {
      logger.error('❗ Gagal kirim DM: ' + e.message);
    }
    return;
  }

  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';

  try {
    await dbRunAsync(`
      INSERT INTO users (user_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = ?, first_name = ?
    `, [userId, username, firstName, username, firstName]);

    // ✅ SELIPKAN DI SINI: Update cache setiap ada aktivitas user masuk
    // Ini bikin angka "Total Member" di dashboard langsung akurat (Satset!)
    updateGlobalCache(); 

  } catch (err) {
    logger.warn('Failed to insert/update user on start/menu: ' + (err.message || err));
  }

  // Jika REQUIRED_CHANNEL tidak diset → langsung kirim menu
  if (!REQUIRED_CHANNEL) {
    return sendMainMenu(ctx);
  }

  // 🔍 Cek apakah user sudah join channel
  const channelIdOrUsername = normalizeChannelId(REQUIRED_CHANNEL);

  try {
    const member = await bot.telegram.getChatMember(channelIdOrUsername, userId);
    const status = (member?.status) || 'left';

    if (['creator', 'administrator', 'member', 'restricted'].includes(status)) {
      return sendMainMenu(ctx);
    }

    const joinUrl = channelIdOrUsername.startsWith('@')
      ? `https://t.me/${channelIdOrUsername.replace(/^@/, '')}`
      : null;

    const keyboard = [
      [
        joinUrl ? { text: '🔗 Gabung Group', url: joinUrl } : { text: '🔎 Buka Group', callback_data: 'open_channel_info' },
        { text: '✅ Sudah Gabung', callback_data: 'check_join_channel' }
      ]
    ];

    const textMsg =
      `🔐 *Akses Terbatas*\n\n` +
      `Silakan bergabung ke group sebelum menggunakan bot.\n\n` +
      `Jika sudah bergabung, tekan tombol *Sudah Gabung*.`;

    return ctx.reply(textMsg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });

  } catch (error) {
    logger.warn('getChatMember error on start/menu: ' + (error.message || error));
    return ctx.reply(
      '⚠️ Gagal memverifikasi keanggotaan.\nPastikan bot sudah menjadi admin di group yang diperlukan.',
      { parse_mode: 'Markdown' }
    );
  }
});

// Fungsi updateGlobalStats
async function updateGlobalStats() {
  try {
    const resellerCount = await dbGetAsync('SELECT COUNT(*) AS count FROM users WHERE role = "reseller"');
    const totalAkun = await dbGetAsync('SELECT COUNT(*) AS count FROM akun');
    const totalServers = await dbGetAsync('SELECT COUNT(*) AS count FROM Server WHERE total_create_akun > 0');

    // Buat tabel jika belum ada (opsional, sekali saja)
    await dbRunAsync(`
      CREATE TABLE IF NOT EXISTS global_stats (
        id INTEGER PRIMARY KEY,
        reseller_count INTEGER DEFAULT 0,
        total_akun INTEGER DEFAULT 0,
        total_servers INTEGER DEFAULT 0
      )
    `);

    // Insert pertama jika kosong
    await dbRunAsync(`INSERT OR IGNORE INTO global_stats (id) VALUES (1)`);

    // Update isinya
    await dbRunAsync(`
      UPDATE global_stats
      SET reseller_count = ?, total_akun = ?, total_servers = ?
      WHERE id = 1
    `, [resellerCount.count, totalAkun.count, totalServers.count]);

    logger.info('✅ Statistik global diperbarui');
  } catch (err) {
    logger.error('❌ Gagal update statistik global: ' + err.message);
  }
}

///waktuuu
async function refreshCacheIfNeeded() {
  const now = Date.now();
  const delay = 60 * 1000; // 1 menit

  if (now - cacheStatus.lastUpdated < delay) return;

  try {
    const serverCount = await dbGetAsync('SELECT COUNT(*) AS count FROM Server');
    const userCount = await dbGetAsync('SELECT COUNT(*) AS count FROM users');

    cacheStatus.jumlahServer = serverCount?.count || 0;
    cacheStatus.jumlahPengguna = userCount?.count || 0;
    cacheStatus.lastUpdated = now;
    logger.info('✅ Cache status diperbarui otomatis');
  } catch (err) {
    logger.warn('⚠️ Gagal refresh cache status:', err.message);
  }
}
async function getRiwayatAkun(userId) {
  // Mengambil 10 akun terakhir yang dibuat oleh user
  return await dbAllAsync(
    "SELECT layanan, akun, created_at FROM invoice_log WHERE user_id = ? ORDER BY id DESC LIMIT 10",
    [userId]
  );
}

async function sendMainMenu(ctx) {
  try {
    const userId = ctx.from.id;
    const ADMIN_USERNAME = vars?.ADMIN_USERNAME || '@joyhayabuse';

    const [userData, totalAkun] = await Promise.all([
      dbGetAsync('SELECT saldo, role FROM users WHERE user_id = ?', [userId]),
      dbGetAsync('SELECT COUNT(*) AS total FROM invoice_log WHERE user_id = ?', [userId])
    ]);

    const saldo = userData?.saldo || 0;
    const role = userData?.role || 'user';
    const totalAkunDibuat = totalAkun?.total || 0;
    const totalUser = typeof cacheTotalUser !== 'undefined' ? cacheTotalUser : 0;

    const roleLabel = role === 'admin' ? 'Administrator' :
                      role === 'reseller' ? 'Reseller Official' : 'Member';

    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Jakarta'
    });

    const keyboard = [];

if (role === 'admin' || adminIds.includes(String(userId))) {
  keyboard.push([{ text: '👑 Menu System Admin', callback_data: 'menu_adminreseller' }]);
}

keyboard.push([
  { text: '➕ Buat Akun',   callback_data: 'service_create' },
  { text: '⌛ Trial Akun',  callback_data: 'service_trial' }
]);
keyboard.push([
  { text: '♻️ Perpanjang',  callback_data: 'renew_select' },
  { text: '📋 Detail Akun', callback_data: 'menu_daftar_akun' }
]);
keyboard.push([
  { text: '🛍️ Menu PPOB',   callback_data: 'menu_ppob' },
  { text: '💳 Top Up Saldo', callback_data: 'topup_saldo_pakasir' }
]);

if (role === 'reseller') {
  keyboard.push([{ text: '📊 Dashboard Reseller', callback_data: 'menu_reseller' }]);
} else if (role !== 'admin') {
  keyboard.push([{ text: '⭐ Upgrade To Reseller', callback_data: 'upgrade_to_reseller' }]);
}


    const text = `
 <b>🖥 CORE DASHBOARD SYSTEM</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<blockquote>👤 <b>Status</b>  : <code>${roleLabel}</code>
🆔 <b>ID</b>    : <code>${userId}</code>
💰 <b>Saldo</b>   : <b>Rp ${saldo.toLocaleString('id-ID')}</b>
📦 <b>Transaksi</b> : <code>${totalAkunDibuat} Proses</code>
👥 <b>Members</b>  : <code>${totalUser} User</code>
🕒 <b>Waktu</b>  : ${timeStr} WIB</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️Hindari Top Up jam <b>00:00 – 00:10</b> WIB
📞 Admin : ${escapeHtml(ADMIN_USERNAME)}
━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

    const msgOptions = {
      caption: safeCaption(text),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    };

    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery().catch(() => {});

      // ✅ FIX RATE LIMIT: Coba edit caption pesan foto yang sudah ada dulu
      // Ini menghindari delete+kirim ulang foto setiap tombol "Kembali" ditekan
      try {
        await ctx.editMessageCaption(msgOptions.caption, {
          parse_mode: msgOptions.parse_mode,
          reply_markup: msgOptions.reply_markup
        });
        return; // Berhasil edit → tidak perlu kirim ulang foto
      } catch (editErr) {
        // "not modified" → sudah sama, tidak perlu apa-apa
        if (editErr.description?.includes('message is not modified')) return;
        // Pesan bukan foto (teks) atau sudah dihapus → hapus lalu kirim foto baru
        try { await ctx.deleteMessage(); } catch (_) {}
      }
    }

    // Kirim foto baru — gunakan file_id cache jika tersedia (lebih cepat, bebas rate limit URL)
    const photoSource = cachedMenuPhotoFileId
      ? cachedMenuPhotoFileId
      : { url: MENU_IMAGE };

    const sent = await ctx.replyWithPhoto(photoSource, msgOptions).catch(async (e) => {
      // Cache mungkin expired → coba ulang dengan URL asli
      if (cachedMenuPhotoFileId && e.description?.includes('wrong file identifier')) {
        cachedMenuPhotoFileId = null;
        return ctx.replyWithPhoto({ url: MENU_IMAGE }, msgOptions);
      }
      throw e;
    });

    // Simpan file_id ke cache untuk pengiriman berikutnya
    if (sent?.photo?.length && !cachedMenuPhotoFileId) {
      cachedMenuPhotoFileId = sent.photo[sent.photo.length - 1].file_id;
    }

  } catch (err) {
    logger.error('❌ Gagal Dashboard: ' + err.message);
    if (ctx.updateType !== 'callback_query') {
      ctx.reply('❌ Gagal menampilkan menu, database sedang sibuk.').catch(() => {});
    }
  }
}

// ==========================================
// 🛠️ SERVICE ACTION HANDLER (NGEBUT)
// ==========================================
async function handleServiceAction(ctx, action) {
  // Langsung matikan loading di Telegram
  if (ctx.updateType === 'callback_query') ctx.answerCbQuery().catch(() => {});

  const { keyboard, pesan } = generateServiceMenu(action);

  // Wrapper timeout 15 detik agar tidak tembus batas 90 detik Telegraf
  const withTimeout = (promise, ms = 15000) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Telegram API timeout setelah ${ms}ms`)), ms)
      )
    ]);

  try {
    await withTimeout(
      safeMenuSend(ctx, pesan, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      })
    ).catch(() => {});
  } catch (error) {
    logger.error('❌ Service Menu Error: ' + error.message);
    ctx.reply('⚠️ Gagal memuat menu, silakan coba lagi.').catch(() => {});
  }
}

// 1. Pastikan fungsi getFlag sudah ada di script Anda (letakkan di luar fungsi)
function getFlag(location) {
  if (!location) return '🌐';
  const loc = location.toLowerCase();
  if (loc.includes('singapore') || loc.includes('sg')) return '🇸🇬';
  if (loc.includes('indonesia') || loc.includes('indo') || loc.includes('id')) return '🇮🇩';
  if (loc.includes('japan') || loc.includes('jp')) return '🇯🇵';
  if (loc.includes('united states') || loc.includes('us')) return '🇺🇸';
  if (loc.includes('germany') || loc.includes('de')) return '🇩🇪';
  if (loc.includes('netherlands') || loc.includes('nl')) return '🇳🇱';
  if (loc.includes('hongkong') || loc.includes('hk')) return '🇭🇰';
  return '🌐'; 
}

// 2. Fungsi showTrialServerMenu yang sudah diupdate
// Gantilah fungsi showTrialServerMenu Anda dengan yang ini:
async function showTrialServerMenu(ctx, jenis, page = 0) {
  try {
    const userId = String(ctx.from.id);
    if (ctx.updateType === 'callback_query') ctx.answerCbQuery().catch(() => {});

    // --- 1. AMBIL DATA SERVER ---
    const servers = await dbAllAsync('SELECT * FROM Server ORDER BY id ASC');

    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server trial yang aktif saat ini.', { parse_mode: 'HTML' });
    }

    // --- 2. SORTING & PAGINATION ---
    const readyServers = servers.filter(s => (s.total_create_akun || 0) < (s.batas_create_akun || 0));
    const fullServers  = servers.filter(s => (s.total_create_akun || 0) >= (s.batas_create_akun || 0));
    const sortedServers = [...readyServers, ...fullServers];

    const serversPerPage = 4;
    const totalPages  = Math.max(1, Math.ceil(sortedServers.length / serversPerPage));
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const currentServers = sortedServers.slice(currentPage * serversPerPage, (currentPage + 1) * serversPerPage);

    // --- 3. KEYBOARD TOMBOL SERVER ---
    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      const flag1 = getFlag(currentServers[i].lokasi);
      row.push({ text: `${flag1} ${currentServers[i].nama_server}`, callback_data: `trial_server_${jenis}_${currentServers[i].id}` });
      if (currentServers[i + 1]) {
        const flag2 = getFlag(currentServers[i + 1].lokasi);
        row.push({ text: `${flag2} ${currentServers[i + 1].nama_server}`, callback_data: `trial_server_${jenis}_${currentServers[i + 1].id}` });
      }
      keyboard.push(row);
    }

    const navRow = [];
    if (currentPage > 0) navRow.push({ text: '⬅️ Prev', callback_data: `TrialPage_${jenis}_${currentPage - 1}` });
    if (currentPage < totalPages - 1) navRow.push({ text: 'Next ➡️', callback_data: `TrialPage_${jenis}_${currentPage + 1}` });
    if (navRow.length) keyboard.push(navRow);
    keyboard.push([{ text: '🔙 Kembali', callback_data: 'service_trial' }]);

    // Nama protokol uppercase
    const currentProtocol = jenis.toUpperCase();

    // --- 4. SERVER CARDS (Gaya Blockquote & Informasi Padat) ---
    const serverCards = currentServers.map(s => {
      const isFull = (s.total_create_akun || 0) >= (s.batas_create_akun || 0);
      const flag   = getFlag(s.lokasi);

      return [
        `${flag} <b>${escapeHtml(s.nama_server)} (${escapeHtml(s.lokasi || 'Global')})</b>`,
        `<blockquote>🖥️ <b>Host   :</b> <code>${escapeHtml(s.domain || '0.0.0.0')}</code>`,
        `⌛ <b>Durasi :</b> <code>60 Menit (Trial)</code>`,
        `🔢 <b>IP Limit:</b> <code>${s.iplimit || 1} Device</code>`,
        `📊 <b>Status :</b> ${isFull ? '❌ FULL' : '✅ READY'} (${s.total_create_akun || 0}/${s.batas_create_akun || 0})</blockquote>`
      ].join('\n');
    }).join('\n\n');

    // --- 5. HEADER & FOOTER ---
    const header =
      ` <b>📋 LIST SERVER TRIAL ${currentProtocol}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Hal. ${currentPage + 1}/${totalPages}</i>\n\n`;

    const footer = 
      `\n\n<b>📝 Syarat & Ketentuan:</b>\n` +
      `🔹 Limit 1 Akun/Hari/User\n` +
      `🔹 Dilarang keras aktivitas ilegal`;

    await safeMenuSend(ctx, header + serverCards + footer, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });

    // --- 6. USER STATE UPDATE ---
    if (!userState[ctx.chat.id]) userState[ctx.chat.id] = {};
    userState[ctx.chat.id].step = `trial_server_${jenis}`;
    userState[ctx.chat.id].page = currentPage;

  } catch (error) {
    logger.error('❌ Error Trial Menu: ' + error.message);
    ctx.reply('❌ Gagal memuat daftar server trial.').catch(() => {});
  }
}

// ==========================================
// 📋 GENERATE SERVICE MENU (SIMPLE & CLEAN)
// ==========================================
function generateServiceMenu(action) {
  let keyboard = [];
  let teks = '';

  const commonKeys = [[{ text: '« Kembali ke Menu', callback_data: 'send_main_menu' }]];
  
  const menuConfig = {
    create: {
      title: '💎 PREMIUM ACCOUNT',
      desc: 'Pilih protokol terbaik untuk koneksi internet Anda. Semua server High Speed & Low Latency.'
    },
    renew: {
      title: '♻️ RENEW SERVICE',
      desc: 'Perpanjang masa aktif akun Anda secara instan tanpa perlu konfigurasi ulang.'
    },
    trial: {
      title: '⚡ FREE TRIAL SYSTEM',
      desc: 'Dapatkan akses gratis selama 1 jam untuk mencoba performa maksimal server kami.'
    }
  };

  const cfg = menuConfig[action];
  
  // Menggunakan tag <blockquote> untuk tampilan yang lebih elegan di Telegram
  teks = `
<b>${cfg.title}</b>
<blockquote>${cfg.desc}</blockquote>
<b>Choose Protocol:</b>`.trim();

  // PERBAIKAN: Menggunakan 'keyboard' (huruf k kecil) agar sama dengan deklarasi di atas
  keyboard = [
    [
      { text: 'SSH', callback_data: `${action}_ssh` }, 
      { text: 'VMESS', callback_data: `${action}_vmess` }
    ],
    [
      { text: 'VLESS', callback_data: `${action}_vless` }, 
      { text: 'TROJAN', callback_data: `${action}_trojan` }
    ],
    ...commonKeys
  ];

  return { keyboard, pesan: teks };
}

// 2. Fungsi Utama startSelectServer
async function startSelectServer(ctx, action, type, page = 0) {
  try {
    const userId = String(ctx.from.id);
    if (ctx.updateType === 'callback_query') ctx.answerCbQuery().catch(() => {});

    const [user, servers] = await Promise.all([
      dbGetAsync('SELECT role FROM users WHERE user_id = ?', [userId]),
      dbAllAsync('SELECT * FROM Server ORDER BY id ASC')
    ]);

    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang aktif saat ini.', { parse_mode: 'HTML' });
    }

    const role = (user?.role || 'user').toLowerCase();
    const isReseller = role === 'reseller' || role === 'admin';
    const diskonRate = isReseller ? 0.3 : 0;

    const readyServers = servers.filter(s => (s.total_create_akun || 0) < (s.batas_create_akun || 0));
    const fullServers  = servers.filter(s => (s.total_create_akun || 0) >= (s.batas_create_akun || 0));
    const sortedServers = [...readyServers, ...fullServers];

    const serversPerPage = 4;
    const totalPages  = Math.max(1, Math.ceil(sortedServers.length / serversPerPage));
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const currentServers = sortedServers.slice(currentPage * serversPerPage, (currentPage + 1) * serversPerPage);

    // Keyboard tombol server
    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      const flag1 = getFlag(currentServers[i].lokasi);
      row.push({ text: `${flag1} ${currentServers[i].nama_server}`, callback_data: `${action}_username_${type}_${currentServers[i].id}` });
      if (currentServers[i + 1]) {
        const flag2 = getFlag(currentServers[i + 1].lokasi);
        row.push({ text: `${flag2} ${currentServers[i + 1].nama_server}`, callback_data: `${action}_username_${type}_${currentServers[i + 1].id}` });
      }
      keyboard.push(row);
    }

    const navRow = [];
    if (currentPage > 0) navRow.push({ text: '⬅️ Prev', callback_data: `Maps_${action}_${type}_${currentPage - 1}` });
    if (currentPage < totalPages - 1) navRow.push({ text: 'Next ➡️', callback_data: `Maps_${action}_${type}_${currentPage + 1}` });
    if (navRow.length) keyboard.push(navRow);
    keyboard.push([{ text: '🔙 Kembali', callback_data: 'service_create' }]);

    // Nama protokol
    const protocolNames = { vmess: 'VMESS', vless: 'VLESS', trojan: 'TROJAN', shadowsocks: 'SHADOWSOCKS', ssh: 'SSH WS', zivpn: 'ZIVPN' };
    const currentProtocol = protocolNames[type.toLowerCase()] || type.toUpperCase();

    // Server cards
    const serverCards = currentServers.map(s => {
      const hariBase  = s.harga || 0;
      const bulanBase = hariBase * 30;
      const hariModal  = Math.floor(hariBase  * (1 - diskonRate));
      const bulanModal = Math.floor(bulanBase * (1 - diskonRate));
      const isFull     = (s.total_create_akun || 0) >= (s.batas_create_akun || 0);
      const flag       = getFlag(s.lokasi);

      const pricing = isReseller
        ? `💵 <b>Jual:</b> <code>Rp${hariBase.toLocaleString('id-ID')}</code> | <code>Rp${bulanBase.toLocaleString('id-ID')}</code>\n` +
          `💴 <b>Beli:</b> <b>Rp${hariModal.toLocaleString('id-ID')}</b> | <b>Rp${bulanModal.toLocaleString('id-ID')}</b>`
        : `💰 <b>Harga:</b> <b>Rp${hariBase.toLocaleString('id-ID')}/hari</b> | <b>Rp${bulanBase.toLocaleString('id-ID')}/bln</b>`;

      return [
        `${flag} <b>${escapeHtml(s.nama_server)} (${escapeHtml(s.lokasi || 'Global')})</b>`,
        `<blockquote>🖥️ <b>Host   :</b> <code>${escapeHtml(s.domain || '0.0.0.0')}</code>`,
        pricing,
        `🔢 <b>IP Limit:</b> <code>${s.iplimit || 1} Device</code>`,
        `📶 <b>Quota  :</b> <code>${(s.quota || 0) * 30} GB/Bulan</code>`,
        `📊 <b>Status :</b> ${isFull ? '❌ FULL' : '✅ READY'} (${s.total_create_akun || 0}/${s.batas_create_akun || 0})</blockquote>`
      ].join('\n');
    }).join('\n\n');

    // Header
    const header =
      ` <b>📋 LIST SERVER ${currentProtocol}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      (isReseller ? `<blockquote>⭐ Akun Reseller — Diskon 30%</blockquote>\n` : '') +
      `<i>Hal. ${currentPage + 1}/${totalPages}</i>\n\n`;

    await safeMenuSend(ctx, header + serverCards, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });

    if (!userState[ctx.chat.id]) userState[ctx.chat.id] = {};
    userState[ctx.chat.id].step = `${action}_username_${type}`;
    userState[ctx.chat.id].page = currentPage;

  } catch (error) {
    logger.error('❌ Error Select Server: ' + error.message);
    ctx.reply('❌ Gagal memuat daftar server.').catch(() => {});
  }
}

// Fungsi yang lebih tangguh untuk mengirim file ke Telegram dengan mekanisme Retry
// ⏱️ Fungsi untuk backup otomatis (Optimasi untuk Mode WAL)
async function telegramAutoBackup() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const backupFileName = `sellvpn_auto_${dateStr}_${Date.now()}.db`;
  const backupPath = path.join(BACKUP_DIR, backupFileName);

  return new Promise((resolve, reject) => {
    // 1. Pastikan folder backup ada
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // 2. Gunakan VACUUM INTO agar data di file WAL ikut terbawa ke file backup
    db.run(`VACUUM INTO '${backupPath}'`, async (err) => {
      if (err) {
        logger.error(`❌ Gagal VACUUM (Backup Otomatis): ${err.message}`);
        return reject(err);
      }

      try {
        logger.info(`📂 Snapshot DB berhasil dibuat: ${backupFileName}`);

        // 3. Ambil ID Admin dari vars
        const adminChatId = vars?.USER_ID;
        if (adminChatId) {
          // Tunggu sampai pengiriman benar-benar selesai
          const success = await sendFileToTelegram(adminChatId, backupPath, backupFileName);
          
          if (success) {
            logger.info(`✅ Backup otomatis sukses dikirim ke Telegram.`);
          }
        }

        // 4. Hapus file backup lokal agar tidak menumpuk di VPS
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
          logger.info(`🧹 File backup sementara dihapus.`);
        }
        
        resolve();
      } catch (sendErr) {
        logger.error(`❌ Error saat proses kirim/hapus backup: ${sendErr.message}`);
        reject(sendErr);
      }
    });
  });
}

// Fungsi pengiriman tetap sama, pastikan 'bot' sudah terdefinisi di scope global
async function sendFileToTelegram(chatId, filePath, filename) {
  const MAX_TELEGRAM_ATTEMPTS = 3;
  const RETRY_DELAY = 10000;

  for (let attempt = 0; attempt < MAX_TELEGRAM_ATTEMPTS; attempt++) {
    try {
      await bot.telegram.sendDocument(chatId, {
        source: filePath,
        filename: filename
      }, {
        caption: `📦 *Auto Backup Database*\n📅 ${new Date().toLocaleString('id-ID')}\n⚡ Mode: WAL Synchronized`,
        parse_mode: 'Markdown'
      });
      return true;
    } catch (error) {
      if (attempt === MAX_TELEGRAM_ATTEMPTS - 1) return false;
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

async function safeEdit(ctx, text, options = {}) {
  try {
    await ctx.editMessageText(text, options);
  } catch (e) {
    if (!e.description?.includes('message is not modified')) {
      logger.warn('safeEdit error: ' + e.message);
    }
  }
}

// ─── Menu Photo Helpers ───────────────────────────────────────────────────────
const MAX_CAPTION_LENGTH = 1024;

function safeCaption(text) {
  if (!text) return '';
  if (text.length <= MAX_CAPTION_LENGTH) return text;
  // ✅ FIX #11: Strip tag HTML dulu sebelum potong agar tidak broken di tengah <b>/<code>
  const stripped = text.replace(/<[^>]+>/g, '');
  return stripped.slice(0, MAX_CAPTION_LENGTH - 50).trimEnd() + '\n\n<i>... (lihat tombol di bawah)</i>';
}

async function safeMenuSend(ctx, text, options = {}) {
  // withImage: true  → hanya main menu yang boleh tampilkan foto
  // withImage: false → semua sub-menu tampilkan teks biasa (tidak ada foto)
  const { withImage = false, ...msgOptions } = options;

  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery().catch(() => {});

    if (withImage) {
      // ── Menu dengan foto (hanya sendMainMenu) ──────────────────────────
      // Coba edit caption foto yang sudah ada
      try {
        await ctx.editMessageCaption(safeCaption(text), msgOptions);
        return;
      } catch (e1) {
        if (e1.description?.includes('message is not modified')) return;
        // Pesan bukan foto / sudah dihapus → hapus lalu kirim foto baru
        try { await ctx.deleteMessage(); } catch (_) {}
        const src = cachedMenuPhotoFileId ? cachedMenuPhotoFileId : { url: MENU_IMAGE };
        const s = await ctx.replyWithPhoto(src, { caption: safeCaption(text), ...msgOptions })
          .catch(async (e2) => {
            if (cachedMenuPhotoFileId && e2.description?.includes('wrong file identifier')) {
              cachedMenuPhotoFileId = null;
              return ctx.replyWithPhoto({ url: MENU_IMAGE }, { caption: safeCaption(text), ...msgOptions });
            }
          });
        if (s?.photo?.length && !cachedMenuPhotoFileId) {
          cachedMenuPhotoFileId = s.photo[s.photo.length - 1].file_id;
        }
      }

    } else {
      // ── Sub-menu teks biasa (tanpa foto) ──────────────────────────────
      // Coba edit teks dulu; kalau pesan sebelumnya foto, hapus lalu kirim teks baru
      try {
        await ctx.editMessageText(text, msgOptions);
        return;
      } catch (e1) {
        if (e1.description?.includes('message is not modified')) return;
        // Pesan mungkin foto (dari main menu) → hapus, kirim teks baru tanpa foto
        try { await ctx.deleteMessage(); } catch (_) {}
        await ctx.reply(text, msgOptions).catch(() => {});
      }
    }

  } else {
    // ── Pesan biasa (bukan callback) ─────────────────────────────────────
    if (withImage) {
      const src = cachedMenuPhotoFileId ? cachedMenuPhotoFileId : { url: MENU_IMAGE };
      const s = await ctx.replyWithPhoto(src, { caption: safeCaption(text), ...msgOptions })
        .catch(async (e) => {
          if (cachedMenuPhotoFileId && e.description?.includes('wrong file identifier')) {
            cachedMenuPhotoFileId = null;
            return ctx.replyWithPhoto({ url: MENU_IMAGE }, { caption: safeCaption(text), ...msgOptions });
          }
        });
      if (s?.photo?.length && !cachedMenuPhotoFileId) {
        cachedMenuPhotoFileId = s.photo[s.photo.length - 1].file_id;
      }
    } else {
      await ctx.reply(text, msgOptions);
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────
async function renderAccountList(ctx, userId) {
  try {
    // Ambil 10 akun aktif (belum expired) yang punya config_text
    const accounts = await dbAllAsync(
      `SELECT id, akun, protocol FROM invoice_log 
       WHERE user_id = ? AND config_text IS NOT NULL
         AND expired_at >= date('now')
       ORDER BY id DESC LIMIT 10`, 
      [userId]
    );

    if (!accounts.length) {
      return ctx.answerCbQuery('⚠️ Kamu tidak memiliki akun aktif atau semua akun sudah expired.', { show_alert: true });
    }

    const buttons = accounts.map(acc => ([{
      text: `👤 [${acc.protocol}] ${acc.akun}`,
      callback_data: `view_acc:${acc.id}` // Ini baru nyambung ke handler yang lu buat
    }]));

    buttons.push([{ text: '🔙 KEMBALI KE MENU', callback_data: 'send_main_menu' }]);

    await safeMenuSend(ctx, '<b>🗂 DAFTAR AKUN ANDA</b>\nSilakan pilih akun untuk melihat detail config:', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    logger.error('renderAccountList error: ' + (err.stack || err.message || err));
    ctx.reply('❌ Terjadi kesalahan saat mengambil daftar akun.');
  }
}

function hitungHargaJual(hargaAsli) {

  hargaAsli = Number(hargaAsli);

  let untung = 0;

  // =========================
  // 🪙 MICRO PRICE
  // =========================

  if (hargaAsli <= 10) {

    untung = 40;

  } else if (hargaAsli <= 25) {

    untung = 75;

  } else if (hargaAsli <= 50) {

    untung = 100;

  } else if (hargaAsli <= 100) {

    untung = 150;

  } else if (hargaAsli <= 300) {

    untung = 200;

  } else if (hargaAsli <= 500) {

    untung = 250;

  } else if (hargaAsli < 1000) {

    untung = 300;

  }

  // =========================
  // 💰 NORMAL
  // =========================

  else if (hargaAsli <= 5000) {

    untung = 500;

  } else if (hargaAsli <= 10000) {

    untung = 800;
    
  } else if (hargaAsli <= 15000) {

    untung = 1000;

  } else if (hargaAsli <= 25000) {

    untung = 1200;

  } else if (hargaAsli <= 50000) {

    untung = 1800;

  } else if (hargaAsli <= 100000) {

    untung = 2500;

  } else {

    untung = 4000;

  }

  const total =
    hargaAsli + untung;

  return total;

}

// HANDLER: ketika admin kirim dokumen .db
bot.on('document', async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;

  // 1. Cek State dan Izin
  const adminList = global.adminIds 
    || (typeof adminIds !== 'undefined' ? adminIds : []);
  
  if (!adminList.map(String).includes(userId) || userState[chatId]?.step !== 'await_restore_upload') {
    return; 
  }

  const doc = ctx.message.document;

  if (!doc.file_name || !doc.file_name.endsWith('.db')) {
    delete userState[chatId]; 
    return ctx.reply('❌ Dokumen harus file .db. Proses dibatalkan.');
  }

  if (doc.file_size > 50 * 1024 * 1024) { 
    delete userState[chatId];
    return ctx.reply('❌ File terlalu besar (maks 50MB).');
  }

  delete userState[chatId];

  try {
    await ctx.reply('⏳ Memproses restore database... Bot akan menjeda koneksi sejenak.');

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const tempFilePath = path.join(UPLOAD_DIR, `restore_${Date.now()}.db`);

    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    // Download file
    const downloadResponse = await axios.get(fileLink.href, { responseType: 'stream' });
    const writer = fs.createWriteStream(tempFilePath);
    downloadResponse.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 🔒 CRITICAL SECTION
    
    // 4. TUTUP KONEKSI UTAMA (Wajib ditutup total agar file tidak locked)
    if (db && typeof db.close === 'function') {
      await new Promise((resolve) => {
        db.close((err) => {
          if (err) logger.warn('⚠️ Gagal menutup DB:', err.message);
          else logger.info('Koneksi DB ditutup untuk restore.');
          resolve();
        });
      });
    }

    // 5. HAPUS FILE WAL/SHM LAMA (WAJIB untuk WAL mode)
    // Jika file -wal lama tidak dihapus, saldo bisa kembali ke data lama (kacau)
    try {
      if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
      if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
      logger.info('File temporary WAL/SHM dibersihkan.');
    } catch (e) {
      logger.warn('Gagal hapus file temp WAL (mungkin tidak ada).');
    }

    // 6. TIMPA FILE DATABASE UTAMA
    fs.copyFileSync(tempFilePath, DB_PATH);
    logger.info(`Database berhasil ditimpa.`);

    // 7. BUKA KEMBALI KONEKSI & AKTIFKAN LAGI MODE NGEBUT
    const openDatabase = () => {
      return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_PATH, (err) => {
          if (err) return reject(err);
          
          // Set ulang PRAGMA agar bot tetap satset setelah restore
          db.run("PRAGMA journal_mode = WAL;");
          db.run("PRAGMA synchronous = NORMAL;");
          
          logger.info('Koneksi DB dibuka kembali & Mode WAL diaktifkan.');
          resolve();
        });
      });
    };

    await openDatabase();

    // 8. HAPUS FILE RESTORE SEMENTARA
    try { fs.unlinkSync(tempFilePath); } catch (e) {}

    await ctx.reply('🎉 **Restore Berhasil!**\nDatabase telah diperbarui dan Mode WAL diaktifkan kembali.', {
      parse_mode: 'Markdown'
    });

  } catch (err) {
    logger.error('❌ Error restore DB:', err);
    
    // Fallback: Pastikan bot tidak mati tanpa koneksi DB
    if (!db) {
      db = new sqlite3.Database(DB_PATH);
    }

    await ctx.reply(`❌ Gagal restore: ${err.message}`, { parse_mode: 'Markdown' });
  }
});

// ==========================================
// 🛒 PPOB ACTION HANDLERS (CLEAN VERSION)
// ==========================================
bot.action('menu_ppob', async (ctx) => {
  const userId = ctx.from.id;

  try {
    const user = await dbGetAsync('SELECT saldo FROM users WHERE user_id = ?', [userId]);
    const saldo = user?.saldo || 0;

    const categories = ['Pulsa', 'Data', 'Games', 'PLN', 'E-Money', 'Masa Aktif', 'Voucher'];

    const buttons = [];
    for (let i = 0; i < categories.length; i += 2) {
      const row = [{ text: categories[i], callback_data: `ppob_cat:${categories[i]}` }];
      if (categories[i + 1]) {
        row.push({ text: categories[i + 1], callback_data: `ppob_cat:${categories[i + 1]}` });
      }
      buttons.push(row);
    }

    buttons.push([{ text: 'Riwayat Transaksi',  callback_data: 'ppob_riwayat' }]);
    buttons.push([{ text: '🔙 Kembali Ke Menu Utama', callback_data: 'send_main_menu' }]);

    const text = `
 <b>🛍️ MENU PPOB</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<blockquote>🆔 <b>ID</b>    : <code>${userId}</code>
💰 <b>Saldo</b> : <b>Rp ${saldo.toLocaleString('id-ID')}</b></blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

    await safeMenuSend(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (err) {
    logger.error('Error menu_ppob: ' + err.message);
    ctx.answerCbQuery('❌ Gagal memuat menu.', { show_alert: true });
  }
});

// --- HANDLER AWAL KLIK RIWAYAT ---
bot.action('ppob_riwayat', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderUserPPOB(ctx, 1); // Lempar ke halaman 1
});

// --- FUNGSI RENDER RIWAYAT USER (PREMIUM STYLE) ---
async function renderUserPPOB(ctx, page) {
  const userId = ctx.from.id;
  const limit = 5; // 5 data per halaman biar pas di layar HP
  const offset = (page - 1) * limit;

  try {
    // 1. Hitung total data user tersebut
    const totalData = await dbGetAsync("SELECT COUNT(*) as count FROM ppob_transactions WHERE user_id = ?", [userId]);
    const totalPages = Math.ceil(totalData.count / limit);

    if (totalData.count === 0) {
      return safeMenuSend(ctx, "<b>📭 RIWAYAT KOSONG</b>\nKamu belum memiliki transaksi PPOB.", {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'menu_ppob' }]] }
      });
    }

    // 2. Ambil data riwayat
    const rows = await dbAllAsync(
      `SELECT * FROM ppob_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    let text = `<b>📜 RIWAYAT TRANSAKSI ANDA</b>\n`;
    text += `<i>Halaman ${page} dari ${totalPages}</i>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    rows.forEach((r, i) => {
      const statusStr = (r.status || 'PENDING').toUpperCase();
      let icon = '⏳';
      if (statusStr === 'SUKSES' || statusStr === 'SUCCESS') icon = '✅';
      if (statusStr === 'GAGAL' || statusStr === 'FAILURE') icon = '❌';

      text += `${offset + i + 1}. ${icon} <b>${statusStr}</b>\n`;
      text += `<blockquote>`;
      text += `📦 <b>Item :</b> ${r.sku}\n`;
      text += `🎯 <b>Dest :</b> <code>${r.target}</code>\n`;
      if (r.sn && statusStr === 'SUKSES') {
        text += `🎟 <b>SN   :</b> <code>${r.sn}</code>\n`;
      }
      text += `📅 <b>Tgl  :</b> ${r.created_at}`;
      text += `</blockquote>\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━━`;

    // 3. Tombol Navigasi
    const buttons = [];
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `userppob_page_${page - 1}` });
    if (page < totalPages) navRow.push({ text: 'Next ➡️', callback_data: `userppob_page_${page + 1}` });
    
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 Kembali Ke Menu', callback_data: 'menu_ppob' }]);

    await safeMenuSend(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (err) {
    logger.error('Error renderUserPPOB: ' + err.message);
    ctx.reply("❌ Terjadi kesalahan saat memuat riwayat.");
  }
}

// --- ACTION HANDLER NAVIGASI USER ---
bot.action(/^userppob_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`Halaman ${page}`);
  return renderUserPPOB(ctx, page);
});
// ==========================================
// 📦 PPOB DATA SUB-KATEGORI HANDLER
// Paste bagian ini ke app.js kamu,
// GANTI handler ppob_brd dan ppob_cat yang lama.
// ==========================================

// ─────────────────────────────────────────────────
// KONSTANTA SUB-KATEGORI (taruh di atas handler)
// ─────────────────────────────────────────────────
const BRAND_SUB_CATEGORIES = {
  'Telkomsel': [
    'Bulk', 'Flash', 'Mini', 'Apps Kuota', 'Maxstream', 'Umroh', 'Malam', 'Combo Sakti',
    'GamesMAX Unlimited Play', 'Whatsapp', 'Youtube', 'Instagram', 'Facebook',
    'Ketengan TikTok', 'GamesMAX', 'MusicMAX', 'Disney', 'OMG', 'GigaMAX', 'UnlimitedMAX',
    'Ilmupedia', 'Orbit', 'InternetMAX', 'Surprise Deal', 'UKM COMBO', 'UKM',
    'Sumatera Utara', 'Sumatera Tengah', 'Sumatera Selatan',
    'Bronze', 'Jabodetabek', 'Jawa Barat', 'Jawa Tengah', 'Jawa Timur',
    'Kalimantan', 'Sulawesi', 'Papua Maluku', 'Serumax', 'Harian Sepuasnya',
    'Harian', 'Mingguan', 'Bulanan', 'Ketengan Utama', 'Zoom', 'Roamax',
    'GamesMAX Booster', 'Banten', 'Naslok', 'FIFA World Cup', 'Musik', 'Games',
    'Jabo', 'Internet Sakti', 'RoaMAX Haji', 'Combo', 'Netflix', 'Eksklusif',
    'Sukabumi Bogor Banten', 'TikTok', 'Super Seru', 'Cek Paket', 'Flash Revamp',
    'DPI', 'Enterprise', 'Twitter', 'Serba Lima Ribu', 'Magnet', 'UKM Plus',
    'Ruangguru', 'Belajar', 'Terbaik Untukmu', 'Non Puma', 'Videomax'
  ],
  'Indosat': [
    'Gift Data', 'Yellow', 'Freedom Combo', 'Freedom Harian', 'Freedom Internet',
    'Haji', 'Ekstra', 'Roaming', 'Freedom U', 'Freedom Apps', 'Freedom Longlife',
    'Yellow Gift', 'Jabodetabek', 'Jawa Barat', 'Jawa Tengah', 'Kalisumapa',
    'Sumatera', 'EJBN', 'Freedom U Gift', 'Freedom Combo Gift', 'Freedom Internet Gift',
    'Umroh Haji Combo', 'Umroh Haji Internet', 'Umroh Haji', 'FIFA World Cup',
    'Freedom Max', 'UMKM', 'Extra Booster Gift', 'Gaspol', 'Sachet', 'Community',
    'Cek Paket', 'Pure Merdeka', 'Kita', 'SMB', 'Ramadan', 'Freedom Apps Gift',
    'HiFi Air', 'Jawa Tengah EJBN', 'Freedom Internet 5G', 'Freedom Spesial',
    'Freedom Play', 'SATSPAM+'
  ],
  'Axis': [
    'Mini', 'Kzl', 'Bronet', 'Owsem', 'Conference', 'Edukasi', 'Ekstra',
    'Youtube', 'Sosmed', 'Sukabumi', 'Kendal', 'Semarang', 'Harian', 'BOY',
    'Paket Warnet', 'Sulutra', 'Non Jawa Bali Nusra', 'Aigo SS', 'NTT',
    'Salatiga', 'Combo Mabrur', 'Mabrur', 'Jawa Bali Nusra', 'Video', 'Musik',
    'Games', 'Sunset', 'Komik', 'Bronet Vidio', 'Jatim Bali Nusra',
    'DRP Games', 'Obor', 'Edu Confrence', 'Banyuwangi Probolinggo',
    'Sulawesi Ewako', 'Apps Games', 'AIGO Unlimited', 'Bagi Kuota', 'Bronet 5G',
    'Bronet Sosmed'
  ],
  'Smartfren': [
    'Unlimited', 'Volume', 'Malam', 'Roaming', 'Youtube', 'Connex Evo',
    'Gokil Max', 'Nonstop', 'Chat', 'Sosmed', 'Unlimited Nonstop', 'FIFA World Cup',
    'Musik', 'Games', 'Kuota', 'Tiktok', 'Mandiri', 'Tapal Kuda', 'Nonton',
    'SnackVideo', 'Unlimited Harian 5G', 'Unlimited Nonstop 5G', 'Kuota 5G', 'Klikfilm'
  ],
  'Tri': [
    'Mini', 'AlwaysOn', 'GetMore', 'Mix', 'Cicilan', 'Home', 'Roaming',
    'Data Transfer', 'Happy', 'Lokal', 'Chelsea', 'Jawa Barat', 'Chat', 'H3RO',
    'Kalisumapa', 'Sumatera', 'EJBN', 'Jawa Tengah', 'Sahabat Ojol',
    'FIFA World Cup', 'Ibadah', 'Addon', 'KeepOn', 'Sumatera Utara', 'Jakarta Raya',
    'Happy Play', 'Pure 7 Hari', 'Pure 14 Hari', 'Pure 30 Hari', 'Ramadan',
    'Happy Travel', 'HiFi Air', 'Jawa Tengah EJBN', 'Sumatera Tengah',
    'Sumatera Selatan', 'Kikida', 'Happy 5G', 'Unlimited Games',
    'Unlimited Sosmed', 'Unlimited Streaming', 'Unlimited Chatting'
  ],
  'XL': [
    'Mini', 'Umroh', 'Hotrod', 'Xtra Combo', 'Combo Lite', 'Xtra Kuota',
    'Conference', 'Edukasi', 'Xtra On', 'Roaming', 'Xtra Combo Plus',
    'Xtra Combo Gift', 'Hotrod Special', 'Xtra Combo Flex', 'Paket Akrab',
    'Harian', 'Blue', 'Sumatera', 'Xtra Combo VIP Plus', 'Xtra Combo Mini',
    'Xtra Combo VIP Gift', 'Xtra Combo Weekend', 'Xtra Kuota Vidio',
    'Combo Umroh Haji', 'Internet Umroh Haji', 'Games', 'Umroh Plus',
    'East', 'West', 'Central', 'Cek Paket', 'Bonus Harian',
    'Bebas Puas 2rb', 'Bebas Puas 3rb', 'Bebas Puas 5rb', 'Grab Gacor',
    'Apps Games', 'Pass', 'Flex', 'ON', 'FlexMax', 'Bebas Puas 6rb',
    'East Kalsul', 'Ultra 5G', 'Flex Mini'
  ],
  'by.U': [
    'Viu', 'Tiktok', 'Kaget', 'Mbps', 'Topping GGWP', 'Vidio', 'Jajan', 'Super Kaget'
  ]
};

// Helper: cari key BRAND_SUB_CATEGORIES yang cocok (case-insensitive)
function getBrandKey(brand) {
  if (!brand) return null;
  const lower = brand.toLowerCase();
  return Object.keys(BRAND_SUB_CATEGORIES).find(k => k.toLowerCase() === lower) || null;
}

// Fungsi get sub-kategori berdasarkan nama produk & brand
function getSubCategory(productName, brand) {
  if (!productName || !brand) return 'Umum';

  const brandKey = getBrandKey(brand);
  const subList = brandKey ? BRAND_SUB_CATEGORIES[brandKey] : [];

  if (!subList || subList.length === 0) return 'Umum';
  
  // Urutkan dari yang terpanjang dulu biar match lebih spesifik
  const sorted = [...subList].sort((a, b) => b.length - a.length);
  
  for (const sub of sorted) {
    if (productName.toLowerCase().includes(sub.toLowerCase())) {
      return sub;
    }
  }
  
  return 'Umum';
}

// ===================== HANDLER PPOB =====================

// Kategori → Brand
bot.action(/^ppob_cat:(.+)$/, async (ctx) => {
  const category = ctx.match[1];
  await ctx.answerCbQuery(`Loading ${category}...`).catch(() => {});
  
  const result = await getDigiProducts();
  if (result.status === 'error') {
    return ctx.reply(`❌ <b>Gagal Mengambil Produk</b>\n\nAlasan: <code>${result.message}</code>`, { parse_mode: 'HTML' });
  }

  const brands = [...new Set(result.data
    .filter(item => item.category === category && item.buyer_product_status && item.seller_product_status)
    .map(item => item.brand))];

  if (brands.length === 0) return ctx.reply(`❌ Tidak ada provider aktif untuk ${category}.`);

  const buttons = [];
  for (let i = 0; i < brands.length; i += 2) {
    const row = [{ text: brands[i], callback_data: `ppob_brd:${category}:${brands[i]}` }];
    if (brands[i+1]) row.push({ text: brands[i+1], callback_data: `ppob_brd:${category}:${brands[i+1]}` });
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Kembali', callback_data: 'menu_ppob' }]);

  // 👇 TEKS BERIKUT SUDAH DITAMBAHKAN GARIS TEBAL DI ATAS DAN BAWAH KATEGORI 👇
  const textMsg = `━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `<b>Provider ${category}</b>\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `Pilih provider/operator:`;

  await safeMenuSend(ctx, textMsg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
});

// Brand → Sub-Kategori
bot.action(/^ppob_brd:([^:]+):([^:]+)$/, async (ctx) => {
  const category = ctx.match[1];
  const brand = ctx.match[2];
  await ctx.answerCbQuery(`Loading ${brand}...`).catch(() => {});

  const result = await getDigiProducts();
  if (result.status === 'error') return ctx.reply('❌ Gagal mengambil produk.');

  const filtered = result.data.filter(item =>
    item.category.trim() === category.trim() &&
    item.brand.trim() === brand.trim() &&
    item.buyer_product_status === true
  );

  if (filtered.length === 0) return ctx.reply(`❌ Produk ${brand} tidak tersedia.`);

  // Cek apakah brand ini punya sub-kategori (case-insensitive)
  const brandKey = getBrandKey(brand);
  const hasSub = brandKey && BRAND_SUB_CATEGORIES[brandKey] && BRAND_SUB_CATEGORIES[brandKey].length > 0;

  if (!hasSub) {
    // Langsung tampilkan produk
    return showPPOBProducts(ctx, category, brand, null, 1);
  }

  // Hitung jumlah produk per sub-kategori
  const subCount = {};
  filtered.forEach(item => {
    const sub = getSubCategory(item.product_name, brand);
    subCount[sub] = (subCount[sub] || 0) + 1;
  });

  const subList = Object.keys(subCount).sort((a, b) => {
    // Umum selalu di atas
    if (a === 'Umum') return -1;
    if (b === 'Umum') return 1;
    return a.localeCompare(b);
  });

  if (subList.length <= 1) {
    return showPPOBProducts(ctx, category, brand, null, 1);
  }

  const buttons = [];
  for (let i = 0; i < subList.length; i += 2) {
    const row = [{
      text: `${subList[i]} (${subCount[subList[i]]})`,
      callback_data: `ppob_sub:${category}:${brand}:${subList[i]}`
    }];
    if (subList[i+1]) {
      row.push({
        text: `${subList[i+1]} (${subCount[subList[i+1]]})`,
        callback_data: `ppob_sub:${category}:${brand}:${subList[i+1]}`
      });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '📋 Semua Produk', callback_data: `ppob_sub:${category}:${brand}:__all__` }]);
  buttons.push([{ text: '🔙 Kembali', callback_data: `ppob_cat:${category}` }]);

  // 👇 TEKS BERIKUT SUDAH DITAMBAHKAN GARIS TEBAL DI ATAS DAN BAWAH JUDUL 👇
  const textMsg = `━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `<b> ${brand} - ${category}</b>\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `Pilih sub-kategori:`;

  await safeMenuSend(ctx, textMsg, { 
    parse_mode: 'HTML', 
    reply_markup: { inline_keyboard: buttons } 
  });
});

// Brand + halaman (navigasi)
bot.action(/^ppob_brd:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
  const category = ctx.match[1];
  const brand = ctx.match[2];
  const page = parseInt(ctx.match[3]);
  await ctx.answerCbQuery().catch(() => {});
  return showPPOBProducts(ctx, category, brand, null, page);
});

// Sub-kategori → Produk
bot.action(/^ppob_sub:([^:]+):([^:]+):([^:]+)(?::(\d+))?$/, async (ctx) => {
  const category = ctx.match[1];
  const brand = ctx.match[2];
  const subBrand = ctx.match[3];
  const page = parseInt(ctx.match[4] || 1);
  await ctx.answerCbQuery().catch(() => {});
  return showPPOBProducts(ctx, category, brand, subBrand === '__all__' ? null : subBrand, page);
});

// Fungsi tampilkan produk
async function showPPOBProducts(ctx, category, brand, subBrand, page) {
  const result = await getDigiProducts();
  if (result.status === 'error') return ctx.reply('❌ Gagal mengambil produk.');

  let filtered = result.data.filter(item =>
    item.category.trim() === category.trim() &&
    item.brand.trim() === brand.trim() &&
    item.buyer_product_status === true
  ).sort((a, b) => a.price - b.price);

  if (subBrand) {
    filtered = filtered.filter(item =>
      getSubCategory(item.product_name, brand) === subBrand
    );
  }

  if (filtered.length === 0) return ctx.reply(`❌ Produk tidak tersedia.`);

  const limit = 6;
  const totalPages = Math.ceil(filtered.length / limit);
  const offset = (page - 1) * limit;
  const currentItems = filtered.slice(offset, offset + limit);

  // 👇 JUDUL DIAPIT GARIS TEBAL BIAR GAK KEKECILAN DAN RAPI 👇
  let messageText = `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `<b>${brand.toUpperCase()}`;
  if (subBrand) messageText += ` — ${subBrand}`;
  messageText += `</b>\n<i>Halaman ${page} / ${totalPages}</i>\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const buttons = [];
  let selectionRow = [];

  currentItems.forEach((p, i) => {
    const hargaJual = hitungHargaJual(p.price);
    const displayNum = offset + i + 1;
    messageText += `<blockquote><b>${displayNum}. ${p.product_name}</b>\n💰 Harga: <b>Rp ${hargaJual.toLocaleString('id-ID')}</b></blockquote>\n`;

    selectionRow.push({
      text: `${displayNum}`,
      callback_data: `ppob_buy:${p.buyer_sku_code}:${hargaJual}`
    });

    if (selectionRow.length === 3) {
      buttons.push(selectionRow);
      selectionRow = [];
    }
  });

  if (selectionRow.length > 0) buttons.push(selectionRow);

  const navRow = [];
  if (page > 1) {
    const prevCb = subBrand
      ? `ppob_sub:${category}:${brand}:${subBrand}:${page - 1}`
      : `ppob_brd:${category}:${brand}:${page - 1}`;
    navRow.push({ text: '⬅️ Prev', callback_data: prevCb });
  }
  if (page < totalPages) {
    const nextCb = subBrand
      ? `ppob_sub:${category}:${brand}:${subBrand}:${page + 1}`
      : `ppob_brd:${category}:${brand}:${page + 1}`;
    navRow.push({ text: 'Next ➡️', callback_data: nextCb });
  }
  if (navRow.length > 0) buttons.push(navRow);

  if (subBrand) {
    buttons.push([{ text: '🔙 Kembali ke Sub-Kategori', callback_data: `ppob_brd:${category}:${brand}` }]);
  } else {
    buttons.push([{ text: '🔙 Kembali ke Provider', callback_data: `ppob_cat:${category}` }]);
  }

  try {
    await safeMenuSend(ctx, messageText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    if (!err.description?.includes("message is not modified")) {
      logger.error("PPOB Products Error: " + err.message);
    }
  }
}

// 4. Minta Nomor Tujuan
bot.action(/^ppob_buy:(.+):(\d+)$/, async (ctx) => {
  const sku = ctx.match[1];
  const price = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  const state = userState[ctx.chat.id] || {};

  // --- AMBIL NAMA PRODUK DARI CACHE ---
  // Cari di tempProducts (kalau lo simpan di state) atau di digiPriceCache (Global)
  const productInfo = (state.tempProducts || digiPriceCache.data || []).find(p => p.buyer_sku_code === sku);
  const productName = productInfo ? productInfo.product_name : sku;

  const user = await dbGetAsync('SELECT saldo FROM users WHERE user_id = ?', [userId]);
  if (!user || user.saldo < price) {
    return ctx.answerCbQuery('❌ Saldo Anda tidak cukup!', { show_alert: true });
  }

  // Simpan productName ke state supaya "dibawa" ke step berikutnya
  userState[ctx.chat.id] = { 
    step: 'ppob_input_target', 
    sku, 
    price, 
    productName // <-- Simpan ini!
  };

  await safeMenuSend(ctx, `🎯 <b>Input Nomor Tujuan</b>\n\n📦 Produk: <b>${productName}</b>\n💰 Harga: <b>Rp ${price.toLocaleString('id-ID')}</b>\n\nSilakan ketik nomor HP atau ID tujuan:`, { 
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'menu_ppob' }]] }
  });
});
// Handler saat tombol "Detail Account" di menu utama diklik
bot.action('menu_daftar_akun', async (ctx) => {
  await renderAccountList(ctx, String(ctx.from.id));
});

// Handler saat salah satu akun di list diklik (Ini kode lu tadi, sudah bener)
bot.action(/^view_acc:(\d+)$/, async (ctx) => {
  const invoiceId = ctx.match[1];
  try {
    const row = await dbGetAsync("SELECT config_text FROM invoice_log WHERE id = ?", [invoiceId]);

    if (!row || !row.config_text) {
      return ctx.answerCbQuery('❌ Data config tidak ditemukan.');
    }

    await safeMenuSend(ctx, row.config_text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 KEMBALI KE LIST', callback_data: 'menu_daftar_akun' }]]
      }
    });
  } catch (err) {
    logger.error('Database callback error: ' + (err.stack || err.message || err));
    ctx.answerCbQuery('❌ Error database.');
  }
});

// Letakkan di bagian action handler bot.action
bot.action('renew_menu_pilihan', async (ctx) => {
  const keyboard = [
    [
      { text: '📋 Pilih dari Daftar', callback_data: 'renew_select' },
      { text: '⌨️ Input Manual', callback_data: 'service_renew' }
    ],
    [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
  ];

  const text = `
<b>🔄 MENU PERPANJANG AKUN</b>
━━━━━━━━━━━━━━━━━━━━━━
Silakan pilih metode yang Anda inginkan:

1️⃣ <b>Pilih dari Daftar (Otomatis)</b>
Bot akan menampilkan daftar akun aktif yang pernah Anda beli. Anda cukup memilih akun tanpa perlu mengetik username lagi.
<i>⚠️ Jika daftar kosong, silakan gunakan metode <b>Input Manual</b>.</i>

2️⃣ <b>Input Manual (Mandiri)</b>
Gunakan ini jika akun Anda tidak muncul di daftar. Anda akan diminta memasukkan Username secara manual.

<b>⚠️ PENTING (INPUT MANUAL):</b>
Sebelum melakukan perpanjangan manual, pastikan Anda telah <b>mengecek tanggal expired</b> akun tersebut. 
Perpanjangan manual wajib dilakukan <b>SEBELUM</b> akun memasuki masa tenggang/mati agar proses sinkronisasi server berhasil.
━━━━━━━━━━━━━━━━━━━━━━
`.trim();

  await safeMenuSend(ctx, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
});

// Handler untuk navigasi halaman server
bot.action(/^Maps_(.+)_(.+)_(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const page = parseInt(ctx.match[3]);
  
  // Panggil kembali fungsinya dengan page yang baru
  await startSelectServer(ctx, action, type, page);
});
// Pasang handler ini di file utama bot kamu
bot.action(/^TrialPage_(.+)_(.+)$/, async (ctx) => {
  try {
    const jenis = ctx.match[1]; // Mengambil 'v2ray', 'ssh', dll
    const page = parseInt(ctx.match[2]); // Mengambil angka halaman
    
    // Memanggil kembali fungsi menu dengan halaman yang baru
    await showTrialServerMenu(ctx, jenis, page);
  } catch (err) {
    logger.error('Error Navigation Trial: ' + (err.stack || err.message || err));
  }
});

// ------------------------- UPGRADE (tampilkan konfirmasi, HTML) -------------------------
bot.action('upgrade_to_reseller', async (ctx) => {
  const userId = ctx.from.id;

  try {
    await ctx.answerCbQuery();

    const user = await dbGetAsync('SELECT saldo, role FROM users WHERE user_id = ?', [userId]);

    if (!user) {
      return ctx.reply('❌ Akun tidak ditemukan di sistem.', { parse_mode: 'HTML' });
    }

    if (user.role === 'reseller') {
      return ctx.reply('✅ Kamu sudah menjadi reseller.', { parse_mode: 'HTML' });
    }

    const minimumSaldo = 30000;

    if (user.saldo < minimumSaldo) {
      return ctx.reply([
        '💸 <b>Saldo kamu belum cukup untuk upgrade.</b>',
        `Minimal saldo: <b>Rp${minimumSaldo.toLocaleString('id-ID')}</b>`,
        `Saldo kamu: <b>Rp${Number(user.saldo || 0).toLocaleString('id-ID')}</b>`
      ].join('\n'), { parse_mode: 'HTML' });
    }

    const pesanKonfirmasi = [
      '<b>🆙 UPGRADE ke Reseller</b>',
      '',
      `⚠️ <i>Syarat:</i> Memiliki saldo minimal <b>Rp${minimumSaldo.toLocaleString('id-ID')}</b> (saldo tidak akan dipotong)`,
      '',
      '<b>🎯 Persyaratan lain:</b>',
      '• Bisa membuat config sendiri',
      '• Paham cara jualan & tanggung jawab',
      '',
      '<b>Dengan menjadi Reseller, kamu bisa:</b>',
      '✅ Mendapat diskon 30% untuk semua layanan',
      '✅ Mengelola akun user sendiri',
      '✅ Mengakses menu reseller di bot ini',
      '',
      'Klik <b>Ya</b> kalau kamu siap upgrade 🚀'
    ].join('\n');

    return safeMenuSend(ctx, pesanKonfirmasi, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Ya, Upgrade Sekarang', callback_data: 'confirm_upgrade_reseller' }],
          [{ text: '❌ Batal', callback_data: 'send_main_menu' }]
        ]
      }
    });

  } catch (err) {
    logger.error('❌ Error upgrade_to_reseller: ' + (err.message || err));
    return ctx.reply('❌ Terjadi kesalahan. Coba lagi nanti.', { parse_mode: 'HTML' });
  }
});

bot.action('confirm_upgrade_reseller', async (ctx) => {
  const userId = ctx.from.id;
  const minimumSaldo = Number(vars?.MIN_RESELLER_BALANCE) || 30000;

  try {
    await ctx.answerCbQuery();

    const user = await dbGetAsync('SELECT saldo, role, username, first_name FROM users WHERE user_id = ?', [userId]);
    if (!user) {
      return ctx.reply('❌ Akun tidak ditemukan.', { parse_mode: 'HTML' });
    }

    if (user.role === 'reseller') {
      return ctx.reply('✅ Kamu sudah menjadi reseller.', { parse_mode: 'HTML' });
    }

    const saldoNow = Number(user.saldo || 0);
    if (saldoNow < minimumSaldo) {
      return ctx.reply('❌ Saldo kamu tidak mencukupi untuk upgrade.', { parse_mode: 'HTML' });
    }

    // Update role (tanpa reseller_level)
    try {
      await dbRunAsync(
        "UPDATE users SET role = ?, reseller_since = datetime('now'), warned_h7 = 0, warned_h3 = 0 WHERE user_id = ?",
        ['reseller', userId]
      );
    } catch (dbErr) {
      logger.error('❌ Gagal update role saat upgrade reseller: ' + (dbErr.message || dbErr));
      return ctx.reply('❌ Gagal melakukan upgrade. Coba lagi nanti.', { parse_mode: 'HTML' });
    }

    // Catat log upgrade
    try {
      await dbRunAsync(
        `INSERT INTO reseller_upgrade_log (user_id, username, amount, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [userId, user.username || user.first_name || '', 0]
      );
    } catch (logErr) {
      logger.warn('⚠️ Gagal insert ke reseller_upgrade_log: ' + (logErr.message || logErr));
    }

    await ctx.reply(`
🏆 *UPGRADE BERHASIL*

Selamat! Kamu telah berhasil upgrade ke *Reseller*.

✅ Saldo minimal sudah dicek
✅ Upgrade GRATIS (tidak ada potongan)
✅ Diskon 30% untuk semua layanan sudah aktif

Silakan mulai transaksi dengan harga spesial!
    `.trim(), { parse_mode: 'Markdown' });

    // Notif ke grup
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
      const mention   = escapeHtml(maskUsername(user.username || user.first_name || String(userId)));
      const timestamp = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      const notif = `
━━━━━━━━━━━━━━━━━━━━━
<b>?? UPGRADE RESELLER BERHASIL</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>📌 <b>Role      :</b> Reseller
💰 <b>Min Saldo :</b> Rp ${minimumSaldo.toLocaleString('id-ID')}
💵 <b>Saldo     :</b> Rp ${saldoNow.toLocaleString('id-ID')}
🎁 <b>Biaya     :</b> <b>GRATIS</b></blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${mention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: 'HTML' }).catch((e) => {
        logger.warn('⚠️ Gagal kirim notif upgrade ke group: ' + (e.message || e));
      });
    }

  } catch (err) {
    logger.error('❌ Error on confirm_upgrade_reseller: ' + (err.message || err));
    await ctx.reply('❌ Terjadi kesalahan pada server. Coba lagi nanti.', { parse_mode: 'HTML' }).catch(() => {});
  }
});
// ==========================================
// 👑 MENU UTAMA ADMIN (DIPERBAIKI)
// ==========================================
bot.action('menu_adminreseller', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    await ctx.answerCbQuery().catch(() => {}); // Biar loading di Telegram ilang cepet

    // 🔹 Cek Izin Ngebut (Admin By List dulu)
    const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
    let isAllowed = adminList.map(String).includes(userId);

    if (!isAllowed) {
      // Kalau bukan di list, baru cek DB (Fallback)
      const user = await dbGetAsync('SELECT role FROM users WHERE user_id = ?', [userId]);
      if (user && user.role === 'admin') isAllowed = true;
    }

    if (!isAllowed) return ctx.reply('🚫 Akses ditolak.');

    const keyboard = {
      inline_keyboard: [
        [{ text: 'Menu Server', callback_data: 'admin_server_menu' }, { text: 'Menu Sistem', callback_data: 'admin_system_menu' }],
        [{ text: 'Kembali Ke Menu', callback_data: 'send_main_menu' }]
      ]
    };

    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

    const content = `
<b>👑 ADMIN CONTROL PANEL</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Admin:</b> ${escapeHTML(who)}
🕒 <b>Waktu:</b> <code>${now}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━
Pilih kategori manajemen di bawah untuk mulai mengelola layanan.
`.trim();

    await safeMenuSend(ctx, content, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    logger.error('Error menu_admin:', err.message);
  }
});

// ==========================================
// 🖥️ MENU SERVER (FULL & NGEBUT)
// ==========================================
bot.action('admin_server_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const keyboard = {
  inline_keyboard: [
    [
      { text: 'Tambah Server', callback_data: 'addserver' }, 
      { text: 'Hapus Server', callback_data: 'deleteserver' }
    ],
    [
      { text: 'Edit Harga', callback_data: 'editserver_harga' }, 
      { text: 'Edit Nama', callback_data: 'nama_server_edit' }
    ],
    [
      { text: 'Edit Domain', callback_data: 'editserver_domain' }, 
      { text: 'Edit Auth', callback_data: 'editserver_auth' }
    ],
    [
      { text: 'Edit Quota', callback_data: 'editserver_quota' }, 
      { text: 'Edit IP Limit', callback_data: 'editserver_limit_ip' }
    ],
    [
      { text: 'Tambah Saldo', callback_data: 'addsaldo_user' }, 
      { text: 'Kurangi Saldo', callback_data: 'reducesaldo_user' }
    ],
    [
      { text: 'Detail Server', callback_data: 'detailserver' }, 
      { text: 'Edit Batas Create', callback_data: 'editserver_batas_create_akun' }
    ],
    [
      { text: 'Total Create', callback_data: 'editserver_total_create_akun' }, 
      { text: 'List Server', callback_data: 'listserver' }
    ],
    [
      { text: 'Reset Database', callback_data: 'resetdb' }, 
      { text: 'Kembali', callback_data: 'menu_adminreseller' }
    ]
  ]
};

    const msg = `
━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🖥️ MANAJEMEN SERVER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Gunakan menu di bawah untuk mengatur konfigurasi server, saldo user, dan monitoring create akun.</i>
`.trim();

    await safeMenuSend(ctx, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (e) { logger.error('Error server menu: ' + e.message); }
});

// ==========================================
// ⚙️ MENU SISTEM (FULL & NGEBUT)
// ==========================================
bot.action('admin_system_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Statistik',        callback_data: 'admin_stats' },
          { text: 'Daftar User',      callback_data: 'admin_listuser' }
        ],
        [          
          { text: 'Backup Data',  callback_data: 'admin_backup_db' }, 
          { text: 'Restore Data', callback_data: 'admin_restore2_db' }        
        ],
        [
          { text: 'Promote Reseller', callback_data: 'admin_promote_reseller' },
          { text: 'Downgrade User',   callback_data: 'admin_downgrade_reseller' }
        ],
        [
          { text: 'List Reseller',      callback_data: 'admin_listreseller' },
          { text: 'Reset Trial',        callback_data: 'admin_reset_trial' }
        ],
        [
          { text: '⚠️ Reseller Berisiko',   callback_data: 'admin_reseller_berisiko' },
          { text: '🔧 Sync Tgl Reseller',   callback_data: 'admin_sync_reseller_since' }
        ],
        [
          { text: '📋 Riwayat Cabut Reseller', callback_data: 'admin_riwayat_cabut' }
        ],
        [
          { text: 'Kelola Event',     callback_data: 'admin_manage_event' },
          { text: 'Pantau Event',     callback_data: 'admin_cek_peserta_event' }
        ],
        [
          { text: 'Log Top Up',       callback_data: 'admin_view_topup' },
          { text: 'Saldo Digiflazz',    callback_data: 'admin_cek_digi' }
        ],
        [
         { text: 'Broadcast',        callback_data: 'admin_broadcast' },
         { text: 'Kembali',          callback_data: 'menu_adminreseller' }
        ]
      ]
    };

    const msg = `
━━━━━━━━━━━━━━━━━━━━━━━━━
<b>⚙️ MANAJEMEN SISTEM</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Gunakan menu di bawah untuk manajemen database, broadcast, dan pengaturan reseller.</i>
`.trim();

    await safeMenuSend(ctx, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (e) {
    logger.error('Error system menu: ' + e.message);
  }
});

bot.action('admin_cek_digi', async (ctx) => {
  const data = await fetchDigiflazz('/cek-saldo', { cmd: 'deposit', sign: generateDigiSig('depo') });
  if (data && data.data) {
    ctx.reply(`💳 <b>SALDO DIGIFLAZZ</b>\nSisa Saldo: Rp ${data.data.deposit.toLocaleString()}`, { parse_mode: 'HTML' });
  } else {
    ctx.reply('❌ Gagal cek saldo Digiflazz.');
  }
});

bot.action('cek_riwayat_akun', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const riwayat = await getRiwayatAkun(userId);

    if (!riwayat || riwayat.length === 0) {
      return ctx.reply("⚠️ Kamu belum pernah membuat akun.");
    }

    let message = "📋 *DAFTAR AKUN ANDA (10 Terakhir)*\n";
    message += "━━━━━━━━━━━━━━━━━━━━\n\n";

    riwayat.forEach((item, index) => {
      // Mempercantik tampilan list
      message += `${index + 1}. *${item.layanan.toUpperCase()}*\n`;
      message += `   📧 Akun: \`${item.akun}\`\n`;
      message += `   📅 Tgl: ${item.created_at}\n\n`;
    });

    message += "━━━━━━━━━━━━━━━━━━━━\n";
    message += "_Gunakan detail di atas jika data terhapus._";

    await ctx.reply(message, { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]]
      }
    });
  } catch (err) {
    logger.error('Error riwayat akun: ' + err.message);
    ctx.reply('❌ Gagal mengambil data riwayat.');
  }
});

// Log topup
// --- HANDLER AWAL KLIK LOG TOPUP ---
bot.action('admin_view_topup', async (ctx) => {
  await ctx.answerCbQuery('Memuat riwayat topup...').catch(() => {});
  return renderAdminTopup(ctx, 1); // Lempar ke halaman 1
});

// --- FUNGSI RENDER LOG TOPUP (ADMIN VERSION) ---
async function renderAdminTopup(ctx, page) {
  const limit = 5; // Tampilkan 5 log per halaman biar rapi
  const offset = (page - 1) * limit;

     // Helper Waktu Lokal WIB dari SQLite (Garansi Akurat)
  const formatToWIB = (sqliteDateStr) => {
    if (!sqliteDateStr) return '-';
    try {
      let cleanStr = sqliteDateStr;
      if (typeof sqliteDateStr === 'string') {
        // Ganti spasi dengan 'T' agar membentuk standar ISO
        cleanStr = sqliteDateStr.replace(' ', 'T');
        
        // 🌟 KUNCINYA DI SINI: Jika string murni datetime('now') SQLite (tidak mengandung 'Z' atau '+')
        // Paksa tambahkan 'Z' di akhir agar JavaScript mendeteksinya sebagai UTC murni.
        if (!cleanStr.includes('Z') && !cleanStr.includes('+')) {
          cleanStr = cleanStr + 'Z';
        }
      }
      
      const dateObj = new Date(cleanStr);
      if (isNaN(dateObj.getTime())) return sqliteDateStr;

      return dateObj.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', 
        month: 'short', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false // Biar format 24 jam rapi
      }).replace(/\./g, ':') + ' WIB';
    } catch (e) { 
      return sqliteDateStr; 
    }
  };

  try {
    // 1. Ambil Total Data dari topup_log
    const totalData = await dbGetAsync("SELECT COUNT(*) as count FROM topup_log");
    const totalPages = Math.ceil((totalData?.count || 0) / limit);

    if (!totalData || totalData.count === 0) {
      return safeMenuSend(ctx, "<b>📭 LOG KOSONG</b>\nBelum ada riwayat topup masuk.", {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'admin_system_menu' }]] }
      });
    }

    // 2. Ambil Data per halaman (Diurutkan berdasarkan ID DESC)
    const logs = await dbAllAsync(
      `SELECT id, created_at, user_id, username, amount, reference, metode 
       FROM topup_log 
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    let text = `<b>📒 LOG TOPUP SYSTEM</b>\n`;
    text += `<i>Halaman ${page} dari ${totalPages} (Total: ${totalData.count} logs)</i>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    logs.forEach((t, i) => {
      const num = offset + i + 1;
      
      // Ambil string metode pembayaran dari database
      let sumber = t.metode || 'Pakasir (QRIS)';
      
      // Berikan icon pembeda yang rapi (Sudah ditambah filter Midtrans)
      let icon = '📦';
      if (sumber.toLowerCase().includes('orkut')) icon = '✴️';
      if (sumber.toLowerCase().includes('qris')) icon = '📱';
      if (sumber.toLowerCase().includes('midtrans')) icon = '💳'; // <-- Icon kartu untuk Midtrans

      // 🔍 LOGIKA FILTER DISTRIBUSI USER TINGKAT TINGGI (WEB VS TELE)
      const usernameStr = String(t.username || '').toLowerCase();
      const refStr = String(t.reference || '').toUpperCase();
      const currentId = Number(t.user_id || 0);

      // Mutlak Website jika:
      // 1. Username mengandung gmail.com
      // 2. ATAU Reference order id diawali kode WEB-
      // 3. ATAU ID User di database kecil/bukan format Telegram Chat ID (Telegram ID selalu > 1.000.000)
      const isWebUser = usernameStr.includes('@gmail.com') || 
                        refStr.startsWith('WEB-') || 
                        (currentId > 0 && currentId < 1000000);

      const platformBadge = isWebUser ? '🌐 [WEB]' : '🤖 [TELE]';
      const waktuWIB = formatToWIB(t.created_at);

      // ✂️ AMANKAN UKURAN TEXT: Potong Reference ID jika kepanjangan (> 15 karakter)
      let refDisplay = t.reference || '-';
      if (refDisplay !== '-' && refDisplay.length > 15) {
        refDisplay = refDisplay.substring(0, 6) + '...' + refDisplay.substring(refDisplay.length - 6);
      }

      text += `${num}. ${icon} <b>${sumber.toUpperCase()}</b> ${platformBadge}\n`;
      text += `<blockquote>`;
      text += `👤 <b>User  :</b> ${t.username || 'No Name'}\n`;
      
      // 🕵️‍♂️ Sembunyikan baris ID jika user terdeteksi berasal dari Website
      if (!isWebUser) {
        text += `🆔 <b>ID    :</b> <code>${t.user_id}</code>\n`;
      }
      
      text += `📋 <b>Ref   :</b> <code>${refDisplay}</code>\n`; // <-- Menampilkan Ref ID yang sudah dipotong ringkas
      text += `💰 <b>Nom   :</b> <b>Rp ${Number(t.amount || 0).toLocaleString('id-ID')}</b>\n`;
      text += `🕒 <b>Waktu :</b> ${waktuWIB}`;
      text += `</blockquote>\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━━`;

    // 3. Tombol Navigasi Halaman
    const buttons = [];
    const navRow = [];
    
    if (page > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `admtopup_page_${page - 1}` });
    }
    if (page < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `admtopup_page_${page + 1}` });
    }
    
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 Kembali Ke Menu Admin', callback_data: 'admin_system_menu' }]);

    await safeMenuSend(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(async () => {
      await ctx.replyWithHTML(text, { reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    });

  } catch (err) {
    logger.error('Error renderAdminTopup: ' + err.message);
    ctx.reply("❌ Gagal mengambil data log.").catch(() => {});
  }
}

// --- ACTION HANDLER NAVIGASI LOG TOPUP ---
bot.action(/^admtopup_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`Halaman ${page}`).catch(() => {});
  return renderAdminTopup(ctx, page);
});

bot.action('admin_cek_peserta_event', async (ctx) => {
  try {
    const event = await dbGetAsync("SELECT * FROM reseller_events WHERE is_active = 1 LIMIT 1");
    
    if (!event) {
      return ctx.answerCbQuery("❌ Tidak ada event yang sedang aktif.", { show_alert: true });
    }

    const participants = await dbAllAsync(`
      SELECT p.*, u.username, u.reseller_level 
      FROM reseller_event_progress p
      JOIN users u ON p.user_id = u.user_id
      WHERE p.event_id = ? AND p.current_sales > 0
      ORDER BY p.current_sales DESC
    `, [event.id]);

    let text = `╭─〔 <b>📊 MONITORING EVENT</b> 〕\n`;
    text += `│\n`;
    text += `├─ 🏆 <b>Event:</b> ${escapeHtml(event.nama_event)}\n`;
    text += `├─ 🎯 <b>Target:</b> ${event.target_penjualan} Akun\n`;
    text += `└─ 👥 <b>Peserta Aktif:</b> ${participants.length} Reseller\n\n`;

    if (participants.length === 0) {
      text += `<i>Belum ada reseller yang memulai penjualan.</i>`;
    } else {
      participants.forEach((p, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤';
        const status = p.current_sales >= event.target_penjualan ? '✅' : '⏳';
        const progressPercent = Math.min(Math.round((p.current_sales / event.target_penjualan) * 100), 100);
        
        text += `${medal} <b>${escapeHtml(p.username || 'User')}</b>\n`;
        text += `├ ID: <code>${p.user_id}</code>\n`;
        text += `├ Progres: <b>${p.current_sales}</b>/${event.target_penjualan} ${status}\n`;
        text += `└ Capaian: [${progressPercent}%]\n\n`;
      });
    }

    // Tambahkan timestamp di bawah biar admin tahu kapan data terakhir di-refresh
    text += `<i>Terakhir diupdate: ${new Date().toLocaleTimeString('id-ID')} WIB</i>`;

    const buttons = [
      [{ text: "Refresh Data", callback_data: "admin_cek_peserta_event" }],
      [{ text: "Kembali", callback_data: "admin_system_menu" }]
    ];

    await safeMenuSend(ctx, text, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: buttons } 
    }); // 🔥 Biar gak error kalau data belum berubah

  } catch (err) {
    logger.error("❌ Error Admin Cek Event: " + (err.stack || err.message || err));
    await ctx.reply("Terjadi kesalahan saat mengambil data peserta.");
  }
});

bot.action('admin_manage_event', async (ctx) => {
  const event = await dbGetAsync("SELECT * FROM reseller_events ORDER BY id DESC LIMIT 1");
  
  let text = "⚙️ *PENGATURAN EVENT RESELLER*\n\n";
  if (!event) {
    text += "❌ Belum ada event yang dibuat.";
  } else {
    text += `📌 *Nama:* ${event.nama_event}\n` +
            `🎯 *Target:* ${event.target_penjualan} Akun\n` +
            `💰 *Bonus:* Rp ${event.bonus_saldo.toLocaleString()}\n` +
            `📅 *Periode:* ${event.start_date} s/d ${event.end_date}\n` +
            `🟢 *Status:* ${event.is_active ? "AKTIF" : "NON-AKTIF"}`;
  }

  const buttons = [
    [{ text: '📝 Buat/Edit Event Baru', callback_data: 'admin_setup_event' }],
    [{ 
      text: event?.is_active ? '🔴 Tutup Event' : '🟢 Buka Event', 
      callback_data: `admin_toggle_event_${event?.id}_${event?.is_active ? 0 : 1}` 
    }],
    [{ text: 'Kembali', callback_data: 'admin_system_menu' }]
  ];

  await safeMenuSend(ctx, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
});
bot.action(/^admin_toggle_event_(\d+)_(\d+)$/, async (ctx) => {
  const id = ctx.match[1];
  const status = ctx.match[2];

  // 1. LANGSUNG JAWAB AGAR TIDAK TIMEOUT
  await ctx.answerCbQuery(`Memproses perubahan status...`).catch(() => {});

  try {
    // 2. Lakukan operasi database
    await dbRunAsync("UPDATE reseller_events SET is_active = ? WHERE id = ?", [status, id]);
    
    // 3. Update tampilan menu (Gunakan fungsi yang sudah ada atau edit text)
    // Jangan panggil bot.launch() atau startBot di sini!
    await ctx.reply(`✅ Event berhasil ${status == 1 ? 'diaktifkan' : 'dinonaktifkan'}!`);
  } catch (err) {
    logger.error('Error toggle event: ' + err.message);
  }
});

bot.action('admin_setup_event', async (ctx) => {
  const chatId = ctx.chat.id;
  userState[chatId] = { step: 'await_event_name' };
  await ctx.reply("📝 *Masukkan Nama Event:*\n(Contoh: Event Sultan Januari)", { parse_mode: 'Markdown' });
});

// Handler untuk backup manual
bot.action('admin_backup_db', async (ctx) => {
  const userId = String(ctx.from.id);

  // 1. Cek Izin Admin (Sesuai variabel di app.js kamu)
  const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    return ctx.answerCbQuery('🚫 Akses ditolak.');
  }

  let waitMessage;
  try {
    await ctx.answerCbQuery('⏳ Menyiapkan database...');
    waitMessage = await ctx.reply('⏳ *Membuat snapshot database (WAL Mode)...*', { parse_mode: 'Markdown' });

    // 2. Siapkan Path
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFileName = `sellvpn_manual_${dateStr}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    // Pastikan folder backup ada
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // 3. Eksekusi VACUUM INTO (Aman untuk Mode WAL & Sinkronisasi Saldo)
    db.run(`VACUUM INTO '${backupPath}'`, async (err) => {
      if (err) {
        logger.error(`❌ Gagal VACUUM: ${err.message}`);
        return ctx.reply(`❌ Gagal membuat snapshot: ${err.message}`);
      }

      try {
        // 4. Kirim file ke Telegram
        await ctx.telegram.sendDocument(ctx.chat.id, {
          source: backupPath,
          filename: backupFileName
        }, {
          caption: `✅ *Backup Manual Berhasil*\n📅 ${new Date().toLocaleString('id-ID')}\n📂 Mode: WAL Synchronized`,
          parse_mode: 'Markdown'
        });

        // 5. Hapus pesan tunggu & berikan info sukses
        if (waitMessage) await ctx.deleteMessage(waitMessage.message_id).catch(() => {});
        
        // 6. Bersihkan file lokal
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
          logger.info(`🧹 Backup lokal dihapus: ${backupPath}`);
        }

      } catch (sendErr) {
        logger.error(`❌ Gagal kirim backup: ${sendErr.message}`);
        ctx.reply('❌ Database berhasil dibuat tapi gagal dikirim ke Telegram.');
      }
    });

  } catch (error) {
    logger.error('❌ Error admin_backup_db:', error);
    await ctx.reply(`❌ Terjadi kesalahan: ${error.message}`);
  }
});

bot.action('admin_reset_trial', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('❌ Akses ditolak bro.');
  }

  try {
    await dbRunAsync(`UPDATE users SET trial_count_today = 0, last_trial_date = date('now')`);
    await ctx.reply('✅ *Semua trial user telah direset ke 0.*', { parse_mode: 'Markdown' });
    logger.info(`🔄 Admin ${userId} melakukan reset trial harian.`);
  } catch (err) {
    logger.error('❌ Gagal reset trial harian:', err.message);
    await ctx.reply('❌ *Gagal melakukan reset trial.*', { parse_mode: 'Markdown' });
  }
});


// ACTION: minta upload file backup
bot.action('admin_restore2_db', async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;

  // Pastikan ID pengguna adalah admin (aman kalau adminIds belum didefinisikan)
  const adminList = global.adminIds 
    || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    await ctx.answerCbQuery('🚫 Akses ditolak.');
    return ctx.reply('🚫 *Akses ditolak.*', { parse_mode: 'Markdown' });
  }

  // Set state pengguna ke langkah 'await_restore_upload'
  userState[chatId] = { step: 'await_restore_upload' };

  await ctx.answerCbQuery('Proses restore dimulai.');
  await ctx.reply(
    '📤 *Silakan kirim file backup database (.db) yang ingin direstore.*\n' +
    '_Contoh: sellvpn_2025-06-01_10-00.db_',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/admin_listreseller(?::(\d+))?/, async (ctx) => {
  const userId = String(ctx.from.id);

  const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    return ctx.answerCbQuery('🚫 Izin Ditolak!', { show_alert: true });
  }

  const page   = ctx.match[1] ? parseInt(ctx.match[1]) : 1;
  const limit  = 5;
  const offset = (page - 1) * limit;

  try {
    await ctx.answerCbQuery('Memuat data reseller...').catch(() => {});

    const totalData = await dbGetAsync("SELECT COUNT(*) as count FROM users WHERE role = 'reseller'");
    const rows = await dbAllAsync(`
      SELECT user_id, username, saldo
      FROM users
      WHERE role = 'reseller'
      ORDER BY saldo DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    if (!rows || rows.length === 0) {
      return safeMenuSend(ctx, '⚠️ <b>Belum ada reseller terdaftar.</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_system_menu' }]] }
      });
    }

    const list = rows.map((row, i) => {
      const rank     = offset + i + 1;
      const username = row.username ? `@${row.username}` : 'No Username';
      const medal    = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : '🔹 ';

      return `${medal}<b>${username}</b>
<blockquote>ID    : <code>${row.user_id}</code>
Diskon: <code>30%</code>
Saldo : <b>Rp ${row.saldo.toLocaleString('id-ID')}</b></blockquote>`;
    }).join('\n');

    const totalPages = Math.ceil(totalData.count / limit);
    const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏆 <b>DAFTAR RESELLER AKTIF (${totalData.count})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${list}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Halaman ${page} dari ${totalPages}</i>
`.trim();

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Prev', callback_data: `admin_listreseller:${page - 1}` });
    if (page < totalPages) navButtons.push({ text: 'Next ➡️', callback_data: `admin_listreseller:${page + 1}` });

    const keyboard = {
      inline_keyboard: [
        ...(navButtons.length ? [navButtons] : []),
        [{ text: '🔄 REFRESH', callback_data: `admin_listreseller:${page}` }],
        [{ text: '⬅️ KEMBALI KE MENU ADMIN', callback_data: 'admin_system_menu' }]
      ]
    };

    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });

  } catch (err) {
    logger.error('❌ Gagal ambil list reseller:', err.message);
    ctx.reply('❌ Gagal mengambil daftar reseller.');
  }
});

// ===================== ACTION: ADMIN RESELLER BERISIKO =====================
bot.action(/admin_reseller_berisiko(?::(\d+))?/, async (ctx) => {
  const userId = String(ctx.from.id);
  const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    return ctx.answerCbQuery('🚫 Izin Ditolak!', { show_alert: true });
  }

  const page   = ctx.match[1] ? parseInt(ctx.match[1]) : 1;
  const limit  = 5;
  const offset = (page - 1) * limit;

  try {
    await ctx.answerCbQuery('Memuat data reseller berisiko...').catch(() => {});

    // Ambil semua reseller dengan saldo < 30.000, urutkan dari yang paling kritis (sisa hari paling sedikit)
    const totalData = await dbGetAsync(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE role = 'reseller'
        AND saldo < 30000
    `);

    const rows = await dbAllAsync(`
      SELECT
        user_id, username, first_name, saldo, reseller_since,
        warned_h7, warned_h3,
        CAST(julianday('now') - julianday(reseller_since) AS INTEGER) AS hari_jalan,
        MAX(0, 60 - CAST(julianday('now') - julianday(reseller_since) AS INTEGER)) AS hari_sisa
      FROM users
      WHERE role = 'reseller'
        AND saldo < 30000
      ORDER BY
        CASE WHEN reseller_since IS NULL THEN 1 ELSE 0 END,
        hari_sisa ASC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    if (!rows || rows.length === 0) {
      await safeMenuSend(ctx, '✅ <b>Tidak ada reseller yang berisiko saat ini.</b>\n\nSemua reseller memiliki saldo di atas Rp 30.000.', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_system_menu' }]] }
      });
      return;
    }

    const totalCount  = totalData?.count || 0;
    const totalPages  = Math.ceil(totalCount / limit);

    const list = rows.map((row, i) => {
      const rank       = offset + i + 1;
      const nama       = row.username ? `@${escapeHtml(row.username)}` : escapeHtml(row.first_name || `ID ${row.user_id}`);
      const saldoFmt   = Number(row.saldo || 0).toLocaleString('id-ID');
      const hariJalan  = row.hari_jalan ?? '-';
      const hariSisa   = row.reseller_since != null ? row.hari_sisa : null;

      // Status icon berdasarkan sisa hari
      let statusIcon, statusTeks;
      if (hariSisa === null) {
        statusIcon = '⚪'; statusTeks = 'Tanggal upgrade tidak diketahui';
      } else if (hariSisa <= 3) {
        statusIcon = '🔴'; statusTeks = `KRITIS — ${hariSisa} hari lagi!`;
      } else if (hariSisa <= 7) {
        statusIcon = '🟡'; statusTeks = `WASPADA — ${hariSisa} hari lagi`;
      } else {
        statusIcon = '🟠'; statusTeks = `Perhatian — ${hariSisa} hari lagi`;
      }

      // Badge warning
      const warnBadge = row.warned_h3
        ? ' <code>[H-3 ✓]</code>'
        : row.warned_h7 ? ' <code>[H-7 ✓]</code>' : '';

      return `${rank}. ${statusIcon} <b>${nama}</b>${warnBadge}\n` +
             `<blockquote>` +
             `ID      : <code>${row.user_id}</code>\n` +
             `Saldo   : <b>Rp ${saldoFmt}</b>\n` +
             `Berjalan: ${hariJalan} hari\n` +
             `Status  : ${statusTeks}` +
             `</blockquote>`;
    }).join('\n');

    // Ringkasan jumlah per level kritis
    const summary = await dbGetAsync(`
      SELECT
        SUM(CASE WHEN reseller_since IS NOT NULL AND (60 - CAST(julianday('now') - julianday(reseller_since) AS INTEGER)) <= 3  THEN 1 ELSE 0 END) AS kritis,
        SUM(CASE WHEN reseller_since IS NOT NULL AND (60 - CAST(julianday('now') - julianday(reseller_since) AS INTEGER)) BETWEEN 4 AND 7 THEN 1 ELSE 0 END) AS waspada,
        SUM(CASE WHEN reseller_since IS NOT NULL AND (60 - CAST(julianday('now') - julianday(reseller_since) AS INTEGER)) > 7  THEN 1 ELSE 0 END) AS perhatian,
        SUM(CASE WHEN reseller_since IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM users
      WHERE role = 'reseller' AND saldo < 30000
    `);

    const text =
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⚠️ <b>RESELLER BERISIKO (${totalCount})</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔴 Kritis  : <b>${summary?.kritis || 0}</b> reseller\n` +
      `🟡 Waspada : <b>${summary?.waspada || 0}</b> reseller\n` +
      `🟠 Perhatian: <b>${summary?.perhatian || 0}</b> reseller\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      list + '\n' +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Halaman ${page} dari ${totalPages}</i>`;

    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⬅️ Prev', callback_data: `admin_reseller_berisiko:${page - 1}` });
    if (page < totalPages) navButtons.push({ text: 'Next ➡️', callback_data: `admin_reseller_berisiko:${page + 1}` });

    const keyboard = {
      inline_keyboard: [
        ...(navButtons.length ? [navButtons] : []),
        [{ text: '🔄 Refresh', callback_data: `admin_reseller_berisiko:${page}` }],
        [{ text: '⬅️ KEMBALI KE MENU ADMIN', callback_data: 'admin_system_menu' }]
      ]
    };

    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard });

  } catch (err) {
    logger.error('❌ Gagal ambil reseller berisiko: ' + err.message);
    ctx.reply('❌ Gagal mengambil data reseller berisiko.').catch(() => {});
  }
});

// ===================== ACTION: ADMIN RIWAYAT CABUT RESELLER =====================
bot.action(/admin_riwayat_cabut(?::(\d+))?/, async (ctx) => {
  const userId = String(ctx.from.id);
  const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    return ctx.answerCbQuery('🚫 Izin Ditolak!', { show_alert: true });
  }
  await ctx.answerCbQuery('Memuat riwayat pencabutan...').catch(() => {});

  const match = ctx.match?.[1];
  const page  = Math.max(1, parseInt(match || '1', 10));
  const limit = 5;
  const offset = (page - 1) * limit;

  try {
    const totalData = await dbGetAsync(`SELECT COUNT(*) AS count FROM reseller_cabut_log`);
    const totalCount = totalData?.count || 0;

    if (totalCount === 0) {
      await safeMenuSend(ctx, `📋 <b>Riwayat Cabut Reseller</b>\n\n✅ Belum ada riwayat pencabutan reseller.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_system_menu' }]] }
      });
      return;
    }

    const rows = await dbAllAsync(`
      SELECT user_id, username, first_name, saldo_terakhir, reseller_since, hari_berjalan, alasan, dicabut_at
      FROM reseller_cabut_log
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    const totalPages = Math.ceil(totalCount / limit);

    let teks = `📋 <b>RIWAYAT CABUT RESELLER</b>\n`;
    teks += `<i>Total: ${totalCount} pencabutan | Hal ${page}/${totalPages}</i>\n`;
    teks += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const row of rows) {
      const nama      = escapeHtml(row.first_name || row.username || `ID ${row.user_id}`);
      const saldoFmt  = Number(row.saldo_terakhir || 0).toLocaleString('id-ID');
      const sejak     = row.reseller_since
        ? new Date(row.reseller_since).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' })
        : '-';
      const dicabutAt = row.dicabut_at
        ? new Date(row.dicabut_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })
        : '-';

      teks +=
        `👤 <b>${nama}</b> (<code>${row.user_id}</code>)\n` +
        `💰 Saldo Terakhir : Rp ${saldoFmt}\n` +
        `📅 Jadi Reseller  : ${sejak}\n` +
        `⏱ Hari Berjalan  : ${row.hari_berjalan !== null ? row.hari_berjalan + ' hari' : '-'}\n` +
        `🗓 Dicabut Pada   : ${dicabutAt}\n` +
        `📌 Alasan         : ${escapeHtml(row.alasan || '-')}\n\n`;
    }

    const navButtons = [];
    if (page > 1)          navButtons.push({ text: '⬅️ Prev', callback_data: `admin_riwayat_cabut:${page - 1}` });
    if (page < totalPages) navButtons.push({ text: 'Next ➡️', callback_data: `admin_riwayat_cabut:${page + 1}` });

    const keyboard = { inline_keyboard: [] };
    if (navButtons.length) keyboard.inline_keyboard.push(navButtons);
    keyboard.inline_keyboard.push([{ text: '🔄 Refresh', callback_data: `admin_riwayat_cabut:${page}` }]);
    keyboard.inline_keyboard.push([{ text: '⬅️ KEMBALI KE MENU ADMIN', callback_data: 'admin_system_menu' }]);

    await safeMenuSend(ctx, teks, { parse_mode: 'HTML', reply_markup: keyboard });

  } catch (err) {
    logger.error('❌ Gagal ambil riwayat cabut reseller: ' + err.message);
    ctx.reply('❌ Gagal mengambil riwayat pencabutan.').catch(() => {});
  }
});

// ===================== ACTION: ADMIN SYNC RESELLER SINCE =====================
bot.action('admin_sync_reseller_since', async (ctx) => {
  const userId = String(ctx.from.id);
  const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    return ctx.answerCbQuery('🚫 Izin Ditolak!', { show_alert: true });
  }

  try {
    await ctx.answerCbQuery('⏳ Sedang sinkronisasi...').catch(() => {});

    // Sebelum sinkronisasi — hitung yang masih NULL
    const before = await dbGetAsync(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'reseller' AND reseller_since IS NULL"
    );

    // Step 1: reseller yang punya data di reseller_upgrade_log → pakai tanggal upgrade terakhir
    await dbRunAsync(`
      UPDATE users
      SET reseller_since = (
        SELECT MAX(created_at)
        FROM reseller_upgrade_log
        WHERE reseller_upgrade_log.user_id = users.user_id
      )
      WHERE role = 'reseller'
        AND reseller_since IS NULL
        AND EXISTS (
          SELECT 1 FROM reseller_upgrade_log
          WHERE reseller_upgrade_log.user_id = users.user_id
        )
    `);

    // Step 2: reseller tanpa data log → set clock mulai dari sekarang
    await dbRunAsync(`
      UPDATE users
      SET reseller_since = datetime('now')
      WHERE role = 'reseller'
        AND reseller_since IS NULL
    `);

    // Setelah sinkronisasi — hitung hasil
    const after = await dbGetAsync(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'reseller' AND reseller_since IS NOT NULL"
    );
    const stillNull = await dbGetAsync(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'reseller' AND reseller_since IS NULL"
    );

    const synced = (before?.total || 0);
    const text =
      `✅ <b>Sinkronisasi Selesai</b>\n\n` +
      `📊 <b>Hasil:</b>\n` +
      `<blockquote>` +
      `• Diproses     : <b>${synced}</b> reseller\n` +
      `• Sudah tersync: <b>${after?.total || 0}</b> reseller\n` +
      `• Masih kosong : <b>${stillNull?.total || 0}</b> reseller` +
      `</blockquote>\n\n` +
      (synced === 0
        ? `ℹ️ Semua reseller sudah memiliki tanggal upgrade. Tidak ada yang perlu disinkronisasi.`
        : `✅ Tanggal upgrade berhasil diisi.\n` +
          `Reseller yang tidak punya log upgrade otomatis mendapat tanggal mulai dari hari ini.`
      );

    await safeMenuSend(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ KEMBALI KE MENU ADMIN', callback_data: 'admin_system_menu' }]
        ]
      }
    });

    logger.info(`✅ [Admin] Sync reseller_since selesai. Diproses: ${synced}, tersync: ${after?.total || 0}`);
  } catch (err) {
    logger.error('❌ Error sync reseller_since: ' + err.message);
    await ctx.reply('❌ Gagal sinkronisasi. Coba lagi nanti.', { parse_mode: 'HTML' }).catch(() => {});
  }
});

bot.action('admin_stats', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('❌ Akses Ditolak.', { show_alert: true });
  }

  try {
    // 1. Instant Feedback
    await ctx.answerCbQuery('Menghitung statistik terbaru...').catch(() => {});

    // 2. Ambil Data Paralel (Hanya data yang diperlukan)
    const [
      jumlahUser,
      jumlahReseller,
      jumlahServer,
      totalSaldo,
      totalTransaksi,
      topBuyer // Ganti Top Reseller Komisi dengan Top Buyer (Opsional/Bisa dihapus)
    ] = await Promise.all([
      dbGetAsync('SELECT COUNT(*) AS count FROM users'),
      dbGetAsync("SELECT COUNT(*) AS count FROM users WHERE role = 'reseller'"),
      dbGetAsync('SELECT COUNT(*) AS count FROM Server'),
      dbGetAsync('SELECT SUM(saldo) AS total FROM users'),
      dbGetAsync('SELECT COUNT(*) AS count FROM invoice_log'),
      dbAllAsync(`
        SELECT u.username, i.user_id, COUNT(*) AS total_order
        FROM invoice_log i
        LEFT JOIN users u ON u.user_id = i.user_id
        GROUP BY i.user_id
        ORDER BY total_order DESC
        LIMIT 3
      `)
    ]);

    // 3. Susun Teks Statistik Sistem
    const sistemHtml = `
━━━━━━━━━━━━━━━━━━━━━━
📊 <b>STATISTIK SISTEM</b>
━━━━━━━━━━━━━━━━━━━━━━
<blockquote>👥 <b>Total User</b>   : <code>${jumlahUser?.count || 0} Member</code>
👑 <b>Total Reseller</b> : <code>${jumlahReseller?.count || 0} Official</code>
🖥️ <b>Total Server</b>   : <code>${jumlahServer?.count || 0} Aktif</code>
💰 <b>Total Saldo</b>   : <b>Rp ${(totalSaldo?.total || 0).toLocaleString('id-ID')}</b></blockquote>
`.trim();

    let globalHtml = `
🌐 <b>STATISTIK GLOBAL</b>
<blockquote>📦 <b>Total Transaksi</b> : <code>${totalTransaksi?.count || 0} Sukses</code></blockquote>
`.trim();

    // 4. Ganti Top Reseller Komisi menjadi Top Buyer (Berdasarkan jumlah transaksi)
    if (topBuyer && topBuyer.length > 0) {
      globalHtml += `\n\n🏆 <b>TOP 3 BUYER (TRANSAKSI)</b>\n`;
      const medals = ['🥇', '🥈', '🥉'];
      
      topBuyer.forEach((r, i) => {
        const medal = medals[i] || '⭐';
        const label = r.username ? `@${r.username}` : `ID:<code>${r.user_id}</code>`;
        const orderCount = (r.total_order || 0).toLocaleString('id-ID');
        globalHtml += `${medal} ${label} — <b>${orderCount} Order</b>\n`;
      });
    }

    const finalHtml = `${sistemHtml}\n\n${globalHtml}\n━━━━━━━━━━━━━━━━━━━━━━`.trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 REFRESH DATA', callback_data: 'admin_stats' }],
        [{ text: '🔙 KEMBALI', callback_data: 'admin_system_menu' }]
      ]
    };

    // 5. Eksekusi Kirim
    await safeMenuSend(ctx, finalHtml, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

  } catch (err) {
    logger.error('❌ Gagal ambil statistik admin: ' + (err.message || err));
    await ctx.reply('❌ <b>Gagal Memuat Statistik</b>\nSistem sedang sibuk hitung database.', { parse_mode: 'HTML' });
  }
});

bot.action('admin_broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);

  if (!adminIds.includes(userId)) {
    return ctx.reply('❌ Perintah ini hanya untuk admin.');
  }

  userState[ctx.chat.id] = { step: 'await_broadcast_message' };

  return safeMenuSend(ctx,
    '📣 *Mode Broadcast Aktif*\n\n' +
    '📝 Kirim pesan yang ingin di-broadcast:\n' +
    '• Text biasa ✍️\n' +
    '• Sticker 🎨\n' +
    '• Foto 📷\n' +
    '• Video 🎥\n' +
    '• GIF 🎞️\n\n' +
    '💡 Bot akan tanya konfirmasi setelah kamu kirim.',
    { parse_mode: 'Markdown' }
  );
});
// =====================================
// BROADCAST TEXT CONFIRM
// =====================================
bot.action('broadcast_text_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const state = userState[userId]; 

  if (!state || !adminIds.includes(userId)) {
    return safeMenuSend(ctx, '❌ Session expired atau tidak punya izin.');
  }

  const broadcastMessage = state.broadcastText;

  if (!broadcastMessage) {
    return ctx.reply('❌ Pesan tidak ditemukan.');
  }

  delete userState[userId];

  const users = await dbAllAsync('SELECT user_id FROM users');
  const BATCH_SIZE = 20;
  const DELAY = 300;

  await safeMenuSend(ctx, `📣 Mengirim broadcast ke ${users.length} pengguna...\n⏳ Proses berjalan di background.`);

  // ✅ Jalankan di background — TIDAK di-await agar handler segera return
  (async () => {
    let sukses = 0;
    let gagal = 0;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (u) => {
        try {
          await bot.telegram.sendMessage(u.user_id, broadcastMessage);
          sukses++;
        } catch (err) {
          gagal++;
        }
      }));

      await new Promise(res => setTimeout(res, DELAY));
    }

    // Notif admin setelah selesai
    await bot.telegram.sendMessage(
      userId,
      `📣 *Broadcast TEXT selesai!*\n\n✅ Berhasil: ${sukses}\n❌ Gagal: ${gagal}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  })().catch((err) => logger.error('Broadcast text background error: ' + err.message));

  // ✅ Handler langsung return — tidak tunggu broadcast selesai
});
// =====================================
// BROADCAST MEDIA CONFIRM
// =====================================
bot.action('broadcast_media_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const state = userState[userId];

  if (!state || !adminIds.includes(userId)) {
    return safeMenuSend(ctx, '❌ Session expired atau tidak punya izin.');
  }

  const { messageId, chatId: sourceChatId, mediaType } = state;
  delete userState[userId];

  const users = await dbAllAsync('SELECT user_id FROM users');

  await safeMenuSend(ctx,
    `📣 Mengirim broadcast ${mediaType.toUpperCase()} ke ${users.length} pengguna...\n` +
    `⏳ Tunggu, proses ini memakan waktu lebih lama.`
  );

  // ✅ Jalankan broadcast di background — TIDAK di-await
  (async () => {
    const BATCH_SIZE = 15;
    const DELAY = 500;
    let sukses = 0;
    let gagal = 0;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (u) => {
        try {
          await bot.telegram.copyMessage(u.user_id, sourceChatId, messageId);
          sukses++;
        } catch (err) {
          gagal++;
        }
      }));

      await new Promise(res => setTimeout(res, DELAY));
    }

    // Notif admin setelah selesai
    await bot.telegram.sendMessage(
      userId,
      `📣 *Broadcast ${mediaType.toUpperCase()} selesai!*\n\n✅ Berhasil: ${sukses}\n❌ Gagal: ${gagal}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  })().catch((err) => logger.error('Broadcast background error: ' + err.message));

  // ✅ Handler langsung return — tidak tunggu broadcast selesai
});
// =====================================
// CANCEL BROADCAST
// =====================================
bot.action('cancel_broadcast', async (ctx) => {
  await ctx.answerCbQuery('❌ Broadcast dibatalkan');

  const userId = String(ctx.from.id); // ✅ FIX

  delete userState[userId]; // ✅ FIX

  return safeMenuSend(ctx,
    '❌ *Broadcast dibatalkan.*',
    { parse_mode: 'Markdown' }
  );
});

bot.action('admin_downgrade_reseller', async (ctx) => {
  const adminId = String(ctx.from.id);
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ *Khusus admin.*', { parse_mode: 'Markdown' });
  }

  userState[ctx.chat.id] = { step: 'await_downgrade_id' };
  return ctx.reply('📥 *Masukkan ID user yang ingin di-DOWNGRADE ke user biasa:*', {
    parse_mode: 'Markdown'
  });
});

bot.action('admin_promote_reseller', async (ctx) => {
  const adminId = String(ctx.from.id);
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin)
    ? rawAdmin.map(String)
    : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ Hanya admin yang bisa akses fitur ini.');
  }

  // Prompt input user ID
  userState[ctx.chat.id] = { step: 'await_reseller_id' };
  setTimeout(() => {
  if (userState[ctx.chat.id]?.step === 'await_reseller_id') {
    delete userState[ctx.chat.id];
    ctx.reply('⏳ Waktu habis. Silakan ulangi /promote_reseller jika masih ingin mempromosikan user.');
  }
}, 30000); // 30 detik
  return ctx.reply('📥 Masukkan user ID yang ingin dipromosikan jadi reseller:');
});

// 1. TARUH DI ATAS (DEKAT DEKLARASI BOT)
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

bot.action('admin_listserver', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Kamu tidak memiliki izin.');
  }

  db.all('SELECT * FROM Server ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      logger.error('❌ Error ambil list server:', err.message);
      return ctx.reply('⚠️ Gagal mengambil data server.');
    }

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Belum ada server yang ditambahkan.');
    }

    const list = rows.map((row, i) => {
      return `${i + 1}. ${row.nama_server}\n` +
             `🌐 Domain   : ${row.domain}\n` +
             `🔐 Auth     : ${row.auth}\n` +
             `💾 Quota    : ${row.quota} GB\n` +
             `🌍 IP Limit : ${row.iplimit}\n` +
             `📦 Harga    : Rp${row.harga.toLocaleString('id-ID')}\n` +
             `🧮 Total Buat: ${row.total_create_akun}`;
    }).join('\n──────────────\n');

    const msg = `📄 List Server Tersimpan:\n\n${list}`;
    ctx.reply(msg);
  });
});


// --- CONFIGURATION ---
const USERS_PER_PAGE = 10;

bot.action(/admin_listuser_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1]); // Ambil angka halaman dari callback_data
  await handleListUser(ctx, page);
});

// Callback original biar tetep jalan dari menu utama
bot.action('admin_listuser', async (ctx) => {
  await handleListUser(ctx, 1);
});

async function handleListUser(ctx, page) {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Akses Ditolak: Khusus Admin.');
  }

  try {
    await ctx.answerCbQuery('Memuat data...').catch(() => {});
    const offset = (page - 1) * USERS_PER_PAGE;

    // 1. Ambil data user dengan limit dan offset
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT user_id, username, role, saldo FROM users 
         ORDER BY (role = 'admin') DESC, saldo DESC 
         LIMIT ? OFFSET ?`, 
        [USERS_PER_PAGE, offset], 
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    // 2. Hitung total user untuk menentukan tombol Next
    const totalUser = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM users', (err, row) => resolve(row.count || 0));
    });

    if (!rows || rows.length === 0) {
      return safeMenuSend(ctx, '📭 <b>Database Kosong</b> atau Halaman Tidak Ditemukan.', { 
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_system_menu' }]] }
      });
    }

    // 3. Format List
    const list = rows.map((row, i) => {
      const globalIndex = offset + i + 1;
      const username = row.username ? `@${row.username}` : `User [Tanpa Username]`;
      return `<b>${globalIndex}. ${username}</b>\n<blockquote>ID: <code>${row.user_id}</code> | Rp ${row.saldo.toLocaleString('id-ID')}</blockquote>`;
    }).join('\n');

    const totalPages = Math.ceil(totalUser / USERS_PER_PAGE);
    const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>DAFTAR PENGGUNA (Hal. ${page}/${totalPages})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${list}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total: <b>${totalUser} User</b>
`.trim();

    // 4. Keyboard Navigasi
    const navButtons = [];
    if (page > 1) navButtons.push({ text: 'Prev', callback_data: `admin_listuser_${page - 1}` });
    if (page < totalPages) navButtons.push({ text: 'Next ', callback_data: `admin_listuser_${page + 1}` });

    const keyboard = {
      inline_keyboard: [
        navButtons,
        [{ text: 'REFRESH', callback_data: `admin_listuser_${page}` }],
        [{ text: 'KEMBALI', callback_data: 'admin_system_menu' }]
      ]
    };

    await safeMenuSend(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

  } catch (err) {
    logger.error('❌ Gagal ambil list user:', err.message);
    ctx.reply('❌ Terjadi kesalahan saat menarik data.');
  }
}

// -- handler Service --
bot.action('service_create', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'create');
});

bot.action('service_renew', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'renew');
});

bot.action('service_trial', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'trial');
});

// ===================== ACTION: MENU RESELLER =====================
bot.action('menu_reseller', async (ctx) => {
  const userId = ctx.from.id;

  try {
    await ctx.answerCbQuery().catch(() => {});

    const row = await dbGetAsync('SELECT role, saldo FROM users WHERE user_id = ?', [userId]);

    if (!row || row.role !== 'reseller') {
      return ctx.reply('❌ <b>Akses Terbatas:</b> Menu ini hanya untuk Reseller Official.', { parse_mode: 'HTML' });
    }

    const saldo = row.saldo || 0;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Jakarta'
    });

    const keyboard = {
      inline_keyboard: [
        [
          { text: '📊 Riwayat Jualan', callback_data: 'reseller_riwayat' },
          { text: '📤 Export Data',    callback_data: 'reseller_export' }
        ],
        [
          { text: '🏆 Top Mingguan',   callback_data: 'reseller_top_weekly' },
          { text: '🥇 Top All Time',   callback_data: 'reseller_top_all' }
        ],
        [
          { text: '👥 List & Expired', callback_data: 'reseller_list_akun' },
          { text: '🗑️ Delete Akun',    callback_data: 'delete_confirm' }
        ],
        [
          { text: '🎯 Event Reseller', callback_data: 'menu_event_reseller' },
          { text: '🔍 Cek Status',     callback_data: 'reseller_cek_status' }
        ],
        [{ text: '🔙 Kembali Ke Menu Utama', callback_data: 'send_main_menu' }]
      ]
    };

    const content = `
 <b>💼 RESELLER DASHBOARD</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<blockquote>👤 <b>Status</b>  : <code>Reseller Official</code>
💰 <b>Saldo</b>   : <b>Rp ${saldo.toLocaleString('id-ID')}</b>
🎁 <b>Diskon</b> : <code>Flat 30% All Service</code>
🕒 <b>Waktu</b>  : ${timeStr} WIB</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

    await safeMenuSend(ctx, content, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    });

  } catch (err) {
    logger.error('❌ Error menu_reseller: ' + (err.message || err));
    return ctx.reply('⚠️ Terjadi kesalahan saat memuat menu reseller.', { parse_mode: 'HTML' });
  }
});
// ===================== ACTION: CEK STATUS RESELLER =====================
bot.action('reseller_cek_status', async (ctx) => {
  const userId = ctx.from.id;
  try {
    await ctx.answerCbQuery();
    const user = await dbGetAsync(
      'SELECT saldo, role, username, first_name, reseller_since, warned_h7, warned_h3 FROM users WHERE user_id = ?',
      [userId]
    );
    if (!user || user.role !== 'reseller') {
      return ctx.reply('❌ <b>Akses Terbatas:</b> Menu ini hanya untuk Reseller.', { parse_mode: 'HTML' });
    }
    const saldo    = Number(user.saldo || 0);
    const saldoFmt = saldo.toLocaleString('id-ID');
    const namaUser = user.first_name || user.username || `ID ${userId}`;

    let hariJalan = null, hariSisa = null, deadlineFmt = '-', upgradeFmt = '-';
    if (user.reseller_since) {
      const sinceMs = new Date(user.reseller_since).getTime();
      hariJalan     = Math.floor((Date.now() - sinceMs) / 86400000);
      hariSisa      = Math.max(0, 60 - hariJalan);
      upgradeFmt    = new Date(user.reseller_since).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
      const deadlineDate = new Date(user.reseller_since);
      deadlineDate.setDate(deadlineDate.getDate() + 60);
      deadlineFmt = deadlineDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
    }

    const aman       = saldo >= 30000;
    const statusIcon = aman ? '🟢' : (hariSisa !== null && hariSisa <= 3 ? '🔴' : '🟡');
    const statusTeks = aman
      ? 'AMAN — Saldo mencukupi'
      : (hariSisa !== null && hariSisa <= 3 ? 'KRITIS — Segera top up!' : 'WASPADA — Saldo di bawah batas');

    const lewatDeadline = hariJalan !== null && hariJalan >= 60;

    const progressBar = (() => {
      if (hariJalan === null) return '—';
      if (lewatDeadline) return `████████████████████ ⚠️ +${hariJalan - 60} hari melewati deadline`;
      const filled = Math.round((hariJalan / 60) * 20);
      return '█'.repeat(filled) + '░'.repeat(20 - filled) + ` ${hariJalan}/60 hari`;
    })();

    const sisaWaktuTeks = (() => {
      if (hariSisa === null) return '-';
      if (lewatDeadline) return `<b>⚠️ Sudah melewati deadline ${hariJalan - 60} hari!</b>`;
      return `<b>${hariSisa} hari lagi</b>`;
    })();

    let warningInfo = '';
    if (!aman) {
      if (user.warned_h3)      warningInfo = '\n⚠️ <b>Peringatan terakhir (H-3) sudah dikirim</b>';
      else if (user.warned_h7) warningInfo = '\n⚠️ <b>Peringatan H-7 sudah dikirim</b>';
      // Hanya tampilkan "akan segera dikirim" jika belum lewat deadline
      else if (hariJalan !== null && hariJalan >= 53 && !lewatDeadline) warningInfo = '\n🔔 Peringatan akan segera dikirim';
    }

    const content =
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>🔍 CEK STATUS RESELLER</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Nama</b>      : ${escapeHtml(namaUser)}\n` +
      `💰 <b>Saldo</b>     : <b>Rp ${saldoFmt}</b>\n` +
      `📌 <b>Batas Min</b> : Rp 30.000\n\n` +
      `<b>📅 Info Periode</b>\n` +
      `<blockquote>` +
      `• Jadi Reseller : ${upgradeFmt}\n` +
      `• Deadline      : ${deadlineFmt}\n` +
      `• Hari Berjalan : ${hariJalan !== null ? hariJalan : '-'} hari\n` +
      `• Sisa Waktu    : ${sisaWaktuTeks}\n` +
      `• Progress      : <code>${progressBar}</code>` +
      `</blockquote>\n` +
      `<b>${statusIcon} Status : ${statusTeks}</b>${warningInfo}\n` +
      (aman
        ? `\n✅ Pertahankan saldo di atas Rp 30.000 agar status reseller tetap aktif.`
        : `\n⚡ Segera top up saldo minimal <b>Rp ${(30000 - saldo).toLocaleString('id-ID')}</b> lagi agar aman.`
      );

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'reseller_cek_status' }],
        [{ text: '⬅️ Kembali ke Dashboard', callback_data: 'menu_reseller' }]
      ]
    };
    await safeMenuSend(ctx, content, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
  } catch (err) {
    logger.error('❌ Error reseller_cek_status: ' + (err.message || err));
    await ctx.reply('⚠️ Terjadi kesalahan. Coba lagi nanti.', { parse_mode: 'HTML' }).catch(() => {});
  }
});

// Handler Tombol Utama Delete
bot.action('delete_confirm', async (ctx) => {
  return renderDeletePage(ctx, ctx.from.id, 1);
});

// Handler Navigasi Delete
bot.action(/^del_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  return renderDeletePage(ctx, ctx.from.id, page);
});
bot.action(/^del_ask:(.+):(.+):(.+)$/, async (ctx) => {
  const type = ctx.match[1];
  const username = ctx.match[2];
  const srvId = ctx.match[3];

  try {
    const server = await dbGetAsync("SELECT nama_server FROM Server WHERE id = ?", [srvId]);
    
    // Cek selisih waktu buat info di menu konfirmasi
    const lastOrder = await dbGetAsync(
      `SELECT harga, (strftime('%s', 'now') - strftime('%s', created_at)) / 3600 AS selisih_jam
       FROM invoice_log WHERE user_id = ? AND akun = ? AND layanan = ? 
       ORDER BY id DESC LIMIT 1`,
      [ctx.from.id, username, server.nama_server]
    );

    let refundInfo = "❌ Tidak ada refund (Sudah lewat 24 jam)";
    if (lastOrder && lastOrder.selisih_jam < 24) {
      refundInfo = `✅ Refund Saldo: Rp ${lastOrder.harga.toLocaleString('id-ID')}`;
    }

    const msg = `<b>⚠️ KONFIRMASI HAPUS</b>\n\n` +
                `Apakah kamu yakin ingin menghapus akun ini?\n\n` +
                `👤 <b>Username:</b> <code>${username}</code>\n` +
                `📡 <b>Service:</b> ${type.toUpperCase()}\n` +
                `🚀 <b>Server:</b> ${server.nama_server}\n` +
                `💰 <b>Status:</b> ${refundInfo}\n\n` +
                `<i>Tindakan ini tidak dapat dibatalkan!</i>`;

    await safeEdit(ctx, msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'YA, HAPUS', callback_data: `del_confirm_v2:${type}:${username}:${srvId}` },
            { text: 'BATAL', callback_data: 'delete_confirm' } // Balik ke list delete
          ]
        ]
      }
    });
  } catch (err) {
    logger.error("Gagal memuat konfirmasi: " + (err.stack || err.message || err));
    ctx.reply("❌ Gagal memuat konfirmasi.");
  }
});

bot.action(/^del_confirm_v2:(.+):(.+):(.+)$/, async (ctx) => {
  const type = ctx.match[1].toLowerCase().trim();
  const username = ctx.match[2].trim();
  const srvId = ctx.match[3];
  const userId = ctx.from.id;

  try {
    await ctx.answerCbQuery('⌛ Memproses Penghapusan...').catch(() => {});

    const server = await dbGetAsync("SELECT * FROM Server WHERE id = ?", [srvId]);
    if (!server) return ctx.reply('❌ Server tidak ditemukan.');

    // 1. AMBIL DATA ORDER TERAKHIR YANG MASIH AKTIF (hari > 0)
    // Filter 'hari > 0' ini WAJIB supaya tidak narik data sampah/lama
    const lastOrder = await dbGetAsync(
      `SELECT harga, (strftime('%s', 'now') - strftime('%s', created_at)) / 3600 AS selisih_jam
       FROM invoice_log 
       WHERE user_id = ? AND akun = ? AND layanan = ? AND hari > 0
       ORDER BY id DESC LIMIT 1`,
      [userId, username, server.nama_server]
    );

    let refundAmount = 0;
    let isRefundable = false;

    if (lastOrder) {
      // Gunakan Math.floor atau parseInt supaya tidak ada koma/selisih perak
      refundAmount = Math.floor(Number(lastOrder.harga));
      
      // Aturan refund 24 jam
      if (lastOrder.selisih_jam < 24) {
        isRefundable = true;
      }
    }

    // 2. Eksekusi ke API VPS
    const endpoint = `/delete${type}`;
    let apiParams = { auth: server.auth };
    type === 'zivpn' ? apiParams.password = username : apiParams.user = username;

    const response = await axios.get(`http://${server.domain}:5888${endpoint}`, {
      params: apiParams,
      timeout: 30000
    });

    if (response.data && response.data.status === 'success') {
      
      // 3. Eksekusi Refund (Hanya jika sukses hapus di VPS)
      if (isRefundable && refundAmount > 0) {
        await dbRunAsync("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [refundAmount, userId]);
      }

      // 4. MATIKAN AKUN DI DB (Set hari ke 0)
      // Supaya invoice ini tidak bisa di-refund dua kali
      await dbRunAsync(
        "UPDATE invoice_log SET hari = 0 WHERE user_id = ? AND akun = ? AND layanan = ?",
        [userId, username, server.nama_server]
      );

      const userUpdated = await dbGetAsync("SELECT saldo FROM users WHERE user_id = ?", [userId]);

      // --- 🔥 NOTIF GRUP (GAYA EVENT ACHIEVED) ---
      if (vars.GROUP_ID) {
        const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || String(userId)));
        const userMention = mention;
        const timestamp = new Date().toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta',
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });

        const groupLogHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🗑️ ACCOUNT DELETED</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>🔖 <b>Protocol :</b> ${type.toUpperCase()}
👤 <b>Account  :</b> <code>${maskUsername(username)}</code>
🌐 <b>Server   :</b> ${server.nama_server}
🛡️ <b>Status   :</b> ${isRefundable ? 'REFUND PROCESSED' : 'NO REFUND'}
💰 <b>Refund   :</b> Rp ${refundAmount.toLocaleString('id-ID')}
💳 <b>Sisa Saldo :</b> Rp ${userUpdated.saldo.toLocaleString('id-ID')}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

        try {
          await ctx.telegram.sendMessage(vars.GROUP_ID, groupLogHtml, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error("❌ Gagal kirim notif grup: " + err.message);
        }
      }

      // --- NOTIFIKASI KE USER (PRIVATE) ---
      const msg = [
        `✅ <b>BERHASIL DIHAPUS</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `👤 <b>Username :</b> <code>${username}</code>`,
        `💰 <b>Refund   :</b> <code>Rp ${refundAmount.toLocaleString('id-ID')}</code>`,
        `💳 <b>Saldo Now :</b> <code>Rp ${userUpdated.saldo.toLocaleString('id-ID')}</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `<i>${isRefundable ? 'Dana otomatis masuk ke saldo.' : 'Dihapus tanpa refund (>24 jam).'}</i>`
      ].join('\n');

      await safeEdit(ctx, msg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'delete_confirm' }]] }
      });

    } else {
      ctx.reply(`❌ <b>Gagal Hapus:</b>\n${response.data.message || 'Akun tidak ditemukan'}`);
    }

  } catch (err) {
    logger.error('[DEL ERROR] ' + err.message);
    ctx.reply("❌ Terjadi kesalahan saat menghubungi server VPS.");
  }
});

bot.action('menu_event_reseller', async (ctx) => {
  const userId = ctx.from.id;
  // Ambil event yang is_active = 1
  const event = await dbGetAsync("SELECT * FROM reseller_events WHERE is_active = 1 LIMIT 1");
  
  if (!event) return ctx.reply("📭 Saat ini tidak ada event aktif.");

  // Cek apakah sudah lewat tanggal berakhir
  const today = new Date().toISOString().split('T')[0];
  const isExpired = today > event.end_date;

  const progress = await dbGetAsync(
    "SELECT current_sales, is_claimed FROM reseller_event_progress WHERE user_id = ? AND event_id = ?",
    [userId, event.id]
  ) || { current_sales: 0, is_claimed: 0 };

  let status = "";
  if (isExpired) {
    status = "❌ *Event telah berakhir*";
  } else {
    status = progress.current_sales >= event.target_penjualan ? "✅ *Target Tercapai!*" : "⏳ *Sedang Berjalan*";
  }
  
  const text = `🏆 *EVENT RESELLER: ${event.nama_event}*\n\n` +
               `🎯 Target: ${event.target_penjualan} Akun (Min. 15 Hari)\n` +
               `💰 Bonus: Rp ${event.bonus_saldo.toLocaleString()}\n` +
               `📊 Progres: *${progress.current_sales}* / ${event.target_penjualan}\n` +
               `📅 Berakhir: ${event.end_date}\n\n` +
               `Status: ${status}`;

  const buttons = [];
  // 🔥 TOMBOL KLAIM HANYA MUNCUL JIKA: Target tercapai + Belum klaim + BELUM EXPIRED
  if (progress.current_sales >= event.target_penjualan && !progress.is_claimed && !isExpired) {
    buttons.push([{ text: "Klaim Bonus Saldo", callback_data: `claim_event_${event.id}` }]);
  }
  buttons.push([{ text: "Kembali", callback_data: "menu_reseller" }]);

  await safeMenuSend(ctx, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^claim_event_(\d+)$/, async (ctx) => {
  const eventId = ctx.match[1];
  const userId = ctx.from.id;
  const today = new Date().toISOString().split('T')[0];

  const event = await dbGetAsync("SELECT * FROM reseller_events WHERE id = ?", [eventId]);
  
  if (today > event.end_date) {
    return ctx.answerCbQuery("⚠️ Maaf, event ini sudah berakhir.", { show_alert: true });
  }

  const progress = await dbGetAsync("SELECT * FROM reseller_event_progress WHERE user_id = ? AND event_id = ?", [userId, eventId]);

  if (!progress || progress.current_sales < event.target_penjualan) {
    return ctx.answerCbQuery("⚠️ Target kamu belum tercapai!", { show_alert: true });
  }

  if (progress.is_claimed) {
    return ctx.answerCbQuery("⚠️ Kamu sudah mengambil bonus ini.", { show_alert: true });
  }

  // --- EKSEKUSI ---
  await dbRunAsync("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [event.bonus_saldo, userId]);
  await dbRunAsync("UPDATE reseller_event_progress SET is_claimed = 1 WHERE user_id = ? AND event_id = ?", [userId, eventId]);

  // Pesan ke User (Private)
  await ctx.reply(`🎉 <b>KLAIM BERHASIL!</b>\n\nBonus saldo <b>Rp ${event.bonus_saldo.toLocaleString()}</b> telah ditambahkan ke akunmu.`, { parse_mode: 'HTML' });

  // --- 🔥 NOTIF GRUP (GAYA KONSISTEN) ---
  if (GROUP_ID) {
    const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || String(userId)));
    const userMention = mention;
    const timestamp = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const groupInvoiceHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🏆 EVENT ACHIEVED</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>🎯 <b>Event  :</b> ${escapeHtml(event.nama_event)}
📊 <b>Target :</b> ${event.target_penjualan} Akun
🎁 <b>Bonus  :</b> Rp ${event.bonus_saldo.toLocaleString()}
📌 <b>Role   :</b> RESELLER</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

    try {
      await bot.telegram.sendMessage(GROUP_ID, groupInvoiceHtml, {
        parse_mode: 'HTML'
      });
    } catch (err) {
      logger.error("❌ Gagal kirim notif event ke grup: " + err.message);
    }
  }
});

// --- STEP 1: PILIH AKUN ---
bot.action('renew_select', async (ctx) => {
  const userId = ctx.from.id;
  // Kita arahkan ke function khusus agar bisa dipanggil berulang saat klik Next/Prev
  return renderRenewPage(ctx, userId, 1); 
});
// HANDLER UNTUK NAVIGASI TOMBOL NEXT / PREV
bot.action(/^ren_page_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const page = parseInt(ctx.match[1]); // Mengambil angka halaman dari callback_data
  
  try {
    await ctx.answerCbQuery('Memuat halaman...').catch(() => {});
    // Panggil kembali fungsi render dengan halaman yang baru
    await renderRenewPage(ctx, userId, page);
  } catch (err) {
    logger.error('Error Navigasi: ' + (err.stack || err.message || err));
  }
});

// --- STEP 2: HANDLER KLIK USERNAME ---
bot.action(/^res_ren:(.+):(.+):(.+)$/, async (ctx) => {
  const type = ctx.match[1].toLowerCase();
  const username = ctx.match[2];
  const srvId = ctx.match[3];
  const chatId = ctx.chat.id;

  try {
    await ctx.answerCbQuery('🔍 Memvalidasi ke server...').catch(() => {});

    const server = await dbGetAsync("SELECT * FROM Server WHERE id = ?", [srvId]);
    const user = await dbGetAsync("SELECT saldo FROM users WHERE user_id = ?", [ctx.from.id]);

    if (!server) {
      return ctx.reply('❌ Server sudah tidak tersedia.');
    }

    // CEK LIVE KE SERVER
    try {
      const checkServer = await axios.get(`http://${server.domain}:5888/list`, {
        params: { type, auth: server.auth },
        timeout: 5000 
      });

      if (checkServer.data && checkServer.data.status === 'success') {
        const target = username.toLowerCase().trim();
        const isExist = checkServer.data.data.some(line => {
          const m = line.match(/User:\s*([^\s|]+)/i) || line.match(/^([^\s|]+)/);
          return m && m[1].toLowerCase().trim() === target;
        });

        if (!isExist) {
          return ctx.reply(`❌ Akun <code>${username}</code> sudah dihapus dari server.\nSilakan buat akun baru di menu CREATE.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '?? KEMBALI', callback_data: 'renew_select' }]] }
          });
        }
      }
    } catch (axiosErr) {
      return ctx.reply(`🔌 <b>Server Offline</b>\n\nServer <b>${server.nama_server}</b> tidak merespon. Coba beberapa saat lagi.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'renew_select' }]] }
      });
    }

    // SETUP STATE RENEW
    userState[chatId] = {
      action: 'renew',
      type,
      username,
      password: username,
      serverId: srvId,
      domain: server.domain,
      auth: server.auth,
      step: `exp_renew_${type}`
    };

    const msg = `
<b>🔄 KONFIRMASI RENEW</b>
━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Username :</b> <code>${username}</code>
📡 <b>Service  :</b> <code>${type.toUpperCase()}</code>
🚀 <b>Server   :</b> <code>${server.nama_server}</code>
💰 <b>Saldo    :</b> <code>Rp ${(user?.saldo || 0).toLocaleString('id-ID')}</code>
━━━━━━━━━━━━━━━━━━━━━━
⏳ <b>Masukkan jumlah hari perpanjang:</b>
    `.trim();

    await safeEdit(ctx, msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ BATALKAN', callback_data: 'renew_select' }]]
      }
    });

  } catch (err) {
    logger.error('res_ren error: ' + err.message);
  }
});

// Tombol Menu List Member
bot.action('reseller_list_akun', async (ctx) => {
  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery().catch(() => {});
    }

    const buttons = [
      [{ text: 'VMESS', callback_data: 'view_list:vmess' }, { text: 'VLESS', callback_data: 'view_list:vless' }],
      [{ text: 'TROJAN', callback_data: 'view_list:trojan' }, { text: 'SS', callback_data: 'view_list:shadowsocks' }],
      [{ text: 'SSH', callback_data: 'view_list:ssh' }, { text: 'ZIVPN', callback_data: 'view_list:zivpn' }],
      [{ text: 'KEMBALI', callback_data: 'menu_reseller' }]
    ];

    await safeMenuSend(ctx,
      '<b>👥 PANEL MONITORING MEMBER</b>\nPilih protokol untuk melihat daftar akun aktif di server:',
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
      }
    );
  } catch (e) {
    logger.warn('reseller_list_akun failed: ' + e.message);
  }
});
// Handler Eksekusi List
bot.action(/^view_list:(.+)$/, async (ctx) => {
  const type = ctx.match[1].toLowerCase();
  const userId = ctx.from.id;

  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery(`🔍 Mengecek akun ${type.toUpperCase()}...`).catch(() => {});
    }

    // 1️⃣ Ambil akun aktif milik reseller dari DB (expired sudah difilter)
    const myAccounts = await dbAllAsync(
      `SELECT akun, MAX(expired_at) AS exp_date, layanan
       FROM invoice_log
       WHERE user_id = ? AND LOWER(protocol) LIKE ?
       GROUP BY LOWER(akun)
       HAVING MAX(expired_at) >= date('now')`,
      [userId, `%${type}%`]
    );

    if (!myAccounts.length) {
      return safeMenuSend(ctx, `<b>📂 MY MEMBER: ${type.toUpperCase()}</b>\n\n<i>Tidak ada member aktif.</i>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'reseller_list_akun' }]] }
      });
    }

    // 2️⃣ Ambil data server aktif
    const servers = await dbAllAsync('SELECT * FROM Server');
    
    // 3️⃣ Fetch API Server secara paralel
    const serverResults = await Promise.allSettled(
      servers.map(srv =>
        axios.get(`http://${srv.domain}:5888/list`, {
          params: { type, auth: srv.auth },
          timeout: 5000
        }).then(res => ({ srvName: srv.nama_server, data: res.data.data }))
      )
    );

    // Satukan semua user yang "Live" di server ke dalam satu Array/Set
    const liveUsers = new Set();
    serverResults.forEach(res => {
      if (res.status === 'fulfilled' && Array.isArray(res.value.data)) {
        res.value.data.forEach(line => {
          const matchUser = line.match(/User:\s*([^\s|]+)/i) || line.match(/^([^\s|]+)/);
          if (matchUser) liveUsers.add(matchUser[1].toLowerCase().trim());
        });
      }
    });

    // 4️⃣ Bangun Output
    let output = `<b>📂 MONITORING MEMBER: ${type.toUpperCase()}</b>\n`;
    output += `👤 <b>Reseller:</b> ${ctx.from.first_name}\n`;
    output += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    myAccounts.forEach(info => {
      const username = info.akun.toLowerCase().trim();
      const isLive = liveUsers.has(username);

      // Format tanggal expired langsung dari kolom exp_date
      const expFmt = new Date(info.exp_date).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
      });

      // Semua akun di sini sudah aktif (expired sudah difilter di query)
      const statusIcon = isLive ? '🟢' : '🟡';
      const statusText = isLive ? 'AKTIF' : 'TIDAK TERDETEKSI';

      output += `${statusIcon} <code>${info.akun}</code>\n`;
      output += `   ├ Exp: <code>${expFmt}</code>\n`;
      output += `   └ Stat: <b>${statusText}</b>\n\n`;
    });

    output += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    output += `🟢 = Aktif & terdeteksi di server\n`;
    output += `🟡 = Belum exp tapi tidak terdeteksi di server`;

    await safeMenuSend(ctx, output, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'reseller_list_akun' }]] }
    });

  } catch (err) {
    logger.warn('view_list error: ' + err.message);
    ctx.reply('❌ Gagal memuat daftar member.').catch(() => {});
  }
});

bot.action('reseller_top_weekly', async (ctx) => {
  try {
    await ctx.answerCbQuery('Memuat peringkat...');

    const topRows = await dbAllAsync(`
      SELECT i.user_id, u.username,
             COUNT(i.id) AS total_akun,
             SUM(i.harga) AS total_omzet
      FROM invoice_log i
      JOIN users u ON i.user_id = u.user_id
      WHERE u.role = 'reseller'
        AND i.created_at >= datetime('now', '-7 days')
      GROUP BY i.user_id
      ORDER BY total_akun DESC
      LIMIT 5
    `);

    if (!topRows || topRows.length === 0) {
      return safeMenuSend(ctx, '<b>📭 BELUM ADA TRANSAKSI</b>\n\nSepertinya belum ada pergerakan reseller dalam 7 hari terakhir.', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]]
        }
      });
    }

    let message = '<b>🏆 TOP RESELLER MINGGU INI</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '<i>Periode: 7 Hari Terakhir</i>\n\n';

    topRows.forEach((row, i) => {
      const medals = ['🥇', '🥈', '🥉', '🎖️', '⭐'];
      const medal = medals[i] || '🔹';
      const name = row.username ? `@${escapeHTML(row.username)}` : `User_${row.user_id}`;

      // Menggunakan style <blockquote> seperti menu export data
      message += `${medal} <b>${name}</b>\n`;
      message += `<blockquote>🛒 Terjual : <b>${row.total_akun} Akun</b>\n`;
      message += `💵 Omzet   : <b>Rp ${(row.total_omzet || 0).toLocaleString('id-ID')}</b></blockquote>\n`;
    });

    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '🎯 <i>Terus tingkatkan penjualanmu!</i>';

    await safeMenuSend(ctx, message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ KEMBALI KE MENU', callback_data: 'menu_reseller' }]]
      }
    });

  } catch (err) {
    logger.error('❌ Error reseller_top_weekly:', err.message);
    await ctx.reply('<b>⚠️ Gagal mengambil data ranking.</b>', { parse_mode: 'HTML' });
  }
});
// 📤 Export Komisi
bot.action('reseller_export', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return renderResellerExport(ctx, 1);
});

bot.action(/^resexp_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  await ctx.answerCbQuery(`Halaman ${page}`).catch(() => {});
  return renderResellerExport(ctx, page);
});

async function renderResellerExport(ctx, page) {
  const userId = String(ctx.from.id);
  const limit = 5;
  const offset = (page - 1) * limit;

  try {
    const totalData = await dbGetAsync(
      "SELECT COUNT(*) as count FROM invoice_log WHERE user_id = ?",
      [userId]
    );

    if (!totalData || totalData.count === 0) {
      return safeMenuSend(ctx, '<b>📭 DATA KOSONG</b>\nKamu belum memiliki riwayat penjualan untuk diexport.', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]]
        }
      });
    }

    const totalPages = Math.ceil(totalData.count / limit);

    const rows = await dbAllAsync(`
      SELECT protocol, akun, hari, harga, created_at
      FROM invoice_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);

    const totalOmzetAll = await dbGetAsync(
      "SELECT SUM(harga) as total FROM invoice_log WHERE user_id = ?",
      [userId]
    );

    let message = '<b>📥 EXPORT RIWAYAT PENJUALAN</b>\n';
    message += `<i>Halaman ${page} dari ${totalPages}</i>\n`;
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += `📊 Total Transaksi : <b>${totalData.count} Akun</b>\n`;
    message += `💵 Total Omzet     : <b>Rp ${(totalOmzetAll?.total || 0).toLocaleString('id-ID')}</b>\n`;
    message += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

    rows.forEach((row, i) => {
      const num = offset + i + 1;
      const waktu = new Date(row.created_at).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });

      message += `${num}. <b>${row.protocol}</b> - <code>${escapeHTML(row.akun)}</code>\n`;
      message += `<blockquote>📅 ${row.hari} Hari | 💵 Rp ${(row.harga || 0).toLocaleString('id-ID')}\n`;
      message += `🕒 ${waktu}</blockquote>\n`;
    });

    // Tombol navigasi
    const buttons = [];
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ Prev', callback_data: `resexp_page_${page - 1}` });
    if (page < totalPages) navRow.push({ text: 'Next ➡️', callback_data: `resexp_page_${page + 1}` });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '⬅️ KEMBALI KE MENU', callback_data: 'menu_reseller' }]);

    await safeMenuSend(ctx, message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (err) {
    logger.error('❌ Error renderResellerExport:', err.message);
    ctx.reply('<b>⚠️ Gagal mengekspor data penjualan.</b>', { parse_mode: 'HTML' });
  }
}
bot.action(/reseller_top_all(?::(\d+))?/, async (ctx) => {
  try {
    const page = ctx.match[1] ? parseInt(ctx.match[1]) : 1;
    const limit = 5; // Menampilkan 5 reseller per halaman agar pas di layar
    const offset = (page - 1) * limit;

    await ctx.answerCbQuery(`Memuat Halaman ${page}...`);

    // 1. Hitung total reseller yang punya riwayat penjualan untuk menentukan jumlah halaman
    const totalRow = await dbGetAsync(`
      SELECT COUNT(DISTINCT i.user_id) AS total 
      FROM invoice_log i 
      INNER JOIN users u ON i.user_id = u.user_id 
      WHERE u.role = 'reseller'
    `);
    const totalResellers = totalRow?.total || 0;
    const totalPages = Math.ceil(totalResellers / limit);

    // 2. Ambil data dengan LIMIT dan OFFSET
    const rows = await dbAllAsync(`
      SELECT i.user_id, COUNT(i.id) AS total_akun,
             SUM(i.harga) AS total_omzet,
             u.username
      FROM invoice_log i
      INNER JOIN users u ON i.user_id = u.user_id
      WHERE u.role = 'reseller'
      GROUP BY i.user_id
      ORDER BY total_akun DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    if (!rows || rows.length === 0) {
      return safeMenuSend(ctx, '<b>📭 BELUM ADA DATA</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]] }
      });
    }

    let message = '<b>🏆 HALL OF FAME: TOP RESELLER</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += `<i>Peringkat Global - Halaman ${page} / ${totalPages}</i>\n\n`;

    rows.forEach((r, i) => {
      // Hitung posisi ranking (1, 2, 3...) berdasarkan page
      const rank = offset + i + 1;
      
      // Pilih emoji medal untuk 10 besar, sisanya pakai bullet
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const medal = rank <= 10 ? medals[rank - 1] : '🔹';
      
      const nama = r.username ? `@${escapeHTML(r.username)}` : `User_${r.user_id}`;

      message += `${medal} <b>${nama}</b>\n`;
      message += `<blockquote>🛒 Terjual : <b>${r.total_akun} Akun</b>\n`;
      message += `💵 Omzet   : <b>Rp ${(r.total_omzet || 0).toLocaleString('id-ID')}</b></blockquote>\n`;
    });

    // 3. Buat Navigasi Next & Prev
    const buttons = [];
    const navRow = [];

    if (page > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `reseller_top_all:${page - 1}` });
    }
    if (page < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `reseller_top_all:${page + 1}` });
    }

    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 KEMBALI KE MENU', callback_data: 'menu_reseller' }]);

    await safeMenuSend(ctx, message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (e) {
    logger.error('Error reseller_top_all pagination:', e.message);
    ctx.reply('❌ Gagal memuat Hall of Fame.').catch(() => {});
  }
});
bot.action(/reseller_riwayat(?::(\d+))?/, async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const page = ctx.match[1] ? parseInt(ctx.match[1]) : 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    await ctx.answerCbQuery(`Halaman ${page}`);

    const totalRow = await dbGetAsync(
      'SELECT COUNT(*) as count FROM invoice_log WHERE user_id = ?',
      [userId]
    );
    const totalData = totalRow?.count || 0;
    const totalPages = Math.ceil(totalData / limit);

    const rows = await dbAllAsync(`
      SELECT protocol, akun, hari, harga, created_at
      FROM invoice_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);

    if (!rows || rows.length === 0) {
      return safeMenuSend(ctx, '<b>📭 BELUM ADA RIWAYAT PENJUALAN</b>\n\nAnda belum melakukan transaksi penjualan.', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]]
        }
      });
    }

    let message = '<b>📊 RIWAYAT PENJUALAN TERAKHIR</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += `<i>Halaman ${page} / ${totalPages}</i>\n\n`;

    rows.forEach((row, i) => {
      const no = offset + i + 1;
      const tgl = new Date(row.created_at).toLocaleString('id-ID', {
        day: '2-digit', 
        month: 'short',
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: 'Asia/Jakarta'
      });

      // Menggunakan Gaya Blockquote agar konsisten
      message += `${no}. 🎫 <b>${row.protocol}</b> - <code>${escapeHTML(row.akun)}</code>\n`;
      message += `<blockquote>📅 Durasi : <b>${row.hari} Hari</b>\n`;
      message += `💰 Harga  : <b>Rp ${row.harga.toLocaleString('id-ID')}</b>\n`;
      message += `🕒 Waktu  : <i>${tgl} WIB</i></blockquote>\n`;
    });

    const navButtons = [];
    const navRow = [];

    if (page > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `reseller_riwayat:${page - 1}` });
    }
    if (page < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `reseller_riwayat:${page + 1}` });
    }

    const keyboard = {
      inline_keyboard: [
        ...(navRow.length ? [navRow] : []),
        [{ text: '⬅️ KEMBALI KE MENU', callback_data: 'menu_reseller' }]
      ]
    };

    await safeMenuSend(ctx, message, { 
      parse_mode: 'HTML', 
      reply_markup: keyboard 
    });

  } catch (err) {
    logger.error('Error reseller_riwayat UI consistent:', err.message);
    ctx.reply('❌ Gagal memuat riwayat penjualan.').catch(() => {});
  }
});
// ===================== ACTION: TRIAL AKUN =====================
bot.action('trial_ssh', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'ssh');
});


bot.action('trial_vmess', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'vmess');
});

bot.action('trial_vless', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'vless');
});

bot.action('trial_trojan', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'trojan');
});

bot.action('trial_shadowsocks', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'shadowsocks');
});

bot.action('trial_zivpn', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'zivpn');
});

// ——— OPTIONAL: helper kalau belum ada
const escapeHTML = (s = '') =>
  String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

bot.action(/^trial_server_zivpn_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;

  const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial ZIVPN berjalan, cek DM ya bro!');
  }


  try {
    // 1️⃣ CEK LIMIT TRIAL BERDASARKAN ROLE
    const check = await canTakeTrial(String(userId));
    const everTrial = await hasEverTrial(userId);
    const everTopup = await hasEverTopup(userId);

    if (check.role === 'user' && everTrial && !everTopup) {
      return bot.telegram.sendMessage(
        chatId,
        '🚫 *TRIAL SUDAH DIGUNAKAN*\n\n' +
        'Kamu sudah pernah mencoba trial sebelumnya.\n\n' +
        '💡 Untuk trial selanjutnya, silakan *topup saldo minimal Rp2.000*.\n' +
        'Setelah topup, trial akan terbuka kembali 🙏',
        { parse_mode: 'Markdown' }
      );
    }

    if (!check.allowed) {
      const roleName = check.role.toUpperCase();
      return bot.telegram.sendMessage(
        chatId,
        `❌ *JATAH TRIAL ${roleName} HABIS*\n\n` +
        `Maaf bro, untuk role *${roleName}* jatahnya adalah ${check.maxTrial}x setiap 3 hari.\n\n` +
        `📊 Pemakaian: \`${check.trialCount}/${check.maxTrial}\`\n` +
        `📅 Terakhir Klaim: \`${check.last || '-'}\`\n\n` +
        `_Jatah akan reset otomatis 1 hari setelah klaim terakhir._`,
        { parse_mode: 'Markdown' }
      );
    }

    // 2️⃣ AMBIL DATA SERVER & CEK KAPASITAS (FIX DISINI)
    const serverRow = await dbGetAsync(
      'SELECT nama_server, domain, auth, total_create_akun, batas_create_akun FROM Server WHERE id = ?', 
      [serverId]
    );
    
    if (!serverRow) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan.');

    // Logika cek apakah server sudah penuh
    if (serverRow.total_create_akun >= serverRow.batas_create_akun) {
      return bot.telegram.sendMessage(
        chatId, 
        `❌ *SERVER FULL*\n\n` +
        `Maaf bro, server *${serverRow.nama_server}* sudah mencapai batas maksimal pembuatan akun (\`${serverRow.total_create_akun}/${serverRow.batas_create_akun}\`).\n\n` +
        `💡 Silakan coba server yang lain.`,
        { parse_mode: 'Markdown' }
      );
    }

    const { nama_server: namaServer, domain, auth } = serverRow;

    // 3️⃣ PANGGIL API TRIAL ZIVPN
    const url = `http://${domain}:5888/trialzivpn?auth=${encodeURIComponent(auth)}`;
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 12000 });
    } catch (e) {
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial ZIVPN.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      return bot.telegram.sendMessage(chatId, `❌ Gagal: ${apiRes.data?.message || 'Unknown error'}`);
    }

    const d = apiRes.data.data;

    // 4️⃣ CLAIM ATOMIK
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      return bot.telegram.sendMessage(chatId, '⚠️ Gagal klaim! Jatah kamu sudah habis.');
    }

    // 5️⃣ SIMPAN LOG (trial tidak dihitung ke total_create_akun)
    await dbRunAsync('INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))', [userId, d.password, 'zivpn']);

    // 6️⃣ FORMAT PESAN USER (DM)
    const msg = `
🌟 *AKUN ZIVPN TRIAL* 🌟
📊 *Jatah ${check.role.toUpperCase()}:* \`${claim.trialKe}/${check.maxTrial}\`

🔹 *Informasi Akun*
┌───────────────────────────
│ 🔐 Password  : \`${d.password}\`
│ 🌐 Domain    : \`${domain}\`
│ 📍 IP Limit  : \`${d.ip_limit} IP\`
│ ⏳ Durasi    : \`${d.duration_minutes} Menit\`
│ 🕒 Expired   : \`${d.expired}\`
└───────────────────────────

✨ Selamat mencoba layanan ZIVPN Premium ✨
`.trim();

    await bot.telegram.sendMessage(chatId, msg, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true 
    });

    // 7️⃣ NOTIF KE GRUP
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
      const timestamp = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      
      const labelUser = (!everTrial && check.role === 'user')
        ? '🟢 NEW USER'
        : (check.role === 'user' ? '🟡 TRIAL USER' : '⭐ ' + check.role.toUpperCase());
    
      const userMention = mention;
      const notifHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🛄 TRIAL ACCOUNT - ZIVPN</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> UDP ZIVPN
• <b>Server   :</b> ${escapeHtml(namaServer)}
• <b>Expired  :</b> ${escapeHtml(d.expired)}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    logger.error('❌ Error trial ZIVPN: ' + (err.stack || err.message || err));
    await bot.telegram.sendMessage(chatId, '❌ Terjadi kesalahan sistem.');
  }
});

bot.action(/^trial_server_ssh_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  
  const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }


  try {
    // ---------- 1) CEK LIMIT TRIAL BERDASARKAN ROLE ----------
    const check = await canTakeTrial(String(userId));
    const everTrial = await hasEverTrial(userId);
    const everTopup = await hasEverTopup(userId);

    if (check.role === 'user' && everTrial && !everTopup) {
      return bot.telegram.sendMessage(
        chatId,
        '🚫 *TRIAL SUDAH DIGUNAKAN*\n\n' +
        'Kamu sudah pernah mencoba trial sebelumnya.\n\n' +
        '💡 Untuk trial selanjutnya, silakan *topup saldo minimal Rp2.000*.\n' +
        'Setelah topup, trial akan terbuka kembali 🙏',
        { parse_mode: 'Markdown' }
      );
    }

    if (!check.allowed) {
      const roleName = (check.role || 'USER').toUpperCase();
      return bot.telegram.sendMessage(
        chatId,
        `❌ *JATAH TRIAL ${roleName} HABIS*\n\n` +
        `Maaf bro, untuk role *${roleName}* jatahnya adalah ${check.maxTrial}x setiap 3 hari.\n\n` +
        `📊 Pemakaian: \`${check.trialCount}/${check.maxTrial}\`\n` +
        `📅 Terakhir Klaim: \`${check.last || '-'}\`\n\n` +
        `_Jatah akan reset otomatis 1 hari setelah klaim terakhir._`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER & CEK KAPASITAS (FIX DISINI) ----------
    const server = await dbGetAsync(
      'SELECT nama_server, domain, auth, total_create_akun, batas_create_akun FROM Server WHERE id = ?', 
      [serverId]
    );
    
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan.');

    // Validasi apakah server sudah penuh
    if (server.total_create_akun >= server.batas_create_akun) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ *SERVER FULL*\n\n` +
        `Maaf bro, server *${server.nama_server}* sudah mencapai batas maksimal pembuatan akun (\`${server.total_create_akun}/${server.batas_create_akun}\`).\n\n` +
        `💡 Silakan coba server yang lain.`,
        { parse_mode: 'Markdown' }
      );
    }

    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialssh?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let api;
    try {
      api = await axios.get(url, { timeout: 12000 });
    } catch (err) {
      logger.error('Error connecting to trial API: ' + (err?.message || err));
      return bot.telegram.sendMessage(chatId, '❌ Tidak bisa menghubungi API SSH.');
    }

    if (!api.data || api.data.status !== 'success') {
      return bot.telegram.sendMessage(chatId, '❌ Gagal membuat akun trial SSH.');
    }

    const d = api.data.data || api.data;
    const username = d.username || '-';
    const password = d.password || '-';
    const expired = d.expiration || d.exp || d.expired || '-';
    const ipLimit = d.ip_limit || d.iplimit || '-';
    const pubkey = d.public_key || d.pubkey || 'Not Available';
    const p = d.ports || {};
    const pick = (k, def) => (p && (p[k] || p[k.toLowerCase()])) || def;

    // ---------- 4) CLAIM ATOMIK (UPDATE HITUNGAN) ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (Limit tercapai).');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN (trial tidak dihitung ke total_create_akun) ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'ssh']
    );

    const msg = `
🌟 *AKUN SSH TRIAL* 🌟
📊 *Jatah ${check.role.toUpperCase()}:* \`${claim.trialKe}/${check.maxTrial}\`

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Password* : \`${password}\`
└─────────────────────
┌─────────────────────
│ *Domain* : \`${domain}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *OpenSSH* : \`${pick('openssh','22')}\`
│ *SSH WS* : \`${pick('ssh_ws','80')}\`
│ *SSH SSL WS*: \`${pick('ssh_ssl_ws','443')}\`
└─────────────────────
🔒 *PUBKEY*
\`\`\`
${pubkey}
\`\`\`
🔗 *Link dan Payload*
───────────────────────
WSS Payload:
\`\`\`
GET wss://BUG.COM/ HTTP/1.1
Host: ${domain}
Upgrade: websocket
\`\`\`

OpenVPN Link: [Download OVPN](https://${domain}:81/allovpn.zip)  
Save Account: [Klik Disini](https://${domain}:81/ssh-${username}.txt)

┌─────────────────────
│ *Expires:* \`${expired}\`
│ *IP Limit:* \`${ipLimit}\`
└─────────────────────

✨ Selamat menggunakan layanan kami! ✨`.trim();

    await bot.telegram.sendMessage(chatId, msg, { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true 
    });

    // ============================
    // 🔔 NOTIF GRUP
    // ============================
    if (GROUP_ID) {
      const timestamp = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      
      const labelUser = (!everTrial && check.role === 'user')
        ? '🟢 NEW USER'
        : (check.role === 'user' ? '🟡 TRIAL USER' : '⭐ ' + check.role.toUpperCase());

      const userMention = mention;
      const notifHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🛄 TRIAL ACCOUNT - SSH</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> SSH
• <b>Server   :</b> ${escapeHtml(server.nama_server)}
• <b>Durasi   :</b> 60 Menit
• <b>Expired  :</b> ${escapeHtml(expired)}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' }).catch(() => {});
    }

  } catch (err) {
    logger.error('Error in SSH handler: ' + (err.stack || err.message || err));
    await bot.telegram.sendMessage(chatId, '❌ Terjadi error saat proses trial SSH.');
  }
});

bot.action(/^trial_server_vmess_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;

  const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }


  try {
    // ---------- 1) CEK LIMIT TRIAL BERDASARKAN ROLE ----------
    const check = await canTakeTrial(String(userId));
    const everTrial = await hasEverTrial(userId);
    const everTopup = await hasEverTopup(userId);

    if (check.role === 'user' && everTrial && !everTopup) {
      return bot.telegram.sendMessage(
        chatId,
        '🚫 *TRIAL SUDAH DIGUNAKAN*\n\n' +
        'Kamu sudah pernah mencoba trial sebelumnya.\n\n' +
        '💡 Untuk trial selanjutnya, silakan *topup saldo minimal Rp2.000*.\n' +
        'Setelah topup, trial akan terbuka kembali 🙏',
        { parse_mode: 'Markdown' }
      );
    }

    if (!check.allowed) {
      const roleName = (check.role || 'USER').toUpperCase();
      return bot.telegram.sendMessage(
        chatId,
        `❌ *JATAH TRIAL ${roleName} HABIS*\n\n` +
        `Maaf bro, untuk role *${roleName}* jatahnya adalah ${check.maxTrial}x setiap 3 hari.\n\n` +
        `📊 Pemakaian: \`${check.trialCount}/${check.maxTrial}\`\n` +
        `📅 Terakhir Klaim: \`${check.last || '-'}\`\n\n` +
        `_Jatah akan reset otomatis 1 hari setelah klaim terakhir._`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER & CEK KAPASITAS (FIX DISINI) ----------
    const serverRow = await dbGetAsync(
      'SELECT nama_server, domain, auth, total_create_akun, batas_create_akun FROM Server WHERE id = ?',
      [serverId]
    );
    if (!serverRow) {
      return await bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');
    }

    // Cek apakah server sudah penuh
    if (serverRow.total_create_akun >= serverRow.batas_create_akun) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ *SERVER FULL*\n\n` +
        `Maaf bro, server *${serverRow.nama_server}* sudah mencapai batas maksimal pembuatan akun (\`${serverRow.total_create_akun}/${serverRow.batas_create_akun}\`).\n\n` +
        `💡 Silakan coba server yang lain.`,
        { parse_mode: 'Markdown' }
      );
    }

    const { nama_server: namaServer, domain, auth } = serverRow;
    const url = `http://${domain}:5888/trialvmess?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 12000 });
    } catch (e) {
      logger.error('Error call trialvmess API: ' + (e?.message || e));
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial VMESS.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial VMESS.\n\nDetail: ${msgErr}`);
    }

    const d = apiRes.data.data || apiRes.data;
    const username   = d.username || '-';
    const uuid       = d.uuid || '-';
    const domainOut  = d.domain || domain || '-';
    const ns_domain  = d.ns_domain || d.ns || '-';
    const city       = d.city || '-';
    const public_key = d.public_key || d.pubkey || 'Public key not available';
    const expiration = d.expiration || d.exp || d.expired || '-';
    const quota      = d.quota || d.quota_gb || '0 GB';
    const ip_limit   = d.ip_limit || d.iplimit || '0';

    const vmess_tls_link    = d.link_tls  || d.vmess_tls_link  || '-';
    const vmess_nontls_link = d.link_ntls || d.vmess_nontls_link || '-';
    const vmess_grpc_link   = d.link_grpc || d.vmess_grpc_link   || '-';

    // ---------- 4) CLAIM ATOMIK (DENGAN UPDATE HITUNGAN) ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (Limit tercapai atau sedang diproses).');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN (trial tidak dihitung ke total_create_akun) ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'vmess']
    );

    const msg = `
🌟 *AKUN VMESS TRIAL* 🌟
📊 *Jatah ${check.role.toUpperCase()}:* \`${claim.trialKe}/${check.maxTrial}\`

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Domain* : \`${domainOut}\`
│ *UUID* : \`${uuid}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Network* : \`Websocket (WS)\`
│ *Path* : \`/vmess\`
│ *Path GRPC*: \`vmess-grpc\`
└─────────────────────

🔐 *URL VMESS TLS*
\`\`\`
${vmess_tls_link}
\`\`\`

🔓 *URL VMESS HTTP*
\`\`\`
${vmess_nontls_link}
\`\`\`

🔒 *URL VMESS GRPC*
\`\`\`
${vmess_grpc_link}
\`\`\`

🔑 *PUBKEY*
\`\`\`
${public_key}
\`\`\`

┌─────────────────────
│ *Expired:* \`${expiration}\`
│ *Quota:* \`${quota === '0 GB' ? 'Unlimited' : quota}\`
│ *IP Limit:* \`${ip_limit === '0' ? 'Unlimited' : ip_limit + ' IP'}\`
└─────────────────────

✨ Selamat menggunakan layanan kami! ✨
`.trim();

    await bot.telegram.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    // ==== NOTIF GRUP ====
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
      const timestamp = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const labelUser = (!everTrial && check.role === 'user')
        ? '🟢 NEW USER'
        : (check.role === 'user' ? '🟡 TRIAL USER' : '⭐ ' + check.role.toUpperCase());

      const userMention = mention;
      const notifHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🛄 TRIAL ACCOUNT - VMESS</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> VMESS
• <b>Server   :</b> ${escapeHtml(namaServer)}
• <b>Expired  :</b> ${escapeHtml(expiration)}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    logger.error('❌ Error trial VMESS: ' + (err.stack || err.message || err));
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial VMESS.');
  }
});

bot.action(/^trial_server_vless_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  
  const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }


  try {
    // ---------- 1) CEK LIMIT TRIAL BERDASARKAN ROLE ----------
    const check = await canTakeTrial(String(userId));
    const everTrial = await hasEverTrial(userId);
    const everTopup = await hasEverTopup(userId);

    if (check.role === 'user' && everTrial && !everTopup) {
      return bot.telegram.sendMessage(
        chatId,
        '🚫 *TRIAL SUDAH DIGUNAKAN*\n\n' +
        'Kamu sudah pernah mencoba trial sebelumnya.\n\n' +
        '💡 Untuk trial selanjutnya, silakan *topup saldo minimal Rp2.000*.\n' +
        'Setelah topup, trial akan terbuka kembali 🙏',
        { parse_mode: 'Markdown' }
      );
    }

    if (!check.allowed) {
      const roleName = check.role.toUpperCase();
      return bot.telegram.sendMessage(
        chatId,
        `❌ *JATAH TRIAL ${roleName} HABIS*\n\n` +
        `Maaf bro, untuk role *${roleName}* jatahnya adalah ${check.maxTrial}x setiap 3 hari.\n\n` +
        `📊 Pemakaian: \`${check.trialCount}/${check.maxTrial}\`\n` +
        `📅 Terakhir Klaim: \`${check.last || '-'}\`\n\n` +
        `_Jatah akan reset otomatis 1 hari setelah klaim terakhir._`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER & CEK KAPASITAS (FIX DISINI) ----------
    const server = await dbGetAsync(
      'SELECT nama_server, domain, auth, total_create_akun, batas_create_akun FROM Server WHERE id = ?', 
      [serverId]
    );
    
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');

    // Validasi kapasitas server
    if (server.total_create_akun >= server.batas_create_akun) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ *SERVER FULL*\n\n` +
        `Maaf bro, server *${server.nama_server}* sudah mencapai batas maksimal pembuatan akun (\`${server.total_create_akun}/${server.batas_create_akun}\`).\n\n` +
        `💡 Silakan coba server yang lain.`,
        { parse_mode: 'Markdown' }
      );
    }

    const namaServer = server.nama_server;
    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialvless?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 15000 });
    } catch (e) {
      logger.error('❌ Gagal call API trialvless: ' + (e?.message || e));
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial VLESS.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial VLESS.\n\nDetail: ${msgErr}`);
    }

    const d = apiRes.data.data || apiRes.data;
    const username   = d.username || '-';
    const uuid       = d.uuid || d.password || '-';
    const domainOut  = d.domain || domain || '-';
    const pubkey     = d.public_key || d.pubkey || 'N/A';
    const expired    = d.expired || d.expiration || d.exp || 'N/A';
    const quota      = d.quota || d.quota_gb || '0 GB';
    const ip_limit   = d.ip_limit || d.iplimit || '0';
    const tls_link   = d.vless_tls_link || d.link_tls || '-';
    const ntls_link  = d.vless_nontls_link || d.link_ntls || '-';
    const grpc_link  = d.vless_grpc_link || d.link_grpc || '-';

    // ---------- 4) CLAIM ATOMIK (DENGAN UPDATE HITUNGAN) ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (Limit tercapai).');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN (trial tidak dihitung ke total_create_akun) ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'vless']
    );

    const replyText = `
🌟 *AKUN VLESS TRIAL* 🌟
📊 *Jatah ${check.role.toUpperCase()}:* \`${claim.trialKe}/${check.maxTrial}\`

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Domain* : \`${domainOut}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Security* : \`Auto\`
│ *Network* : \`Websocket (WS)\`
│ *Path* : \`/vless\`
│ *Path GRPC*: \`vless-grpc\`
└─────────────────────
🔐 *URL VLESS TLS*
\`\`\`
${tls_link}
\`\`\`
🔓 *URL VLESS HTTP*
\`\`\`
${ntls_link}
\`\`\`
🔒 *URL VLESS GRPC*
\`\`\`
${grpc_link}
\`\`\`
🔒 *UUID & PUBKEY*
\`\`\`
${uuid}
\`\`\`
\`\`\`
${pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${expired}\`
│ Quota: \`${quota === '0 GB' ? 'Unlimited' : quota}\`
│ IP Limit: \`${ip_limit === '0' ? 'Unlimited' : ip_limit + ' IP'}\`
└─────────────────────

✨ Selamat menggunakan layanan kami! ✨`.trim();

    await bot.telegram.sendMessage(chatId, replyText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    // ====== NOTIF KE GROUP ======
    if (GROUP_ID) {
      const timestamp = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const labelUser = (!everTrial && check.role === 'user')
        ? '🟢 NEW USER'
        : (check.role === 'user' ? '🟡 TRIAL USER' : '⭐ ' + check.role.toUpperCase());

      const userMention = mention;
      const notifHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🛄 TRIAL ACCOUNT - VLESS</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> VLESS
• <b>Server   :</b> ${escapeHtml(namaServer)}
• <b>Expired  :</b> ${escapeHtml(expired)}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    logger.error('❌ Gagal proses trial VLESS: ' + (err.stack || err.message || err));
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial VLESS.');
  }
});

bot.action(/^trial_server_trojan_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  
  const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }


  try {
    // ---------- 1) CEK LIMIT TRIAL BERDASARKAN ROLE ----------
    const check = await canTakeTrial(String(userId));
    const everTrial = await hasEverTrial(userId);
    const everTopup = await hasEverTopup(userId);

    if (check.role === 'user' && everTrial && !everTopup) {
      return bot.telegram.sendMessage(
        chatId,
        '🚫 *TRIAL SUDAH DIGUNAKAN*\n\n' +
        'Kamu sudah pernah mencoba trial sebelumnya.\n\n' +
        '💡 Untuk trial selanjutnya, silakan *topup saldo minimal Rp2.000*.\n' +
        'Setelah topup, trial akan terbuka kembali 🙏',
        { parse_mode: 'Markdown' }
      );
    }    
    if (!check.allowed) {
      const roleName = check.role.toUpperCase();
      return bot.telegram.sendMessage(
        chatId,
        `❌ *JATAH TRIAL ${roleName} HABIS*\n\n` +
        `Maaf bro, untuk role *${roleName}* jatahnya adalah ${check.maxTrial}x setiap 3 hari.\n\n` +
        `📊 Pemakaian: \`${check.trialCount}/${check.maxTrial}\`\n` +
        `📅 Terakhir Klaim: \`${check.last || '-'}\`\n\n` +
        `_Jatah akan reset otomatis 1 hari setelah klaim terakhir._`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER & CEK KAPASITAS (FIX DISINI) ----------
    const server = await dbGetAsync(
      'SELECT nama_server, domain, auth, total_create_akun, batas_create_akun FROM Server WHERE id = ?', 
      [serverId]
    );
    
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');

    // Cek apakah server sudah penuh
    if (server.total_create_akun >= server.batas_create_akun) {
      return bot.telegram.sendMessage(
        chatId, 
        `❌ *SERVER FULL*\n\n` +
        `Maaf bro, server *${server.nama_server}* sudah mencapai batas maksimal pembuatan akun (\`${server.total_create_akun}/${server.batas_create_akun}\`).\n\n` +
        `💡 Silakan coba server yang lain.`,
        { parse_mode: 'Markdown' }
      );
    }

    const namaServer = server.nama_server;
    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialtrojan?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 15000 });
    } catch (e) {
      logger.error('❌ Gagal call API trialtrojan: ' + (e?.message || e));
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial TROJAN.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial TROJAN.\n\nDetail: ${msgErr}`);
    }

    const d = apiRes.data.data || apiRes.data;
    const username       = d.username || '-';
    const domainOut      = d.domain || domain || '-';
    const trojan_tls_link  = d.trojan_tls_link || d.trojan_tls || d.link_tls || '-';
    const trojan_grpc_link = d.trojan_grpc_link || d.trojan_grpc || d.link_grpc || '-';
    const pubkey         = d.pubkey || d.public_key || d.publicKey || 'Not Available';
    const uuid_or_pass   = d.uuid || d.password || '-';
    const expired        = d.expired || d.expiration || d.exp || 'N/A';
    const quota          = d.quota || d.quota_gb || '0 GB';
    const ip_limit       = (typeof d.ip_limit !== 'undefined') ? String(d.ip_limit) : (d.iplimit || '0');

    // ---------- 4) CLAIM ATOMIK (DENGAN UPDATE HITUNGAN) ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (Limit tercapai).');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN (trial tidak dihitung ke total_create_akun) ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'trojan']
    );

    const msg = `
🌟 *AKUN TROJAN TRIAL* 🌟
📊 *Jatah ${check.role.toUpperCase()}:* \`${claim.trialKe}/${check.maxTrial}\`

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Domain* : \`${domainOut}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Network* : \`Websocket (WS)\`
│ *Path* : \`/trojan-ws\`
│ *Path GRPC*: \`trojan-grpc\`
└─────────────────────
🔐 *URL TROJAN TLS*
\`\`\`
${trojan_tls_link}
\`\`\`
🔒 *URL TROJAN GRPC*
\`\`\`
${trojan_grpc_link}
\`\`\`
🔒 *PUBKEY*
\`\`\`
${pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${expired}\`
│ Quota: \`${quota === '0 GB' ? 'Unlimited' : quota}\`
│ IP Limit: \`${ip_limit === '0' ? 'Unlimited' : ip_limit + ' IP'}\`
└─────────────────────
🔐 *Password/UUID*
\`\`\`
${uuid_or_pass}
\`\`\`

✨ Selamat menggunakan layanan kami! ✨`.trim();

    await bot.telegram.sendMessage(chatId, msg, { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true 
    });

    // ====== NOTIF GROUP ======
    if (GROUP_ID) {
      const timestamp = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const labelUser = (!everTrial && check.role === 'user')
        ? '🟢 NEW USER'
        : (check.role === 'user' ? '🟡 TRIAL USER' : '⭐ ' + check.role.toUpperCase());

      const userMention = mention;
      const notifHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🛄 TRIAL ACCOUNT - TROJAN</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> TROJAN
• <b>Server   :</b> ${escapeHtml(namaServer)}
• <b>Expired  :</b> ${escapeHtml(expired)}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    logger.error('❌ Gagal proses trial TROJAN: ' + (err.stack || err.message || err));
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial TROJAN.');
  }
});

// === TRIAL SHADOWSOCKS — mirror createshadowsocks (kotak + codeblock) + notif tetap ===
bot.action(/^trial_server_shadowsocks_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  const mention = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  try {
    // ---------- 1) CEK LIMIT TRIAL ----------
    const check = await canTakeTrial(String(userId));
    if (!check.allowed) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ Kamu sudah memakai jatah trial.\n\n` +
        `📅 Terakhir: ${check.last || '-'}\n` +
        `🔢 Dipakai: ${check.trialCount}/${check.maxTrial}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER ----------
    const server = await dbGetAsync('SELECT nama_server, domain, auth FROM Server WHERE id = ?', [serverId]);
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');

    const namaServer = server.nama_server;
    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialshadowsocks?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 15000 });
    } catch (e) {
      logger.error('❌ Gagal call API trialshadowsocks: ' + (e?.message || e));
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial SHADOWSOCKS di server. Coba lagi nanti.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial SHADOWSOCKS.\n\nDetail: ${msgErr}`);
    }

    // mapping response
    const d = apiRes.data.data || apiRes.data;
    const username   = d.username || '-';
    const password   = d.password || d.uuid || '-';
    const method     = d.method || '-';
    const ns_domain  = d.ns_domain || '-';
    const city       = d.city || '-';
    const public_key = d.public_key || d.pubkey || 'Not Available';
    const expiration = d.expiration || d.exp || '-';
    const link_ws    = d.ss_link_ws || d.link_ws || 'N/A';
    const link_grpc  = d.ss_link_grpc || d.link_grpc || 'N/A';

    // ---------- 4) CLAIM ATOMIK ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      logger.warn(`Claim trial Shadowsocks failed due to limit/race for user ${userId}`);
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (limit atau race). Coba lagi nanti.');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'shadowsocks']
    );

    const trialKe = claim.trialKe;
    const roleLabel = check.role === 'admin' ? 'Admin' : check.role === 'reseller' ? 'Reseller' : 'User';

    const msg = `
🌟 *AKUN SHADOWSOCKS TRIAL* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Password* : \`${password}\`
│ *Method*   : \`${method}\`
│ *Domain*   : \`${domain}\`
│ *Kota*     : \`${city}\`
│ *NS*       : \`${ns_domain}\`
└─────────────────────

🔒 *PUBKEY*
\`\`\`
${public_key}
\`\`\`

🔌 *URL SHADOWSOCKS TLS (WS)*
\`\`\`
${link_ws}
\`\`\`

🔌 *URL SHADOWSOCKS GRPC*
\`\`\`
${link_grpc}
\`\`\`

┌─────────────────────
│ Expiry: \`${expiration}\`
│ Limit IP: \`Unlimited\`
└─────────────────────
Save Account Link: [Download](https://${domain}:81/shadowsocks-${username}.txt)

✨ Selamat menggunakan layanan kami! ✨
    `.trim();

    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    // ====== NOTIF GROUP ======
    if (GROUP_ID) {
      const notifHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>🛄 TRIAL ACCOUNT - SHADOWSOCKS</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> SHADOWSOCKS
• <b>Server   :</b> ${namaServer}
• <b>Durasi   :</b> 60 Menit</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${mention}
🆔 <b>ID    :</b> <code>${maskUserId(ctx.from.id)}</code>
🕒 <b>Waktu :</b> <code>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB</code>`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {
        logger.warn('Gagal kirim notif SHADOWSOCKS: ' + (e && e.message));
      }
    }

  } catch (err) {
    logger.error('❌ Gagal proses trial SHADOWSOCKS: ' + (err.stack || err.message || err));
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial SHADOWSOCKS.');
  }
});


bot.action('send_main_menu', async (ctx) => {
  await sendMainMenu(ctx);
});

bot.action(/^service_(create|renew|trial)$/, async (ctx) => {
  const action = ctx.match[1];
  await handleServiceAction(ctx, action);
});

// ===================== ACTION: CREATE / RENEW =====================
bot.action('create_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vmess');
});

bot.action('create_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vless');
});

bot.action('create_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'trojan');
});

bot.action('create_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'shadowsocks');
});

bot.action('create_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'ssh');
});

bot.action('renew_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vmess');
});

bot.action('renew_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vless');
});

bot.action('renew_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'trojan');
});

bot.action('renew_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'shadowsocks');
});

bot.action('renew_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'ssh');
});


bot.action(/navigate_(\w+)_(\w+)_(\d+)/, async (ctx) => {
  const [, action, type, page] = ctx.match;
  await startSelectServer(ctx, action, type, parseInt(page, 10));
});
bot.action(/(create|renew)_username_(vmess|vless|trojan|shadowsocks|ssh)_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const serverId = ctx.match[3];
  userState[ctx.chat.id] = { step: `username_${action}_${type}`, serverId, type, action };

  db.get('SELECT batas_create_akun, total_create_akun FROM Server WHERE id = ?', [serverId], async (err, server) => {
    if (err) {
      logger.error('⚠️ Error fetching server details:', err.message);
      return ctx.reply('❌ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
    }

    if (!server) {
      return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const batasCreateAkun = server.batas_create_akun;
    const totalCreateAkun = server.total_create_akun;

    if (totalCreateAkun >= batasCreateAkun) {
      return ctx.reply('❌ *Server penuh. Tidak dapat membuat akun baru di server ini.*', { parse_mode: 'Markdown' });
    }

    await ctx.reply('👤 *Masukkan username:*', { parse_mode: 'Markdown' });
  });
});
// =====================================
// BROADCAST MULTIMEDIA HANDLER
// =====================================
bot.on(['sticker', 'photo', 'video', 'animation', 'document'], async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;
  const state = userState[chatId];

  if (!state || state.step !== 'await_broadcast_message') {
    return;
  }

  if (!adminIds.includes(userId)) {
    return ctx.reply('❌ Kamu tidak punya izin untuk broadcast.');
  }

  // 🧠 simpan info media
  state.messageId = ctx.message.message_id;
  state.chatId = chatId;
  state.mediaType = ctx.message.sticker ? 'sticker' 
    : ctx.message.photo ? 'photo'
    : ctx.message.video ? 'video'
    : ctx.message.animation ? 'animation'
    : 'document';

  if (ctx.message.caption) {
    state.caption = ctx.message.caption;
  }

  return ctx.reply(
    `📣 *Media ${state.mediaType.toUpperCase()} siap dikirim!*\n\n` +
    `Konfirmasi broadcast ke semua user?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ya, Kirim Sekarang', callback_data: 'broadcast_media_confirm' }
          ],
          [
            { text: '❌ Batalkan', callback_data: 'cancel_broadcast' }
          ]
        ]
      },
      parse_mode: 'Markdown'
    }
  );
});

bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;
  const text = ctx.message?.text?.trim() ?? '';

  const stateUser = userState[chatId];


  try {

    // =================================================================
    // LOGIC: FITUR LAINNYA — gunakan userState
    // =================================================================
    if (!stateUser || typeof stateUser !== 'object') {
      return next();
    }

    const state = stateUser;

    // ─────────────────────────────────────────
    // SETUP EVENT BARU
    // ─────────────────────────────────────────
    if (state.step === 'await_event_name') {
      state.nama = text;
      state.step = 'await_event_target';
      return ctx.reply('🎯 *Masukkan Target Penjualan (Angka):*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'await_event_target') {
      state.target = parseInt(text, 10);
      state.step   = 'await_event_bonus';
      return ctx.reply('💰 *Masukkan Bonus Saldo (Angka):*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'await_event_bonus') {
      state.bonus = parseInt(text, 10);
      state.step  = 'await_event_date';
      return ctx.reply('📅 *Masukkan Tanggal Berakhir (YYYY-MM-DD):*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'await_event_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
        return ctx.reply('❌ Format salah! Gunakan YYYY-MM-DD');

      const startDate = new Date().toISOString().split('T')[0];
      await dbRunAsync('UPDATE reseller_events SET is_active = 0');
      await dbRunAsync(
        `INSERT INTO reseller_events
           (nama_event, target_penjualan, bonus_saldo, start_date, end_date, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [state.nama, state.target, state.bonus, startDate, text]
      );
      delete userState[chatId];
      return ctx.reply('✅ *Event Berhasil Diaktifkan!*', { parse_mode: 'Markdown' });
    }

    // ─────────────────────────────────────────
    // ZIVPN: INPUT USERNAME/PASSWORD (CREATE)
    // ─────────────────────────────────────────
    if (state.type === 'zivpn' && state.step === 'username_create_zivpn') {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text))
        return ctx.reply('❌ *Password ZIVPN harus huruf & angka (3–20 karakter)*', { parse_mode: 'Markdown' });

      state.username = text;
      state.password = text;
      state.step     = 'exp_create_zivpn';
      return ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }

    // ─────────────────────────────────────────
    // ZIVPN: INPUT PASSWORD (RENEW)
    // ─────────────────────────────────────────
    if (state.type === 'zivpn' && state.action === 'renew' && state.step === 'username_renew_zivpn') {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text))
        return ctx.reply('❌ *Password ZIVPN harus huruf & angka (3–20 karakter)*', { parse_mode: 'Markdown' });

      state.username = text;
      state.password = text;
      state.step     = 'exp_renew_zivpn';
      return ctx.reply('⏳ *Masukkan tambahan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }

    // ─────────────────────────────────────────
    // USERNAME GENERIC (NON-ZIVPN)
    // ─────────────────────────────────────────
    if (
      typeof state.step === 'string' &&
      state.step.startsWith('username_') &&
      state.type !== 'zivpn'
    ) {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text))
        return ctx.reply('❌ *Username tidak valid.*', { parse_mode: 'Markdown' });

      state.username = text;

      if (state.action === 'create' && state.type === 'ssh') {
        state.step = `password_${state.action}_${state.type}`;
        return ctx.reply('🔑 *Masukkan password:*', { parse_mode: 'Markdown' });
      }

      state.step = `exp_${state.action}_${state.type}`;
      return ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }

    // ─────────────────────────────────────────
    // PASSWORD SSH
    // ─────────────────────────────────────────
    if (typeof state.step === 'string' && state.step.startsWith('password_')) {
      if (!/^[a-zA-Z0-9]{6,}$/.test(text))
        return ctx.reply('❌ *Password minimal 6 karakter & tanpa simbol.*', { parse_mode: 'Markdown' });

      state.password = text;
      state.step     = `exp_${state.action}_${state.type}`;
      return ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }

    // ─────────────────────────────────────────
    // EXPIRED DAYS (SEMUA SERVICE)
    // ─────────────────────────────────────────
    if (typeof state.step === 'string' && state.step.startsWith('exp_')) {
      const days = parseInt(text, 10);
      if (isNaN(days) || days <= 0 || days > 365)
        return ctx.reply('❌ *Masa aktif tidak valid (1-365 hari).*', { parse_mode: 'Markdown' });

      state.exp = days;

      const { username, password, serverId, type, action } = state;

      const server = await dbGetAsync(
        'SELECT nama_server, domain, quota, iplimit, harga FROM Server WHERE id = ?',
        [serverId]
      );
      if (!server)
        return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });

      let user = await dbGetAsync(
        'SELECT saldo, role FROM users WHERE user_id = ?',
        [userId]
      );
      if (!user) {
        await dbRunAsync(
          `INSERT INTO users (user_id, username, saldo, role)
           VALUES (?, ?, 0, 'user')`,
          [userId, ctx.from.username || ctx.from.first_name || '']
        );
        user = { saldo: 0, role: 'user' };
      }

      if (action === 'create') {
        const existed = await dbGetAsync(
          'SELECT 1 AS ada FROM akun_aktif WHERE username = ? AND jenis = ?',
          [username, type]
        );
        if (existed)
          return ctx.reply(
            '❌ *Username sudah dipakai. Silakan gunakan username lain.*',
            { parse_mode: 'Markdown' }
          );
      }

      if (action === 'renew') {
        const row = await dbGetAsync(
          'SELECT * FROM akun_aktif WHERE username = ? AND jenis = ?',
          [username, type]
        );
        if (!row)
          return ctx.reply('❌ *Akun tidak ditemukan atau tidak aktif.*', { parse_mode: 'Markdown' });
      }

      // Reseller dapat flat diskon 30%
      const diskon     = user.role === 'reseller' ? 0.3 : 0;
      const totalHarga = Math.floor(Number(server.harga) * Number(days) * (1 - diskon));

      if (user.saldo < totalHarga)
        return ctx.reply('❌ *Saldo tidak mencukupi.*', { parse_mode: 'Markdown' });

      await dbRunAsync(
        'UPDATE users SET saldo = saldo - ? WHERE user_id = ?',
        [totalHarga, userId]
      );

      const handlerMap = {
        create: {
          vmess:       () => createvmess(username, days, server.quota * days, server.iplimit, serverId),
          vless:       () => createvless(username, days, server.quota * days, server.iplimit, serverId),
          trojan:      () => createtrojan(username, days, server.quota * days, server.iplimit, serverId),
          shadowsocks: () => createshadowsocks(username, days, server.quota * days, server.iplimit, serverId),
          ssh:         () => createssh(username, password, days, server.iplimit, serverId),
          zivpn:       () => createzivpn(password, days, server.iplimit, serverId),
        },
        renew: {
          vmess:       () => renewvmess(username, days, server.quota * days, server.iplimit, serverId),
          vless:       () => renewvless(username, days, server.quota * days, server.iplimit, serverId),
          trojan:      () => renewtrojan(username, days, server.quota * days, server.iplimit, serverId),
          shadowsocks: () => renewshadowsocks(username, days, server.quota * days, server.iplimit, serverId),
          ssh:         () => renewssh(username, days, server.iplimit, serverId),
          zivpn:       () => renewzivpn(password, days, server.iplimit, serverId),
        },
      };

      const handler = handlerMap[action]?.[type];
      if (!handler) {
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [totalHarga, userId]);
        return ctx.reply('❌ *Tipe layanan tidak dikenali.*', { parse_mode: 'Markdown' });
      }

      let result;
      try {
        result = await handler();
      } catch (e) {
        logger.error('❌ Error pada handler create/renew:', e?.stack ?? String(e));
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [totalHarga, userId]);
        return ctx.reply(
          '❌ *Terjadi kesalahan saat membuat akun. Saldo kamu sudah dikembalikan.*',
          { parse_mode: 'Markdown' }
        );
      }

      if (!result || result.status === 'error') {
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [totalHarga, userId]);
        return ctx.reply(
          result?.message || '❌ Terjadi kesalahan sistem.',
          { parse_mode: 'Markdown' }
        );
      }

      if (action === 'create') {
        await dbRunAsync(
          'UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?',
          [serverId]
        );
        await dbRunAsync(
          'INSERT OR REPLACE INTO akun_aktif (username, jenis) VALUES (?, ?)',
          [username, type]
        );
      }

      const teksConfigLengkap = result.message;

      await dbRunAsync(
        `INSERT INTO invoice_log
           (user_id, username, layanan, akun, hari, harga, komisi, protocol, config_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          userId,
          ctx.from.username || ctx.from.first_name,
          server.nama_server,
          username,
          days,
          totalHarga,
          0, // komisi selalu 0, tidak ada lagi sistem komisi
          type.toUpperCase(),
          teksConfigLengkap,
        ]
      );

      // Notif ke group
      const mention     = escapeHtml(maskUsername(ctx.from.username || ctx.from.first_name || 'User'));
      const userMention = mention;
      const headerText  = action === 'renew' ? '🔄 ACCOUNT RENEWED' : '✅ ACCOUNT CREATED';
      const timestamp   = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      const invoiceHtml = `
━━━━━━━━━━━━━━━━━━━━━
<b>${headerText}</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Protocol :</b> ${toTitleCase(type)}
• <b>Username :</b> <code>${escapeHtml(maskUsername(username))}</code>
• <b>Server   :</b> ${escapeHtml(server.nama_server || server.domain || 'Unknown')}
• <b>IP Limit :</b> ${server.iplimit || '-'} IP
• <b>Durasi   :</b> ${days} Hari</blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User  :</b> ${userMention}
🆔 <b>ID    :</b> <code>${maskUserId(userId)}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();

      if (GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, invoiceHtml, { parse_mode: 'HTML' }).catch(() => {});
      }

      await ctx.reply(result.message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      delete userState[chatId];
      return;
    }

    // ─────────────────────────────────────────
    // PPOB: INPUT NOMOR TUJUAN
    // ─────────────────────────────────────────
      if (state.step === 'ppob_input_target') {      
      const target = text.replace(/[^0-9]/g, ''); 

      const { sku, price, productName } = state;
      const refId  = 'TRX' + Date.now();

      delete userState[chatId];

      await dbRunAsync('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [price, userId]);

      const sign = generateDigiSig(refId);
      const res  = await fetchDigiflazz('/transaction', {
        buyer_sku_code: sku,
        customer_no:   target,
        ref_id:        refId,
        sign,
      });

      const d      = res?.data;
      const rc     = d?.rc;
      const status = d?.status?.toLowerCase() ?? '';

      if (res && d && (rc === '00' || rc === '03' || status === 'pending' || status === 'sukses' || status === 'success')) {
        await dbRunAsync(
          `INSERT INTO ppob_transactions (user_id, ref_id, sku, target, price, status, sn)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, refId, productName, target, price, d.status, d.sn || '']
        );

        let msg = `<b>🚀 TRANSAKSI DIPROSES</b>\n\n`;
        msg += `📦 Produk : <b>${productName}</b>\n`;
        msg += `🎯 Tujuan : <code>${target}</code>\n`;
        msg += `📝 Status : <b>${d.status}</b>\n`;
        msg += `🆔 RefID  : <code>${refId}</code>\n\n`;
        msg += (d.sn && d.sn !== '')
          ? `✅ <b>SN:</b> <code>${d.sn}</code>\n\n`
          : `⏳ <i>SN akan diupdate otomatis via notifikasi.</i>\n\n`;
        msg += `Saldo terpotong: <b>Rp ${price.toLocaleString('id-ID')}</b>`;

        return ctx.reply(msg, { parse_mode: 'HTML' });

      } else {
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [price, userId]);
        const errorDetail = d?.message || 'Produk sedang gangguan.';
        return ctx.reply(
          `❌ <b>Transaksi Gagal</b>\nProduk: ${productName}\nAlasan: ${errorDetail}\n\n✅ Saldo dikembalikan ke akun Anda.`,
          { parse_mode: 'HTML' }
        );
      }
    }
    // ─────────────────────────────────────────
    // ADMIN: DOWNGRADE RESELLER
    // ─────────────────────────────────────────
    if (state.step === 'await_downgrade_id') {
      const targetId = parseInt(text, 10);
      if (isNaN(targetId))
        return ctx.reply('❌ *ID tidak valid.*', { parse_mode: 'Markdown' });

      db.run(
        `UPDATE users SET role = 'user', reseller_level = NULL WHERE user_id = ?`,
        [targetId],
        function (err) {
          if (err) {
            logger.error('❌ DB error saat downgrade reseller:', err.message);
            return ctx.reply('❌ *Gagal downgrade user.*', { parse_mode: 'Markdown' });
          }
          if (this.changes === 0)
            return ctx.reply('⚠️ *User belum terdaftar.*', { parse_mode: 'Markdown' });

          ctx.reply(
            `✅ *User ${targetId} telah di-downgrade menjadi USER biasa.*`,
            { parse_mode: 'Markdown' }
          );
        }
      );

      delete userState[chatId];
      return;
    }

    // ─────────────────────────────────────────
    // ADMIN: PROMOTE RESELLER
    // ─────────────────────────────────────────
    if (state.step === 'await_reseller_id') {
      const targetId = parseInt(text, 10);
      if (isNaN(targetId))
        return ctx.reply('⚠️ *ID tidak valid. Masukkan angka.*', { parse_mode: 'Markdown' });

      db.run(
        `UPDATE users SET role = 'reseller', reseller_level = 'silver', reseller_since = datetime('now'), warned_h7 = 0, warned_h3 = 0 WHERE user_id = ?`,
        [targetId],
        function (err) {
          if (err) {
            logger.error('❌ DB error saat promote:', err.message);
            return ctx.reply('❌ *Gagal promote user.*', { parse_mode: 'Markdown' });
          }
          if (this.changes === 0)
            return ctx.reply('⚠️ *User belum terdaftar.*', { parse_mode: 'Markdown' });

          ctx.reply(
            `✅ *User ${targetId} sukses dipromosikan jadi RESELLER!*`,
            { parse_mode: 'Markdown' }
          );
        }
      );

      delete userState[chatId];
      return;
    }

    // ─────────────────────────────────────────
    // ADMIN: BROADCAST MESSAGE
    // ─────────────────────────────────────────
    if (state.step === 'await_broadcast_message') {
      if (!adminIds.includes(userId))
        return ctx.reply('❌ Kamu tidak punya izin untuk broadcast.');

      const broadcastText = text;
      state.messageId     = ctx.message.message_id;
      state.chatId        = chatId;
      state.broadcastText = broadcastText;

      return ctx.reply(
        `📣 *Konfirmasi Broadcast TEXT*\n\n` +
        `📝 Pesan: _${broadcastText.substring(0, 100)}${broadcastText.length > 100 ? '...' : ''}_\n\n` +
        `Kirim ke semua user?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Ya, Kirim Sekarang', callback_data: 'broadcast_text_confirm' }],
              [{ text: '❌ Batalkan',           callback_data: 'cancel_broadcast' }],
            ],
          },
          parse_mode: 'Markdown',
        }
      );
    }

    // ─────────────────────────────────────────
    // PAKASIR: REQUEST AMOUNT
    // ─────────────────────────────────────────
    if (state.step === 'request_pakasir_amount') {
      const amount     = parseInt(text, 10);
      const minDeposit = MIN_DEPOSIT_AMOUNT || 1000;

      if (isNaN(amount) || amount < minDeposit) {
        return ctx.reply(
          `❌ *Nominal tidak valid.* Masukkan angka yang valid (minimal Rp ${minDeposit.toLocaleString('id-ID')}).`,
          { parse_mode: 'Markdown' }
        );
      }

      delete userState[chatId];

      return ctx.reply(
        `💰 *Konfirmasi Top Up Saldo (Otomatis)*\n\n` +
        `• *Nominal:* Rp ${amount.toLocaleString('id-ID')}\n\n` +
        `Silakan tekan tombol di bawah, dan QRIS akan langsung muncul otomatis.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{
                text: `🧾 Buat Pembayaran Rp ${amount.toLocaleString('id-ID')}`,
                callback_data: `create_pakasir_payment_${amount}`,
              }],
              [{ text: '❌ Batalkan', callback_data: 'send_main_menu' }],
            ],
          },
          parse_mode: 'Markdown',
        }
      );
    }

    // ─────────────────────────────────────────
    // ADD SERVER: STEP-BY-STEP
    // ─────────────────────────────────────────
    if (state.step === 'addserver') {
      if (!text) return ctx.reply('⚠️ *Domain tidak boleh kosong.*', { parse_mode: 'Markdown' });
      state.domain = text;
      state.step   = 'addserver_auth';
      return ctx.reply('🔑 *Silakan masukkan auth server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_auth') {
      if (!text) return ctx.reply('⚠️ *Auth tidak boleh kosong.*', { parse_mode: 'Markdown' });
      state.auth = text;
      state.step  = 'addserver_nama_server';
      return ctx.reply('🏷️ *Silakan masukkan nama server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_nama_server') {
      if (!text) return ctx.reply('⚠️ *Nama server tidak boleh kosong.*', { parse_mode: 'Markdown' });
      state.nama_server = text;
      state.step        = 'addserver_quota';
      return ctx.reply('📊 *Silakan masukkan quota server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_quota') {
      const quota = parseInt(text, 10);
      if (isNaN(quota)) return ctx.reply('⚠️ *Quota tidak valid.*', { parse_mode: 'Markdown' });
      state.quota = quota;
      state.step  = 'addserver_iplimit';
      return ctx.reply('🔢 *Silakan masukkan limit IP server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_iplimit') {
      const iplimit = parseInt(text, 10);
      if (isNaN(iplimit)) return ctx.reply('⚠️ *Limit IP tidak valid.*', { parse_mode: 'Markdown' });
      state.iplimit = iplimit;
      state.step    = 'addserver_batas_create_akun';
      return ctx.reply('🔢 *Silakan masukkan batas create akun server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_batas_create_akun') {
      const batas = parseInt(text, 10);
      if (isNaN(batas)) return ctx.reply('⚠️ *Batas create akun tidak valid.*', { parse_mode: 'Markdown' });
      state.batas_create_akun = batas;
      state.step              = 'addserver_harga';
      return ctx.reply('💰 *Silakan masukkan harga server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_harga') {
      const harga = parseFloat(text);
      if (isNaN(harga) || harga <= 0)
        return ctx.reply('⚠️ *Harga tidak valid.*', { parse_mode: 'Markdown' });

      const { domain, auth, nama_server, quota, iplimit, batas_create_akun } = state;

      try {
        const resolvedIP = await resolveDomainToIP(domain);
        let isp    = 'Tidak diketahui';
        let lokasi = 'Tidak diketahui';

        if (resolvedIP) {
          const info = await getISPAndLocation(resolvedIP);
          isp    = info.isp;
          lokasi = info.lokasi;
        }

        db.run(
          `INSERT INTO Server
             (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, total_create_akun, isp, lokasi)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, isp, lokasi],
          function (err) {
            if (err) {
              logger.error('❌ Error saat tambah server:', err.message);
              return ctx.reply('❌ *Gagal menambahkan server.*', { parse_mode: 'Markdown' });
            }
            ctx.reply(
              `✅ *Server berhasil ditambahkan!*\n\n` +
              `🌐 Domain : ${domain}\n` +
              `📍 Lokasi : ${lokasi}\n` +
              `🏢 ISP    : ${isp}`,
              { parse_mode: 'Markdown' }
            );
          }
        );

      } catch (err) {
        logger.error('❌ Gagal resolve/tambah server:', err.message);
        await ctx.reply('❌ *Terjadi kesalahan saat menambahkan server.*', { parse_mode: 'Markdown' });
      }

      delete userState[chatId];
      return;
    }

  } catch (err) {
    logger.error('❌ Error in text handler: ' + (err.stack || err.message || err));
    await ctx.reply('❌ Terjadi kesalahan saat memproses permintaan.');
  }
});

// create transaction via Pakasir API and return { orderId, paymentUrl, qrImageBuffer, amount }
async function generatePakasirPayment(userId, amount) {
  const orderId = `PKS-${userId}-${Date.now()}`;

  // 1) Try API transactioncreate/qris
  try {
    const apiUrl = 'https://app.pakasir.com/api/transactioncreate/qris';
    const body = {
      project: PAKASIR_PROJECT_SLUG,
      order_id: orderId,
      amount: Number(amount),
      api_key: PAKASIR_API_KEY
    };

    const resp = await axios.post(apiUrl, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const p = resp.data.payment || resp.data;

    // build paymentUrl fallback (web checkout)
    const redirectUrl = encodeURIComponent((PAKASIR_WEBHOOK_URL || '').replace('/webhook/pakasir', '/topup-success') || '');
    const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_PROJECT_SLUG)}/${encodeURIComponent(amount)}?order_id=${encodeURIComponent(orderId)}&redirect=${redirectUrl}&qris_only=1`;

    // save pending deposit in DB (as you already do)
    await new Promise((resolve, reject) => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.run(`INSERT INTO pending_deposits_pakasir (user_id, order_id, amount, status, payment_method, payment_data, expired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, orderId, amount, 'pending', 'qris', paymentUrl, expiresAt],
          (err) => {
            if (err) { logger.error('Error saving pending deposit:', err.message); return reject(err); }
            resolve();
          }
      );
    });

    // Prefer direct QR content if present
    // Some Pakasir responses include `payment.payment_number` (EMVCo string) OR a base64 image
    let qrImageBuffer = null;
    if (p && p.payment_number) {
      // convert EMVCo QR string to image
      const qrData = String(p.payment_number);
      const dataUrl = await QRCode.toDataURL(qrData, { margin: 1, errorCorrectionLevel: 'M' });
      qrImageBuffer = Buffer.from(dataUrl.split(',')[1], 'base64');
    } else if (p && (p.qrcode || p.qr_image_base64)) {
      const base64 = p.qrcode || p.qr_image_base64;
      qrImageBuffer = Buffer.from(base64, 'base64');
    }

    return { orderId, paymentUrl, qrImageBuffer, amount };
  } catch (err) {
    // if API fails, fallback to web checkout URL
    logger.warn('Pakasir API create failed, falling back to web checkout: ' + (err && (err.message || JSON.stringify(err))));
    const fallbackOrderId = `PKS-${userId}-${Date.now()}`;
    const redirectUrl = encodeURIComponent((PAKASIR_WEBHOOK_URL || '').replace('/webhook/pakasir', '/topup-success') || '');
    const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_PROJECT_SLUG)}/${encodeURIComponent(amount)}?order_id=${encodeURIComponent(fallbackOrderId)}&redirect=${redirectUrl}&qris_only=1`;

    await new Promise((resolve, reject) => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.run(`INSERT INTO pending_deposits_pakasir (user_id, order_id, amount, status, payment_method, payment_data, expired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, fallbackOrderId, amount, 'pending', 'qris', paymentUrl, expiresAt],
          (err2) => {
            if (err2) { logger.error('Error saving pending deposit (fallback): ' + err2.message); return reject(err2); }
            resolve();
          }
      );
    });

    return { orderId: fallbackOrderId, paymentUrl, qrImageBuffer: null, amount };
  }
}

// --- WEBHOOK HANDLER PAKASIR (Dengan Notifikasi Grup) ---
async function handlePakasirWebhook(payload, botInstance) {
  const {
    order_id,
    amount: rawAmount,
    status,
    project
  } = payload;

  const amount = Number(rawAmount || 0);

  // VALIDASI STATUS
  if (status !== 'completed' || project !== PAKASIR_PROJECT_SLUG) {
    logger.warn(`Webhook ignored: status/project mismatch. order_id=${order_id}`);
    return;
  }

  // ANTI DOUBLE
  if (global.processedTransactions.has(order_id)) {
    logger.warn(`Webhook ignored: already processed order_id=${order_id}`);
    return;
  }

  global.processedTransactions.add(order_id);

  try {
    // AMBIL PENDING
    const row = await dbGetAsync(
      `
      SELECT user_id, status
      FROM pending_deposits_pakasir
      WHERE order_id = ? AND status = ?
      `,
      [order_id, 'pending']
    );

    if (!row) {
      logger.warn(`Pending deposit not found: ${order_id}`);
      return;
    }

    const userId = row.user_id;

    // START TRANSACTION
    await dbRunAsync('BEGIN TRANSACTION');

    let isWebUser = false;
    let usernameLog = String(userId);
    let saldoBaru = 0;
    let webUserData = null;

    try {
      // CEK USER WEBSITE
      webUserData = await dbGetAsync(`SELECT * FROM web_users WHERE id = ?`, [userId]);

      // WEBSITE USER
      if (webUserData) {
        isWebUser = true;
        await dbRunAsync(`UPDATE web_users SET balance = balance + ? WHERE id = ?`, [amount, userId]);

        const updatedWebUser = await dbGetAsync(`SELECT balance, username, email FROM web_users WHERE id = ?`, [userId]);
        saldoBaru = Number(updatedWebUser?.balance || 0);
        usernameLog = updatedWebUser?.username || updatedWebUser?.email || `WEB-${userId}`;
      }
      // TELEGRAM USER
      else {
        await dbRunAsync(`UPDATE users SET saldo = saldo + ? WHERE user_id = ?`, [amount, userId]);

        // AUTO EXTEND RESELLER
        if (amount >= 20000) {
          await dbRunAsync(
            `
            UPDATE users
            SET warned_h7 = 0, warned_h3 = 0, reseller_since = datetime('now')
            WHERE user_id = ? AND saldo >= 30000 AND role = 'reseller'
            `,
            [userId]
          ).catch(() => {});
        }

        const updatedUser = await getUserDetails(userId);
        saldoBaru = Number(updatedUser?.saldo || 0);

        try {
          const chat = await botInstance.telegram.getChat(userId);
          usernameLog = chat.username ? `${chat.username}` : (chat.first_name || String(userId));
        } catch (e) {}
      }

      // UPDATE STATUS & INSERT LOG
      await dbRunAsync(`UPDATE pending_deposits_pakasir SET status = ? WHERE order_id = ?`, ['completed', order_id]);
      await dbRunAsync(
        `
        INSERT INTO topup_log (user_id, username, amount, reference, metode, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        `,
        [userId, usernameLog, amount, order_id, `Pakasir (${payload.payment_method || 'QRIS'})`]
      );

      // COMMIT
      await dbRunAsync('COMMIT');
      logger.info(`Top up committed: ${order_id}`);

    } catch (txErr) {
      try { await dbRunAsync('ROLLBACK'); } catch (rbErr) { logger.error(`Rollback failed: ${rbErr.message}`); }
      logger.error(`Transaction failed: ${txErr.message}`);
      return;
    }

    // USER MESSAGE
    const userMessage =
      `<b>✅ TOP UP SALDO BERHASIL</b>\n\n` +
      `📄 <b>Invoice:</b> <code>${escapeHtml(order_id)}</code>\n` +
      `💰 <b>Jumlah:</b> Rp ${amount.toLocaleString('id-ID')}\n` +
      `🏧 <b>Metode:</b> ${escapeHtml(payload.payment_method || 'QRIS')}\n` +
      `💳 <b>Saldo Baru:</b> Rp ${saldoBaru.toLocaleString('id-ID')}\n\n` +
      `Terima kasih telah menggunakan layanan kami.`;

    // Notif TELEGRAM ONLY
    if (!isWebUser) {
      await botInstance.telegram.sendMessage(userId, userMessage, { parse_mode: 'HTML' })
        .catch(e => logger.error(`Failed notify user ${userId}: ${e.message}`));
    }

    // GROUP NOTIFICATION (SINKRONISASI JAM & PEMISAH TITIK DUA)
    const timestamp = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/\./g, ':');

    let groupMessage = '';

    if (isWebUser) {
      const maskedWebEmail = escapeHtml(maskEmail(webUserData?.email || ''));
      groupMessage = `
━━━━━━━━━━━━━━━━━━━━━
<b>💳 DEPOSIT SUCCESS </b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>💵 <b>Nominal :</b> Rp ${amount.toLocaleString('id-ID')}
🏧 <b>Metode :</b> ${escapeHtml(payload.payment_method || 'QRIS')}
💰 <b>Saldo :</b> Rp ${saldoBaru.toLocaleString('id-ID')}
📋 <b>Ref ID :</b> <code>${escapeHtml(order_id)}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━
📧 <b>Email :</b> <code>${maskedWebEmail}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>
`.trim();
    } else {
      const userMention = escapeHtml(maskUsername(usernameLog));
      const maskedId = maskUserId(String(userId));
      groupMessage = `
━━━━━━━━━━━━━━━━━━━━━
<b>💳 DEPOSIT SUCCESS</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>💵 <b>Nominal :</b> Rp ${amount.toLocaleString('id-ID')}
🏧 <b>Metode :</b> ${escapeHtml(payload.payment_method || 'QRIS')}
💰 <b>Saldo :</b> Rp ${saldoBaru.toLocaleString('id-ID')}
📋 <b>Ref ID :</b> <code>${escapeHtml(order_id)}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User :</b> ${userMention}
🆔 <b>ID :</b> <code>${maskedId}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>
`.trim();
    }

    // WAJIB AWAIT AGAR SIKLUS EXPRESS TIDAK MEMUTUS REQUEST TELEGRAM
    if (GROUP_ID) {
      await botInstance.telegram.sendMessage(GROUP_ID, groupMessage, { parse_mode: 'HTML' })
        .catch(e => logger.error(`❌ Gagal kirim notif grup Pakasir: ${e.message}`));
    }

    logger.info(`Webhook processed successfully: ${order_id}`);
  } catch (err) {
    logger.error(`Webhook error ${order_id}: ${err?.message || err}`);
  }
}

async function queryPakasirTransaction(orderId, amount) {
  const url = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(PAKASIR_PROJECT_SLUG)}&amount=${encodeURIComponent(amount)}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;
  const resp = await axios.get(url, { timeout: 15000 });
  return resp.data.transaction || resp.data;
}

bot.action(/create_pakasir_payment_(\d+)/, async (ctx) => {
  const amount = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id;

  await ctx.answerCbQuery('Membuat tautan pembayaran...');

  try {
    const { orderId, qrImageBuffer, amount: amt } =
      await generatePakasirPayment(userId, amount);

    const expiryDate = new Date(Date.now() + 60 * 60 * 1000);
    const expiryText = expiryDate.toLocaleString('id-ID', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const notice =
      `\n\nℹ️ *Setelah pembayaran berhasil, saldo akan masuk otomatis tanpa perlu tombol apapun.*` +
      `\n⏳ Biasanya hanya 2–10 detik. Jika saldo belum masuk setelah 1 menit, silakan hubungi admin.`;

    const originalMessage = ctx.update?.callback_query?.message;
    const deleteAt = Date.now() + 10 * 60 * 1000; // auto-delete 10 menit

    // --- QR Available ---
    if (qrImageBuffer) {

      // Update pesan awal
      try {
        await safeMenuSend(ctx,
          `🧾 *PEMBAYARAN QRIS TERSEDIA*\n\n` +
          `Invoice: \`${orderId}\`\n` +
          `Nominal: *Rp ${amt.toLocaleString('id-ID')}*\n` +
          `Kadaluarsa: ${expiryText}\n\n` +
          `Silakan *scan QR* untuk melakukan pembayaran.${notice}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}

      // Kirim gambar QR
      const qrMsg = await ctx.replyWithPhoto(
        { source: qrImageBuffer },
        {
          caption:
            `Invoice: \`${orderId}\`\n` +
            `Nominal: Rp ${amt.toLocaleString('id-ID')}\n` +
            `Kadaluarsa: ${expiryText}\n\n` +
            `Silakan lakukan pembayaran, saldo akan masuk otomatis.`,
          parse_mode: 'Markdown'
        }
      );

      // Simpan untuk auto-delete
      if (originalMessage)
        await addPendingDelete(originalMessage.chat.id, originalMessage.message_id, deleteAt);

      if (qrMsg)
        await addPendingDelete(qrMsg.chat.id, qrMsg.message_id, deleteAt);
    }

    // --- Tanpa QR (fallback link) ---
    else {
      try {
        await safeMenuSend(ctx,
          `🔗 *TAUTAN PEMBAYARAN*\n\n` +
          `Invoice: \`${orderId}\`\n` +
          `Nominal: *Rp ${amt.toLocaleString('id-ID')}*\n\n` +
          `Silakan buka halaman pembayaran.${notice}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}

      if (originalMessage)
        await addPendingDelete(originalMessage.chat.id, originalMessage.message_id, deleteAt);
    }

  } catch (err) {
    logger.error('Error creating Pakasir payment action: ' +
      (err?.stack || err?.message || err));
    await ctx.reply(
      '❌ *GAGAL!* Terjadi kesalahan saat membuat tautan pembayaran. Silakan coba lagi nanti.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.action(/check_pakasir_status_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery('Mengecek status pembayaran...');

  try {
    const pending = await dbGetAsync('SELECT amount FROM pending_deposits_pakasir WHERE order_id = ? AND status = ?', [orderId, 'pending']);
    if (!pending) return ctx.reply('ℹ️ *Transaksi sudah selesai atau tidak ditemukan.* Silakan cek saldo Anda.', { parse_mode: 'Markdown' });

    const amount = Number(pending.amount);
    const txn = await queryPakasirTransaction(orderId, amount);

    const status = (txn?.status || '').toLowerCase();
    if (status === 'completed' || status === 'paid') {
      // reuse your webhook handler to credit the user
      await handlePakasirWebhook({ order_id: orderId, amount, project: PAKASIR_PROJECT_SLUG, status: 'completed', payment_method: txn.payment_method || 'qris' }, bot);
      return ctx.reply('✅ *Pembayaran berhasil dikonfirmasi!* Saldo Anda telah ditambahkan secara otomatis.', { parse_mode: 'Markdown' });
    } else if (status === 'pending' || status === 'waiting') {
      return ctx.reply(`⏳ *Status Transaksi: Menunggu Pembayaran*\n\nInvoice: \`${orderId}\`\nNominal: *Rp ${amount.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' });
    } else {
      return ctx.reply(`⚠️ *Status Transaksi: ${status.toUpperCase()}*\n\nSilakan buat transaksi Top Up baru.`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    logger.error('Error checking Pakasir status: ' + (e && (e.stack || e.message || JSON.stringify(e))));
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat mengecek status pembayaran. Coba lagi nanti.', { parse_mode: 'Markdown' });
  }
});

bot.action('addserver', async (ctx) => {
  try {
    logger.info('📥 Proses tambah server dimulai');
    await ctx.answerCbQuery();
    await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
    userState[ctx.chat.id] = { step: 'addserver' };
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses tambah server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action('detailserver', async (ctx) => {
  try {
    logger.info('?? Proses detail server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    const buttons = [];
    for (let i = 0; i < servers.length; i += 2) {
      const row = [];
      row.push({
        text: `${servers[i].nama_server}`,
        callback_data: `server_detail_${servers[i].id}`
      });
      if (i + 1 < servers.length) {
        row.push({
          text: `${servers[i + 1].nama_server}`,
          callback_data: `server_detail_${servers[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    await ctx.reply('📋 *Silakan pilih server untuk melihat detail:*', {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('listserver', async (ctx) => {
  try {
    logger.info('📜 Proses daftar server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    let serverList = '📜 *Daftar Server* 📜\n\n';
    servers.forEach((server, index) => {
      serverList += `🔹 ${index + 1}. ${server.domain}\n`;
    });

    serverList += `\nTotal Jumlah Server: ${servers.length}`;

    await ctx.reply(serverList, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil daftar server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('deleteserver', async (ctx) => {
  try {
    logger.info('🗑️ Proses hapus server dimulai');
    await ctx.answerCbQuery();
    
    db.all('SELECT * FROM Server', [], (err, servers) => {
      if (err) {
        logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
      }

      if (servers.length === 0) {
        logger.info('⚠️ Tidak ada server yang tersedia');
        return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
      }

      const keyboard = servers.map(server => {
        return [{ text: server.nama_server, callback_data: `confirm_delete_server_${server.id}` }];
      });
      keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'kembali_ke_menu' }]);

      ctx.reply('🗑️ *Pilih server yang ingin dihapus:*', {
        reply_markup: {
          inline_keyboard: keyboard
        },
        parse_mode: 'Markdown'
      });
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses hapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});


// Menangani aksi untuk mengecek saldo
bot.action('cek_saldo', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat memeriksa saldo:', err.message);
          return reject('❌ *Terjadi kesalahan saat memeriksa saldo Anda. Silakan coba lagi nanti.*');
        }
        resolve(row);
      });
    });

    if (row) {
      await ctx.reply(`📊 *Cek Saldo*\n\n🆔 ID Telegram: ${userId}\n💰 Sisa Saldo: Rp${row.saldo}`, 
      { 
        parse_mode: 'Markdown', 
        reply_markup: {
          inline_keyboard: [
            [{ text: '💸 Top Up', callback_data: 'topup_saldo' }, { text: '📝 Menu Utama', callback_data: 'send_main_menu' }]
          ]
        } 
      });
    } else {
      await ctx.reply('⚠️ *Anda belum memiliki saldo. Silakan tambahkan saldo terlebih dahulu.*', { parse_mode: 'Markdown' });
    }
    
  } catch (error) {
    logger.error('❌ Kesalahan saat memeriksa saldo:', error);
    await ctx.reply(`❌ *${error.message}*`, { parse_mode: 'Markdown' });
  }
});

// Fungsi untuk mengambil username berdasarkan ID
const getUsernameById = async (userId) => {
  try {
    // Kita ambil dari database lokal saja biar gak kena limit Telegram
    const row = await new Promise((resolve) => {
      db.get("SELECT username, first_name FROM Users WHERE user_id = ?", [userId], (err, r) => {
        resolve(r);
      });
    });

    if (row) {
      // Kalau ada username pakai @, kalau gak ada pakai Nama depan, kalau gak ada pakai ID
      return row.username ? `@${row.username}` : (row.first_name || userId);
    }
    
    return userId; // Fallback kalau user gak ketemu di DB
  } catch (err) {
    logger.error('❌ Gagal ambil username dari DB:', err.message);
    return userId;
  }
};

// 📄 NEXT PAGE untuk kurangi saldo user
// --- BAGIAN REDUCE SALDO USER (Menu Utama) ---
bot.action('reducesaldo_user', async (ctx) => {
  try {
    logger.info('Reduce saldo user process started');
    await ctx.answerCbQuery();

    // 🔹 Ambil data user + username sekaligus dari DB
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT id, user_id, username, first_name FROM Users LIMIT 20', [], (err, rows) => {
        if (err) return reject('⚠️ Gagal ambil daftar user.');
        resolve(rows || []);
      });
    });

    const totalUsers = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => resolve(row ? row.count : 0));
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      // User 1
      const name1 = users[i].username ? `@${users[i].username}` : (users[i].first_name || users[i].user_id);
      row.push({ text: name1, callback_data: `reduce_saldo_${users[i].id}` });
      
      // User 2
      if (i + 1 < users.length) {
        const name2 = users[i+1].username ? `@${users[i+1].username}` : (users[i+1].first_name || users[i+1].user_id);
        row.push({ text: name2, callback_data: `reduce_saldo_${users[i+1].id}` });
      }
      buttons.push(row);
    }

    const replyMarkup = { inline_keyboard: [...buttons] };
    if (totalUsers > 20) {
      replyMarkup.inline_keyboard.push([{ text: '➡️ Next', callback_data: `next_users_reduce_1` }]);
    }

    await ctx.reply('📉 *Silakan pilih user untuk mengurangi saldo:*', { reply_markup: replyMarkup, parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Eror reducesaldo_user:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

// --- BAGIAN NEXT REDUCE USERS ---
bot.action(/next_users_reduce_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    await ctx.answerCbQuery();
    const users = await new Promise((resolve) => {
      db.all(`SELECT id, user_id, username, first_name FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, rows) => resolve(rows || []));
    });

    const totalUsers = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => resolve(row ? row.count : 0));
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const name1 = users[i].username ? `@${users[i].username}` : (users[i].first_name || users[i].user_id);
      row.push({ text: name1, callback_data: `reduce_saldo_${users[i].id}` });
      if (i + 1 < users.length) {
        const name2 = users[i+1].username ? `@${users[i+1].username}` : (users[i+1].first_name || users[i+1].user_id);
        row.push({ text: name2, callback_data: `reduce_saldo_${users[i+1].id}` });
      }
      buttons.push(row);
    }

    const navigation = [];
    if (currentPage > 0) navigation.push({ text: '⬅️ Back', callback_data: `prev_users_reduce_${currentPage - 1}` });
    if (offset + 20 < totalUsers) navigation.push({ text: '➡️ Next', callback_data: `next_users_reduce_${currentPage + 1}` });

    await ctx.editMessageReplyMarkup({ inline_keyboard: [...buttons, navigation] });
  } catch (error) {
    logger.error('❌ Eror next_users_reduce:', error);
  }
});

// --- BAGIAN PREV REDUCE USERS ---
bot.action(/prev_users_reduce_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    await ctx.answerCbQuery();
    const users = await new Promise((resolve) => {
      db.all(`SELECT id, user_id, username, first_name FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, rows) => resolve(rows || []));
    });

    const totalUsers = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => resolve(row ? row.count : 0));
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const name1 = users[i].username ? `@${users[i].username}` : (users[i].first_name || users[i].user_id);
      row.push({ text: name1, callback_data: `reduce_saldo_${users[i].id}` });
      if (i + 1 < users.length) {
        const name2 = users[i+1].username ? `@${users[i+1].username}` : (users[i+1].first_name || users[i+1].user_id);
        row.push({ text: name2, callback_data: `reduce_saldo_${users[i+1].id}` });
      }
      buttons.push(row);
    }

    const navigation = [];
    if (currentPage > 0) navigation.push({ text: '⬅️ Back', callback_data: `prev_users_reduce_${currentPage - 1}` });
    if (offset + 20 < totalUsers) navigation.push({ text: '➡️ Next', callback_data: `next_users_reduce_${currentPage + 1}` });

    await ctx.editMessageReplyMarkup({ inline_keyboard: [...buttons, navigation] });
  } catch (error) {
    logger.error('❌ Eror prev_users_reduce:', error);
  }
});

// --- BAGIAN ADD SALDO USER ---
bot.action('addsaldo_user', async (ctx) => {
  try {
    logger.info('Add saldo user process started');
    await ctx.answerCbQuery();

    // Ambil user sekaligus dengan username/nama dari database
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT id, user_id, username, first_name FROM Users LIMIT 20', [], (err, rows) => {
        if (err) return reject('⚠️ Gagal ambil daftar user.');
        resolve(rows);
      });
    });

    const rowCount = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => resolve(row ? row.count : 0));
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      // User 1
      const name1 = users[i].username ? `@${users[i].username}` : (users[i].first_name || users[i].user_id);
      row.push({ text: name1, callback_data: `add_saldo_${users[i].id}` });
      
      // User 2 (kalau ada)
      if (i + 1 < users.length) {
        const name2 = users[i+1].username ? `@${users[i+1].username}` : (users[i+1].first_name || users[i+1].user_id);
        row.push({ text: name2, callback_data: `add_saldo_${users[i+1].id}` });
      }
      buttons.push(row);
    }

    const replyMarkup = { inline_keyboard: [...buttons] };
    if (rowCount > 20) {
      replyMarkup.inline_keyboard.push([{ text: '➡️ Next', callback_data: `next_users_1` }]);
    }

    await ctx.reply('📊 *Silakan pilih user untuk menambahkan saldo:*', { reply_markup: replyMarkup, parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Eror addsaldo_user:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

// --- BAGIAN NEXT USERS ---
bot.action(/next_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    await ctx.answerCbQuery();
    const users = await new Promise((resolve) => {
      db.all(`SELECT id, user_id, username, first_name FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, rows) => resolve(rows || []));
    });

    const rowCount = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => resolve(row ? row.count : 0));
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const name1 = users[i].username ? `@${users[i].username}` : (users[i].first_name || users[i].user_id);
      row.push({ text: name1, callback_data: `add_saldo_${users[i].id}` });
      if (i + 1 < users.length) {
        const name2 = users[i+1].username ? `@${users[i+1].username}` : (users[i+1].first_name || users[i+1].user_id);
        row.push({ text: name2, callback_data: `add_saldo_${users[i+1].id}` });
      }
      buttons.push(row);
    }

    const navigation = [];
    if (currentPage > 0) navigation.push({ text: '⬅️ Back', callback_data: `prev_users_${currentPage}` });
    if (offset + 20 < rowCount) navigation.push({ text: '➡️ Next', callback_data: `next_users_${currentPage + 1}` });

    const replyMarkup = { inline_keyboard: [...buttons, navigation] };
    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Eror next_users:', error);
  }
});

// --- BAGIAN PREV USERS ---
bot.action(/prev_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]); // Ini halaman tujuannya
  const offset = (currentPage - 1) * 20;

  try {
    await ctx.answerCbQuery();
    const users = await new Promise((resolve) => {
      db.all(`SELECT id, user_id, username, first_name FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, rows) => resolve(rows || []));
    });

    const rowCount = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => resolve(row ? row.count : 0));
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const name1 = users[i].username ? `@${users[i].username}` : (users[i].first_name || users[i].user_id);
      row.push({ text: name1, callback_data: `add_saldo_${users[i].id}` });
      if (i + 1 < users.length) {
        const name2 = users[i+1].username ? `@${users[i+1].username}` : (users[i+1].first_name || users[i+1].user_id);
        row.push({ text: name2, callback_data: `add_saldo_${users[i+1].id}` });
      }
      buttons.push(row);
    }

    const navigation = [];
    if (currentPage > 1) navigation.push({ text: '⬅️ Back', callback_data: `prev_users_${currentPage - 1}` });
    navigation.push({ text: '➡️ Next', callback_data: `next_users_${currentPage}` });

    const replyMarkup = { inline_keyboard: [...buttons, navigation] };
    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Eror prev_users:', error);
  }
});

bot.action('editserver_limit_ip', async (ctx) => {
  try {
    logger.info('Edit server limit IP process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_limit_ip_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit limit IP:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit limit IP server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_batas_create_akun', async (ctx) => {
  try {
    logger.info('Edit server batas create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_batas_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit batas create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit batas create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_total_create_akun', async (ctx) => {
  try {
    logger.info('Edit server total create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit total create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit total create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_quota', async (ctx) => {
  try {
    logger.info('Edit server quota process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_quota_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit quota:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit quota server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_auth', async (ctx) => {
  try {
    logger.info('Edit server auth process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_auth_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🌐 *Silakan pilih server untuk mengedit auth:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit auth server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_harga', async (ctx) => {
  try {
    logger.info('Edit server harga process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_harga_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('💰 *Silakan pilih server untuk mengedit harga:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit harga server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_domain', async (ctx) => {
  try {
    logger.info('Edit server domain process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_domain_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🌐 *Silakan pilih server untuk mengedit domain:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit domain server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('nama_server_edit', async (ctx) => {
  try {
    logger.info('Edit server nama process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_nama_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🏷️ *Silakan pilih server untuk mengedit nama:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit nama server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('topup_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    await safeMenuSend(ctx,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━
         <b>💰 TOP UP SALDO</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🔄 Pilih Metode Pembayaran</b>
<blockquote>Bot menyediakan 2 gateway pembayaran otomatis untuk kemudahan transaksi Anda.</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>💎 Orkut Payment</b>
<blockquote>• Saldo langsung masuk setelah pembayaran
• Proses sangat cepat & stabil
• Sistem otomatis 24/7
• Support berbagai metode</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>⚖️ Pakasir Payment</b>
<blockquote>• Proses otomatis tanpa konfirmasi manual
• Support QRIS & fast payment
• Berbagai metode modern
• Real-time notification</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━━━

<i>Pilih gateway sesuai preferensi Anda</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💎 Orkut Payment (Otomatis)', callback_data: 'topup_saldo_orderkuota' }
            ],
            [
              { text: '⚖️ Pakasir Payment (Otomatis)', callback_data: 'topup_saldo_pakasir' }
            ],
            [
              { text: '🏠 Kembali', callback_data: 'send_main_menu' }
            ]
          ]
        }
      }
    );

  } catch (error) {
    logger.error('❌ Gagal membuka menu topup:', error);
  }
});

bot.action('topup_saldo_orderkuota1', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    logger.info(`🔍 User ${userId} memulai proses top-up saldo.`);

    if (!global.depositState) {
      global.depositState = {};
    }
    global.depositState[userId] = {
      action: 'request_amount',
      amount: ''
    };

    const keyboard = keyboard_nomor_deposit();

    const text =
      '💰 *Silakan masukkan jumlah nominal saldo yang Anda ingin tambahkan ke akun Anda:*\n\n' +
      'Jumlah saat ini: *Rp 0*';

    await safeMenuSend(ctx, text, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses top-up saldo:', error);
    await safeMenuSend(ctx,
      '❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*',
      { parse_mode: 'Markdown' }
    );
  }
});
bot.action('topup_saldo_pakasir', async (ctx) => {
    try {
        await ctx.answerCbQuery();

        userState[ctx.chat.id] = {
            step: 'request_pakasir_amount',
            amount: ''
        };

        await safeMenuSend(ctx,
            `💰 *TOP UP SALDO (OTOMATIS)*\n\n` +
            `Silakan masukkan *nominal saldo* yang ingin Anda tambahkan ke akun.\n` +
            `Gunakan angka saja *tanpa titik atau koma*.\n\n` +
            `🔸 Minimal Top Up: *Rp ${MIN_DEPOSIT_AMOUNT.toLocaleString('id-ID')}*\n` +
            `_Contoh: 5000_`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        logger.error('❌ Kesalahan saat memulai proses top-up saldo otomatis:', error);

        await ctx.reply(
            '❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.',
            { parse_mode: 'Markdown' }
        );
    }
});

bot.action(/edit_harga_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit harga server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga', serverId: serverId };

  await ctx.reply('💰 *Silakan masukkan harga server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/add_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk menambahkan saldo user dengan ID: ${userId}`);
  userState[ctx.chat.id] = { step: 'add_saldo', userId: userId };

  await ctx.reply('📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/reduce_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengurangi saldo user dengan ID: ${userId}`);

  userState[ctx.chat.id] = { step: 'reduce_saldo', userId: userId, amount: '' };

  await ctx.reply('📉 *Masukkan jumlah saldo yang ingin dikurangi:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_batas_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit batas create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_batas_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan batas create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_total_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit total create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_total_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan total create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_limit_ip_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit limit IP server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_limit_ip', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan limit IP server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_quota_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit quota server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_quota', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan quota server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_auth_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit auth server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_auth', serverId: serverId };

  await ctx.reply('🔑 *Silakan masukkan auth server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_domain_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit domain server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_domain', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan domain server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_nama_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit nama server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_nama', serverId: serverId };

  await ctx.reply('🏷️ *Silakan masukkan nama server baru:*', {
    reply_markup: { inline_keyboard: keyboard_abc() },
    parse_mode: 'Markdown'
  });
});
bot.action(/confirm_delete_server_(\d+)/, async (ctx) => {
  try {
    db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], function(err) {
      if (err) {
        logger.error('Error deleting server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat menghapus server.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        logger.info('Server tidak ditemukan');
        return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      logger.info(`Server dengan ID ${ctx.match[1]} berhasil dihapus`);
      ctx.reply('✅ *Server berhasil dihapus.*', { parse_mode: 'Markdown' });
    });
  } catch (error) {
    logger.error('Kesalahan saat menghapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action(/server_detail_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(server);
      });
    });

    if (!server) {
      logger.info('⚠️ Server tidak ditemukan');
      return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const serverDetails = `📋 *Detail Server* 📋\n\n` +
      `🌐 *Domain:* \`${server.domain}\`\n` +
      `🔑 *Auth:* \`${server.auth}\`\n` +
      `🏷️ *Nama Server:* \`${server.nama_server}\`\n` +
      `📊 *Quota:* \`${server.quota}\`\n` +
      `?? *Limit IP:* \`${server.iplimit}\`\n` +
      `🔢 *Batas Create Akun:* \`${server.batas_create_akun}\`\n` +
      `📋 *Total Create Akun:* \`${server.total_create_akun}\`\n` +
      `💵 *Harga:* \`Rp ${server.harga}\`\n\n`;

    await ctx.reply(serverDetails, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});
bot.on('callback_query', async (ctx) => {
  const userId = String(ctx.from.id);
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat?.id;
  const state = userState[chatId];

  // ===============================
  // 🔙 KEMBALI KE MENU UTAMA (PALING ATAS)
  // ===============================
  if (data === 'send_main_menu') {
    delete global.depositState?.[userId];
    delete userState[chatId];
    return sendMainMenu(ctx);
  }

  // ===============================
  // 🔁 RENEW ZIVPN → PILIH SERVER
  // ===============================
  if (data === 'renew_zivpn') {
    return startSelectServer(ctx, 'renew', 'zivpn');
  }

  if (data.startsWith('renew_username_zivpn_')) {
    const serverId = Number(data.split('_').pop());

    userState[chatId] = {
      action: 'renew',
      type: 'zivpn',
      serverId,
      step: 'username_renew_zivpn'
    };

    return ctx.reply(
      '🔐 *Masukkan Password ZIVPN yang ingin diperpanjang*\n_(huruf kecil & angka, 5–8 karakter)_',
      { parse_mode: 'Markdown' }
    );
  }

  // ===============================
  // 🆕 CREATE ZIVPN → PILIH SERVER
  // ===============================
  if (data === 'create_zivpn') {
    return startSelectServer(ctx, 'create', 'zivpn');
  }

  // ===============================
  // 🧩 SERVER DIPILIH (CREATE ONLY)
  // ===============================
  if (data.startsWith('create_username_')) {
    const [, , type, serverId] = data.split('_');

    // 🔒 CEK SERVER FULL (KHUSUS CREATE)
    const server = await dbGetAsync(
      'SELECT total_create_akun, batas_create_akun FROM Server WHERE id = ?',
      [serverId]
    );

    if (!server || server.total_create_akun >= server.batas_create_akun) {
      delete userState[chatId];
      return ctx.reply(
        '❌ *Server penuh.*\nTidak dapat membuat akun baru di server ini.',
        { parse_mode: 'Markdown' }
      );
    }

    userState[chatId] = {
      action: 'create',
      type,
      serverId: Number(serverId),
      step: `username_create_${type}`
    };

    // 🔥 ZIVPN = PASSWORD ONLY
    if (type === 'zivpn') {
      return ctx.reply(
        '🔐 *Masukkan Password ZIVPN*\n_(isi seseuau keinginan mu)_',
        { parse_mode: 'Markdown' }
      );
    }

    return ctx.reply(
      '👤 *Masukkan username:*',
      { parse_mode: 'Markdown' }
    );
  }

  // ===============================
  // 💰 HANDLE DEPOSIT
  // ===============================
  const depositState = global.depositState?.[userId];
  if (depositState?.action === 'request_amount') {
    if (data.startsWith('dep_')) {
      return handleDepositState(ctx, userId, data.slice(4));
    }
    delete global.depositState[userId];
  }

  // ===============================
  // ⚙️ HANDLE STATE LAIN
  // ===============================
  if (state) {
    switch (state.step) {
      case 'add_saldo': return handleAddSaldo(ctx, state, data);
      case 'reduce_saldo': return handleReduceSaldo(ctx, state, data);
      case 'edit_batas_create_akun': return handleEditBatasCreateAkun(ctx, state, data);
      case 'edit_limit_ip': return handleEditiplimit(ctx, state, data);
      case 'edit_quota': return handleEditQuota(ctx, state, data);
      case 'edit_auth': return handleEditAuth(ctx, state, data);
      case 'edit_domain': return handleEditDomain(ctx, state, data);
      case 'edit_harga': return handleEditHarga(ctx, state, data);
      case 'edit_nama': return handleEditNama(ctx, state, data);
      case 'edit_total_create_akun': return handleEditTotalCreateAkun(ctx, state, data);
    }
  }
});

async function handleReduceSaldo(ctx, userStateData, data) {
  const userId = userStateData.userId;

  // Tambah angka ke input
  if (/^\d+$/.test(data)) {
    userStateData.amount = (userStateData.amount || '') + data;
    return await safeMenuSend(ctx, `?? *Masukkan jumlah saldo yang ingin dikurangi:*\n\n💰 ${userStateData.amount}`, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }

  // Hapus angka terakhir
  if (data === 'delete') {
    userStateData.amount = (userStateData.amount || '').slice(0, -1);
    return await safeMenuSend(ctx, `📉 *Masukkan jumlah saldo yang ingin dikurangi:*\n\n💰 ${userStateData.amount || '0'}`, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }

  // Konfirmasi
  if (data === 'confirm') {
    const amount = parseInt(userStateData.amount || '0');
    if (!amount || amount <= 0) {
      return await ctx.reply('⚠️ Nominal tidak valid.');
    }

    db.run('UPDATE Users SET saldo = saldo - ? WHERE id = ?', [amount, userId], function (err) {
      if (err) {
        logger.error('❌ Gagal mengurangi saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengurangi saldo.');
      }

      ctx.reply(`✅ Berhasil mengurangi saldo sebesar *Rp${amount.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' });
      delete userState[ctx.chat.id]; // reset
    });
  }
}

async function handleDepositState(ctx, userId, data) {
  if (!global.depositState || !global.depositState[userId]) {
    return;
  }

  let currentAmount = global.depositState[userId].amount || '';

  // 1️⃣ DELETE
  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  }
  // 2️⃣ CONFIRM
  else if (data === 'confirm') {
    if (!currentAmount || currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ Jumlah tidak boleh kosong!', { show_alert: true });
    }

    const num = parseInt(currentAmount, 10);
    if (isNaN(num) || num < 2000) {
      return await ctx.answerCbQuery(
        '⚠️ Jumlah minimal top-up adalah 2000 Ya Kawan...!!!',
        { show_alert: true }
      );
    }

    global.depositState[userId].action = 'confirm_amount';
    await processDeposit(ctx, currentAmount);
    return;
  }
  // 3️⃣ INPUT ANGKA
  else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ Hanya angka yang diperbolehkan!', { show_alert: true });
    }

    if (currentAmount.length >= 12) {
      return await ctx.answerCbQuery('⚠️ Jumlah maksimal adalah 12 digit!', { show_alert: true });
    }

    currentAmount += data;
  }

  global.depositState[userId].amount = currentAmount;

  const display = currentAmount || '0';
  const newMessage =
    `💰 *Silakan masukkan jumlah nominal saldo yang Anda ingin tambahkan ke akun Anda:*\n\n` +
    `Jumlah saat ini: *Rp ${display}*`;

  if (newMessage === ctx.callbackQuery.message.text) {
    return ctx.answerCbQuery();
  }

  try {
    await safeMenuSend(ctx, newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_deposit() },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      return;
    }
    logger.error('Error updating message (deposit):', error.message || error);
  }
}

async function handleAddSaldo(ctx, userStateData, data) {
  let currentSaldo = userStateData.saldo || '';

  if (data === 'delete') {
    currentSaldo = currentSaldo.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentSaldo.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak boleh kosong!*', { show_alert: true });
    }

    try {
      await updateUserSaldo(userStateData.userId, currentSaldo);
      ctx.reply(`✅ *Saldo user berhasil ditambahkan.*\n\n📄 *Detail Saldo:*\n- Jumlah Saldo: *Rp ${currentSaldo}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat menambahkan saldo user.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[0-9]+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak valid!*', { show_alert: true });
    }
    if (currentSaldo.length < 10) {
      currentSaldo += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo maksimal adalah 10 karakter!*', { show_alert: true });
    }
  }

  userStateData.saldo = currentSaldo;
  const newMessage = `📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah saldo saat ini: *${currentSaldo}*`;
  if (newMessage !== (ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption)) {
    await safeMenuSend(ctx, newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditBatasCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'batasCreateAkun', 'batas create akun', 'UPDATE Server SET batas_create_akun = ? WHERE id = ?');
}

async function handleEditTotalCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'totalCreateAkun', 'total create akun', 'UPDATE Server SET total_create_akun = ? WHERE id = ?');
}

async function handleEditiplimit(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'iplimit', 'limit IP', 'UPDATE Server SET iplimit = ? WHERE id = ?');
}

async function handleEditQuota(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'quota', 'quota', 'UPDATE Server SET quota = ? WHERE id = ?');
}

async function handleEditAuth(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'auth', 'auth', 'UPDATE Server SET auth = ? WHERE id = ?');
}

async function handleEditDomain(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'domain', 'domain', 'UPDATE Server SET domain = ? WHERE id = ?');
}

async function handleEditHarga(ctx, userStateData, data) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah tidak boleh kosong!*', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply('❌ *Harga tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, 'UPDATE Server SET harga = ? WHERE id = ?');
      ctx.reply(`✅ *Harga server berhasil diupdate.*\n\n?? *Detail Server:*\n- Harga Baru: *Rp ${hargaBaru}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat mengupdate harga server.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Hanya angka yang diperbolehkan!*', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah maksimal adalah 12 digit!*', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = `💰 *Silakan masukkan harga server baru:*\n\nJumlah saat ini: *Rp ${currentAmount}*`;
  if (newMessage !== (ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption)) {
    await safeMenuSend(ctx, newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditNama(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'name', 'nama server', 'UPDATE Server SET nama_server = ? WHERE id = ?');
}

async function handleEditField(ctx, userStateData, data, field, fieldName, query) {
  let currentValue = userStateData[field] || '';

  // Kelompok field
  const numericFields = new Set(['batasCreateAkun', 'totalCreateAkun', 'iplimit', 'quota']);
  const textFields   = new Set(['name', 'domain', 'auth']); // name = nama server

  // 1️⃣ Tombol DELETE
  if (data === 'delete') {
    if (!currentValue.length) {
      await ctx.answerCbQuery('⚠️ Tidak ada karakter untuk dihapus.', { show_alert: false });
      return;
    }
    currentValue = currentValue.slice(0, -1);

  // 2️⃣ Tombol CONFIRM
  } else if (data === 'confirm') {
    if (currentValue.length === 0) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak boleh kosong!*`, { show_alert: true });
    }

    try {
      await updateServerField(userStateData.serverId, currentValue, query);
      await ctx.reply(
        `✅ *${fieldName} server berhasil diupdate.*\n\n` +
        `📄 *Detail Server:*\n- ${
          fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
        }: *${currentValue}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(
        `❌ *Terjadi kesalahan saat mengupdate ${fieldName} server.*`,
        { parse_mode: 'Markdown' }
      );
    }

    delete userState[ctx.chat.id];
    return;

  // 3️⃣ Tambah karakter dari tombol keyboard
  } else {

    // VALIDASI BERDASARKAN TIPE FIELD
    if (numericFields.has(field)) {
      // cuma boleh angka
      if (!/^[0-9]+$/.test(data)) {
        return await ctx.answerCbQuery(`⚠️ *${fieldName} hanya boleh angka!*`, { show_alert: true });
      }
    } else if (textFields.has(field)) {
      // huruf/angka/titik/dash
      if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
        return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
      }
    } else {
      // fallback kalau ada field lain ke depan
      if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
        return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
      }
    }

    // BATAS PANJANG
    if (currentValue.length < 253) {
      currentValue += data;
    } else {
      return await ctx.answerCbQuery(
        `⚠️ *${fieldName} maksimal adalah 253 karakter!*`,
        { show_alert: true }
      );
    }
  }

  // 4️⃣ Simpan nilai baru di state
  userStateData[field] = currentValue;

  const newMessage =
    `📊 *Silakan masukkan ${fieldName} server baru:*\n\n` +
    `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} saat ini: *${currentValue}*`;

  // 5️⃣ Pilih keyboard sesuai field
  let inlineKb;
  if (textFields.has(field)) {
    // name, domain, auth → huruf+angka
    inlineKb = keyboard_full();    // atau keyboard_abc() kalau mau huruf saja
  } else if (numericFields.has(field)) {
    // quota, iplimit, batas dll → angka
    inlineKb = keyboard_nomor();
  } else {
    // fallback
    inlineKb = keyboard_full();
  }

  // 6️⃣ Kalau menurut Telegraf teks sudah sama, gak usah edit
  const currentText = ctx.callbackQuery?.message?.text || ctx.callbackQuery?.message?.caption;
  if (currentText === newMessage) {
    return;
  }

  try {
    await safeMenuSend(ctx, newMessage, {
      reply_markup: { inline_keyboard: inlineKb },
      parse_mode: 'Markdown'
    });
  } catch (err) {
    const desc = err.description || err.message || '';
    if (!desc.includes('message is not modified')) {
      logger.error('❌ Error safeMenuSend di handleEditField: ' + (err.message || err));
    }
  }
}
async function updateUserSaldo(userId, saldo) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE Users SET saldo = saldo + ? WHERE id = ?', [saldo, userId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan saldo user:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateServerField(serverId, value, query) {
  return new Promise((resolve, reject) => {
    db.run(query, [value, serverId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat mengupdate field server: ' + err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function generateRandomAmount(baseAmount) {
  const random = Math.floor(Math.random() * 99) + 1;
  return baseAmount + random;
}

global.depositState = {};
global.pendingDeposits = {};
let lastRequestTime = 0;
const requestInterval = 1000; 

db.all('SELECT * FROM pending_deposits WHERE status = "pending"', [], (err, rows) => {
  if (err) {
    logger.error('Gagal load pending_deposits:', err.message);
    return;
  }
  rows.forEach(row => {
    global.pendingDeposits[row.unique_code] = {
      amount: row.amount,
      originalAmount: row.original_amount,
      userId: row.user_id,
      timestamp: row.timestamp,
      status: row.status,
      qrMessageId: row.qr_message_id
    };
  });
  logger.info('Pending deposit loaded:', Object.keys(global.pendingDeposits).length);
});

    //const qris = new QRISPayment({
    //merchantId: MERCHANT_ID,
   // apiKey: API_KEY,
   // baseQrString: DATA_QRIS,
 //   logoPath: 'logo.png'
//    });


function generateRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processDeposit(ctx, amount) {
  const currentTime = Date.now();

  if (currentTime - lastRequestTime < requestInterval) {
    await safeMenuSend(ctx, '⚠️ *Terlalu banyak permintaan. Silakan tunggu sebentar.*', { parse_mode: 'Markdown' });
    return;
  }

  lastRequestTime = currentTime;
  const userId = ctx.from.id;
  const uniqueCode = `user-${userId}-${Date.now()}`;

  // Generate nominal unik
  const finalAmount = Number(amount) + generateRandomNumber(1, 300);
  const adminFee = finalAmount - Number(amount);

  try {
    const urlQr = DATA_QRIS; 
    // Link API Vercel kamu
    const myApiUrl = `https://avi.isdarprem.net/api/generate-qris?amount=${finalAmount}&codeqr=${encodeURIComponent(urlQr)}`;

    // LANGKAH 1: Download gambar langsung dari Vercel kamu
    const qrResponse = await axios.get(myApiUrl, { 
      responseType: 'arraybuffer',
      timeout: 15000 
    });
    
    const qrBuffer = Buffer.from(qrResponse.data);

    // LANGKAH 2: Siapkan Caption
    const caption =
      `📝 *Detail Pembayaran:*\n\n` +
      `💰 Jumlah: Rp ${finalAmount.toLocaleString('id-ID')}\n` +
      `- Nominal Top Up: Rp ${amount.toLocaleString('id-ID')}\n` +
      `- Admin Fee : Rp ${adminFee}\n\n` +
      `⚠️ *Penting:* Mohon transfer sesuai nominal (sampai 3 angka terakhir)\n` +
      `⏱️ Waktu: 5 menit\n\n` +
      `⚠️ *Catatan:*\n` +
      `- Pembayaran akan otomatis terverifikasi\n` +
      `- Jika pembayaran berhasil, saldo akan otomatis ditambahkan`;

    // LANGKAH 3: Kirim QR ke User
    const qrMessage = await ctx.replyWithPhoto({ source: qrBuffer }, {
      caption: caption,
      parse_mode: 'Markdown'
    }); 

    // Hapus pesan input nominal
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    // LANGKAH 4: Simpan ke Memory & Database (PENTING AGAR SALDO BISA MASUK)
    global.pendingDeposits[uniqueCode] = {
      amount: finalAmount,
      originalAmount: amount,
      userId,
      timestamp: Date.now(),
      status: 'pending',
      qrMessageId: qrMessage.message_id
    };

    db.run(
      `INSERT INTO pending_deposits (unique_code, user_id, amount, original_amount, timestamp, status, qr_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uniqueCode, userId, finalAmount, amount, Date.now(), 'pending', qrMessage.message_id],
      (err) => {
        if (err) logger.error('Gagal database deposit:', err.message);
      }
    );

    delete global.depositState[userId];

  } catch (error) {
    logger.error('❌ Kesalahan saat memproses deposit:', error.message);
    await ctx.reply('❌ *GAGAL!* Terjadi kesalahan teknis saat membuat QRIS. Silakan coba lagi.', { parse_mode: 'Markdown' });
    
    // Bersihkan state jika gagal
    delete global.depositState[userId];
    delete global.pendingDeposits[uniqueCode];
  }
}

let isCheckingQRIS = false;
let lastHit = 0;

async function checkQRISStatus() {
  if (isCheckingQRIS) return; // ⛔ cegah double request

  isCheckingQRIS = true;

  try {
    const pendingEntries = Object.entries(global.pendingDeposits || {});
    if (pendingEntries.length === 0) {
      isCheckingQRIS = false;
      return;
    }

    // ⏱️ RATE LIMIT MANUAL (min 15 detik antar hit API)
    const now = Date.now();
    if (now - lastHit < 15000) {
      isCheckingQRIS = false;
      return;
    }
    lastHit = now;

    let history = [];

    try {
      const payload = buildPayload();
      const resultcek = await axios.post(API_URL, payload, {
        headers,
        timeout: 10000
      });

      // 🚨 HANDLE RATE LIMIT API
      if (resultcek.data?.message?.includes('terlalu sering')) {
        logger.warn('⛔ Kena rate limit QRIS, pause 5 menit...');
        isCheckingQRIS = false;

        setTimeout(() => {
          checkQRISStatus();
        }, 5 * 60 * 1000);

        return;
      }

      history = resultcek.data.qris_history?.results || [];

    } catch (apiErr) {
      const detail = apiErr.response
        ? JSON.stringify(apiErr.response.data)
        : apiErr.message;

      logger.error(`❌ Gagal koneksi API Orderkuota: ${detail}`);
      isCheckingQRIS = false;
      return;
    }

    // 🔄 Parse mutasi
    const transaksiList = history.map(t => ({
      kredit: Number(t.kredit ? t.kredit.toString().replace(/\./g, '') : 0),
      id: t.id,
      status: t.status
    }));

    // 🔁 Loop pending deposit
    for (const [uniqueCode, deposit] of pendingEntries) {
      if (deposit.status !== 'pending') continue;

      // ⏳ Expired 5 menit
      const depositAge = Date.now() - deposit.timestamp;
      if (depositAge > 5 * 60 * 1000) {
        try {
          if (deposit.qrMessageId) {
            await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId).catch(() => {});
          }

          await bot.telegram.sendMessage(
            deposit.userId,
            '❌ *Pembayaran Expired*\n\nSilakan buat QRIS baru.',
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}

        delete global.pendingDeposits[uniqueCode];

        db.run(
          `
          UPDATE pending_deposits
          SET status = 'expired'
          WHERE unique_code = ?
          `,
          [uniqueCode]
        );
        continue;
      }

      const expectedAmount = Number(deposit.amount);

      // 🔐 Anti double transaksi (pakai ID)
      const matched = transaksiList.find(t =>
        t.status === 'IN' &&
        t.kredit === expectedAmount &&
        (!deposit.usedTx || !deposit.usedTx.includes(t.id))
      );

      if (matched) {
        // 🚀 Proses pembayaran sekaligus hitung bonus jumat di dalam database transaction
        const success = await processMatchingPayment(deposit, matched, uniqueCode);

        if (success) {
          logger.info(`✅ Pembayaran Berhasil: ${uniqueCode} senilai ${expectedAmount}`);

          // tandai transaksi sudah dipakai
          if (!deposit.usedTx) deposit.usedTx = [];
          deposit.usedTx.push(matched.id);

          // 🗑️ BONUS JUMAT DI SINI SUDAH DIHAPUS & DIPINDAH KE processMatchingPayment 
          // Supaya perhitungan saldo baru di notifikasi sinkron dan anti-double.

          delete global.pendingDeposits[uniqueCode];
          db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
        }
      }
    }

  } catch (error) {
    logger.error('⚠️ Fatal Error di checkQRISStatus:', error);
  }

  isCheckingQRIS = false;
}

function keyboard_abc() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}
function keyboard_nomor_deposit() {
  const digits = '1234567890';
  const buttons = [];
  for (let i = 0; i < digits.length; i += 3) {
    const row = digits.slice(i, i + 3).split('').map(ch => ({
      text: ch,
      callback_data: 'dep_' + ch
    }));
    buttons.push(row);
  }
  buttons.push([
    { text: '🔙 Hapus', callback_data: 'dep_delete' },
    { text: '✅ Konfirmasi', callback_data: 'dep_confirm' }
  ]);
  buttons.push([
    { text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }
  ]);
  return buttons;
}
function keyboard_nomor() {
  const alphabet = '1234567890';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_full() {
  // Tambahkan titik (.) ke dalam deretan karakter
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789.'; 
  const buttons = [];
  
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  
  // Baris kontrol tambahan
  buttons.push([
    { text: '🔙 Hapus', callback_data: 'delete' }, 
    { text: '✅ Konfirmasi', callback_data: 'confirm' }
  ]);
  buttons.push([
    { text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }
  ]);
  
  return buttons;
}


global.processedTransactions = new Set();
async function updateUserBalance(userId, amount) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [amount, userId], function(err) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengupdate saldo user:', err.message);
          reject(err);
      } else {
        resolve();
        }
    });
  });
}

async function getUserBalance(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT saldo FROM users WHERE user_id = ?", [userId], function(err, row) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengambil saldo user:', err.message);
          reject(err);
      } else {
        resolve(row ? row.saldo : 0);
        }
    });
  });
}

async function sendPaymentSuccessNotification(userId, deposit, currentBalance) {
  try {
    // Hitung admin fee
    const adminFee = deposit.amount - deposit.originalAmount;
    await bot.telegram.sendMessage(userId,
      `✅ *Pembayaran Berhasil!*\n\n` +
      `💰 Jumlah Deposit: Rp ${deposit.originalAmount}\n` +
      `💸 Biaya Admin: Rp ${adminFee}\n` +
      `💰 Total Pembayaran: Rp ${deposit.amount}\n` +
      `💳 Saldo Sekarang: Rp ${currentBalance}`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (error) {
    logger.error('Error sending payment notification:', error);
    return false;
  }
}

async function processMatchingPayment(deposit, matchingTransaction, uniqueCode) {
  const refId =
    matchingTransaction.id
    ? `TRX${Math.floor(1000000000000 + Math.random() * 9000000000000)}`
    : uniqueCode;

  try {
    await dbRunAsync('BEGIN TRANSACTION');

    const existingTx = await new Promise((res) => {
      db.get(
        `SELECT id FROM transactions WHERE reference_id = ?`,
        [refId],
        (err, row) => res(row)
      );
    });

    if (existingTx) {
      await dbRunAsync('ROLLBACK');
      return false;
    }

    // ==================================================
    // 🌐 TOPUP WEBSITE
    // ==================================================
    if (deposit.type === 'web') {
      await dbRunAsync(
        `UPDATE web_users SET balance = balance + ? WHERE id = ?`,
        [deposit.originalAmount, deposit.userId]
      );
    } else {
      // ==================================================
      // 🤖 TOPUP TELEGRAM
      // ==================================================
      await dbRunAsync(
        `UPDATE users SET saldo = saldo + ? WHERE user_id = ?`,
        [deposit.originalAmount, deposit.userId]
      );

      // ✅ AUTO EXTEND RESELLER
      if (deposit.originalAmount >= 20000) {
        await dbRunAsync(
          `UPDATE users SET warned_h7 = 0, warned_h3 = 0, reseller_since = datetime('now') WHERE user_id = ? AND saldo >= 30000 AND role = 'reseller'`,
          [deposit.userId]
        ).catch(() => {});
      }

      // ==================================================
      // 🎁 BONUS JUMAT (DIPINDAH KE SINI AGAR MASUK TRANSAKSI)
      // ==================================================
      try {
        const BONUS_THRESHOLD = 5000;
        const BONUS_AMOUNT = 1000;
        const amt = Number(deposit.originalAmount || deposit.amount || 0);
        
        const nowJakarta = new Date(
          new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })
        );

        if (nowJakarta.getDay() === 5 && amt >= BONUS_THRESHOLD) {
          const today = `${nowJakarta.getFullYear()}-${String(nowJakarta.getMonth() + 1).padStart(2, '0')}-${String(nowJakarta.getDate()).padStart(2, '0')}`;

          // Cek klaim bonus hari ini secara synchronous/await dalam transaksi
          const alreadyClaimed = await new Promise((res) => {
            db.get(
              "SELECT id FROM weekly_bonus_claims WHERE user_id = ? AND claimed_date = ?",
              [String(deposit.userId), today],
              (err, row) => res(row)
            );
          });

          if (!alreadyClaimed) {
            // Tambahkan bonus langsung ke saldo
            await dbRunAsync(
              "UPDATE users SET saldo = saldo + ? WHERE user_id = ?",
              [BONUS_AMOUNT, deposit.userId]
            );

            // Log transaksi bonus
            await dbRunAsync(
              "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
              [deposit.userId, BONUS_AMOUNT, 'bonus', `friday-${Date.now()}`, Date.now()]
            );

            // Simpan klaim bonus
            await dbRunAsync(
              "INSERT INTO weekly_bonus_claims (user_id, amount, claimed_date, reference) VALUES (?, ?, ?, ?)",
              [String(deposit.userId), BONUS_AMOUNT, today, `ref-${Date.now()}`]
            );

            // Buat penanda untuk kirim notif bonus terpisah nanti
            deposit.gotBonusFriday = BONUS_AMOUNT;
          }
        }
      } catch (bonusErr) {
        logger.error('Error proses hitung Bonus Jumat:', bonusErr.message);
      }
    }

    // ==================================================
    // ✅ AMBIL DATA USER TERBARU (Sudah Termasuk Bonus Jika Ada)
    // ==================================================
    const userRow = await new Promise((res) => {
      if (deposit.type === 'web') {
        db.get(
          `SELECT username, email, balance FROM web_users WHERE id = ?`,
          [deposit.userId],
          (err, row) => res(row)
        );
      } else {
        db.get(
          `SELECT username, first_name, saldo FROM users WHERE user_id = ?`,
          [deposit.userId],
          (err, row) => res(row)
        );
      }
    });

    let usernameLog = 'Unknown User';
    if (deposit.type === 'web') {
      usernameLog = userRow?.email || userRow?.username || `WEB-${deposit.userId}`;
    } else {
      if (userRow?.username) {
        usernameLog = `@${userRow.username}`;
      } else if (userRow?.first_name) {
        usernameLog = userRow.first_name;
      } else {
        usernameLog = `TG-${deposit.userId}`;
      }
    }

    // ==================================================
    // ✅ SIMPAN TOPUP LOG & TRANSACTION LOG UTAMA
    // ==================================================
    await dbRunAsync(
      `INSERT INTO topup_log (user_id, username, amount, reference, metode, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [deposit.userId, usernameLog, deposit.originalAmount, refId, deposit.type === 'web' ? 'Website QRIS' : 'Orkut (QRIS)']
    );

    await dbRunAsync(
      `INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [deposit.userId, deposit.originalAmount, 'deposit', refId, Date.now()]
    );

    await dbRunAsync('COMMIT');

    // ==================================================
    // ✅ SALDO TERBARU (DIJAMIN SUDAH SINKRON)
    // ==================================================
    const currentBalance = deposit.type === 'web' ? (userRow?.balance || 0) : (userRow?.saldo || 0);

    // ==================================================
    // 🤖 NOTIF USER TELEGRAM ONLY
    // ==================================================
    if (deposit.type !== 'web') {
      sendPaymentSuccessNotification(deposit.userId, deposit, currentBalance).catch(() => {});
      
      // Kirim pesan bonus jumat jika berhak dapet
      if (deposit.gotBonusFriday) {
        setTimeout(() => {
          bot.telegram.sendMessage(
            deposit.userId,
            `🎉 *BONUS JUMAT BERKAH!*\nKamu mendapatkan tambahan saldo sebesar *Rp ${deposit.gotBonusFriday.toLocaleString('id-ID')}* karena melakukan top-up di hari Jumat.`,
            { parse_mode: 'Markdown' }
          ).catch((err) => {
            logger.error(`❌ Gagal notif bonus jumat ke ${deposit.userId}: ${err.message}`);
          });
        }, 1500); // delay dikit biar ga numpuk chatnya
      }
    }

    // ==================================================
    // 🗑 HAPUS QR MESSAGE
    // ==================================================
    if (deposit.qrMessageId && deposit.type !== 'web') {
      bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId).catch(() => {});
    }

    // ==================================================
    // 📢 NOTIF GROUP
    // ==================================================
    const rawName = userRow?.username || userRow?.first_name || userRow?.email || String(deposit.userId);
    const userMention = escapeHtml(maskUsername(rawName));
    const maskedId = maskUserId(String(deposit.userId));

    const timestamp = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date()).replace(',', '').replace(/\./g, ':');

    // 🌟 LOGIC VARIABEL BONUS KHUSUS NOTIF GROUP
    const bonusRowText = deposit.gotBonusFriday 
      ? `\n💰 <b>Bonus Saldo :</b> Rp ${deposit.gotBonusFriday.toLocaleString('id-ID')}` 
      : '';

    let groupMessage = '';
    if (deposit.type === 'web') {
      const maskedWebEmail = escapeHtml(maskEmail(userRow?.email || ''));
      groupMessage = `
━━━━━━━━━━━━━━━━━━━━━
<b>💳 TOP UP SALDO BERHASIL</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>💵 <b>Nominal  :</b> Rp ${deposit.originalAmount.toLocaleString('id-ID')}
🏧 <b>Metode   :</b> Website QRIS${bonusRowText}
💰 <b>Saldo Baru :</b> Rp ${currentBalance.toLocaleString('id-ID')}
📋 <b>Referensi :</b> <code>${refId}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━
📧 <b>User :</b> <code>${maskedWebEmail}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();
    } else {
      groupMessage = `
━━━━━━━━━━━━━━━━━━━━━
<b>💳 TOP UP SALDO BERHASIL</b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>💵 <b>Nominal :</b> Rp ${deposit.originalAmount.toLocaleString('id-ID')}
🏧 <b>Metode :</b> Telegram QRIS${bonusRowText}
💰 <b>Saldo Baru :</b> Rp ${currentBalance.toLocaleString('id-ID')}
📋 <b>Referensi :</b> <code>${refId}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━
👤 <b>User :</b> ${userMention}
🆔 <b>ID :</b> <code>${maskedId}</code>
🕒 <b>Waktu :</b> <code>${timestamp} WIB</code>`.trim();
    }

    if (GROUP_ID) {
      bot.telegram.sendMessage(GROUP_ID, groupMessage, { parse_mode: 'HTML' }).catch((e) => {
        logger.warn(`⚠️ Gagal kirim notif topup QRIS ke grup: ${e.message}`);
      });
    }

    return true;
  } catch (error) {
    logger.error('❌ Error processMatchingPayment:', error.message);
    try { await dbRunAsync('ROLLBACK'); } catch (rbErr) {}
    return false;
  }
}
/* 
setInterval(() => {
  if (Object.keys(global.pendingDeposits || {}).length > 0) {
    checkQRISStatus();
  }
}, 30000);
*/

async function recordAccountTransaction(userId, type) {
  return new Promise((resolve, reject) => {
    const referenceId = `account-${type}-${userId}-${Date.now()}`;
    db.run(
      'INSERT INTO transactions (user_id, type, reference_id, timestamp) VALUES (?, ?, ?, ?)',
      [userId, type, referenceId, Date.now()],
      (err) => {
        if (err) {
          logger.error('Error recording account transaction:', err.message);
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

//info server
async function resolveDomainToIP(domain) {
  try {
    const res = await dns.lookup(domain);
    return res.address;
  } catch (err) {
    logger.warn('⚠️ Gagal resolve domain:', err.message);
    return null;
  }
}

async function getISPAndLocation(ip) {
  try {
    const res = await fetch(`https://ipinfo.io/${ip}/json`);
    const data = await res.json();
    const isp = data.org || 'Tidak diketahui';
    const lokasi = data.city && data.country ? `${data.city}, ${data.country}` : 'Tidak diketahui';
    return { isp, lokasi };
  } catch (err) {
    logger.warn('⚠️ Gagal ambil ISP/Lokasi:', err.message);
    return { isp: 'Tidak diketahui', lokasi: 'Tidak diketahui' };
  }
}
// 💡 Fungsi validasi user harus reseller
async function onlyReseller(ctx) {
  const userId = ctx.from.id;
  return new Promise((resolve) => {
    db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err || !row || row.role !== 'reseller') {
        ctx.reply('⛔ *Panel ini hanya tersedia untuk reseller.*', { parse_mode: 'Markdown' });
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
function insertKomisi(ctx, type, username, totalHarga) {
  const komisi = Math.floor(totalHarga * 0.1);
  db.run(
    'INSERT INTO reseller_sales (reseller_id, buyer_id, akun_type, username, komisi) VALUES (?, ?, ?, ?, ?)',
    [ctx.from.id, ctx.from.id, type, username, komisi]
  );
}

// Validasi DB: coba buka file sebagai SQLite
function isValidSQLiteDB(path) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve(false);
      db.get("SELECT name FROM sqlite_master WHERE type='table'", (err2) => {
        db.close();
        resolve(!err2);
      });
    });
  });
}

function isValidSQLDump(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, sql) => {
      if (err) return resolve(false);
      const isSQL = sql.includes('CREATE TABLE') || sql.includes('INSERT INTO');
      resolve(isSQL);
    });
  });
}
// ─────────────────────────────────────────────────────────────
// Migrasi satu kali: isi reseller_since untuk reseller lama
// yang belum punya nilai karena upgrade sebelum patch ini.
// Dijalankan sekali saat startup, aman diulang (idempotent).
// ─────────────────────────────────────────────────────────────
async function migrasiResellerSince() {
  try {
    // Reseller yang sudah punya data di reseller_upgrade_log
    // → pakai tanggal upgrade terakhirnya
    await dbRunAsync(`
      UPDATE users
      SET reseller_since = (
        SELECT MAX(created_at)
        FROM reseller_upgrade_log
        WHERE reseller_upgrade_log.user_id = users.user_id
      )
      WHERE role = 'reseller'
        AND reseller_since IS NULL
        AND EXISTS (
          SELECT 1 FROM reseller_upgrade_log
          WHERE reseller_upgrade_log.user_id = users.user_id
        )
    `);

    // Reseller yang TIDAK punya data di reseller_upgrade_log
    // (di-promote manual oleh admin) → clock mulai dari sekarang
    await dbRunAsync(`
      UPDATE users
      SET reseller_since = datetime('now')
      WHERE role = 'reseller'
        AND reseller_since IS NULL
    `);

    const migrated = await dbGetAsync(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'reseller' AND reseller_since IS NOT NULL"
    );
    logger.info(`✅ [Migrasi] reseller_since terisi untuk ${migrated?.total || 0} reseller.`);
  } catch (err) {
    logger.error('❌ [Migrasi] Gagal migrasi reseller_since: ' + err.message);
  }
}
// =====================
// WEB API
// =====================
async function checkAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.json({ success: false, message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.json({ success: false, message: 'Token kosong' });
    }

    // 1. Verifikasi pakai JWT_SECRET (sesuai yang di-sign pas login)
    const decoded = jwt.verify(token, JWT_SECRET);

    // 2. Ambil data user pake helper dbGet yang sudah kamu punya
    const user = await dbGet("SELECT * FROM web_users WHERE id = ?", [decoded.id]);

    if (!user || user.role !== 'admin') {
      return res.json({ success: false, message: 'Akses ditolak' });
    }

    // Lolos, simpan data user ke request
    req.user = user;
    next();

  } catch (err) {
    console.error("Middleware Error:", err);
    return res.json({ success: false, message: 'Token invalid atau expired' });
  }
}
// ───────────────────────────────────────────────────────────────────────
// 🔒 MIDDLEWARE CHECKAUTH (UNTUK MEMPROTEKSI API WEB)
// ───────────────────────────────────────────────────────────────────────
function checkAuth(req, res, next) {
  try {
    // Ambil token dari header Authorization (Format: Bearer <token>)
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'Akses ditolak, token tidak ditemukan' });
    }

    // CATATAN: Sesuaikan 'JWT_SECRET' di bawah dengan secret key JWT bawaan script kamu (misal dari vars.JWT_SECRET)
    const jwtSecret = vars.JWT_SECRET || 'rahasia_store_kamu'; 

    const jwt = require('jsonwebtoken');
    jwt.verify(token, jwtSecret, (err, user) => {
      if (err) {
        return res.status(403).json({ success: false, message: 'Token tidak valid atau sudah kedaluwarsa' });
      }
      
      // Simpan data user ke req agar bisa dipakai di endpoint bawahnya jika butuh (misal untuk cek saldo)
      req.user = user; 
      next(); // Lanjut ke endpoint PPOB
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal Server Auth Error' });
  }
}
function dbGet(sql, params = []) {

    return new Promise((resolve, reject) => {

        db.get(sql, params, (err, row) => {

            if (err) reject(err);
            else resolve(row);

        });

    });

}

function dbRun(sql, params = []) {

    return new Promise((resolve, reject) => {

        db.run(sql, params, function(err) {

            if (err) reject(err);
            else resolve(this);

        });

    });

}
app.post('/api/google-login', async (req, res) => {
  try {
    const { credential } = req.body;

    // Verifikasi token Google
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: '480091956294-njvigllpnbqmh6p11nij99eavv101u3e.apps.googleusercontent.com'
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const username = payload.name;
    const avatar = payload.picture || '';
    
    // MENGHAPUS HARDCODED ADMIN EMAIL DI SINI
    // Variabel ADMIN_EMAIL langsung dibaca dari destructuring vars di paling atas script
    
    // Ambil waktu login sekarang dalam format ISO String
    const currentTimestamp = new Date().toISOString(); 

    const user = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM web_users WHERE google_id = ?`, [googleId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    // ================= USER SUDAH ADA =================
    if (user) {
      let currentRole = user.role;
      
      // VALIDASI GOOGLE LOGIN USER LAMA â”€â”€â”€
      if (email === ADMIN_EMAIL && user.role !== 'admin') {
        currentRole = 'admin';
      }

      // Update Role dan kolom last_login ke Database
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE web_users SET role = ?, last_login = ? WHERE id = ?`, 
          [currentRole, currentTimestamp, user.id], 
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Sinkronkan data objek user sebelum dikirim ke frontend
      user.role = currentRole;
      user.last_login = currentTimestamp; 

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({
        success: true,
        token,
        user
      });
    }

    // ================= USER BARU =================
    // FIX 5: VALIDASI GOOGLE LOGIN USER BARU
    const role = email === ADMIN_EMAIL ? 'admin' : 'user';

    db.run(
      `INSERT INTO web_users (google_id, username, email, avatar, role, last_login) VALUES (?,?,?,?,?,?)`,
      [googleId, username, email, avatar, role, currentTimestamp],
      function (err) {
        if (err) {
          console.error(err);
          return res.json({
            success: false,
            message: 'Gagal membuat akun'
          });
        }

        const newUser = {
          id: this.lastID,
          google_id: googleId,
          username,
          email,
          avatar,
          role,
          balance: 0,
          last_login: currentTimestamp
        };

        const token = jwt.sign(
          { id: newUser.id, email: newUser.email, role: newUser.role },
          JWT_SECRET,
          { expiresIn: '7d' }
        );

        return res.json({
          success: true,
          token,
          user: newUser
        });
      }
    );

  } catch (err) {
    console.error(err);
    return res.json({
      success: false,
      message: 'Google login gagal'
    });
  }
});

// Cegat akses langsung ke seluruh file HTML admin
app.get('/admin*.html', (req, res, next) => {
  return res.redirect('/dashboard.html');
});

// API Get Profile
app.get('/api/profile', checkAuth, async (req, res) => {
    try {
        const emailFromToken = req.user.email;

        const user = await dbGetAsync(`
            SELECT id, google_id, username, email, avatar, role, balance, created_at, last_login
            FROM web_users WHERE email = ?
        `, [emailFromToken]);

        if (!user) {
            return res.json({ success: false, message: 'User tidak ditemukan' });
        }

        // FIX 2: VALIDASI ADMIN DI PROFILE
        if (user.email === ADMIN_EMAIL) {
            user.role = 'admin';
        }

        // 1. HITUNG DARI TOPUP_LOG (Otomatis/Gerbang Pembayaran)
        const totalInLog = await dbGetAsync(`
            SELECT SUM(amount) as total 
            FROM topup_log 
            WHERE user_id = ?
        `, [user.id]);

        // 2. HITUNG DARI TOPUP_HISTORY (Penambahan Manual Admin berdasarkan Username)
        const totalInAdmin = await dbGetAsync(`
            SELECT SUM(amount) as total 
            FROM topup_history 
            WHERE username = ?
        `, [user.username]);

        // GABUNGKAN KEDUANYA UNTUK TOTAL IN YANG AKURAT
        const totalIn = Number(totalInLog?.total || 0) + Number(totalInAdmin?.total || 0);

        // TOTAL UANG KELUAR (TOTAL OUT)
        const totalVpn = await dbGetAsync(`SELECT SUM(price) as total FROM web_orders WHERE email = ?`, [user.email]);
        const totalPpob = await dbGetAsync(`SELECT SUM(price) as total FROM ppob_transactions WHERE web_user_id = ?`, [user.id]);

        const totalOut = Number(totalVpn?.total || 0) + Number(totalPpob?.total || 0);

        return res.json({
            success: true,
            user: {
                ...user,
                total_in: totalIn, // Sudah akurat gabungan log & manual admin
                total_out: totalOut
            }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/products', (req, res) => {

db.all(
    `
    SELECT
        id,
        nama_server,
        domain,
        harga,
        quota,
        iplimit,
        lokasi,
        protocol,
        total_create_akun,
        batas_create_akun
    FROM Server
    ORDER BY id ASC
    `,
    [],
    (err, rows) => {

        if(err){

            console.error(err);

            return res.json({
                success:false
            });

        }

        return res.json({
            success:true,
            products:rows
        });

    }
);

});

// ✅ 1. Tambahkan checkAuth sebelum async (req, res)
app.post('/api/create-account', checkAuth, async (req, res) => {

try {

// ==================================================
// 📦 BODY REQUEST
// ==================================================

const {
  server_id,
  username,
  password,
  protocol,
  duration
} = req.body;

// ==================================================
// 🔐 USER DARI JWT
// ==================================================

const authUserId =
req.user.id;

const authUserEmail =
req.user.email;

// ==================================================
// ✅ VALIDASI
// ==================================================

if (
  !server_id ||
  !username
) {

  return res.json({
    success: false,
    message: 'Data tidak lengkap'
  });

}

const selectedProtocol =
(protocol || 'SSH')
.toUpperCase();

if (
  selectedProtocol === 'SSH' &&
  !password
) {

  return res.json({
    success: false,
    message: 'Password wajib diisi untuk SSH'
  });

}

// ==================================================
// 👤 AMBIL USER
// ==================================================

const user =
await dbGetAsync(
  `
  SELECT *
  FROM web_users
  WHERE id = ?
  `,
  [authUserId]
);

if (!user) {

  return res.json({
    success: false,
    message: 'User tidak ditemukan'
  });

}

// ==================================================
// 🌐 AMBIL SERVER
// ==================================================

const server =
await dbGetAsync(
  `
  SELECT *
  FROM Server
  WHERE id = ?
  `,
  [server_id]
);

if (!server) {

  return res.json({
    success: false,
    message: 'Server tidak ditemukan'
  });

}

// ==================================================
// 💰 HITUNG HARGA
// ==================================================

const days =
Number(duration || 30);

const harga =
Number(server.harga || 0) * days;

if (user.balance < harga) {

  return res.json({
    success: false,
    message: 'Saldo tidak cukup'
  });

}

try {

  let result;

  const quota =
  Number(server.quota || 0) * days;

  // ==================================================
  // ⚡ CREATE ACCOUNT VPS
  // ==================================================

  if(selectedProtocol === 'SSH'){

    result =
    await createsshWeb(
      username,
      password,
      days,
      server.iplimit,
      server.id
    );

  } else if(selectedProtocol === 'VMESS'){

    result =
    await createvmessWeb(
      username,
      days,
      quota,
      server.iplimit,
      server.id
    );

  } else if(selectedProtocol === 'VLESS'){

    result =
    await createvlessWeb(
      username,
      days,
      quota,
      server.iplimit,
      server.id
    );

  } else if(selectedProtocol === 'TROJAN'){

    result =
    await createtrojanWeb(
      username,
      days,
      quota,
      server.iplimit,
      server.id
    );

  } else if(selectedProtocol === 'SHADOWSOCKS'){

    result =
    await createshadowsocksWeb(
      username,
      days,
      quota,
      server.iplimit,
      server.id
    );

  } else {

    return res.json({
      success:false,
      message:'Protocol tidak valid'
    });

  }

  // ==================================================
  // 💸 POTONG SALDO
  // ==================================================

  await dbRunAsync(
    `
    UPDATE web_users
    SET balance = balance - ?
    WHERE id = ?
    `,
    [
      harga,
      user.id
    ]
  );

  // ==================================================
  // 📅 EXPIRED DATE
  // ==================================================

  const expiredDate =
  new Date(
    Date.now() +
    days * 24 * 60 * 60 * 1000
  ).toISOString();

  // ==================================================
// 💾 SIMPAN WEB ORDER
// ==================================================

await dbRunAsync(
  `
  INSERT INTO web_orders
  (
    user_id,
    email,
    product_name,
    product_type,
    username,
    password,
    server_name,
    expired_at,
    result,
    price
  )
  VALUES(?,?,?,?,?,?,?,?,?,?)
  `,
  [
    user.id,
    authUserEmail,
    server.nama_server,
    selectedProtocol,
    username,
    password || '-',
    server.nama_server,
    expiredDate,

    typeof result === 'string'
    ? result
    : JSON.stringify(result),

    harga
  ]
);

  // ==================================================
  // ?? UPDATE STATS SERVER
  // ==================================================

  await dbRunAsync(
    `
    UPDATE Server
    SET total_create_akun =
    COALESCE(total_create_akun,0) + 1
    WHERE id = ?
    `,
    [server.id]
  );

  
  // ==================================================
  // 📢 NOTIF TELEGRAM
  // ==================================================

  try {

    const timestamp =
    new Date()
    .toLocaleString(
      'id-ID',
      {
        timeZone:'Asia/Jakarta'
      }
    );

    const maskedWebEmail =
    escapeHtml(
      maskEmail(
        authUserEmail || ''
      )
    );

    const groupMessage = `
━━━━━━━━━━━━━━━━━━━━━
<b>✅ ACCOUNT TRANSACTION </b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Server :</b> ${escapeHtml(server.nama_server)}
• <b>Protocol :</b> ${escapeHtml(selectedProtocol)}
• <b>Username :</b> <code>${escapeHtml(maskUsername(username))}</code>
• <b>Durasi :</b> ${days} Hari</blockquote>
━━━━━━━━━━━━━━━━━━━━━
<b>📧 User :</b> <code>${maskedWebEmail}</code>
<b>🕒 Waktu :</b> <code>${timestamp} WIB</code>
`.trim();

    if (GROUP_ID && bot) {

      await bot.telegram.sendMessage(
        GROUP_ID,
        groupMessage,
        {
          parse_mode:'HTML'
        }
      );

    }

  } catch(e){

    console.error(
      'NOTIF ERROR:',
      e.message
    );

  }

  // ==================================================
  // ✅ SUCCESS
  // ==================================================

  return res.json({
    success: true,
    html:
    typeof result === 'string'
    ? result
    : JSON.stringify(result)
  });

} catch (e) {

  console.error(e);

  return res.json({
    success: false,
    message:
    'Gagal membuat akun'
  });

}

} catch (err) {

console.error(err);

return res.json({
  success: false,
  message: err.message
});

}

});

// ✅ 1. Tambahkan middleware checkAuth sebelum async (req, res)
app.post('/api/create-trial', checkAuth, async (req, res) => {

try {

// ==================================================
// 📦 BODY REQUEST
// ==================================================

const {
  protocol,
  server_id
} = req.body;

// ==================================================
// 🔐 USER DARI JWT
// ==================================================

const authUserId =
req.user.id;

const authUserEmail =
req.user.email;

// ==================================================
// ✅ VALIDASI
// ==================================================

if (
  !protocol ||
  !server_id
) {

  return res.json({
    success: false,
    message: 'Data tidak lengkap'
  });

}

// ==================================================
// 👤 AMBIL USER
// ==================================================

const user =
await dbGetAsync(
  `
  SELECT *
  FROM web_users
  WHERE id = ?
  `,
  [authUserId]
);

if (!user) {

  return res.json({
    success: false,
    message: 'User tidak ditemukan'
  });

}

// ==================================================
// 📆 CEK TRIAL 24 JAM
// ==================================================

const cekTrial =
await dbGetAsync(
  `
  SELECT *
  FROM web_trials
  WHERE user_id = ?
  AND created_at >= datetime('now', '-1 day')
  `,
  [user.id]
);

// ==================================================
// 💰 CEK PERNAH TOPUP
// ==================================================

const pernahTopup =
await dbGetAsync(
  `
  SELECT *
  FROM topup_log
  WHERE user_id = ?
  LIMIT 1
  `,
  [user.id]
);

// ==================================================
// 📊 TOTAL TRIAL USER
// ==================================================

const totalTrial =
await dbGetAsync(
  `
  SELECT COUNT(*) as total
  FROM web_trials
  WHERE user_id = ?
  `,
  [user.id]
);

// ==================================================
// 🚫 RULE TRIAL
// ADMIN = UNLIMITED TRIAL
// ==================================================

const isAdmin =
(user.role || '').toLowerCase() === 'admin';

// Kalau bukan admin baru kena limit
if (!isAdmin) {

  if (cekTrial) {

    return res.json({
      success: false,
      message:
      'Trial hanya bisa 1x dalam 24 jam'
    });

  }

  if (
    totalTrial.total >= 1 &&
    !pernahTopup
  ) {

    return res.json({
      success: false,
      message:
      'Silakan topup terlebih dahulu untuk mendapatkan trial lagi'
    });

  }

}

// ==================================================
// 🌐 AMBIL SERVER
// ==================================================

const server =
await dbGetAsync(
  `
  SELECT *
  FROM Server
  WHERE id = ?
  `,
  [server_id]
);

if (!server) {

  return res.json({
    success: false,
    message:
    'Server tidak ditemukan'
  });

}

// ==================================================
// ⚡ CREATE TRIAL
// ==================================================

let result;

const proto =
protocol.toUpperCase();

if (proto === 'SSH') {

  result =
  await createsshTrialWeb(server);

} else if (proto === 'VMESS') {

  result =
  await createvmessTrialWeb(server);

} else if (proto === 'VLESS') {

  result =
  await createvlessTrialWeb(server);

} else if (proto === 'TROJAN') {

  result =
  await createtrojanTrialWeb(server);

} else if (proto === 'SHADOWSOCKS') {

  result =
  await createshadowsocksTrialWeb(server);

} else {

  return res.json({
    success: false,
    message:
    'Protocol tidak valid'
  });

}

// ==================================================
// 💾 SIMPAN RIWAYAT
// ==================================================

await dbRunAsync(
  `
  INSERT INTO web_trials
  (
    user_id,
    email,
    protocol,
    username
  )
  VALUES (?, ?, ?, ?)
  `,
  [
    user.id,
    authUserEmail,
    proto,
    result.username || '-'
  ]
);

// ==================================================
// 🛡️ HELPER
// ==================================================



// ==================================================
// 📢 NOTIF TELEGRAM
// ==================================================

try {

  const maskedEmail =
  escapeHtml(
    maskEmail(
      authUserEmail || ''
    )
  );

  const timestamp =
  new Date()
  .toLocaleString(
    'id-ID',
    {
      timeZone:
      'Asia/Jakarta'
    }
  );

  const groupMessage = `

━━━━━━━━━━━━━━━━━━━━━─
<b>🛄 TRIAL ACCOUNT CREATED </b>
━━━━━━━━━━━━━━━━━━━━━
<blockquote>• <b>Server :</b> ${escapeHtml(server.nama_server)}
• <b>Protocol :</b> ${escapeHtml(proto)}
• <b>Expired :</b> ${escapeHtml(result.expired || '-')}</blockquote>
━━━━━━━━━━━━━━━━━━━━━
<b>📧 User :</b><code>${maskedEmail}</code>
<b>🕒 Waktu :</b><code>${timestamp} WIB</code>
`.trim();


  if (GROUP_ID && bot) {

    await bot.telegram.sendMessage(
      GROUP_ID,
      groupMessage,
      {
        parse_mode: 'HTML'
      }
    );

  }

} catch (e) {

  console.error(
    'TRIAL NOTIF ERROR:',
    e.message
  );

}

// ==================================================
// ✅ SUCCESS
// ==================================================

return res.json({
  success: true,
  html: result.message
});

} catch (err) {

console.error(err);

return res.json({
  success: false,
  message:
  'Gagal membuat trial'
});

}

});

app.get('/api/admin/stats', checkAdmin, async (req, res) => {
    try {

        const [
            users,
            topupCount,
            vpnCount,
            ppobCount,
            balance
        ] = await Promise.all([

            // TOTAL USER
            dbGetAsync(`
                SELECT COUNT(*) as total
                FROM web_users
            `),

            // TOTAL TOPUP
            dbGetAsync(`
                SELECT COUNT(*) as total
                FROM topup_history
            `),

            // TOTAL TRANSAKSI VPN
            dbGetAsync(`
                SELECT COUNT(*) as total
                FROM web_orders
            `),

            // TOTAL TRANSAKSI PPOB
            dbGetAsync(`
                SELECT COUNT(*) as total
                FROM ppob_transactions
            `),

            // TOTAL SALDO USER
            dbGetAsync(`
                SELECT SUM(balance) as total
                FROM web_users
            `)

        ]);

        // GABUNG SEMUA TRANSAKSI
        const totalTransactions =
            Number(topupCount?.total || 0) +
            Number(vpnCount?.total || 0) +
            Number(ppobCount?.total || 0);

        return res.json({
            success: true,
            stats: {

                users:
                    Number(users?.total || 0),

                transactions:
                    totalTransactions,
                    
                ppob: 
                    Number(ppobCount?.total || 0),

                balance:
                    Number(balance?.total || 0)

            }
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan pada server.'
        });

    }
});

app.get(
    '/api/admin/users',
    checkAdmin,
    (req, res) => {
        db.all(
            `
            SELECT 
                id, 
                username, 
                email, 
                balance, 
                role, 
                /* Memaksa string tanggal dari SQLite berakhiran Z (UTC) */
                strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at
            FROM web_users
            ORDER BY id DESC
            `,
            [],
            (err, rows) => {
                if (err) {
                    return res.json({
                        success: false,
                        message: 'Database error'
                    });
                }

                return res.json({
                    success: true,
                    users: rows
                });
            }
        );
    }
);

app.post(
'/api/admin/add-balance',
checkAdmin,
async (req, res) => {

try {

    const {
        user_id,
        amount
    } = req.body;

    // VALIDASI
    if (
        !user_id ||
        !amount
    ) {

        return res.json({
            success:false,
            message:'Data tidak lengkap'
        });

    }

    // AMBIL USER
    const user = await dbGetAsync(`
        SELECT *
        FROM web_users
        WHERE id = ?
    `,[user_id]);

    if(!user){

        return res.json({
            success:false,
            message:'User tidak ditemukan'
        });

    }

    // TAMBAH SALDO
    await dbRunAsync(`
        UPDATE web_users
        SET balance = balance + ?
        WHERE id = ?
    `,[
        amount,
        user_id
    ]);

    // SIMPAN RIWAYAT TOPUP
    await dbRunAsync(`
        INSERT INTO topup_history
        (
            username,
            amount,
            created_at
        )
        VALUES(?,?,datetime('now'))
    `,[
        user.username,
        amount
    ]);

    return res.json({
        success:true,
        message:'Saldo berhasil ditambah'
    });

} catch(err){

    console.error(err);

    return res.json({
        success:false,
        message:'Server error'
    });

}

});

app.post(
'/api/admin/reduce-balance',
checkAdmin,
(req,res)=>{

const {
    user_id,
    amount
} = req.body;

db.run(
    `
    UPDATE web_users
    SET balance =
    balance - ?
    WHERE id = ?
    `,
    [
        amount,
        user_id
    ],
    function(err){

        if(err){

            return res.json({
                success:false,
                message:'Gagal mengurangi saldo'
            });

        }

        return res.json({
            success:true,
            message:'Saldo berhasil dikurangi'
        });

    }
);

});

app.get('/api/server/:id', (req,res)=>{

    db.get(
        `
        SELECT *
        FROM Server
        WHERE id=?
        `,
        [req.params.id],
        (err,row)=>{

            if(err || !row){

                return res.json({
                    success:false
                });

            }

            return res.json({
                success:true,
                server:row
            });

        }
    );

});
app.get(
'/api/admin/transactions',
checkAdmin,
(req,res)=>{

db.all(
    `
    SELECT *
    FROM web_orders
    ORDER BY id DESC
    `,
    [],
    (err,rows)=>{

        if(err){

            return res.json({
                success:false,
                message:'Database error'
            });

        }

        return res.json({
            success:true,
            transactions:rows
        });

    }
);

});
// ✅ 1. Tambahkan middleware checkAuth sebelum (req, res)
app.get('/api/my-vpn', checkAuth, (req, res) => {
    
    // ✅ 2. AMAN: Ambil ID user langsung dari token JWT hasil verifikasi login
    const authUserId = req.user.id;

    // Ambil data user dari database berdasarkan ID dari token JWT
    db.get(
        `SELECT * FROM web_users WHERE id = ?`,
        [authUserId],
        (err, user) => {

            if (err || !user) {
                return res.json({
                    success: false,
                    message: 'User tidak ditemukan atau sesi telah berakhir'
                });
            }

            // ✅ 3. Ambil data order murni milik user yang sedang login
            db.all(
                `SELECT * FROM web_orders WHERE user_id = ? ORDER BY id DESC`,
                [user.id],
                (err, rows) => {

                    if (err) {
                        return res.json({
                            success: false,
                            message: 'Database error'
                        });
                    }

                    // Kembalikan data akun hanya yang menjadi hak milik user ini
                    return res.json({
                        success: true,
                        accounts: rows
                    });
                }
            );
        }
    );
});

// Pakasir
app.post('/api/create-topup', checkAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    let { amount } = req.body;

    // 1. Keamanan Data: Konversi dan pastikan amount adalah angka bulat (Integer)
    amount = parseInt(amount, 10);

    // 2. Validasi Keamanan: Pastikan input adalah nomor valid dan minimal Rp 1.000
    if (isNaN(amount) || amount < 1000) {
      return res.json({
        success: false,
        message: 'Nominal tidak valid, minimal Rp 1.000'
      });
    }

    // 3. Keamanan ID: Tambahkan string random di akhir orderId 
    // Mencegah duplikasi (Race Condition) jika user melakukan spam klik di milidetik yang sama
    const randomString = Math.random().toString(36).substring(2, 7).toUpperCase();
    const orderId = `WEB-${userId}-${Date.now()}-${randomString}`;

    const redirectUrl = encodeURIComponent(
      'https://app.isdarprem.net/topup-success'
    );

    const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_PROJECT_SLUG)}/${encodeURIComponent(amount)}?order_id=${encodeURIComponent(orderId)}&redirect=${redirectUrl}&qris_only=1`;

    const expiredAt = new Date(
      Date.now() + 60 * 60 * 1000 // 1 Jam Expired
    ).toISOString();

    await dbRunAsync(
      `
      INSERT INTO pending_deposits_pakasir
      (
        user_id,
        order_id,
        amount,
        status,
        payment_method,
        payment_data,
        expired_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        userId,
        orderId,
        amount,
        'pending',
        'qris',
        paymentUrl,
        expiredAt
      ]
    );

    return res.json({
      success: true,
      order_id: orderId,
      payment_url: paymentUrl
    });

  } catch (err) {
    console.error('Error on create-topup:', err);
    return res.json({
      success: false,
      message: 'Terjadi kesalahan pada server'
    });
  }
});

// ==================================================
// 1. ENDPOINT CREATE DEPOSIT (DENGAN ANTI-SPAM & MIN DEPOSIT LANGSUNG)
// ==================================================
app.post('/api/deposit', checkAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const authUserId = req.user.id; // Diambil dari JWT middleware

    if (!amount) {
      return res.json({
        success: false,
        message: 'Data tidak lengkap'
      });
    }

    // Membersihkan input amount dari karakter non-angka
    const cleanAmount = String(amount).replace(/[^0-9]/g, '');
    const nominal = Number(cleanAmount);

    // 🎯 LANGSUNG DISINI: Atur minimal deposit langsung berupa angka murni (contoh: 100 atau 10000)
    const minDeposit = 100; 
    if (isNaN(nominal) || nominal < minDeposit) {
      return res.json({
        success: false,
        message: `Minimal topup Rp ${minDeposit.toLocaleString('id-ID')}`
      });
    }

    // Ambil data user dari tabel web_users
    const user = await dbGetAsync(
      'SELECT * FROM web_users WHERE id = ?',
      [authUserId]
    );

    if (!user) {
      return res.json({
        success: false,
        message: 'User tidak ditemukan atau sesi tidak valid'
      });
    }

    // 🛡️ ANTI-SPAM: Cek apakah user ini punya transaksi yang masih berstatus 'pending' di database
    const existingPending = await dbGetAsync(
      "SELECT unique_code FROM pending_deposits WHERE user_id = ? AND status = 'pending' LIMIT 1",
      [user.id]
    );

    if (existingPending) {
      return res.json({
        success: false,
        message: 'Anda masih memiliki transaksi QRIS aktif'
      });
    }

    // Logika pembuatan kode unik transaksi deposit
    const uniqueCode = `web-${user.id}-${Date.now()}`;
    
    // Fungsi pembantu generate angka acak/unik (contoh: 1 s/d 300)
    const generateRandomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const randomFee = generateRandomNumber(1, 300);
    
    const finalAmount = nominal + randomFee;
    const adminFee = finalAmount - nominal;

    // Pastikan variabel DATA_QRIS sudah didefinisikan secara global dari .vars.json
    const qrUrl = `https://avi.isdarprem.net/api/generate-qris?amount=${finalAmount}&codeqr=${encodeURIComponent(DATA_QRIS || '')}`;

    // Simpan data deposit di memory global pending state
    global.pendingDeposits[uniqueCode] = {
      amount: finalAmount,
      originalAmount: nominal,
      userId: user.id,
      username: user.username || 'Unknown User',
      email: user.email || '-',
      timestamp: Date.now(),
      status: 'pending',
      qrMessageId: null,
      type: 'web'
    };

    // Simpan rekaman invoice ke dalam database pending_deposits
    await dbRunAsync(
      `INSERT INTO pending_deposits
      (unique_code, user_id, amount, original_amount, timestamp, status)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [uniqueCode, user.id, finalAmount, nominal, Date.now(), 'pending']
    );

    return res.json({
      success: true,
      amount: finalAmount,
      originalAmount: nominal,
      adminFee,
      uniqueCode,
      qrUrl
    });

  } catch (err) {
    logger.error('Error Create Deposit Web API: ' + err.message);
    return res.json({
      success: false,
      message: 'Gagal membuat QRIS'
    });
  }
});
// ==================================================
// 2. ENDPOINT CHECK STATUS DEPOSIT (VERSI AMAN)
// ==================================================
app.get('/api/deposit-status/:code', checkAuth, async (req, res) => {
  try {
    const authUserId = req.user.id;

    const deposit = await dbGetAsync(
      `SELECT * FROM pending_deposits WHERE unique_code = ?`,
      [req.params.code]
    );

    // Perbaikan Keamanan: Jika tidak ditemukan, jangan langsung dibilang 'paid'
    if (!deposit) {
      return res.json({
        success: true,
        status: 'expired', // Atau 'not_found', memaksa frontend menampilkan QRIS habis/tidak valid
        message: 'Invoice tidak ditemukan atau sudah kedaluwarsa'
      });
    }

    // 🔒 PROTEKSI KRITIS: Validasi kecocokan ID pemilik invoice
    if (Number(deposit.user_id) !== Number(authUserId)) {
      return res.status(403).json({
        success: false,
        message: 'Akses ditolak! Ini bukan invoice deposit kamu.'
      });
    }

    return res.json({
      success: true,
      status: deposit.status // Pastikan di DB menyimpan string seperti 'pending', 'paid', atau 'expired'
    });

  } catch (err) {
    logger.error('Error Check Status Deposit Web API: ' + err.message);
    return res.json({
      success: false,
      message: 'Gagal memuat status deposit'
    });
  }
});

app.get('/api/topup-history', checkAuth, async (req, res) => {
  try {
    // ✅ AMAN: Ambil ID user langsung dari token JWT hasil verifikasi login
    const authUserId = req.user.id;

    // Ambil data user dari database berdasarkan ID dari token JWT
    const user = await dbGetAsync(
      `SELECT * FROM web_users WHERE id = ?`,
      [authUserId]
    );

    if (!user) {
      return res.json({
        success: false,
        message: 'User tidak ditemukan atau sesi telah berakhir'
      });
    }

    // ✅ Ambil riwayat topup murni milik user yang sedang login
    db.all(
      `
      SELECT
        amount,
        metode,
        reference,
        created_at
      FROM topup_log
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
      `,
      [user.id],
      (err, rows) => {
        if (err) {
          console.error(err);
          return res.json({
            success: false,
            message: 'Database error'
          });
        }

        return res.json({
          success: true,
          data: rows || []
        });
      }
    );

  } catch (err) {
    console.error(err);
    return res.json({
      success: false,
      message: 'Server error'
    });
  }
});

app.get('/api/admin/topup-history', checkAdmin, async (req, res) => {
  try {
    // Tarik data secara eksplisit dengan mengurutkan dari ID paling besar (terbaru)
    db.all(
      `SELECT id, user_id, username, amount, reference, metode, created_at FROM topup_log ORDER BY id DESC`,
      [],
      (err, rows) => {
        if (err) {
          console.error('Database Error:', err.message);
          return res.json({
            success: false,
            message: 'Database error: ' + err.message
          });
        }

        // Return data murni ke frontend
        return res.json({
          success: true,
          data: rows
        });
      }
    );

  } catch (e) {
    console.error('Server Error:', e.message);
    return res.json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// 📂 FIX ENDPOINT PPOB WEBSITE AGAR AKUR DENGAN TELEGRAM
// ───────────────────────────────────────────────────────────────────────

// Helper pencari key sub-kategori (sama dengan Telegram)
function getBrandKeyWeb(brand) {
  if (!brand) return null;
  const lowerBrand = brand.trim().toLowerCase();
  return Object.keys(BRAND_SUB_CATEGORIES).find(
    k => k.toLowerCase() === lowerBrand
  ) || null;
}

// Helper penentu sub-kategori dari product_name (sama dengan Telegram)
function getSubCategoryWeb(productName, brand) {
  const brandKey = getBrandKeyWeb(brand);
  if (!brandKey) return 'Reguler';
  
  const subCategories = BRAND_SUB_CATEGORIES[brandKey];
  const nameLower = productName.toLowerCase();
  
  for (const sub of subCategories) {
    if (nameLower.includes(sub.toLowerCase())) {
      return sub;
    }
  }
  return 'Reguler';
}

// 1. GET /api/ppob/categories -> Mengambil kategori utama
app.get('/api/ppob/categories', checkAuth, async (req, res) => {
  try {
    const result = await getDigiProducts();
    if (result.status !== 'success') {
      return res.json({ success: false, message: result.message || 'Gagal mengambil produk' });
    }
    // Ambil kategori unik yang produknya aktif
    const categories = [...new Set(result.data
      .filter(p => p.buyer_product_status === true)
      .map(p => p.category)
    )].sort();
    
    return res.json({ success: true, categories });
  } catch (err) {
    logger.error('GET /api/ppob/categories error: ' + err.message);
    return res.json({ success: false, message: 'Server error' });
  }
});

// 2. GET /api/ppob/brands?category=xxx
app.get('/api/ppob/brands', checkAuth, async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) return res.json({ success: false, message: 'Kategori wajib diisi' });

    const result = await getDigiProducts();
    if (result.status !== 'success') {
      return res.json({ success: false, message: result.message || 'Gagal mengambil produk' });
    }

    const filtered = result.data.filter(p => 
      p.category.trim() === category.trim() && p.buyer_product_status === true
    );

    const brands = [...new Set(filtered.map(p => p.brand))].sort();

    const brandList = brands.map(b => {
      const brandKey = getBrandKeyWeb(b);
      const hasSub = brandKey && BRAND_SUB_CATEGORIES[brandKey] && BRAND_SUB_CATEGORIES[brandKey].length > 0;
      
      // DI SINI YANG FIX NYA BRO: Diubah jadi hasSubCategory (tanpa tanda strip/minus)
      return { brand: b, hasSubCategory: !!hasSub }; 
    });

    return res.json({ success: true, brands: brandList });
  } catch (err) {
    logger.error('GET /api/ppob/brands error: ' + err.message);
    return res.json({ success: false, message: 'Server error' });
  }
});

// 3. GET /api/ppob/subcategories?category=xxx&brand=yyy -> Ambil list sub-kategori ber-isi produk
app.get('/api/ppob/subcategories', checkAuth, async (req, res) => {
  try {
    const { category, brand } = req.query;
    if (!category || !brand) return res.json({ success: false, message: 'Kategori dan Brand wajib diisi' });

    const result = await getDigiProducts();
    if (result.status !== 'success') return res.json({ success: false, message: result.message });

    const filtered = result.data.filter(p => 
      p.category.trim() === category.trim() && 
      p.brand.trim() === brand.trim() && 
      p.buyer_product_status === true
    );

    // Dapatkan list sub-kategori yang benar-benar memiliki isi item di dalamnya
    const subs = [...new Set(filtered.map(p => getSubCategoryWeb(p.product_name, brand)))].sort();

    return res.json({ success: true, subcategories: subs });
  } catch (err) {
    return res.json({ success: false, message: 'Server error' });
  }
});

// 4. GET /api/ppob/products?category=xxx&brand=yyy&subcategory=zzz -> List produk akurat dengan harga markup
app.get('/api/ppob/products', checkAuth, async (req, res) => {
  try {
    const { category, brand, subcategory } = req.query;
    if (!category || !brand) return res.json({ success: false, message: 'Kategori & Brand wajib diisi' });

    const result = await getDigiProducts();
    if (result.status !== 'success') return res.json({ success: false, message: result.message });

    let products = result.data.filter(p => 
      p.category.trim() === category.trim() && 
      p.brand.trim() === brand.trim() && 
      p.buyer_product_status === true
    );

    // Saring berdasarkan sub-kategori jika dikirim dari frontend
    if (subcategory) {
      products = products.filter(p => getSubCategoryWeb(p.product_name, brand) === subcategory);
    }

    // Urutkan berdasarkan harga jual termurah & mapping properties
    const mapped = products.map(p => {
      // Gunakan fungsi hitungHargaJual bawaan bot kamu agar margin keuntungan sinkron!
      const hargaJual = hitungHargaJual(p.price); 
      return {
        sku: p.buyer_sku_code,
        name: p.product_name,
        category: p.category,
        brand: p.brand,
        originalPrice: p.price,
        price: hargaJual, // Harga yang dipublish ke web user
        desc: p.desc || 'Tidak ada deskripsi.',
        status: p.seller_product_status
      };
    }).sort((a, b) => a.price - b.price);

    return res.json({ success: true, products: mapped });
  } catch (err) {
    logger.error('GET /api/ppob/products error: ' + err.message);
    return res.json({ success: false, message: 'Server error' });
  }
});
app.post('/api/ppob/buy', checkAuth, async (req, res) => {

  try {

    const {
      sku,
      target,
      product_name,
      price
    } = req.body;

    const userId = req.user.id;
    const email  = req.user.email;

    // =========================
    // VALIDASI
    // =========================

    if (!sku || !target || !price) {

      return res.json({
        success: false,
        message: 'Data tidak lengkap'
      });

    }

    // =========================
    // AMBIL USER
    // =========================

    const user = await dbGetAsync(
      `
      SELECT *
      FROM web_users
      WHERE id = ?
      `,
      [userId]
    );

    if (!user) {

      return res.json({
        success: false,
        message: 'User tidak ditemukan'
      });

    }

    // =========================
    // CEK SALDO
    // =========================

    if (Number(user.balance) < Number(price)) {

      return res.json({
        success: false,
        message: 'Saldo tidak cukup'
      });

    }

    // =========================
    // REF ID
    // =========================

    const refId =
      'PPOB' +
      Date.now();

    // =========================
    // POTONG SALDO
    // =========================

    await dbRunAsync(
      `
      UPDATE web_users
      SET balance = balance - ?
      WHERE id = ?
      `,
      [
        price,
        userId
      ]
    );

    // =========================
    // SIGN DIGIFLAZZ
    // =========================

    const sign =
      crypto
      .createHash('md5')
      .update(
        DIGIFLAZZ_USERNAME +
        DIGIFLAZZ_API_KEY +
        refId
      )
      .digest('hex');

    // =========================
    // HIT DIGIFLAZZ
    // =========================

    const digiBase =
      (DIGIFLAZZ_BASE_URL || '')
      .replace(/\/$/, '');

    const digiRes =
      await axios.post(
        `${digiBase}/transaction`,
        {
          username: DIGIFLAZZ_USERNAME,
          buyer_sku_code: sku,
          customer_no: target,
          ref_id: refId,
          sign: sign
        },
        {
          timeout: 15000
        }
      );

    const digiData = digiRes.data?.data || digiRes.data;

    // =========================
    // STATUS AWAL
    // =========================

    let trxStatus = 'PENDING';

    if (
      digiData?.status
    ) {

      trxStatus =
        String(digiData.status)
        .toUpperCase();

    }

    // =========================
    // SIMPAN DB
    // =========================

    await dbRunAsync(
      `
      INSERT INTO ppob_transactions
      (
        web_user_id,
        sku,
        target,
        price,
        status,
        ref_id,
        source,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      [
        userId,
        product_name,
        target,
        price,
        trxStatus,
        refId,
        'web'
      ]
    );

    // =========================
    // RESPONSE
    // =========================

    return res.json({
      success: true,
      message: 'Transaksi berhasil dibuat',
      data: digiData
    });

  } catch (err) {

    console.error(
      'PPOB BUY ERROR:',
      err.message
    );

    // =========================
    // REFUND JIKA GAGAL HIT API
    // =========================

    try {

      const {
        price
      } = req.body;

      const userId =
        req.user.id;

      if (price && userId) {

        await dbRunAsync(
          `
          UPDATE web_users
          SET balance = balance + ?
          WHERE id = ?
          `,
          [
            price,
            userId
          ]
        );

      }

    } catch(refundErr) {

      console.error(
        'REFUND ERROR:',
        refundErr.message
      );

    }

    return res.json({
      success: false,
      message: 'Server error / gagal hit provider'
    });

  }

});
// ───────────────────────────────────────────────────────────────────────
// 📜 GET /api/ppob/history
// Mengambil riwayat transaksi PPOB milik user yang sedang login di web
// ───────────────────────────────────────────────────────────────────────
app.get('/api/ppob/history', checkAuth, async (req, res) => {
  const user = req.user; // Diambil dari middleware checkAuth
  
  try {
    // Ambil semua transaksi PPOB khusus dari source web untuk user ini
    db.all(
      `SELECT sku, target, price, status, sn, ref_id, created_at 
       FROM ppob_transactions 
       WHERE web_user_id = ? AND source = 'web' 
       ORDER BY id DESC`,
      [user.id],
      (err, rows) => {
        if (err) {
          logger.error('Database Error pada riwayat PPOB: ' + err.message);
          return res.json({ success: false, message: 'Database error' });
        }
        
        return res.json({ 
          success: true, 
          transactions: rows || [] 
        });
      }
    );
  } catch (err) {
    logger.error('GET /api/ppob/history error: ' + err.message);
    return res.json({ success: false, message: 'Server error' });
  }
});
// ───────────────────────────────────────────────────────────────────────
// 🔐 GET /api/admin/ppob-history
// Mengambil semua riwayat transaksi PPOB dari seluruh user (Admin Only)
// ───────────────────────────────────────────────────────────────────────
app.get('/api/admin/ppob-history', checkAdmin, async (req, res) => {
  try {
    // Tarik seluruh transaksi PPOB, gabungkan dengan data web_users jika transaksi dari web
    db.all(
      `SELECT 
        p.id, 
        p.user_id, 
        p.web_user_id,
        p.sku, 
        p.target, 
        p.price, 
        p.status, 
        p.sn, 
        p.ref_id, 
        p.source, 
        p.created_at,
        w.email AS web_user_email
       FROM ppob_transactions p
       LEFT JOIN web_users w ON p.web_user_id = w.id
       ORDER BY p.id DESC`,
      [],
      (err, rows) => {
        if (err) {
          console.error('Database Error pada admin riwayat PPOB:', err.message);
          return res.json({ success: false, message: 'Database error: ' + err.message });
        }
        
        return res.json({ 
          success: true, 
          transactions: rows || [] 
        });
      }
    );
  } catch (err) {
    console.error('GET /api/admin/ppob-history error:', err.message);
    return res.json({ success: false, message: 'Server error' });
  }
});


// ✅ Global error handler — cegah bot crash karena unhandled error di handler manapun
bot.catch((err, ctx) => {
  const update = ctx?.update?.callback_query?.data || ctx?.update?.message?.text || 'unknown';
  logger.error(`❌ Unhandled bot error [${update}]: ${err.message || err}`);
});

app.listen(PORT, () => {
  logger.info(`🚀 Server berjalan di port ${PORT}`);

  // Jalankan migrasi reseller_since untuk data lama
  // Delay 3 detik agar safeAlter selesai menambah kolom di SQLite sebelum migrasi jalan
  setTimeout(() => migrasiResellerSince(), 3000);

  const startBot = async (retry = 0) => {
    try {
      await bot.launch();
      logger.info('🤖 Bot Telegram aktif!');
    } catch (err) {
      const MAX_RETRY = 5;
      const delay = Math.min(10000 * (retry + 1), 60000); // max 1 menit

      logger.error(`❌ Error saat memulai bot: ${err.message}`);

      const isRetryable =
        ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code) ||
        (err.response && err.response.status >= 500) ||
        /timed out|timeout|TIMEOUT/i.test(err.message);

      if (isRetryable) {
        if (retry < MAX_RETRY) {
          logger.warn(`🔁 Coba reconnect (${retry + 1}/${MAX_RETRY}) dalam ${delay / 1000}s...`);
          setTimeout(() => startBot(retry + 1), delay);
        } else {
          logger.error('🚫 Gagal konek ke Telegram setelah beberapa percobaan. Periksa koneksi VPS.');
          setTimeout(() => startBot(0), 60000); // reset counter, coba lagi 1 menit
        }
      } else {
        logger.error('🚨 Error tidak dikenali saat start bot, coba ulang dalam 30s...');
        setTimeout(() => startBot(0), 30000);
      }
    }
  };

  // 🚀 Mulai bot dengan reconnect logic
  startBot();
});