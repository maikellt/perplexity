// popup.js — Lógica do popup da extensão YT → Perplexity Summarizer

(function () {
  'use strict';

  // ── Elementos do DOM ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  const states = {
    loading:  $('state-loading'),
    noYt:     $('state-no-yt'),
    noVideo:  $('state-no-video'),
    ready:    $('state-ready'),
  };

  const btnSummarize  = $('btn-summarize');
  const btnLabel      = $('btn-label');
  const titleChip     = $('video-title-chip');
  const titleText     = $('video-title-text');
  const toast         = $('toast');
  const toastText     = $('toast-text');

  let toastTimer = null;

  // ── Exibição de estados ───────────────────────────────────────────────────

  function showState(name) {
    Object.values(states).forEach(el => el.classList.add('hidden'));
    states[name]?.classList.remove('hidden');
  }

  function showToast(message, type = 'ok') {
    clearTimeout(toastTimer);
    toastText.textContent = message;
    toast.className = `toast show ${type}`;
    toastTimer = setTimeout(() => {
      toast.className = 'toast';
    }, 3000);
  }

  // ── Comunicação com a aba ativa ───────────────────────────────────────────

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  }

  function isYouTubeVideo(url) {
    try {
      const u = new URL(url);
      return u.hostname.includes('youtube.com') && u.pathname === '/watch' && u.searchParams.has('v');
    } catch { return false; }
  }

  function isYouTube(url) {
    try {
      return new URL(url).hostname.includes('youtube.com');
    } catch { return false; }
  }

  // ── Recupera o título do vídeo via content script ─────────────────────────

  async function getVideoTitleFromTab(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
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
        },
      });
      return results?.[0]?.result ?? '';
    } catch {
      return '';
    }
  }

  // ── Aciona o resumo via content script ────────────────────────────────────

  async function triggerSummarize(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const btn = document.getElementById('yt-perplexity-btn');
          if (btn && !btn.disabled) {
            btn.click();
            return 'clicked';
          }
          return 'not-found';
        },
      });
    } catch (err) {
      throw new Error('Não foi possível comunicar com a página: ' + err.message);
    }
  }

  // ── Handler do botão ──────────────────────────────────────────────────────

  async function handleSummarize() {
    if (btnSummarize.disabled) return;

    btnSummarize.disabled = true;
    btnLabel.textContent = '⏳ Processando...';

    try {
      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('Aba não encontrada');

      await triggerSummarize(tab.id);

      btnLabel.textContent = '✓ Aberto no Perplexity';
      showToast('Nova aba aberta com o resumo!', 'ok');

      setTimeout(() => {
        btnLabel.textContent = 'Resumir no Perplexity';
        btnSummarize.disabled = false;
      }, 2500);
    } catch (err) {
      btnLabel.textContent = 'Resumir no Perplexity';
      btnSummarize.disabled = false;
      showToast('Erro: ' + err.message, 'error');
    }
  }

  // ── Init: detecta o contexto da aba atual ─────────────────────────────────

  async function init() {
    showState('loading');

    try {
      const tab = await getActiveTab();
      const url = tab?.url ?? '';

      if (!isYouTube(url)) {
        showState('noYt');
        return;
      }

      if (!isYouTubeVideo(url)) {
        showState('noVideo');
        return;
      }

      // Está em uma página de vídeo
      showState('ready');

      // Tenta exibir o título do vídeo
      const title = await getVideoTitleFromTab(tab.id);
      if (title) {
        titleText.textContent = title;
        titleChip.classList.remove('hidden');
      }

      btnSummarize.addEventListener('click', handleSummarize);

    } catch (err) {
      console.error('[YT→Perplexity popup]', err);
      showState('noYt');
    }
  }

  // Aguarda o DOM estar pronto e inicializa
  document.addEventListener('DOMContentLoaded', init);

})();
