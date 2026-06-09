// apitrial-web.js
const axios = require("axios");

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

async function callTrialApi(server, path) {
  if (!server || !server.domain || !server.auth) {
    throw new Error("Data server tidak lengkap (domain / auth kosong).");
  }

  const url = `http://${server.domain}:5888/${path}?auth=${encodeURIComponent(server.auth)}`;

  let apiRes;
  try {
    apiRes = await axios.get(url, { timeout: 15000 });
  } catch (e) {
    console.error(`Gagal call API ${path}:`, e?.message || e);
    throw new Error("Tidak dapat terhubung ke server. Silakan coba lagi.");
  }

  if (!apiRes.data || apiRes.data.status !== "success") {
    const msgErr = apiRes.data?.message || "Server error";
    throw new Error(`Gagal membuat akun trial. ${msgErr}`);
  }

  return apiRes.data.data || apiRes.data;
}

function formatIpLimit(ipLimit) {
  const limit = String(ipLimit || "0");
  return limit === "0" ? "Unlimited" : `${limit} IP`;
}

function formatQuota(quota) {
  return !quota || quota === "0 GB" ? "Unlimited" : quota;
}

// ─────────────────────────────────────────
// BASE STYLE — tema dashboard
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

  .rc-header {
    background: linear-gradient(150deg, #3D0F72 0%, #7B2FBE 55%, #9B4FDE 100%);
    padding: 16px 20px;
    display: flex; align-items: center; gap: 10px;
    position: relative; overflow: hidden;
  }
  .rc-header::before {
    content: '';
    position: absolute; top: -30px; right: -20px;
    width: 100px; height: 100px;
    border: 24px solid rgba(255,255,255,0.07);
    border-radius: 50%;
  }
  .rc-header-icon {
    width: 38px; height: 38px; border-radius: 12px;
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
    color: #fff; line-height: 1.1; letter-spacing: -0.2px;
  }
  .rc-header-sub {
    font-size: 11px; color: rgba(255,255,255,0.65);
    font-weight: 700; margin-top: 2px;
  }

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

  .rc-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 9px; gap: 10px;
    font-size: 13px;
  }
  .rc-row:last-child { margin-bottom: 0; }
  .rc-label { color: #A882CC; font-weight: 700; white-space: nowrap; min-width: 80px; }
  .rc-value { color: #1A0533; font-weight: 800; text-align: right; word-break: break-all; }
  .rc-value code {
    background: #F3EAFD; border-radius: 6px;
    padding: 2px 8px; font-size: 12px;
    color: #5A1A9A; font-weight: 800; font-family: monospace;
  }

  .badge {
    display: inline-block; padding: 3px 11px;
    border-radius: 20px; font-size: 11px; font-weight: 800;
  }
  .badge-green  { background: #E6FAF4; color: #12C28A; border: 1px solid rgba(18,194,138,0.25); }
  .badge-purple { background: #F3EAFD; color: #7B2FBE; border: 1px solid rgba(123,47,190,0.2); }
  .badge-orange { background: #FFF0E0; color: #FF6B2B; border: 1px solid rgba(255,107,43,0.2); }

  .port-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 7px;
  }
  .port-item {
    background: #F7F0FD; border: 1px solid #E8D8F8;
    border-radius: 10px; padding: 8px 12px;
    font-size: 12px; font-weight: 800; color: #1A0533;
  }
  .port-item span {
    color: #A882CC; font-size: 10px; font-weight: 800;
    text-transform: uppercase; letter-spacing: 0.5px;
    display: block; margin-bottom: 2px;
  }

  .link-box {
    background: #F7F0FD; border: 1.5px solid #E8D8F8;
    border-radius: 14px; padding: 12px 14px; margin-bottom: 10px;
  }
  .link-box:last-child { margin-bottom: 0; }
  .link-label {
    font-size: 10px; font-weight: 800; color: #6B3FA0;
    text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;
  }
  .link-row { display: flex; gap: 8px; align-items: stretch; }
  .link-text {
  background: #fff;
  border: 1.5px solid #E8D8F8;
  border-radius: 10px;

  padding: 8px 10px;

  color: #5A1A9A;
  font-size: 11px;
  font-weight: 700;

  flex: 1;

  word-break: break-all;

  min-height: 54px;

  -webkit-user-select: all;
  user-select: all;

  font-family: monospace;

  outline: none;
}
  .copy-btn {
    background: linear-gradient(135deg, #5A1A9A, #7B2FBE);
    color: #fff; border: none; border-radius: 10px;
    padding: 8px 13px; font-size: 11px; font-weight: 900;
    cursor: pointer; white-space: nowrap;
    font-family: 'Nunito', sans-serif; transition: opacity 0.15s;
    transition:
  transform .15s,
  opacity .15s;
  }
  .copy-btn:hover { opacity: 0.85; }

  .dl-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .download-link {
    display: inline-flex; align-items: center; gap: 6px;
    background: #F3EAFD; border: 1.5px solid #E8D8F8;
    color: #5A1A9A; padding: 9px 16px; border-radius: 12px;
    text-decoration: none; font-size: 12px; font-weight: 800;
    font-family: 'Nunito', sans-serif; transition: background 0.15s, border-color 0.15s;
  }
  .download-link:hover { background: #EAD5FA; border-color: #C9A8F0; }
  .download-link svg {
    width: 14px; height: 14px; fill: none; stroke: #5A1A9A;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }

  .rc-error {
    font-family: 'Nunito', sans-serif;
    background: #FFECEC; border: 1.5px solid rgba(232,64,64,0.25);
    border-radius: 16px; padding: 16px 20px;
    display: flex; align-items: center; gap: 10px;
    color: #E84040; font-weight: 800; font-size: 14px; margin-top: 14px;
  }
  .rc-error svg {
    width: 20px; height: 20px; fill: none; stroke: #E84040;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0;
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

// ── SVG icon strings ──
const iconInfo     = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16" stroke-width="3"/></svg>`;
const iconGrid     = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
const iconClock    = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const iconLink     = `<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const iconDownload = `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const iconFile     = `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const iconKey      = `<svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;

// ── Reusable builders ──
function linkBox(label, link) {
  const safeLink = link || "-";
  // Menggunakan encodeURIComponent agar tidak merusak HTML quote pembungkus onclick
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
      <button class="copy-btn" onclick="copyText(this, '${encoded}')">Copy</button>
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

function dlRow(...links) {
  return `<div class="dl-row">${links.join("")}</div>`;
}

function dlBtn(href, icon, label) {
  return `<a href="${href}" target="_blank" class="download-link">${icon} ${label}</a>`;
}

// ─────────────────────────────────────────
// TRIAL SSH
// ─────────────────────────────────────────

async function createsshTrialWeb(server) {
  let d;
  try { d = await callTrialApi(server, "trialssh"); }
  catch (e) { return { message: errorCard(e.message), username: "-", expired: "-", serverName: server.nama_server || "-" }; }

  const username = d.username || "-";
  const password = d.password || "-";
  const expired  = d.expiration || d.exp || d.expired || d.expiry || "Tidak diketahui";
  const domain   = d.domain || server.domain || "-";
  const ipLimit  = formatIpLimit(d.ip_limit || d.iplimit);
  const ports    = d.ports || {};
  const gp       = (k, fb) => ports[k] || ports[k.toLowerCase()] || fb;

  const msg = `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Trial SSH Berhasil</div>
      <div class="rc-header-sub">${domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${domain}</code>`)}
    ${row("Username", `<code>${username}</code>`)}
    ${row("Password", `<code>${password}</code>`)}
  `)}

  ${section(iconGrid, "Konfigurasi Port", `
    <div class="port-grid">
      <div class="port-item"><span>OpenSSH</span>${gp("openssh", "22, 80, 443")}</div>
      <div class="port-item"><span>Dropbear</span>${gp("dropbear", "109, 443")}</div>
      <div class="port-item"><span>SSH WS</span>${gp("ssh_ws", "80")}</div>
      <div class="port-item"><span>SSH SSL WS</span>${gp("ssh_ssl_ws", "443")}</div>
      <div class="port-item"><span>OVPN TCP</span>${gp("ovpn_tcp", "1194")}</div>
      <div class="port-item"><span>OVPN UDP</span>${gp("ovpn_udp", "2200")}</div>
    </div>
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Expired",  `<span class="badge badge-orange">${expired}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${ipLimit}</span>`)}
  `)}

  ${section(iconDownload, "Unduh", dlRow(
    dlBtn(`https://${domain}:81/allovpn.zip`,        iconDownload, "All OVPN"),
    dlBtn(`https://${domain}:81/ssh-${username}.txt`, iconFile,     "Info Akun")
  ))}
</div>`;

  return { message: msg, username, password, expired, serverName: server.nama_server || "-" };
}

// ─────────────────────────────────────────
// TRIAL VMESS
// ─────────────────────────────────────────

async function createvmessTrialWeb(server) {
  let d;
  try { d = await callTrialApi(server, "trialvmess"); }
  catch (e) { return { message: errorCard(e.message), username: "-", expired: "-", serverName: server.nama_server || "-" }; }

  const username   = d.username || "-";
  const uuid       = d.uuid || "-";
  const domain     = d.domain || server.domain || "-";
  const city       = d.city || "-";
  const ns_domain  = d.ns_domain || d.ns || "-";
  const public_key = d.public_key || d.pubkey || "Not Available";
  const expired    = d.expiration || d.exp || d.expired || d.expiry || "Tidak diketahui";
  const quota      = formatQuota(d.quota || d.quota_gb);
  const ipLimit    = formatIpLimit(d.ip_limit || d.iplimit);
  const tls_link   = d.link_tls || d.vmess_tls_link || "-";
  const ntls_link  = d.link_ntls || d.vmess_nontls_link || "-";
  const grpc_link  = d.link_grpc || d.vmess_grpc_link || "-";

  const msg = `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Trial VMESS Berhasil</div>
      <div class="rc-header-sub">${domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${domain}</code>`)}
    ${row("Username", `<code>${username}</code>`)}
    ${row("UUID",     `<code style="font-size:11px">${uuid}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Location", city)}
    ${row("NS Domain", ns_domain)}
    ${row("Quota",    `<span class="badge badge-green">${quota}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${ipLimit}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("VMESS TLS",       tls_link)}
    ${linkBox("VMESS HTTP NTLS", ntls_link)}
    ${linkBox("VMESS gRPC",      grpc_link)}
  `)}

  ${section(iconKey, "Public Key", linkBox("Public Key", public_key))}

  ${section(iconDownload, "Unduh", dlRow(
    dlBtn(`https://${domain}:81/vmess-${username}.txt`, iconFile, "Info Akun")
  ))}
</div>`;

  return { message: msg, username, expired, serverName: server.nama_server || "-" };
}

// ─────────────────────────────────────────
// TRIAL VLESS
// ─────────────────────────────────────────

async function createvlessTrialWeb(server) {
  let d;
  try { d = await callTrialApi(server, "trialvless"); }
  catch (e) { return { message: errorCard(e.message), username: "-", expired: "-", serverName: server.nama_server || "-" }; }

  const username  = d.username || "-";
  const uuid      = d.uuid || "-";
  const domain    = d.domain || server.domain || "-";
  const pubkey    = d.public_key || d.pubkey || "N/A";
  const expired   = d.expired || d.expiration || d.exp || d.expiry || "Tidak diketahui";
  const quota     = formatQuota(d.quota || d.quota_gb);
  const ipLimit   = formatIpLimit(d.ip_limit || d.iplimit);
  const tls_link  = d.vless_tls_link || d.link_tls || "-";
  const ntls_link = d.vless_nontls_link || d.link_ntls || "-";
  const grpc_link = d.vless_grpc_link || d.link_grpc || "-";

  const msg = `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Trial VLESS Berhasil</div>
      <div class="rc-header-sub">${domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${domain}</code>`)}
    ${row("Username", `<code>${username}</code>`)}
    ${row("UUID",     `<code style="font-size:11px">${uuid}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Network",  "WS / gRPC")}
    ${row("Quota",    `<span class="badge badge-green">${quota}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${ipLimit}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("VLESS TLS",       tls_link)}
    ${linkBox("VLESS HTTP NTLS", ntls_link)}
    ${linkBox("VLESS gRPC",      grpc_link)}
  `)}

  ${section(iconKey, "Public Key", linkBox("Public Key", pubkey))}

  ${section(iconDownload, "Unduh", dlRow(
    dlBtn(`https://${domain}:81/vless-${username}.txt`, iconFile, "Info Akun")
  ))}
</div>`;

  return { message: msg, username, expired, serverName: server.nama_server || "-" };
}

// ─────────────────────────────────────────
// TRIAL TROJAN
// ─────────────────────────────────────────

async function createtrojanTrialWeb(server) {
  let d;
  try { d = await callTrialApi(server, "trialtrojan"); }
  catch (e) { return { message: errorCard(e.message), username: "-", expired: "-", serverName: server.nama_server || "-" }; }

  const username     = d.username || "-";
  const domain       = d.domain || server.domain || "-";
  const uuid_or_pass = d.password || d.uuid || "-";
  const pubkey       = d.pubkey || d.public_key || d.publicKey || "Not Available";
  const expired      = d.expired || d.expiration || d.exp || d.expiry || "Tidak diketahui";
  const quota        = formatQuota(d.quota || d.quota_gb);
  const ipLimit      = formatIpLimit(d.ip_limit || d.iplimit);
  const tls_link     = d.trojan_tls_link || d.trojan_tls || d.link_tls || "-";
  const grpc_link    = d.trojan_grpc_link || d.trojan_grpc || d.link_grpc || "-";

  const msg = `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Trial TROJAN Berhasil</div>
      <div class="rc-header-sub">${domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",          `<code>${domain}</code>`)}
    ${row("Username",        `<code>${username}</code>`)}
    ${row("UUID / Password", `<code style="font-size:11px">${uuid_or_pass}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Network",  "WS / gRPC")}
    ${row("Quota",    `<span class="badge badge-green">${quota}</span>`)}
    ${row("IP Limit", `<span class="badge badge-purple">${ipLimit}</span>`)}
    ${row("Expired",  `<span class="badge badge-orange">${expired}</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("TROJAN TLS",  tls_link)}
    ${linkBox("TROJAN gRPC", grpc_link)}
  `)}

  ${section(iconKey, "Public Key", linkBox("Public Key", pubkey))}

  ${section(iconDownload, "Unduh", dlRow(
    dlBtn(`https://${domain}:81/trojan-${username}.txt`, iconFile, "Info Akun")
  ))}
</div>`;

  return { message: msg, username, expired, serverName: server.nama_server || "-" };
}

// ─────────────────────────────────────────
// TRIAL SHADOWSOCKS
// ─────────────────────────────────────────

async function createshadowsocksTrialWeb(server) {
  let d;
  try { d = await callTrialApi(server, "trialshadowsocks"); }
  catch (e) { return { message: errorCard(e.message), username: "-", expired: "-", serverName: server.nama_server || "-" }; }

  const username   = d.username || "-";
  const password   = d.password || d.uuid || "-";
  const method     = d.method || "-";
  const domain     = d.domain || server.domain || "-";
  const ns_domain  = d.ns_domain || "-";
  const city       = d.city || "-";
  const public_key = d.public_key || d.pubkey || "Not Available";
  const expired    = d.expiration || d.exp || d.expired || d.expiry || "Tidak diketahui";
  const link_ws    = d.ss_link_ws || d.link_ws || "N/A";
  const link_grpc  = d.ss_link_grpc || d.link_grpc || "N/A";

  const msg = `${baseStyle}
<div class="rc">
  <div class="rc-header">
    <div class="rc-header-icon">
      <svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    </div>
    <div class="rc-header-text">
      <div class="rc-header-title">Trial Shadowsocks Berhasil</div>
      <div class="rc-header-sub">${domain}</div>
    </div>
  </div>

  ${section(iconInfo, "Info Akun", `
    ${row("Server",   `<code>${domain}</code>`)}
    ${row("Username", `<code>${username}</code>`)}
    ${row("Password", `<code>${password}</code>`)}
    ${row("Method",   `<code>${method}</code>`)}
  `)}

  ${section(iconClock, "Detail Akun", `
    ${row("Location",  city)}
    ${row("NS Domain", ns_domain)}
    ${row("Expired",   `<span class="badge badge-orange">${expired}</span>`)}
    ${row("IP Limit",  `<span class="badge badge-purple">Unlimited</span>`)}
  `)}

  ${section(iconLink, "Config Links", `
    ${linkBox("SS TLS (WS)", link_ws)}
    ${linkBox("SS gRPC",     link_grpc)}
  `)}

  ${section(iconKey, "Public Key", linkBox("Public Key", public_key))}

  ${section(iconDownload, "Unduh", dlRow(
    dlBtn(`https://${domain}:81/shadowsocks-${username}.txt`, iconFile, "Info Akun")
  ))}
</div>`;

  return { message: msg, username, expired, serverName: server.nama_server || "-" };
}

module.exports = {
  createsshTrialWeb,
  createvmessTrialWeb,
  createvlessTrialWeb,
  createtrojanTrialWeb,
  createshadowsocksTrialWeb,
};
