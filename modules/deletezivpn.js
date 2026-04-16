const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// Pastikan merujuk ke database yang sama dengan app.js
const db = new sqlite3.Database('./database.db'); 

async function deletezivpn(password, serverId) {
  console.log(`🗑️ Deleting ZIVPN | Password: ${password} | ServerID: ${serverId}`);

  if (!password) {
    return '❌ Password/Username ZIVPN diperlukan untuk menghapus.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) {
        return resolve('❌ Server tidak ditemukan di database.');
      }

      // Endpoint sesuai api.js: /deletezivpn?password=...&auth=...
      const url = `http://${server.domain}:5888/deletezivpn?password=${encodeURIComponent(password)}&auth=${encodeURIComponent(server.auth)}`;

      try {
        const { data } = await axios.get(url, { timeout: 15000 });

        if (data.status !== 'success') {
          return resolve(`❌ Gagal menghapus: ${data.message || 'Akun tidak ditemukan'}`);
        }

        resolve(`✅ *ZIVPN BERHASIL DIHAPUS*\n\n👤 Password: \`${password}\`\n🖥️ Server: \`${server.domain}\`\n\nData telah dibersihkan dari server.`);

      } catch (e) {
        console.error('❌ ZIVPN Delete API error:', e.message);
        resolve('❌ Koneksi API gagal. Pastikan server aktif.');
      }
    });
  });
}

module.exports = { deletezivpn };
