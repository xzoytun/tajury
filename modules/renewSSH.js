const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function renewssh(username, exp, limitip, serverId) {
  console.log(`⚙️ Renewing SSH for ${username} | Exp: ${exp} days | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return { status: 'error', message: '❌ Username tidak valid. Gunakan hanya huruf dan angka tanpa spasi.' };
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        return resolve({ status: 'error', message: '❌ Server tidak ditemukan.' });
      }

      const url = `http://${server.domain}:5888/renewssh?user=${username}&exp=${exp}&iplimit=${limitip}&auth=${server.auth}`;
      
      axios.get(url, { timeout: 15000 })
        .then(res => {
          if (res.data.status === "success") {
            const data = res.data.data;
            
            // Siapkan teks untuk ditampilkan ke user & disimpan ke DB
            const msg = `
♻️ *RENEW SSH PREMIUM* ♻️

🔹 *Informasi Akun*
┌─────────────────────────────
│ *Username* : \`${username}\`
│ *Kadaluarsa* : \`${data.exp || data.expired || '-'}\`
│ *Batas IP* : \`${data.limitip || limitip} IP\`
└─────────────────────────────
✅ Akun berhasil diperpanjang.
✨ Terima kasih telah menggunakan layanan kami!
`.trim();

            // KUNCINYA DI SINI: Kembalikan Object, bukan cuma string
            resolve({
              status: 'success',
              message: msg,
              data: data
            });
          } else {
            resolve({ status: 'error', message: `❌ Gagal: ${res.data.message}` });
          }
        })
        .catch((e) => {
          console.error('❌ SSH Renew Error:', e.message);
          resolve({ status: 'error', message: '❌ Gagal menghubungi server SSH.' });
        });
    });
  });
}

module.exports = { renewssh };