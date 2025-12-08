const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createssh(username, password, exp, iplimit, serverId) {
  console.log(`⚙️ Creating SSH for ${username} | Exp: ${exp} days | IP Limit: ${iplimit}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Gunakan tanpa spasi & simbol.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      // 1. Handle DB Error
      if (err) {
        console.error(`❌ DB error while fetching server ${serverId}:`, err.message);
        return resolve('❌ Terjadi kesalahan database.');
      }
      if (!server) {
        return resolve('❌ Server tidak ditemukan.');
      }

      const url = 
        `http://${server.domain}:5888/createssh?` +
        `user=${username}&password=${password}&exp=${exp}&iplimit=${iplimit}&auth=${server.auth}`;

      try {
        // Tambahkan timeout untuk ketahanan jaringan
        const { data } = await axios.get(url, { timeout: 15000 }); 
        
        // 2. Handle API failure
        if (data.status !== 'success') {
          console.error(`❌ SSH API returned error for ${username} on server ${serverId}: ${data.message}`);
          return resolve(`❌ Gagal: ${data.message}`);
        }

        const d = data.data;
        const ipLimitDisplay = d.ip_limit === '0' ? 'Unlimited' : `${d.ip_limit} IP`;

        // Mengambil nilai port, menggunakan default jika tidak ada dari API response
        const ports = d.ports || {};
        
        // =========================
        //   STYLE PREMIUM TERBARU
        // =========================
        const msg = `
🌟 *AKUN SSH PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Password* : \`${d.password}\`
│ *Domain* : \`${d.domain}\`
└─────────────────────
🔌 *PORT*
┌─────────────────────
│ *TLS* : \`443\`
│ *HTTP* : \`80\`
│ *OpenSSH* : \`${ports.openssh || '22'}\`
│ *SSH WS* : \`${ports.ssh_ws || '80'}\`
│ *SSH SSL WS* : \`${ports.ssh_ssl_ws || '443'}\`
│ *Dropbear* : \`${ports.dropbear || '109, 443'}\`
│ *DNS* : \`53, 443, 22\`
│ *OVPN SSL* : \`${ports.ovpn_ssl || '443'}\`
│ *OVPN TCP* : \`${ports.ovpn_tcp || '1194'}\`
│ *OVPN UDP* : \`${ports.ovpn_udp || '2200'}\`
└─────────────────────

🔐 *PUBKEY*
\`\`\`
${d.pubkey || 'Pubkey tidak tersedia'}
\`\`\`
🔗 *Link & File*
WSS Payload :
\`\`\`
GET wss://BUG.COM/ HTTP/1.1
Host: ${d.domain}
Upgrade: websocket
\`\`\`
OpenVPN :
\`\`\`
https://${d.domain}:81/allovpn.zip
\`\`\`
Save Account :
\`\`\`
https://${d.domain}:81/ssh-${d.username}.txt
\`\`\`
┌─────────────────────
│ *Expired* : \`${d.expired}\`
│ *IP Limit* : \`${ipLimitDisplay}\`
└─────────────────────
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        return resolve(msg);

      } catch (error) {
        // 3. Handle Axios (network/timeout) error
        console.error(`❌ SSH API network error for user ${username} on server ${serverId}:`, error.message);
        return resolve('❌ Gagal request ke API SSH. Periksa koneksi atau status server.');
      }
    });
  });
}

module.exports = { createssh };