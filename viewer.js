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
      return "https://www.google.com/search?q=" + encodeURIComponent(input);
    }
    input = "https://" + input;
  }
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch { return null; }
}

async function navigate(value, addHistory = true) {
  const url = normalizeUrl(value);
  if (!url) {
    status.textContent = "Enter a valid HTTP or HTTPS website address.";
    return;
  }
  currentUrl = url;
  address.value = url;
  welcomeAddress.value = url;
  welcome.style.display = "none";
  frame.style.display = "block";
  status.textContent = "Loading " + url + " · Embedded viewing may be blocked by the website.";
  if (addHistory) {
    historyList = historyList.slice(0, historyIndex + 1);
    historyList.push(url);
    historyIndex = historyList.length - 1;
  }
  frame.src = url;
}

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
    navigate(historyList[historyIndex], false);
  }
});
document.getElementById("forward").addEventListener("click", () => {
  if (historyIndex < historyList.length - 1) {
    historyIndex++;
    navigate(historyList[historyIndex], false);
  }
});
document.getElementById("reload").addEventListener("click", () => {
  if (currentUrl) frame.src = currentUrl;
});
document.getElementById("open-tab").addEventListener("click", () => {
  if (currentUrl) chrome.tabs.create({ url: currentUrl });
});
frame.addEventListener("load", () => {
  status.textContent = "Frame finished loading. A blank/error page may mean the website blocks embedding.";
});