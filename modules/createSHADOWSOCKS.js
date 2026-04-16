const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createshadowsocks(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating SHADOWSOCKS for ${username} | Exp: ${exp} days | Quota: ${quota} | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return { status: 'error', message: '❌ Username tidak valid. Gunakan hanya huruf & angka tanpa spasi.' };
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err) {
        console.error(`❌ DB Error:`, err.message);
        return resolve({ status: 'error', message: '❌ Terjadi kesalahan database.' });
      }
      if (!server) {
        return resolve({ status: 'error', message: '❌ Server tidak ditemukan.' });
      }

      const url = `http://${server.domain}:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 });

        if (data.status !== 'success') {
          console.error(`❌ API Error: ${data.message}`);
          return resolve({ status: 'error', message: `❌ Gagal: ${data.message}` });
        }

        const d = data.data;

        // --- Sanitasi & Fallback ---
        const domainOut = d.domain || server.domain || '-';
        const ss_ws = d.ss_link_ws || d.link_ws || d.ss_ws || 'Link WS tidak tersedia';
        const ss_grpc = d.ss_link_grpc || d.link_grpc || d.ss_grpc || 'Link gRPC tidak tersedia';
        const pubkey = d.pubkey || d.public_key || 'Pubkey tidak tersedia';
        const expired = d.expired || d.expiration || '-';
        
        const quotaValue = d.quota || quota;
        const quotaStr = (quotaValue === '0 GB' || quotaValue === 0 || quotaValue === '0') ? 'Unlimited' : quotaValue;
        
        let ipLimitStr = d.ip_limit || limitip || '0';
        if (ipLimitStr === '0' || ipLimitStr === 0) {
             ipLimitStr = 'Unlimited';
        } else if (!String(ipLimitStr).includes('IP')) {
             ipLimitStr = `${ipLimitStr} IP`;
        }

        // =======================================
        //      PREMIUM SHADOWSOCKS UI FORMAT
        // =======================================
        const msg = `
🌟 *AKUN SHADOWSOCKS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain* : \`${domainOut}\`
└─────────────────────

🔌 *DETAIL QUOTA & LIMIT*
┌─────────────────────
│ *Quota* : \`${quotaStr}\`
│ *IP Limit* : \`${ipLimitStr}\`
└─────────────────────

🔐 *SHADOWSOCKS WS LINK*
\`\`\`
${ss_ws}
\`\`\`

🔒 *SHADOWSOCKS gRPC LINK*
\`\`\`
${ss_grpc}
\`\`\`

🔏 *PUBKEY*
\`\`\`
${pubkey}
\`\`\`

┌─────────────────────
│ *Expired* : \`${expired}\`
└─────────────────────

📄 *Save Account*
\`https://${domainOut}:81/shadowsocks-${d.username}.txt\`

✨ Selamat menggunakan layanan kami! ✨
`.trim();

        // RETURN OBJECT UNTUK SIMPAN KE DATABASE
        resolve({
          status: 'success',
          message: msg,
          data: d
        });

      } catch (error) {
        console.error(`❌ Network error:`, error.message);
        resolve({ status: 'error', message: '❌ Gagal menghubungi server Shadowsocks. Coba lagi nanti.' });
      }
    });
  });
}

module.exports = { createshadowsocks };