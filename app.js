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
const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');
const fetch = require('node-fetch');

// 📁 Direktori
const TELEGRAM_UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';
const BACKUP_DIR = '/root/BotVPN2/backups';
const DB_PATH = path.resolve('./sellvpn.db');
const UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';

if (!fs.existsSync(TELEGRAM_UPLOAD_DIR)) fs.mkdirSync(TELEGRAM_UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 🛠️ Load Config
const vars = JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));
const {
  BOT_TOKEN,
  USER_ID,
  GROUP_ID,
  PORT = 50123,
  NAMA_STORE = 'GabutStore',
  DATA_QRIS,
  MERCHANT_ID,
  API_KEY,
  PAKASIR_API_KEY,
  PAKASIR_PROJECT_SLUG,
  PAKASIR_WEBHOOK_URL
} = vars;

const MIN_DEPOSIT_AMOUNT = Number(vars.MIN_DEPOSIT_AMOUNT) || 2000;

// 📦 Tools & Libraries
const { promisify } = require('util');
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
});

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

// Jalankan migrasi setelah event 'open' DB (pastikan serialize sudah selesai)
db.on('open', () => {
  // Migrasi: update reference_id yang masih NULL
  db.all(
    "SELECT id, user_id, type, timestamp FROM transactions WHERE reference_id IS NULL",
    [],
    (err, rows) => {
      if (err || !rows || !rows.length) return;
      rows.forEach((row) => {
        const referenceId = `account-${row.type}-${row.user_id}-${row.timestamp}`;
        db.run("UPDATE transactions SET reference_id = ? WHERE id = ?", [referenceId, row.id], (e) => {
          if (e) logger.error(`Gagal update reference_id tx ${row.id}: ${e.message}`);
        });
      });
      logger.info(`🔄 Migrasi reference_id: ${rows.length} baris diperbarui.`);
    }
  );
});

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
    const adminChatId = vars?.USER_ID;
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

// Reset komisi reseller tiap tanggal 1 di bulan ganjil (2 bulanan)
cron.schedule('1 0 1 * *', async () => {
  try {
    const month = new Date().getMonth() + 1;
    if (month % 2 !== 1) {
      logger.info(`ℹ️ Reset komisi dilewati (bulan ${month} = genap).`);
      return;
    }

    logger.info('🧹 Memulai arsip & reset komisi reseller (2 bulanan)...');

    const rows = await dbAllAsync('SELECT * FROM reseller_sales');

    if (rows && rows.length > 0) {
      for (const r of rows) {
        await dbRunAsync(
          `INSERT INTO reseller_sales_archive
           (reseller_id, buyer_id, akun_type, username, komisi, created_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          [r.reseller_id, r.buyer_id, r.akun_type, r.username, r.komisi, r.created_at]
        );
      }
      logger.info(`📦 Diarsipkan: ${rows.length} baris.`);
    }

    await dbRunAsync('DELETE FROM reseller_sales');
    await dbRunAsync("UPDATE users SET reseller_level = 'silver' WHERE role = 'reseller'");
    logger.info('✅ Reset komisi & level silver selesai.');

    if (GROUP_ID) {
      const text =
        `🧹 *Reset Komisi 2 Bulanan Selesai*\n\n` +
        `• Jumlah arsip: *${rows?.length || 0}* data\n` +
        `• Semua reseller kembali ke level *SILVER*.`;
      await bot.telegram.sendMessage(GROUP_ID, text, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (err) {
    logger.error('❌ Gagal job reset komisi: ' + err.message);
  }
});

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

// ===========================
// 🔑 State Management
// ===========================
const userState = {};
global.adminState = {};
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
    console.warn(`⚠️ Gagal kirim ke ${chatId}: ${err.message}`);
  }
}

async function safeEdit(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    console.warn(`⚠️ Gagal edit pesan: ${err.message}`);
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
      if (err) return console.error("❌ Gagal cek reseller yatim:", err.message);
      if (!rows.length) return console.log("✅ Tidak ada reseller yatim.");

      const orphanIds  = rows.map(r => r.reseller_id);
      const placeholders = orphanIds.map(() => '?').join(',');
      console.log("⚠️ Reseller yatim ditemukan:", orphanIds);

      db.run(
        `DELETE FROM reseller_sales WHERE reseller_id IN (${placeholders})`,
        orphanIds,
        function (err) {
          if (err) return console.error("❌ Gagal hapus reseller yatim:", err.message);
          console.log(`✅ ${this.changes} baris reseller_sales dibersihkan.`);
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

  const role     = user.role || 'user';
  const maxTrial = (role === 'reseller' || role === 'admin') ? 20 : 1;
  const last     = user.last_trial_date;
  const currentCount = user.trial_count_today || 0;

  if (!last) return { allowed: true, trialCount: 0, maxTrial, role, last: null };

  const diffDays = Math.floor(
    (new Date() - new Date(`${last}T00:00:00Z`)) / (1000 * 60 * 60 * 24)
  );

  if (diffDays >= 1) {
    return { allowed: true, trialCount: 0, maxTrial, role, last };
  }

  return { allowed: currentCount < maxTrial, trialCount: currentCount, maxTrial, role, last };
}

async function claimTrialAtomic(userId) {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      const check = await canTakeTrial(userId);
      if (!check.allowed) return resolve({ ok: false, reason: 'LIMIT_REACHED' });

      const today    = new Date().toISOString().split('T')[0];
      const newCount = check.trialCount + 1;

      db.run(
        'UPDATE users SET trial_count_today = ?, last_trial_date = ? WHERE user_id = ?',
        [newCount, today, userId],
        (err) => {
          if (err) return reject(err);
          resolve({ ok: true, trialKe: newCount });
        }
      );
    });
  });
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
      return safeEdit(ctx,
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

    for (const srvId in serverGroups) {
      const { info: server, accounts } = serverGroups[srvId];
      try {
        const protocols = [...new Set(accounts.map(a => (a.protocol || 'ssh').toLowerCase()))];
        for (const proto of protocols) {
          const res = await axios.get(`http://${server.domain}:5888/list`, {
            params: { type: proto, auth: server.auth },
            timeout: 15000
          });

          if (res.data?.status === "success" && Array.isArray(res.data.data)) {
            const serverUsernames = res.data.data.map(line => {
              const match = line.match(/User:\s*([^\s|]+)/i) || line.match(/^([^\s|]+)/);
              return match ? match[1].toLowerCase().trim() : line.toLowerCase().trim();
            });

            validAccounts.push(...accounts.filter(a =>
              (a.protocol || 'ssh').toLowerCase() === proto &&
              serverUsernames.includes(a.akun.toLowerCase().trim())
            ));
          }
        }
      } catch {
        // Server down → tampilkan data DB sebagai cadangan
        validAccounts.push(...accounts);
      }
    }

    if (!validAccounts.length) {
      return safeEdit(ctx,
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

    await safeEdit(ctx,
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
      return safeEdit(ctx, 
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
      return safeEdit(ctx, 
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

    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });

  } catch (err) {
    logger.error('renderDeletePage error: ' + err.message);
    ctx.reply("❌ Database/API sedang sibuk. Coba lagi nanti.").catch(() => {});
  }
}

// ==========================================
// 🌐 EXPRESS ENDPOINTS
// ==========================================

app.post('/webhook/pakasir', (req, res) => {
  const payload = req.body;
  logger.info(`Webhook received: ${JSON.stringify(payload)}`);

  if (payload?.order_id && payload?.amount && payload?.status) {
    handlePakasirWebhook(payload, bot);
    res.json({ received: true });
  } else {
    res.status(400).json({ error: 'Invalid webhook payload structure.' });
  }
});

app.get('/topup-success', (req, res) => {
  res.send('Pembayaran Anda sedang diverifikasi. Silakan kembali ke Telegram bot untuk melihat saldo.');
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
      console.error('❗ Gagal kirim DM:', e.message);
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

    console.log('✅ Statistik global diperbarui');
  } catch (err) {
    console.error('❌ Gagal update statistik global:', err.message);
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

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendMainMenu(ctx) {
  try {
    const userId = ctx.from.id;
    const firstName = escapeHtml(ctx.from.first_name || 'Partner');
    const ADMIN_USERNAME = vars?.ADMIN_USERNAME || '@joyhayabuse';

    // 1. Ambil Data secara Paralel (DIPERBAIKI: Hapus query total user, ambil dari cache)
    const [userData, totalAkun] = await Promise.all([
      dbGetAsync('SELECT saldo, role, reseller_level FROM users WHERE user_id = ?', [userId]),
      dbGetAsync('SELECT COUNT(*) AS total FROM invoice_log WHERE user_id = ?', [userId])
    ]);

    const saldo = userData?.saldo || 0;
    const role = userData?.role || 'user';
    const reseller_level = userData?.reseller_level || 'silver';
    const totalAkunDibuat = totalAkun?.total || 0;
    
    // Pakai variabel cache (ini yang bikin kencang)
    const totalUser = cacheTotalUser;

    const roleLabel = role === 'admin' ? 'Administrator' : 
                      role === 'reseller' ? `Reseller ${reseller_level.toUpperCase()}` : 'Member';

    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jakarta' });
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' });

    // 2. Susun Keyboard (Tetap sama)
    const keyboard = [];

    if (role === 'admin' || adminIds.includes(String(userId))) {
      keyboard.push([{ text: 'MENU SYSTEM ADMIN', callback_data: 'menu_adminreseller' }]);
    }

    keyboard.push([
      { text: '➕ Buat Akun', callback_data: 'service_create' },
      { text: '⌛ Trial Akun', callback_data: 'service_trial' }
    ]);

    keyboard.push([
      { text: '♻️ Perpanjang', callback_data: 'renew_select' },
      { text: '📋 Detail Akun', callback_data: 'menu_daftar_akun' }
    ]);

    keyboard.push([{ text: '💳 Top Up Saldo (Otomatis)', callback_data: 'topup_saldo_orderkuota' }]);

    if (role === 'reseller') {
      keyboard.push([{ text: '💼 Dashboard Resellers ', callback_data: 'menu_reseller' }]);
    } else if (role !== 'admin') {
      keyboard.push([{ text: '⭐ Upgrade To Resellers', callback_data: 'upgrade_to_reseller' }]);
    }

    // 3. Susun Teks (Gaya Tetap Sama Persis)
    const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━
 <b>🖥 CORE DASHBOARD SYSTEM </b>
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Informasi Pengguna</b>
<blockquote>• Status : <code>${roleLabel}</code>
• ID Anda : <code>${userId}</code>
• Saldo Anda : <b>Rp ${saldo.toLocaleString('id-ID')}</b>
• Total Transaksi : <code>${totalAkunDibuat} Proses</code>
• Total User Bot : <code>${totalUser} Member</code>
• Tgl/thn : ${dateStr} ${timeStr} WIB</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
📋 <b>Menu Tersedia</b>
<blockquote>• <b>Buat Akun</b> : SSH-VMess-VLess-Trojan-UdpZivpn
• <b>Trial Akun</b> : Coba gratis 1 jam
• <b>Perpanjang</b> : Extend masa aktif akun
• <b>Top up Saldo</b> : Isi saldo untuk transaksi
• <b>Menu Reseller</b> : Lihat komisi & statistik</blockquote>
⚠️ <b>Tips Top Up:</b>
<blockquote>• Hindari Top Up jam <b>00:00 - 00:10</b>
• Gunakan menit bebas agar saldo masuk</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
📞 <b>Bantuan & Dukungan</b>
<blockquote>Hubungi admin : ${escapeHtml(ADMIN_USERNAME)}</blockquote>
`.trim();

    const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery().catch(() => {});
      await safeEdit(ctx, text, options);
    } else {
      await ctx.reply(text, options);
    }

  } catch (err) {
    logger.error(`❌ Gagal Dashboard: ${err.message}`);
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

  try {
    await ctx.editMessageText(pesan, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(async () => {
      // Jika edit gagal (misal pesan sama), kirim ulang sebagai fallback
      await ctx.reply(pesan, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    });
  } catch (error) {
    logger.error('❌ Service Menu Error:', error.message);
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
async function showTrialServerMenu(ctx, jenis, page = 0) {
  try {
    const userId = String(ctx.from.id);
    if (ctx.updateType === 'callback_query') ctx.answerCbQuery().catch(() => {});

    // --- 1. AMBIL DATA SERVER ---
    const servers = await dbAllAsync('SELECT * FROM Server ORDER BY id ASC');
    
    if (!servers || servers.length === 0) {
      return ctx.reply('<b>⚠️ SERVER TIDAK TERSEDIA</b>\n\nMohon maaf, saat ini kapasitas server trial sedang penuh atau dalam pemeliharaan rutin.', { parse_mode: 'HTML' });
    }

    // --- 2. SORTING & PAGINATION ---
    const readyServers = servers.filter(s => (s.total_create_akun || 0) < (s.batas_create_akun || 0));
    const fullServers = servers.filter(s => (s.total_create_akun || 0) >= (s.batas_create_akun || 0));
    const sortedServers = [...readyServers, ...fullServers];

    const serversPerPage = 4;
    const totalPages = Math.max(1, Math.ceil(sortedServers.length / serversPerPage));
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const currentServers = sortedServers.slice(start, start + serversPerPage);

    // --- 3. BUILD KEYBOARD (DENGAN BENDERA) ---
    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      
      const flag1 = getFlag(currentServers[i].lokasi);
      row.push({ 
        text: `${flag1} ${currentServers[i].nama_server}`, 
        callback_data: `trial_server_${jenis}_${currentServers[i].id}` 
      });

      if (currentServers[i + 1]) {
        const flag2 = getFlag(currentServers[i + 1].lokasi);
        row.push({ 
          text: `${flag2} ${currentServers[i + 1].nama_server}`, 
          callback_data: `trial_server_${jenis}_${currentServers[i + 1].id}` 
        });
      }
      keyboard.push(row);
    }

    const navButtons = [];
    if (currentPage > 0) navButtons.push({ text: '⬅️ Prev', callback_data: `TrialPage_${jenis}_${currentPage - 1}` });
    if (currentPage < totalPages - 1) navButtons.push({ text: 'Next ➡️', callback_data: `TrialPage_${jenis}_${currentPage + 1}` });
    if (navButtons.length) keyboard.push(navButtons);
    
    keyboard.push([{ text: '🔙 Kembali Ke Menu', callback_data: 'service_trial' }]);

    // --- 4. FORMAT SERVER CARDS ---
    const serverCards = currentServers.map(s => {
      const isFull = (s.total_create_akun || 0) >= (s.batas_create_akun || 0);
      const status = isFull ? '❌ FULL' : '✅ READY';
      const flag = getFlag(s.lokasi);
      
      return `
  ${flag} <b>SERVER: ${escapeHtml(s.nama_server)}${s.lokasi ? ` (${escapeHtml(s.lokasi)})` : ' (Global)'}</b>
🖥️ <b>Host/IP:</b> <code>${escapeHtml(s.domain || '0.0.0.0')}</code>
⌛ <b>Durasi:</b> 60 Menit (Trial)
🔢 <b>Limit IP:</b> <code>${s.iplimit || 1}</code>
📊 <b>Status:</b> ${status} (${s.total_create_akun || 0}/${s.batas_create_akun || 0})`.trim();
    }).join('\n\n' + '─'.repeat(25) + '\n\n'); //

    // --- 5. HEADER & FOOTER ---
    let headerText = `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    headerText += `<b>⌛ TRIAL ${jenis.toUpperCase()} (${currentPage + 1}/${totalPages})</b>\n`;
    headerText += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    const footerText = `\n\n<b>📝 Syarat & Ketentuan:</b>\n🔹 Limit: 1 Akun/Hari/User\n🔹 Dilarang keras aktivitas ilegal\n\n<i>Silakan pilih tombol server di bawah ini.</i>`;

    // --- FIX DI SINI: Ganti ctx.editMessageText dengan safeEdit ---
    await safeEdit(ctx, headerText + serverCards + footerText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });

  } catch (error) {
    if (typeof logger !== 'undefined') logger.error(`❌ Error Trial Menu: ${error.message}`);
    else console.error(`❌ Error Trial Menu: ${error.message}`);
    
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

  // Update emoji ke gaya yang lebih clean/modern
  keyboard = [
    [
      { text: '🧿 SSH Tunnel', callback_data: `${action}_ssh` }, 
      { text: '🛰️ Xray Vmess', callback_data: `${action}_vmess` }
    ],
    [
      { text: '🔮 Xray Vless', callback_data: `${action}_vless` }, 
      { text: '🏹 Xray Trojan', callback_data: `${action}_trojan` }
    ],
    [
      { text: '♾️ UDP Zivpn', callback_data: `${action}_zivpn` }
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

    // --- 1. AMBIL DATA PARALEL ---
    const [user, servers] = await Promise.all([
      dbGetAsync('SELECT role, reseller_level FROM users WHERE user_id = ?', [userId]),
      dbAllAsync('SELECT * FROM Server ORDER BY id ASC')
    ]);

    if (!servers || servers.length === 0) {
      return ctx.reply('<b>⚠️ SERVER TIDAK TERSEDIA</b>\n\nMohon maaf, saat ini tidak ada server yang aktif.', { parse_mode: 'HTML' });
    }

    // --- 2. LOGIKA DISKON RESELLER ---
    const role = (user?.role || 'user').toLowerCase();
    const resellerLevel = (user?.reseller_level || 'silver').toLowerCase();
    const isReseller = role === 'reseller' || role === 'admin';

    let diskonRate = 0;
    if (isReseller) {
      if (resellerLevel === 'platinum') diskonRate = 0.4;
      else if (resellerLevel === 'gold') diskonRate = 0.3;
      else diskonRate = 0.2;
    }

    // --- 3. SORTING & PAGINATION ---
    const readyServers = servers.filter(s => (s.total_create_akun || 0) < (s.batas_create_akun || 0));
    const fullServers  = servers.filter(s => (s.total_create_akun || 0) >= (s.batas_create_akun || 0));
    const sortedServers = [...readyServers, ...fullServers];

    const serversPerPage = 4;
    const totalPages  = Math.max(1, Math.ceil(sortedServers.length / serversPerPage));
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const currentServers = sortedServers.slice(start, start + serversPerPage);

    // --- 4. BUILD KEYBOARD ---
    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];

      const flag1 = getFlag(currentServers[i].lokasi);
      row.push({
        text: `${flag1} ${currentServers[i].nama_server}`,
        callback_data: `${action}_username_${type}_${currentServers[i].id}`
      });

      if (currentServers[i + 1]) {
        const flag2 = getFlag(currentServers[i + 1].lokasi);
        row.push({
          text: `${flag2} ${currentServers[i + 1].nama_server}`,
          callback_data: `${action}_username_${type}_${currentServers[i + 1].id}`
        });
      }
      keyboard.push(row);
    }

    const navButtons = [];
    if (currentPage > 0)
      navButtons.push({ text: '⬅️ Prev', callback_data: `Maps_${action}_${type}_${currentPage - 1}` });
    if (currentPage < totalPages - 1)
      navButtons.push({ text: 'Next ➡️', callback_data: `Maps_${action}_${type}_${currentPage + 1}` });
    if (navButtons.length) keyboard.push(navButtons);
    keyboard.push([{ text: '🔙 Kembali Ke Menu', callback_data: 'service_create' }]);

    // --- 5. FORMAT HEADER & SERVER CARDS ---
    const protocolNames = {
      'vmes': 'VMESS',
      'vless': 'VLESS',
      'trojan': 'TROJAN',
      'shadowsocks': 'SHADOWSOCKS',
      'ssh': 'SSH WS',
      'zivpn': 'ZIVPN'
    };
    const currentProtocol = protocolNames[type.toLowerCase()] || type.toUpperCase();

    const serverCards = currentServers.map(s => {
      const basePriceDaily   = s.harga || 0;
      const basePriceMonthly = basePriceDaily * 30;
      const modalPriceDaily   = Math.floor(basePriceDaily   * (1 - diskonRate));
      const modalPriceMonthly = Math.floor(basePriceMonthly * (1 - diskonRate));

      const isFull  = (s.total_create_akun || 0) >= (s.batas_create_akun || 0);
      const status  = isFull ? '❌ FULL' : '✅ READY';
      const quotaMonth = (s.quota || 0) * 30;

      let pricingInfo = '';
      if (isReseller) {
        pricingInfo =
          `💵 <b>Jual:</b> <code>Rp${basePriceDaily.toLocaleString('id-ID')}</code> | <code>Rp${basePriceMonthly.toLocaleString('id-ID')}</code>\n` +
          `💴 <b>Beli:</b> <b>Rp${modalPriceDaily.toLocaleString('id-ID')}</b> | <b>Rp${modalPriceMonthly.toLocaleString('id-ID')}</b>`;
      } else {
        pricingInfo =
          `💰 <b>Harga:</b> <b>Rp${basePriceDaily.toLocaleString('id-ID')}/hari</b> | <b>Rp${basePriceMonthly.toLocaleString('id-ID')}/bln</b>`;
      }

      const flag = getFlag(s.lokasi);

      // ✅ Update: Limit IP dan Quota dipisah agar lebih enak dibaca
      return [
        `${flag} <b>SERVER: ${escapeHtml(s.nama_server)} (${escapeHtml(s.lokasi || 'Global')})</b>`,
        `🖥️ <b>Host:</b> <code>${escapeHtml(s.domain || '0.0.0.0')}</code>`,        
        pricingInfo,
        `🔢 <b>Limit IP:</b> <code>${s.iplimit || 1} Device</code>`,
        `📶 <b>Quota:</b> <code>${quotaMonth} GB / Bulan</code>`,
        `📊 <b>Status:</b> ${status} (${s.total_create_akun || 0}/${s.batas_create_akun || 0})`
      ].join('\n');
    }).join('\n\n' + '─'.repeat(25) + '\n\n'); //

    // --- 6. HEADER & FOOTER ---
    let headerText = `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    headerText += `<b>📋 LIST SERVER ${currentProtocol} (${currentPage + 1}/${totalPages})</b>\n`;
    headerText += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (isReseller) {
      headerText += `<i>⭐ Reseller ${resellerLevel.toUpperCase()} (${diskonRate * 100}% Diskon)</i>\n\n`;
    } else {
      headerText += `\n`;
    }

    const footerText = `\n\n<i>Silakan pilih tombol server di bawah ini.</i>`;

    // --- 7. KIRIM PESAN ---
    await safeEdit(ctx, headerText + serverCards + footerText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });

    if (!userState[ctx.chat.id]) userState[ctx.chat.id] = {};
    userState[ctx.chat.id].step = `${action}_username_${type}`;
    userState[ctx.chat.id].page = currentPage;

  } catch (error) {
    console.error(`❌ Error Select Server: ${error.message}`);
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
    // Abaikan error telegram "message is not modified"
    if (!e.description?.includes('message is not modified')) {
      logger.warn('safeEdit error: ' + e.message);
    }
  }
}
async function renderAccountList(ctx, userId) {
  try {
    // Ambil 10 akun terakhir yang punya config_text
    const accounts = await dbAllAsync(
      `SELECT id, akun, protocol FROM invoice_log 
       WHERE user_id = ? AND config_text IS NOT NULL 
       ORDER BY id DESC LIMIT 10`, 
      [userId]
    );

    if (!accounts.length) {
      return ctx.answerCbQuery('⚠️ Kamu belum memiliki riwayat pembuatan akun.', { show_alert: true });
    }

    const buttons = accounts.map(acc => ([{
      text: `👤 [${acc.protocol}] ${acc.akun}`,
      callback_data: `view_acc:${acc.id}` // Ini baru nyambung ke handler yang lu buat
    }]));

    buttons.push([{ text: '🔙 KEMBALI KE MENU', callback_data: 'send_main_menu' }]);

    await ctx.editMessageText('<b>🗂 DAFTAR AKUN ANDA</b>\nSilakan pilih akun untuk melihat detail config:', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Terjadi kesalahan saat mengambil daftar akun.');
  }
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

    await ctx.editMessageText(row.config_text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 KEMBALI KE LIST', callback_data: 'menu_daftar_akun' }]]
      }
    });
  } catch (err) {
    console.error(err);
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

  await ctx.editMessageText(text, {
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
    console.error('Error Navigation Trial:', err);
  }
});

// ------------------------- UPGRADE (tampilkan konfirmasi, HTML) -------------------------
bot.action('upgrade_to_reseller', async (ctx) => {
  const userId = ctx.from.id;

  const user = await dbGetAsync('SELECT saldo, role FROM users WHERE user_id = ?', [userId]);

  if (!user) {
    return ctx.reply('❌ Akun tidak ditemukan di sistem.', { parse_mode: 'HTML' });
  }

  if (user.role === 'reseller') {
    return ctx.reply('✅ Kamu sudah menjadi reseller.', { parse_mode: 'HTML' });
  }

  const minimumSaldo = 30000;

  if (user.saldo < minimumSaldo) {
    const msg = [
      '💸 <b>Saldo kamu belum cukup untuk upgrade.</b>',
      `Minimal saldo: <b>Rp${minimumSaldo.toLocaleString('id-ID')}</b>`,
      `Saldo kamu: <b>Rp${Number(user.saldo || 0).toLocaleString('id-ID')}</b>`
    ].join('\n');

    return ctx.reply(msg, { parse_mode: 'HTML' });
  }

  // Konfirmasi upgrade (biaya hanya syarat, TIDAK dipotong)
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
    '✅ Mendapat harga khusus',
    '✅ Mengelola akun user sendiri',
    '✅ Mengakses menu reseller di bot ini',
    '',
    'Klik <b>Ya</b> kalau kamu siap upgrade 🚀'
  ].join('\n');

  return ctx.reply(pesanKonfirmasi, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Ya, Upgrade Sekarang', callback_data: 'confirm_upgrade_reseller' }],
        [{ text: '❌ Batal', callback_data: 'send_main_menu' }]
      ]
    }
  });
});

// ------------------------- CONFIRM UPGRADE (TANPA POTONG SALDO) - HTML -------------------------
bot.action('confirm_upgrade_reseller', async (ctx) => {
  const userId = ctx.from.id;
  const minimumSaldo = Number(vars?.MIN_RESELLER_BALANCE) || 30000;

  // Helper escape HTML
  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  try {
    // ==========================
    // 1️⃣ CEK DATA USER
    // ==========================
    const user = await dbGetAsync('SELECT saldo, role, username, first_name FROM users WHERE user_id = ?', [userId]);
    if (!user) {
      await ctx.reply('❌ Akun tidak ditemukan.', { parse_mode: 'HTML' });
      return;
    }

    if (user.role === 'reseller') {
      await ctx.reply('✅ Kamu sudah menjadi reseller.', { parse_mode: 'HTML' });
      return;
    }

    // ==========================
    // 2️⃣ VALIDASI SALDO
    // ==========================
    const saldoNow = Number(user.saldo || 0);
    if (saldoNow < minimumSaldo) {
      await ctx.reply('❌ Saldo kamu tidak mencukupi untuk upgrade.', { parse_mode: 'HTML' });
      return;
    }

    // ==========================
    // 3️⃣ UPDATE ROLE RESELLER
    // ==========================
    try {
      await dbRunAsync('UPDATE users SET role = ?, reseller_level = ? WHERE user_id = ?', ['reseller', 'silver', userId]);
    } catch (dbErr) {
      logger.error('❌ Gagal update role saat upgrade reseller: ' + (dbErr.message || dbErr));
      await ctx.reply('❌ Gagal melakukan upgrade. Coba lagi nanti.', { parse_mode: 'HTML' });
      return;
    }

    // ==========================
    // 4️⃣ CATAT LOG UPGRADE
    // ==========================
    try {
      await dbRunAsync(
        `INSERT INTO reseller_upgrade_log (user_id, username, amount, level, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [userId, user.username || user.first_name || '', 0, 'silver']
      );
    } catch (logErr) {
      logger.warn('⚠️ Gagal insert ke reseller_upgrade_log: ' + (logErr.message || logErr));
      // jangan return, karena upgrade sudah berhasil
    }

    // ==========================
    // 5️⃣ KIRIM KONFIRMASI KE USER
    // ==========================
    const suksesMsg = `
🏆 *UPGRADE BERHASIL*

Selamat! Kamu telah berhasil upgrade ke *Reseller Silver*.

✅ Saldo minimal sudah dicek
✅ Upgrade GRATIS (tidak ada potongan)
✅ Harga khusus reseller sudah aktif

Silakan mulai transaksi dengan harga spesial!
    `.trim();

    await ctx.reply(suksesMsg, { parse_mode: 'Markdown' });

    // ==========================
    // 6️⃣ NOTIF KE GRUP
    // ==========================
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
      // Format mention yang aman
      const usernameMention = user.username ? `@${escapeHtml(user.username)}` : null;
      const nameLink = `<a href="tg://user?id=${userId}">${escapeHtml(user.first_name || 'User')}</a>`;
      const mention = usernameMention || nameLink;

      // Format tanggal Indonesia
      const timestamp = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const notif = `
╭─〔 <b>🏆 UPGRADE RESELLER</b> 〕
│
├─ 👤 <b>Informasi User</b>
│  ├ User : ${mention}
│  ├ ID   : <code>${userId}</code>
│  └ Role : Reseller Silver
│
├─ 💰 <b>Syarat Upgrade</b>
│  ├ Min Saldo    : Rp ${minimumSaldo.toLocaleString('id-ID')}
│  ├ Saldo Aktual : Rp ${saldoNow.toLocaleString('id-ID')}
│  └ Biaya        : <b>GRATIS</b>
│
├─ 🕐 <b>Waktu Upgrade</b>
│  └ ${timestamp} WIB
│
╰───────────────────────
   ✅ <i>Upgrade Berhasil</i>
      `.trim();

      // Kirim notif ke grup
      try {
        await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: 'HTML' });
      } catch (e) {
        logger.warn('⚠️ Gagal kirim notif upgrade ke group: ' + (e.message || e));
      }
    }

  } catch (err) {
    logger.error('❌ Error on confirm_upgrade_reseller: ' + (err.message || err));
    try { 
      await ctx.reply('❌ Terjadi kesalahan pada server. Coba lagi nanti.', { parse_mode: 'HTML' }); 
    } catch (_) {}
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

    await ctx.editMessageText(content, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
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

    await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
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
      { text: 'Statistik', callback_data: 'admin_stats' }, 
      { text: 'Daftar User', callback_data: 'admin_listuser' }
    ],
    [
      { text: 'Broadcast', callback_data: 'admin_broadcast' }, 
      { text: 'Backup Database', callback_data: 'admin_backup_db' }
    ],
    [
      { text: 'Restore Database', callback_data: 'admin_restore2_db' }, 
      { text: 'All Backup', callback_data: 'admin_restore_all' }
    ],
    [
      { text: 'Promote Reseller', callback_data: 'admin_promote_reseller' }, 
      { text: 'Downgrade User', callback_data: 'admin_downgrade_reseller' }
    ],
    [
      { text: 'Ubah Level', callback_data: 'admin_ubah_level' }, 
      { text: 'List Reseller', callback_data: 'admin_listreseller' }
    ],
    [
      { text: 'Reset Komisi', callback_data: 'admin_resetkomisi' }, 
      { text: 'Tambah Komisi', callback_data: 'admin_add_komisi_manual' } // Ditambah di sini agar sejajar dengan Reset Komisi
    ],
    [
      { text: 'Reset Trial', callback_data: 'admin_reset_trial' },
      { text: 'Kelola Event', callback_data: 'admin_manage_event' }
    ],
    [
      { text: 'Pantau Event', callback_data: 'admin_cek_peserta_event' },
      { text: 'Log Top Up', callback_data: 'admin_view_topup' }
    ],
    [
      { text: 'Kembali', callback_data: 'menu_adminreseller' }
    ]
  ]
};

    const msg = `
━━━━━━━━━━━━━━━━━━━━━━━━━
<b>⚙️ MANAJEMEN SISTEM</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Gunakan menu di bawah untuk manajemen database, broadcast, dan pengaturan level reseller.</i>
`.trim();

    await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
  } catch (e) { logger.error('Error system menu: ' + e.message); }
});

// State sementara untuk mencatat langkah admin
const komisiState = {};

// Handler saat tombol diklik
bot.action('admin_add_komisi_manual', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) return ctx.answerCbQuery('🚫 Akses Ditolak');

  komisiState[userId] = { step: 'WAIT_ID' };
  await ctx.answerCbQuery();
  await ctx.editMessageText('👤 **Langkah 1:**\nSilakan masukkan **User ID** reseller yang akan ditambah komisinya:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'admin_system_menu' }]] }
  });
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
bot.action('admin_view_topup', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) return ctx.answerCbQuery('🚫 Akses ditolak.');

  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Helper untuk convert UTC ke WIB
  const formatToWIB = (utcDateStr) => {
    try {
      // Parse UTC datetime dari SQLite
      const utcDate = new Date(utcDateStr + 'Z'); // Tambah 'Z' untuk mark sebagai UTC
      
      // Format ke WIB (UTC+7)
      return utcDate.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (e) {
      return utcDateStr; // Fallback ke string original jika error
    }
  };

  try {
    await ctx.answerCbQuery('⏳ Mengambil data...');

    const logs = await new Promise((resolve, reject) => {
      db.all(
        `SELECT created_at, user_id, username, amount, reference, metode 
         FROM topup_log 
         ORDER BY created_at DESC LIMIT 50`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });

    if (!logs || logs.length === 0) {
      return ctx.reply('ℹ️ <b>Belum ada riwayat topup.</b>', { parse_mode: 'HTML' });
    }

    let html = `📒 <b>LOG TOPUP (50 Terakhir)</b>\n\n`;

    logs.forEach((t, i) => {
      // Jika kolom metode kosong (log lama), tebak berdasarkan reference
      let sumber = t.metode || (t.reference?.includes('OR') ? 'Orkut (QRIS)' : 'Pakasir');
      
      // Icon berdasarkan sumber
      let icon = sumber.toLowerCase().includes('orkut') ? '✴️' : '📦';

      // Convert waktu ke WIB
      const waktuWIB = formatToWIB(t.created_at);

      const block = [
        `<b>#${i + 1}</b> | ${icon} <b>${sumber}</b>`,
        `🕒 ${waktuWIB} WIB`,
        `👤 ${escapeHtml(t.username)} (<code>${t.user_id}</code>)`,    
        `💰 <b>Rp ${t.amount.toLocaleString('id-ID')}</b>`,
        `🔖 Ref: <code>${escapeHtml(t.reference)}</code>`,
        '────────────────────'
      ].join('\n') + '\n\n';

      if ((html + block).length > 4000) {
        ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
        html = '';
      }
      html += block;
    });

    if (html.trim()) ctx.reply(html, { parse_mode: 'HTML' });

  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
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

    await ctx.editMessageText(text, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: buttons } 
    }).catch(() => ctx.answerCbQuery("ℹ️ Data sudah yang terbaru.")); // 🔥 Biar gak error kalau data belum berubah

  } catch (err) {
    console.error("❌ Error Admin Cek Event:", err);
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

  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
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
  
  // 1. Cek Izin Admin (Mengikuti logika adminIds di app.js)
  const adminList = global.adminIds || (typeof adminIds !== 'undefined' ? adminIds : []);
  if (!adminList.map(String).includes(userId)) {
    return ctx.answerCbQuery('🚫 Izin Ditolak!', { show_alert: true });
  }

  // Mengambil nomor halaman dari callback_data, default ke halaman 1
  const page = ctx.match[1] ? parseInt(ctx.match[1]) : 1;
  const limit = 5; // Tampilkan 5 reseller per halaman agar tidak kepanjangan di HP
  const offset = (page - 1) * limit;

  try {
    await ctx.answerCbQuery('Memuat data reseller...').catch(() => {});

    // 2. Query Total Data & Data per Halaman (Menggunakan helper async dari app.js)
    const totalData = await dbGetAsync("SELECT COUNT(*) as count FROM users WHERE role = 'reseller'");
    const rows = await dbAllAsync(`
      SELECT user_id, username, reseller_level, saldo 
      FROM users 
      WHERE role = 'reseller' 
      ORDER BY saldo DESC 
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    if (!rows || rows.length === 0) {
      return ctx.editMessageText('⚠️ <b>Belum ada reseller terdaftar.</b>', { 
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'admin_system_menu' }]] }
      });
    }

    // 3. Format List Reseller
    const list = rows.map((row, i) => {
      const rank = offset + i + 1;
      const username = row.username ? `@${row.username}` : 'No Username';
      const level = (row.reseller_level || 'SILVER').toUpperCase();
      
      // Ikon medali untuk Top 3 global (bukan per halaman)
      const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : '🔹 ';
      
      return `${medal}<b>${username}</b>
<blockquote>Level: <code>${level}</code>
ID: <code>${row.user_id}</code>
Saldo: <b>Rp ${row.saldo.toLocaleString('id-ID')}</b></blockquote>`;
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

    // 4. Keyboard Navigasi Next & Prev
    const navButtons = [];
    if (page > 1) {
      navButtons.push({ text: '⬅️ Prev', callback_data: `admin_listreseller:${page - 1}` });
    }
    if (page < totalPages) {
      navButtons.push({ text: 'Next ➡️', callback_data: `admin_listreseller:${page + 1}` });
    }

    const keyboard = {
      inline_keyboard: [
        navButtons,
        [{ text: '🔄 REFRESH', callback_data: `admin_listreseller:${page}` }],
        [{ text: '⬅️ KEMBALI KE MENU ADMIN', callback_data: 'admin_system_menu' }]
      ]
    };

    await safeEdit(ctx, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

  } catch (err) {
    logger.error('❌ Gagal ambil list reseller:', err.message);
    ctx.reply('❌ Gagal mengambil daftar reseller.');
  }
});

bot.action('admin_stats', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('❌ Akses Ditolak.', { show_alert: true });
  }

  try {
    // 1. Instant Feedback
    await ctx.answerCbQuery('Menghitung statistik...').catch(() => {});

    // 2. Ambil Data Paralel (Biar Ngebut)
    const [
      jumlahUser,
      jumlahReseller,
      jumlahServer,
      totalSaldo,
      totalTransaksi,
      totalKomisi,
      topReseller
    ] = await Promise.all([
      dbGetAsync('SELECT COUNT(*) AS count FROM users'),
      dbGetAsync("SELECT COUNT(*) AS count FROM users WHERE role = 'reseller'"),
      dbGetAsync('SELECT COUNT(*) AS count FROM Server'),
      dbGetAsync('SELECT SUM(saldo) AS total FROM users'),
      dbGetAsync('SELECT COUNT(*) AS count FROM invoice_log'),
      dbGetAsync('SELECT SUM(komisi) AS total FROM reseller_sales'),
      dbAllAsync(`
        SELECT u.username, r.reseller_id, SUM(r.komisi) AS total_komisi
        FROM reseller_sales r
        LEFT JOIN users u ON u.user_id = r.reseller_id
        GROUP BY r.reseller_id
        ORDER BY total_komisi DESC
        LIMIT 3
      `)
    ]);

    // 3. Susun Teks Sistem & Global
    const sistemHtml = `
━━━━━━━━━━━━━━━━━━━━━━
📊 <b>STATISTIK SISTEM</b>
━━━━━━━━━━━━━━━━━━━━━━
<blockquote>👥 <b>User Total</b> : <code>${jumlahUser?.count || 0}</code>
👑 <b>Reseller</b>   : <code>${jumlahReseller?.count || 0}</code>
🖥️ <b>Server</b>     : <code>${jumlahServer?.count || 0}</code>
💰 <b>Total Saldo</b> : <b>Rp ${(totalSaldo?.total || 0).toLocaleString('id-ID')}</b></blockquote>
`.trim();

    let globalHtml = `
🌐 <b>STATISTIK GLOBAL</b>
<blockquote>📦 <b>Transaksi</b>    : <code>${totalTransaksi?.count || 0}</code>
💸 <b>Total Komisi</b> : <b>Rp ${(totalKomisi?.total || 0).toLocaleString('id-ID')}</b></blockquote>
`.trim();

    // 4. Tambahkan Top Reseller dengan gaya Medali
    if (topReseller && topReseller.length > 0) {
      globalHtml += `\n\n🏆 <b>TOP 3 RESELLER (KOMISI)</b>\n`;
      const medals = ['🥇', '🥈', '🥉'];
      
      topReseller.forEach((r, i) => {
        const medal = medals[i] || '⭐';
        const label = r.username ? `@${r.username}` : `ID:<code>${r.reseller_id}</code>`;
        const komisi = (r.total_komisi || 0).toLocaleString('id-ID');
        globalHtml += `${medal} ${label} — <b>Rp ${komisi}</b>\n`;
      });
    }

    const finalHtml = `${sistemHtml}\n\n${globalHtml}\n━━━━━━━━━━━━━━━━━━━━━━`.trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: 'REFRESH DATA', callback_data: 'admin_stats' }],
        [{ text: 'KEMBALI', callback_data: 'admin_system_menu' }]
      ]
    };

    // 5. Eksekusi Kirim
    await ctx.editMessageText(finalHtml, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    }).catch(async () => {
      await ctx.reply(finalHtml, { parse_mode: 'HTML', reply_markup: keyboard });
    });

  } catch (err) {
    logger.error('❌ Gagal ambil statistik admin:', err.message || err);
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

  return ctx.editMessageText(
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
    return ctx.editMessageText('❌ Session expired atau tidak punya izin.');
  }

  const broadcastMessage = state.broadcastText;

  if (!broadcastMessage) {
    return ctx.reply('❌ Pesan tidak ditemukan.');
  }

  delete userState[userId];

  const users = await dbAllAsync('SELECT user_id FROM users');
  const BATCH_SIZE = 20;
  const DELAY = 300;

  let sukses = 0;
  let gagal = 0;

  await ctx.editMessageText(`📣 Mengirim broadcast ke ${users.length} pengguna...\n⏳ Tunggu sebentar.`);

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

  return ctx.reply(
    `📣 *Broadcast selesai!*\n\n` +
    `✅ Berhasil: ${sukses}\n` +
    `❌ Gagal: ${gagal}`,
    { parse_mode: 'Markdown' }
  );
});
// =====================================
// BROADCAST MEDIA CONFIRM
// =====================================
bot.action('broadcast_media_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const state = userState[userId]; // ✅ FIX

  if (!state || !adminIds.includes(userId)) {
    return ctx.editMessageText('❌ Session expired atau tidak punya izin.');
  }

  const { messageId, chatId: sourceChatId, mediaType } = state;

  delete userState[userId]; // ✅ FIX

  const users = await dbAllAsync('SELECT user_id FROM users');
  const BATCH_SIZE = 15;
  const DELAY = 500;

  let sukses = 0;
  let gagal = 0;

  await ctx.editMessageText(
    `📣 Mengirim broadcast ${mediaType.toUpperCase()} ke ${users.length} pengguna...\n` +
    `⏳ Tunggu, proses ini memakan waktu lebih lama.`
  );

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

  return ctx.reply(
    `📣 *Broadcast ${mediaType.toUpperCase()} selesai!*\n\n` +
    `✅ Berhasil: ${sukses}\n` +
    `❌ Gagal: ${gagal}`,
    { parse_mode: 'Markdown' }
  );
});

// =====================================
// CANCEL BROADCAST
// =====================================
bot.action('cancel_broadcast', async (ctx) => {
  await ctx.answerCbQuery('❌ Broadcast dibatalkan');

  const userId = String(ctx.from.id); // ✅ FIX

  delete userState[userId]; // ✅ FIX

  return ctx.editMessageText(
    '❌ *Broadcast dibatalkan.*',
    { parse_mode: 'Markdown' }
  );
});

bot.action('admin_ubah_level', async (ctx) => {
  const adminId = String(ctx.from.id);
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ *Khusus admin.*', { parse_mode: 'Markdown' });
  }

  userState[ctx.chat.id] = { step: 'await_level_change' };
  ctx.reply('🧬 *Masukkan ID user dan level baru:*\n\nFormat: `123456789 platinum`', {
    parse_mode: 'Markdown'
  });

  // ⏱️ Timeout auto reset 30 detik
  setTimeout(() => {
    if (userState[ctx.chat.id]?.step === 'await_level_change') {
      delete userState[ctx.chat.id];
      ctx.reply('⏳ Waktu habis. Silakan klik ulang tombol *Ubah Level Reseller*.', {
        parse_mode: 'Markdown'
      });
    }
  }, 30000);
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

// 2. KODE ACTION RESET KAMU
bot.action('admin_resetkomisi', async (ctx) => {
  try {
    const rows = await dbAllAsync('SELECT * FROM reseller_sales');
    const totalData = rows ? rows.length : 0;

    await dbRunAsync(`CREATE TABLE IF NOT EXISTS reseller_sales_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER,
      buyer_id INTEGER,
      akun_type TEXT,
      username TEXT,
      komisi INTEGER,
      created_at TEXT,
      archived_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    if (totalData > 0) {
      for (const r of rows) {
        await dbRunAsync(`INSERT INTO reseller_sales_archive 
          (reseller_id, buyer_id, akun_type, username, komisi, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`, 
          [r.reseller_id, r.buyer_id, r.akun_type, r.username, r.komisi, r.created_at]);
      }
    }

    await dbRunAsync('DELETE FROM reseller_sales');
    await dbRunAsync("UPDATE users SET reseller_level = 'silver' WHERE role = 'reseller'");

    await ctx.answerCbQuery('✅ Reset Komisi Berhasil!', { show_alert: true });
    
    // GUNAKAN escapeMarkdown di sini supaya aman
    let pesan = `🧹 *MANUAL RESET BERHASIL*\n\n`;
    pesan += `• Data Diarsipkan: *${totalData}*\n`;
    pesan += `• Status: Semua reseller kembali ke *SILVER*\n`;
    pesan += `• Waktu: ${escapeMarkdown(new Date().toLocaleString('id-ID'))}`;

    await ctx.editMessageText(pesan, { parse_mode: 'Markdown' });

  } catch (err) {
    logger.error('❌ Gagal reset manual: ' + err.message);
    // Tambahkan pengaman juga di sini
    await ctx.reply('Terjadi kesalahan saat reset: ' + escapeMarkdown(err.message), { parse_mode: 'Markdown' });
  }
});

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
      return ctx.editMessageText('📭 <b>Database Kosong</b> atau Halaman Tidak Ditemukan.', { 
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

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
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
    // Ambil role user
    const row = await dbGetAsync('SELECT role, username, reseller_level FROM users WHERE user_id = ?', [userId]);

    if (!row || row.role !== 'reseller') {
      return ctx.reply('❌ <b>Kamu bukan reseller.</b>', { parse_mode: 'HTML' });
    }

    // --- LOGIKA BARU UNTUK MENGHITUNG RESET 2 BULANAN ---
    const now = new Date();
    let targetMonthIndex = -1; // 0=Jan, 1=Feb, dst.
    let targetYear = now.getFullYear();

    // Reset terjadi pada bulan GANJIL (Jan:0, Mar:2, May:4, Jul:6, Sep:8, Nov:10)
    for (let i = now.getMonth(); i <= 11; i++) {
        if (i % 2 === 0) { // Cek apakah bulan saat ini/mendatang adalah bulan reset
            // Jika kita berada di bulan reset dan tanggal 1 jam 01:00 sudah lewat, lewati ke bulan reset berikutnya.
            const hasResetPassed = (now.getDate() > 1 || (now.getDate() === 1 && now.getHours() >= 1));
            
            if (i === now.getMonth() && hasResetPassed) {
                continue; 
            }
            
            // Ditemukan bulan reset berikutnya (atau yang sedang berjalan jika belum jam 01:00)
            targetMonthIndex = i;
            break;
        }
    }

    // Jika tidak ada bulan reset tersisa di tahun ini (sudah lewat Nov), target adalah Jan tahun depan.
    if (targetMonthIndex === -1) {
        targetMonthIndex = 0; // Januari
        targetYear++;
    }

    // Konstruksi tanggal reset berikutnya
    const nextReset = new Date(targetYear, targetMonthIndex, 1, 1, 0, 0);
    // -----------------------------------------------------------------

    const nextResetStr = nextReset.toLocaleString('id-ID', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    // Keyboard menu reseller
    const keyboard = {
  inline_keyboard: [
    [
      { text: '📊 Statistik Jualan', callback_data: 'reseller_riwayat' },
      { text: '💰 Cek Komisi', callback_data: 'reseller_komisi' }
    ],
    [
      { text: '🏆 Top Mingguan', callback_data: 'reseller_top_weekly' },
      { text: '👑 Top All Time', callback_data: 'reseller_top_all' }
    ],
    [
      { text: '📋 List & Expired', callback_data: 'reseller_list_akun' },
      { text: '🗑️ Delete Akun', callback_data: 'delete_confirm' }
    ],
    [
      { text: '📥 Export Data', callback_data: 'reseller_export' },
      { text: '🎁 Event Reseller', callback_data: 'menu_event_reseller' }
    ],
    [
      { text: '💸 Tarik Komisi', callback_data: 'tarik_komisi_input' }
    ],
    [
      { text: '⬅️ Kembali Ke Menu Utama', callback_data: 'send_main_menu' }
    ]
  ]
};

    // Format level
    const levelFormatted = (row.reseller_level || 'silver').toUpperCase();
    const currentDate = now.toLocaleDateString('id-ID', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      timeZone: 'Asia/Jakarta'
    });
    const currentTime = now.toLocaleTimeString('id-ID', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Jakarta',
      timeZoneName: 'short'
    });

    // Bangun pesan HTML
    const content = `
━━━━━━━━━━━━━━━━━━━━━━━━━
<b>💼 DASHBOARD RESELLER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📋 Informasi Akun</b>
<blockquote>• Status  : <code>Reseller Aktif</code>
• Level   : <code>${escapeHtml(levelFormatted)}</code>
• Tanggal : <code>${escapeHtml(currentDate)}</code>
• Waktu   : <code>${escapeHtml(currentTime)}</code></blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
<b>💰 Informasi Komisi</b>
<blockquote>• Reset komisi setiap <b>2 bulan sekali</b>
• Reset berikutnya: <b>${escapeHtml(nextResetStr)}</b>
• Komisi aktif akan menjadi 0 setelah reset
• Upgrade level otomatis komisi di atas 20k-30k
• Kumpulkan komisi untuk upgrade level</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━

<i>Pilih menu di bawah untuk melanjutkan</i>
`.trim();

    // Kirim / edit dengan fallback bila edit gagal
    try {
      await ctx.editMessageText(content, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        disable_web_page_preview: true
      });
    } catch (err) {
      if (err.response?.error_code === 400 || (err.message && err.message.includes("message can't be edited"))) {
        await ctx.reply(content, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          disable_web_page_preview: true
        });
      } else {
        logger.error('❌ Gagal tampilkan menu_reseller: ' + (err.message || err));
      }
    }

  } catch (err) {
    logger.error('❌ Error query menu_reseller: ' + (err.message || err));
    return ctx.reply('⚠️ Terjadi kesalahan saat memuat menu reseller.', { parse_mode: 'HTML' });
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
    console.error(err);
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
        const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        const userMention = `<a href="tg://user?id=${userId}">${mention}</a>`;
        const timestamp = new Date().toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta',
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });

        const groupLogHtml = `
╭─〔 <b>🗑️ ACCOUNT DELETED</b> 〕
│
├─ 👤 <b>Informasi Reseller</b>
│  ├ User : ${userMention}
│  ├ ID   : <code>${userId}</code>
│  └ Status : ${isRefundable ? 'REFUND PROCESSED' : 'NO REFUND'}
│
├─ 📡 <b>Detail Layanan</b>
│  ├ Protocol : ${type.toUpperCase()}
│  ├ Account  : <code>${maskUsername(username)}</code>
│  └ Server   : ${server.nama_server}
│
├─ 💰 <b>Detail Finansial</b>
│  ├ Refund   : Rp ${refundAmount.toLocaleString('id-ID')}
│  └ Sisa Saldo : <b>Rp ${userUpdated.saldo.toLocaleString('id-ID')}</b>
│
├─ 🕐 <b>Waktu Eksekusi</b>
│  └ ${timestamp} WIB
│
╰───────────────────────`.trim();

        try {
          await ctx.telegram.sendMessage(vars.GROUP_ID, groupLogHtml, { parse_mode: 'HTML' });
        } catch (err) {
          console.error("❌ Gagal kirim notif grup:", err.message);
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
    console.error('[DEL ERROR]', err.message);
    ctx.reply("❌ Terjadi kesalahan saat menghubungi server VPS.");
  }
});

bot.action('tarik_komisi_input', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  try {
    // 1. Ambil data saldo utama user
    const user = await dbGetAsync('SELECT saldo FROM users WHERE user_id = ?', [userId]);

    // 2. Hitung total komisi yang tersedia di tabel reseller_sales
    const komisiRow = await dbGetAsync('SELECT SUM(komisi) AS total FROM reseller_sales WHERE reseller_id = ?', [userId]);
    const totalKomisi = komisiRow?.total || 0;

    // 3. Cek minimal saldo akun (opsional, sesuai logic kamu sebelumnya)
    if (user && user.saldo < 30000) {
      return ctx.answerCbQuery(`❌ Saldo akun minimal Rp 30.000 untuk menarik komisi!`, { show_alert: true });
    }

    // 4. Cek apakah ada komisi yang bisa ditarik
    if (totalKomisi <= 0) {
      return ctx.answerCbQuery(`❌ Kamu belum memiliki komisi yang bisa ditarik.`, { show_alert: true });
    }

    // Set state untuk input nominal
    userState[chatId] = { step: 'WAIT_CLAIM_NOMINAL' }; 

    // 5. Tampilan Pesan yang lebih informatif
    const message = `
╭─〔 <b>💰 TARIK KOMISI</b> 〕
│
├─ 💵 <b>Komisi Tersedia:</b>
│  └ <b>Rp ${totalKomisi.toLocaleString('id-ID')}</b>
│
├─ 💳 <b>Saldo Utama:</b>
│  └ Rp ${user.saldo.toLocaleString('id-ID')}
│
╰───────────────────────

✍️ <b>Masukkan nominal yang ingin ditarik:</b>
<i>Contoh: <code>${totalKomisi}</code></i>

⚠️ <i>Komisi yang ditarik akan langsung dipindahkan ke Saldo Utama Anda.</i>`.trim();

    await ctx.deleteMessage().catch(() => {});
    return ctx.reply(message, { 
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Batal', callback_data: 'menu_reseller' }]]
      }
    });

  } catch (err) {
    logger.error('Error tarik_komisi_input: ' + err.message);
    return ctx.reply('❌ Terjadi kesalahan saat mengambil data komisi.');
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

  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
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
    const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;
    const timestamp = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const groupInvoiceHtml = `
╭─〔 <b>🏆 EVENT ACHIEVED</b> 〕
│
├─ 👤 <b>Informasi Reseller</b>
│  ├ User : ${userMention}
│  ├ ID   : <code>${userId}</code>
│  └ Role : RESELLER
│
├─ 🎁 <b>Detail Hadiah</b>
│  ├ Event  : ${escapeHtml(event.nama_event)}
│  ├ Target : ${event.target_penjualan} Akun
│  └ Bonus  : <b>Rp ${event.bonus_saldo.toLocaleString()}</b>
│
├─ 🕐 <b>Waktu Klaim</b>
│  └ ${timestamp} WIB
│
╰───────────────────────
    `.trim();

    try {
      await bot.telegram.sendMessage(GROUP_ID, groupInvoiceHtml, {
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error("❌ Gagal kirim notif event ke grup:", err.message);
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
    console.error('Error Navigasi:', err);
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
            reply_markup: { inline_keyboard: [[{ text: '🔙 KEMBALI', callback_data: 'renew_select' }]] }
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

    await ctx.editMessageText(
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

    // 1️⃣ Ambil SEMUA akun milik reseller dari DB (termasuk yang mungkin sudah exp)
    const myAccounts = await dbAllAsync(
      `SELECT akun, SUM(hari) AS total_hari, MIN(created_at) AS tgl_awal, layanan
       FROM invoice_log
       WHERE user_id = ? AND LOWER(protocol) LIKE ?
       GROUP BY LOWER(akun)`,
      [userId, `%${type}%`]
    );

    if (!myAccounts.length) {
      return ctx.editMessageText(`<b>📂 MY MEMBER: ${type.toUpperCase()}</b>\n\n<i>Anda belum memiliki member.</i>`, {
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
      
      // Hitung Tanggal Expired dari DB
      const start = new Date(info.tgl_awal);
      const exp = new Date(start);
      exp.setDate(exp.getDate() + Number(info.total_hari));
      const expFmt = exp.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

      // Tentukan Status & Icon
      const statusIcon = isLive ? '🟢' : '🔴';
      const statusText = isLive ? 'AKTIF' : 'EXPIRED/HILANG';

      output += `${statusIcon} <code>${info.akun}</code>\n`;
      output += `   ├ Exp: <code>${expFmt}</code>\n`;
      output += `   └ Stat: <b>${statusText}</b>\n\n`;
    });

    output += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    output += `🟢 = Terdeteksi di Server\n`;
    output += `🔴 = Tidak terdeteksi (Sudah Exp/Dihapus)`;

    await ctx.editMessageText(output, {
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
    // 1. Ambil data top reseller 7 hari terakhir
    const topRows = await dbAllAsync(`
      SELECT u.user_id, u.username, SUM(r.komisi) AS total_komisi
      FROM reseller_sales r
      JOIN users u ON r.reseller_id = u.user_id
      WHERE r.created_at >= datetime('now', '-7 days')
      GROUP BY r.reseller_id
      ORDER BY total_komisi DESC
      LIMIT 5
    `);

    if (!topRows || topRows.length === 0) {
      return ctx.editMessageText('<b>📭 BELUM ADA TRANSAKSI</b>\n\nSepertinya belum ada pergerakan reseller dalam 7 hari terakhir.', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]]
        }
      });
    }

    // 2. Susun tampilan dengan gaya Dashboard
    let message = '<b>🏆 TOP RESELLER MINGGU INI</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '<i>Periode: 7 Hari Terakhir</i>\n\n';

    topRows.forEach((row, i) => {
      const medals = ['🥇', '🥈', '🥉', '🎖️', '⭐'];
      const medal = medals[i] || '🔹';
      
      // Nama Reseller (Gunakan escapeHtml agar aman)
      const name = row.username ? `@${escapeHTML(row.username)}` : `User_${row.user_id}`;
      const total = row.total_komisi.toLocaleString('id-ID');

      message += `${medal} <b>${name}</b>\n`;
      message += `└─ Profit: <code>Rp ${total}</code>\n\n`;
    });

    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '🎯 <i>Terus tingkatkan penjualanmu!</i>';

    // 3. Kirim dengan editMessageText agar lebih smooth (gak spam chat)
    await ctx.editMessageText(message, {
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
  const userId = ctx.from.id;

  try {
    // 1. Ambil data penjualan reseller
    const rows = await dbAllAsync(`
      SELECT akun_type, username, komisi, created_at 
      FROM reseller_sales 
      WHERE reseller_id = ?
      ORDER BY created_at DESC
    `, [userId]);

    if (!rows || rows.length === 0) {
      return ctx.editMessageText('<b>📭 DATA KOSONG</b>\nKamu belum memiliki riwayat penjualan untuk diexport.', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'send_main_menu' }]]
        }
      });
    }

    // 2. Hitung Total Komisi biar informatif
    const totalCuan = rows.reduce((sum, row) => sum + row.komisi, 0);

    // 3. Susun isi laporan
    let message = '<b>📥 EXPORT RIWAYAT KOMISI</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += `📊 Total Transaksi: <b>${rows.length} Akun</b>\n`;
    message += `💰 Total Profit   : <b>Rp ${totalCuan.toLocaleString('id-ID')}</b>\n`;
    message += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

    rows.forEach((row, i) => {
      const waktu = new Date(row.created_at).toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      
      // Emoji per baris: 🏷️ untuk tipe, ?? untuk user, 💸 untuk nominal
      message += `${i + 1}. <b>${row.akun_type.toUpperCase()}</b> - <code>${row.username}</code>\n`;
      message += `   └─ 💸 Rp ${row.komisi.toLocaleString('id-ID')} | ?? ${waktu}\n\n`;
    });

    // 4. Batasi panjang pesan jika terlalu banyak (Telegram limit 4096 karakter)
    if (message.length > 4000) {
      message = message.substring(0, 3900) + "\n\n<i>...data lainnya terpotong karena terlalu panjang</i>";
    }

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ KEMBALI KE MENU', callback_data: 'menu_reseller' }]
        ]
      }
    });

  } catch (err) {
    logger.error('❌ Error reseller_export:', err.message);
    await ctx.reply('<b>⚠️ Gagal mengekspor data komisi.</b>', { parse_mode: 'HTML' });
  }
});

bot.action('reseller_top_all', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const rows = await dbAllAsync(`
      SELECT r.reseller_id, COUNT(r.id) AS total_akun, 
             SUM(COALESCE(r.komisi, 0)) AS total_komisi,
             u.username
      FROM reseller_sales r
      INNER JOIN users u ON r.reseller_id = u.user_id
      GROUP BY r.reseller_id
      HAVING total_komisi > 0
      ORDER BY total_komisi DESC
      LIMIT 10
    `);

    if (!rows || rows.length === 0) {
      return ctx.editMessageText('<b>📭 BELUM ADA DATA</b>', { parse_mode: 'HTML' });
    }

    let message = '<b>🏆 HALL OF FAME: TOP RESELLER</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '<i>Peringkat Berdasarkan Total Komisi</i>\n\n';

    rows.forEach((r, i) => {
      const medals = ['🥇', '🥈', '🥉', '??️', '⭐'];
      const medal = medals[i] || '🔹';
      const nama = r.username ? `@${escapeHTML(r.username)}` : `User_${r.reseller_id}`;

      message += `${medal} <b>${nama}</b>\n`;
      message += `├ 🛒 Terjual: <code>${r.total_akun} Akun</code>\n`;
      message += `└ 💰 Komisi : <b>Rp ${(r.total_komisi || 0).toLocaleString('id-ID')}</b>\n\n`;
    });

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]] }
    });
  } catch (e) {
    logger.error('Error reseller_top_all:', e.message);
  }
});

bot.action('reseller_komisi', async (ctx) => {
  const userId = ctx.from.id;
  try {
    await ctx.answerCbQuery();
    const user = await dbGetAsync('SELECT role, reseller_level FROM users WHERE user_id = ?', [userId]);
    
    if (!user || user.role !== 'reseller') {
      return ctx.reply('<b>❌ AKSES DITOLAK</b>\nFitur ini hanya untuk Reseller.', { parse_mode: 'HTML' });
    }

    const summary = await dbGetAsync('SELECT COUNT(*) AS total_akun, SUM(komisi) AS total_komisi FROM reseller_sales WHERE reseller_id = ?', [userId]);
    const rows = await dbAllAsync('SELECT akun_type, username, komisi, created_at FROM reseller_sales WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 5', [userId]);

    const level = user.reseller_level ? user.reseller_level.toUpperCase() : 'SILVER';

    let message = '<b>💰 STATISTIK KOMISI RESELLER</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n';
    message += `🎖️ Level  : <b>${level}</b>\n`;
    message += `🛒 Terjual: <code>${summary.total_akun} Akun</code>\n`;
    message += `💸 Total  : <b>Rp ${(summary.total_komisi || 0).toLocaleString('id-ID')}</b>\n`;
    message += '━━━━━━━━━━━━━━━━━━━━━━\n\n';
    message += '<b>📜 5 TRANSAKSI TERAKHIR:</b>\n';

    if (rows.length === 0) {
      message += '<i>Belum ada riwayat transaksi.</i>';
    } else {
      rows.forEach(r => {
        const tgl = new Date(r.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
        message += `🔹 [${tgl}] <code>${r.username}</code> (+Rp ${r.komisi.toLocaleString('id-ID')})\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]] }
    });
  } catch (err) {
    logger.error('Error reseller_komisi:', err.message);
  }
});

bot.action('reseller_riwayat', async (ctx) => {
  const userId = ctx.from.id;
  try {
    await ctx.answerCbQuery();
    const rows = await dbAllAsync(`
      SELECT r.akun_type, r.username, r.komisi, r.created_at,
      (SELECT i.harga FROM invoice_log i WHERE i.akun = r.username ORDER BY i.created_at DESC LIMIT 1) AS harga_jual
      FROM reseller_sales r
      WHERE r.reseller_id = ?
      ORDER BY r.created_at DESC LIMIT 10
    `, [userId]);

    if (!rows || rows.length === 0) {
      return ctx.editMessageText('<b>📭 BELUM ADA RIWAYAT PENJUALAN</b>', { parse_mode: 'HTML' });
    }

    let message = '<b>📊 RIWAYAT PENJUALAN TERAKHIR</b>\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

    rows.forEach((row, i) => {
      const tgl = new Date(row.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const harga = row.harga_jual ? `Rp ${row.harga_jual.toLocaleString('id-ID')}` : '<i>N/A</i>';

      message += `${i + 1}. 🎫 <b>${row.akun_type.toUpperCase()}</b>\n`;
      message += `   👤 User : <code>${escapeHTML(row.username)}</code>\n`;
      message += `   💵 Harga: ${harga} | 💰 Cuan: <b>Rp ${row.komisi.toLocaleString('id-ID')}</b>\n`;
      message += `   🕒 <i>${tgl} WIB</i>\n\n`;
    });

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_reseller' }]] }
    });
  } catch (err) {
    logger.error('Error reseller_riwayat:', err.message);
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

  const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'User';

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial ZIVPN berjalan, cek DM ya bro!');
  }

  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

    // 5️⃣ UPDATE COUNTER SERVER & SIMPAN LOG
    // Tambahkan penambahan counter total_create_akun di server
    await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);
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
    
      const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;
      const notifHtml = `
╭─〔 <b>⏳ TRIAL ACCOUNT </b> 〕
│
├─ 👤 <b>User:</b> ${userMention} (<i>${userId}</i>)
├─ 🔖 <b>Protocol:</b> UDP ZIVPN
│
├─ 📋 <b>Info Trial</b>
│  ├ Server : ${escapeHtml(namaServer)}
│  └ Expired: ${escapeHtml(d.expired)}
│
├─ 🕐 <b>Waktu:</b> ${timestamp} WIB
│
╰───────────────────────`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    console.error('❌ Error trial ZIVPN:', err);
    await bot.telegram.sendMessage(chatId, '❌ Terjadi kesalahan sistem.');
  }
});

bot.action(/^trial_server_ssh_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  
  const mention = ctx.from.username
    ? `@${ctx.from.username}`
    : ctx.from.first_name || 'User';

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      console.error('Error connecting to trial API:', err?.message || err);
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

    // ---------- 5) UPDATE SERVER COUNTER, INSERT LOG & KIRIM PESAN ----------
    // Tambahkan counter di database server
    await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);
    
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

      const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;
      const notifHtml = `
╭─〔 <b>⏳ TRIAL ACCOUNT</b> 〕
│
├─ 👤 <b>User:</b> ${userMention} (<i>${userId}</i>)
├─ 🔖 <b>Protocol:</b> SSH
│
├─ 📋 <b>Info Trial</b>
│  ├ Server : ${escapeHtml(server.nama_server)}
│  ├ Durasi : 60 Menit
│  └ Expired: ${escapeHtml(expired)}
│
├─ 🕐 <b>Waktu:</b> ${timestamp} WIB
│
╰───────────────────────`.trim();

      await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' }).catch(() => {});
    }

  } catch (err) {
    console.error('Error in SSH handler:', err);
    await bot.telegram.sendMessage(chatId, '❌ Terjadi error saat proses trial SSH.');
  }
});

bot.action(/^trial_server_vmess_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;

  const mention = ctx.from.username 
    ? `@${ctx.from.username}` 
    : ctx.from.first_name || 'User';

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      console.error('Error call trialvmess API:', e?.message || e);
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

    // ---------- 5) UPDATE SERVER COUNTER, INSERT LOG & KIRIM PESAN ----------
    // Tambahkan hitungan akun di database server
    await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);

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

      const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;
      const notifHtml = `
╭─〔 <b>⏳ TRIAL ACCOUNT</b> 〕
│
├─ 👤 <b>User:</b> ${userMention} (<i>${userId}</i>)
├─ 🔖 <b>Protocol:</b> VMESS
│
├─ 📋 <b>Info Trial</b>
│  ├ Server : ${escapeHtml(namaServer)}
│  └ Expired: ${escapeHtml(expiration)}
│
├─ 🕐 <b>Waktu:</b> ${timestamp} WIB
│
╰───────────────────────`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    console.error('❌ Error trial VMESS:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial VMESS.');
  }
});

bot.action(/^trial_server_vless_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  
  const mention = ctx.from.username 
    ? `@${ctx.from.username}` 
    : ctx.from.first_name || 'User';

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      console.error('❌ Gagal call API trialvless:', e?.message || e);
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

    // ---------- 5) UPDATE COUNTER SERVER, INSERT LOG & KIRIM PESAN ----------
    // Tambah hitungan akun yang dibuat pada server ini
    await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);

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

      const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;
      const notifHtml = `
╭─〔 <b>⏳ TRIAL ACCOUNT</b> 〕
│
├─ 👤 <b>User:</b> ${userMention} (<i>${userId}</i>)
├─ 🔖 <b>Protocol:</b> VLESS
│
├─ 📋 <b>Info Trial</b>
│  ├ Server : ${escapeHtml(namaServer)}
│  └ Expired: ${escapeHtml(expired)}
│
├─ 🕐 <b>Waktu:</b> ${timestamp} WIB
│
╰───────────────────────`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    console.error('❌ Gagal proses trial VLESS:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial VLESS.');
  }
});

bot.action(/^trial_server_trojan_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  
  const mention = ctx.from.username 
    ? `@${ctx.from.username}` 
    : ctx.from.first_name || 'User';

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      console.error('❌ Gagal call API trialtrojan:', e?.message || e);
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

    // ---------- 5) UPDATE COUNTER SERVER, INSERT LOG & KIRIM PESAN ----------
    // Tambah counter akun di server
    await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);

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

      const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;
      const notifHtml = `
╭─〔 <b>⏳ TRIAL ACCOUNT</b> 〕
│
├─ 👤 <b>User:</b> ${userMention} (<i>${userId}</i>)
├─ 🔖 <b>Protocol:</b> TROJAN
│
├─ 📋 <b>Info Trial</b>
│  ├ Server : ${escapeHtml(namaServer)}
│  └ Expired: ${escapeHtml(expired)}
│
├─ 🕐 <b>Waktu:</b> ${timestamp} WIB
│
╰───────────────────────`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {}
    }

  } catch (err) {
    console.error('❌ Gagal proses trial TROJAN:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial TROJAN.');
  }
});

// === TRIAL SHADOWSOCKS — mirror createshadowsocks (kotak + codeblock) + notif tetap ===
bot.action(/^trial_server_shadowsocks_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  const rawName = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
  const mention = escapeMarkdown(rawName);

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
      console.error('❌ Gagal call API trialshadowsocks:', e?.message || e);
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
      console.warn('Claim trial Shadowsocks failed due to limit/race for user', userId);
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
      const headerText = '⏰ <b>TRIAL ACCOUNT SHADOWSOCKS</b>';
      const notifHtml = `
<blockquote>
${headerText}
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
🏷 <b>Trial By:</b> ${roleLabel.toUpperCase()} | ${trialKe} dari ${check.maxTrial === Infinity ? '∞' : check.maxTrial}
📝 <b>Protocol:</b> <code>SHADOWSOCKS</code>
🌐 <b>Server:</b> ${namaServer}
⏳ <b>Duration:</b> 60 Minutes
🕒 <b>Time:</b> <b>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</b>
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {
        console.warn('Gagal kirim notif SHADOWSOCKS:', e && e.message);
      }
    }

  } catch (err) {
    console.error('❌ Gagal proses trial SHADOWSOCKS:', err);
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
  const state = userState[userId]; // ✅ FIX

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
function toTitleCase(str) {
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
      }

      function maskUsername(uname) {
  if (!uname) return uname;
  if (uname.length <= 2) return uname;
  
  return uname.slice(0, 2) + 'x'.repeat(uname.length - 2 + 1);
}
bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;
  const text = ctx.message.text ? ctx.message.text.trim() : '';
  
  // Ambil state masing-masing
  const stateKms = komisiState[userId];
  const stateUser = userState[chatId];

  // Helper escape HTML
  const escapeHtml = (str) => !str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  try {
    // =================================================================
    // LOGIC 1: TAMBAH KOMISI MANUAL (ADMIN)
    // =================================================================
    if (stateKms && adminIds.includes(userId)) {
      if (stateKms.step === 'WAIT_ID') {
        const user = await dbGetAsync("SELECT user_id, username, role FROM users WHERE user_id = ?", [text]);
        if (!user) return ctx.reply('❌ ID tidak ditemukan. Masukkan ID yang benar:');
        if (user.role !== 'reseller') return ctx.reply('⚠️ User ini bukan Reseller. Masukkan ID lain:');

        komisiState[userId] = { step: 'WAIT_AMOUNT', targetId: text, targetName: user.username || text };
        return ctx.reply(`✅ Reseller: *${komisiState[userId].targetName}*\n\n💰 **Langkah 2:**\nMasukkan jumlah komisi (Angka saja):`, { parse_mode: 'Markdown' });
      }

      if (stateKms.step === 'WAIT_AMOUNT') {
        const amount = parseInt(text);
        if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Nominal harus angka positif.');
        const { targetId, targetName } = stateKms;

        try {
          await dbRunAsync("BEGIN TRANSACTION");
          
          await dbRunAsync(`INSERT INTO reseller_sales (reseller_id, buyer_id, akun_type, username, komisi, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))`, [targetId, userId, 'MANUAL_ADD', targetName, amount]);
            
          await dbRunAsync("COMMIT");

          delete komisiState[userId];
          ctx.reply(`🚀 **SUKSES!**\nKomisi *Rp ${amount.toLocaleString()}* telah ditambahkan ke database komisi *${targetName}*.\n\nUser harus melakukan 'Tarik Komisi' untuk memindahkannya ke saldo utama.`, { parse_mode: 'Markdown' });
          
          bot.telegram.sendMessage(targetId, `🎁 **Bonus Komisi!**\nAdmin telah menambahkan komisi ke akun Anda sebesar *Rp ${amount.toLocaleString()}*.\n\nSilakan cek di menu Reseller dan lakukan penarikan ke saldo utama.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (err) {
          await dbRunAsync("ROLLBACK");
          ctx.reply('❌ Gagal simpan ke database.');
        }
        return; 
      }
    }

    // =================================================================
    // LOGIC 2: FITUR LAINNYA (EVENT, SSH, ZIVPN, DLL) - Menggunakan userState
    // =================================================================
    if (!stateUser || typeof stateUser !== 'object') {
      // ✅ FALLBACK: Jika tidak ada state aktif, abaikan input
      return;
    }

    // Gunakan alias 'state' untuk kemudahan
    const state = stateUser;
    
    // =================================================================
    // TARIK KOMISI MANUAL
    // =================================================================
    if (state.step === 'WAIT_CLAIM_NOMINAL') {
      const nominalTarik = parseInt(text);

      if (isNaN(nominalTarik) || nominalTarik <= 0) {
        return ctx.reply('❌ Masukkan nominal angka yang benar.');
      }

      const komisiRow = await dbGetAsync('SELECT SUM(komisi) AS total FROM reseller_sales WHERE reseller_id = ?', [userId]);
      const totalKomisi = komisiRow?.total || 0;

      if (nominalTarik > totalKomisi) {
        return ctx.reply(`❌ Komisi tidak cukup! Komisi kamu saat ini: Rp ${totalKomisi.toLocaleString('id-ID')}`);
      }

      try {
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [nominalTarik, userId]);
        
        await dbRunAsync(
          "INSERT INTO reseller_sales (reseller_id, buyer_id, akun_type, username, komisi, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
          [userId, 0, 'PENARIKAN', 'CUSTOM_CLAIM', -nominalTarik]
        );

        const refId = `CLAIM-${Date.now()}`;
        await dbRunAsync(
          "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
          [userId, nominalTarik, 'claim_komisi', refId, Date.now()]
        );

        if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
          const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'User';
          const userMention = `<a href="tg://user?id=${userId}">${mention}</a>`;
          const timestamp = new Date().toLocaleString('id-ID', { 
            timeZone: 'Asia/Jakarta', 
            day: '2-digit', 
            month: 'short', 
            year: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit' 
          });

          const groupNotif = `
╭─〔 <b>💰 PENARIKAN KOMISI</b> 〕
│
├─ 👤 <b>Informasi User</b>
│ ├ User : ${userMention}
│ ├ ID : <code>${userId}</code>
│ └ Role : RESELLER
│
├─ 💸 <b>Detail Penarikan</b>
│ ├ Nominal : <b>Rp ${nominalTarik.toLocaleString('id-ID')}</b>
│ ├ Ref ID : <code>${refId}</code>
│ └ Status : ✅ BERHASIL
│
├─ 🕐 <b>Waktu Transaksi</b>
│ └ ${timestamp} WIB
│
╰───────────────────────
`.trim();

          try {
            await bot.telegram.sendMessage(GROUP_ID, groupNotif, { parse_mode: 'HTML' });
          } catch (e) {
            logger.warn('⚠️ Gagal kirim notif tarik komisi ke group: ' + e.message);
          }
        }

        delete userState[chatId];
        return ctx.reply(`✅ <b>BERHASIL!</b>\n\nKomisi sebesar <b>Rp ${nominalTarik.toLocaleString('id-ID')}</b> telah dipindahkan ke saldo utama.`, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error('Error Tarik Komisi: ' + err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memproses data.');
      }
    }

    // --- SETUP EVENT BARU ---
    if (state.step === 'await_event_name') {
      state.nama = text;
      state.step = 'await_event_target';
      return ctx.reply("🎯 *Masukkan Target Penjualan (Angka):*", { parse_mode: 'Markdown' });
    }
    
    if (state.step === 'await_event_target') {
      state.target = parseInt(text);
      state.step = 'await_event_bonus';
      return ctx.reply("💰 *Masukkan Bonus Saldo (Angka):*", { parse_mode: 'Markdown' });
    }
    
    if (state.step === 'await_event_bonus') {
      state.bonus = parseInt(text);
      state.step = 'await_event_date';
      return ctx.reply("📅 *Masukkan Tanggal Berakhir (YYYY-MM-DD):*", { parse_mode: 'Markdown' });
    }
    
    if (state.step === 'await_event_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return ctx.reply("❌ Format salah! Gunakan YYYY-MM-DD");
      }
      const startDate = new Date().toISOString().split('T')[0];
      await dbRunAsync("UPDATE reseller_events SET is_active = 0");
      await dbRunAsync(
        "INSERT INTO reseller_events (nama_event, target_penjualan, bonus_saldo, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?, 1)",
        [state.nama, state.target, state.bonus, startDate, text]
      );
      delete userState[chatId];
      return ctx.reply("✅ *Event Berhasil Diaktifkan!*", { parse_mode: 'Markdown' });
    }

    // =====================================
    // ZIVPN USERNAME (CREATE)
    // =====================================
    if (state.type === 'zivpn' && state.step === 'username_create_zivpn') {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text)) {
        return ctx.reply(
          '❌ *Password ZIVPN harus huruf & angka (3–20 karakter)*',
          { parse_mode: 'Markdown' }
        );
      }

      state.username = text;
      state.password = text;
      state.step = 'exp_create_zivpn';

      return ctx.reply(
        '⏳ *Masukkan masa aktif (hari):*',
        { parse_mode: 'Markdown' }
      );
    }

    // =====================================
    // ZIVPN RENEW - INPUT PASSWORD
    // =====================================
    if (state.type === 'zivpn' && state.action === 'renew' && state.step === 'username_renew_zivpn') {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text)) {
        return ctx.reply(
          '❌ *Password ZIVPN harus huruf & angka (3–20 karakter)*',
          { parse_mode: 'Markdown' }
        );
      }

      state.username = text;
      state.password = text;
      state.step = 'exp_renew_zivpn';

      return ctx.reply(
        '⏳ *Masukkan tambahan masa aktif (hari):*',
        { parse_mode: 'Markdown' }
      );
    }

    // =====================================
    // USERNAME GENERIC (NON-ZIVPN)
    // =====================================
    if (typeof state.step === 'string' && state.step.startsWith('username_') && state.type !== 'zivpn') {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text)) {
        return ctx.reply(
          '❌ *Username tidak valid.*',
          { parse_mode: 'Markdown' }
        );
      }

      state.username = text;

      if (state.action === 'create' && state.type === 'ssh') {
        state.step = `password_${state.action}_${state.type}`;
        return ctx.reply(
          '🔑 *Masukkan password:*',
          { parse_mode: 'Markdown' }
        );
      }

      state.step = `exp_${state.action}_${state.type}`;
      return ctx.reply(
        '⏳ *Masukkan masa aktif (hari):*',
        { parse_mode: 'Markdown' }
      );
    }

    // =====================================
    // PASSWORD SSH
    // =====================================
    if (state.step && state.step.startsWith('password_')) {
      if (!/^[a-zA-Z0-9]{6,}$/.test(text)) {
        return ctx.reply(
          '❌ *Password minimal 6 karakter & tanpa simbol.*',
          { parse_mode: 'Markdown' }
        );
      }

      state.password = text;
      state.step = `exp_${state.action}_${state.type}`;
      return ctx.reply(
        '⏳ *Masukkan masa aktif (hari):*',
        { parse_mode: 'Markdown' }
      );
    }

    // =====================================
    // EXPIRED DAYS (SEMUA SERVICE)
    // =====================================
    if (state.step && state.step.startsWith('exp_')) {
      const days = parseInt(text);
      if (isNaN(days) || days <= 0 || days > 365) {
        return ctx.reply(
          '❌ *Masa aktif tidak valid (1-365 hari).*',
          { parse_mode: 'Markdown' }
        );
      }

      let { username, password, serverId, type, action } = state;
      state.exp = days;
      
      const server = await dbGetAsync(`
        SELECT nama_server, domain, quota, iplimit, harga 
        FROM Server 
        WHERE id = ?
      `, [serverId]);

      let user = await dbGetAsync('SELECT saldo, role, reseller_level FROM users WHERE user_id = ?', [userId]);

      if (!user) {
        await dbRunAsync(
          `INSERT INTO users (user_id, username, saldo, role, reseller_level) VALUES (?, ?, 0, 'user', 'silver')`,
          [userId, ctx.from.username || ctx.from.first_name || '']
        );
        user = { saldo: 0, role: 'user', reseller_level: 'silver' };
      }

      if (!server) {
        return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      if (action === 'create') {
        const existed = await dbGetAsync(
          'SELECT 1 AS ada FROM akun_aktif WHERE username = ? AND jenis = ?',
          [username, type]
        );
        if (existed) {
          return ctx.reply('❌ *Username sudah dipakai. Silakan gunakan username lain.*', {
            parse_mode: 'Markdown'
          });
        }
      }

      const dailyQuota = server.quota;
      const totalQuota = dailyQuota * days;

      const diskon = user.role === 'reseller'
        ? (user.reseller_level === 'gold' ? 0.3
          : user.reseller_level === 'platinum' ? 0.4
          : 0.2)
        : 0;

      const totalHargaKotor = Number(server.harga) * Number(days);
      const totalHarga = Math.floor(totalHargaKotor * (1 - diskon)); 
      
      // Komisi ini opsional, kalau mau ada ya hitung, tapi jangan di-update ke saldo langsung
      const komisi = user.role === 'reseller' ? Math.floor(totalHarga * 0.1) : 0;

      if (user.saldo < totalHarga) {
        return ctx.reply('❌ *Saldo tidak mencukupi.*', { parse_mode: 'Markdown' });
      }

      if (action === 'renew') {
        const row = await dbGetAsync(
          'SELECT * FROM akun_aktif WHERE username = ? AND jenis = ?',
          [username, type]
        );
        if (!row) {
          return ctx.reply('❌ *Akun tidak ditemukan atau tidak aktif.*', { parse_mode: 'Markdown' });
        }
      }

      await dbRunAsync('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [totalHarga, userId]);

      const handlerMap = {
        create: {
          vmess: () => createvmess(username, days, totalQuota, server.iplimit, serverId),
          vless: () => createvless(username, days, totalQuota, server.iplimit, serverId),
          trojan: () => createtrojan(username, days, totalQuota, server.iplimit, serverId),
          shadowsocks: () => createshadowsocks(username, days, totalQuota, server.iplimit, serverId),
          ssh: () => createssh(username, password, days, server.iplimit, serverId),
          zivpn: () => createzivpn(password, days, server.iplimit, serverId)
        },
        renew: {
          vmess: () => renewvmess(username, days, totalQuota, server.iplimit, serverId),
          vless: () => renewvless(username, days, totalQuota, server.iplimit, serverId),
          trojan: () => renewtrojan(username, days, totalQuota, server.iplimit, serverId),
          shadowsocks: () => renewshadowsocks(username, days, totalQuota, server.iplimit, serverId),
          ssh: () => renewssh(username, days, server.iplimit, serverId),
          zivpn: () => renewzivpn(password, days, server.iplimit, serverId)
        }
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
        logger.error('❌ Error pada handler create/renew:', e && e.stack ? e.stack : String(e));
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [totalHarga, userId]);
        return ctx.reply('❌ *Terjadi kesalahan saat membuat akun. Saldo kamu sudah dikembalikan.*', {
          parse_mode: 'Markdown'
        });
      }

            // GANTI BAGIAN YANG TADI (if !msg) JADI SEPERTI INI:
      if (!result || result.status === 'error') {
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [totalHarga, userId]);
        const errorText = (result && result.message) ? result.message : 'Terjadi kesalahan sistem.';
        return ctx.reply(errorText, {
          parse_mode: 'Markdown'
        });
      }

      if (action === 'create') {
        await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);
        await dbRunAsync('INSERT OR REPLACE INTO akun_aktif (username, jenis) VALUES (?, ?)', [username, type]);
      }

      if (user.role === 'reseller') {
        await updateEventProgress(userId, days);
      }

            // 1. Ambil teks config yang sudah jadi dari hasil 'createssh'
      const teksConfigLengkap = result.message;

      // 2. SIMPAN KE DATABASE (Tambahkan kolom config_text)
      await dbRunAsync(`
        INSERT INTO invoice_log (
          user_id, 
          username, 
          layanan, 
          akun, 
          hari, 
          harga, 
          komisi, 
          protocol, 
          config_text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        userId, 
        ctx.from.username || ctx.from.first_name, 
        server.nama_server, 
        username, 
        days, 
        totalHarga, 
        komisi,
        type.toUpperCase(),
        teksConfigLengkap
      ]);

            if (user.role === 'reseller') {
        // --- BARIS UPDATE SALDO DI BAWAH INI DIHAPUS/KOMEN ---
        // await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [komisi, userId]);

        // Tetap catat di tabel reseller_sales agar komisi terkumpul di menu Reseller
        await dbRunAsync(`
          INSERT INTO reseller_sales (reseller_id, buyer_id, akun_type, username, komisi, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `, [userId, userId, type, username, komisi]);

        // Logika Level Up tetap biarkan di sini
        const res = await dbGetAsync('SELECT SUM(komisi) AS total_komisi FROM reseller_sales WHERE reseller_id = ?', [userId]);
        const totalKomisi = res?.total_komisi || 0;
        const prevLevel = user.reseller_level || 'silver';
        
        // Penentuan Level berdasarkan total akumulasi komisi
        const level = totalKomisi >= 30000 ? 'platinum' : totalKomisi >= 20000 ? 'gold' : 'silver';
        const levelOrder = { silver: 1, gold: 2, platinum: 3 };

        if (level !== prevLevel) {
          await dbRunAsync('UPDATE users SET reseller_level = ? WHERE user_id = ?', [level, userId]);

          if (GROUP_ID) {
            const mentionLevel = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
            const naik = levelOrder[level] > levelOrder[prevLevel];
            const icon = naik ? '📈 *Level Naik!*' : '📉 *Level Turun!*';
            const notif = `${icon}\n\n💌 ${mentionLevel}\n🎖️ Dari: *${prevLevel.toUpperCase()}* ke *${level.toUpperCase()}*`;
            await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: 'Markdown' }).catch(() => {});
          }
        }
      }

      const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'User';

      const isReseller = user?.role === 'reseller';
      const roleLabel = isReseller ? 'RESELLER' : 'USER';
      const headerText = action === 'renew' ? '🔄 ACCOUNT RENEWED' : '✅ ACCOUNT CREATED';

      const serverNama = server?.nama_server || server?.domain || 'Unknown Server';
      const ipLimit = server?.iplimit || '-';
      const durasiHari = days || 30;
      
      const timestamp = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
          
      const userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mention)}</a>`;

      const invoiceHtml = `
╭─〔 <b>${headerText}</b> 〕
│
├─ 👤 <b>User</b> : ${userMention} (<i>${userId}</i>)
├─ 🔖 <b>Protocol</b> : ${toTitleCase(type)}
│
├─ 📋 <b>Detail Akun</b>
│  ├ Username : <code>${escapeHtml(maskUsername(username))}</code>
│  ├ Server   : ${escapeHtml(serverNama)}
│  ├ IP Limit : ${ipLimit} IP
│  └ Durasi   : ${durasiHari} Hari
│
├─ 🕐 <b>Waktu Transaksi</b>
│  └ ${timestamp} WIB
│
╰───────────────────────
      `.trim();

      if (GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, invoiceHtml, {
          parse_mode: 'HTML'
        }).catch(() => {});
      }

      await ctx.reply(result.message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      delete userState[chatId];
      return;
    }
  
    // =====================================
    // ADMIN: UBAH LEVEL RESELLER
    // =====================================
    if (state.step === 'await_level_change') {
      const [idStr, level] = text.split(' ');
      const validLevels = ['silver', 'gold', 'platinum'];
      const targetId = parseInt(idStr);

      if (isNaN(targetId) || !validLevels.includes(level)) {
        return ctx.reply('❌ *Format salah.*\nContoh: `123456789 gold`\nLevel valid: silver, gold, platinum', {
          parse_mode: 'Markdown'
        });
      }

      db.run(
        `UPDATE users SET reseller_level = ? WHERE user_id = ? AND role = 'reseller'`,
        [level, targetId],
        function (err) {
          if (err) {
            logger.error('❌ DB error saat ubah level:', err.message);
            return ctx.reply('❌ *Gagal mengubah level reseller.*', { parse_mode: 'Markdown' });
          }

          if (this.changes === 0) {
            return ctx.reply('⚠️ *User tidak ditemukan atau bukan reseller.*', { parse_mode: 'Markdown' });
          }

          ctx.reply(`✅ *User ${targetId} diubah menjadi reseller ${level.toUpperCase()}.*`, {
            parse_mode: 'Markdown'
          });
        }
      );

      delete userState[ctx.chat.id];
      return;
    }

    // =====================================
    // ADMIN: DOWNGRADE RESELLER
    // =====================================
    if (state.step === 'await_downgrade_id') {
      const targetId = parseInt(text);
      if (isNaN(targetId)) {
        return ctx.reply('❌ *ID tidak valid.*', { parse_mode: 'Markdown' });
      }

      db.run(
        `UPDATE users SET role = 'user', reseller_level = NULL WHERE user_id = ?`,
        [targetId],
        function (err) {
          if (err) {
            logger.error('❌ DB error saat downgrade reseller:', err.message);
            return ctx.reply('❌ *Gagal downgrade user.*', { parse_mode: 'Markdown' });
          }

          if (this.changes === 0) {
            return ctx.reply('⚠️ *User belum terdaftar.*', { parse_mode: 'Markdown' });
          }

          ctx.reply(`✅ *User ${targetId} telah di-downgrade menjadi USER biasa.*`, {
            parse_mode: 'Markdown'
          });
        }
      );

      delete userState[ctx.chat.id];
      return;
    }

    // =====================================
    // ADMIN: PROMOTE RESELLER
    // =====================================
    if (state.step === 'await_reseller_id') {
      const targetId = parseInt(text);
      if (isNaN(targetId)) {
        return ctx.reply('⚠️ *ID tidak valid. Masukkan angka.*', { parse_mode: 'Markdown' });
      }

      db.run(
        `UPDATE users SET role = 'reseller', reseller_level = 'silver' WHERE user_id = ?`,
        [targetId],
        function (err) {
          if (err) {
            logger.error('❌ DB error saat promote:', err.message);
            return ctx.reply('❌ *Gagal promote user.*', { parse_mode: 'Markdown' });
          }

          if (this.changes === 0) {
            return ctx.reply('⚠️ *User belum terdaftar.*', { parse_mode: 'Markdown' });
          }

          ctx.reply(`✅ *User ${targetId} sukses dipromosikan jadi RESELLER level Silver!*`, {
            parse_mode: 'Markdown'
          });
        }
      );

      delete userState[ctx.chat.id];
      return;
    }

    // =====================================
    // ADMIN: RESET KOMISI
    // =====================================
    if (state.step === 'reset_komisi_input') {
      const targetId = parseInt(text);
      if (isNaN(targetId)) {
        return ctx.reply('❌ User ID tidak valid. Masukkan angka.', {
          parse_mode: 'Markdown'
        });
      }

      try {
        await dbRunAsync('DELETE FROM reseller_sales WHERE reseller_id = ?', [targetId]);
        await dbRunAsync('UPDATE users SET reseller_level = ? WHERE user_id = ?', ['silver', targetId]);

        await ctx.reply(`✅ Komisi user ${targetId} berhasil direset.`, {
          parse_mode: 'Markdown'
        });

        if (GROUP_ID) {
          const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
          const notif = `🧹 Reset Komisi Reseller\n\n👤 Oleh: ${mention}\n🆔 User ID: ${targetId}\n📉 Komisi & level direset.`;
          await bot.telegram.sendMessage(GROUP_ID, notif, {
            parse_mode: 'Markdown'
          }).catch(() => {});
        }

      } catch (err) {
        logger.error('❌ Gagal reset komisi:', err.message);
        await ctx.reply('❌ Terjadi kesalahan saat reset komisi.', {
          parse_mode: 'Markdown'
        });
      }

      delete userState[ctx.chat.id];
      return;
    }

    // =====================================
// ADMIN: BROADCAST MESSAGE
// =====================================
if (state && state.step === 'await_broadcast_message') {
  if (!adminIds.includes(userId)) {
    return ctx.reply('❌ Kamu tidak punya izin untuk broadcast.');
  }

  const text = ctx.message.text;

  // 🧠 simpan state
  state.messageId = ctx.message.message_id;
  state.chatId = chatId;
  state.broadcastText = text;

  return ctx.reply(
    '📣 *Konfirmasi Broadcast TEXT*\n\n' +
    `📝 Pesan: _${text.substring(0, 100)}${text.length > 100 ? '...' : ''}_\n\n` +
    `Kirim ke semua user?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ya, Kirim Sekarang', callback_data: 'broadcast_text_confirm' }
          ],
          [
            { text: '❌ Batalkan', callback_data: 'cancel_broadcast' }
          ]
        ]
      },
      parse_mode: 'Markdown'
    }
  );
}

    // =====================================
    // PAKASIR: REQUEST AMOUNT
    // =====================================
    if (state.step === 'request_pakasir_amount') {
      const amount = parseInt(text, 10);

      if (isNaN(amount) || amount < (MIN_DEPOSIT_AMOUNT || 1000)) {
        return ctx.reply(
          `❌ *Nominal tidak valid.* Masukkan angka yang valid (minimal Rp ${(MIN_DEPOSIT_AMOUNT || 1000).toLocaleString('id-ID')}).`,
          { parse_mode: 'Markdown' }
        );
      }

      await ctx.reply(
        `💰 *Konfirmasi Top Up Saldo (Otomatis)*\n\n` +
        `• *Nominal:* Rp ${amount.toLocaleString('id-ID')}\n\n` +
        `Silakan tekan tombol di bawah, dan QRIS akan langsung muncul otomatis.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `🧾 Buat Pembayaran Rp ${amount.toLocaleString('id-ID')}`,
                  callback_data: `create_pakasir_payment_${amount}`
                }
              ],
              [
                { text: '❌ Batalkan', callback_data: 'send_main_menu' }
              ]
            ]
          },
          parse_mode: 'Markdown'
        }
      );

      delete userState[ctx.chat.id];
      return;
    }

    // =====================================
    // ADD SERVER: STEP-BY-STEP
    // =====================================
    if (state.step === 'addserver') {
      const domain = text;
      if (!domain) return ctx.reply('⚠️ *Domain tidak boleh kosong.* Silakan masukkan domain server yang valid.', { parse_mode: 'Markdown' });
      state.domain = domain;
      state.step = 'addserver_auth';
      return ctx.reply('🔑 *Silakan masukkan auth server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_auth') {
      const auth = text;
      if (!auth) return ctx.reply('⚠️ *Auth tidak boleh kosong.* Silakan masukkan auth server yang valid.', { parse_mode: 'Markdown' });
      state.auth = auth;
      state.step = 'addserver_nama_server';
      return ctx.reply('🏷️ *Silakan masukkan nama server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_nama_server') {
      const nama_server = text;
      if (!nama_server) return ctx.reply('⚠️ *Nama server tidak boleh kosong.*', { parse_mode: 'Markdown' });
      state.nama_server = nama_server;
      state.step = 'addserver_quota';
      return ctx.reply('📊 *Silakan masukkan quota server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_quota') {
      const quota = parseInt(text, 10);
      if (isNaN(quota)) return ctx.reply('⚠️ *Quota tidak valid.*', { parse_mode: 'Markdown' });
      state.quota = quota;
      state.step = 'addserver_iplimit';
      return ctx.reply('🔢 *Silakan masukkan limit IP server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_iplimit') {
      const iplimit = parseInt(text, 10);
      if (isNaN(iplimit)) return ctx.reply('⚠️ *Limit IP tidak valid.*', { parse_mode: 'Markdown' });
      state.iplimit = iplimit;
      state.step = 'addserver_batas_create_akun';
      return ctx.reply('🔢 *Silakan masukkan batas create akun server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_batas_create_akun') {
      const batas = parseInt(text, 10);
      if (isNaN(batas)) return ctx.reply('⚠️ *Batas create akun tidak valid.*', { parse_mode: 'Markdown' });
      state.batas_create_akun = batas;
      state.step = 'addserver_harga';
      return ctx.reply('💰 *Silakan masukkan harga server:*', { parse_mode: 'Markdown' });
    }

    if (state.step === 'addserver_harga') {
      const harga = parseFloat(text);
      if (isNaN(harga) || harga <= 0) return ctx.reply('⚠️ *Harga tidak valid.*', { parse_mode: 'Markdown' });

      const { domain, auth, nama_server, quota, iplimit, batas_create_akun } = state;

      try {
        const resolvedIP = await resolveDomainToIP(domain);
        let isp = 'Tidak diketahui', lokasi = 'Tidak diketahui';

        if (resolvedIP) {
          const info = await getISPAndLocation(resolvedIP);
          isp = info.isp;
          lokasi = info.lokasi;
        }

        db.run(`
          INSERT INTO Server (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, total_create_akun, isp, lokasi)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `, [domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, isp, lokasi], function(err) {
          if (err) {
            logger.error('❌ Error saat tambah server:', err.message);
            ctx.reply('❌ *Gagal menambahkan server.*', { parse_mode: 'Markdown' });
          } else {
            ctx.reply(
              `✅ *Server berhasil ditambahkan!*\n\n` +
              `🌐 Domain: ${domain}\n` +
              `📍 Lokasi: ${lokasi}\n` +
              `🏢 ISP: ${isp}`,
              { parse_mode: 'Markdown' }
            );
          }
        });

      } catch (err) {
        logger.error('❌ Gagal resolve/tambah server:', err.message);
        ctx.reply('❌ *Terjadi kesalahan saat menambahkan server.*', { parse_mode: 'Markdown' });
      }

      delete userState[ctx.chat.id];
      return;
    }

  } catch (err) {
    console.error('❌ Error in text handler:', err);
    logger.error('❌ Error in text handler:', err.stack || err);
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

    const payment = resp.data && (resp.data.payment || resp.data.payment || resp.data);
    // payment likely at resp.data.payment
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
    // if API fails, fallback to web checkout URL (what you already had)
    logger.warn('Pakasir API create failed, falling back to web checkout: ' + (err && (err.message || JSON.stringify(err))));
    const orderId = `PKS-${userId}-${Date.now()}`;
    const redirectUrl = encodeURIComponent((PAKASIR_WEBHOOK_URL || '').replace('/webhook/pakasir', '/topup-success') || '');
    const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_PROJECT_SLUG)}/${encodeURIComponent(amount)}?order_id=${encodeURIComponent(orderId)}&redirect=${redirectUrl}&qris_only=1`;

    await new Promise((resolve, reject) => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.run(`INSERT INTO pending_deposits_pakasir (user_id, order_id, amount, status, payment_method, payment_data, expired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, orderId, amount, 'pending', 'qris', paymentUrl, expiresAt],
          (err2) => {
            if (err2) { logger.error('Error saving pending deposit (fallback):', err2.message); return reject(err2); }
            resolve();
          }
      );
    });

    return { orderId, paymentUrl, qrImageBuffer: null, amount };
  }
}

// --- WEBHOOK HANDLER PAKASIR (Dengan Notifikasi Grup) ---
async function handlePakasirWebhook(payload, botInstance) {
  const { order_id, amount: rawAmount, status, project } = payload;
  const amount = Number(rawAmount || 0);

  if (status !== 'completed' || project !== PAKASIR_PROJECT_SLUG) {
    logger.warn(`Webhook ignored: status/project mismatch. order_id=${order_id} status=${status} project=${project}`);
    return;
  }

  // init processed set bila belum ada
  if (!global.processedTransactions) global.processedTransactions = new Set();
  if (global.processedTransactions.has(order_id)) {
    logger.warn(`Webhook ignored: already processed order_id=${order_id}`);
    return;
  }
  global.processedTransactions.add(order_id);

  // helper: escape HTML untuk aman
  function escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  try {
    // Ambil pending deposit
    const row = await dbGetAsync(
      'SELECT user_id, status FROM pending_deposits_pakasir WHERE order_id = ? AND status = ?',
      [order_id, 'pending']
    );

    if (!row) {
      logger.warn(`Pending deposit not found or already completed for order_id=${order_id}`);
      return;
    }

    const userId = row.user_id;

    // Mulai transaksi DB
    await dbRunAsync('BEGIN TRANSACTION');

    try {
      // Update saldo user
      await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, userId]);

      // Update pending_deposits_pakasir status -> completed
      await dbRunAsync('UPDATE pending_deposits_pakasir SET status = ? WHERE order_id = ?', ['completed', order_id]);
      let usernameLog = String(userId);
      try {
        // Ambil info username sebentar untuk log
        const chat = await botInstance.telegram.getChat(userId);
        usernameLog = chat.username ? `@${chat.username}` : (chat.first_name || String(userId));
      } catch (e) { /* ignore error chat */ }

      // Insert ke topup_log
      await dbRunAsync(
        'INSERT INTO topup_log (user_id, username, amount, reference, metode, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))',
        [userId, usernameLog, amount, order_id, `Pakasir (${payload.payment_method || 'QRIS'})`]
      );

      // Commit jika semua sukses
      await dbRunAsync('COMMIT');
      logger.info(`Top up committed: order_id=${order_id} user=${userId} amount=${amount}`);
    } catch (txErr) {
      // Rollback jika gagal
      try { await dbRunAsync('ROLLBACK'); } catch (rbErr) { logger.error(`Rollback failed: ${rbErr.message}`); }
      logger.error(`DB transaction failed for order_id=${order_id}: ${txErr.message}`);
      return;
    }

    // Ambil detail user terbaru (safe)
    let userAfterTopUp = { saldo: 0, role: 'user' };
    try {
      userAfterTopUp = await getUserDetails(userId);
    } catch (e) {
      logger.warn(`Gagal ambil user details setelah topup untuk user ${userId}: ${e.message}`);
    }

    // Ambil username/mention (jika tersedia)
    let userMention = escapeHtml(String(userId)); // fallback text
    let userTagForUserMsg = String(userId); // fallback for user DM
    try {
      const chat = await botInstance.telegram.getChat(userId);
      const username = chat?.username ? `@${chat.username}` : null;
      const displayName = `${chat?.first_name || ''}${chat?.last_name ? ' ' + chat.last_name : ''}`.trim();

      // untuk pesan ke user, gunakan username jika ada, else userId
      userTagForUserMsg = username || String(userId);

      // untuk group mention: buat mention klikable (tg://user?id=...)
      const mentionText = username || displayName || String(userId);
      userMention = `<a href="tg://user?id=${userId}">${escapeHtml(mentionText)}</a>`;
    } catch (e) {
      // jangan block, pakai userId sebagai fallback
      userMention = `<a href="tg://user?id=${userId}">${escapeHtml(String(userId))}</a>`;
      userTagForUserMsg = String(userId);
    }

    // Timestamp untuk notifikasi
    const timestamp = new Date().toLocaleString('id-ID', { 
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Pesan ke user (rapi & aman)
    const userMessage =
      `<b>✅ TOP UP SALDO BERHASIL (OTOMATIS)</b>\n\n` +
      `📄 <b>Invoice:</b> <code>${escapeHtml(order_id)}</code>\n` +
      `💰 <b>Jumlah:</b> Rp ${Number(amount).toLocaleString('id-ID')}\n` +
      `🏧 <b>Metode:</b> ${escapeHtml(payload.payment_method || 'QRIS')}\n\n` +
      `Saldo Anda telah diperbarui. Terima kasih!`;

    botInstance.telegram.sendMessage(userId, userMessage, { parse_mode: 'HTML' })
      .catch(e => logger.error(`Failed to notify user ${userId}: ${e.message}`));

    // Pesan ke grup/admin (DENGAN GARIS KEREN)
    const groupMessage = `
╭─〔 <b>💰 TRANSAKSI BERHASIL</b> 〕
│
├─ 👤 <b>Informasi User</b>
│  ├ User : ${userMention}
│  ├ ID   : <code>${escapeHtml(String(userId))}</code>
│  └ Role : ${escapeHtml((userAfterTopUp.role || 'user').toString().toUpperCase())}
│
├─ 💵 <b>Detail Pembayaran</b>
│  ├ Nominal Top Up : Rp ${Number(amount).toLocaleString('id-ID')}
│  ├ Saldo Terbaru  : Rp ${Number(userAfterTopUp.saldo || 0).toLocaleString('id-ID')}
│  └ Metode Bayar   : ${escapeHtml(payload.payment_method || 'QRIS')}
│
├─ 📋 <b>Order ID</b>
│  └ <code>${escapeHtml(order_id)}</code>
│
├─ 🕐 <b>Waktu Transaksi</b>
│  └ ${timestamp} WIB
│
╰───────────────────────
    `.trim();

    botInstance.telegram.sendMessage(GROUP_ID, groupMessage, { parse_mode: 'HTML' })
      .catch(e => logger.error(`Failed to notify admin group for order ${order_id}: ${e.message}`));

    logger.info(`Webhook processed successfully: order_id=${order_id}`);
  } catch (err) {
    logger.error(`Error processing Pakasir webhook order_id=${order_id}: ${err && err.message ? err.message : JSON.stringify(err)}`);
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
        await ctx.editMessageText(
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
        await ctx.editMessageText(
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

    await ctx.editMessageText(
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

bot.action('topup_saldo_orderkuota', async (ctx) => {
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

    try {
      await ctx.editMessageText(text, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    } catch (e) {
      // kalau pesan lama nggak bisa di-edit (misalnya pesan biasa), fallback ke reply
      if (!e.description || !e.description.includes('message is not modified')) {
        logger.warn('⚠️ Gagal edit pesan topup, fallback ke reply:', e.message);
      }
      await ctx.reply(text, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }

  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses top-up saldo:', error);
    try {
      await ctx.editMessageText(
        '❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*',
        { parse_mode: 'Markdown' }
      );
    } catch {
      await ctx.reply(
        '❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*',
        { parse_mode: 'Markdown' }
      );
    }
  }
});
bot.action('topup_saldo_pakasir', async (ctx) => {
    try {
        await ctx.answerCbQuery();

        userState[ctx.chat.id] = {
            step: 'request_pakasir_amount',
            amount: ''
        };

        await ctx.editMessageText(
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
    return await ctx.editMessageText(`?? *Masukkan jumlah saldo yang ingin dikurangi:*\n\n💰 ${userStateData.amount}`, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }

  // Hapus angka terakhir
  if (data === 'delete') {
    userStateData.amount = (userStateData.amount || '').slice(0, -1);
    return await ctx.editMessageText(`📉 *Masukkan jumlah saldo yang ingin dikurangi:*\n\n💰 ${userStateData.amount || '0'}`, {
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
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_deposit() }, // ✅ PENTING
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
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
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
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
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
  if (ctx.callbackQuery?.message?.text === newMessage) {
    return;
  }

  try {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: inlineKb },
      parse_mode: 'Markdown'
    });
  } catch (err) {
    const desc = err.description || err.message || '';
    // Abaikan error "message is not modified"
    if (!desc.includes('message is not modified')) {
      console.error('❌ Error editMessageText di handleEditField:', err);
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
        logger.error(`⚠️ Kesalahan saat mengupdate ${fieldName} server:`, err.message);
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
    await ctx.editMessageText('⚠️ *Terlalu banyak permintaan. Silakan tunggu sebentar.*', { parse_mode: 'Markdown' });
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
    const myApiUrl = `https://paksir.sshgreen.cloud/api/generate-qris?amount=${finalAmount}&codeqr=${encodeURIComponent(urlQr)}`;

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
        db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
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
        const success = await processMatchingPayment(deposit, matched, uniqueCode);

        if (success) {
          logger.info(`✅ Pembayaran Berhasil: ${uniqueCode} senilai ${expectedAmount}`);

          // tandai transaksi sudah dipakai
          if (!deposit.usedTx) deposit.usedTx = [];
          deposit.usedTx.push(matched.id);

          // 🎁 BONUS JUMAT
          try {
            const BONUS_THRESHOLD = 5000;
            const BONUS_AMOUNT = 1000;

            const amt = Number(deposit.originalAmount || deposit.amount || 0);
            const nowJakarta = new Date(
              new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })
            );

            if (nowJakarta.getDay() === 5 && amt >= BONUS_THRESHOLD) {
              const today = `${nowJakarta.getFullYear()}-${String(nowJakarta.getMonth() + 1).padStart(2, '0')}-${String(nowJakarta.getDate()).padStart(2, '0')}`;

              db.get(
                "SELECT id FROM weekly_bonus_claims WHERE user_id = ? AND claimed_date = ?",
                [String(deposit.userId), today],
                (chkErr, row) => {
                  if (!row && !chkErr) {
                    db.run(
                      "UPDATE users SET saldo = saldo + ? WHERE user_id = ?",
                      [BONUS_AMOUNT, deposit.userId],
                      (uErr) => {
                        if (!uErr) {
                          db.run(
                            "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                            [deposit.userId, BONUS_AMOUNT, 'bonus', `friday-${Date.now()}`, Date.now()]
                          );

                          db.run(
                            "INSERT INTO weekly_bonus_claims (user_id, amount, claimed_date, reference) VALUES (?, ?, ?, ?)",
                            [String(deposit.userId), BONUS_AMOUNT, today, `ref-${Date.now()}`]
                          );

                          bot.telegram.sendMessage(
                            deposit.userId,
                            `🎉 Bonus Jumat Rp${BONUS_AMOUNT.toLocaleString('id-ID')} ditambahkan!`
                          ).catch(() => {});
                        }
                      }
                    );
                  }
                }
              );
            }
          } catch (e) {
            logger.error('Error Bonus:', e.message);
          }

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
  const refId = matchingTransaction.id ? `orkut_${matchingTransaction.id}` : uniqueCode;
  
  try {
    // 1. Mulai Transaksi
    await dbRunAsync('BEGIN TRANSACTION');

    // 2. Cek Duplikasi
    const existingTx = await new Promise((res) => {
      db.get('SELECT id FROM transactions WHERE reference_id = ?', [refId], (err, row) => res(row));
    });

    if (existingTx) {
      await dbRunAsync('ROLLBACK');
      return false;
    }

    // 3. Update Saldo
    await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [deposit.originalAmount, deposit.userId]);

    // 4. Ambil Username & Saldo Baru
    const userRow = await new Promise((res) => {
      db.get("SELECT username, first_name, saldo FROM Users WHERE user_id = ?", [deposit.userId], (err, row) => res(row));
    });

    let usernameLog = String(deposit.userId);
    if (userRow && userRow.username) {
      usernameLog = `@${userRow.username}`;
    } else if (userRow && userRow.first_name) {
      usernameLog = userRow.first_name;
    }

    // 5. Simpan Log & Transaksi
    await dbRunAsync('INSERT INTO topup_log (user_id, username, amount, reference, metode, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))', 
      [deposit.userId, usernameLog, deposit.originalAmount, refId, 'Orkut (QRIS)']);
    
    await dbRunAsync('INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)', 
      [deposit.userId, deposit.originalAmount, 'deposit', refId, Date.now()]);

    // 6. Selesaikan Transaksi SEBELUM kirim notifikasi (agar DB tidak terkunci lama)
    await dbRunAsync('COMMIT');

    // 7. Notifikasi (Diluar blok transaksi agar tidak membebani DB)
    sendPaymentSuccessNotification(deposit.userId, deposit, userRow.saldo).catch(() => {});
    if (deposit.qrMessageId) {
      bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId).catch(() => {});
    }

    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const groupMessage = `
╭─〔 <b>💰 TRANSAKSI BERHASIL</b> 〕
│
├─ 👤 <b>Informasi User</b>
│  └ ${usernameLog}
│
├─ 💵 <b>Detail Pembayaran</b>
│  ├ Nominal Top Up : Rp ${deposit.originalAmount.toLocaleString('id-ID')}
│  └ Saldo Terbaru  : Rp ${userRow.saldo.toLocaleString('id-ID')}
│
├─ 📋 <b>Referensi</b>
│  └ <code>${refId}</code>
│
├─ 🕐 <b>Waktu Transaksi</b>
│  └ ${timestamp} WIB
│
╰───────────────────────`.trim();

    bot.telegram.sendMessage(GROUP_ID, groupMessage, { parse_mode: 'HTML' }).catch(() => {});
    
    return true;

  } catch (error) {
    logger.error('❌ Error processMatchingPayment:', error.message);
    // Jika error, pastikan balikkan status DB ke normal
    try {
      await dbRunAsync('ROLLBACK');
    } catch (rbErr) {
      // Abaikan jika rollback gagal karena transaksi memang belum mulai
    }
    return false;
  }
}

setInterval(() => {
  if (Object.keys(global.pendingDeposits || {}).length > 0) {
    checkQRISStatus();
  }
}, 30000);

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
app.listen(PORT, () => {
  logger.info(`🚀 Server berjalan di port ${PORT}`);

  const startBot = async (retry = 0) => {
    try {
      await bot.launch();
      logger.info('🤖 Bot Telegram aktif!');
    } catch (err) {
      const MAX_RETRY = 5;
      const delay = Math.min(10000 * (retry + 1), 60000); // max 1 menit

      logger.error(`❌ Error saat memulai bot: ${err.message}`);

      if (
        ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code) ||
        (err.response && err.response.status >= 500)
      ) {
        if (retry < MAX_RETRY) {
          logger.warn(`🔁 Coba reconnect (${retry + 1}/${MAX_RETRY}) dalam ${delay / 1000}s...`);
          setTimeout(() => startBot(retry + 1), delay);
        } else {
          logger.error('🚫 Gagal konek ke Telegram setelah beberapa percobaan. Periksa koneksi VPS.');
        }
      } else {
        logger.error('🚨 Error lain saat start bot. Tidak dilakukan retry.');
      }
    }
  };

  // 🚀 Mulai bot dengan reconnect logic
  startBot();
});