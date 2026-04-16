const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function renewzivpn(password, days, iplimit, serverId) {
  console.log(`♻️ Renew ZIVPN | Password: ${password} | +${days} days | IP Limit: ${iplimit}`);

  // VALIDASI PARAMETER
  if (!password || !days) {
    return { status: 'error', message: '❌ Parameter renew ZIVPN tidak lengkap.' };
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err) {
        console.error(`❌ DB error:`, err.message);
        return resolve({ status: 'error', message: '❌ Terjadi kesalahan database.' });
      }
      if (!server) {
        return resolve({ status: 'error', message: '❌ Server tidak ditemukan.' });
      }

      const url =
        `http://${server.domain}:5888/renewzivpn?` +
        `password=${password}&days=${days}&iplimit=${iplimit}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 });

        if (data.status !== 'success') {
          console.error(`❌ API Error: ${data.message}`);
          return resolve({ status: 'error', message: `❌ Gagal: ${data.message || 'unknown error'}` });
        }

        const d = data.data;
        const ipLimitDisplay = d.ip_limit === '0' || d.ip_limit === 0 ? 'Unlimited' : `${d.ip_limit} IP`;

        // =======================================
        //          PREMIUM ZIVPN UI FORMAT
        // =======================================
        const msg = `
♻️ *ZIVPN RENEW BERHASIL*

🔹 *Informasi Akun*
┌───────────────────────────
│ 🌍 *Domain* : \`${server.domain}\`
│ 🔐 *Password* : \`${d.password}\`
│ 📅 *Expired* : \`${d.expired}\`
│ 🌐 *IP Limit* : \`${ipLimitDisplay}\`
│ 📡 *Port UDP* : \`6000 – 19999\`
└───────────────────────────

✨ Masa aktif berhasil diperpanjang! ✨
`.trim();

        // RETURN OBJECT AGAR BISA DISIMPAN DI APP.JS (MENCEGAH UNDEFINED)
        resolve({
          status: 'success',
          message: msg,
          data: d
        });

      } catch (e) {
        console.error('❌ ZIVPN Renew API error:', e.message);
        resolve({ status: 'error', message: '❌ Gagal request ke API ZIVPN. Coba lagi nanti.' });
      }
    });
  });
}

module.exports = { renewzivpn };