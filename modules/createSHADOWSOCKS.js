const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// =============================
//      CREATE SHADOWSOCKS PREMIUM
// =============================
async function createshadowsocks(username, exp, quota, limitip, serverId) {
  // Log menggunakan nilai quota total
  console.log(`⚙️ Creating SHADOWSOCKS for ${username} | Exp: ${exp} days | Quota Total: ${quota} | IP Limit: ${limitip}`);

  // validasi username: huruf & angka saja, tanpa spasi
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      // 1. Handle DB Error
      if (err) {
        console.error(`❌ DB Error (createshadowsocks) fetching server ${serverId}:`, err.message);
        return resolve('❌ Terjadi kesalahan database.');
      }
      if (!server) {
        return resolve('❌ Server tidak ditemukan.');
      }

      // Kuota yang dikirim adalah Kuota Total
      const url = `http://${server.domain}:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        // Tambahkan timeout untuk ketahanan jaringan
        const { data } = await axios.get(url, { timeout: 15000 });

        // 2. Handle API failure
        if (data.status !== 'success') {
          console.error(`❌ Shadowsocks API returned error for ${username} on server ${serverId}:`, data.message);
          return resolve(`❌ Gagal: ${data.message}`);
        }

        const d = data.data;

        // --- Sanitasi / Fallback Nilai (Diperbaiki) ---
        const domainOut = d.domain || server.domain || '-';
        const ss_ws = d.ss_link_ws || d.link_ws || d.ss_ws || '-';
        const ss_grpc = d.ss_link_grpc || d.link_grpc || d.ss_grpc || '-';
        const pubkey = d.pubkey || d.public_key || 'Not Available';
        const expired = d.expired || d.expiration || d.exp || '-';
        
        // Logika tampilan Quota: Asumsi response API sudah menyertakan unit (e.g., "10 GB")
        const quotaValue = d.quota || quota; // Gunakan response API atau fallback ke nilai input totalQuota
        const quotaStr = (quotaValue === '0 GB' || quotaValue === 0 || quotaValue === '0') ? 'Unlimited' : quotaValue;
        
        // Logika tampilan IP Limit
        let ipLimitStr = d.ip_limit || limitip || '0';
        if (ipLimitStr === '0' || ipLimitStr === 0) {
             ipLimitStr = 'Unlimited';
        } else if (!String(ipLimitStr).includes('IP')) {
             ipLimitStr = `${ipLimitStr} IP`;
        }
        // ----------------------------------------------

        const msg = `
🌟 *AKUN SHADOWSOCKS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain* : \`${domainOut}\`
└─────────────────────
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
\`\`\`
https://${domainOut}:81/shadowsocks-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        console.log('✅ Shadowsocks created for', d.username);
        return resolve(msg);
      } catch (error) {
        // 3. Handle Axios (network/timeout) error
        console.error(`❌ SHADOWSOCKS API network error for user ${username} on server ${serverId}:`, error.message);
        return resolve('❌ Tidak bisa menghubungi server Shadowsocks. Coba lagi nanti.');
      }
    });
  });
}

module.exports = { createshadowsocks };