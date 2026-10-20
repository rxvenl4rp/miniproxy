const SERVER_URL = "https://miniproxy-p53r.onrender.com";

const address = document.getElementById("address");
const welcomeAddress = document.getElementById("welcome-address");
const frame = document.getElementById("site-frame");
const welcome = document.getElementById("welcome");
const status = document.getElementById("status");

let currentUrl = "";
let historyList = [];
let historyIndex = -1;

function normalizeUrl(value) {
  let input = value.trim();
  if (!input) return null;

  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) {
    if (input.includes(" ") || !input.includes(".")) {
      return "https://duckduckgo.com/html/?q=" + encodeURIComponent(input);
    }
    input = "https://" + input;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function proxied(url) {
  return `${SERVER_URL}/proxy?url=${encodeURIComponent(url)}`;
}

function show(url, addHistory = true) {
  currentUrl = url;
  address.value = url;
  welcomeAddress.value = url;

  if (addHistory) {
    historyList = historyList.slice(0, historyIndex + 1);
    historyList.push(url);
    historyIndex = historyList.length - 1;
  }

  welcome.style.display = "none";
  frame.style.display = "block";
  status.textContent = `Loading ${new URL(url).hostname}…`;
  frame.src = proxied(url);
}

function navigate(value, addHistory = true) {
  const url = normalizeUrl(value);
  if (!url) {
    status.textContent = "Enter a valid website address.";
    return;
  }
  show(url, addHistory);
}

// The proxied page reports its real URL whenever it loads (links, forms, redirects).
window.addEventListener("message", event => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.type !== "miniproxy-nav" || typeof data.url !== "string") return;

  if (data.url !== currentUrl) {
    currentUrl = data.url;
    address.value = data.url;
    // Only add to history if this wasn't a back/forward move.
    if (historyList[historyIndex] !== data.url) {
      historyList = historyList.slice(0, historyIndex + 1);
      historyList.push(data.url);
      historyIndex = historyList.length - 1;
    }
  }
  if (data.title) document.title = data.title + " – Mini Proxy Viewer";
  try {
    status.textContent = `Loaded ${new URL(data.url).hostname}`;
  } catch {}
});

frame.addEventListener("load", () => {
  if (currentUrl && status.textContent.startsWith("Loading")) {
    status.textContent = `Loaded ${new URL(currentUrl).hostname}`;
  }
});

document.getElementById("nav-form").addEventListener("submit", event => {
  event.preventDefault();
  navigate(address.value);
});

document.getElementById("welcome-form").addEventListener("submit", event => {
  event.preventDefault();
  navigate(welcomeAddress.value);
});

document.getElementById("back").addEventListener("click", () => {
  if (historyIndex > 0) {
    historyIndex--;
    show(historyList[historyIndex], false);
  }
});

document.getElementById("forward").addEventListener("click", () => {
  if (historyIndex < historyList.length - 1) {
    historyIndex++;
    show(historyList[historyIndex], false);
  }
});

document.getElementById("reload").addEventListener("click", () => {
  if (currentUrl) show(currentUrl, false);
});

document.getElementById("open-tab").addEventListener("click", () => {
  if (currentUrl) chrome.tabs.create({ url: proxied(currentUrl) });
});
