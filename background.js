// background.js — Service Worker (Manifest V3)
// Responsabilidades:
//   1. Gerenciar o badge do ícone da extensão conforme a aba ativa
//   2. Injetar content.js em abas do YouTube já abertas ao instalar/atualizar
//   3. Servir como ponto central de mensagens entre content.js e popup.js

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isYouTubeVideo(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.includes('youtube.com') &&
      u.pathname === '/watch' &&
      u.searchParams.has('v')
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge — indica visualmente se a extensão está ativa na aba atual
// ─────────────────────────────────────────────────────────────────────────────

function setBadgeActive(tabId) {
  chrome.action.setBadgeText({ text: '▶', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#4f98a3', tabId }); // teal Perplexity
  chrome.action.setTitle({ tabId, title: 'YT → Perplexity: pronto para resumir' });
}

function setBadgeInactive(tabId) {
  chrome.action.setBadgeText({ text: '', tabId });
  chrome.action.setTitle({ tabId, title: 'YT → Perplexity Summarizer' });
}

function updateBadge(tabId, url) {
  if (!tabId || !url) return;
  if (isYouTubeVideo(url)) {
    setBadgeActive(tabId);
  } else {
    setBadgeInactive(tabId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Injeção programática — garante funcionamento em abas já abertas
// ─────────────────────────────────────────────────────────────────────────────

async function injectIntoExistingTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
  } catch {
    return;
  }

  for (const tab of tabs) {
    if (!tab.id || tab.status !== 'complete') continue;

    try {
      // Verifica se o content script já foi injetado antes de reinjetar
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => !!document.getElementById('yt-perplexity-btn'),
      });

      const alreadyInjected = results?.[0]?.result;
      if (alreadyInjected) continue;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });

      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles.css'],
      });

      updateBadge(tab.id, tab.url);
    } catch (err) {
      // Aba pode não aceitar scripts (ex.: chrome:// ou extensões)
      console.warn(`[YT→Perplexity] Não foi possível injetar na aba ${tab.id}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instalação / Atualização
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    injectIntoExistingTabs();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Listeners de aba — mantém o badge sincronizado
// ─────────────────────────────────────────────────────────────────────────────

// Dispara ao terminar de carregar uma aba (incluindo navegação dentro do YouTube)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadge(tabId, tab.url);
  }
});

// Dispara ao trocar de aba
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) updateBadge(tabId, tab.url);
  } catch {
    // A aba pode ter sido fechada antes de responder
  }
});

// Limpa o badge ao fechar uma aba
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Message handler — canal de comunicação com content.js e popup.js
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // content.js avisa que abriu o Perplexity com sucesso
    case 'SUMMARY_OPENED':
      if (sender.tab?.id) setBadgeActive(sender.tab.id);
      sendResponse({ ok: true });
      break;

    // content.js avisa que não encontrou transcrição
    case 'TRANSCRIPT_ERROR':
      console.warn('[YT→Perplexity] Erro de transcrição:', message.reason);
      sendResponse({ ok: true });
      break;

    // popup.js pede o status atual da aba
    case 'GET_TAB_STATUS':
      chrome.tabs.query({ active: true, currentWindow: true })
        .then(([tab]) => {
          sendResponse({
            isVideo: tab?.url ? isYouTubeVideo(tab.url) : false,
            tabId:   tab?.id ?? null,
            url:     tab?.url ?? '',
          });
        })
        .catch(() => sendResponse({ isVideo: false, tabId: null, url: '' }));
      return true; // mantém o canal aberto para resposta assíncrona

    default:
      sendResponse({ ok: false, error: 'Mensagem desconhecida' });
  }
});
