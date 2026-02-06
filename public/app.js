(function () {
  const API = '';
  function headers() {
    const h = { 'Content-Type': 'application/json' };
    const key = document.getElementById('apiKey').value.trim() || localStorage.getItem('rscara_api_key');
    if (key) {
      h['x-api-key'] = key;
      localStorage.setItem('rscara_api_key', key);
    }
    return h;
  }

  function show(el, visible) {
    el.classList.toggle('hidden', !visible);
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

  // --- Conexões: listar salvas e conectar ao clicar ---
  function renderSavedList(saved) {
    const ul = document.getElementById('savedList');
    if (!saved || saved.length === 0) {
      ul.innerHTML = '<li class="text-muted">Nenhuma conexão salva. Conecte uma vez por nome e ela aparecerá aqui.</li>';
      return;
    }
    ul.innerHTML = saved
      .map(
        (name) =>
          `<li class="saved-item-row">
            <span class="instance-name">${name}</span>
            <div class="saved-item-actions">
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

  async function doConnect(name) {
    connectingInstanceName = name;
    const statusEl = document.getElementById('connectStatus');
    const qrContainer = document.getElementById('qrContainer');
    const qrImage = document.getElementById('qrImage');
    show(statusEl, false);
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
        statusEl.textContent = 'Escaneie o QR no WhatsApp.';
        statusEl.className = 'status success';
      } else if (data.status === 'connected') {
        show(qrContainer, false);
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
      ul.innerHTML = '<li>Nenhuma instância ativa.</li>';
      return;
    }
    ul.innerHTML = list
      .map(
        (i) =>
          `<li class="instance-row">
            <span class="instance-name">${i.instance}</span>
            <span class="badge ${i.status}">${i.status}</span>
            <div class="instance-actions">
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
    const options = ['— Nova conexão —', ...(saved || [])];
    sel.innerHTML = '<option value="">— Nova conexão —</option>' +
      (saved || []).map((n) => `<option value="${n}" ${n === current ? 'selected' : ''}>${n}</option>`).join('');
    connectNewNameRow.style.display = sel.value === '' ? '' : 'none';
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
        sel.innerHTML = names.map((n) => `<option value="${n}" ${n === current ? 'selected' : ''}>${n}</option>`).join('');
        if (!names.includes(current)) sel.selectedIndex = 0;

        // Atualização ativa: se estamos conectando uma instância, atualizar QR e status
        if (connectingInstanceName) {
          const inst = data.instances.find((i) => i.instance === connectingInstanceName);
          if (inst) {
            if (inst.status === 'qr') {
              try {
                const qrRes = await fetch(`${API}/v1/instances/${encodeURIComponent(connectingInstanceName)}/qr`, { headers: headers() });
                const qrData = await qrRes.json();
                if (qrData.qr) {
                  qrImage.src = qrData.qr;
                  show(qrContainer, true);
                  statusEl.textContent = 'Escaneie o QR no WhatsApp.';
                  statusEl.className = 'status success';
                  show(statusEl, true);
                }
              } catch (_) {}
            } else if (inst.status === 'connected') {
              show(qrContainer, false);
              statusEl.textContent = 'Conectado.';
              statusEl.className = 'status success';
              show(statusEl, true);
              connectingInstanceName = null;
            } else if (inst.status === 'disconnected') {
              statusEl.textContent = 'Desconectado. Clique em Conectar novamente.';
              statusEl.className = 'status error';
              show(statusEl, true);
            }
          }
        }
      }
    } catch (_) {
      renderSavedList([]);
      renderInstanceList([]);
      updateConnectSelect([]);
    }
  }

  document.getElementById('btnRefreshList').addEventListener('click', refreshInstanceList);
  refreshInstanceList();

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
    addRow('menuOptionsList', '<input type="text" placeholder="Texto da opção" data-field="opt">');
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
      <div class="form-row"><input type="text" placeholder="Corpo/descrição" data-field="body"></div>
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
    document.querySelectorAll('#menuOptionsList .item-row input[data-field="opt"]').forEach((inp) => {
      const v = inp.value.trim();
      if (v) options.push(v);
    });
    return {
      url: '/v1/messages/send_menu',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        title: document.getElementById('menuTitle').value.trim() || 'Menu',
        text: document.getElementById('menuText').value.trim() || 'Escolha uma opção:',
        options: options.length ? options : ['Opção 1'],
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
    const buttons = [];
    document.querySelectorAll('#interactiveList .item-row').forEach((row) => {
      const type = row.querySelector('[data-field="type"]')?.value || 'url';
      const text = row.querySelector('[data-field="text"]')?.value?.trim();
      const extra = row.querySelector('[data-field="extra"]')?.value?.trim();
      if (!text || !extra) return;
      const btn = { type, text };
      if (type === 'url') btn.url = extra;
      else if (type === 'copy') btn.copyCode = extra;
      else if (type === 'call') btn.phoneNumber = extra;
      buttons.push(btn);
    });
    return {
      url: '/v1/messages/send_interactive_helpers',
      body: {
        instance: document.getElementById('dispatchInstance').value,
        to: document.getElementById('dispatchTo').value.trim(),
        text: document.getElementById('interactiveText').value.trim() || 'Confira:',
        footer: document.getElementById('interactiveFooter').value.trim() || undefined,
        buttons,
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
      const body = block.querySelector('[data-field="body"]')?.value?.trim();
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
        body: body || '',
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
        cards: cards.length ? cards : [{ title: 'Card', body: '', buttons: [{ id: 'b1', text: 'Botão' }] }],
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
    if (type === 'interactive' && (!payload.body.buttons || payload.body.buttons.length === 0)) {
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

  const savedKey = localStorage.getItem('rscara_api_key');
  if (savedKey) document.getElementById('apiKey').placeholder = '••••••••';
})();
