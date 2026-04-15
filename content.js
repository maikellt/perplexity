// content.js — YouTube → Perplexity Summarizer (v1.3)
// Estratégia: usa Innertube API (POST) para obter captionTracks frescos,
// evitando baseUrl com &exp=xpe (PoToken) que causa resposta vazia.

(function () {
  'use strict';

  const BUTTON_ID   = 'yt-perplexity-btn';
  const MAX_CHARS   = 8000;
  const LANG_PRIORITY = ['pt-BR', 'pt', 'pt-PT', 'en', 'en-US', 'en-GB'];

  // Contexto padrão do cliente web do YouTube (Innertube)
  const INNERTUBE_CONTEXT = {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20240101.00.00',
      hl: 'pt-BR',
      gl: 'BR',
    },
  };

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
  // Extrai INNERTUBE_API_KEY do HTML da página
  // ─────────────────────────────────────────────────────────────

  async function fetchInnertubeKey(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: 'include',
      headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`Falha na página: HTTP ${res.status}`);
    const html = await res.text();

    const m = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (!m) throw new Error('INNERTUBE_API_KEY não encontrada na página');
    return m[1];
  }

  // ─────────────────────────────────────────────────────────────
  // Chama a Innertube API para obter captionTracks frescos
  // (sem &exp=xpe, sem expiração problemática)
  // ─────────────────────────────────────────────────────────────

  async function fetchCaptionTracksViaInnertube(videoId, apiKey) {
    const url = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      body: JSON.stringify({
        context: INNERTUBE_CONTEXT,
        videoId,
      }),
    });

    if (!res.ok) throw new Error(`Innertube API: HTTP ${res.status}`);
    const data = await res.json();

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('Nenhuma legenda disponível neste vídeo');

    return tracks;
  }

  // ─────────────────────────────────────────────────────────────
  // Seleção da melhor faixa
  // ─────────────────────────────────────────────────────────────

  function pickBestTrack(tracks) {
    // 1. Manual no idioma preferido
    for (const lang of LANG_PRIORITY) {
      const t = tracks.find(t => t.vssId === '.' + lang);
      if (t) return { track: t, tlang: null };
    }
    // 2. ASR no idioma preferido
    for (const lang of LANG_PRIORITY) {
      const code = lang.split('-')[0];
      const t = tracks.find(
        t => (t.kind === 'asr' || t.vssId?.startsWith('.a.')) &&
             (t.languageCode === lang || t.languageCode === code)
      );
      if (t) return { track: t, tlang: null };
    }
    // 3. Qualquer manual + tradução automática para pt-BR
    const manual = tracks.find(t => t.kind !== 'asr' && !t.vssId?.startsWith('.a.'));
    if (manual) return { track: manual, tlang: 'pt-BR' };

    // 4. Qualquer faixa disponível
    return { track: tracks[0], tlang: 'pt-BR' };
  }

  // ─────────────────────────────────────────────────────────────
  // Busca da transcrição — XML (mais confiável que JSON3 para ASR)
  // ─────────────────────────────────────────────────────────────

  function buildTranscriptUrl(track, tlang) {
    // Remove fmt existente e parâmetros problemáticos
    let url = track.baseUrl
      .replace(/[&?]fmt=[^&]*/g, '')
      .replace(/[&?]exp=xpe[^&]*/g, '');

    // Garante o separador correto
    url += (url.includes('?') ? '&' : '?') + 'hl=pt-BR';
    if (tlang) url += `&tlang=${tlang}`;

    return url;
  }

  function parseXML(xmlText) {
    const matches = [...xmlText.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
    if (!matches.length) throw new Error('Nenhum segmento no XML da transcrição');

    return matches
      .map(m => m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&#39;/g,  "'")
        .replace(/&quot;/g, '"')
        .trim()
      )
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async function fetchTranscript(track, tlang) {
    const url = buildTranscriptUrl(track, tlang);

    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Transcrição: HTTP ${res.status}`);

    const text = await res.text();
    if (!text?.trim()) throw new Error('Resposta da transcrição vazia');

    // Tenta XML (padrão e mais confiável)
    if (text.trim().startsWith('<')) {
      const result = parseXML(text);
      if (result) return result;
      throw new Error('XML sem segmentos válidos');
    }

    // Tenta JSON3 como fallback
    if (text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      const result = (data.events ?? [])
        .filter(e => Array.isArray(e.segs))
        .map(e => e.segs.map(s => s.utf8 ?? '').join(''))
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (result) return result;
      throw new Error('JSON3 sem texto válido');
    }

    throw new Error('Formato de transcrição não reconhecido');
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

    const notes = [];
    if (isAsr) notes.push('transcrição gerada automaticamente — pode conter imprecisões');
    if (truncated) notes.push('transcrição truncada por limite de caracteres');

    return [
      'Resuma o vídeo do YouTube abaixo com base na transcrição fornecida.',
      '',
      `Título: ${title}`,
      `URL: ${videoUrl}`,
      ...(notes.length ? [`Notas: ${notes.join('; ')}`] : []),
      '',
      'Instruções:',
      '- Apresente os principais pontos em tópicos',
      '- Seja objetivo e claro',
      '- Responda em português do Brasil',
      '',
      'Transcrição:',
      body,
    ].join('\n');
  }

  // ─────────────────────────────────────────────────────────────
  // Estados do botão
  // ─────────────────────────────────────────────────────────────

  function applyState(btn, state, errorMsg) {
    const labels = {
      idle:    '▶ Resumir no Perplexity',
      loading: '⏳ Obtendo transcrição...',
      error:   errorMsg || '⚠ Sem transcrição disponível',
      success: '✓ Aberto no Perplexity',
    };
    btn.querySelector('.yt-pp-label').textContent = labels[state];
    btn.disabled = state !== 'idle';
    btn.dataset.state = state;
    if (state === 'error' || state === 'success') {
      setTimeout(() => applyState(btn, 'idle'), 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Handler principal
  // ─────────────────────────────────────────────────────────────

  async function handleClick(btn) {
    if (btn.disabled) return;
    applyState(btn, 'loading');

    try {
      const videoId = getVideoId();
      if (!videoId) throw new Error('ID do vídeo não encontrado');

      // 1. Obtém API key da página
      const apiKey = await fetchInnertubeKey(videoId);

      // 2. Busca faixas via Innertube (URLs frescas, sem PoToken)
      const tracks = await fetchCaptionTracksViaInnertube(videoId, apiKey);

      // Log diagnóstico (visível no console da extensão)
      console.log('[YT→Perplexity] Faixas disponíveis:', tracks.map(t =>
        `${t.languageCode} kind=${t.kind ?? 'manual'} vssId=${t.vssId}`
      ));

      // 3. Seleciona melhor faixa
      const { track, tlang } = pickBestTrack(tracks);
      const isAsr = track.kind === 'asr' || track.vssId?.startsWith('.a.');

      console.log('[YT→Perplexity] Faixa selecionada:', track.languageCode, 'ASR:', isAsr);

      // 4. Baixa transcrição
      const transcript = await fetchTranscript(track, tlang);

      // 5. Abre Perplexity
      const title    = getVideoTitle();
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const prompt   = buildPrompt(title, transcript, videoUrl, isAsr);

      window.open(
        `https://www.perplexity.ai/?q=${encodeURIComponent(prompt)}`,
        '_blank',
        'noopener,noreferrer'
      );

      applyState(btn, 'success');
    } catch (err) {
      console.error('[YT→Perplexity]', err.message, err);
      applyState(btn, 'error', err.message.length < 50 ? `⚠ ${err.message}` : undefined);
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

  window.addEventListener('yt-navigate-start',    removeButton);
  window.addEventListener('yt-page-data-updated', () => setTimeout(injectButton, 300));
  window.addEventListener('yt-navigate-finish',   () => setTimeout(injectButton, 1200));

  new MutationObserver(() => {
    if (window.location.pathname.startsWith('/watch') && !document.getElementById(BUTTON_ID)) {
      injectButton();
    }
  }).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

})();
