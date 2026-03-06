(function () {
  const API = '';
  const apiKeyInput = document.getElementById('apiKey');
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

  const cachedApiKey = getStoredApiKey();
  if (cachedApiKey && !apiKeyInput.value) {
    apiKeyInput.value = cachedApiKey;
  }

  apiKeyInput.addEventListener('input', () => {
    storeApiKey(apiKeyInput.value.trim());
  });

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    const key = apiKeyInput.value.trim() || getStoredApiKey();
    if (key) {
      h['x-api-key'] = key;
      storeApiKey(key);
    }
    return h;
  }

  function show(el, visible) {
    el.classList.toggle('hidden', !visible);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setListState(listEl, message, tone) {
    if (!listEl) return;
    const toneClass = tone ? ` ${tone}` : '';
    listEl.innerHTML = `<li class="list-state${toneClass}">${escapeHtml(message)}</li>`;
  }

  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.getAttribute('data-tab')).classList.add('active');
    });
  });

  // Tipo de disparo
  const dispatchForms = {
    menu: document.getElementById('formMenu'),
    buttons: document.getElementById('formButtons'),
    interactive: document.getElementById('formInteractive'),
    list: document.getElementById('formList'),
    poll: document.getElementById('formPoll'),
    carousel: document.getElementById('formCarousel'),
  };
  document.getElementById('dispatchType').addEventListener('change', () => {
    const type = document.getElementById('dispatchType').value;
    Object.values(dispatchForms).forEach((f) => f && f.classList.add('hidden'));
    if (dispatchForms[type]) dispatchForms[type].classList.remove('hidden');
    if (type === 'list' && !document.getElementById('listSectionsList').querySelector('.block-section')) addListSection();
    if (type === 'carousel' && !document.getElementById('carouselCardsList').querySelector('.block-section')) addCarouselCard();
  });
  dispatchForms.menu.classList.remove('hidden');

  // Instância que estamos conectando (para atualizar QR e status em tempo real)
  let connectingInstanceName = null;
  let connectingMode = 'qr';
  const lastModeByInstance = new Map();

  const connectModeEl = document.getElementById('connectMode');
  const connectPhoneRowEl = document.getElementById('connectPhoneRow');
  const pairingContainerEl = document.getElementById('pairingContainer');
  const pairingCodeValueEl = document.getElementById('pairingCodeValue');

  const integrationInstanceEl = document.getElementById('integrationInstance');
  const integrationStatusEl = document.getElementById('integrationStatus');
  const chatwootResultEl = document.getElementById('chatwootResult');
  const n8nResultEl = document.getElementById('n8nResult');

  function setResult(el, message, tone) {
    if (!el) return;
    el.textContent = message;
    el.className = tone ? `result ${tone}` : 'result';
    show(el, true);
  }

  function setIntegrationStatus(message, tone) {
    if (!integrationStatusEl) return;
    integrationStatusEl.textContent = message;
    integrationStatusEl.className = tone ? `status ${tone}` : 'status';
    show(integrationStatusEl, true);
  }

  connectModeEl.addEventListener('change', () => {
    const isPairing = connectModeEl.value === 'pairing';
    show(connectPhoneRowEl, isPairing);
    if (!isPairing) {
      show(pairingContainerEl, false);
      pairingCodeValueEl.textContent = '';
    }
  });

  // --- Conexões: listar salvas e conectar ao clicar ---
  function renderSavedList(saved) {
    const ul = document.getElementById('savedList');
    if (!saved || saved.length === 0) {
      setListState(ul, 'Nenhuma conexao salva. Conecte por nome e ela aparecera aqui.');
      return;
    }
    ul.innerHTML = saved
      .map(
        (name) =>
          `<li class="saved-item-row">
            <span class="instance-name">${escapeHtml(name)}</span>
            <div class="saved-item-actions">
              <a class="btn btn-small btn-ghost" href="/instance.html?instance=${encodeURIComponent(name)}">Painel</a>
              <button type="button" class="btn btn-primary btn-connect-saved" data-connect-name="${name}">Conectar</button>
              <button type="button" class="btn btn-small btn-danger" data-delete-saved-name="${name}" title="Excluir sessão salva (será necessário novo QR para conectar)">Deletar</button>
            </div>
          </li>`
      )
      .join('');
    ul.querySelectorAll('[data-connect-name]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-connect-name');
        document.getElementById('connectInstanceSelect').value = name;
        document.getElementById('instanceName').value = name;
        connectNewNameRow.style.display = 'none';
        doConnect(name);
      });
    });
    ul.querySelectorAll('[data-delete-saved-name]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-delete-saved-name');
        if (!name || !confirm(`Excluir a conexão salva "${name}"? Será necessário escanear o QR de novo para conectar.`)) return;
        try {
          const res = await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/logout`, {
            method: 'POST',
            headers: headers(),
          });
          const data = await res.json();
          if (data.ok) refreshInstanceList();
        } catch (_) {
          refreshInstanceList();
        }
      });
    });
  }

  async function requestPairingCode(name) {
    const rawPhone = document.getElementById('pairingPhone').value.trim();
    if (!rawPhone) {
      return { ok: false, error: 'Informe o número para gerar o pairing code.' };
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/pairing-code`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ phoneNumber: rawPhone }),
        });
        const data = await res.json();

        if (!res.ok) {
          if (res.status === 503 && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            continue;
          }

          const msgByCode = {
            session_already_registered: 'Essa sessão já está autenticada. Use "Novo QR" para limpar e tentar de novo.',
            pairing_channel_not_ready: 'Canal do WhatsApp ainda iniciando. Tente novamente em alguns segundos.',
            empty_pairing_code: 'O WhatsApp não retornou código de pareamento. Tente novamente.',
            pairing_code_unavailable: 'Não foi possível gerar o pairing code agora. Tente novamente em alguns segundos.',
            pairing_code_unstable: 'O código ficou inválido durante a inicialização. Gere um novo código e tente imediatamente.',
            pairing_code_disabled: 'Pairing code está desabilitado no servidor.',
          };
          return { ok: false, error: msgByCode[data.error] || data.error || 'Erro ao gerar pairing code.' };
        }

        if (!data.pairingCode) {
          return { ok: false, error: 'Não foi possível obter o pairing code. Tente novamente.' };
        }

        return { ok: true, pairingCode: data.pairingCode, phoneNumber: data.phoneNumber || '' };
      } catch (e) {
        if (attempt >= 2) {
          return { ok: false, error: e.message || 'Erro de rede ao gerar pairing code.' };
        }
      }
    }

    return { ok: false, error: 'Não foi possível gerar pairing code.' };
  }

  async function resetInstanceOnModeSwitch(name, nextMode) {
    const previousMode = lastModeByInstance.get(name);
    if (!previousMode || previousMode === nextMode) return;

    try {
      await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/disconnect`, {
        method: 'POST',
        headers: headers(),
      });
    } catch (_) {}

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  async function doConnect(name) {
    const nextMode = connectModeEl.value === 'pairing' ? 'pairing' : 'qr';
    const statusEl = document.getElementById('connectStatus');
    const qrContainer = document.getElementById('qrContainer');
    const qrImage = document.getElementById('qrImage');

    await resetInstanceOnModeSwitch(name, nextMode);

    connectingInstanceName = name;
    connectingMode = nextMode;
    lastModeByInstance.set(name, connectingMode);
    show(statusEl, false);
    show(qrContainer, false);
    show(pairingContainerEl, false);
    pairingCodeValueEl.textContent = '';

    if (connectingMode === 'pairing') {
      const pairing = await requestPairingCode(name);
      if (!pairing.ok) {
        statusEl.textContent = pairing.error || 'Erro ao gerar pairing code';
        statusEl.className = 'status error';
        show(statusEl, true);
        connectingInstanceName = null;
        return;
      }
      pairingCodeValueEl.textContent = pairing.pairingCode;
      show(pairingContainerEl, true);
      show(qrContainer, false);
      statusEl.textContent = `Pairing code gerado para ${pairing.phoneNumber || 'o número informado'}.`;
      statusEl.className = 'status success';
      show(statusEl, true);
      refreshInstanceList();
      return;
    }

    try {
      const res = await fetch(`${API}/v1/instances`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ instance: name }),
      });
      const data = await res.json();
      if (!res.ok) {
        statusEl.textContent = data.error || 'Erro ao conectar';
        statusEl.className = 'status error';
        show(statusEl, true);
        connectingInstanceName = null;
        return;
      }
      if (data.qr) {
        qrImage.src = data.qr;
        show(qrContainer, true);
        show(pairingContainerEl, false);
        statusEl.textContent = 'Escaneie o QR no WhatsApp.';
        statusEl.className = 'status success';
      } else if (data.status === 'connected') {
        show(qrContainer, false);
        show(pairingContainerEl, false);
        statusEl.textContent = 'Conectado.';
        statusEl.className = 'status success';
        connectingInstanceName = null;
      } else {
        statusEl.textContent = 'Aguardando QR...';
        statusEl.className = 'status';
        show(qrContainer, false);
      }
      show(statusEl, true);
      refreshInstanceList();
    } catch (e) {
      statusEl.textContent = e.message || 'Erro de rede';
      statusEl.className = 'status error';
      show(statusEl, true);
      connectingInstanceName = null;
    }
  }

  const connectInstanceSelect = document.getElementById('connectInstanceSelect');
  const connectNewNameRow = document.getElementById('connectNewNameRow');

  connectInstanceSelect.addEventListener('change', () => {
    const isNew = connectInstanceSelect.value === '';
    connectNewNameRow.style.display = isNew ? '' : 'none';
  });

  document.getElementById('btnConnect').addEventListener('click', () => {
    const selected = connectInstanceSelect.value;
    const name = selected ? selected : (document.getElementById('instanceName').value.trim() || 'main');
    doConnect(name);
  });

  async function fetchQrAndShow(name, qrImage, qrContainer) {
    try {
      const res = await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/qr`, { headers: headers() });
      const data = await res.json();
      if (data.qr) {
        qrImage.src = data.qr;
        show(qrContainer, true);
      }
    } catch (_) {}
  }

  function renderInstanceList(list) {
    const ul = document.getElementById('instanceList');
    if (!list.length) {
      setListState(ul, 'Nenhuma instancia ativa no momento.');
      return;
    }
    ul.innerHTML = list
      .map(
        (i) =>
          `<li class="instance-row">
            <span class="instance-name">${escapeHtml(i.instance)}</span>
            <span class="badge ${escapeHtml(i.status)}">${escapeHtml(i.status)}</span>
            <div class="instance-actions">
              <a class="btn btn-small btn-primary" href="/instance.html?instance=${encodeURIComponent(i.instance)}">Painel</a>
              ${i.status === 'qr' ? `<button type="button" class="btn btn-small btn-ghost" data-action="qr" data-name="${i.instance}">Ver QR</button>` : ''}
              ${i.status === 'connected' ? `<button type="button" class="btn btn-small btn-ghost" data-action="disconnect" data-name="${i.instance}">Desconectar</button>` : ''}
              <button type="button" class="btn btn-small btn-ghost" data-action="logout" data-name="${i.instance}" title="Novo QR na próxima conexão">Novo QR</button>
              <button type="button" class="btn btn-small btn-danger" data-action="delete" data-name="${i.instance}">Deletar</button>
            </div>
          </li>`
      )
      .join('');
    ul.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        const name = btn.getAttribute('data-name');
        if (!name) return;
        const base = `${API}/v1/instances/${encodeURIComponent(name)}`;
        try {
          if (action === 'qr') {
            const res = await fetch(`${base}/qr`, { headers: headers() });
            const data = await res.json();
            if (data.qr) {
              document.getElementById('qrImage').src = data.qr;
              document.getElementById('instanceName').value = name;
              show(document.getElementById('qrContainer'), true);
              show(pairingContainerEl, false);
              show(document.getElementById('connectStatus'), false);
            }
          } else if (action === 'disconnect') {
            await fetch(`${base}/disconnect`, { method: 'POST', headers: headers() });
            refreshInstanceList();
          } else if (action === 'logout') {
            await fetch(`${base}/logout`, { method: 'POST', headers: headers() });
            refreshInstanceList();
          } else if (action === 'delete') {
            await fetch(base, { method: 'DELETE', headers: headers() });
            refreshInstanceList();
          }
        } catch (_) {}
        refreshInstanceList();
      });
    });
  }

  function updateConnectSelect(saved) {
    const sel = document.getElementById('connectInstanceSelect');
    const current = sel.value;
    sel.innerHTML = '<option value="">— Nova conexão —</option>' +
      (saved || []).map((n) => `<option value="${escapeHtml(n)}" ${n === current ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
    connectNewNameRow.style.display = sel.value === '' ? '' : 'none';
  }

  function updateIntegrationSelect(names) {
    if (!integrationInstanceEl) return;
    const current = integrationInstanceEl.value;
    const list = Array.isArray(names) ? names : [];
    if (!list.length) {
      integrationInstanceEl.innerHTML = '<option value="main">main</option>';
      return;
    }
    integrationInstanceEl.innerHTML = list
      .map((name) => `<option value="${escapeHtml(name)}" ${name === current ? 'selected' : ''}>${escapeHtml(name)}</option>`)
      .join('');
    if (!list.includes(current)) integrationInstanceEl.selectedIndex = 0;
  }

  function updateOverviewStats(saved, instances) {
    const safeSaved = Array.isArray(saved) ? saved : [];
    const safeInstances = Array.isArray(instances) ? instances : [];
    const connectedCount = safeInstances.filter((entry) => String(entry.status || '') === 'connected').length;
    const statSaved = document.getElementById('statSavedCount');
    const statActive = document.getElementById('statActiveCount');
    const statConnected = document.getElementById('statConnectedCount');
    if (statSaved) statSaved.textContent = String(safeSaved.length);
    if (statActive) statActive.textContent = String(safeInstances.length);
    if (statConnected) statConnected.textContent = String(connectedCount);
  }

  function fillIntegrationsForm(integration) {
    const chatwoot = integration?.chatwoot || {};
    document.getElementById('chatwootEnabled').checked = Boolean(chatwoot.enabled);
    document.getElementById('chatwootBaseUrl').value = chatwoot.baseUrl || '';
    document.getElementById('chatwootAccountId').value = chatwoot.accountId || '';
    document.getElementById('chatwootInboxId').value = chatwoot.inboxId || '';
    document.getElementById('chatwootToken').value = chatwoot.apiAccessToken || '';

    const n8n = integration?.n8n || {};
    document.getElementById('n8nEnabled').checked = Boolean(n8n.enabled);
    document.getElementById('n8nWebhookUrl').value = n8n.webhookUrl || '';
    document.getElementById('n8nAuthHeaderName').value = n8n.authHeaderName || 'x-api-key';
    document.getElementById('n8nAuthHeaderValue').value = n8n.authHeaderValue || '';
  }

  async function loadIntegrationsForSelected() {
    if (!integrationInstanceEl) return;
    const instance = (integrationInstanceEl.value || '').trim();
    if (!instance) return;

    try {
      const res = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}`, { headers: headers() });
      const data = await res.json();
      if (!res.ok || !data.integration) {
        setIntegrationStatus(data.error || 'Erro ao carregar integrações.', 'error');
        return;
      }
      fillIntegrationsForm(data.integration);
      setIntegrationStatus(`Integrações carregadas para ${instance}.`, 'success');
    } catch (error) {
      setIntegrationStatus(error.message || 'Erro de rede ao carregar integrações.', 'error');
    }
  }

  async function saveChatwootConfig() {
    const instance = (integrationInstanceEl?.value || '').trim();
    if (!instance) return;
    const body = {
      enabled: document.getElementById('chatwootEnabled').checked,
      baseUrl: document.getElementById('chatwootBaseUrl').value.trim(),
      accountId: document.getElementById('chatwootAccountId').value.trim(),
      inboxId: document.getElementById('chatwootInboxId').value.trim(),
      apiAccessToken: document.getElementById('chatwootToken').value.trim(),
    };
    try {
      const res = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult(chatwootResultEl, data.error || 'Erro ao salvar Chatwoot.', 'error');
        return;
      }
      fillIntegrationsForm(data.integration);
      setResult(chatwootResultEl, 'Configuração Chatwoot salva.', 'success');
    } catch (error) {
      setResult(chatwootResultEl, error.message || 'Erro de rede ao salvar Chatwoot.', 'error');
    }
  }

  async function testChatwootConfig() {
    const instance = (integrationInstanceEl?.value || '').trim();
    if (!instance) return;
    try {
      const res = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/test`, {
        method: 'POST',
        headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult(chatwootResultEl, data.error || 'Teste Chatwoot falhou.', 'error');
        return;
      }
      setResult(chatwootResultEl, `Chatwoot OK (status ${data.status || 200}).`, 'success');
    } catch (error) {
      setResult(chatwootResultEl, error.message || 'Erro de rede no teste Chatwoot.', 'error');
    }
  }

  async function saveN8nConfig() {
    const instance = (integrationInstanceEl?.value || '').trim();
    if (!instance) return;
    const body = {
      enabled: document.getElementById('n8nEnabled').checked,
      webhookUrl: document.getElementById('n8nWebhookUrl').value.trim(),
      authHeaderName: document.getElementById('n8nAuthHeaderName').value.trim(),
      authHeaderValue: document.getElementById('n8nAuthHeaderValue').value.trim(),
    };
    try {
      const res = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/n8n`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult(n8nResultEl, data.error || 'Erro ao salvar n8n.', 'error');
        return;
      }
      fillIntegrationsForm(data.integration);
      setResult(n8nResultEl, 'Configuração n8n salva.', 'success');
    } catch (error) {
      setResult(n8nResultEl, error.message || 'Erro de rede ao salvar n8n.', 'error');
    }
  }

  async function testN8nConfig() {
    const instance = (integrationInstanceEl?.value || '').trim();
    if (!instance) return;
    try {
      const res = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/n8n/test`, {
        method: 'POST',
        headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult(n8nResultEl, data.error || 'Teste n8n falhou.', 'error');
        return;
      }
      setResult(n8nResultEl, `n8n OK (status ${data.status || 200}).`, 'success');
    } catch (error) {
      setResult(n8nResultEl, error.message || 'Erro de rede no teste n8n.', 'error');
    }
  }

  async function refreshInstanceList() {
    const statusEl = document.getElementById('connectStatus');
    const qrContainer = document.getElementById('qrContainer');
    const qrImage = document.getElementById('qrImage');
    try {
      const res = await fetch(`${API}/v1/instances`, { headers: headers() });
      const data = await res.json();
      if (data.saved) {
        renderSavedList(data.saved);
        updateConnectSelect(data.saved);
      } else {
        renderSavedList([]);
        updateConnectSelect([]);
      }
      if (data.instances) {
        renderInstanceList(data.instances);
        const sel = document.getElementById('dispatchInstance');
        const current = sel.value;
        const names = [...new Set([...data.instances.map((i) => i.instance), ...(data.saved || [])])];
        sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}" ${n === current ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
        if (!names.includes(current)) sel.selectedIndex = 0;
        updateIntegrationSelect(names);

        // Atualização ativa: se estamos conectando uma instância, atualizar QR e status
        if (connectingInstanceName) {
          const inst = data.instances.find((i) => i.instance === connectingInstanceName);
          if (inst) {
            if (inst.status === 'qr' && connectingMode === 'qr') {
              try {
                const qrRes = await fetch(`${API}/v1/instances/${encodeURIComponent(connectingInstanceName)}/qr`, { headers: headers() });
                const qrData = await qrRes.json();
                if (qrData.qr) {
                  qrImage.src = qrData.qr;
                  show(qrContainer, true);
                  show(pairingContainerEl, false);
                  statusEl.textContent = 'Escaneie o QR no WhatsApp.';
                  statusEl.className = 'status success';
                  show(statusEl, true);
                }
              } catch (_) {}
            } else if (inst.status !== 'connected' && connectingMode === 'pairing') {
              const currentPairingCode = String(pairingCodeValueEl.textContent || '').trim();
              show(qrContainer, false);
              if (currentPairingCode) {
                show(pairingContainerEl, true);
                statusEl.textContent = 'Digite o pairing code no WhatsApp para concluir a conexão.';
                statusEl.className = 'status success';
              } else {
                show(pairingContainerEl, false);
                statusEl.textContent = 'Aguardando geração do pairing code...';
                statusEl.className = 'status';
              }
              show(statusEl, true);
            } else if (inst.status === 'connected') {
              show(qrContainer, false);
              show(pairingContainerEl, false);
              statusEl.textContent = 'Conectado.';
              statusEl.className = 'status success';
              show(statusEl, true);
              connectingInstanceName = null;
            } else if (inst.status === 'disconnected') {
              show(pairingContainerEl, false);
              statusEl.textContent = 'Desconectado. Clique em Conectar novamente.';
              statusEl.className = 'status error';
              show(statusEl, true);
              connectingInstanceName = null;
            }
          } else {
            connectingInstanceName = null;
          }
        }
      }
      updateOverviewStats(data.saved || [], data.instances || []);
    } catch (_) {
      renderSavedList([]);
      renderInstanceList([]);
      updateConnectSelect([]);
      updateOverviewStats([], []);
    }
  }

  document.getElementById('btnRefreshList').addEventListener('click', refreshInstanceList);
  if (integrationInstanceEl) {
    document.getElementById('btnIntegrationReload').addEventListener('click', loadIntegrationsForSelected);
    integrationInstanceEl.addEventListener('change', loadIntegrationsForSelected);
    document.getElementById('btnSaveChatwoot').addEventListener('click', saveChatwootConfig);
    document.getElementById('btnTestChatwoot').addEventListener('click', testChatwootConfig);
    document.getElementById('btnSaveN8n').addEventListener('click', saveN8nConfig);
    document.getElementById('btnTestN8n').addEventListener('click', testN8nConfig);
    const btnOpenIntegrationPanel = document.getElementById('btnOpenIntegrationPanel');
    if (btnOpenIntegrationPanel) {
      btnOpenIntegrationPanel.addEventListener('click', () => {
        const name = (integrationInstanceEl.value || '').trim();
        if (!name) return;
        window.location.href = `/instance.html?instance=${encodeURIComponent(name)}#integrations`;
      });
    }
  }

  const integrationsTab = document.querySelector('[data-tab="integracoes"]');
  if (integrationsTab) {
    integrationsTab.addEventListener('click', () => {
      loadIntegrationsForSelected();
    });
  }

  show(connectPhoneRowEl, false);
  refreshInstanceList();
  if (integrationInstanceEl) {
    loadIntegrationsForSelected();
  }

  // Polling ativo: atualizar lista, QR e status a cada 2s quando a aba Conexões estiver visível
  setInterval(() => {
    if (document.getElementById('conexoes').classList.contains('active')) {
      refreshInstanceList();
    }
  }, 2000);

  // --- Formulários dinâmicos (add/remove e montagem do payload) ---
  function addRow(containerId, html, removeClass) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const div = document.createElement('div');
    div.className = removeClass || 'item-row';
    div.innerHTML = html + (removeClass ? '' : ' <button type="button" class="btn btn-small btn-ghost btn-remove">Remover</button>');
    const removeBtn = div.querySelector('.btn-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => div.remove());
    container.appendChild(div);
  }

  function addMenuOption() {
    addRow('menuOptionsList', '<input type="text" placeholder="ID (opcional)" data-field="id"><input type="text" placeholder="Texto da opcao" data-field="text"><input type="text" placeholder="Descricao (opcional)" data-field="description">');
  }
  function addButtonRow() {
    addRow('buttonsList', '<input type="text" placeholder="ID do botão" data-field="id"><input type="text" placeholder="Texto do botão" data-field="text">');
  }
  function addInteractiveRow() {
    addRow(
      'interactiveList',
      `<select data-field="type"><option value="url">URL</option><option value="copy">Copiar</option><option value="call">Ligar</option></select>
       <input type="text" placeholder="Texto do botão" data-field="text">
       <input type="text" placeholder="URL / Código / Telefone" data-field="extra">`
    );
  }
  function addPollOption() {
    addRow('pollOptionsList', '<input type="text" placeholder="Opção" data-field="opt">');
  }

  function addListSection() {
    const container = document.getElementById('listSectionsList');
    const block = document.createElement('div');
    block.className = 'block-section';
    block.innerHTML = `
      <div class="block-title">Seção</div>
      <input type="text" class="section-title" placeholder="Título da seção">
      <div class="sub-list section-rows"></div>
      <button type="button" class="btn btn-small btn-ghost add-row-in-section">+ Adicionar item</button>
      <button type="button" class="btn btn-small btn-danger btn-remove-block">Remover seção</button>
    `;
    block.querySelector('.add-row-in-section').addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'item-row';
      row.innerHTML = `
        <input type="text" placeholder="ID" data-field="id">
        <input type="text" placeholder="Título" data-field="title">
        <input type="text" placeholder="Descrição" data-field="desc">
        <button type="button" class="btn btn-small btn-ghost btn-remove">Remover</button>
      `;
      row.querySelector('.btn-remove').onclick = () => row.remove();
      block.querySelector('.section-rows').appendChild(row);
    });
    block.querySelector('.btn-remove-block').onclick = () => block.remove();
    container.appendChild(block);
  }

  function addCarouselCard() {
    const container = document.getElementById('carouselCardsList');
    const block = document.createElement('div');
    block.className = 'block-section';
    block.innerHTML = `
      <div class="block-title">Card</div>
      <div class="form-row"><input type="text" placeholder="Título" data-field="title"></div>
      <div class="form-row"><input type="text" placeholder="Descricao" data-field="description"></div>
      <div class="form-row"><input type="text" placeholder="Rodapé" data-field="footer"></div>
      <div class="form-row"><input type="text" placeholder="URL da imagem" data-field="imageUrl"></div>
      <div class="sub-list card-buttons"></div>
      <button type="button" class="btn btn-small btn-ghost add-card-btn">+ Botão no card</button>
      <button type="button" class="btn btn-small btn-danger btn-remove-block">Remover card</button>
    `;
    block.querySelector('.add-card-btn').addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'item-row';
      row.innerHTML = `
        <input type="text" placeholder="ID" data-field="id">
        <input type="text" placeholder="Texto" data-field="text">
        <button type="button" class="btn btn-small btn-ghost btn-remove">Remover</button>
      `;
      row.querySelector('.btn-remove').onclick = () => row.remove();
      block.querySelector('.card-buttons').appendChild(row);
    });
    block.querySelector('.btn-remove-block').onclick = () => block.remove();
    container.appendChild(block);
  }

  document.querySelectorAll('.add-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const forId = btn.getAttribute('data-for');
      if (forId === 'menuOptions') addMenuOption();
      else if (forId === 'buttons') addButtonRow();
      else if (forId === 'interactive') addInteractiveRow();
      else if (forId === 'listSections') addListSection();
      else if (forId === 'pollOptions') addPollOption();
      else if (forId === 'carouselCards') addCarouselCard();
    });
  });

  // Inicializar um item vazio por tipo
  addMenuOption();
  addButtonRow();
  addInteractiveRow();
  addPollOption();

  // Coletar dados dos formulários e montar payload
  function getMenuPayload() {
    const options = [];
    document.querySelectorAll('#menuOptionsList .item-row').forEach((row, idx) => {
      const id = row.querySelector('[data-field="id"]')?.value?.trim();
      const text = row.querySelector('[data-field="text"]')?.value?.trim();
      const description = row.querySelector('[data-field="description"]')?.value?.trim();
      if (!text) return;
      options.push({
        id: id || String(idx + 1),
        text,
        ...(description ? { description } : {}),
      });
    });
    return {
      url: '/v1/messages/send_menu',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        title: document.getElementById('menuTitle').value.trim() || 'Menu',
        text: document.getElementById('menuText').value.trim() || 'Escolha uma opção:',
        options: options.length ? options : [{ id: '1', text: 'Opcao 1' }],
        footer: document.getElementById('menuFooter').value.trim() || undefined,
      },
    };
  }
  function getButtonsPayload() {
    const buttons = [];
    document.querySelectorAll('#buttonsList .item-row').forEach((row) => {
      const id = row.querySelector('[data-field="id"]')?.value?.trim();
      const text = row.querySelector('[data-field="text"]')?.value?.trim();
      if (id && text) buttons.push({ id, text });
    });
    return {
      url: '/v1/messages/send_buttons_helpers',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        text: document.getElementById('buttonsText').value.trim() || 'Escolha:',
        footer: document.getElementById('buttonsFooter').value.trim() || undefined,
        buttons: buttons.length ? buttons.slice(0, 3) : [{ id: 'btn1', text: 'Opção 1' }],
      },
    };
  }
  function getInteractivePayload() {
    const ctas = [];
    document.querySelectorAll('#interactiveList .item-row').forEach((row) => {
      const type = row.querySelector('[data-field="type"]')?.value || 'url';
      const text = row.querySelector('[data-field="text"]')?.value?.trim();
      const extra = row.querySelector('[data-field="extra"]')?.value?.trim();
      if (!text || !extra) return;
      const cta = { type, text };
      if (type === 'url') cta.url = extra;
      else if (type === 'copy') cta.copy_code = extra;
      else if (type === 'call') cta.phone_number = extra;
      ctas.push(cta);
    });
    return {
      url: '/v1/messages/send_interactive_helpers',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        text: document.getElementById('interactiveText').value.trim() || 'Confira:',
        footer: document.getElementById('interactiveFooter').value.trim() || undefined,
        ctas,
      },
    };
  }
  function getListPayload() {
    const sections = [];
    document.querySelectorAll('#listSectionsList .block-section').forEach((block) => {
      const title = block.querySelector('.section-title')?.value?.trim() || 'Seção';
      const rows = [];
      block.querySelectorAll('.section-rows .item-row').forEach((row) => {
        const id = row.querySelector('[data-field="id"]')?.value?.trim();
        const titleR = row.querySelector('[data-field="title"]')?.value?.trim();
        const desc = row.querySelector('[data-field="desc"]')?.value?.trim();
        if (id && titleR) rows.push({ id, title: titleR, description: desc || '' });
      });
      if (rows.length) sections.push({ title, rows });
    });
    return {
      url: '/v1/messages/send_list_helpers',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        text: document.getElementById('listText').value.trim() || 'Escolha:',
        buttonText: document.getElementById('listButtonText').value.trim() || 'Ver opções',
        footer: document.getElementById('listFooter').value.trim() || undefined,
        sections: sections.length ? sections : [{ title: 'Opções', rows: [{ id: 'opt1', title: 'Opção 1', description: '' }] }],
      },
    };
  }
  function getPollPayload() {
    const options = [];
    document.querySelectorAll('#pollOptionsList .item-row input[data-field="opt"]').forEach((inp) => {
      const v = inp.value.trim();
      if (v) options.push(v);
    });
    return {
      url: '/v1/messages/send_poll',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        name: document.getElementById('pollName').value.trim() || 'Enquete',
        options: options.length >= 2 ? options : ['Sim', 'Não'],
        selectableCount: parseInt(document.getElementById('pollSelectable').value, 10) || 1,
      },
    };
  }
  function getCarouselPayload() {
    const cards = [];
    document.querySelectorAll('#carouselCardsList .block-section').forEach((block) => {
      const title = block.querySelector('[data-field="title"]')?.value?.trim();
      const description = block.querySelector('[data-field="description"]')?.value?.trim();
      const footer = block.querySelector('[data-field="footer"]')?.value?.trim();
      const imageUrl = block.querySelector('[data-field="imageUrl"]')?.value?.trim();
      const buttons = [];
      block.querySelectorAll('.card-buttons .item-row').forEach((row) => {
        const id = row.querySelector('[data-field="id"]')?.value?.trim();
        const text = row.querySelector('[data-field="text"]')?.value?.trim();
        if (id && text) buttons.push({ id, text });
      });
      cards.push({
        title: title || '',
        description: description || '',
        footer: footer || undefined,
        imageUrl: imageUrl || undefined,
        buttons: buttons.length ? buttons : [{ id: 'btn1', text: 'Ver' }],
      });
    });
    return {
      url: '/v1/messages/send_carousel_helpers',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        text: document.getElementById('carouselText').value.trim() || undefined,
        footer: document.getElementById('carouselFooter').value.trim() || undefined,
        cards: cards.length ? cards : [{ title: 'Card', description: '', buttons: [{ id: 'b1', text: 'Botao' }] }],
      },
    };
  }

  /**
   * Lê destinatários do campo e normaliza: aceita +55, espaços, traços, vírgulas etc.
   * Ex: "+55 35 9882-8503," vira "553598828503".
   */
  function getRecipients() {
    const raw = document.getElementById('dispatchTo').value.trim();
    if (!raw) return [];
    return raw
      .split(/[\r\n,;]+/)
      .map((s) => s.replace(/\D/g, ''))
      .filter((n) => n.length >= 10);
  }

  function delayMs(minSec, maxSec) {
    const min = Math.max(0, Number(minSec) || 0);
    const max = Math.max(min, Number(maxSec) || min);
    const sec = min + Math.random() * (max - min);
    return Math.round(sec * 1000);
  }

  document.getElementById('btnSend').addEventListener('click', async () => {
    const recipients = getRecipients();
    const resultEl = document.getElementById('sendResult');
    const btnSend = document.getElementById('btnSend');
    if (!recipients.length) {
      resultEl.textContent = 'Informe ao menos um número (um por linha, com DDI).';
      resultEl.className = 'result error';
      show(resultEl, true);
      return;
    }
    const type = document.getElementById('dispatchType').value;
    let payload;
    switch (type) {
      case 'menu': payload = getMenuPayload(); break;
      case 'buttons': payload = getButtonsPayload(); break;
      case 'interactive': payload = getInteractivePayload(); break;
      case 'list': payload = getListPayload(); break;
      case 'poll': payload = getPollPayload(); break;
      case 'carousel': payload = getCarouselPayload(); break;
      default:
        resultEl.textContent = 'Tipo não implementado.';
        resultEl.className = 'result error';
        show(resultEl, true);
        return;
    }
    if (type === 'interactive' && (!payload.body.ctas || payload.body.ctas.length === 0)) {
      resultEl.textContent = 'Adicione ao menos um botão CTA.';
      resultEl.className = 'result error';
      show(resultEl, true);
      return;
    }

    const delayMin = document.getElementById('dispatchDelayMin').value;
    const delayMax = document.getElementById('dispatchDelayMax').value;
    let sent = 0;
    let failed = 0;
    btnSend.disabled = true;
    show(resultEl, true);
    resultEl.className = 'result';

    for (let i = 0; i < recipients.length; i++) {
      const to = recipients[i];
      payload.body.to = to;
      resultEl.textContent = `Enviando ${i + 1}/${recipients.length}... (${to})`;
      try {
        const res = await fetch(`${API}${payload.url}`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(payload.body),
        });
        const data = await res.json();
        if (res.ok) {
          sent++;
        } else {
          failed++;
        }
      } catch (_) {
        failed++;
      }
      if (i < recipients.length - 1) {
        const wait = delayMs(delayMin, delayMax);
        resultEl.textContent = `Aguardando ${wait / 1000}s antes do próximo... (${i + 1}/${recipients.length})`;
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    resultEl.textContent = `Concluído: ${sent} enviados${failed ? `, ${failed} falhas` : ''}.`;
    resultEl.className = failed === 0 ? 'result success' : failed === recipients.length ? 'result error' : 'result';
    btnSend.disabled = false;
  });
})();
