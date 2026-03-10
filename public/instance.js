(function () {
  const API = '';
  const REQUIRED_EVENTS = [
    'APPLICATION_STARTUP',
    'CALL',
    'CHATS_DELETE',
    'CHATS_SET',
    'CHATS_UPDATE',
    'CHATS_UPSERT',
    'CONNECTION_UPDATE',
    'CONTACTS_SET',
    'CONTACTS_UPDATE',
    'CONTACTS_UPSERT',
    'GROUP_PARTICIPANTS_UPDATE',
    'GROUP_UPDATE',
    'GROUPS_UPSERT',
    'LABELS_ASSOCIATION',
    'LABELS_EDIT',
    'LOGOUT_INSTANCE',
    'MESSAGES_DELETE',
    'MESSAGES_SET',
    'MESSAGES_UPDATE',
    'MESSAGES_UPSERT',
    'PRESENCE_UPDATE',
    'QRCODE_UPDATED',
    'REMOVE_INSTANCE',
    'SEND_MESSAGE',
    'TYPEBOT_CHANGE_STATUS',
    'TYPEBOT_START',
  ];
  const VALID_SECTIONS = new Set(['dashboard', 'chat', 'settings', 'events', 'integrations']);

  const params = new URLSearchParams(window.location.search);
  const instance = String(params.get('instance') || '').trim();

  if (!instance) {
    alert('Instância não informada. Abra a partir da lista de conexões.');
    window.location.href = '/';
    return;
  }

  const API_KEY_STORAGE_KEY = 'rscara_api_key';

  function getStoredApiKey() {
    const sessionKey = sessionStorage.getItem(API_KEY_STORAGE_KEY);
    if (sessionKey) return sessionKey;
    const legacyKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (legacyKey) {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, legacyKey);
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      return legacyKey;
    }
    return '';
  }

  function storeApiKey(key) {
    if (key) {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, key);
      return;
    }
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  }

  const state = {
    activeSection: 'dashboard',
    inFlight: new Set(),
    selectedChatJid: '',
    chatItems: [],
    chatFilter: 'all',
    availableEvents: [],
    hideTimers: new Map(),
    autoSyncedChats: new Set(),
    mediaObjectUrls: new Set(),
    mediaBlobCache: new Map(),
  };

  const el = {
    apiKey: document.getElementById('apiKey'),
    title: document.getElementById('instanceTitle'),
    subtitle: document.getElementById('instanceSubtitle'),
    sidebarInstanceName: document.getElementById('sidebarInstanceName'),
    topbarLastSync: document.getElementById('topbarLastSync'),
    statusChip: document.getElementById('headerStatusChip'),
    btnForceRefresh: document.getElementById('btnForceRefresh'),
    dashboardStatus: document.getElementById('dashboardStatus'),
    dashQrBox: document.getElementById('dashboardQrBox'),
    dashQrImage: document.getElementById('dashboardQrImage'),
    dashPairingBox: document.getElementById('dashboardPairingBox'),
    dashPairingCode: document.getElementById('dashboardPairingCode'),
    chatList: document.getElementById('chatList'),
    chatHeader: document.getElementById('chatHeader'),
    chatHeaderTitle: document.getElementById('chatHeaderTitle'),
    chatHeaderMeta: document.getElementById('chatHeaderMeta'),
    chatMessages: document.getElementById('chatMessages'),
    chatSearchInput: document.getElementById('chatSearchInput'),
    chatComposerInput: document.getElementById('chatComposerInput'),
    btnSendChatMessage: document.getElementById('btnSendChatMessage'),
    btnSyncChatHistory: document.getElementById('btnSyncChatHistory'),
    settingsResult: document.getElementById('settingsResult'),
    eventsResult: document.getElementById('eventsResult'),
    integrationsResult: document.getElementById('integrationsResult'),
  };

  const cachedKey = getStoredApiKey();
  if (cachedKey) el.apiKey.value = cachedKey;

  el.apiKey.addEventListener('input', () => {
    storeApiKey(el.apiKey.value.trim());
  });

  function headers() {
    const out = { 'Content-Type': 'application/json' };
    const key = el.apiKey.value.trim() || getStoredApiKey();
    if (key) out['x-api-key'] = key;
    return out;
  }

  function show(node, visible) {
    if (!node) return;
    node.classList.toggle('hidden', !visible);
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function setStatus(node, message, tone) {
    if (!node) return;
    node.textContent = message;
    node.className = tone ? `status ${tone}` : 'status';
    show(node, true);
  }

  function setResult(node, message, tone) {
    if (!node) return;

    const priorTimer = state.hideTimers.get(node.id || '');
    if (priorTimer) {
      clearTimeout(priorTimer);
      state.hideTimers.delete(node.id || '');
    }

    node.textContent = message;
    node.className = tone ? `result ${tone}` : 'result';
    show(node, true);

    if (tone === 'success' && node.id) {
      const timer = setTimeout(() => {
        show(node, false);
        state.hideTimers.delete(node.id);
      }, 4200);
      state.hideTimers.set(node.id, timer);
    }
  }

  function setLoading(node, message) {
    if (!node) return;
    node.textContent = message;
    node.className = 'status';
    show(node, true);
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function setLastSync(text) {
    if (!el.topbarLastSync) return;
    el.topbarLastSync.textContent = text;
  }

  function markSynced() {
    setLastSync(`Atualizado as ${new Date().toLocaleTimeString('pt-BR')}`);
  }

  function sectionFromHash() {
    const raw = window.location.hash.replace('#', '').trim().toLowerCase();
    return VALID_SECTIONS.has(raw) ? raw : 'dashboard';
  }

  async function api(path, init = {}) {
    const response = await fetch(`${API}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        ...headers(),
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...(init.headers || {}),
      },
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { ok: false, error: 'invalid_json_response' };
    }
    return { response, data };
  }

  async function apiBinary(path) {
    const response = await fetch(`${API}${path}`, {
      cache: 'no-store',
      headers: {
        ...headers(),
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    return response;
  }

  function revokeMediaObjectUrls() {
    state.mediaObjectUrls.forEach((value) => {
      try {
        URL.revokeObjectURL(value);
      } catch (_) {}
    });
    state.mediaObjectUrls.clear();
    state.mediaBlobCache.clear();
  }

  function normalizeMediaPath(url) {
    if (typeof url !== 'string' || !url.trim()) return '';
    if (/^https?:\/\//i.test(url)) {
      try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}`;
      } catch {
        return '';
      }
    }
    return url;
  }

  async function resolveMediaSource(media) {
    if (!media || typeof media !== 'object') return null;

    const mediaPath = normalizeMediaPath(media.url);
    if (mediaPath) {
      const cached = state.mediaBlobCache.get(mediaPath);
      if (cached) return cached;
      try {
        const response = await apiBinary(mediaPath);
        if (!response.ok) return null;
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        state.mediaObjectUrls.add(objectUrl);
        state.mediaBlobCache.set(mediaPath, objectUrl);
        return objectUrl;
      } catch (_) {
        return null;
      }
    }

    return buildMediaDataUrl(media);
  }

  async function attachMediaSource(element, media) {
    if (!element || !media) return;
    try {
      const source = await resolveMediaSource(media);
      if (!source) return;
      element.src = source;
    } catch (_) {}
  }

  function beginLoad(key) {
    if (state.inFlight.has(key)) return false;
    state.inFlight.add(key);
    return true;
  }

  function endLoad(key) {
    state.inFlight.delete(key);
  }

  function updateHeaderStatus(status) {
    const normalized = String(status || 'disconnected').toLowerCase();
    const statusClassMap = {
      connected: 'connected',
      open: 'connected',
      disconnected: 'disconnected',
      close: 'disconnected',
      qr: 'qr',
      pairing: 'pairing',
      connecting: 'connecting',
    };
    const cssToken = statusClassMap[normalized] || 'connecting';
    el.statusChip.className = `instance-pill state-${cssToken}`;
    el.statusChip.textContent = normalized;
  }

  async function loadDashboardStats() {
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/chats`);
      if (!response.ok || !data.ok || !Array.isArray(data.chats)) {
        setText('dashChatsCount', '0');
        setText('dashMessagesCount', '0');
        setText('dashUnreadCount', '0');
        return;
      }

      const chats = data.chats;
      const totalChats = chats.length;
      const totalMessages = chats.reduce((sum, chat) => sum + Number(chat.messageCount || 0), 0);
      const unread = chats.reduce((sum, chat) => sum + Number(chat.unreadCount || 0), 0);

      setText('dashChatsCount', String(totalChats));
      setText('dashMessagesCount', String(totalMessages));
      setText('dashUnreadCount', String(unread));
    } catch {
      setText('dashChatsCount', '0');
      setText('dashMessagesCount', '0');
      setText('dashUnreadCount', '0');
    }
  }

  async function loadDashboard() {
    if (!beginLoad('dashboard')) return;
    try {
      setLoading(el.dashboardStatus, 'Carregando status da instancia...');
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/details`);
      if (!response.ok || !data.ok) {
        updateHeaderStatus('disconnected');
        setStatus(el.dashboardStatus, data.error || 'Falha ao carregar dashboard.', 'error');
        return;
      }

      const status = data.status || 'disconnected';
      updateHeaderStatus(status);
      setText('dashInstance', data.instance || instance);
      setText('dashConnectionStatus', status);
      setText('dashNumber', data.linkedNumber || '-');
      setText('dashProfileName', data.profileName || '-');

      const photo = document.getElementById('dashProfilePicture');
      if (data.profilePictureUrl) {
        photo.src = data.profilePictureUrl;
        show(photo, true);
      } else {
        photo.src = '';
        show(photo, false);
      }

      if (status !== 'qr') {
        show(el.dashQrBox, false);
      }
      if (status === 'connected') {
        show(el.dashPairingBox, false);
      }

      if (status === 'qr') {
        const qr = await api(`/v1/instances/${encodeURIComponent(instance)}/qr`);
        if (qr.response.ok && qr.data.qr) {
          el.dashQrImage.src = qr.data.qr;
          show(el.dashQrBox, true);
        } else {
          setStatus(el.dashboardStatus, 'Aguardando QR atualizado da instância.', '');
        }
      }

      const tone = status === 'connected' ? 'success' : status === 'disconnected' ? 'error' : '';
      setStatus(el.dashboardStatus, `Status: ${status}`, tone);
      await loadDashboardStats();
      markSynced();
    } catch (error) {
      updateHeaderStatus('disconnected');
      setStatus(el.dashboardStatus, error.message || 'Erro de rede no dashboard.', 'error');
    } finally {
      endLoad('dashboard');
    }
  }

  async function connectFromDashboard() {
    const connectButton = document.getElementById('btnDashboardConnect');
    connectButton.disabled = true;
    const mode = document.getElementById('dashboardConnectMode').value;
    show(el.dashQrBox, false);
    show(el.dashPairingBox, false);
    el.dashPairingCode.textContent = '';

    try {
      if (mode === 'pairing') {
        const phoneNumber = document.getElementById('dashboardPairingPhone').value.trim();
        if (!phoneNumber) {
          setStatus(el.dashboardStatus, 'Informe o número para pairing code.', 'error');
          return;
        }

        const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/pairing-code`, {
          method: 'POST',
          body: JSON.stringify({ phoneNumber }),
        });
        if (!response.ok || !data.ok) {
          setStatus(el.dashboardStatus, data.error || 'Erro ao gerar pairing.', 'error');
          return;
        }

        if (data.pairingCode) {
          el.dashPairingCode.textContent = data.pairingCode;
          show(el.dashPairingBox, true);
          setStatus(el.dashboardStatus, 'Pairing code gerado.', 'success');
        } else {
          setStatus(el.dashboardStatus, 'Pairing code não retornado.', 'error');
        }
      } else {
        const { response, data } = await api('/v1/instances', {
          method: 'POST',
          body: JSON.stringify({ instance }),
        });
        if (!response.ok || !data.ok) {
          setStatus(el.dashboardStatus, data.error || 'Erro ao gerar QR.', 'error');
          return;
        }

        if (data.qr) {
          el.dashQrImage.src = data.qr;
          show(el.dashQrBox, true);
          setStatus(el.dashboardStatus, 'QR atualizado.', 'success');
        } else {
          setStatus(el.dashboardStatus, `Status: ${data.status || 'connecting'}`);
        }
      }

      await loadDashboard();
    } catch (error) {
      setStatus(el.dashboardStatus, error.message || 'Erro de rede ao conectar.', 'error');
    } finally {
      connectButton.disabled = false;
    }
  }

  async function dashboardAction(action) {
    const button = action === 'restart'
      ? document.getElementById('btnDashboardRestart')
      : document.getElementById('btnDashboardDisconnect');
    button.disabled = true;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/${action}`, {
        method: 'POST',
      });
      if (!response.ok || !data.ok) {
        setStatus(el.dashboardStatus, data.error || `Falha em ${action}.`, 'error');
        return;
      }
      setStatus(el.dashboardStatus, `Ação ${action} executada.`, 'success');
      await loadDashboard();
    } catch (error) {
      setStatus(el.dashboardStatus, error.message || `Erro de rede em ${action}.`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function formatMessageTimestamp(rawValue) {
    const raw = Number(rawValue || 0);
    const timestamp = raw > 1000000000000 ? raw : raw * 1000;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    return new Date(timestamp).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function inferMimeType(media) {
    if (!media || typeof media !== 'object') return 'application/octet-stream';
    if (typeof media.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(media.mimeType)) {
      return media.mimeType;
    }
    switch (media.kind) {
      case 'audio':
        return 'audio/ogg';
      case 'image':
        return 'image/jpeg';
      case 'sticker':
        return 'image/webp';
      case 'video':
        return 'video/mp4';
      case 'document':
        return 'application/octet-stream';
      default:
        return 'application/octet-stream';
    }
  }

  function buildMediaDataUrl(media) {
    if (!media || typeof media !== 'object') return null;
    if (typeof media.base64 !== 'string' || media.base64.length === 0) return null;
    const mimeType = inferMimeType(media);
    return `data:${mimeType};base64,${media.base64}`;
  }

  function renderMessageMedia(media) {
    if (!media || typeof media !== 'object') return null;

    if (media.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.className = 'chat-media-audio';
      audio.controls = true;
      audio.preload = 'none';
      void attachMediaSource(audio, media);
      return audio;
    }

    if (media.kind === 'video') {
      const video = document.createElement('video');
      video.className = 'chat-media-video';
      video.controls = true;
      video.preload = 'metadata';
      void attachMediaSource(video, media);
      return video;
    }

    if (media.kind === 'image' || media.kind === 'sticker') {
      const image = document.createElement('img');
      image.className = media.kind === 'sticker' ? 'chat-media-sticker' : 'chat-media-image';
      image.loading = 'lazy';
      image.alt = media.kind === 'sticker' ? 'Figurinha recebida' : 'Imagem recebida';
      void attachMediaSource(image, media);
      return image;
    }

    if (media.kind === 'document') {
      const link = document.createElement('a');
      link.className = 'chat-media-document';
      link.href = '#';
      link.download = String(media.fileName || 'arquivo');
      link.textContent = `Baixar ${String(media.fileName || 'documento')}`;
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        const source = await resolveMediaSource(media);
        if (!source) return;
        const tmp = document.createElement('a');
        tmp.href = source;
        tmp.download = String(media.fileName || 'arquivo');
        tmp.rel = 'noopener noreferrer';
        tmp.click();
      });
      return link;
    }

    return null;
  }

  function formatSenderLabel(message) {
    if (message.fromMe) return 'Você';
    const name = String(message.senderName || '').trim();
    const number = String(message.senderNumber || '').trim();
    if (name && number) return `${name} (${number})`;
    if (name) return name;
    if (number) return number;
    return 'Contato';
  }

  function getSelectedChat() {
    return state.chatItems.find((chat) => chat.jid === state.selectedChatJid) || null;
  }

  function setChatHeaderDefaults() {
    if (el.chatHeaderTitle) el.chatHeaderTitle.textContent = 'Selecione um chat';
    if (el.chatHeaderMeta) el.chatHeaderMeta.textContent = 'Nenhuma conversa ativa.';
  }

  function updateSendButtonState() {
    const hasText = String(el.chatComposerInput?.value || '').trim().length > 0;
    const chatReady = Boolean(state.selectedChatJid);
    el.btnSendChatMessage.disabled = !chatReady || !hasText;
    if (el.btnSyncChatHistory && !state.inFlight.has('chat-history-sync')) {
      el.btnSyncChatHistory.disabled = !chatReady;
    }
  }

  function setChatFilter(nextFilter) {
    state.chatFilter = nextFilter;
    document.querySelectorAll('[data-chat-filter]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-chat-filter') === nextFilter);
    });
    renderChatList();
  }

  async function loadHeaderStatus() {
    if (!beginLoad('header-status')) return;
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/details`);
      if (!response.ok || !data.ok) {
        updateHeaderStatus('disconnected');
        return;
      }
      updateHeaderStatus(data.status || 'disconnected');
    } catch {
      updateHeaderStatus('disconnected');
    } finally {
      endLoad('header-status');
    }
  }

  function autoResizeComposer() {
    if (!el.chatComposerInput) return;
    el.chatComposerInput.style.height = 'auto';
    const nextHeight = Math.min(Math.max(el.chatComposerInput.scrollHeight, 44), 170);
    el.chatComposerInput.style.height = `${nextHeight}px`;
  }

  function renderChatListPlaceholder(text) {
    clearNode(el.chatList);
    const p = document.createElement('p');
    p.className = 'subtitle';
    p.textContent = text;
    el.chatList.appendChild(p);
  }

  function renderChatList() {
    const query = String(el.chatSearchInput?.value || '').trim().toLowerCase();
    const filteredByType = state.chatItems.filter((chat) => {
      if (state.chatFilter === 'unread') {
        return Number(chat.unreadCount || 0) > 0;
      }
      if (state.chatFilter === 'groups') {
        return String(chat.jid || '').endsWith('@g.us');
      }
      return true;
    });

    const filtered = !query
      ? filteredByType
      : filteredByType.filter((chat) => {
        const label = [chat.title, chat.jid, chat.lastMessage].join(' ').toLowerCase();
        return label.includes(query);
      });

    if (!filtered.length) {
      renderChatListPlaceholder(query ? 'Nenhum chat encontrado para a busca.' : 'Sem conversas em cache.');
      return;
    }

    clearNode(el.chatList);
    filtered.forEach((chat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chat-item ${state.selectedChatJid === chat.jid ? 'active' : ''}`;

      const avatar = document.createElement('span');
      avatar.className = 'chat-avatar';
      avatar.textContent = String(chat.title || chat.jid || '?').trim().charAt(0).toUpperCase() || '?';

      const body = document.createElement('span');
      body.className = 'chat-item-body';

      const top = document.createElement('span');
      top.className = 'chat-item-top';

      const title = document.createElement('strong');
      title.textContent = chat.title || chat.jid;

      const time = document.createElement('small');
      time.textContent = formatMessageTimestamp(chat.lastTimestamp);

      top.appendChild(title);
      top.appendChild(time);

      const bottom = document.createElement('span');
      bottom.className = 'chat-item-bottom';

      const subtitle = document.createElement('span');
      subtitle.className = 'chat-preview';
      subtitle.textContent = chat.lastMessage || '-';
      bottom.appendChild(subtitle);

      const jid = document.createElement('span');
      jid.className = 'chat-jid';
      jid.textContent = chat.jid || '-';
      bottom.appendChild(jid);

      const total = Number(chat.messageCount || 0);
      if (total > 0) {
        const count = document.createElement('em');
        count.className = 'chat-message-count';
        count.textContent = `${total}`;
        bottom.appendChild(count);
      }

      if (Number(chat.unreadCount || 0) > 0) {
        const badge = document.createElement('em');
        badge.className = 'chat-unread-badge';
        badge.textContent = String(chat.unreadCount);
        bottom.appendChild(badge);
      }

      body.appendChild(top);
      body.appendChild(bottom);
      btn.appendChild(avatar);
      btn.appendChild(body);

      btn.addEventListener('click', async () => {
        state.selectedChatJid = chat.jid;
        renderChatList();
        await loadChatMessages();
      });

      el.chatList.appendChild(btn);
    });
  }

  async function loadChats() {
    if (!beginLoad('chat-list')) return;
    try {
      renderChatListPlaceholder('Carregando conversas...');
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/chats`);
      if (!response.ok || !data.ok) {
        const msg = data.error === 'instance_not_found'
          ? 'Instância offline. Conecte para carregar conversas.'
          : data.error || 'Não foi possível carregar chats.';
        state.chatItems = [];
        renderChatListPlaceholder(msg);
        state.selectedChatJid = '';
        setChatHeaderDefaults();
        revokeMediaObjectUrls();
        clearNode(el.chatMessages);
        const p = document.createElement('p');
        p.className = 'subtitle';
        p.textContent = 'Nenhuma conversa selecionada.';
        el.chatMessages.appendChild(p);
        el.chatComposerInput.value = '';
        autoResizeComposer();
        el.chatComposerInput.disabled = true;
        updateSendButtonState();
        return;
      }

      const chats = Array.isArray(data.chats) ? data.chats : [];
      state.chatItems = chats;
      if (!chats.length) {
        state.selectedChatJid = '';
        renderChatListPlaceholder('Sem conversas em cache. Envie/receba mensagens para popular.');
        setChatHeaderDefaults();
        revokeMediaObjectUrls();
        clearNode(el.chatMessages);
        const p = document.createElement('p');
        p.className = 'subtitle';
        p.textContent = 'Sem mensagens em cache para exibir.';
        el.chatMessages.appendChild(p);
        el.chatComposerInput.value = '';
        autoResizeComposer();
        el.chatComposerInput.disabled = true;
        updateSendButtonState();
        return;
      }

      if (!state.selectedChatJid || !chats.some((chat) => chat.jid === state.selectedChatJid)) {
        state.selectedChatJid = chats[0].jid;
      }

      el.chatComposerInput.disabled = false;
      updateSendButtonState();
      renderChatList();

      markSynced();
    } catch (error) {
      state.chatItems = [];
      renderChatListPlaceholder(error.message || 'Erro de rede no chat.');
      state.selectedChatJid = '';
      setChatHeaderDefaults();
      revokeMediaObjectUrls();
      clearNode(el.chatMessages);
      const p = document.createElement('p');
      p.className = 'subtitle';
      p.textContent = 'Erro ao carregar chats.';
      el.chatMessages.appendChild(p);
      el.chatComposerInput.value = '';
      autoResizeComposer();
      el.chatComposerInput.disabled = true;
      updateSendButtonState();
    } finally {
      endLoad('chat-list');
    }
  }

  async function loadChatMessages() {
    if (!state.selectedChatJid) {
      setChatHeaderDefaults();
      revokeMediaObjectUrls();
      clearNode(el.chatMessages);
      const p = document.createElement('p');
      p.className = 'subtitle';
      p.textContent = 'Nenhuma conversa selecionada.';
      el.chatMessages.appendChild(p);
      el.chatComposerInput.disabled = true;
      updateSendButtonState();
      return;
    }

    if (!beginLoad('chat-messages')) return;
    try {
      revokeMediaObjectUrls();
      clearNode(el.chatMessages);
      const loading = document.createElement('p');
      loading.className = 'subtitle';
      loading.textContent = 'Carregando mensagens...';
      el.chatMessages.appendChild(loading);
      const { response, data } = await api(
        `/v1/instances/${encodeURIComponent(instance)}/chats/${encodeURIComponent(state.selectedChatJid)}/messages`
      );
      if (!response.ok || !data.ok) {
        clearNode(el.chatMessages);
        const p = document.createElement('p');
        p.className = 'subtitle';
        p.textContent = data.error || 'Falha ao carregar mensagens.';
        el.chatMessages.appendChild(p);
        return;
      }

      const selected = getSelectedChat();
      if (selected) {
        selected.unreadCount = 0;
      }
      if (el.chatHeaderTitle) {
        el.chatHeaderTitle.textContent = selected?.title || state.selectedChatJid;
      }
      if (el.chatHeaderMeta) {
        const totalMessages = Number(selected?.messageCount || 0);
        el.chatHeaderMeta.textContent = `${selected?.jid || state.selectedChatJid} • ${totalMessages} mensagens em cache`;
      }

      el.chatComposerInput.disabled = false;
      updateSendButtonState();
      renderChatList();

      const distanceFromBottom = el.chatMessages.scrollHeight - el.chatMessages.scrollTop - el.chatMessages.clientHeight;
      const keepPinnedBottom = distanceFromBottom < 70;
      revokeMediaObjectUrls();
      clearNode(el.chatMessages);

      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (!messages.length) {
        const p = document.createElement('p');
        p.className = 'subtitle';
        p.textContent = 'Sem mensagens em cache para este chat.';
        el.chatMessages.appendChild(p);
        if (!state.autoSyncedChats.has(state.selectedChatJid)) {
          state.autoSyncedChats.add(state.selectedChatJid);
          void syncSelectedChatHistory();
        }
        return;
      }

      let previousDay = '';
      messages.forEach((message) => {
        const raw = Number(message.timestamp || 0);
        const timestamp = raw > 1000000000000 ? raw : raw * 1000;
        const dayLabel = Number.isFinite(timestamp) && timestamp > 0
          ? new Date(timestamp).toLocaleDateString('pt-BR')
          : '';

        if (dayLabel && dayLabel !== previousDay) {
          previousDay = dayLabel;
          const divider = document.createElement('p');
          divider.className = 'chat-day-divider';
          divider.textContent = dayLabel;
          el.chatMessages.appendChild(divider);
        }

        const bubble = document.createElement('article');
        bubble.className = `chat-bubble ${message.fromMe ? 'me' : 'other'}`;

        const label = document.createElement('strong');
        label.className = 'chat-bubble-author';
        label.textContent = formatSenderLabel(message);
        bubble.appendChild(label);

        const mediaNode = renderMessageMedia(message.media);
        if (mediaNode) {
          bubble.appendChild(mediaNode);
        }

        const messageText = String(message.text || '').trim();
        const isMediaPlaceholder = /^\[[a-z]+\]$/i.test(messageText);
        const captionText = typeof message.media?.caption === 'string' ? message.media.caption.trim() : '';
        const textToRender = captionText || (!isMediaPlaceholder ? messageText : '');

        if (textToRender) {
          const text = document.createElement('p');
          text.textContent = textToRender;
          bubble.appendChild(text);
        }

        if (message.media && !message.media.base64 && message.media.omittedReason) {
          const notice = document.createElement('p');
          notice.className = 'chat-media-warning';
          notice.textContent = message.media.omittedReason === 'too_large'
            ? 'Mídia não carregada: arquivo acima do limite configurado.'
            : 'Mídia não carregada: falha no download.';
          bubble.appendChild(notice);
        }

        const footer = document.createElement('small');
        footer.textContent = formatMessageTimestamp(message.timestamp);

        bubble.appendChild(footer);
        el.chatMessages.appendChild(bubble);
      });

      if (keepPinnedBottom) {
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
      } else {
        el.chatMessages.scrollTop = Math.max(
          0,
          el.chatMessages.scrollHeight - el.chatMessages.clientHeight - distanceFromBottom
        );
      }

      if (messages.length < 120 && !state.autoSyncedChats.has(state.selectedChatJid)) {
        state.autoSyncedChats.add(state.selectedChatJid);
        void syncSelectedChatHistory();
      }
    } catch (error) {
      revokeMediaObjectUrls();
      clearNode(el.chatMessages);
      const p = document.createElement('p');
      p.className = 'subtitle';
      p.textContent = error.message || 'Erro de rede ao carregar mensagens.';
      el.chatMessages.appendChild(p);
    } finally {
      endLoad('chat-messages');
    }
  }

  async function sendChatMessage() {
    if (!state.selectedChatJid) return;
    const text = String(el.chatComposerInput.value || '').trim();
    if (!text) return;

    const priorLabel = el.btnSendChatMessage.textContent;
    el.btnSendChatMessage.textContent = 'Enviando...';
    el.btnSendChatMessage.disabled = true;
    try {
      const { response, data } = await api(
        `/v1/instances/${encodeURIComponent(instance)}/chats/${encodeURIComponent(state.selectedChatJid)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ text }),
        }
      );
      if (!response.ok || !data.ok) {
        if (el.chatHeaderMeta) {
          el.chatHeaderMeta.textContent = data.error || 'Falha ao enviar mensagem.';
        }
        return;
      }

      el.chatComposerInput.value = '';
      await loadChats();
      await loadChatMessages();
      autoResizeComposer();
      updateSendButtonState();
      markSynced();
    } catch (error) {
      if (el.chatHeaderMeta) {
        el.chatHeaderMeta.textContent = error.message || 'Erro de rede ao enviar mensagem.';
      }
    } finally {
      el.btnSendChatMessage.textContent = priorLabel;
      updateSendButtonState();
      el.chatComposerInput.focus();
    }
  }

  async function syncSelectedChatHistory() {
    if (!el.btnSyncChatHistory) return;
    if (!state.selectedChatJid) {
      if (el.chatHeaderMeta) {
        el.chatHeaderMeta.textContent = 'Selecione um chat para sincronizar histórico.';
      }
      return;
    }

    const priorLabel = el.btnSyncChatHistory.textContent;
    state.inFlight.add('chat-history-sync');
    el.btnSyncChatHistory.textContent = 'Sincronizando...';
    el.btnSyncChatHistory.disabled = true;

    try {
      const { response, data } = await api(
        `/v1/instances/${encodeURIComponent(instance)}/chats/${encodeURIComponent(state.selectedChatJid)}/sync-history`,
        {
          method: 'POST',
          body: JSON.stringify({ maxBatches: 20, fetchCount: 200 }),
        }
      );

      if (!response.ok || !data.ok) {
        if (el.chatHeaderMeta) {
          el.chatHeaderMeta.textContent = data.error || 'Falha ao sincronizar histórico.';
        }
        return;
      }

      await loadChats();
      await loadChatMessages();
      if (el.chatHeaderMeta) {
        const doneLabel = data.done ? 'completo' : 'parcial';
        el.chatHeaderMeta.textContent = `Sincronização ${doneLabel}: +${data.imported || 0} mensagens (${data.batches || 0} lotes).`;
      }
      markSynced();
    } catch (error) {
      if (el.chatHeaderMeta) {
        el.chatHeaderMeta.textContent = error.message || 'Erro de rede ao sincronizar histórico.';
      }
    } finally {
      state.inFlight.delete('chat-history-sync');
      el.btnSyncChatHistory.textContent = priorLabel;
      updateSendButtonState();
    }
  }

  async function loadSettings() {
    if (!beginLoad('settings')) return;
    try {
      setResult(el.settingsResult, 'Carregando configuracoes...', '');
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/settings`);
      if (!response.ok || !data.ok) {
        setResult(el.settingsResult, data.error || 'Falha ao carregar configurações.', 'error');
        return;
      }

      const proxy = data.proxy || {};
      const general = data.general || {};
      document.getElementById('proxyEnabled').checked = Boolean(proxy.enabled);
      document.getElementById('proxyProtocol').value = proxy.protocol || 'http';
      document.getElementById('proxyHost').value = proxy.host || '';
      document.getElementById('proxyPort').value = proxy.port || '';
      document.getElementById('proxyUsername').value = proxy.username || '';
      document.getElementById('proxyPassword').value = proxy.password || '';

      document.getElementById('settingRejectCalls').checked = Boolean(general.rejectCalls);
      document.getElementById('settingIgnoreGroups').checked = Boolean(general.ignoreGroups);
      document.getElementById('settingAlwaysOnline').checked = Boolean(general.alwaysOnline);
      document.getElementById('settingAutoReadMessages').checked = Boolean(general.autoReadMessages);
      document.getElementById('settingSyncFullHistory').checked = Boolean(general.syncFullHistory);
      document.getElementById('settingReadStatus').checked = Boolean(general.readStatus);
      markSynced();
    } catch (error) {
      setResult(el.settingsResult, error.message || 'Erro de rede ao carregar configurações.', 'error');
    } finally {
      endLoad('settings');
    }
  }

  async function saveGeneral() {
    const body = {
      rejectCalls: document.getElementById('settingRejectCalls').checked,
      ignoreGroups: document.getElementById('settingIgnoreGroups').checked,
      alwaysOnline: document.getElementById('settingAlwaysOnline').checked,
      autoReadMessages: document.getElementById('settingAutoReadMessages').checked,
      syncFullHistory: document.getElementById('settingSyncFullHistory').checked,
      readStatus: document.getElementById('settingReadStatus').checked,
    };
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/settings/general`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (!response.ok || !data.ok) {
        setResult(el.settingsResult, data.error || 'Falha ao salvar configurações gerais.', 'error');
        return;
      }
      const reconnectHint = Array.isArray(data.requiresReconnect) && data.requiresReconnect.length > 0
        ? ` Reinicie para aplicar: ${data.requiresReconnect.join(', ')}.`
        : '';
      const runtimeHint = data.runtimeApplied
        ? ' Aplicado em runtime quando possível.'
        : ' Instância offline: efeitos aplicam ao conectar.';
      const readSyncHint = Number(data.readSyncCount || 0) > 0
        ? ` ${data.readSyncCount} mensagens/status marcados como lidos.`
        : '';
      const syncRestartHint = data.syncRestartTriggered
        ? (data.syncRestartOk
          ? ' Reinício automático disparado para aplicar syncFullHistory.'
          : ` Falha no reinício automático (${data.syncRestartError || 'erro_desconhecido'}).`)
        : '';
      const syncContinuousHint = body.syncFullHistory
        ? ' Sincronização contínua de histórico ativada.'
        : ' Sincronização contínua de histórico desativada.';

      setResult(
        el.settingsResult,
        `Configurações gerais salvas.${runtimeHint}${readSyncHint}${syncRestartHint}${syncContinuousHint}${reconnectHint}`,
        'success'
      );
      if (data.syncRestartTriggered) {
        setTimeout(() => {
          void loadDashboard();
        }, 1000);
      }
      markSynced();
    } catch (error) {
      setResult(el.settingsResult, error.message || 'Erro de rede ao salvar configurações gerais.', 'error');
    }
  }

  async function saveProxy() {
    const body = {
      enabled: document.getElementById('proxyEnabled').checked,
      protocol: document.getElementById('proxyProtocol').value.trim(),
      host: document.getElementById('proxyHost').value.trim(),
      port: document.getElementById('proxyPort').value.trim(),
      username: document.getElementById('proxyUsername').value.trim(),
      password: document.getElementById('proxyPassword').value.trim(),
    };
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/settings/proxy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (!response.ok || !data.ok) {
        setResult(el.settingsResult, data.error || 'Falha ao salvar proxy.', 'error');
        return;
      }
      const reconnectHint = data.requiresReconnect ? ' Reinicie a conexão para aplicar o proxy.' : '';
      setResult(el.settingsResult, `Proxy salvo.${reconnectHint}`, 'success');
      markSynced();
    } catch (error) {
      setResult(el.settingsResult, error.message || 'Erro de rede ao salvar proxy.', 'error');
    }
  }

  function renderEventsList(toggles) {
    const box = document.getElementById('eventsToggles');
    clearNode(box);

    state.availableEvents.forEach((eventName) => {
      const label = document.createElement('label');
      label.className = 'switch-row';

      const text = document.createElement('span');
      text.textContent = eventName;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.eventToggle = eventName;
      input.checked = Boolean(toggles[eventName]);

      label.appendChild(text);
      label.appendChild(input);
      box.appendChild(label);
    });
  }

  async function loadEvents() {
    if (!beginLoad('events')) return;
    try {
      setResult(el.eventsResult, 'Carregando eventos...', '');
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/events`);
      if (!response.ok || !data.ok) {
        setResult(el.eventsResult, data.error || 'Falha ao carregar eventos.', 'error');
        return;
      }
      state.availableEvents = Array.isArray(data.availableEvents) ? data.availableEvents : [];
      state.availableEvents = Array.from(new Set([...REQUIRED_EVENTS, ...state.availableEvents]));
      document.getElementById('eventsWebhookUrl').value = data.webhookUrl || '';
      renderEventsList(data.toggles || {});
      setResult(el.eventsResult, 'Eventos carregados.', 'success');
      markSynced();
    } catch (error) {
      setResult(el.eventsResult, error.message || 'Erro de rede ao carregar eventos.', 'error');
    } finally {
      endLoad('events');
    }
  }

  function collectEventToggles() {
    const toggles = {};
    document.querySelectorAll('[data-event-toggle]').forEach((input) => {
      const key = input.getAttribute('data-event-toggle');
      if (key) toggles[key] = input.checked;
    });
    return toggles;
  }

  function setAllEventToggles(value) {
    document.querySelectorAll('[data-event-toggle]').forEach((input) => {
      input.checked = value;
    });
  }

  async function saveEvents() {
    try {
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/events`, {
        method: 'PATCH',
        body: JSON.stringify({
          webhookUrl: document.getElementById('eventsWebhookUrl').value.trim(),
          toggles: collectEventToggles(),
        }),
      });
      if (!response.ok || !data.ok) {
        setResult(el.eventsResult, data.error || 'Falha ao salvar eventos.', 'error');
        return;
      }
      renderEventsList((data.events && data.events.toggles) || collectEventToggles());
      setResult(el.eventsResult, 'Eventos salvos.', 'success');
      markSynced();
    } catch (error) {
      setResult(el.eventsResult, error.message || 'Erro de rede ao salvar eventos.', 'error');
    }
  }

  async function testEvent() {
    try {
      const toggles = collectEventToggles();
      const enabledEvent = Object.entries(toggles).find(([, value]) => Boolean(value))?.[0];
      const eventToTest = enabledEvent || 'APPLICATION_STARTUP';
      const { response, data } = await api(`/v1/instances/${encodeURIComponent(instance)}/events/test`, {
        method: 'POST',
        body: JSON.stringify({ event: eventToTest }),
      });
      if (!response.ok || !data.ok) {
        const detail = data.skipped ? ` (${data.error || 'evento desabilitado'})` : ` (${data.error || 'falha de entrega'})`;
        setResult(el.eventsResult, `Falha no teste do evento${detail}.`, 'error');
        return;
      }
      setResult(el.eventsResult, `Evento ${data.event} entregue (status ${data.status || 200}).`, 'success');
      markSynced();
    } catch (error) {
      setResult(el.eventsResult, error.message || 'Erro de rede no teste de evento.', 'error');
    }
  }

  async function loadIntegrations() {
    if (!beginLoad('integrations')) return;
    try {
      setResult(el.integrationsResult, 'Carregando integracoes...', '');
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}`);
      if (!response.ok || !data.ok) {
        setResult(el.integrationsResult, data.error || 'Falha ao carregar integrações.', 'error');
        return;
      }

      const integration = data.integration || {};
      const chatwoot = integration.chatwoot || {};
      const n8n = integration.n8n || {};

      document.getElementById('intChatwootEnabled').checked = Boolean(chatwoot.enabled);
      document.getElementById('intChatwootBaseUrl').value = chatwoot.baseUrl || '';
      document.getElementById('intChatwootAccountId').value = chatwoot.accountId || '';
      document.getElementById('intChatwootInboxId').value = chatwoot.inboxId || '';
      document.getElementById('intChatwootToken').value = chatwoot.apiAccessToken || '';

      document.getElementById('intN8nEnabled').checked = Boolean(n8n.enabled);
      document.getElementById('intN8nWebhookUrl').value = n8n.webhookUrl || '';
      document.getElementById('intN8nHeaderName').value = n8n.authHeaderName || 'x-api-key';
      document.getElementById('intN8nHeaderValue').value = n8n.authHeaderValue || '';

      setResult(el.integrationsResult, 'Integrações carregadas.', 'success');
      markSynced();
    } catch (error) {
      setResult(el.integrationsResult, error.message || 'Erro de rede ao carregar integrações.', 'error');
    } finally {
      endLoad('integrations');
    }
  }

  async function saveIntegrationChatwoot() {
    const body = {
      enabled: document.getElementById('intChatwootEnabled').checked,
      baseUrl: document.getElementById('intChatwootBaseUrl').value.trim(),
      accountId: document.getElementById('intChatwootAccountId').value.trim(),
      inboxId: document.getElementById('intChatwootInboxId').value.trim(),
      apiAccessToken: document.getElementById('intChatwootToken').value.trim(),
    };
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (!response.ok || !data.ok) {
        setResult(el.integrationsResult, data.error || 'Falha ao salvar Chatwoot.', 'error');
        return;
      }
      setResult(el.integrationsResult, 'Chatwoot salvo com sucesso.', 'success');
      markSynced();
    } catch (error) {
      setResult(el.integrationsResult, error.message || 'Erro de rede ao salvar Chatwoot.', 'error');
    }
  }

  async function testIntegrationChatwoot() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/chatwoot/test`, {
        method: 'POST',
      });
      if (!response.ok || !data.ok) {
        setResult(el.integrationsResult, data.error || 'Teste Chatwoot falhou.', 'error');
        return;
      }
      setResult(el.integrationsResult, `Chatwoot OK (status ${data.status || 200}).`, 'success');
      markSynced();
    } catch (error) {
      setResult(el.integrationsResult, error.message || 'Erro de rede no teste Chatwoot.', 'error');
    }
  }

  async function saveIntegrationN8n() {
    const body = {
      enabled: document.getElementById('intN8nEnabled').checked,
      webhookUrl: document.getElementById('intN8nWebhookUrl').value.trim(),
      authHeaderName: document.getElementById('intN8nHeaderName').value.trim(),
      authHeaderValue: document.getElementById('intN8nHeaderValue').value.trim(),
    };
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/n8n`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (!response.ok || !data.ok) {
        setResult(el.integrationsResult, data.error || 'Falha ao salvar n8n.', 'error');
        return;
      }
      setResult(el.integrationsResult, 'n8n salvo com sucesso.', 'success');
      markSynced();
    } catch (error) {
      setResult(el.integrationsResult, error.message || 'Erro de rede ao salvar n8n.', 'error');
    }
  }

  async function testIntegrationN8n() {
    try {
      const { response, data } = await api(`/v1/integrations/${encodeURIComponent(instance)}/n8n/test`, {
        method: 'POST',
      });
      if (!response.ok || !data.ok) {
        setResult(el.integrationsResult, data.error || 'Teste n8n falhou.', 'error');
        return;
      }
      setResult(el.integrationsResult, `n8n OK (status ${data.status || 200}).`, 'success');
      markSynced();
    } catch (error) {
      setResult(el.integrationsResult, error.message || 'Erro de rede no teste n8n.', 'error');
    }
  }

  async function loadSection(section) {
    if (section !== 'dashboard') {
      await loadHeaderStatus();
    }
    if (section === 'dashboard') await loadDashboard();
    if (section === 'chat') {
      await loadChats();
      if (state.selectedChatJid) await loadChatMessages();
    }
    if (section === 'settings') await loadSettings();
    if (section === 'events') await loadEvents();
    if (section === 'integrations') await loadIntegrations();
  }

  function switchSection(nextSection) {
    state.activeSection = nextSection;
    document.querySelectorAll('.instance-nav-btn').forEach((btn) => {
      const active = btn.getAttribute('data-section') === nextSection;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.instance-section').forEach((section) => {
      section.classList.toggle('active', section.id === `section-${nextSection}`);
    });

    if (window.location.hash !== `#${nextSection}`) {
      window.history.replaceState(null, '', `#${nextSection}`);
    }

    void loadSection(nextSection);
  }

  document.querySelectorAll('.instance-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.getAttribute('data-section');
      if (!section || section === state.activeSection) return;
      switchSection(section);
    });
  });

  document.getElementById('dashboardConnectMode').addEventListener('change', () => {
    const isPairing = document.getElementById('dashboardConnectMode').value === 'pairing';
    show(document.getElementById('dashboardPhoneRow'), isPairing);
  });

  document.getElementById('btnDashboardConnect').addEventListener('click', connectFromDashboard);
  document.getElementById('btnDashboardRestart').addEventListener('click', () => dashboardAction('restart'));
  document.getElementById('btnDashboardDisconnect').addEventListener('click', () => dashboardAction('disconnect'));
  document.getElementById('btnRefreshChats').addEventListener('click', async () => {
    await loadChats();
    await loadChatMessages();
  });
  document.querySelectorAll('[data-chat-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-chat-filter');
      if (!filter || filter === state.chatFilter) return;
      setChatFilter(filter);
    });
  });
  el.btnSyncChatHistory?.addEventListener('click', () => {
    void syncSelectedChatHistory();
  });
  el.chatSearchInput.addEventListener('input', () => {
    renderChatList();
  });
  el.chatComposerInput.addEventListener('input', () => {
    autoResizeComposer();
    updateSendButtonState();
  });
  el.btnSendChatMessage.addEventListener('click', () => {
    void sendChatMessage();
  });
  el.chatComposerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendChatMessage();
    }
  });
  document.getElementById('btnSaveGeneral').addEventListener('click', saveGeneral);
  document.getElementById('btnSaveProxy').addEventListener('click', saveProxy);
  document.getElementById('btnMarkAllEvents').addEventListener('click', () => setAllEventToggles(true));
  document.getElementById('btnUnmarkAllEvents').addEventListener('click', () => setAllEventToggles(false));
  document.getElementById('btnSaveEvents').addEventListener('click', saveEvents);
  document.getElementById('btnTestEvent').addEventListener('click', testEvent);
  document.getElementById('btnSaveIntChatwoot').addEventListener('click', saveIntegrationChatwoot);
  document.getElementById('btnTestIntChatwoot').addEventListener('click', testIntegrationChatwoot);
  document.getElementById('btnSaveIntN8n').addEventListener('click', saveIntegrationN8n);
  document.getElementById('btnTestIntN8n').addEventListener('click', testIntegrationN8n);
  el.btnForceRefresh.addEventListener('click', () => {
    void loadSection(state.activeSection);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    void loadSection(state.activeSection);
  });

  window.addEventListener('hashchange', () => {
    const next = sectionFromHash();
    if (next !== state.activeSection) {
      switchSection(next);
    }
  });

  setInterval(() => {
    if (document.hidden) return;
    void loadHeaderStatus();
    if (state.activeSection === 'dashboard') {
      void loadDashboard();
      return;
    }
    if (state.activeSection === 'chat') {
      void loadChats();
      if (state.selectedChatJid) void loadChatMessages();
    }
  }, 4000);

  el.title.textContent = `Conexão: ${instance}`;
  el.subtitle.textContent = `Painel operacional da instância ${instance}`;
  if (el.sidebarInstanceName) {
    el.sidebarInstanceName.textContent = `Instância: ${instance}`;
  }
  show(document.getElementById('dashboardPhoneRow'), false);
  autoResizeComposer();
  updateSendButtonState();
  setLastSync('Carregando dados da instância...');

  const initialSection = sectionFromHash();
  if (initialSection !== 'dashboard') {
    switchSection(initialSection);
  } else {
    void loadSection('dashboard');
  }
})();
