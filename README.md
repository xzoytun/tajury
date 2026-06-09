# XTRIMER PROJECT

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-v20-339933?style=for-the-badge&logo=node.js&logoColor=white)
![SQLite3](https://img.shields.io/badge/SQLite3-3.41.2-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Telegraf](https://img.shields.io/badge/Telegraf-Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)

**Pemilik:** `XTRIMER TUNNEL`  
**Status:** ✅ Stable  

[📖 Documentation](#-deskripsi) • [🚀 Installation](#-instalasi) • [⚡ Features](#-fitur-utama) • [📞 Support](#-support)

</div>

---

## 📜 Deskripsi

**BhotVPN** adalah sistem manajemen akun VPN berbasis **Node.js** dengan integrasi **Telegram Bot** yang menyediakan layanan otomatis dan efisien untuk pengelolaan akun VPN.

### Mengapa BhotVPN?

- ✨ Otomatisasi penuh untuk manajemen akun VPN
- 🔒 Keamanan data dengan SQLite3
- 🤖 Integrasi Telegram Bot untuk kemudahan akses
- 📊 Sistem saldo dan pembayaran terintegrasi
- 🚀 Performa tinggi dengan Node.js v20

---

## ⚡ Fitur Utama

<table>
<thead>
<tr>
<th>Fitur</th>
<th>Deskripsi</th>
<th>Status</th>
</tr>
</thead>
<tbody>
<tr>
<td>🆕 <strong>Service Create</strong></td>
<td>Membuat akun VPN baru secara otomatis</td>
<td>✅ Active</td>
</tr>
<tr>
<td>🔄 <strong>Service Renew</strong></td>
<td>Memperbarui masa aktif akun VPN</td>
<td>✅ Active</td>
</tr>
<tr>
<td>💰 <strong>Top Up Saldo</strong></td>
<td>Menambah saldo akun pengguna</td>
<td>✅ Active</td>
</tr>
<tr>
<td>💳 <strong>Cek Saldo</strong></td>
<td>Memeriksa saldo akun pengguna</td>
<td>✅ Active</td>
</tr>
</tbody>
</table>

---

## 🛠 Teknologi yang Digunakan

| Technology | Version | Purpose |
|------------|---------|---------|
| **Node.js** | v20 | Runtime JavaScript server-side |
| **SQLite3** | 3.41.2 | Database ringan untuk penyimpanan data |
| **Axios** | Latest | HTTP client untuk request API |
| **Telegraf** | Latest | Framework bot Telegram |

---

## 🚀 Instalasi

### Prasyarat

Pastikan sistem Anda memenuhi persyaratan berikut:
- Ubuntu/Debian Linux
- Akses root atau sudo
- Koneksi internet stabil

### Step 1: Install Node.js v20

#### 1️⃣ Install NVM (Node Version Manager)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
```

#### 2️⃣ Load NVM ke Session

```bash
source ~/.bashrc
```

#### 3️⃣ Install Node.js v20

```bash
nvm install 20
```

#### 4️⃣ Gunakan Node.js v20

```bash
nvm use 20
```

#### 5️⃣ Verifikasi Instalasi

```bash
node -v
# Output: v20.x.x
```

#### 6️⃣ Set Node.js v20 sebagai Default (Opsional)

```bash
nvm alias default 20
```

---

### Step 2: Install V2 System

Jalankan perintah berikut untuk instalasi otomatis:

```bash
sysctl -w net.ipv6.conf.all.disable_ipv6=1 \
&& sysctl -w net.ipv6.conf.default.disable_ipv6=1 \
&& apt update -y \
&& apt install -y git curl \
&& curl -L -k -sS https://raw.githubusercontent.com/xzoytun/tajury/main/install -o install \
&& chmod +x install \
&& ./install sellvpn \
&& [ $? -eq 0 ] && rm -f install
```
### Install npm
```
npm install
npm install sqlite3 --save
npm install jsonwebtoken google-auth-library
pm2 restart sellvpn
```
#### Penjelasan Script:
- **Disable IPv6**: Menonaktifkan IPv6 untuk stabilitas
- **Update System**: Memperbarui package list
- **Install Dependencies**: Menginstal git dan curl
- **Download Installer**: Mengunduh script instalasi
- **Execute Installation**: Menjalankan instalasi sellvpn
- **Cleanup**: Menghapus file installer setelah selesai

---

## 📝 Logger System

Sistem logging sederhana untuk monitoring:

```javascript
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

module.exports = logger;
```

### Penggunaan Logger

```javascript
const logger = require('./logger');

logger.info('Server started successfully');
logger.warn('Low balance detected');
logger.error('Failed to create VPN account');
```

---

## 📋 Struktur Project

```
xtrimer-project/
├── src/
│   ├── bot/           # Telegram bot handlers
│   ├── services/      # VPN service logic
│   ├── database/      # SQLite3 database
│   └── utils/         # Utility functions
├── config/            # Configuration files
├── logs/              # Log files
├── package.json       # Dependencies
└── README.md          # Documentation
```

---

## 🔧 Konfigurasi

### Environment Variables

Buat file `.env` di root directory:

```env
BOT_TOKEN=your_telegram_bot_token
API_URL=your_vpn_api_url
DATABASE_PATH=./data/vpn.db
LOG_LEVEL=info
```

---

## 📞 Support

<div align="center">

### Butuh Bantuan?

Jika Anda mengalami masalah atau memiliki pertanyaan, jangan ragu untuk menghubungi kami:

📧 **Email**: support@xtrimertunnel.com  
💬 **Telegram**: [@XtrimerSupport](https://t.me/XtrimerSupport)  
🌐 **Website**: [xtrimertunnel.com](https://xtrimertunnel.com)

</div>

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## ⭐ Show Your Support

Jika project ini membantu Anda, berikan ⭐ di repository ini!

---

<div align="center">

**Made with ❤️ by XTRIMER TUNNEL**

© 2024 XTRIMER PROJECT. All rights reserved.

</div>
