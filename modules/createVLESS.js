const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// =============================
//      CREATE VLESS PREMIUM
// =============================
async function createvless(username, exp, quota, limitip, serverId) {
  // Log menggunakan nilai quota total
  console.log(`⚙️ Creating VLESS for ${username} | Exp: ${exp} days | Quota Total: ${quota} | IP Limit: ${limitip}`);

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
        `http://${server.domain}:5888/createvless?` +
        `user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        // Tambahkan timeout untuk mencegah gantung
        const { data } = await axios.get(url, { timeout: 15000 }); 

        // 2. Handle API failure
        if (data.status !== "success") {
          console.error(`❌ VLESS API returned error for ${username} on server ${serverId}: ${data.message}`);
          return resolve(`❌ Gagal membuat akun: ${data.message}`);
        }

        const d = data.data;

        // Tampilan kuota dan limit IP
        const quotaDisplay = d.quota === '0 GB' ? 'Unlimited' : d.quota;
        const ipLimitDisplay = d.ip_limit === '0' ? 'Unlimited' : `${d.ip_limit} IP`;

        // =======================================
        //          PREMIUM UI FORMAT
        // =======================================
        const msg = `
🌟 *AKUN VLESS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain* : \`${d.domain}\`
└─────────────────────
🔌 *PORT & JARINGAN*
┌─────────────────────
│ *TLS* : \`443\`
│ *HTTP* : \`80\`
│ *Network* : \`Websocket (WS)\`
│ *Path WS* : \`/vless\`
│ *Path GRPC* : \`vless-grpc\`
│ *Quota* : \`${quotaDisplay}\`
│ *IP Limit* : \`${ipLimitDisplay}\`
└─────────────────────

🔐 *VLESS TLS*
\`\`\`
${d.vless_tls_link}
\`\`\`
🔓 *VLESS HTTP*
\`\`\`
${d.vless_nontls_link}
\`\`\`
🔒 *VLESS GRPC*
\`\`\`
${d.vless_grpc_link}
\`\`\`
🔑 *UUID*
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
https://${d.domain}:81/vless-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        resolve(msg);

      } catch (error) {
        // 3. Handle Axios (network/timeout) error
        console.error(`❌ VLESS API network error for user ${username} on server ${serverId}:`, error.message);
        resolve("❌ Tidak bisa menghubungi server. Coba lagi nanti.");
      }
    });
  });
}

module.exports = { createvless };