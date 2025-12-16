const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createzivpn(password, exp, iplimit, serverId) {
  console.log(`⚙️ Creating ZIVPN | Password: ${password} | Exp: ${exp} days | IP Limit: ${iplimit}`);

  // VALIDASI KERAS
  if (!password || !exp || !iplimit) {
    return '❌ Parameter ZIVPN tidak lengkap.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) {
        return resolve('❌ Server tidak ditemukan.');
      }

      const url =
        `http://${server.domain}:5888/createzivpn?` +
        `password=${password}&exp=${exp}&iplimit=${iplimit}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 });

        if (data.status !== 'success') {
          return resolve(`❌ Gagal membuat ZIVPN: ${data.message || 'unknown error'}`);
        }

        const d = data.data;

        const msg = `
🌟 *AKUN ZIVPN PREMIUM* 🌟

🔹 *Informasi Akun*
┌───────────────────────────
│🌍 Domain   : \`${server.domain}\`
│🔐 Password : \`${d.password}\`
│📅 Expired  : \`${d.expired}\`
│🌐 IP Limit : \`${d.ip_limit} IP\`
│📡 Port UDP  : \`6000 – 19999\`
└───────────────────────────

✨ Akun aktif & siap digunakan
`.trim();

        resolve(msg);

      } catch (e) {
        console.error('❌ ZIVPN API error:', e.message);
        resolve('❌ ZIVPN API timeout / error');
      }
    });
  });
}

module.exports = { createzivpn };