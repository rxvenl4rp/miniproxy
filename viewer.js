
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
      return "https://www.google.com/search?q=" +
        encodeURIComponent(input);
    }
    input = "https://" + input;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

async function navigate(value, addHistory = true) {
  const url = normalizeUrl(value);

  if (!url) {
    status.textContent = "Enter a valid HTTPS website address.";
    return;
  }

  currentUrl = url;
  address.value = url;
  welcomeAddress.value = url;

  if (addHistory) {
    historyList = historyList.slice(0, historyIndex + 1);
    historyList.push(url);
    historyIndex = historyList.length - 1;
  }

  welcome.style.display = "none";
  frame.style.display = "none";
  status.textContent = "Connecting to server…";

  try {
    const response = await fetch(`${SERVER_URL}/api/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "The server rejected this request.");
    }

    // Display returned text safely, without interpreting it as HTML.
    const output = document.createElement("pre");
    output.textContent = data.text || "No text was returned.";
    output.style.cssText =
      "white-space:pre-wrap;overflow-wrap:anywhere;" +
      "font:16px/1.6 Arial,sans-serif;padding:20px;" +
      "margin:0;max-width:900px;color:inherit;";

    const container = document.getElementById("text-results");
    if (!container) {
      status.textContent =
        "Missing text-results element. Update viewer.html as well.";
      return;
    }

    container.replaceChildren(output);
    container.style.display = "block";
    status.textContent = `Loaded text from ${new URL(url).hostname}`;
  } catch (error) {
    status.textContent = `Unable to load: ${error.message}`;
  }
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
  if (currentUrl) navigate(currentUrl, false);
});

document.getElementById("open-tab").addEventListener("click", () => {
  if (currentUrl) chrome.tabs.create({ url: currentUrl });
});
