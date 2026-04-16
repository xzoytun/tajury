const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createvless(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating VLESS for ${username} | Exp: ${exp} days | Quota: ${quota} | IP Limit: ${limitip}`);

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
        `http://${server.domain}:5888/createvless?` +
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
        //          PREMIUM VLESS UI FORMAT
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
${d.vless_tls_link || 'Link tidak tersedia'}
\`\`\`

🔓 *VLESS HTTP*
\`\`\`
${d.vless_nontls_link || 'Link tidak tersedia'}
\`\`\`

🔒 *VLESS GRPC*
\`\`\`
${d.vless_grpc_link || 'Link tidak tersedia'}
\`\`\`

🔑 *UUID*
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
\`https://${d.domain}:81/vless-${d.username}.txt\`

✨ Selamat menggunakan layanan kami! ✨
`.trim();

        // RETURN OBJECT AGAR BISA DISIMPAN DI APP.JS
        resolve({
          status: 'success',
          message: msg,
          data: d
        });

      } catch (error) {
        console.error(`❌ Network error:`, error.message);
        resolve({ status: 'error', message: "❌ Gagal menghubungi server VLESS. Coba lagi nanti." });
      }
    });
  });
}

module.exports = { createvless };