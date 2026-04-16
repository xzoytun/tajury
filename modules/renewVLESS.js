const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function renewvless(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Renewing VLESS for ${username} | Exp: ${exp} days | Quota: ${quota} | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return { status: 'error', message: '❌ Username tidak valid. Gunakan hanya huruf & angka.' };
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err) {
        console.error(`❌ DB error:`, err.message);
        return resolve({ status: 'error', message: '❌ Terjadi kesalahan database.' });
      }
      if (!server) {
        return resolve({ status: 'error', message: '❌ Server tidak ditemukan.' });
      }

      const url = `http://${server.domain}:5888/renewvless?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;
      
      axios.get(url, { timeout: 15000 })
        .then(res => {
          if (res.data.status === "success") {
            const data = res.data.data;
            
            // Format tampilan kuota & IP Limit agar lebih rapi
            const quotaDisplay = data.quota === '0 GB' || data.quota === '0' ? 'Unlimited' : `${data.quota} GB`;
            const ipLimitDisplay = data.limitip === '0' || data.limitip === 0 ? 'Unlimited' : `${data.limitip} IP`;

            const msg = `
♻️ *RENEW VLESS PREMIUM* ♻️

🔹 *Informasi Akun*
┌─────────────────────────────
│ *Username* : \`${username}\`
│ *Kadaluarsa* : \`${data.exp || data.expired || '-'}\`
│ *Kuota* : \`${quotaDisplay}\`
│ *Batas IP* : \`${ipLimitDisplay}\`
└─────────────────────────────
✅ Akun berhasil diperpanjang.
✨ Terima kasih telah menggunakan layanan kami!
`.trim();

            // KUNCINYA: Kembalikan Object agar app.js bisa baca result.message
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
          console.error('❌ Vless Renew Error:', e.message);
          resolve({ status: 'error', message: '❌ Gagal menghubungi server Vless.' });
        });
    });
  });
}

module.exports = { renewvless };