const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// =============================
//     CREATE VMESS PREMIUM
// =============================
async function createvmess(username, exp, quota, limitip, serverId) {
  // Log menggunakan nilai quota total
  console.log(`⚙️ Creating VMESS for ${username} | Exp: ${exp} days | Quota Total: ${quota} | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Gunakan tanpa spasi & simbol.';
  }

  // Bungkus operasi DB ke dalam Promise
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      // 1. Handle DB Error
      if (err) {
        console.error(`❌ DB error while fetching server ${serverId}:`, err.message);
        return resolve('❌ Terjadi kesalahan database.');
      }
      if (!server) {
        return resolve('❌ Server tidak ditemukan.');
      }

      // Pastikan kuota yang dikirim ke API adalah kuota total (nilai numerik)
      const url =
        `http://${server.domain}:5888/createvmess?` +
        `user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 }); // Tambahkan timeout
        
        // 2. Handle API failure
        if (data.status !== "success") {
          console.error(`❌ VMESS API returned error for ${username} on server ${serverId}: ${data.message}`);
          return resolve(`❌ Gagal membuat akun: ${data.message}`);
        }

        const d = data.data;

        // Terapkan penambahan unit 'GB' atau 'MB' jika API tidak menyediakannya
        // Asumsi: Variabel 'quota' di respons API sudah berisi unit (misalnya "10 GB")
        const quotaDisplay = d.quota === '0 GB' ? 'Unlimited' : d.quota;
        const ipLimitDisplay = d.ip_limit === '0' ? 'Unlimited' : `${d.ip_limit} IP`;

        // =============================
        //  PREMIUM STYLE MIRIP SSH
        // =============================
        const msg = `
🌟 *AKUN VMESS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain* : \`${d.domain}\`
└─────────────────────
🔌 *PORT*
┌─────────────────────
│ *TLS* : \`443\`
│ *HTTP* : \`80\`
│ *Network* : \`Websocket (WS)\`
│ *Path* : \`/vmess\`
│ *Path GRPC* : \`vmess-grpc\`
│ *Quota* : \`${quotaDisplay}\`
│ *IP Limit* : \`${ipLimitDisplay}\`
└─────────────────────

🔐 *VMESS TLS*
\`\`\`
${d.vmess_tls_link}
\`\`\`
🔓 *VMESS HTTP*
\`\`\`
${d.vmess_nontls_link}
\`\`\`
🔒 *VMESS GRPC*
\`\`\`
${d.vmess_grpc_link}
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
https://${d.domain}:81/vmess-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        resolve(msg);

      } catch (error) {
        // 3. Handle Axios (network/timeout) error
        console.error(`❌ VMESS API network error for user ${username}:`, error.message);
        resolve("❌ Tidak bisa menghubungi server. Coba lagi nanti.");
      }
    });
  });
}

module.exports = { createvmess };