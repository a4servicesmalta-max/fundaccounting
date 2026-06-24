/* Fund Autopilot — Audit Requests view. Plain JS, registers via FA.registerView.
   Drop an auditor request (pasted email + any files / Excel sheets); the app gathers
   the matching evidence and packages it for download. Never throws; guards missing data. */
(function () {
  'use strict';

  FA.registerView('audit-requests', {
    label: 'Audit requests',
    async render(mount, FA) {
      var el = FA.el;

      mount.appendChild(el('h1', { class: 'section-title' }, 'Audit requests'));
      mount.appendChild(el('p', { class: 'section-help' },
        'Drop an auditor request in any form — a pasted email, an Excel request sheet, or a bundle of files. '
        + 'Autopilot gathers the matching evidence and packages it for download. '
        + 'Answering an Excel request sheet from the evidence switches on when the AI reader is connected.'));

      // ---- New request -----------------------------------------------------
      var card = el('div', { class: 'card card-pad' });
      mount.appendChild(card);
      card.appendChild(el('div', { class: 'section-title' }, 'New request'));

      var titleInput = el('input', { class: 'input', placeholder: 'Title (e.g. Q1 2025 PBC list)', style: { maxWidth: '380px', marginTop: '10px' } });
      var emailTa = el('textarea', { class: 'input', rows: '4',
        placeholder: 'Paste the auditor email / request text here…',
        style: { width: '100%', marginTop: '10px', fontFamily: 'inherit', resize: 'vertical' } });
      var fileIn = el('input', { type: 'file', multiple: true, class: 'input', style: { marginTop: '10px' } });
      var submit = el('button', { class: 'btn btn-primary', style: { marginTop: '12px' } }, 'Prepare evidence');

      card.appendChild(el('div', null, titleInput));
      card.appendChild(emailTa);
      card.appendChild(el('div', { class: 'section-help', style: { marginTop: '10px', marginBottom: '4px' } }, 'Attach the request sheet(s) and any other files (optional):'));
      card.appendChild(fileIn);
      card.appendChild(el('div', null, submit));

      var listWrap = el('div', { style: { marginTop: '22px' } });
      mount.appendChild(listWrap);

      submit.addEventListener('click', async function () {
        var files = fileIn.files || [];
        if (!(titleInput.value || '').trim() && !(emailTa.value || '').trim() && !files.length) {
          FA.toast('Add a title, some request text, or a file.', 'warn');
          return;
        }
        var fd = new FormData();
        fd.append('title', titleInput.value || '');
        fd.append('emailText', emailTa.value || '');
        for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
        submit.disabled = true; submit.textContent = 'Preparing…';
        try {
          var resp = await fetch('/api/audit-requests', { method: 'POST', body: fd });
          var j = await resp.json();
          if (j && j.error) { FA.toast(j.error, 'error'); }
          else {
            FA.toast('Request prepared — evidence gathered.', 'success');
            titleInput.value = ''; emailTa.value = ''; fileIn.value = '';
            await loadList();
          }
        } catch (e) {
          FA.toast('Could not prepare the request.', 'error');
        }
        submit.disabled = false; submit.textContent = 'Prepare evidence';
      });

      // ---- Existing requests ----------------------------------------------
      async function loadList() {
        listWrap.innerHTML = '';
        var data = await FA.api('/api/audit-requests');
        var requests = (data && !data.error && Array.isArray(data.requests)) ? data.requests : [];
        if (!requests.length) {
          listWrap.appendChild(el('p', { class: 'section-help' }, 'No requests yet. Prepare one above.'));
          return;
        }
        listWrap.appendChild(el('div', { class: 'section-title', style: { fontSize: '16px' } }, 'Prepared requests'));
        requests.forEach(function (q) {
          var meta = (q.attachments || 0) + ' file' + (q.attachments === 1 ? '' : 's')
            + ' · ' + (q.sheets || 0) + ' sheet' + (q.sheets === 1 ? '' : 's')
            + ' · ' + (q.evidenceCount || 0) + ' evidence item' + (q.evidenceCount === 1 ? '' : 's');
          var dlBtn = el('a', { class: 'btn btn-dark btn-sm',
            href: '/api/audit-requests/' + q.id + '/pack.zip', target: '_blank', rel: 'noopener',
            title: 'Download a ZIP of the gathered evidence, with a manifest' }, 'Download evidence pack');
          var actions = el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, dlBtn);
          var answersWrap = el('div', { style: { marginTop: '10px' } });

          if ((q.sheets || 0) > 0) {
            var ansBtn = el('button', { class: 'btn btn-secondary btn-sm',
              title: 'Match the request sheet against the gathered evidence and fill in the answers' }, 'Answer the sheet');
            ansBtn.addEventListener('click', async function () {
              ansBtn.disabled = true; ansBtn.textContent = 'Answering…';
              try {
                var resp = await fetch('/api/audit-requests/' + q.id + '/answer', { method: 'POST' });
                var j = await resp.json();
                if (j && j.error) { FA.toast(j.error, 'error'); }
                else {
                  FA.toast('Answered ' + (j.answered || 0) + ' item(s); ' + (j.needsReview || 0) + ' need review.', 'success');
                  await renderAnswers(q.id, answersWrap);
                }
              } catch (e) { FA.toast('Could not answer the sheet.', 'error'); }
              ansBtn.disabled = false; ansBtn.textContent = 'Answer the sheet';
            });
            actions.appendChild(ansBtn);
          }

          var rc = el('div', { class: 'card card-pad', style: { marginTop: '12px' } },
            el('div', { class: 'spread', style: { alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
              el('div', null,
                el('div', { style: { fontWeight: '600' } }, q.title || 'Audit request'),
                el('div', { class: 'muted', style: { fontSize: '13px', marginTop: '2px' } }, meta)),
              actions),
            answersWrap);
          listWrap.appendChild(rc);
          renderAnswers(q.id, answersWrap); // show any sheets already answered
        });
      }

      // Render download links for a request's answered sheets (if any).
      async function renderAnswers(id, wrap) {
        wrap.innerHTML = '';
        var d = await FA.api('/api/audit-requests/' + id);
        var sheets = (d && d.request && Array.isArray(d.request.answeredSheets)) ? d.request.answeredSheets : [];
        if (!sheets.length) return;
        wrap.appendChild(el('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '4px' } }, 'Answered sheets:'));
        sheets.forEach(function (s) {
          wrap.appendChild(el('div', { style: { marginTop: '2px' } },
            el('a', { class: 'btn btn-ghost btn-sm',
              href: '/api/audit-requests/' + id + '/answer/' + s.attachmentId, target: '_blank', rel: 'noopener' },
              '⤓ ' + (s.fileName || 'answered sheet'))));
        });
      }

      await loadList();
    },
  });
})();
