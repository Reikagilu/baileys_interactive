(function () {
  'use strict';
  const API = '';
  const API_KEY_STORAGE_KEY = 'rscara_api_key';

  const REQUIRED_EVENTS = [
    'APPLICATION_STARTUP', 'CALL', 'CHATS_DELETE', 'CHATS_SET', 'CHATS_UPDATE', 'CHATS_UPSERT',
    'CONNECTION_UPDATE', 'CONTACTS_SET', 'CONTACTS_UPDATE', 'CONTACTS_UPSERT',
    'GROUP_PARTICIPANTS_UPDATE', 'GROUP_UPDATE', 'GROUPS_UPSERT',
    'LABELS_ASSOCIATION', 'LABELS_EDIT', 'LOGOUT_INSTANCE',
    'MESSAGES_DELETE', 'MESSAGES_SET', 'MESSAGES_UPDATE', 'MESSAGES_UPSERT',
    'PRESENCE_UPDATE', 'QRCODE_UPDATED', 'REMOVE_INSTANCE', 'SEND_MESSAGE',
    'TYPEBOT_CHANGE_STATUS', 'TYPEBOT_START',
  ];

  // ============ Instance from URL ============
  const params = new URLSearchParams(window.location.search);
  const instance = (params.get('instance') || '').trim();
  if (!instance) {
    alert('Instância não informada. Abra a partir da lista de conexões.');
    window.location.href = '/';
    return;
  }

  // ============ API key ============
  function getStoredApiKey() {
    try {
      const ls = localStorage.getItem(API_KEY_STORAGE_KEY);
      if (ls) return ls;
      const ss = sessionStorage.getItem(API_KEY_STORAGE_KEY);
      if (ss) { localStorage.setItem(API_KEY_STORAGE_KEY, ss); return ss; }
    } catch {}
    return '';
  }
  function storeApiKey(k) {
    try {
      if (k) { localStorage.setItem(API_KEY_STORAGE_KEY, k); sessionStorage.setItem(API_KEY_STORAGE_KEY, k); }
      else { localStorage.removeItem(API_KEY_STORAGE_KEY); sessionStorage.removeItem(API_KEY_STORAGE_KEY); }
    } catch {}
  }
  const apiKeyInput = document.getElementById('apiKey');
  const stored = getStoredApiKey();
  if (stored && !apiKeyInput.value) apiKeyInput.value = stored;
  apiKeyInput.addEventListener('input', () => storeApiKey(apiKeyInput.value.trim()));

  function headers() {
    const h = {
      'Content-Type': 'application/json',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    };
    const k = apiKeyInput.value.trim() || getStoredApiKey();
    if (k) { h['x-api-key'] = k; storeApiKey(k); }
    return h;
  }

  async function api(path, options = {}) {
    const init = { headers: headers(), cache: 'no-store', ...options };
    if (init.headers !== options.headers) {
      init.headers = { ...init.headers, ...(options.headers || {}) };
    }
    const r = await fetch(API + path, init);
    let data = null;
    try { data = await r.json(); } catch { data = {}; }
    return { response: r, data };
  }

  async function apiBinary(path) {
    const r = await fetch(API + path, { headers: headers(), cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.blob();
  }

  // ============ Helpers ============
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function show(el, visible) { if (el) el.classList.toggle('hidden', !visible); }
  function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
  function setResult(el, msg, tone) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'result' + (tone ? ' ' + tone : '');
    show(el, !!msg);
  }
  const hideTimers = new Map();
  function setResultAuto(el, msg, tone) {
    setResult(el, msg, tone);
    if (hideTimers.has(el)) clearTimeout(hideTimers.get(el));
    if (tone === 'success' && msg) {
      hideTimers.set(el, setTimeout(() => show(el, false), 4200));
    }
  }

  // ============ State ============
  const state = {
    activeSection: 'dashboard',
    inFlight: new Set(),
    selectedChatJid: '',
    chatItems: [],
    chatItemsBySig: new Map(),
    chatFilter: 'all',
    chatSearch: '',
    availableEvents: [],
    autoSyncedChats: new Set(),
    mediaObjectUrls: new Set(),
    mediaBlobCache: new Map(),
    mediaResolveInFlight: new Map(),
    syncPollHandle: null,
    syncPollBusy: false,
    uiPollHandle: null,
    uiPollBusy: false,
    renderedChatJid: '',
    renderedMessagesMeta: [],
    loadedChatJid: '',
    loadedMessagesMeta: [],
    lastChatListMeta: [],
    activeChatNode: null,
  };

  function beginLoad(key) {
    if (state.inFlight.has(key)) return false;
    state.inFlight.add(key);
    return true;
  }
  function endLoad(key) { state.inFlight.delete(key); }

  // ============ Element refs ============
  const el = {
    sidebarInstanceName: document.getElementById('sidebarInstanceName'),
    instanceTitle: document.getElementById('instanceTitle'),
    instanceSubtitle: document.getElementById('instanceSubtitle'),
    topbarLastSync: document.getElementById('topbarLastSync'),
    headerStatusChip: document.getElementById('headerStatusChip'),
    btnForceRefresh: document.getElementById('btnForceRefresh'),

    // Dashboard
    dashInstance: document.getElementById('dashInstance'),
    dashNumber: document.getElementById('dashNumber'),
    dashProfileName: document.getElementById('dashProfileName'),
    dashConnectionStatus: document.getElementById('dashConnectionStatus'),
    dashboardStatus: document.getElementById('dashboardStatus'),
    dashProfilePicture: document.getElementById('dashProfilePicture'),
    dashProfileFallback: document.getElementById('dashProfileFallback'),
    dashboardConnectMode: document.getElementById('dashboardConnectMode'),
    dashboardPhoneRow: document.getElementById('dashboardPhoneRow'),
    dashboardPairingPhone: document.getElementById('dashboardPairingPhone'),
    dashboardPairingBox: document.getElementById('dashboardPairingBox'),
    dashboardPairingCode: document.getElementById('dashboardPairingCode'),
    dashboardQrBox: document.getElementById('dashboardQrBox'),
    dashboardQrImage: document.getElementById('dashboardQrImage'),
    btnDashboardConnect: document.getElementById('btnDashboardConnect'),
    btnDashboardRestart: document.getElementById('btnDashboardRestart'),
    btnDashboardDisconnect: document.getElementById('btnDashboardDisconnect'),
    dashChatsCount: document.getElementById('dashChatsCount'),
    dashMessagesCount: document.getElementById('dashMessagesCount'),
    dashUnreadCount: document.getElementById('dashUnreadCount'),

    // Chat
    chatList: document.getElementById('chatList'),
    chatSearchInput: document.getElementById('chatSearchInput'),
    chatHeaderTitle: document.getElementById('chatHeaderTitle'),
    chatHeaderMeta: document.getElementById('chatHeaderMeta'),
    chatHeaderAvatar: document.getElementById('chatHeaderAvatar'),
    chatHeaderActions: document.getElementById('chatHeaderActions'),
    chatMessages: document.getElementById('chatMessages'),
    chatComposerInput: document.getElementById('chatComposerInput'),
    btnSendChatMessage: document.getElementById('btnSendChatMessage'),
    btnRefreshChats: document.getElementById('btnRefreshChats'),
    btnSyncChatHistory: document.getElementById('btnSyncChatHistory'),
    btnSyncSelectedHistory: document.getElementById('btnSyncSelectedHistory'),

    // Settings
    settings: {
      rejectCalls: document.getElementById('settingRejectCalls'),
      ignoreGroups: document.getElementById('settingIgnoreGroups'),
      alwaysOnline: document.getElementById('settingAlwaysOnline'),
      autoReadMessages: document.getElementById('settingAutoReadMessages'),
      syncFullHistory: document.getElementById('settingSyncFullHistory'),
      readStatus: document.getElementById('settingReadStatus'),
    },
    proxy: {
      enabled: document.getElementById('proxyEnabled'),
      protocol: document.getElementById('proxyProtocol'),
      host: document.getElementById('proxyHost'),
      port: document.getElementById('proxyPort'),
      username: document.getElementById('proxyUsername'),
      password: document.getElementById('proxyPassword'),
    },
    btnSaveGeneral: document.getElementById('btnSaveGeneral'),
    btnSaveProxy: document.getElementById('btnSaveProxy'),
    settingsResult: document.getElementById('settingsResult'),

    // Events
    eventsWebhookUrl: document.getElementById('eventsWebhookUrl'),
    eventsToggles: document.getElementById('eventsToggles'),
    btnSaveEvents: document.getElementById('btnSaveEvents'),
    btnTestEvent: document.getElementById('btnTestEvent'),
    btnMarkAllEvents: document.getElementById('btnMarkAllEvents'),
    btnUnmarkAllEvents: document.getElementById('btnUnmarkAllEvents'),
    eventsResult: document.getElementById('eventsResult'),

    // Integrations
    intChatwoot: {
      enabled: document.getElementById('intChatwootEnabled'),
      baseUrl: document.getElementById('intChatwootBaseUrl'),
      accountId: document.getElementById('intChatwootAccountId'),
      inboxId: document.getElementById('intChatwootInboxId'),
      token: document.getElementById('intChatwootToken'),
      signMessages: document.getElementById('intChatwootSignMessages'),
      signDelimiter: document.getElementById('intChatwootSignDelimiter'),
      nameInbox: document.getElementById('intChatwootNameInbox'),
      webhookSlug: document.getElementById('intChatwootWebhookSlug'),
      organization: document.getElementById('intChatwootOrganization'),
      logoUrl: document.getElementById('intChatwootLogoUrl'),
      conversationPending: document.getElementById('intChatwootConversationPending'),
      reopenConversation: document.getElementById('intChatwootReopenConversation'),
      importContacts: document.getElementById('intChatwootImportContacts'),
      importMessages: document.getElementById('intChatwootImportMessages'),
      daysLimit: document.getElementById('intChatwootDaysLimit'),
      ignoreJids: document.getElementById('intChatwootIgnoreJids'),
      autoCreate: document.getElementById('intChatwootAutoCreate'),
      webhookInfo: document.getElementById('intChatwootWebhookInfo'),
      webhookUrl: document.getElementById('intChatwootWebhookUrl'),
    },
    intN8n: {
      enabled: document.getElementById('intN8nEnabled'),
      webhookUrl: document.getElementById('intN8nWebhookUrl'),
      headerName: document.getElementById('intN8nHeaderName'),
      headerValue: document.getElementById('intN8nHeaderValue'),
    },
    btnSaveIntChatwoot: document.getElementById('btnSaveIntChatwoot'),
    btnTestIntChatwoot: document.getElementById('btnTestIntChatwoot'),
    btnAutoCreateIntChatwoot: document.getElementById('btnAutoCreateIntChatwoot'),
    btnSyncContactNamesIntChatwoot: document.getElementById('btnSyncContactNamesIntChatwoot'),
    btnSyncHistoryIntChatwoot: document.getElementById('btnSyncHistoryIntChatwoot'),
    btnSaveIntN8n: document.getElementById('btnSaveIntN8n'),
    btnTestIntN8n: document.getElementById('btnTestIntN8n'),
    intAutoCreateResult: document.getElementById('intAutoCreateResult'),
    integrationsResult: document.getElementById('integrationsResult'),

    // Sync progress
    intSyncProgress: document.getElementById('intSyncProgress'),
    intSyncBadge: document.getElementById('intSyncBadge'),
    intSyncCurrent: document.getElementById('intSyncCurrent'),
    intSyncFill: document.getElementById('intSyncFill'),
    intSyncChats: document.getElementById('intSyncChats'),
    intSyncSent: document.getElementById('intSyncSent'),
    intSyncSkipped: document.getElementById('intSyncSkipped'),
    intSyncErrors: document.getElementById('intSyncErrors'),
    btnCancelSyncInt: document.getElementById('btnCancelSyncInt'),
  };

  // ============ Status chip ============
  function updateHeaderStatus(status) {
    const s = (status || '').toLowerCase();
    const map = {
      connected: 'state-connected', open: 'state-connected',
      disconnected: 'state-disconnected', close: 'state-disconnected',
      qr: 'state-qr', pairing: 'state-pairing', connecting: 'state-connecting',
    };
    const cls = map[s] || 'state-disconnected';
    el.headerStatusChip.className = 'status-pill ' + cls;
    el.headerStatusChip.textContent = s || 'unknown';
  }

  function markSynced() {
    const t = new Date().toLocaleTimeString('pt-BR');
    setText(el.topbarLastSync, `Atualizado ${t}`);
    show(el.topbarLastSync, true);
  }

  // ============ Section switching ============
  const navBtns = document.querySelectorAll('.nav-btn[data-section]');
  const sections = document.querySelectorAll('section.section');

  function sectionFromHash() {
    const h = (window.location.hash || '#dashboard').replace('#', '');
    return ['dashboard', 'chat', 'settings', 'events', 'integrations'].includes(h) ? h : 'dashboard';
  }

  function switchSection(next) {
    state.activeSection = next;
    navBtns.forEach((b) => {
      const active = b.dataset.section === next;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    sections.forEach((s) => s.classList.toggle('active', s.id === 'section-' + next));
    if (window.location.hash !== '#' + next) {
      window.history.replaceState(null, '', '#' + next);
    }
    loadSection(next);
  }
  navBtns.forEach((b) => b.addEventListener('click', () => switchSection(b.dataset.section)));
  window.addEventListener('hashchange', () => switchSection(sectionFromHash()));

  function loadSection(name) {
    if (name === 'dashboard') loadDashboard();
    else if (name === 'chat') loadChats();
    else if (name === 'settings') loadSettings();
    else if (name === 'events') loadEvents();
    else if (name === 'integrations') loadIntegrations();
  }

  // ============ Header status (always polled) ============
  async function loadHeaderStatus() {
    if (!beginLoad('header')) return;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/details`);
      if (response.ok) updateHeaderStatus(data.status);
    } catch {} finally { endLoad('header'); }
  }

  // ============ Dashboard ============
  async function loadDashboard() {
    if (!beginLoad('dashboard')) return;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/details`);
      if (!response.ok) return;
      updateHeaderStatus(data.status);
      setText(el.dashInstance, data.instance || instance);
      setText(el.dashNumber, data.linkedNumber || '—');
      setText(el.dashProfileName, data.profileName || '—');
      setText(el.dashConnectionStatus, data.status || '—');

      if (data.profilePictureUrl) {
        el.dashProfilePicture.src = data.profilePictureUrl;
        show(el.dashProfilePicture, true);
        show(el.dashProfileFallback, false);
      } else {
        show(el.dashProfilePicture, false);
        show(el.dashProfileFallback, true);
        setText(el.dashProfileFallback, (data.profileName || data.instance || '?')[0].toUpperCase());
      }

      // QR / pairing
      if (data.status === 'qr') {
        const qrRes = await api(`/v1/instances/${encodeURIComponent(instance)}/qr`);
        if (qrRes.response.ok && qrRes.data.qr) {
          el.dashboardQrImage.src = qrRes.data.qr;
          show(el.dashboardQrBox, true);
        }
      } else {
        show(el.dashboardQrBox, false);
      }
      if (data.status === 'connected') show(el.dashboardPairingBox, false);

      // Stats
      const statsRes = await api(`/v1/instances/${encodeURIComponent(instance)}/chats`);
      if (statsRes.response.ok) {
        applyDashboardStats(Array.isArray(statsRes.data.chats) ? statsRes.data.chats : []);
      }
      markSynced();
    } catch {} finally { endLoad('dashboard'); }
  }

  function applyDashboardStats(chats) {
    const totalMsg = chats.reduce((a, c) => a + (Number(c.messageCount) || 0), 0);
    const totalUnread = chats.reduce((a, c) => a + (Number(c.unreadCount) || 0), 0);
    setText(el.dashChatsCount, String(chats.length));
    setText(el.dashMessagesCount, String(totalMsg));
    setText(el.dashUnreadCount, String(totalUnread));
  }

  el.dashboardConnectMode.addEventListener('change', () => {
    show(el.dashboardPhoneRow, el.dashboardConnectMode.value === 'pairing');
  });

  async function connectFromDashboard() {
    setResult(el.dashboardStatus, 'Conectando...', '');
    try {
      if (el.dashboardConnectMode.value === 'pairing') {
        const phone = (el.dashboardPairingPhone.value || '').replace(/\D/g, '');
        if (!phone) { setResult(el.dashboardStatus, 'Informe o número.', 'error'); return; }
        const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/pairing-code`, {
          method: 'POST', body: JSON.stringify({ phoneNumber: phone })
        });
        if (!response.ok) { setResult(el.dashboardStatus, data.error || 'Falha.', 'error'); return; }
        el.dashboardPairingCode.textContent = data.pairingCode || '-';
        show(el.dashboardPairingBox, true);
        show(el.dashboardQrBox, false);
        setResult(el.dashboardStatus, `Pairing code gerado para ${phone}.`, 'success');
      } else {
        const { response, data } = await api('/v1/instances', { method: 'POST', body: JSON.stringify({ instance }) });
        if (data.qr) {
          el.dashboardQrImage.src = data.qr;
          show(el.dashboardQrBox, true);
          setResult(el.dashboardStatus, 'Escaneie o QR.', '');
        } else if (data.status === 'connected') {
          setResult(el.dashboardStatus, 'Conectado.', 'success');
        } else {
          setResult(el.dashboardStatus, 'Aguardando QR...', '');
        }
      }
      loadDashboard();
    } catch (err) { setResult(el.dashboardStatus, err.message || 'Erro.', 'error'); }
  }

  async function dashboardAction(action) {
    setResult(el.dashboardStatus, action + '...', '');
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/${action}`, { method: 'POST' });
      if (!response.ok) { setResult(el.dashboardStatus, data.error || 'Falha.', 'error'); return; }
      setResult(el.dashboardStatus, action + ' executado.', 'success');
      setTimeout(loadDashboard, 800);
    } catch (err) { setResult(el.dashboardStatus, err.message || 'Erro.', 'error'); }
  }

  el.btnDashboardConnect.addEventListener('click', connectFromDashboard);
  el.btnDashboardRestart.addEventListener('click', () => dashboardAction('restart'));
  el.btnDashboardDisconnect.addEventListener('click', () => dashboardAction('disconnect'));

  // ============ Chat (diff-render) ============
  function chatItemSig(c) {
    return JSON.stringify({
      j: c.jid, t: c.title, l: c.lastMessage, ts: c.lastTimestamp,
      m: c.messageCount, u: c.unreadCount,
    });
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function applyChatFilter(chats) {
    const q = state.chatSearch.toLowerCase();
    return chats.filter((c) => {
      if (state.chatFilter === 'unread' && !(Number(c.unreadCount) > 0)) return false;
      if (state.chatFilter === 'groups' && !c.jid?.endsWith('@g.us')) return false;
      if (q) {
        const txt = ((c.title || '') + ' ' + (c.jid || '') + ' ' + (c.lastMessage || '')).toLowerCase();
        if (!txt.includes(q)) return false;
      }
      return true;
    });
  }

  function renderChatList() {
    const filtered = applyChatFilter(state.chatItems);
    const container = el.chatList;

    if (filtered.length === 0) {
      const msg = state.chatSearch ? 'Nenhum chat para a busca.'
        : state.chatItems.length === 0 ? 'Sem conversas em cache. Envie/receba mensagens para popular.'
        : 'Nenhum chat para o filtro.';
      container.innerHTML = `<div class="chat-empty-list">${escapeHtml(msg)}</div>`;
      state.chatItemsBySig.clear();
      state.activeChatNode = null;
      return;
    }

    // Diff render: keep DOM elements when sig unchanged
    const newSigs = new Map();
    const fragment = document.createDocumentFragment();

    filtered.forEach((c) => {
      const sig = chatItemSig(c) + (c.jid === state.selectedChatJid ? ':sel' : '');
      let node = state.chatItemsBySig.get(sig);
      if (!node) {
        node = createChatItemNode(c);
        if (c.jid === state.selectedChatJid) node.classList.add('active');
      }
      newSigs.set(sig, node);
      fragment.appendChild(node);
    });

    // Replace children using fragment (browser keeps existing nodes that are reused)
    container.replaceChildren(fragment);
    state.chatItemsBySig = newSigs;
    state.activeChatNode = container.querySelector('.chat-item.active');
  }

  function createChatItemNode(c) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-item';
    btn.dataset.jid = c.jid;
    const initial = (c.title || c.jid || '?')[0].toUpperCase();
    const unread = Number(c.unreadCount) || 0;
    const msgCount = Number(c.messageCount) || 0;
    btn.innerHTML = `
      <div class="chat-item-avatar">${escapeHtml(initial)}</div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(c.title || c.jid || '')}</span>
          <span class="chat-item-time">${escapeHtml(formatTimestamp(c.lastTimestamp))}</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-preview">${escapeHtml(c.lastMessage || '—')}</span>
          <span class="chat-item-badges">
            ${msgCount > 0 ? `<span class="chat-item-badge">${msgCount}</span>` : ''}
            ${unread > 0 ? `<span class="chat-item-badge unread">${unread}</span>` : ''}
          </span>
        </div>
      </div>`;
    btn.addEventListener('click', () => {
      const previousJid = state.selectedChatJid;
      state.selectedChatJid = c.jid;
      if (previousJid !== c.jid) revokeMediaUrls();
      if (state.activeChatNode && state.activeChatNode !== btn) {
        state.activeChatNode.classList.remove('active');
      }
      btn.classList.add('active');
      state.activeChatNode = btn;
      // reset unread locally
      const target = state.chatItems.find((x) => x.jid === c.jid);
      if (target) target.unreadCount = 0;
      loadChatMessages();
    });
    return btn;
  }

  document.querySelectorAll('.pill-tab[data-chat-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.pill-tab[data-chat-filter]').forEach((x) => x.classList.toggle('active', x === b));
      state.chatFilter = b.dataset.chatFilter;
      renderChatList();
    });
  });
  el.chatSearchInput.addEventListener('input', () => {
    state.chatSearch = el.chatSearchInput.value.trim();
    renderChatList();
  });

  function chatListMeta(chats) {
    return chats.map((c) => [
      c.jid || '',
      c.title || '',
      c.lastMessage || '',
      Number(c.lastTimestamp) || 0,
      Number(c.messageCount) || 0,
      Number(c.unreadCount) || 0,
    ]);
  }
  function sameTupleList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i];
      const right = b[i];
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let j = 0; j < left.length; j += 1) {
        if (left[j] !== right[j]) return false;
      }
    }
    return true;
  }
  async function loadChats() {
    if (!beginLoad('chats')) return;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/chats`);
      if (!response.ok) {
        if (state.chatItems.length === 0) {
          el.chatList.innerHTML = `<div class="chat-empty-list">${escapeHtml(data.error || 'Erro ao carregar.')}</div>`;
        }
        return;
      }
      const chats = Array.isArray(data.chats) ? data.chats : [];
      const meta = chatListMeta(chats);
      if (sameTupleList(meta, state.lastChatListMeta)) return;
      state.lastChatListMeta = meta;
      state.chatItems = chats;
      renderChatList();
      markSynced();
    } catch (err) {
      if (state.chatItems.length === 0) {
        el.chatList.innerHTML = `<div class="chat-empty-list">${escapeHtml(err.message || 'Erro de rede.')}</div>`;
      }
    } finally { endLoad('chats'); }
  }

  // ============ Chat messages (sem flicker) ============
  function getSelectedChat() {
    return state.chatItems.find((c) => c.jid === state.selectedChatJid);
  }

  function setChatHeader() {
    const c = getSelectedChat();
    if (!c) {
      setText(el.chatHeaderTitle, 'Selecione um chat');
      setText(el.chatHeaderMeta, 'Nenhuma conversa ativa');
      setText(el.chatHeaderAvatar, '?');
      show(el.chatHeaderActions, false);
      el.chatComposerInput.disabled = true;
      el.btnSendChatMessage.disabled = true;
      return;
    }
    setText(el.chatHeaderTitle, c.title || c.jid);
    setText(el.chatHeaderMeta, `${c.jid} • ${c.messageCount || 0} msg`);
    setText(el.chatHeaderAvatar, ((c.title || c.jid || '?')[0] || '?').toUpperCase());
    show(el.chatHeaderActions, true);
    el.chatComposerInput.disabled = false;
    updateSendButtonState();
  }

  function inferMime(kind) {
    return ({ audio: 'audio/ogg', image: 'image/jpeg', sticker: 'image/webp', video: 'video/mp4', document: 'application/octet-stream' })[kind] || 'application/octet-stream';
  }

  function buildMediaDataUrl(media) {
    if (!media?.base64) return '';
    const mime = media.mimeType || inferMime(media.kind);
    return `data:${mime};base64,${media.base64}`;
  }

  async function resolveMediaSource(media) {
    if (!media) return '';
    if (media.url) {
      const cached = state.mediaBlobCache.get(media.url);
      if (cached) return cached;
      const pending = state.mediaResolveInFlight.get(media.url);
      if (pending) return pending;
      const request = (async () => {
        try {
          const blob = await apiBinary(media.url);
          const url = URL.createObjectURL(blob);
          state.mediaObjectUrls.add(url);
          state.mediaBlobCache.set(media.url, url);
          return url;
        } catch {
          return '';
        } finally {
          state.mediaResolveInFlight.delete(media.url);
        }
      })();
      state.mediaResolveInFlight.set(media.url, request);
      try {
        return await request;
      } catch { return ''; }
    }
    return buildMediaDataUrl(media);
  }

  function revokeMediaUrls() {
    state.mediaObjectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
    state.mediaObjectUrls.clear();
    state.mediaBlobCache.clear();
    state.mediaResolveInFlight.clear();
  }

  function messageMeta(msg) {
    return {
      id: msg.id || '',
      ts: Number(msg.timestamp) || 0,
      fromMe: !!msg.fromMe,
      text: msg.text || '',
      kind: msg.media?.kind || '',
      omittedReason: msg.media?.omittedReason || '',
    };
  }

  function canAppendMessages(msgs) {
    if (state.renderedChatJid !== state.selectedChatJid) return false;
    if (!Array.isArray(state.renderedMessagesMeta) || state.renderedMessagesMeta.length === 0) return false;
    if (msgs.length <= state.renderedMessagesMeta.length) return false;
    for (let i = 0; i < state.renderedMessagesMeta.length; i += 1) {
      const prev = state.renderedMessagesMeta[i];
      const next = messageMeta(msgs[i]);
      if (prev.id !== next.id || prev.ts !== next.ts || prev.fromMe !== next.fromMe || prev.text !== next.text || prev.kind !== next.kind || prev.omittedReason !== next.omittedReason) {
        return false;
      }
    }
    return true;
  }

  function messagesMeta(msgs) {
    return msgs.map((m) => [
      m.id || '',
      Number(m.timestamp) || 0,
      m.text || '',
      m.fromMe ? 1 : 0,
      m.media?.kind || '',
      m.media?.omittedReason || '',
    ]);
  }

  function formatBubbleAuthor(m) {
    if (m.fromMe) return 'Você';
    if (m.senderName && m.senderNumber) return `${m.senderName} (${m.senderNumber})`;
    return m.senderName || m.senderNumber || 'Contato';
  }

  function formatMessageTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function renderChatMessages(msgs) {
    if (!msgs || msgs.length === 0) {
      if (state.renderedChatJid !== state.selectedChatJid) revokeMediaUrls();
      state.renderedChatJid = state.selectedChatJid;
      state.renderedMessagesMeta = [];
      state.loadedChatJid = state.selectedChatJid;
      state.loadedMessagesMeta = [];
      el.chatMessages.innerHTML = `<div class="chat-empty-thread">Sem mensagens. Use Histórico para sincronizar.</div>`;
      return;
    }

    const shouldAppend = canAppendMessages(msgs);
    const wasNearBottom = (el.chatMessages.scrollHeight - el.chatMessages.scrollTop - el.chatMessages.clientHeight) < 72;

    if (!shouldAppend) {
      if (state.renderedChatJid !== state.selectedChatJid) revokeMediaUrls();
      el.chatMessages.innerHTML = '';
    }

    let lastDay = '';
    if (shouldAppend && state.renderedMessagesMeta.length > 0) {
      const prev = state.renderedMessagesMeta[state.renderedMessagesMeta.length - 1];
      lastDay = new Date(prev.ts).toLocaleDateString('pt-BR');
    }
    const fragment = document.createDocumentFragment();
    const mediaTasks = [];

    msgs.slice(shouldAppend ? state.renderedMessagesMeta.length : 0).forEach((m) => {
      const d = new Date(Number(m.timestamp));
      const day = d.toLocaleDateString('pt-BR');
      if (day !== lastDay && !isNaN(d.getTime())) {
        const div = document.createElement('div');
        div.className = 'chat-day-divider';
        div.textContent = day;
        fragment.appendChild(div);
        lastDay = day;
      }

      const bubble = document.createElement('article');
      bubble.className = 'chat-bubble' + (m.fromMe ? ' me' : '');

      const author = document.createElement('strong');
      author.className = 'chat-bubble-author';
      author.textContent = formatBubbleAuthor(m);
      bubble.appendChild(author);

      // Media
      const media = m.media;
      let textToShow = m.text || '';
      if (media && /^\[[a-z]+\]$/i.test((textToShow || '').trim())) textToShow = media.caption || '';

      if (media && media.kind && media.kind !== 'text') {
        const mediaEl = document.createElement('div');
        mediaEl.className = 'chat-media-wrap';
        if (media.kind === 'image' || media.kind === 'sticker') {
          const img = document.createElement('img');
          img.className = media.kind === 'sticker' ? 'chat-media-sticker' : 'chat-media-image';
          img.alt = 'Mídia recebida';
          img.loading = 'lazy';
          mediaTasks.push(resolveMediaSource(media).then((src) => { if (src) img.src = src; }));
          mediaEl.appendChild(img);
        } else if (media.kind === 'audio') {
          const audio = document.createElement('audio');
          audio.className = 'chat-media-audio';
          audio.controls = true;
          audio.preload = 'none';
          mediaTasks.push(resolveMediaSource(media).then((src) => { if (src) audio.src = src; }));
          mediaEl.appendChild(audio);
        } else if (media.kind === 'video') {
          const video = document.createElement('video');
          video.className = 'chat-media-video';
          video.controls = true;
          video.preload = 'metadata';
          mediaTasks.push(resolveMediaSource(media).then((src) => { if (src) video.src = src; }));
          mediaEl.appendChild(video);
        } else if (media.kind === 'document') {
          const a = document.createElement('a');
          a.className = 'chat-media-document';
          a.textContent = 'Baixar ' + (media.fileName || 'documento');
          mediaTasks.push(resolveMediaSource(media).then((src) => { if (src) a.href = src; }));
          if (media.fileName) a.download = media.fileName;
          mediaEl.appendChild(a);
        }
        bubble.appendChild(mediaEl);

        if (media.omittedReason) {
          const w = document.createElement('p');
          w.className = 'chat-media-warning';
          w.textContent = media.omittedReason === 'too_large'
            ? 'Mídia não carregada: arquivo acima do limite.' : 'Mídia não carregada: falha no download.';
          bubble.appendChild(w);
        }
      }

      if (textToShow) {
        const p = document.createElement('div');
        p.className = 'chat-bubble-text';
        p.textContent = textToShow;
        bubble.appendChild(p);
      }

      const t = document.createElement('span');
      t.className = 'chat-bubble-time';
      t.textContent = formatMessageTime(m.timestamp);
      bubble.appendChild(t);

      fragment.appendChild(bubble);
    });

    el.chatMessages.appendChild(fragment);
    if (wasNearBottom || !shouldAppend) el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    state.renderedChatJid = state.selectedChatJid;
    state.renderedMessagesMeta = msgs.map(messageMeta);
    // Resolve media in parallel
    Promise.all(mediaTasks).catch(() => {});
  }

  async function loadChatMessages() {
    if (!state.selectedChatJid) { setChatHeader(); return; }
    if (!beginLoad('messages')) return;
    setChatHeader();
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/chats/${encodeURIComponent(state.selectedChatJid)}/messages`);
      if (!response.ok) return;
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      const meta = messagesMeta(msgs);
      if (state.loadedChatJid !== state.selectedChatJid || !sameTupleList(meta, state.loadedMessagesMeta)) {
        state.loadedChatJid = state.selectedChatJid;
        state.loadedMessagesMeta = meta;
        await renderChatMessages(msgs);
      }
      // Auto-sync if no messages yet
      const fewMessages = msgs.length < 120;
      if (fewMessages && !state.autoSyncedChats.has(state.selectedChatJid)) {
        state.autoSyncedChats.add(state.selectedChatJid);
        syncSelectedHistory();
      }
    } catch {} finally { endLoad('messages'); }
  }

  function updateSendButtonState() {
    const hasText = !!el.chatComposerInput.value.trim();
    el.btnSendChatMessage.disabled = !state.selectedChatJid || !hasText;
  }

  function autoResizeComposer() {
    el.chatComposerInput.style.height = 'auto';
    const h = Math.max(36, Math.min(160, el.chatComposerInput.scrollHeight));
    el.chatComposerInput.style.height = h + 'px';
  }

  el.chatComposerInput.addEventListener('input', () => { autoResizeComposer(); updateSendButtonState(); });
  el.chatComposerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  async function sendChatMessage() {
    const text = el.chatComposerInput.value.trim();
    if (!text || !state.selectedChatJid) return;
    el.btnSendChatMessage.disabled = true;
    const orig = el.btnSendChatMessage.textContent;
    el.btnSendChatMessage.textContent = 'Enviando...';
    try {
      const { response, data } = await api(
        `/v1/instances/${encodeURIComponent(instance)}/chats/${encodeURIComponent(state.selectedChatJid)}/messages`,
        { method: 'POST', body: JSON.stringify({ text }) }
      );
      if (!response.ok) {
        setText(el.chatHeaderMeta, data.error || 'Falha ao enviar.');
        return;
      }
      el.chatComposerInput.value = '';
      autoResizeComposer();
      state.loadedChatJid = '';
      state.loadedMessagesMeta = [];
      await Promise.all([loadChatMessages(), loadChats()]);
      el.chatComposerInput.focus();
    } catch (err) {
      setText(el.chatHeaderMeta, err.message || 'Erro de rede.');
    } finally {
      el.btnSendChatMessage.textContent = orig || 'Enviar';
      updateSendButtonState();
    }
  }
  el.btnSendChatMessage.addEventListener('click', sendChatMessage);

  async function syncSelectedHistory() {
    if (!state.selectedChatJid) return;
    setText(el.chatHeaderMeta, 'Buscando histórico...');
    [el.btnSyncChatHistory, el.btnSyncSelectedHistory].forEach((b) => { if (b) b.disabled = true; });
    try {
      const { response, data } = await api(
        `/v1/instances/${encodeURIComponent(instance)}/chats/${encodeURIComponent(state.selectedChatJid)}/sync-history`,
        { method: 'POST', body: JSON.stringify({ maxBatches: 30, fetchCount: 200 }) }
      );
      if (!response.ok) {
        const errMap = {
          instance_not_connected: 'Instância desconectada.',
          history_fetch_not_supported: 'Versão do WhatsApp não suporta isso.',
        };
        setText(el.chatHeaderMeta, errMap[data.error] || data.error || 'Falha.');
        return;
      }
      const imp = Number(data.imported) || 0;
      const batches = Number(data.batches) || 0;
      if (imp > 0) {
        setText(el.chatHeaderMeta, `Histórico: +${imp} mensagens (${batches} lotes)`);
      } else {
        setText(el.chatHeaderMeta, `Sem novas mensagens. (${batches} lotes verificados)`);
      }
      state.loadedChatJid = '';
      state.loadedMessagesMeta = [];
      await Promise.all([loadChatMessages(), loadChats()]);
    } catch (err) { setText(el.chatHeaderMeta, err.message || 'Erro de rede.'); }
    finally { [el.btnSyncChatHistory, el.btnSyncSelectedHistory].forEach((b) => { if (b) b.disabled = false; }); }
  }
  el.btnRefreshChats.addEventListener('click', () => { state.lastChatListMeta = []; loadChats(); });
  el.btnSyncChatHistory.addEventListener('click', syncSelectedHistory);
  el.btnSyncSelectedHistory.addEventListener('click', syncSelectedHistory);

  // ============ Settings ============
  async function loadSettings() {
    if (!beginLoad('settings')) return;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/settings`);
      if (!response.ok) return;
      const g = data.general || {};
      el.settings.rejectCalls.checked = !!g.rejectCalls;
      el.settings.ignoreGroups.checked = !!g.ignoreGroups;
      el.settings.alwaysOnline.checked = !!g.alwaysOnline;
      el.settings.autoReadMessages.checked = !!g.autoReadMessages;
      el.settings.syncFullHistory.checked = !!g.syncFullHistory;
      el.settings.readStatus.checked = !!g.readStatus;
      const p = data.proxy || {};
      el.proxy.enabled.checked = !!p.enabled;
      el.proxy.protocol.value = p.protocol || '';
      el.proxy.host.value = p.host || '';
      el.proxy.port.value = p.port || '';
      el.proxy.username.value = p.username || '';
      el.proxy.password.value = p.password || '';
    } catch {} finally { endLoad('settings'); }
  }

  async function saveGeneral() {
    try {
      const body = {
        rejectCalls: el.settings.rejectCalls.checked,
        ignoreGroups: el.settings.ignoreGroups.checked,
        alwaysOnline: el.settings.alwaysOnline.checked,
        autoReadMessages: el.settings.autoReadMessages.checked,
        syncFullHistory: el.settings.syncFullHistory.checked,
        readStatus: el.settings.readStatus.checked,
      };
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/settings/general`, {
        method: 'PATCH', body: JSON.stringify(body)
      });
      if (!response.ok) { setResult(el.settingsResult, data.error || 'Falha.', 'error'); return; }
      let msg = 'Configurações salvas.';
      if (data.requiresReconnect?.length) msg += ` Reinicie para aplicar: ${data.requiresReconnect.join(', ')}.`;
      setResultAuto(el.settingsResult, msg, 'success');
      if (data.syncRestartTriggered) setTimeout(loadDashboard, 1000);
    } catch (err) { setResult(el.settingsResult, err.message || 'Erro.', 'error'); }
  }

  async function saveProxy() {
    try {
      const body = {
        enabled: el.proxy.enabled.checked,
        protocol: el.proxy.protocol.value.trim(),
        host: el.proxy.host.value.trim(),
        port: el.proxy.port.value.trim(),
        username: el.proxy.username.value.trim(),
        password: el.proxy.password.value.trim(),
      };
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/settings/proxy`, {
        method: 'PATCH', body: JSON.stringify(body)
      });
      if (!response.ok) { setResult(el.settingsResult, data.error || 'Falha.', 'error'); return; }
      let msg = 'Proxy salvo.';
      if (data.requiresReconnect) msg += ' Reinicie a conexão para aplicar.';
      setResultAuto(el.settingsResult, msg, 'success');
    } catch (err) { setResult(el.settingsResult, err.message || 'Erro.', 'error'); }
  }
  el.btnSaveGeneral.addEventListener('click', saveGeneral);
  el.btnSaveProxy.addEventListener('click', saveProxy);

  // ============ Events ============
  function renderEventsList(toggles) {
    const all = Array.from(new Set([...REQUIRED_EVENTS, ...state.availableEvents])).sort();
    el.eventsToggles.innerHTML = all.map((ev) => {
      const checked = toggles?.[ev] === true ? 'checked' : '';
      return `<label class="switch-row">
        <div class="switch-row-info"><span class="switch-row-label">${escapeHtml(ev)}</span></div>
        <label class="switch"><input type="checkbox" data-event-toggle="${escapeHtml(ev)}" ${checked}></label>
      </label>`;
    }).join('');
  }

  async function loadEvents() {
    if (!beginLoad('events')) return;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/events`);
      if (!response.ok) return;
      el.eventsWebhookUrl.value = data.webhookUrl || '';
      state.availableEvents = data.availableEvents || [];
      renderEventsList(data.toggles || {});
    } catch {} finally { endLoad('events'); }
  }

  function collectEventToggles() {
    const out = {};
    document.querySelectorAll('[data-event-toggle]').forEach((cb) => {
      out[cb.dataset.eventToggle] = !!cb.checked;
    });
    return out;
  }

  function setAllEventToggles(v) {
    document.querySelectorAll('[data-event-toggle]').forEach((cb) => { cb.checked = v; });
  }

  async function saveEvents() {
    try {
      const body = { webhookUrl: el.eventsWebhookUrl.value.trim(), toggles: collectEventToggles() };
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/events`, {
        method: 'PATCH', body: JSON.stringify(body)
      });
      if (!response.ok) { setResult(el.eventsResult, data.error || 'Falha.', 'error'); return; }
      setResultAuto(el.eventsResult, 'Eventos salvos.', 'success');
    } catch (err) { setResult(el.eventsResult, err.message || 'Erro.', 'error'); }
  }

  async function testEvent() {
    try {
      const toggles = collectEventToggles();
      const event = Object.keys(toggles).find((k) => toggles[k]) || 'APPLICATION_STARTUP';
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/events/test`, {
        method: 'POST', body: JSON.stringify({ event })
      });
      if (!response.ok) {
        const tag = data.skipped ? '(evento desabilitado)' : '(falha)';
        setResult(el.eventsResult, `Falha ${tag}: ${data.error || ''}`, 'error');
        return;
      }
      setResultAuto(el.eventsResult, `Evento ${data.event} entregue (status ${data.status || 200}).`, 'success');
    } catch (err) { setResult(el.eventsResult, err.message || 'Erro.', 'error'); }
  }
  el.btnSaveEvents.addEventListener('click', saveEvents);
  el.btnTestEvent.addEventListener('click', testEvent);
  el.btnMarkAllEvents.addEventListener('click', () => setAllEventToggles(true));
  el.btnUnmarkAllEvents.addEventListener('click', () => setAllEventToggles(false));

  // ============ Integrations ============
  function fillIntegrations(integ) {
    const cw = integ?.chatwoot || {};
    el.intChatwoot.enabled.checked = !!cw.enabled;
    el.intChatwoot.baseUrl.value = cw.baseUrl || '';
    el.intChatwoot.accountId.value = cw.accountId || '';
    el.intChatwoot.inboxId.value = cw.inboxId || '';
    el.intChatwoot.token.value = cw.apiAccessToken || '';
    el.intChatwoot.signMessages.checked = !!cw.signMessages;
    el.intChatwoot.signDelimiter.value = cw.signDelimiter || '';
    el.intChatwoot.nameInbox.value = cw.nameInbox || '';
    el.intChatwoot.webhookSlug.value = cw.webhookSlug || '';
    el.intChatwoot.organization.value = cw.organization || '';
    el.intChatwoot.logoUrl.value = cw.logoUrl || '';
    el.intChatwoot.conversationPending.checked = !!cw.conversationPending;
    el.intChatwoot.reopenConversation.checked = cw.reopenConversation !== false;
    el.intChatwoot.importContacts.checked = !!cw.importContacts;
    el.intChatwoot.importMessages.checked = cw.importMessages !== false;
    el.intChatwoot.daysLimit.value = cw.daysLimitImportMessages || 7;
    el.intChatwoot.ignoreJids.value = Array.isArray(cw.ignoreJids) ? cw.ignoreJids.join('\n') : '';
    el.intChatwoot.autoCreate.checked = !!cw.autoCreate;

    const slug = (cw.webhookSlug || instance).trim();
    el.intChatwoot.webhookUrl.textContent = `${window.location.origin}/chatwoot/webhook/${encodeURIComponent(slug)}`;
    show(el.intChatwoot.webhookInfo, true);

    const n8 = integ?.n8n || {};
    el.intN8n.enabled.checked = !!n8.enabled;
    el.intN8n.webhookUrl.value = n8.webhookUrl || '';
    el.intN8n.headerName.value = n8.authHeaderName || '';
    el.intN8n.headerValue.value = n8.authHeaderValue || '';
  }

  async function loadIntegrations() {
    if (!beginLoad('integrations')) return;
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}`);
      if (!response.ok) { setResult(el.integrationsResult, data.error || 'Falha.', 'error'); return; }
      fillIntegrations(data.integration);
      pollSyncOnce();
    } catch (err) { setResult(el.integrationsResult, err.message || 'Erro.', 'error'); }
    finally { endLoad('integrations'); }
  }

  function buildIntChatwootBody() {
    const ignoreJids = (el.intChatwoot.ignoreJids.value || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    return {
      enabled: el.intChatwoot.enabled.checked,
      baseUrl: el.intChatwoot.baseUrl.value.trim(),
      accountId: el.intChatwoot.accountId.value.trim(),
      inboxId: el.intChatwoot.inboxId.value.trim(),
      apiAccessToken: el.intChatwoot.token.value.trim(),
      signMessages: el.intChatwoot.signMessages.checked,
      signDelimiter: el.intChatwoot.signDelimiter.value,
      nameInbox: el.intChatwoot.nameInbox.value.trim(),
      webhookSlug: el.intChatwoot.webhookSlug.value.trim(),
      organization: el.intChatwoot.organization.value.trim(),
      logoUrl: el.intChatwoot.logoUrl.value.trim(),
      conversationPending: el.intChatwoot.conversationPending.checked,
      reopenConversation: el.intChatwoot.reopenConversation.checked,
      importContacts: el.intChatwoot.importContacts.checked,
      importMessages: el.intChatwoot.importMessages.checked,
      daysLimitImportMessages: Number(el.intChatwoot.daysLimit.value) || 7,
      ignoreJids,
      autoCreate: el.intChatwoot.autoCreate.checked,
    };
  }

  async function saveIntegrationChatwoot() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot`, {
        method: 'PATCH', body: JSON.stringify(buildIntChatwootBody())
      });
      if (!response.ok) { setResult(el.integrationsResult, data.error || 'Falha.', 'error'); return; }
      fillIntegrations(data.integration);
      setResultAuto(el.integrationsResult, 'Configuração Chatwoot salva.', 'success');
    } catch (err) { setResult(el.integrationsResult, err.message || 'Erro.', 'error'); }
  }

  async function testIntegrationChatwoot() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/test`, { method: 'POST' });
      if (!response.ok) { setResult(el.integrationsResult, data.error || 'Falha.', 'error'); return; }
      setResultAuto(el.integrationsResult, `Chatwoot OK (status ${data.status || 200}).`, 'success');
    } catch (err) { setResult(el.integrationsResult, err.message || 'Erro.', 'error'); }
  }

  async function autoCreateIntegrationChatwoot() {
    setResult(el.intAutoCreateResult, 'Criando inbox...', '');
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/autocreate`, { method: 'POST' });
      if (!response.ok || !data.ok) { setResult(el.intAutoCreateResult, data.error || 'Falha.', 'error'); return; }
      const r = data.result || {};
      setResultAuto(el.intAutoCreateResult, `Inbox "${r.inboxName || ''}" (id=${r.inboxId || '?'}) criado/atualizado.`, 'success');
      await loadIntegrations();
    } catch (err) { setResult(el.intAutoCreateResult, err.message || 'Erro.', 'error'); }
  }

  async function syncContactNamesIntegrationChatwoot() {
    setResult(el.integrationsResult, 'Sincronizando nomes de contatos...', '');
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-contact-names`, { method: 'POST' });
      if (!response.ok || !data.ok) {
        setResult(el.integrationsResult, data.error || 'Falha ao sincronizar nomes.', 'error');
        return;
      }
      const r = data.result || {};
      setResultAuto(el.integrationsResult, `Sync de nomes concluído: ${r.updated || 0} atualizados, ${r.skipped || 0} ignorados, ${r.errors || 0} erros.`, 'success');
    } catch (err) {
      setResult(el.integrationsResult, err.message || 'Erro.', 'error');
    }
  }

  async function startSyncHistory() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-history`, {
        method: 'POST', body: JSON.stringify({})
      });
      if (!response.ok) { setResult(el.integrationsResult, data.error || 'Falha.', 'error'); return; }
      setResultAuto(el.integrationsResult, 'Sincronização iniciada.', 'success');
      startSyncPolling();
    } catch (err) { setResult(el.integrationsResult, err.message || 'Erro.', 'error'); }
  }

  async function cancelSync() {
    try {
      await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-cancel`, { method: 'POST' });
    } catch {}
  }

  function renderSyncProgress(p) {
    if (!p || p.status === 'idle') { show(el.intSyncProgress, false); return; }
    show(el.intSyncProgress, true);
    const map = {
      running: { txt: 'rodando', cls: 'info' },
      cancelling: { txt: 'cancelando', cls: 'warning' },
      completed: { txt: 'concluído', cls: 'success' },
      cancelled: { txt: 'cancelado', cls: 'warning' },
      failed: { txt: 'falhou', cls: 'danger' },
    };
    const s = map[p.status] || { txt: p.status, cls: '' };
    el.intSyncBadge.textContent = s.txt;
    el.intSyncBadge.className = 'badge ' + s.cls;
    show(el.btnCancelSyncInt, p.status === 'running');

    el.intSyncChats.textContent = `${p.processedChats || 0}/${p.totalChats || 0}`;
    el.intSyncSent.textContent = String(p.syncedMessages || 0);
    el.intSyncSkipped.textContent = String(p.skippedMessages || 0);
    el.intSyncErrors.textContent = String(p.errorCount || 0);

    const trigger = p.trigger ? ` • disparo: ${p.trigger}` : '';
    el.intSyncCurrent.textContent = (p.currentChatTitle || (p.lastError ? 'erro: ' + p.lastError : (p.status === 'running' ? 'preparando...' : ''))) + trigger;

    el.intSyncFill.classList.remove('indeterminate');
    if (p.status === 'running') {
      if (p.totalChats > 0) {
        const pct = Math.min(100, Math.round((p.processedChats / p.totalChats) * 100));
        el.intSyncFill.style.width = pct + '%';
      } else {
        el.intSyncFill.classList.add('indeterminate');
        el.intSyncFill.style.width = '';
      }
    } else if (p.status === 'completed') {
      el.intSyncFill.style.width = '100%';
    }
  }

  async function pollSyncOnce() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-status`);
      if (response.ok) {
        renderSyncProgress(data.progress);
        return data.progress;
      }
    } catch {}
    return null;
  }

  function stopSyncPolling() {
    if (state.syncPollHandle) { clearTimeout(state.syncPollHandle); state.syncPollHandle = null; }
    state.syncPollBusy = false;
  }

  function startSyncPolling() {
    stopSyncPolling();
    const run = async () => {
      if (state.syncPollBusy) return;
      state.syncPollBusy = true;
      const p = await pollSyncOnce();
      state.syncPollBusy = false;
      if (p && p.status !== 'running' && p.status !== 'cancelling') {
        stopSyncPolling();
        return;
      }
      state.syncPollHandle = setTimeout(run, 1000);
    };
    run();
  }

  function startUiPolling() {
    if (state.uiPollHandle) clearTimeout(state.uiPollHandle);
    const run = async () => {
      if (!document.hidden && !state.uiPollBusy) {
        state.uiPollBusy = true;
        try {
          if (state.activeSection === 'dashboard') {
            await loadDashboard();
          } else {
            await loadHeaderStatus();
            if (state.activeSection === 'chat') {
              if (state.selectedChatJid) {
                await Promise.all([loadChats(), loadChatMessages()]);
              } else {
                await loadChats();
              }
            }
          }
        } finally {
          state.uiPollBusy = false;
        }
      }
      state.uiPollHandle = setTimeout(run, 4000);
    };
    run();
  }

  async function saveIntegrationN8n() {
    try {
      const body = {
        enabled: el.intN8n.enabled.checked,
        webhookUrl: el.intN8n.webhookUrl.value.trim(),
        authHeaderName: el.intN8n.headerName.value.trim(),
        authHeaderValue: el.intN8n.headerValue.value.trim(),
      };
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/n8n`, {
        method: 'PATCH', body: JSON.stringify(body)
      });
      if (!response.ok) { setResult(el.integrationsResult, data.error || 'Falha.', 'error'); return; }
      setResultAuto(el.integrationsResult, 'Configuração n8n salva.', 'success');
    } catch (err) { setResult(el.integrationsResult, err.message || 'Erro.', 'error'); }
  }

  async function testIntegrationN8n() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/n8n/test`, { method: 'POST' });
      if (!response.ok) { setResult(el.integrationsResult, data.error || 'Falha.', 'error'); return; }
      setResultAuto(el.integrationsResult, `n8n OK (status ${data.status || 200}).`, 'success');
    } catch (err) { setResult(el.integrationsResult, err.message || 'Erro.', 'error'); }
  }

  el.btnSaveIntChatwoot.addEventListener('click', saveIntegrationChatwoot);
  el.btnTestIntChatwoot.addEventListener('click', testIntegrationChatwoot);
  el.btnAutoCreateIntChatwoot.addEventListener('click', autoCreateIntegrationChatwoot);
  el.btnSyncContactNamesIntChatwoot.addEventListener('click', syncContactNamesIntegrationChatwoot);
  el.btnSyncHistoryIntChatwoot.addEventListener('click', startSyncHistory);
  el.btnCancelSyncInt.addEventListener('click', cancelSync);
  el.btnSaveIntN8n.addEventListener('click', saveIntegrationN8n);
  el.btnTestIntN8n.addEventListener('click', testIntegrationN8n);

  // ============ Boot ============
  setText(el.sidebarInstanceName, `Instância: ${instance}`);
  setText(el.instanceTitle, `Conexão: ${instance}`);
  setText(el.instanceSubtitle, `Painel operacional`);

  el.btnForceRefresh.addEventListener('click', () => loadSection(state.activeSection));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadSection(state.activeSection);
  });

  switchSection(sectionFromHash());

  // Polling — only when visible, without overlapping async requests
  startUiPolling();
})();
