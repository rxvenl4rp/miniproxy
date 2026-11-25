const SERVER_URL = 'https://miniproxy-p53r.onrender.com';
const address = document.getElementById('address');
const welcomeAddress = document.getElementById('welcome-address');
const frame = document.getElementById('proxy-frame');
const welcome = document.getElementById('welcome');
const status = document.getElementById('status');
let historyList = [];
let historyIndex = -1;
let currentUrl = '';

function normalize(value) {
  let input = value.trim();
  if (!input) return null;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
    if (input.includes(' ') || !input.includes('.')) input = 'https://www.google.com/search?q=' + encodeURIComponent(input);
    else input = 'https://' + input;
  }
  try { const u = new URL(input); return u.protocol === 'https:' ? u.href : null; }
  catch { return null; }
}
function navigate(value, push = true) {
  const url = normalize(value);
  if (!url) { status.textContent = 'Enter a valid HTTPS address.'; return; }
  currentUrl = url;
  address.value = url;
  welcomeAddress.value = url;
  if (push) { historyList = historyList.slice(0, historyIndex + 1); historyList.push(url); historyIndex = historyList.length - 1; }
  welcome.style.display = 'none';
  frame.style.display = 'block';
  status.textContent = 'Loading through MiniProxy: ' + url;
  frame.src = SERVER_URL + '/proxy?url=' + encodeURIComponent(url);
}
document.getElementById('nav-form').addEventListener('submit', e => { e.preventDefault(); navigate(address.value); });
document.getElementById('welcome-form').addEventListener('submit', e => { e.preventDefault(); navigate(welcomeAddress.value); });
document.getElementById('back').addEventListener('click', () => { if (historyIndex > 0) { historyIndex--; navigate(historyList[historyIndex], false); } });
document.getElementById('forward').addEventListener('click', () => { if (historyIndex < historyList.length - 1) { historyIndex++; navigate(historyList[historyIndex], false); } });
document.getElementById('reload').addEventListener('click', () => { if (currentUrl) navigate(currentUrl, false); });
frame.addEventListener('load', () => { if (currentUrl) status.textContent = 'Proxy response loaded · ' + new URL(currentUrl).hostname; });
