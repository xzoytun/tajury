const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function renewzivpn(password, days, iplimit, serverId) {
  console.log(
    `♻️ Renew ZIVPN | Password: ${password} | +${days} days | IP Limit: ${iplimit}`
  );

  if (!password || !days) {
    return '❌ Parameter renew ZIVPN tidak lengkap.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) {
        return resolve('❌ Server tidak ditemukan.');
      }

      const url =
        `http://${server.domain}:5888/renewzivpn?` +
        `password=${password}&days=${days}&iplimit=${iplimit}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 });

        if (data.status !== 'success') {
          return resolve(`❌ Gagal renew ZIVPN: ${data.message || 'unknown error'}`);
        }

        const d = data.data;

        const msg = `
♻️ *ZIVPN RENEW BERHASIL*

🌐 *Domain*   : \`${server.domain}\`
🔐 *Password* : \`${d.password}\`
📅 *Expired*  : \`${d.expired}\`
🌍 *IP Limit* : \`${d.ip_limit} IP\`

✨ Masa aktif berhasil diperpanjang
`.trim();

        resolve(msg);

      } catch (e) {
        console.error('❌ ZIVPN Renew API error:', e.message);
        resolve('❌ ZIVPN API timeout / error');
      }
    });
  });
}

module.exports = { renewzivpn };