(function () {
  'use strict';
  const API = '';
  const API_KEY_STORAGE_KEY = 'rscara_api_key';

  // ============ API key storage ============
  function getStoredApiKey() {
    try {
      const ls = localStorage.getItem(API_KEY_STORAGE_KEY);
      if (ls) return ls;
      const ss = sessionStorage.getItem(API_KEY_STORAGE_KEY);
      if (ss) {
        localStorage.setItem(API_KEY_STORAGE_KEY, ss);
        return ss;
      }
    } catch {}
    return '';
  }
  function storeApiKey(k) {
    try {
      if (k) {
        localStorage.setItem(API_KEY_STORAGE_KEY, k);
        sessionStorage.setItem(API_KEY_STORAGE_KEY, k);
      } else {
        localStorage.removeItem(API_KEY_STORAGE_KEY);
        sessionStorage.removeItem(API_KEY_STORAGE_KEY);
      }
    } catch {}
  }

  const apiKeyInput = document.getElementById('apiKey');
  const stored = getStoredApiKey();
  if (stored && !apiKeyInput.value) apiKeyInput.value = stored;
  apiKeyInput.addEventListener('input', () => storeApiKey(apiKeyInput.value.trim()));

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    const k = apiKeyInput.value.trim() || getStoredApiKey();
    if (k) {
      h['x-api-key'] = k;
      storeApiKey(k);
    }
    return h;
  }

  // ============ Helpers ============
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function show(el, visible) { if (el) el.classList.toggle('hidden', !visible); }
  function setResult(el, msg, tone) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'result' + (tone ? ' ' + tone : '');
    show(el, !!msg);
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function delayMs(min, max) {
    const a = Math.max(0, Number(min) || 0);
    const b = Math.max(a, Number(max) || a);
    return (a + Math.random() * (b - a)) * 1000;
  }

  // ============ Tab switching ============
  const navBtns = document.querySelectorAll('.nav-btn[data-tab]');
  const sections = document.querySelectorAll('section.section');
  const topbarTitle = document.getElementById('topbarTitle');
  const TAB_TITLES = { conexoes: 'Instâncias', disparos: 'Disparos', integracoes: 'Integrações' };

  function activateTab(name) {
    navBtns.forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    sections.forEach((s) => s.classList.toggle('active', s.id === name));
    if (topbarTitle && TAB_TITLES[name]) topbarTitle.textContent = TAB_TITLES[name];
    if (name === 'integracoes') loadIntegrationsForSelected();
  }
  navBtns.forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));

  // ============ Connection state ============
  let connectingInstanceName = null;
  let connectingMode = 'qr';

  // Connection elements
  const connectModeEl = document.getElementById('connectMode');
  const connectPhoneRow = document.getElementById('connectPhoneRow');
  const connectInstanceSelectEl = document.getElementById('connectInstanceSelect');
  const connectNewNameRow = document.getElementById('connectNewNameRow');
  const instanceNameEl = document.getElementById('instanceName');
  const pairingPhoneEl = document.getElementById('pairingPhone');
  const pairingContainer = document.getElementById('pairingContainer');
  const pairingCodeValueEl = document.getElementById('pairingCodeValue');
  const qrContainer = document.getElementById('qrContainer');
  const qrImageEl = document.getElementById('qrImage');
  const connectStatusEl = document.getElementById('connectStatus');

  connectModeEl.addEventListener('change', () => {
    show(connectPhoneRow, connectModeEl.value === 'pairing');
  });
  connectInstanceSelectEl.addEventListener('change', () => {
    show(connectNewNameRow, !connectInstanceSelectEl.value);
  });

  // ============ Instance list polling ============
  const savedListEl = document.createElement('ul'); // not used directly, kept for compat
  const instanceListEl = document.getElementById('instanceList');
  const stat = {
    saved: document.getElementById('statSavedCount'),
    active: document.getElementById('statActiveCount'),
    connected: document.getElementById('statConnectedCount'),
  };

  let lastInstanceListMeta = { saved: [], instances: [] };
  let instancePollHandle = null;
  let instancePollBusy = false;
  let syncPollBusy = false;

  function instanceListMeta(saved, instances) {
    return {
      saved: saved.slice().sort(),
      instances: instances
        .map((x) => [x.instance || '', x.status || ''])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    };
  }

  function sameSimpleList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (Array.isArray(a[i]) || Array.isArray(b[i])) {
        const left = a[i];
        const right = b[i];
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let j = 0; j < left.length; j += 1) {
          if (left[j] !== right[j]) return false;
        }
      } else if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function renderUnifiedList(saved, instances) {
    const activeNames = new Set(instances.map((i) => i.instance));
    const items = [];
    instances.forEach((i) => items.push({ name: i.instance, status: i.status || 'unknown', saved: saved.includes(i.instance) }));
    saved.forEach((n) => { if (!activeNames.has(n)) items.push({ name: n, status: 'saved', saved: true }); });
    items.sort((a, b) => a.name.localeCompare(b.name));

    if (items.length === 0) {
      instanceListEl.innerHTML = '<li class="list-empty">Nenhuma instância. Crie uma usando o painel à direita.</li>';
      return;
    }

    instanceListEl.innerHTML = items.map((it) => {
      const sCls =
        it.status === 'connected' ? 'state-connected' :
        it.status === 'qr' ? 'state-qr' :
        it.status === 'pairing' ? 'state-pairing' :
        it.status === 'connecting' ? 'state-connecting' : 'state-disconnected';
      const actions = [];
      if (it.status !== 'saved') {
        actions.push(`<a class="btn btn-primary btn-sm" href="/instance.html?instance=${encodeURIComponent(it.name)}">Painel</a>`);
        if (it.status === 'qr') actions.push(`<button class="btn btn-secondary btn-sm" data-action="qr" data-name="${escapeHtml(it.name)}">Ver QR</button>`);
        if (it.status === 'connected') actions.push(`<button class="btn btn-secondary btn-sm" data-action="disconnect" data-name="${escapeHtml(it.name)}">Disconnect</button>`);
        actions.push(`<button class="btn btn-ghost btn-sm" data-action="logout" data-name="${escapeHtml(it.name)}" title="Limpa sessão (novo QR)">Logout</button>`);
        actions.push(`<button class="btn btn-danger btn-sm" data-action="delete" data-name="${escapeHtml(it.name)}">Deletar</button>`);
      } else {
        actions.push(`<button class="btn btn-primary btn-sm" data-action="connect-saved" data-name="${escapeHtml(it.name)}">Conectar</button>`);
        actions.push(`<button class="btn btn-danger btn-sm" data-action="logout" data-name="${escapeHtml(it.name)}" title="Excluir sessão salva">Excluir</button>`);
      }
      const statusText = it.status === 'saved' ? 'salva (offline)' : it.status;
      return `<li class="list-item">
        <div class="list-item-info">
          <div class="avatar-circle">${escapeHtml((it.name[0] || '?').toUpperCase())}</div>
          <div>
            <div class="list-item-name">${escapeHtml(it.name)}</div>
            <span class="status-pill ${sCls}">${escapeHtml(statusText)}</span>
          </div>
        </div>
        <div class="list-item-actions">${actions.join('')}</div>
      </li>`;
    }).join('');
  }

  function updateOverview(saved, instances) {
    if (stat.saved) stat.saved.textContent = saved.length;
    if (stat.active) stat.active.textContent = instances.length;
    if (stat.connected) stat.connected.textContent = instances.filter((s) => s.status === 'connected').length;
  }

  function updateConnectSelect(saved) {
    const cur = connectInstanceSelectEl.value;
    const opts = ['<option value="">— Nova conexão —</option>']
      .concat(saved.map((n) => `<option value="${escapeHtml(n)}"${cur === n ? ' selected' : ''}>${escapeHtml(n)}</option>`));
    connectInstanceSelectEl.innerHTML = opts.join('');
    show(connectNewNameRow, !connectInstanceSelectEl.value);
  }

  function updateDispatchSelect(allNames) {
    const sel = document.getElementById('dispatchInstance');
    const cur = sel.value;
    const opts = allNames.map((n) => `<option value="${escapeHtml(n)}"${cur === n ? ' selected' : ''}>${escapeHtml(n)}</option>`);
    sel.innerHTML = opts.length ? opts.join('') : '<option value="main">main</option>';
  }

  function updateIntegrationSelect(allNames) {
    const sel = document.getElementById('integrationInstance');
    const cur = sel.value;
    const opts = allNames.map((n) => `<option value="${escapeHtml(n)}"${cur === n ? ' selected' : ''}>${escapeHtml(n)}</option>`);
    sel.innerHTML = opts.length ? opts.join('') : '<option value="main">main</option>';
  }

  async function refreshInstanceList() {
    try {
      const res = await fetch(`${API}/v1/instances`, { headers: headers() });
      if (!res.ok) return;
      const data = await res.json();
      const saved = Array.isArray(data.saved) ? data.saved : [];
      const instances = Array.isArray(data.instances) ? data.instances : [];

      const meta = instanceListMeta(saved, instances);
      if (!sameSimpleList(meta.saved, lastInstanceListMeta.saved) || !sameSimpleList(meta.instances, lastInstanceListMeta.instances)) {
        lastInstanceListMeta = meta;
        renderUnifiedList(saved, instances);
        const allNames = Array.from(new Set([...instances.map((i) => i.instance), ...saved]));
        updateConnectSelect(saved);
        updateDispatchSelect(allNames);
        updateIntegrationSelect(allNames);
      }
      updateOverview(saved, instances);

      // Active QR/pairing update
      if (connectingInstanceName) {
        const me = instances.find((i) => i.instance === connectingInstanceName);
        const status = me?.status;
        if (connectingMode === 'qr' && status === 'qr') {
          try {
            const r = await fetch(`${API}/v1/instances/${encodeURIComponent(connectingInstanceName)}/qr`, { headers: headers() });
            if (r.ok) {
              const d = await r.json();
              if (d.qr) {
                qrImageEl.src = d.qr;
                show(qrContainer, true);
                setResult(connectStatusEl, 'Escaneie o QR no WhatsApp.', '');
              }
            }
          } catch {}
        } else if (status === 'connected') {
          setResult(connectStatusEl, 'Conectado.', 'success');
          connectingInstanceName = null;
          show(qrContainer, false);
          show(pairingContainer, false);
        } else if (status === 'disconnected') {
          setResult(connectStatusEl, 'Desconectado.', 'error');
          connectingInstanceName = null;
        }
      }
    } catch {}
  }

  instanceListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const name = btn.dataset.name;
    const action = btn.dataset.action;
    btn.disabled = true;
    try {
      if (action === 'qr') {
        const r = await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/qr`, { headers: headers() });
        const d = await r.json();
        if (d.qr) {
          qrImageEl.src = d.qr;
          show(qrContainer, true);
          show(pairingContainer, false);
          instanceNameEl.value = name;
        }
      } else if (action === 'disconnect') {
        await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/disconnect`, { method: 'POST', headers: headers() });
      } else if (action === 'logout') {
        if (!confirm(`Limpar sessão "${name}"?`)) { btn.disabled = false; return; }
        await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/logout`, { method: 'POST', headers: headers() });
      } else if (action === 'delete') {
        if (!confirm(`Deletar instância "${name}"?`)) { btn.disabled = false; return; }
        await fetch(`${API}/v1/instances/${encodeURIComponent(name)}`, { method: 'DELETE', headers: headers() });
      } else if (action === 'connect-saved') {
        connectInstanceSelectEl.value = name;
        instanceNameEl.value = name;
        show(connectNewNameRow, false);
        await doConnect(name);
      }
      lastInstanceListMeta = { saved: [], instances: [] }; // force render
      await refreshInstanceList();
    } catch (err) {
      setResult(connectStatusEl, err.message || 'Erro de rede.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnRefreshList').addEventListener('click', () => {
    lastInstanceListMeta = { saved: [], instances: [] };
    refreshInstanceList();
  });

  // ============ Connect ============
  async function requestPairingCode(name) {
    const phone = (pairingPhoneEl.value || '').replace(/\D/g, '');
    if (!phone) { setResult(connectStatusEl, 'Informe o número (DDI+DDD).', 'error'); return; }
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      try {
        const r = await fetch(`${API}/v1/instances/${encodeURIComponent(name)}/pairing-code`, {
          method: 'POST', headers: headers(), body: JSON.stringify({ phoneNumber: phone })
        });
        if (r.status === 503 && attempts < 2) { await sleep(1200); continue; }
        const d = await r.json();
        if (!r.ok) {
          const errMap = {
            session_already_registered: 'Sessão já autenticada. Use Logout para novo QR.',
            pairing_channel_not_ready: 'Canal iniciando. Tente novamente em alguns segundos.',
            empty_pairing_code: 'WhatsApp não retornou código.',
            pairing_code_unavailable: 'Não foi possível gerar agora.',
            pairing_code_unstable: 'Código ficou inválido. Tente outro número.',
            pairing_code_disabled: 'Pairing code desabilitado no servidor.',
          };
          setResult(connectStatusEl, errMap[d.error] || d.error || 'Falha ao gerar código.', 'error');
          return;
        }
        pairingCodeValueEl.textContent = d.pairingCode;
        show(pairingContainer, true);
        show(qrContainer, false);
        setResult(connectStatusEl, `Pairing code gerado para ${phone}.`, 'success');
        return;
      } catch (err) {
        if (attempts < 2) { await sleep(1200); continue; }
        setResult(connectStatusEl, err.message || 'Erro de rede.', 'error');
      }
    }
  }

  async function doConnect(name) {
    const mode = connectModeEl.value;
    connectingInstanceName = name;
    connectingMode = mode;
    show(qrContainer, false);
    show(pairingContainer, false);
    setResult(connectStatusEl, 'Conectando...', '');
    try {
      if (mode === 'pairing') {
        await requestPairingCode(name);
      } else {
        const r = await fetch(`${API}/v1/instances`, {
          method: 'POST', headers: headers(), body: JSON.stringify({ instance: name })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = d.error === 'invalid_instance_name'
            ? 'Nome invalido. Use apenas letras, numeros, "_" ou "-" (1-64).'
            : (d.message || d.error || `Erro ${r.status} ao criar instancia.`);
          setResult(connectStatusEl, msg, 'error');
          connectingInstanceName = null;
          return;
        }
        if (d.qr) {
          qrImageEl.src = d.qr;
          show(qrContainer, true);
          setResult(connectStatusEl, 'Escaneie o QR no WhatsApp.', '');
        } else if (d.status === 'connected') {
          setResult(connectStatusEl, 'Conectado.', 'success');
          connectingInstanceName = null;
        } else {
          setResult(connectStatusEl, 'Aguardando QR...', '');
        }
      }
    } catch (err) {
      setResult(connectStatusEl, err.message || 'Erro de rede.', 'error');
    }
    lastInstanceListMeta = { saved: [], instances: [] };
    refreshInstanceList();
  }

  const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  document.getElementById('btnConnect').addEventListener('click', async () => {
    const sel = connectInstanceSelectEl.value;
    const name = sel || (instanceNameEl.value.trim() || 'main');
    if (!INSTANCE_NAME_PATTERN.test(name)) {
      setResult(connectStatusEl, 'Nome invalido. Use apenas letras, numeros, "_" ou "-" (1-64 caracteres). Sem espacos ou acentos.', 'error');
      return;
    }
    await doConnect(name);
  });

  // ============ Dispatch ============
  const dispatchTypeEl = document.getElementById('dispatchType');
  const dispatchForms = {
    menu: document.getElementById('formMenu'),
    buttons: document.getElementById('formButtons'),
    interactive: document.getElementById('formInteractive'),
    list: document.getElementById('formList'),
    poll: document.getElementById('formPoll'),
    carousel: document.getElementById('formCarousel'),
  };

  function showDispatchForm(t) {
    Object.entries(dispatchForms).forEach(([k, el]) => show(el, k === t));
    if (t === 'list' && document.getElementById('listSectionsList').children.length === 0) addListSection();
    if (t === 'carousel' && document.getElementById('carouselCardsList').children.length === 0) addCarouselCard();
  }
  dispatchTypeEl.addEventListener('change', () => showDispatchForm(dispatchTypeEl.value));

  // Dynamic adders
  function makeRemoveBtn() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-danger btn-sm';
    b.textContent = 'Remover';
    b.addEventListener('click', () => b.parentElement.remove());
    return b;
  }
  function makeRow(...inputs) {
    const row = document.createElement('div');
    row.className = 'dyn-row';
    inputs.forEach((i) => row.appendChild(i));
    row.appendChild(makeRemoveBtn());
    return row;
  }
  function inp(field, placeholder, type = 'text') {
    const i = document.createElement('input');
    i.type = type; i.className = 'input'; i.placeholder = placeholder;
    i.dataset.field = field;
    return i;
  }
  function selOpts(field, options) {
    const s = document.createElement('select');
    s.className = 'select'; s.dataset.field = field;
    s.innerHTML = options.map((o) => `<option value="${o.v}">${o.t}</option>`).join('');
    return s;
  }

  function addMenuOption() {
    const list = document.getElementById('menuOptionsList');
    list.appendChild(makeRow(inp('id', 'ID (opcional)'), inp('text', 'Texto da opção'), inp('description', 'Descrição (opcional)')));
  }
  function addButtonRow() {
    const list = document.getElementById('buttonsList');
    list.appendChild(makeRow(inp('id', 'ID'), inp('text', 'Texto')));
  }
  function addInteractiveRow() {
    const list = document.getElementById('interactiveList');
    const sel = selOpts('type', [{ v: 'url', t: 'URL' }, { v: 'copy', t: 'Copiar' }, { v: 'call', t: 'Ligar' }]);
    list.appendChild(makeRow(sel, inp('text', 'Texto'), inp('extra', 'URL / Código / Telefone')));
  }
  function addPollOption() {
    const list = document.getElementById('pollOptionsList');
    list.appendChild(makeRow(inp('opt', 'Opção')));
  }
  function addListSection() {
    const list = document.getElementById('listSectionsList');
    const block = document.createElement('div');
    block.className = 'dyn-block';
    block.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <p class="dyn-block-title">Seção</p>
        <button type="button" class="btn btn-ghost btn-sm btn-remove-block">Remover</button>
      </div>
      <input type="text" class="input section-title" placeholder="Título da seção">
      <div class="section-rows" style="display:flex; flex-direction:column; gap:6px;"></div>
      <button type="button" class="btn btn-ghost btn-sm add-row-in-section">+ Adicionar item</button>`;
    list.appendChild(block);
    block.querySelector('.btn-remove-block').addEventListener('click', () => block.remove());
    block.querySelector('.add-row-in-section').addEventListener('click', () => {
      const rows = block.querySelector('.section-rows');
      rows.appendChild(makeRow(inp('id', 'ID'), inp('title', 'Título'), inp('desc', 'Descrição')));
    });
    block.querySelector('.add-row-in-section').click();
  }
  function addCarouselCard() {
    const list = document.getElementById('carouselCardsList');
    const block = document.createElement('div');
    block.className = 'dyn-block';
    block.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <p class="dyn-block-title">Card</p>
        <button type="button" class="btn btn-ghost btn-sm btn-remove-block">Remover</button>
      </div>
      <div class="field-row">
        <input type="text" class="input" data-field="title" placeholder="Título">
        <input type="text" class="input" data-field="description" placeholder="Descrição">
      </div>
      <div class="field-row">
        <input type="text" class="input" data-field="footer" placeholder="Rodapé (opcional)">
        <input type="text" class="input mono" data-field="imageUrl" placeholder="https://imagem.png">
      </div>
      <div class="card-buttons" style="display:flex; flex-direction:column; gap:6px;"></div>
      <button type="button" class="btn btn-ghost btn-sm add-card-btn">+ Botão no card</button>`;
    list.appendChild(block);
    block.querySelector('.btn-remove-block').addEventListener('click', () => block.remove());
    block.querySelector('.add-card-btn').addEventListener('click', () => {
      const rows = block.querySelector('.card-buttons');
      rows.appendChild(makeRow(inp('id', 'ID'), inp('text', 'Texto')));
    });
  }

  document.querySelectorAll('button.add-item').forEach((b) => {
    const map = {
      menuOptions: addMenuOption, buttons: addButtonRow,
      interactive: addInteractiveRow, pollOptions: addPollOption,
      listSections: addListSection, carouselCards: addCarouselCard,
    };
    b.addEventListener('click', () => map[b.dataset.for]?.());
  });
  // initial rows
  addMenuOption(); addButtonRow(); addInteractiveRow(); addPollOption();

  function getRecipients() {
    const raw = (document.getElementById('dispatchTo').value || '').split(/[\r\n,;]+/);
    return raw.map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 10);
  }
  function gatherRow(row) {
    const out = {};
    row.querySelectorAll('[data-field]').forEach((el) => { out[el.dataset.field] = (el.value || '').trim(); });
    return out;
  }

  function getMenuPayload(instance, to) {
    const opts = Array.from(document.getElementById('menuOptionsList').children).map(gatherRow)
      .filter((o) => o.text).map((o) => ({ id: o.id || undefined, text: o.text, description: o.description || undefined }));
    return {
      url: '/v1/messages/send_menu',
      body: {
        instance, to,
        title: (document.getElementById('menuTitle').value || 'Menu').trim(),
        text: (document.getElementById('menuText').value || 'Escolha uma opção:').trim(),
        options: opts.length ? opts : [{ id: '1', text: 'Opção 1' }],
        footer: (document.getElementById('menuFooter').value || '').trim() || undefined,
      },
    };
  }
  function getButtonsPayload(instance, to) {
    const btns = Array.from(document.getElementById('buttonsList').children).map(gatherRow)
      .filter((o) => o.text).slice(0, 3).map((o) => ({ id: o.id || `btn${Math.random()}`, text: o.text }));
    return {
      url: '/v1/messages/send_buttons_helpers',
      body: {
        instance, to,
        text: (document.getElementById('buttonsText').value || '').trim(),
        footer: (document.getElementById('buttonsFooter').value || '').trim() || undefined,
        buttons: btns.length ? btns : [{ id: 'btn1', text: 'Opção 1' }],
      },
    };
  }
  function getInteractivePayload(instance, to) {
    const ctas = Array.from(document.getElementById('interactiveList').children).map(gatherRow)
      .filter((o) => o.text && o.extra).map((o) => {
        const c = { type: o.type, text: o.text };
        if (o.type === 'url') c.url = o.extra;
        else if (o.type === 'copy') c.copy_code = o.extra;
        else if (o.type === 'call') c.phone_number = o.extra;
        return c;
      });
    return {
      url: '/v1/messages/send_interactive_helpers',
      body: {
        instance, to,
        text: (document.getElementById('interactiveText').value || '').trim(),
        footer: (document.getElementById('interactiveFooter').value || '').trim() || undefined,
        ctas,
      },
    };
  }
  function getListPayload(instance, to) {
    const sections = Array.from(document.getElementById('listSectionsList').children).map((block) => {
      const title = block.querySelector('.section-title').value.trim();
      const rows = Array.from(block.querySelectorAll('.section-rows .dyn-row')).map(gatherRow)
        .filter((o) => o.title).map((o) => ({ id: o.id || `row${Math.random()}`, title: o.title, description: o.desc || '' }));
      return { title: title || 'Seção', rows };
    }).filter((s) => s.rows.length > 0);
    return {
      url: '/v1/messages/send_list_helpers',
      body: {
        instance, to,
        text: (document.getElementById('listText').value || '').trim(),
        buttonText: (document.getElementById('listButtonText').value || 'Ver opções').trim(),
        footer: (document.getElementById('listFooter').value || '').trim() || undefined,
        sections: sections.length ? sections : [{ title: 'Opções', rows: [{ id: 'opt1', title: 'Opção 1', description: '' }] }],
      },
    };
  }
  function getPollPayload(instance, to) {
    const opts = Array.from(document.getElementById('pollOptionsList').children).map((r) => r.querySelector('[data-field=opt]').value.trim()).filter(Boolean);
    return {
      url: '/v1/messages/send_poll',
      body: {
        instance, to,
        name: (document.getElementById('pollName').value || '').trim(),
        options: opts.length >= 2 ? opts : ['Sim', 'Não'],
        selectableCount: Math.max(1, Number(document.getElementById('pollSelectable').value) || 1),
      },
    };
  }
  function getCarouselPayload(instance, to) {
    const cards = Array.from(document.getElementById('carouselCardsList').children).map((block) => {
      const c = gatherRow(block);
      const buttons = Array.from(block.querySelectorAll('.card-buttons .dyn-row')).map(gatherRow)
        .filter((o) => o.text).map((o) => ({ id: o.id || `b${Math.random()}`, text: o.text }));
      return {
        title: c.title, description: c.description,
        footer: c.footer || undefined,
        imageUrl: c.imageUrl || undefined,
        buttons,
      };
    }).filter((c) => c.title);
    return {
      url: '/v1/messages/send_carousel_helpers',
      body: {
        instance, to,
        text: (document.getElementById('carouselText').value || '').trim() || undefined,
        footer: (document.getElementById('carouselFooter').value || '').trim() || undefined,
        cards,
      },
    };
  }

  document.getElementById('btnSend').addEventListener('click', async () => {
    const recipients = getRecipients();
    const sendResultEl = document.getElementById('sendResult');
    if (recipients.length === 0) { setResult(sendResultEl, 'Informe ao menos um número (com DDI).', 'error'); return; }

    const t = dispatchTypeEl.value;
    const instance = document.getElementById('dispatchInstance').value || 'main';
    const builders = {
      menu: getMenuPayload, buttons: getButtonsPayload, interactive: getInteractivePayload,
      list: getListPayload, poll: getPollPayload, carousel: getCarouselPayload,
    };
    if (t === 'interactive') {
      const probe = builders[t](instance, recipients[0]);
      if (!probe.body.ctas.length) { setResult(sendResultEl, 'Adicione ao menos um CTA.', 'error'); return; }
    }

    const dMin = Number(document.getElementById('dispatchDelayMin').value) || 0;
    const dMax = Number(document.getElementById('dispatchDelayMax').value) || dMin;

    const btn = document.getElementById('btnSend');
    btn.disabled = true;
    let sent = 0, failed = 0;
    for (let i = 0; i < recipients.length; i++) {
      const to = recipients[i];
      const payload = builders[t](instance, to);
      setResult(sendResultEl, `Enviando ${i + 1}/${recipients.length}... (${to})`, '');
      try {
        const r = await fetch(`${API}${payload.url}`, { method: 'POST', headers: headers(), body: JSON.stringify(payload.body) });
        if (r.ok) sent++; else failed++;
      } catch { failed++; }
      if (i < recipients.length - 1) {
        const ms = delayMs(dMin, dMax);
        setResult(sendResultEl, `Aguardando ${(ms / 1000).toFixed(1)}s antes do próximo... (${i + 1}/${recipients.length})`, '');
        await sleep(ms);
      }
    }
    setResult(sendResultEl, `Concluído: ${sent} enviados, ${failed} falhas.`, failed ? (sent ? 'warning' : 'error') : 'success');
    btn.disabled = false;
  });

  // ============ Integrations (index — Chatwoot + n8n) ============
  const integrationInstanceEl = document.getElementById('integrationInstance');
  const integrationStatusEl = document.getElementById('integrationStatus');
  const chatwootResultEl = document.getElementById('chatwootResult');
  const n8nResultEl = document.getElementById('n8nResult');

  // Sync progress polling state
  let syncPollHandle = null;

  function fillIntegrationsForm(integration) {
    const cw = integration?.chatwoot || {};
    document.getElementById('chatwootEnabled').checked = !!cw.enabled;
    document.getElementById('chatwootBaseUrl').value = cw.baseUrl || '';
    document.getElementById('chatwootAccountId').value = cw.accountId || '';
    document.getElementById('chatwootInboxId').value = cw.inboxId || '';
    document.getElementById('chatwootToken').value = cw.apiAccessToken || '';
    document.getElementById('chatwootSignMessages').checked = !!cw.signMessages;
    document.getElementById('chatwootSignDelimiter').value = cw.signDelimiter || '';
    document.getElementById('chatwootNameInbox').value = cw.nameInbox || '';
    document.getElementById('chatwootWebhookSlug').value = cw.webhookSlug || '';
    document.getElementById('chatwootOrganization').value = cw.organization || '';
    document.getElementById('chatwootLogoUrl').value = cw.logoUrl || '';
    document.getElementById('chatwootConversationPending').checked = !!cw.conversationPending;
    document.getElementById('chatwootReopenConversation').checked = cw.reopenConversation !== false;
    document.getElementById('chatwootImportContacts').checked = !!cw.importContacts;
    document.getElementById('chatwootImportMessages').checked = cw.importMessages !== false;
    document.getElementById('chatwootDaysLimit').value = cw.daysLimitImportMessages || 7;
    document.getElementById('chatwootIgnoreJids').value = Array.isArray(cw.ignoreJids) ? cw.ignoreJids.join('\n') : '';
    document.getElementById('chatwootAutoCreate').checked = !!cw.autoCreate;

    const n8n = integration?.n8n || {};
    document.getElementById('n8nEnabled').checked = !!n8n.enabled;
    document.getElementById('n8nWebhookUrl').value = n8n.webhookUrl || '';
    document.getElementById('n8nAuthHeaderName').value = n8n.authHeaderName || '';
    document.getElementById('n8nAuthHeaderValue').value = n8n.authHeaderValue || '';

    // Webhook URL display
    const slug = (cw.webhookSlug || integrationInstanceEl.value || 'main').trim();
    const url = `${window.location.origin}/chatwoot/webhook/${encodeURIComponent(slug)}`;
    document.getElementById('chatwootWebhookUrl').textContent = url;
    show(document.getElementById('chatwootWebhookInfo'), true);
  }

  async function loadIntegrationsForSelected() {
    const instance = (integrationInstanceEl?.value || '').trim();
    if (!instance) return;
    setResult(integrationStatusEl, 'Carregando...', '');
    try {
      const res = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}`, { headers: headers() });
      const data = await res.json();
      if (!res.ok) { setResult(integrationStatusEl, data.error || 'Falha ao carregar.', 'error'); return; }
      fillIntegrationsForm(data.integration);
      setResult(integrationStatusEl, `Configuração carregada para "${instance}".`, 'success');
      const link = document.getElementById('btnOpenIntegrationPanel');
      if (link) link.href = `/instance.html?instance=${encodeURIComponent(instance)}#integrations`;
      // Pull current sync status once
      pollSyncOnce(instance);
    } catch (err) {
      setResult(integrationStatusEl, err.message || 'Erro de rede.', 'error');
    }
  }

  function buildChatwootBody() {
    const ignoreJids = (document.getElementById('chatwootIgnoreJids').value || '')
      .split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    return {
      enabled: document.getElementById('chatwootEnabled').checked,
      baseUrl: document.getElementById('chatwootBaseUrl').value.trim(),
      accountId: document.getElementById('chatwootAccountId').value.trim(),
      inboxId: document.getElementById('chatwootInboxId').value.trim(),
      apiAccessToken: document.getElementById('chatwootToken').value.trim(),
      signMessages: document.getElementById('chatwootSignMessages').checked,
      signDelimiter: document.getElementById('chatwootSignDelimiter').value,
      nameInbox: document.getElementById('chatwootNameInbox').value.trim(),
      webhookSlug: document.getElementById('chatwootWebhookSlug').value.trim(),
      organization: document.getElementById('chatwootOrganization').value.trim(),
      logoUrl: document.getElementById('chatwootLogoUrl').value.trim(),
      conversationPending: document.getElementById('chatwootConversationPending').checked,
      reopenConversation: document.getElementById('chatwootReopenConversation').checked,
      importContacts: document.getElementById('chatwootImportContacts').checked,
      importMessages: document.getElementById('chatwootImportMessages').checked,
      daysLimitImportMessages: Number(document.getElementById('chatwootDaysLimit').value) || 7,
      ignoreJids,
      autoCreate: document.getElementById('chatwootAutoCreate').checked,
    };
  }

  async function saveChatwootConfig() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify(buildChatwootBody()),
      });
      const d = await r.json();
      if (!r.ok) { setResult(chatwootResultEl, d.error || 'Falha ao salvar.', 'error'); return; }
      fillIntegrationsForm(d.integration);
      setResult(chatwootResultEl, 'Configuração Chatwoot salva.', 'success');
    } catch (err) { setResult(chatwootResultEl, err.message || 'Erro.', 'error'); }
  }

  async function testChatwootConfig() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/test`, { method: 'POST', headers: headers() });
      const d = await r.json();
      if (!r.ok) { setResult(chatwootResultEl, d.error || 'Teste falhou.', 'error'); return; }
      setResult(chatwootResultEl, `Chatwoot OK (status ${d.status || 200}).`, 'success');
    } catch (err) { setResult(chatwootResultEl, err.message || 'Erro.', 'error'); }
  }

  async function autoCreateChatwoot() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    setResult(chatwootResultEl, 'Criando inbox...', '');
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/autocreate`, { method: 'POST', headers: headers() });
      const d = await r.json();
      if (!r.ok || !d.ok) { setResult(chatwootResultEl, d.error || 'Falha.', 'error'); return; }
      const res = d.result || {};
      setResult(chatwootResultEl, `Inbox "${res.inboxName || ''}" (id=${res.inboxId || '?'}) criado/atualizado.`, 'success');
      await loadIntegrationsForSelected();
    } catch (err) { setResult(chatwootResultEl, err.message || 'Erro.', 'error'); }
  }

  async function syncContactNamesChatwoot() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    setResult(chatwootResultEl, 'Sincronizando nomes de contatos...', '');
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-contact-names`, {
        method: 'POST', headers: headers()
      });
      const d = await r.json();
      if (!r.ok || !d.ok) { setResult(chatwootResultEl, d.error || 'Falha ao sincronizar nomes.', 'error'); return; }
      const res = d.result || {};
      setResult(chatwootResultEl, `Sync de nomes concluído: ${res.updated || 0} atualizados, ${res.skipped || 0} ignorados, ${res.errors || 0} erros.`, 'success');
    } catch (err) { setResult(chatwootResultEl, err.message || 'Erro.', 'error'); }
  }

  async function startSyncHistory() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-history`, {
        method: 'POST', headers: headers(), body: JSON.stringify({})
      });
      const d = await r.json();
      if (!r.ok) { setResult(chatwootResultEl, d.error || 'Falha ao iniciar.', 'error'); return; }
      setResult(chatwootResultEl, 'Sincronização iniciada — acompanhe abaixo.', 'success');
      startSyncPolling(instance);
    } catch (err) { setResult(chatwootResultEl, err.message || 'Erro.', 'error'); }
  }

  async function cancelSync() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    try {
      await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-cancel`, { method: 'POST', headers: headers() });
    } catch {}
  }

  function renderSyncProgress(p) {
    const panel = document.getElementById('chatwootSyncProgress');
    const badge = document.getElementById('chatwootSyncBadge');
    const fill = document.getElementById('chatwootSyncFill');
    const cur = document.getElementById('chatwootSyncCurrent');
    const elChats = document.getElementById('chatwootSyncChats');
    const elSent = document.getElementById('chatwootSyncSent');
    const elSkipped = document.getElementById('chatwootSyncSkipped');
    const elErrors = document.getElementById('chatwootSyncErrors');
    const btnCancel = document.getElementById('btnCancelSyncChatwoot');
    if (!panel) return;

    if (!p || p.status === 'idle') {
      show(panel, false);
      return;
    }
    show(panel, true);

    const statusMap = {
      running: { txt: 'rodando', cls: 'info' },
      cancelling: { txt: 'cancelando', cls: 'warning' },
      completed: { txt: 'concluído', cls: 'success' },
      cancelled: { txt: 'cancelado', cls: 'warning' },
      failed: { txt: 'falhou', cls: 'danger' },
    };
    const s = statusMap[p.status] || { txt: p.status, cls: '' };
    badge.textContent = s.txt;
    badge.className = 'badge ' + s.cls;
    show(btnCancel, p.status === 'running');

    elChats.textContent = `${p.processedChats || 0}/${p.totalChats || 0}`;
    elSent.textContent = String(p.syncedMessages || 0);
    elSkipped.textContent = String(p.skippedMessages || 0);
    elErrors.textContent = String(p.errorCount || 0);

    cur.textContent = p.currentChatTitle || (p.lastError ? 'erro: ' + p.lastError : (p.status === 'running' ? 'preparando...' : ''));

    fill.classList.remove('indeterminate');
    if (p.status === 'running') {
      if (p.totalChats > 0) {
        const pct = Math.min(100, Math.round((p.processedChats / p.totalChats) * 100));
        fill.style.width = pct + '%';
      } else {
        fill.classList.add('indeterminate');
        fill.style.width = '';
      }
    } else if (p.status === 'completed') {
      fill.style.width = '100%';
    }
  }

  async function pollSyncOnce(instance) {
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/chatwoot/sync-status`, { headers: headers() });
      if (r.ok) {
        const d = await r.json();
        renderSyncProgress(d.progress);
        return d.progress;
      }
    } catch {}
    return null;
  }

  function stopSyncPolling() {
    if (syncPollHandle) { clearTimeout(syncPollHandle); syncPollHandle = null; }
    syncPollBusy = false;
  }

  function startSyncPolling(instance) {
    stopSyncPolling();
    const run = async () => {
      if (syncPollBusy) return;
      syncPollBusy = true;
      const p = await pollSyncOnce(instance);
      syncPollBusy = false;
      if (p && p.status !== 'running' && p.status !== 'cancelling') {
        stopSyncPolling();
        return;
      }
      syncPollHandle = setTimeout(run, 1000);
    };
    run();
  }

  function startInstancePolling() {
    if (instancePollHandle) clearTimeout(instancePollHandle);
    const run = async () => {
      const activeTab = document.querySelector('.nav-btn.active')?.dataset.tab;
      if (activeTab === 'conexoes' && !instancePollBusy) {
        instancePollBusy = true;
        try {
          await refreshInstanceList();
        } finally {
          instancePollBusy = false;
        }
      }
      instancePollHandle = setTimeout(run, 2500);
    };
    run();
  }

  document.getElementById('btnSaveChatwoot').addEventListener('click', saveChatwootConfig);
  document.getElementById('btnTestChatwoot').addEventListener('click', testChatwootConfig);
  document.getElementById('btnAutoCreateChatwoot').addEventListener('click', autoCreateChatwoot);
  document.getElementById('btnSyncContactNamesChatwoot').addEventListener('click', syncContactNamesChatwoot);
  document.getElementById('btnSyncHistoryChatwoot').addEventListener('click', startSyncHistory);
  document.getElementById('btnCancelSyncChatwoot').addEventListener('click', cancelSync);
  document.getElementById('btnIntegrationReload').addEventListener('click', loadIntegrationsForSelected);
  integrationInstanceEl.addEventListener('change', loadIntegrationsForSelected);

  async function saveN8nConfig() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    try {
      const body = {
        enabled: document.getElementById('n8nEnabled').checked,
        webhookUrl: document.getElementById('n8nWebhookUrl').value.trim(),
        authHeaderName: document.getElementById('n8nAuthHeaderName').value.trim(),
        authHeaderValue: document.getElementById('n8nAuthHeaderValue').value.trim(),
      };
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/n8n`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setResult(n8nResultEl, d.error || 'Falha.', 'error'); return; }
      setResult(n8nResultEl, 'Configuração n8n salva.', 'success');
    } catch (err) { setResult(n8nResultEl, err.message || 'Erro.', 'error'); }
  }

  async function testN8nConfig() {
    const instance = integrationInstanceEl.value.trim();
    if (!instance) return;
    try {
      const r = await fetch(`${API}/v1/integrations/${encodeURIComponent(instance)}/n8n/test`, { method: 'POST', headers: headers() });
      const d = await r.json();
      if (!r.ok) { setResult(n8nResultEl, d.error || 'Falha.', 'error'); return; }
      setResult(n8nResultEl, `n8n OK (status ${d.status || 200}).`, 'success');
    } catch (err) { setResult(n8nResultEl, err.message || 'Erro.', 'error'); }
  }
  document.getElementById('btnSaveN8n').addEventListener('click', saveN8nConfig);
  document.getElementById('btnTestN8n').addEventListener('click', testN8nConfig);

  // ============ Boot ============
  showDispatchForm('menu');
  refreshInstanceList();
  startInstancePolling();
})();
