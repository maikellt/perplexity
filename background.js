// background.js — Service Worker (Manifest V3)

/**
 * Intercepta requisições à API de transcrição do YouTube e repassa
 * a URL para o content script da aba correspondente.
 */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;

    chrome.tabs
      .sendMessage(details.tabId, {
        type: "SUBTITLES_URL_INTERCEPTED",
        url: details.url,
      })
      .catch(() => {
        // Aba pode ainda não ter o content script pronto — ignora silenciosamente
      });
  },
  { urls: ["*://www.youtube.com/api/timedtext*"] }
);

/**
 * Abre uma nova aba do Perplexity com o prompt montado pelo content script.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "OPEN_PERPLEXITY") return false;

  const { prompt } = message;

  if (!prompt || typeof prompt !== "string") {
    sendResponse({ success: false, error: "Prompt inválido ou ausente." });
    return false;
  }

  const encoded = encodeURIComponent(prompt);
  const url = `https://www.perplexity.ai/?q=${encoded}`;

  chrome.tabs
    .create({ url })
    .then(() => sendResponse({ success: true }))
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true; // resposta assíncrona
});

/**
 * Ao instalar a extensão, injeta o content script em todas as abas
 * do YouTube já abertas.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/watch*" });

  for (const tab of tabs) {
    if (!tab.id) continue;

    chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ["content.js"],
      })
      .catch(() => {});
  }
});