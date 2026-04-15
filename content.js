// content.js — YouTube → Perplexity Summarizer (v1.2)
// Correções:
//   - Tratamento de resposta vazia / não-JSON na fetchTranscript
//   - Fallback XML quando fmt=json3 falha (comum em faixas ASR)
//   - fetchPlayerResponse mais robusto com regex tolerante
//   - Parâmetro &hl=pt-BR adicionado nas requisições de transcrição

(function () {
  'use strict';

  const BUTTON_ID = 'yt-perplexity-btn';
  const MAX_CHARS = 8000;
  const LANG_PRIORITY = ['pt-BR', 'pt', 'pt-PT', 'en', 'en-US', 'en-GB'];

  // ─────────────────────────────────────────────────────────────
  // Utilitários
  // ─────────────────────────────────────────────────────────────

  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v');
  }

  function getVideoTitle() {
    const selectors = [
      'h1.ytd-watch-metadata yt-formatted-string',
      'h1.style-scope.ytd-watch-metadata',
      '#title h1',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return document.title.replace(' - YouTube', '').trim();
  }

  // ─────────────────────────────────────────────────────────────
  // Obtenção do ytInitialPlayerResponse
  // Primeiro tenta o objeto em memória; se desatualizado ou sem
  // captions, faz fetch fresh do HTML da página.
  // ─────────────────────────────────────────────────────────────

  async function fetchPlayerResponse(videoId) {
    // 1ª tentativa: objeto em memória (válido apenas no carregamento direto)
    const cached = window.ytInitialPlayerResponse;
    if (cached?.videoDetails?.videoId === videoId &&
        cached?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
      return cached;
    }

    // 2ª tentativa: fetch fresh do HTML — garante URLs assinadas e válidas
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: 'include',
      headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`Falha ao buscar página: HTTP ${res.status}`);

    const html = await res.text();
    if (!html) throw new Error('Resposta da página veio vazia');

    const marker = 'ytInitialPlayerResponse = ';
    const start  = html.indexOf(marker);
    if (start === -1) throw new Error('Dados do vídeo não encontrados na página');

    // Extrai o JSON de forma tolerante (corta no próximo ;var / ;const ou </script>)
    const raw = html.slice(start + marker.length);
    const jsonStr = raw.split(/;(?:var|const|let)\s|\n<\/script>/)[0].trim();

    if (!jsonStr || jsonStr[0] !== '{') {
      throw new Error('Formato de resposta inesperado — tente recarregar a página');
    }

    return JSON.parse(jsonStr);
  }

  // ─────────────────────────────────────────────────────────────
  // Seleção da melhor faixa de legenda
  // vssId ".pt-BR"   = manual
  // vssId ".a.pt-BR" = ASR (gerada automaticamente)
  // ─────────────────────────────────────────────────────────────

  function pickBestTrack(tracks) {
    // 1. Manual no idioma preferido
    for (const lang of LANG_PRIORITY) {
      const t = tracks.find(t => t.vssId === '.' + lang);
      if (t) return { track: t, tlang: null };
    }
    // 2. ASR no idioma preferido
    for (const lang of LANG_PRIORITY) {
      const t = tracks.find(
        t => t.vssId === '.a.' + lang || (t.kind === 'asr' && t.languageCode === lang)
      );
      if (t) return { track: t, tlang: null };
    }
    // 3. Qualquer manual + solicita tradução automática
    const manual = tracks.find(t => t.vssId?.startsWith('.') && !t.vssId?.startsWith('.a.'));
    if (manual) return { track: manual, tlang: 'pt-BR' };

    // 4. Qualquer faixa disponível
    if (tracks[0]) return { track: tracks[0], tlang: 'pt-BR' };

    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // Busca da transcrição — tenta JSON3, cai em XML se falhar
  // ─────────────────────────────────────────────────────────────

  async function fetchTranscriptJSON3(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    if (!text || text.trim() === '') throw new Error('Resposta vazia');
    if (text.trim()[0] !== '{') throw new Error('Resposta não é JSON: ' + text.slice(0, 80));

    const data = JSON.parse(text);
    const result = (data.events ?? [])
      .filter(e => Array.isArray(e.segs))
      .map(e => e.segs.map(s => s.utf8 ?? '').join(''))
      .join(' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!result) throw new Error('JSON3 retornou eventos sem texto');
    return result;
  }

  async function fetchTranscriptXML(url) {
    // Fallback: formato XML (padrão quando fmt não é especificado)
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const xml = await res.text();
    if (!xml || xml.trim() === '') throw new Error('XML vazio');

    // Extrai o texto de cada <text>...</text>, removendo tags HTML internas
    const matches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
    if (!matches.length) throw new Error('Nenhum segmento de texto encontrado no XML');

    const result = matches
      .map(m => m[1]
        .replace(/<[^>]+>/g, '')          // remove tags HTML internas
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&#39;/g,  "'")
        .replace(/&quot;/g, '"')
      )
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!result) throw new Error('XML retornou apenas tags vazias');
    return result;
  }

  async function fetchTranscript(track, tlang) {
    // Monta parâmetros base — &hl=pt-BR ajuda a obter ASR traduzido
    const baseUrl = track.baseUrl
      + '&hl=pt-BR'
      + (tlang ? `&tlang=${tlang}` : '');

    // Tenta JSON3 primeiro (mais estruturado)
    try {
      return await fetchTranscriptJSON3(baseUrl + '&fmt=json3');
    } catch (errJson) {
      console.warn('[YT→Perplexity] JSON3 falhou, tentando XML:', errJson.message);
    }

    // Fallback: XML nativo do YouTube
    return await fetchTranscriptXML(baseUrl);
  }

  // ─────────────────────────────────────────────────────────────
  // Construção do prompt
  // ─────────────────────────────────────────────────────────────

  function buildPrompt(title, transcript, videoUrl, isAsr) {
    let body = transcript;
    let truncated = false;
    if (body.length > MAX_CHARS) {
      body = body.slice(0, MAX_CHARS);
      truncated = true;
    }

    const lines = [
      'Resuma o vídeo do YouTube abaixo com base na transcrição fornecida.',
      '',
      `Título: ${title}`,
      `URL: ${videoUrl}`,
    ];

    if (isAsr) {
      lines.push('Nota: transcrição gerada automaticamente pelo YouTube — pode conter imprecisões.');
    }
    if (truncated) {
      lines.push('Nota: transcrição truncada por limite de caracteres.');
    }

    lines.push(
      '',
      'Instruções:',
      '- Apresente os principais pontos abordados',
      '- Use tópicos quando houver múltiplos assuntos distintos',
      '- Seja objetivo e claro',
      '- Responda em português do Brasil',
      '',
      'Transcrição:',
      body
    );

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────
  // Estados do botão
  // ─────────────────────────────────────────────────────────────

  const BTN_STATES = {
    idle:    { label: '▶ Resumir no Perplexity', disabled: false },
    loading: { label: '⏳ Extraindo transcrição...', disabled: true },
    error:   { label: '⚠ Sem transcrição disponível', disabled: true },
    success: { label: '✓ Aberto no Perplexity', disabled: true },
  };

  function applyState(btn, state) {
    const s = BTN_STATES[state];
    btn.querySelector('.yt-pp-label').textContent = s.label;
    btn.disabled = s.disabled;
    btn.dataset.state = state;
    if (state === 'error' || state === 'success') {
      setTimeout(() => applyState(btn, 'idle'), 2500);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Handler do clique
  // ─────────────────────────────────────────────────────────────

  async function handleClick(btn) {
    if (btn.disabled) return;
    applyState(btn, 'loading');

    try {
      const videoId = getVideoId();
      if (!videoId) throw new Error('ID do vídeo não encontrado');

      const playerResponse = await fetchPlayerResponse(videoId);
      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

      if (!tracks.length) throw new Error('Nenhuma legenda disponível neste vídeo');

      const result = pickBestTrack(tracks);
      if (!result) throw new Error('Nenhuma faixa de legenda selecionável');

      const { track, tlang } = result;
      const isAsr = track.kind === 'asr' || track.vssId?.startsWith('.a.');

      const transcript = await fetchTranscript(track, tlang);
      const title      = getVideoTitle();
      const videoUrl   = `https://www.youtube.com/watch?v=${videoId}`;
      const prompt     = buildPrompt(title, transcript, videoUrl, isAsr);

      const perplexityUrl = `https://www.perplexity.ai/?q=${encodeURIComponent(prompt)}`;
      window.open(perplexityUrl, '_blank', 'noopener,noreferrer');

      applyState(btn, 'success');
    } catch (err) {
      console.error('[YT→Perplexity]', err.message);
      applyState(btn, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Injeção do botão
  // ─────────────────────────────────────────────────────────────

  const ACTION_BAR_SELECTORS = [
    'ytd-watch-metadata #actions',
    '#top-level-buttons-computed',
    'ytd-watch-flexy #actions',
  ];

  function findActionBar() {
    for (const s of ACTION_BAR_SELECTORS) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function injectButton() {
    if (!window.location.pathname.startsWith('/watch')) return;
    if (document.getElementById(BUTTON_ID)) return;

    const actionBar = findActionBar();
    if (!actionBar) return;

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.dataset.state = 'idle';
    btn.setAttribute('aria-label', 'Resumir este vídeo no Perplexity');
    btn.innerHTML = `<span class="yt-pp-label">▶ Resumir no Perplexity</span>`;
    btn.addEventListener('click', () => handleClick(btn));

    actionBar.parentElement.insertBefore(btn, actionBar.nextSibling);
  }

  // ─────────────────────────────────────────────────────────────
  // Observadores de navegação SPA
  // ─────────────────────────────────────────────────────────────

  function removeButton() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  window.addEventListener('yt-navigate-start', removeButton);

  window.addEventListener('yt-page-data-updated', () => {
    setTimeout(injectButton, 300);
  });

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(injectButton, 1200);
  });

  const observer = new MutationObserver(() => {
    if (window.location.pathname.startsWith('/watch') && !document.getElementById(BUTTON_ID)) {
      injectButton();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ─────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

})();
