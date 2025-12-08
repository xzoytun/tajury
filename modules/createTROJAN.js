const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// =============================
//      CREATE TROJAN PREMIUM
// =============================
async function createtrojan(username, exp, quota, limitip, serverId) {
  // Log menggunakan nilai quota total
  console.log(`⚙️ Creating TROJAN for ${username} | Exp: ${exp} days | Quota Total: ${quota} | IP Limit: ${limitip}`);

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

      // Kuota yang dikirim adalah Kuota Total
      const url =
        `http://${server.domain}:5888/createtrojan?` +
        `user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        // Tambahkan timeout untuk ketahanan jaringan
        const { data } = await axios.get(url, { timeout: 15000 }); 

        // 2. Handle API failure
        if (data.status !== "success") {
          console.error(`❌ TROJAN API returned error for ${username} on server ${serverId}: ${data.message}`);
          return resolve(`❌ Gagal: ${data.message}`);
        }

        const d = data.data;

        // Tampilan kuota dan limit IP
        const quotaDisplay = d.quota === '0 GB' ? 'Unlimited' : d.quota;
        const ipLimitDisplay = d.ip_limit === '0' ? 'Unlimited' : `${d.ip_limit} IP`;

        // =======================================
        //       PREMIUM TROJAN UI FORMAT
        // =======================================
        const msg = `
🌟 *AKUN TROJAN PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain* : \`${d.domain}\`
└─────────────────────
🔌 *PORT & JARINGAN*
┌─────────────────────
│ *TLS (WS)* : \`443\`
│ *gRPC* : \`443\`
│ *Network* : \`Websocket / gRPC\`
│ *Quota* : \`${quotaDisplay}\`
│ *IP Limit* : \`${ipLimitDisplay}\`
└─────────────────────

🔐 *TROJAN TLS*
\`\`\`
${d.trojan_tls_link}
\`\`\`
🔒 *TROJAN GRPC*
\`\`\`
${d.trojan_grpc_link}
\`\`\`
🔑 *PASSWORD/UUID*
\`\`\`
${d.uuid}
\`\`\`
🔏 *PUBKEY*
\`\`\`
${d.pubkey}
\`\`\`
┌─────────────────────
│ *Expired* : \`${d.expired}\`
└─────────────────────
📄 *Save Account*
\`\`\`
https://${d.domain}:81/trojan-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        resolve(msg);

      } catch (error) {
        // 3. Handle Axios (network/timeout) error
        console.error(`❌ TROJAN API network error for user ${username} on server ${serverId}:`, error.message);
        resolve("❌ Tidak bisa menghubungi server. Coba lagi nanti.");
      }
    });
  });
}

module.exports = { createtrojan };