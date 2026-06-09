const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./sellvpn.db");

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function getServer(serverId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM Server WHERE id = ?", [serverId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function isValidUsername(username) {
  return !(/\s/.test(username) || /[^a-zA-Z0-9]/.test(username));
}

function formatIpLimit(ipLimit) {
  const limit = String(ipLimit || "0");
  return limit === "0" ? "Unlimited" : `${limit} IP`;
}

function formatQuota(quota) {
  return !quota || quota === "0 GB" ? "Unlimited" : quota;
}

async function callAPI(url, serviceName) {
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data.status !== "success") throw new Error(data.message || "Unknown error");
    return data.data;
  } catch (err) {
    console.error(`${serviceName} API error:`, err.message || err);
    if (err.code === "ECONNABORTED") throw new Error("Request timeout. Server tidak merespon.");
    else if (err.code === "ECONNREFUSED") throw new Error("Tidak dapat terhubung ke server.");
    else throw new Error(err.message || `Gagal request ke API ${serviceName}.`);
  }
}

// ─────────────────────────────────────────
// HTML COMPONENTS — tema dashboard
// ─────────────────────────────────────────

const baseStyle = `
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  .rc {
    font-family: 'Nunito', sans-serif;
    background: #FFFFFF;
    border-radius: 20px;
    overflow: hidden;
    border: 1.5px solid #E8D8F8;
    box-shadow: 0 4px 20px rgba(90,26,154,0.12);
    margin-top: 14px;
    color: #1A0533;
  }

  /* ── header ── */
  .rc-header {
    background: linear-gradient(150deg, #3D0F72 0%, #7B2FBE 55%, #9B4FDE 100%);
    padding: 16px 20px;
    display: flex;
    align-items: center;
    gap: 10px;
    position: relative;
    overflow: hidden;
  }
  .rc-header::before {
    content: '';
    position: absolute; top: -30px; right: -20px;
    width: 100px; height: 100px;
    border: 24px solid rgba(255,255,255,0.07);
    border-radius: 50%;
  }
  .rc-header-icon {
    width: 38px; height: 38px;
    border-radius: 12px;
    background: rgba(255,255,255,0.18);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .rc-header-icon svg {
    width: 20px; height: 20px;
    fill: none; stroke: #fff;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }
  .rc-header-text { position: relative; z-index: 1; }
  .rc-header-title {
    font-size: 15px; font-weight: 900;
    color: #fff; line-height: 1.1;
    letter-spacing: -0.2px;
  }
  .rc-header-sub {
    font-size: 11px; color: rgba(255,255,255,0.65);
    font-weight: 700; margin-top: 2px;
  }

  /* ── section ── */
  .rc-section {
    padding: 16px 20px;
    border-bottom: 1.5px solid #E8D8F8;
  }
  .rc-section:last-child { border-bottom: none; }
  .rc-section-title {
    font-size: 10px; font-weight: 800;
    color: #A882CC;
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 12px;
    display: flex; align-items: center; gap: 5px;
  }
  .rc-section-title svg {
    width: 12px; height: 12px;
    fill: none; stroke: #A882CC;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }

  /* ── rows ── */
  .rc-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 9px;
    gap: 10px;
    font-size: 13px;
  }
  .rc-row:last-child { margin-bottom: 0; }
  .rc-label {
    color: #A882CC;
    font-weight: 700;
    white-space: nowrap;
    min-width: 80px;
  }
  .rc-value {
    color: #1A0533;
    font-weight: 800;
    text-align: right;
    word-break: break-all;
  }
  .rc-value code {
    background: #F3EAFD;
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 12px;
    color: #5A1A9A;
    font-weight: 800;
    font-family: monospace;
  }

  /* ── badges ── */
  .badge {
    display: inline-block;
    padding: 3px 11px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 800;
  }
  .badge-green  { background: #E6FAF4; color: #12C28A; border: 1px solid rgba(18,194,138,0.25); }
  .badge-purple { background: #F3EAFD; color: #7B2FBE; border: 1px solid rgba(123,47,190,0.2); }
  .badge-orange { background: #FFF0E0; color: #FF6B2B; border: 1px solid rgba(255,107,43,0.2); }

  /* ── port grid ── */
  .port-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
  }
  .port-item {
    background: #F7F0FD;
    border: 1px solid #E8D8F8;
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 800;
    color: #1A0533;
  }
  .port-item span {
    color: #A882CC;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: block;
    margin-bottom: 2px;
  }

  /* ── link box ── */
  .link-box {
    background: #F7F0FD;
    border: 1.5px solid #E8D8F8;
    border-radius: 14px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .link-box:last-child { margin-bottom: 0; }
  .link-label {
    font-size: 10px;
    font-weight: 800;
    color: #6B3FA0;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 8px;
  }
  .link-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .link-text {
  background: #fff;
  border: 1.5px solid #E8D8F8;
  border-radius: 10px;
  padding: 8px 10px;
  color: #5A1A9A;
  font-size: 11px;
  font-weight: 700;
  flex: 1;
  font-family: monospace;
  outline: none;

  min-height: 54px;
  -webkit-user-select: all;
user-select: all;
}
  .copy-btn {
    background: linear-gradient(135deg, #5A1A9A, #7B2FBE);
    color: #fff;
    border: none;
    border-radius: 10px;
    padding: 8px 13px;
    font-size: 11px;
    font-weight: 900;
    cursor: pointer;
    white-space: nowrap;
    font-family: 'Nunito', sans-serif;
    transition: opacity 0.15s;
  }
  .copy-btn:hover { opacity: 0.85; }

  /* ── download buttons ── */
  .dl-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .download-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #F3EAFD;
    border: 1.5px solid #E8D8F8;
    color: #5A1A9A;
    padding: 9px 16px;
    border-radius: 12px;
    text-decoration: none;
    font-size: 12px;
    font-weight: 800;
    font-family: 'Nunito', sans-serif;
    transition: background 0.15s, border-color 0.15s;
  }
  .download-link:hover { background: #EAD5FA; border-color: #C9A8F0; }
  .download-link svg {
    width: 14px; height: 14px;
    fill: none; stroke: #5A1A9A;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }

  /* ── error card ── */
  .rc-error {
    font-family: 'Nunito', sans-serif;
    background: #FFECEC;
    border: 1.5px solid rgba(232,64,64,0.25);
    border-radius: 16px;
    padding: 16px 20px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: #E84040;
    font-weight: 800;
    font-size: 14px;
    margin-top: 14px;
  }
  .rc-error svg {
    width: 20px; height: 20px;
    fill: none; stroke: #E84040;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    flex-shrink: 0;
  }
  .copy-btn:active{
  transform:scale(.95);
}
.copy-btn{
  transition:
    transform .15s,
    opacity .15s;
}
</style>
<script>
  function copyText(btn, encodedText) {

  const text = decodeURIComponent(encodedText);

  if (navigator.clipboard) {

    navigator.clipboard.writeText(text)
      .then(() => successCopy(btn))
      .catch(() => fallbackCopy(btn, text));

  } else {

    fallbackCopy(btn, text);

  }

}

function fallbackCopy(btn, text) {

  const input = document.createElement("input");

  input.value = text;

  document.body.appendChild(input);

  input.select();

  document.execCommand("copy");

  document.body.removeChild(input);

  successCopy(btn);

}

function successCopy(btn) {

  const original = btn.innerHTML;

  btn.innerHTML = "✓ Copied";

  btn.style.background =
    "linear-gradient(135deg,#12C28A,#00E676)";

  setTimeout(() => {

    btn.innerHTML = original;

    btn.style.background =
      "linear-gradient(135deg,#5A1A9A,#7B2FBE)";

  }, 1500);

}
</script>
`;

// ── SVG icons (inline strings) ──
const iconDownload = `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const iconFile     = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const iconInfo     = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16" stroke-width="3"/></svg>`;
const iconLink     = `<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const iconGrid     = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
const iconClock    = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

// ── Reusable builders ──
function linkBox(label, link) {
  const safeLink = link || "-";
  const encoded = encodeURIComponent(safeLink);

  return `
  <div class="link-box">
    <div class="link-label">${label}</div>

    <div class="link-row">

      <input
  type="text"
  class="link-text"
  value="${safeLink}"
  readonly
/>

      <button
        class="copy-btn"
        onclick="copyText(this, '${encoded}')"
      >
        Copy
      </button>

    </div>
  </div>`;
}

function row(label, value) {
  return `
  <div class="rc-row">
    <span class="rc-label">${label}</span>
    <span class="rc-value">${value}</span>
  </div>`;
}

function section(icon, title, content) {
  return `
  <div class="rc-section">
    <div class="rc-section-title">${icon} ${title}</div>
    ${content}
  </div>`;
}

function errorCard(msg) {
  return `${baseStyle}
  <div class="rc-error">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    ${msg}
  </div>`;
}

// ─────────────────────────────────────────
// SSH
// ─────────────────────────────────────────

async function createsshWeb(username, password, exp, iplimit, serverId) {
  if (!isValidUsername(username)) return errorCard("Username tidak valid. Gunakan huruf/angka tanpa spasi.");

  const server = await getServer(serverId);
  if (!server) return errorCard("Server tidak ditemukan.");

  const url = `http://${server.domain}:5888/createssh?user=${username}&password=${password}&exp=${exp}&iplimit=${iplimit}&auth=${server.auth}`;

  try {
    const d = await callAPI(url, "SSH");

    return `${baseStyle}
<div class="rc">
  <div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Akun SSH Berhasil Dibuat</div>
      <div class="rc-header-sub">${d.domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${d.domain}</code>`)}
    ${row("Username", `<code>${d.username}</code>`)}
    ${row("Password", `<code>${d.password}</code>`)}
  `)}

  ${section(iconGrid, "Konfigurasi Port", `
    <div class="port-grid">
      <div class="port-item"><span>OpenSSH</span>22, 80, 443</div>
      <div class="port-item"><span>Dropbear</span>109, 443</div>
      <div class="port-item"><span>SSH WS</span>80</div>
      <div class="port-item"><span>SSH SSL WS</span>443</div>
      <div class="port-item"><span>DNS</span>53, 443, 22</div>
      <div class="port-item"><span>OVPN TCP/UDP</span>1194 / 2200</div>
    </div>
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Expired",  `<span class="badge badge-orange">${d.expired}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${formatIpLimit(d.ip_limit)}</span>`)}
  `)}

  ${section(iconDownload, "Unduh", `
    <div class="dl-row">
      <a href="https://${d.domain}:81/allovpn.zip" target="_blank" class="download-link">
        ${iconDownload} All OVPN
      </a>
      <a href="https://${d.domain}:81/ssh-${d.username}.txt" target="_blank" class="download-link">
        ${iconFile} Info Akun
      </a>
    </div>
  `)}
</div>`;
  } catch (err) {
    return errorCard(err.message);
  }
}

// ─────────────────────────────────────────
// VMESS
// ─────────────────────────────────────────

async function createvmessWeb(username, exp, quota, iplimit, serverId) {
  if (!isValidUsername(username)) return errorCard("Username tidak valid.");

  const server = await getServer(serverId);
  if (!server) return errorCard("Server tidak ditemukan.");

  const url = `http://${server.domain}:5888/createvmess?user=${username}&exp=${exp}&quota=${quota}&iplimit=${iplimit}&auth=${server.auth}`;

  try {
    const d = await callAPI(url, "VMESS");

    return `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Akun VMESS Berhasil Dibuat</div>
      <div class="rc-header-sub">${d.domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${d.domain}</code>`)}
    ${row("Username", `<code>${d.username}</code>`)}
    ${row("UUID",     `<code style="font-size:11px">${d.uuid}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Protocol", "VMess")}
    ${row("Network",  "WS / gRPC")}
    ${row("Quota",    `<span class="badge badge-green">${formatQuota(d.quota)}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${formatIpLimit(d.ip_limit)}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${d.expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("VMESS TLS",       d.vmess_tls_link)}
    ${linkBox("VMESS HTTP NTLS", d.vmess_nontls_link)}
    ${linkBox("VMESS gRPC",      d.vmess_grpc_link)}
  `)}

  ${section(iconDownload, "Unduh", `
    <div class="dl-row">
      <a href="https://${d.domain}:81/vmess-${d.username}.txt" target="_blank" class="download-link">
        ${iconFile} Info Akun
      </a>
    </div>
  `)}
</div>`;
  } catch (err) {
    return errorCard(err.message);
  }
}

// ─────────────────────────────────────────
// VLESS
// ─────────────────────────────────────────

async function createvlessWeb(username, exp, quota, iplimit, serverId) {
  if (!isValidUsername(username)) return errorCard("Username tidak valid.");

  const server = await getServer(serverId);
  if (!server) return errorCard("Server tidak ditemukan.");

  const url = `http://${server.domain}:5888/createvless?user=${username}&exp=${exp}&quota=${quota}&iplimit=${iplimit}&auth=${server.auth}`;

  try {
    const d = await callAPI(url, "VLESS");

    return `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Akun VLESS Berhasil Dibuat</div>
      <div class="rc-header-sub">${d.domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${d.domain}</code>`)}
    ${row("Username", `<code>${d.username}</code>`)}
    ${row("UUID",     `<code style="font-size:11px">${d.uuid}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Protocol", "VLess")}
    ${row("Network",  "WS / gRPC")}
    ${row("Quota",    `<span class="badge badge-green">${formatQuota(d.quota)}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${formatIpLimit(d.ip_limit)}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${d.expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("VLESS TLS",       d.vless_tls_link)}
    ${linkBox("VLESS HTTP NTLS", d.vless_nontls_link)}
    ${linkBox("VLESS gRPC",      d.vless_grpc_link)}
  `)}

  ${section(iconDownload, "Unduh", `
    <div class="dl-row">
      <a href="https://${d.domain}:81/vless-${d.username}.txt" target="_blank" class="download-link">
        ${iconFile} Info Akun
      </a>
    </div>
  `)}
</div>`;
  } catch (err) {
    return errorCard(err.message);
  }
}

// ─────────────────────────────────────────
// TROJAN
// ─────────────────────────────────────────

async function createtrojanWeb(username, exp, quota, iplimit, serverId) {
  if (!isValidUsername(username)) return errorCard("Username tidak valid.");

  const server = await getServer(serverId);
  if (!server) return errorCard("Server tidak ditemukan.");

  const url = `http://${server.domain}:5888/createtrojan?user=${username}&exp=${exp}&quota=${quota}&iplimit=${iplimit}&auth=${server.auth}`;

  try {
    const d = await callAPI(url, "TROJAN");

    return `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Akun TROJAN Berhasil Dibuat</div>
      <div class="rc-header-sub">${d.domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${d.domain}</code>`)}
    ${row("Username", `<code>${d.username}</code>`)}
    ${row("Password", `<code style="font-size:11px">${d.password || d.uuid}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Protocol", "Trojan")}
    ${row("Network",  "WS / gRPC")}
    ${row("Quota",    `<span class="badge badge-green">${formatQuota(d.quota)}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${formatIpLimit(d.ip_limit)}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${d.expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("TROJAN TLS",  d.trojan_tls_link)}
    ${linkBox("TROJAN gRPC", d.trojan_grpc_link)}
  `)}

  ${section(iconDownload, "Unduh", `
    <div class="dl-row">
      <a href="https://${d.domain}:81/trojan-${d.username}.txt" target="_blank" class="download-link">
        ${iconFile} Info Akun
      </a>
    </div>
  `)}
</div>`;
  } catch (err) {
    return errorCard(err.message);
  }
}

// ─────────────────────────────────────────
// SHADOWSOCKS
// ─────────────────────────────────────────

async function createshadowsocksWeb(username, exp, quota, iplimit, serverId) {
  if (!isValidUsername(username)) return errorCard("Username tidak valid.");

  const server = await getServer(serverId);
  if (!server) return errorCard("Server tidak ditemukan.");

  const url = `http://${server.domain}:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${iplimit}&auth=${server.auth}`;

  try {
    const d = await callAPI(url, "SHADOWSOCKS");

    return `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Akun Shadowsocks Dibuat</div>
      <div class="rc-header-sub">${d.domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${d.domain}</code>`)}
    ${row("Username", `<code>${d.username}</code>`)}
    ${row("Password", `<code>${d.password}</code>`)}
    ${row("Method",   `<code>${d.method || "aes-256-gcm"}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Protocol", "Shadowsocks")}
    ${row("Network",  "WS / gRPC")}
    ${row("Quota",    `<span class="badge badge-green">${formatQuota(d.quota)}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${formatIpLimit(d.ip_limit)}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${d.expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("SS TLS (WS)", d.ss_link_ws)}
    ${linkBox("SS gRPC",     d.ss_link_grpc)}
  `)}

  ${section(iconDownload, "Unduh", `
    <div class="dl-row">
      <a href="https://${d.domain}:81/shadowsocks-${d.username}.txt" target="_blank" class="download-link">
        ${iconFile} Info Akun
      </a>
    </div>
  `)}
</div>`;
  } catch (err) {
    return errorCard(err.message);
  }
}

module.exports = {
  createsshWeb,
  createvmessWeb,
  createvlessWeb,
  createtrojanWeb,
  createshadowsocksWeb,
};
