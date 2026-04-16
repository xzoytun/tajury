const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createtrojan(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating TROJAN for ${username} | Exp: ${exp} days | Quota: ${quota} | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return { status: 'error', message: '❌ Username tidak valid. Gunakan tanpa spasi & simbol.' };
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
        `http://${server.domain}:5888/createtrojan?` +
        `user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 }); 

        if (data.status !== "success") {
          console.error(`❌ API Error: ${data.message}`);
          return resolve({ status: 'error', message: `❌ Gagal: ${data.message}` });
        }

        const d = data.data;
        const quotaDisplay = d.quota === '0 GB' || d.quota === '0' ? 'Unlimited' : d.quota;
        const ipLimitDisplay = d.ip_limit === '0' || d.ip_limit === 0 ? 'Unlimited' : `${d.ip_limit} IP`;

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
${d.trojan_tls_link || 'Link tidak tersedia'}
\`\`\`

🔒 *TROJAN GRPC*
\`\`\`
${d.trojan_grpc_link || 'Link tidak tersedia'}
\`\`\`

🔑 *PASSWORD/UUID*
\`\`\`
${d.uuid || 'UUID tidak tersedia'}
\`\`\`

🔏 *PUBKEY*
\`\`\`
${d.pubkey || 'Pubkey tidak tersedia'}
\`\`\`

┌─────────────────────
│ *Expired* : \`${d.expired}\`
└─────────────────────

📄 *Save Account*
\`https://${d.domain}:81/trojan-${d.username}.txt\`

✨ Selamat menggunakan layanan kami! ✨
`.trim();

        // RETURN OBJECT UNTUK SIMPAN KE DB
        resolve({
          status: 'success',
          message: msg,
          data: d
        });

      } catch (error) {
        console.error(`❌ Network error:`, error.message);
        resolve({ status: 'error', message: "❌ Gagal menghubungi server Trojan. Coba lagi nanti." });
      }
    });
  });
}

module.exports = { createtrojan };