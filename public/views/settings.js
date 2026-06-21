/* Fund Autopilot — Settings + Help views. Plain JS, registers via FA.registerView.
   Owns: public/views/settings.js. Never throws; guards missing data. */
(function () {
  'use strict';

  // -- SETTINGS --------------------------------------------------------------
  FA.registerView('settings', {
    label: 'Settings',
    async render(mount, FA) {
      const el = FA.el;

      mount.appendChild(el('h1', { class: 'section-title' }, 'Settings'));
      mount.appendChild(el('p', { class: 'section-help' },
        'Manage your AI connection, working month and your data.'));

      // ---- AI connection card --------------------------------------------
      const aiCard = el('div', { class: 'card card-pad' });
      mount.appendChild(aiCard);
      renderAi(el, aiCard, FA.state.health);

      // Re-fetch health to be current, then repaint this card.
      FA.api('/api/health').then((h) => {
        if (h && !h.error) {
          FA.state.health = { aiConfigured: !!h.aiConfigured, model: h.model || '' };
          renderAi(el, aiCard, FA.state.health);
        }
      });

      // ---- Working month card --------------------------------------------
      const monthCard = el('div', { class: 'card card-pad' });
      mount.appendChild(monthCard);
      await renderMonth(el, monthCard, FA);

      // ---- Accounting setup card (opening date + reporting entity) -------
      const setupCard = el('div', { class: 'card card-pad' });
      mount.appendChild(setupCard);
      await renderAccountingSetup(el, setupCard, FA);

      // ---- Your data card -------------------------------------------------
      const dataCard = el('div', { class: 'card card-pad' });
      mount.appendChild(dataCard);
      dataCard.appendChild(el('div', { class: 'section-title' }, 'Your data'));
      dataCard.appendChild(el('p', { class: 'section-help' },
        'Everything you load stays on this computer. All documents, entries, bank data and reports live locally in data/autopilot.json — nothing is sent anywhere except to the AI reader you connected.'));

      const startOver = el('button', {
        class: 'btn btn-ghost',
        style: { color: '#c0392b', borderColor: '#e3b4ae', marginTop: '14px' },
        onclick: async () => {
          const ok = await FA.confirmAction(
            'This wipes all loaded documents, entries, bank data and reports so you can begin again. This cannot be undone.');
          if (!ok) return;
          startOver.disabled = true;
          startOver.textContent = 'Clearing…';
          const r = await FA.api('/api/reset', { method: 'POST' });
          if (r && r.error) {
            startOver.disabled = false;
            startOver.textContent = 'Start over';
            FA.toast(r.error, 'error');
            return;
          }
          location.reload();
        },
      }, 'Start over');
      dataCard.appendChild(startOver);
    },
  });

  function renderAi(el, card, health) {
    card.innerHTML = '';
    health = health || { aiConfigured: false, model: '' };
    card.appendChild(el('div', { class: 'section-title' }, 'AI connection'));

    if (health.aiConfigured) {
      const row = el('div', { class: 'row', style: { gap: '12px', alignItems: 'center', marginTop: '10px' } },
        el('span', { class: 'pill pill-ok' }, 'AI reader connected'));
      if (health.model) row.appendChild(el('span', { class: 'muted' }, health.model));
      card.appendChild(row);
      card.appendChild(el('p', { class: 'section-help', style: { marginTop: '12px' } },
        'Documents are read live. When you upload a statement or invoice, the AI reader extracts the figures for you to approve.'));
    } else {
      card.appendChild(el('div', { class: 'row', style: { marginTop: '10px' } },
        el('span', { class: 'pill pill-missing' }, 'Not connected')));
      card.appendChild(el('p', { class: 'section-help', style: { marginTop: '12px' } },
        'To switch on the AI reader:'));
      const list = el('ol', { class: 'section-help', style: { margin: '6px 0 0 18px', lineHeight: '1.7' } },
        el('li', null, 'Open the .env file in the app folder.'),
        el('li', null, el('span', null, 'Set ',
          el('code', null, 'ANTHROPIC_API_KEY=…'), ' with your key.')),
        el('li', null, 'Save the file, then restart the app.'));
      card.appendChild(list);
    }
  }

  async function renderMonth(el, card, FA) {
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'section-title' }, 'Working month'));

    const r = await FA.api('/api/periods');
    let current = null;
    let suggested = '';
    if (r && !r.error) {
      current = r.current || null;
      suggested = (r.suggested && String(r.suggested)) || '';
    }

    card.appendChild(el('p', { class: 'section-help', style: { marginTop: '8px' } },
      current
        ? el('span', null, 'You are currently working in ',
            el('strong', null, FA.monthLabel(current)), '.')
        : 'No working month is set yet. Start one below to begin booking entries for a month.'));

    const input = el('input', {
      class: 'input',
      type: 'month',
      value: suggested || current || '',
      style: { maxWidth: '200px' },
    });

    const startBtn = el('button', { class: 'btn btn-primary' }, 'Start new month');
    startBtn.addEventListener('click', async () => {
      const period = (input.value || '').trim();
      if (!/^\d{4}-\d{2}$/.test(period)) {
        FA.toast('Please pick a valid month.', 'warn');
        return;
      }
      startBtn.disabled = true;
      startBtn.textContent = 'Starting…';
      const res = await FA.api('/api/period', { json: { period } });
      startBtn.disabled = false;
      startBtn.textContent = 'Start new month';
      if (res && res.error) { FA.toast(res.error, 'error'); return; }
      FA.toast('Started ' + FA.monthLabel(period) + '.', 'success');
      if (typeof FA.setPeriod === 'function') FA.setPeriod(period);
      if (typeof FA.refreshChrome === 'function') FA.refreshChrome();
    });

    card.appendChild(el('div', {
      class: 'row',
      style: { gap: '10px', alignItems: 'center', marginTop: '14px' },
    }, input, startBtn));
    card.appendChild(el('p', { class: 'section-help', style: { marginTop: '10px' } },
      'Starting a new month makes it your working month and the figures you see across the app.'));
  }

  async function renderAccountingSetup(el, card, FA) {
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'section-title' }, 'Accounting setup'));

    const s = await FA.api('/api/settings');
    const settings = s && !s.error ? s : {};
    const resolved = settings.booksOpeningDate || '';
    const explicit = settings.booksOpeningDateExplicit || '';
    const entity = settings.reportingEntity || '';

    // Reporting entity (read-only — set via deployment config).
    card.appendChild(el('p', { class: 'section-help', style: { marginTop: '8px' } },
      entity
        ? el('span', null, 'Books are kept for ', el('strong', null, entity),
            '. Document direction (a purchase vs a sale) is read from this entity’s point of view.')
        : 'No reporting entity is configured. Set REPORTING_ENTITY so the AI knows whose books these are when deciding a buy vs a sale.'));

    // Opening date.
    card.appendChild(el('div', { class: 'section-title', style: { fontSize: '15px', marginTop: '18px' } },
      'Books opening date'));
    card.appendChild(el('p', { class: 'section-help', style: { marginTop: '6px' } },
      el('span', null,
        'The date your opening balances are as at. Any document dated on or before it is treated as ',
        el('strong', null, 'already included in the opening balance'),
        ' and filed as supporting evidence — it is not booked again. This lets you safely upload a folder that mixes old and current documents.')));

    const input = el('input', {
      class: 'input', type: 'date', value: resolved || '', style: { maxWidth: '200px' },
    });
    const saveBtn = el('button', { class: 'btn btn-primary' }, 'Save opening date');
    const clearBtn = el('button', { class: 'btn btn-ghost' }, 'Clear');

    saveBtn.addEventListener('click', async () => {
      const date = (input.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { FA.toast('Please pick a valid date.', 'warn'); return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      const res = await FA.api('/api/settings', { json: { booksOpeningDate: date } });
      saveBtn.disabled = false; saveBtn.textContent = 'Save opening date';
      if (res && res.error) { FA.toast(res.error, 'error'); return; }
      FA.toast('Opening date set to ' + date + '.', 'success');
      renderAccountingSetup(el, card, FA);
    });
    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true;
      const res = await FA.api('/api/settings', { json: { booksOpeningDate: null } });
      clearBtn.disabled = false;
      if (res && res.error) { FA.toast(res.error, 'error'); return; }
      FA.toast('Opening date cleared.', 'success');
      renderAccountingSetup(el, card, FA);
    });

    card.appendChild(el('div', { class: 'row', style: { gap: '10px', alignItems: 'center', marginTop: '14px' } },
      input, saveBtn, resolved ? clearBtn : null));
    if (resolved && !explicit) {
      card.appendChild(el('p', { class: 'section-help', style: { marginTop: '10px' } },
        'This date was derived automatically from your opening balance. Set it explicitly above if your books start on a different date.'));
    }
  }

  // -- HELP ------------------------------------------------------------------
  FA.registerView('help', {
    label: 'Help & support',
    render(mount, FA) {
      const el = FA.el;

      mount.appendChild(el('h1', { class: 'section-title' }, 'Help & support'));
      mount.appendChild(el('p', { class: 'section-help' },
        'A quick guide to how Fund Autopilot works and how to stay in control.'));

      const card = el('div', { class: 'card card-pad' });
      mount.appendChild(card);

      const faq = [
        ['How it works',
          'You upload your documents — bank statements, invoices, contracts. The AI reads them and lays out what it found. You check each entry and approve it. Once approved, Autopilot books it to the ledger and keeps your reports up to date.'],
        ['Are the numbers safe?',
          'Yes. The AI only reads your documents — it never invents figures. The engine calculates every number from what you approve, and nothing is booked until you say so. You are always the final check.'],
        ['Where is my data kept?',
          'Everything stays on this computer, in a local file (data/autopilot.json). Your documents and figures are only shared with the AI reader you connected — nowhere else.'],
        ['How do I start over?',
          'Open Settings and use the "Start over" button under Your data. That clears all loaded documents, entries, bank data and reports so you can begin fresh. It cannot be undone.'],
      ];

      faq.forEach((qa, i) => {
        const block = el('div', { style: i ? { marginTop: '18px' } : null },
          el('div', { class: 'section-title', style: { fontSize: '16px', marginBottom: '4px' } }, qa[0]),
          el('p', { class: 'muted', style: { lineHeight: '1.7' } }, qa[1]));
        card.appendChild(block);
      });

      card.appendChild(el('p', { class: 'section-help', style: { marginTop: '20px' } },
        'Still stuck? Reach out to your A4 contact and we will help you get unblocked.'));
    },
  });
})();
