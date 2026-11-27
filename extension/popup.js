/* global chrome */
'use strict';

const $ = (id) => document.getElementById(id);

function setStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

async function getZpwSek() {
  const cookies = await chrome.cookies.getAll({ domain: 'zalo.me', name: 'zpw_sek' });
  if (cookies.length === 0) return null;
  return cookies[0].value;
}

async function getImei() {
  const tabs = await chrome.tabs.query({ url: '*://chat.zalo.me/*' });
  if (tabs.length === 0) return null;
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: () => localStorage.getItem('z_uuid'),
  });
  return results?.[0]?.result ?? null;
}

$('btnExport').addEventListener('click', async () => {
  $('btnExport').disabled = true;
  setStatus('Đang đọc...', 'info');
  try {
    const [zpwSek, imei] = await Promise.all([getZpwSek(), getImei()]);
    if (!zpwSek) {
      setStatus('Không tìm thấy cookie zpw_sek. Hãy đăng nhập chat.zalo.me trước.', 'error');
      $('btnExport').disabled = false;
      return;
    }
    if (!imei) {
      setStatus('Không đọc được z_uuid. Hãy mở tab chat.zalo.me rồi thử lại.', 'error');
      $('btnExport').disabled = false;
      return;
    }
    $('imei').value = imei;
    $('zpwSek').value = zpwSek;
    $('btnCopy').disabled = false;
    $('btnDownload').disabled = false;
    setStatus('Xuất thành công!', 'success');
  } catch (err) {
    setStatus('Lỗi: ' + err.message, 'error');
  }
  $('btnExport').disabled = false;
});

$('btnCopy').addEventListener('click', async () => {
  const text = `ZALO_BROWSER_IMEI=${$('imei').value}\nZALO_BROWSER_ZPW_SEK=${$('zpwSek').value}`;
  await navigator.clipboard.writeText(text);
  setStatus('Đã copy dạng .env vào clipboard!', 'success');
});

$('btnDownload').addEventListener('click', () => {
  const now = new Date().toISOString();
  const session = {
    imei: $('imei').value,
    cookie: [{
      key: 'zpw_sek',
      value: $('zpwSek').value,
      domain: 'zalo.me',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false,
      sameSite: 'none',
      creation: now,
      lastAccessed: now,
    }],
    userAgent: navigator.userAgent,
  };
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'zalo-session.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Đã tải zalo-session.json! Nhớ xoá file sau khi nạp vào bridge.', 'success');
});
