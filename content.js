// content.js — Parte 1: Interceptação da URL e extração da transcrição

let subtitlesUrl = null;

/**
 * Recebe a URL interceptada pelo background service worker.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SUBTITLES_URL_INTERCEPTED") {
    subtitlesUrl = message.url;
  }
});

/**
 * Busca e faz o parse da transcrição a partir da URL capturada.
 * @returns {Promise<string>}
 */
async function fetchTranscript() {
  if (!subtitlesUrl) {
    throw new Error("URL da transcrição ainda não foi capturada. Reproduza o vídeo primeiro.");
  }

  const response = await fetch(subtitlesUrl);
  if (!response.ok) {
    throw new Error(`Falha ao buscar transcrição: HTTP ${response.status}`);
  }

  const xml = await response.text();
  return parseTranscriptXml(xml);
}

/**
 * Faz o parse do XML da API timedtext do YouTube.
 * @param {string} xmlString
 * @returns {string}
 */
function parseTranscriptXml(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");
  const nodes = doc.querySelectorAll("text");

  if (nodes.length === 0) {
    throw new Error("Nenhuma legenda encontrada no XML retornado.");
  }

  return Array.from(nodes)
    .map((node) =>
      node.textContent
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, " ")
        .trim()
    )
    .filter((line) => line.length > 0)
    .join(" ");
}

// content.js — Parte 2: Título, prompt e envio ao background

/**
 * Extrai o título do vídeo diretamente do DOM do YouTube.
 * Tenta seletores em ordem de prioridade (o DOM do YT muda com frequência).
 * @returns {string}
 */
function getVideoTitle() {
  const selectors = [
    "h1.ytd-watch-metadata yt-formatted-string",
    "h1.title.ytd-video-primary-info-renderer",
    "#title h1",
    "h1.ytd-video-primary-info-renderer",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) {
      return el.textContent.trim();
    }
  }

  // Fallback: título da aba, removendo sufixo " - YouTube"
  return document.title.replace(/ - YouTube$/, "").trim() || "Vídeo sem título";
}

/**
 * Monta o prompt enviado ao Perplexity.
 * Limita a transcrição a ~8.000 chars para não ultrapassar o limite de URL.
 * @param {string} title
 * @param {string} transcript
 * @returns {string}
 */
function buildPrompt(title, transcript) {
  const MAX_TRANSCRIPT_CHARS = 8000;

  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "... [transcrição truncada]"
      : transcript;

  return (
    `Assista ao vídeo do YouTube intitulado "${title}" e responda com base na transcrição abaixo.\n\n` +
    `TRANSCRIÇÃO:\n${truncated}\n\n` +
    `Por favor, faça um resumo detalhado dos principais pontos abordados no vídeo.`
  );
}

/**
 * Orquestra o fluxo completo:
 * 1. Busca a transcrição  2. Extrai o título
 * 3. Monta o prompt       4. Envia ao background
 * @returns {Promise<void>}
 */
async function openInPerplexity() {
  const title = getVideoTitle();
  let transcript;

  try {
    transcript = await fetchTranscript();
  } catch (err) {
    alert(`Não foi possível obter a transcrição:\n\n${err.message}`);
    return;
  }

  const prompt = buildPrompt(title, transcript);

  chrome.runtime.sendMessage({ type: "OPEN_PERPLEXITY", prompt }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("[YT→Perplexity] Erro ao comunicar com background:", chrome.runtime.lastError.message);
      return;
    }
    if (!response?.success) {
      console.error("[YT→Perplexity] Background reportou falha:", response?.error);
    }
  });
}
// content.js — Parte 3: Injeção do botão no player do YouTube
// content.js — Parte 3 (corrigida)

const BUTTON_ID = "yt-perplexity-btn";

function createButton() {
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.title = "Resumir no Perplexity";
  btn.setAttribute("aria-label", "Resumir vídeo no Perplexity");

  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
      <path d="M11 8v6M8 11h6"/>
    </svg>
  `;

  Object.assign(btn.style, {
    background: "transparent",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 6px",
    height: "100%",
    opacity: "0.9",
    transition: "opacity 0.15s ease",
  });

  btn.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "0.9"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    btn.style.opacity = "0.4";
    btn.disabled = true;
    openInPerplexity().finally(() => {
      btn.style.opacity = "0.9";
      btn.disabled = false;
    });
  });

  return btn;
}

function injectButton() {
  if (document.getElementById(BUTTON_ID)) return;

  const selectors = [
    ".ytp-right-controls",
    ".ytp-chrome-controls .ytp-right-controls",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      el.prepend(createButton());
      return true; // injetado com sucesso
    }
  }
  return false; // player ainda não está no DOM
}

/**
 * Tenta injetar com retries em intervalos crescentes (backoff linear).
 * Para assim que conseguir ou após esgotar as tentativas.
 */
function injectWithRetry(maxAttempts = 10, intervalMs = 500) {
  let attempts = 0;

  const timer = setInterval(() => {
    attempts++;
    const success = injectButton();

    if (success || attempts >= maxAttempts) {
      clearInterval(timer);
    }
  }, intervalMs);
}

/**
 * Escuta o evento nativo do YouTube para navegação entre vídeos (SPA).
 * Mais confiável que MutationObserver para esse caso específico.
 */
function observeNavigation() {
  // Evento disparado pelo próprio YouTube ao concluir navegação SPA
  window.addEventListener("yt-navigate-finish", () => {
    subtitlesUrl = null;
    injectWithRetry();
  });

  // Fallback: MutationObserver observando apenas o container do player,
  // não o body inteiro — muito mais eficiente
  const observer = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) {
      injectButton();
    }
  });

  // Observa apenas a região do player, não o DOM inteiro
  const playerContainer = document.querySelector("#movie_player, #player");
  if (playerContainer) {
    observer.observe(playerContainer, { childList: true, subtree: true });
  }
}

// --- Inicialização ---
injectWithRetry();
observeNavigation();