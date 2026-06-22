/* documents.js — "Documents" screen.
   Upload (drag/drop + Choose files + Choose a folder + .zip) and a list of
   everything we've read, with a plain-language summary after each upload.

   Upload logic is ported from public_legacy/app.js (the proven dropzone:
   directory-walking drop, folder input, files[] multipart POST /api/upload,
   busy spinner, and the friendly result summary), re-skinned to the new
   FA design-system classes and adapted to FA.api (which returns parsed JSON
   directly, or {error} on failure). */
(function () {
  'use strict';
  if (!window.FA || typeof FA.registerView !== 'function') return;

  // ---- classification → friendly badge -------------------------------------
  function classMeta(c) {
    switch (String(c || '').toUpperCase()) {
      case 'EVENT':     return { cls: 'badge lime',  label: 'Transaction' };
      case 'BANK':      return { cls: 'badge blue',  label: 'Bank statement' };
      case 'ARAP':      return { cls: 'badge blue',  label: 'Invoice / Bill' };
      case 'DUPLICATE': return { cls: 'badge warn',  label: 'Duplicate' };
      case 'EVIDENCE':  return { cls: 'badge muted', label: 'Supporting' };
      case 'ERROR':     return { cls: 'badge warn',  label: "Couldn't read" };
      case 'UNKNOWN':
      default:         return { cls: 'badge warn',  label: 'Needs a look' };
    }
  }

  // ---- gather files from a drop, walking folders where the browser allows ---
  async function collectDroppedFiles(dt) {
    try {
      const items = dt && dt.items ? Array.from(dt.items) : [];
      const entries = items
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
      if (entries.length) {
        const out = [];
        await Promise.all(entries.map((entry) => walkEntry(entry, out)));
        if (out.length) return out;
      }
    } catch (_) { /* fall through to flat list */ }
    return dt && dt.files ? Array.from(dt.files) : [];
  }

  function walkEntry(entry, out, prefix) {
    prefix = prefix || '';
    return new Promise((resolve) => {
      if (!entry) return resolve();
      if (entry.isFile) {
        entry.file((file) => {
          try { file._relPath = prefix + file.name; } catch (_) {}
          out.push(file);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries(async (batch) => {
            if (!batch || !batch.length) return resolve();
            await Promise.all(batch.map((e) => walkEntry(e, out, prefix + entry.name + '/')));
            readBatch(); // directories may need multiple reads
          }, () => resolve());
        };
        readBatch();
      } else {
        resolve();
      }
    });
  }

  // ---- plain-language upload summary (from the /api/upload response) --------
  function summaryNode(FA, data) {
    data = data || {};
    const events   = Array.isArray(data.events)   ? data.events   : [];
    const evidence = Array.isArray(data.evidence) ? data.evidence : [];
    const bank     = Array.isArray(data.bank)     ? data.bank     : [];
    const arap     = Array.isArray(data.arap)     ? data.arap     : [];
    const duplicates = Array.isArray(data.duplicates) ? data.duplicates : [];
    const unknown  = Array.isArray(data.unknown)  ? data.unknown  : [];
    const errors   = Array.isArray(data.errors)   ? data.errors   : [];
    const processed = Number(data.processed) ||
      (events.length + evidence.length + bank.length + arap.length + duplicates.length + unknown.length + errors.length);
    const attention = unknown.length + errors.length;
    const bankTxns = bank.reduce((s, o) => s + (Number(o && o.added) || 0), 0);

    const detail = [];
    detail.push(`${events.length} transaction${events.length === 1 ? '' : 's'} found`);
    if (bank.length) detail.push(`${bank.length} bank statement${bank.length === 1 ? '' : 's'} read`);
    if (arap.length) detail.push(`${arap.length} invoice${arap.length === 1 ? '' : 's'}/bill${arap.length === 1 ? '' : 's'} filed to Debtors & Creditors`);
    if (duplicates.length) detail.push(`${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'} skipped`);
    if (evidence.length) detail.push(`${evidence.length} supporting file${evidence.length === 1 ? '' : 's'} filed`);
    if (attention) detail.push(`${attention} need${attention === 1 ? 's' : ''} your attention`);

    const headline = `Read ${processed} document${processed === 1 ? '' : 's'} — ${detail.join(', ')}.`;

    const children = [
      FA.el('div', { class: 'section-title', style: { fontSize: '17px', margin: '0 0 4px' } }, headline),
    ];

    // Friendly nudge toward Review when there are transactions to approve.
    if (events.length) {
      children.push(FA.el('div', { class: 'muted', style: { marginBottom: '10px' } },
        'They’re drafted and waiting for you on the ',
        FA.el('a', {
          href: '#', class: 'link',
          onclick: (e) => { e.preventDefault(); FA.navigate('review'); },
        }, 'Review'),
        ' screen.'));
    }

    // Nudge toward the Bank screen when statements were imported.
    if (bank.length) {
      children.push(FA.el('div', { class: 'muted', style: { marginBottom: '10px' } },
        bankTxns
          ? `We pulled ${bankTxns} transaction${bankTxns === 1 ? '' : 's'} into the `
          : 'Your statement is on the ',
        FA.el('a', {
          href: '#', class: 'link',
          onclick: (e) => { e.preventDefault(); FA.navigate('bank'); },
        }, 'Bank statements'),
        ' screen — review where each one posts, then approve.'));
    }

    // If anything needs attention, list the filenames helpfully.
    const flagged = [].concat(unknown, errors)
      .map((o) => (o && (o.fileName || o.file || o.name)) || null)
      .filter(Boolean);
    if (flagged.length) {
      const ul = FA.el('ul', { class: 'muted', style: { margin: '6px 0 0', paddingLeft: '18px' } });
      flagged.slice(0, 12).forEach((name) => ul.appendChild(FA.el('li', null, name)));
      if (flagged.length > 12) ul.appendChild(FA.el('li', null, `…and ${flagged.length - 12} more`));
      children.push(FA.el('div', null,
        FA.el('div', { class: 'muted', style: { margin: '4px 0 2px' } },
          'We weren’t sure what to do with these — they’re saved, but you may want to check them:'),
        ul));
    }

    return FA.el('div', { class: 'banner', style: { marginTop: '18px' } }, children);
  }

  // ---- view -----------------------------------------------------------------
  FA.registerView('documents', {
    label: 'Documents',
    async render(mount, FA) {
      try {
        const el = FA.el;

        // Header.
        mount.appendChild(el('div', { style: { maxWidth: '880px' } },
          el('h1', { class: 'section-title' }, 'Documents'),
          el('p', { class: 'section-help', style: { maxWidth: '620px' } },
            'Bank statements, share purchase agreements, loan papers, dividend resolutions, invoices — drop them all in. We’ll read each one and draft the bookkeeping for you.')));

        // --- Upload zone ------------------------------------------------------
        const fileInput = el('input', {
          type: 'file', multiple: true, style: { display: 'none' },
          accept: '.pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.xls,.xlsx,.zip,image/*',
        });
        const folderInput = el('input', {
          type: 'file', multiple: true, style: { display: 'none' },
        });
        // webkitdirectory must be set as an attribute for folder selection.
        try {
          folderInput.setAttribute('webkitdirectory', '');
          folderInput.setAttribute('directory', '');
        } catch (_) {}

        const spinner = el('span', { class: 'spinner', style: { display: 'none' } });
        const busyText = el('span', null, '');
        const busyRow = el('div', {
          class: 'row', style: { display: 'none', gap: '10px', justifyContent: 'center', marginTop: '14px' },
        }, spinner, busyText);

        const summarySlot = el('div', null);

        const chooseFilesBtn = el('button', {
          type: 'button', class: 'btn btn-dark',
          onclick: (e) => { e.stopPropagation(); fileInput.click(); },
        }, 'Choose files');
        const chooseFolderBtn = el('button', {
          type: 'button', class: 'btn btn-ghost',
          onclick: (e) => { e.stopPropagation(); folderInput.click(); },
        }, 'Choose a folder');

        const dz = el('div', {
          class: 'dropzone', tabindex: '0', role: 'button',
          onclick: () => fileInput.click(),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
          },
        },
          el('div', {
            style: {
              width: '72px', height: '72px', borderRadius: '9999px', background: '#fff',
              border: '1px solid var(--hairline-light)', margin: '0 auto 20px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--primary)',
            },
            html: FA.icon('upload'),
          }),
          el('div', { class: 'section-title', style: { fontSize: '20px', margin: '0 0 6px' } },
            'Drop your documents here, or click to choose'),
          el('p', { class: 'section-help', style: { margin: '0 auto 22px', maxWidth: '460px' } },
            'PDF, images, CSV, Excel and .zip files all welcome. You can drop many at once.'),
          el('div', { class: 'row', style: { gap: '12px', justifyContent: 'center' } },
            chooseFilesBtn, chooseFolderBtn),
          busyRow);

        // Busy toggle.
        let busy = false;
        function setBusy(on, text) {
          busy = on;
          spinner.style.display = on ? '' : 'none';
          busyRow.style.display = on ? '' : 'none';
          busyText.textContent = text || '';
          dz.style.pointerEvents = on ? 'none' : '';
          dz.style.opacity = on ? '0.6' : '';
          chooseFilesBtn.disabled = on;
          chooseFolderBtn.disabled = on;
        }

        // The actual upload (files[] multipart → POST /api/upload).
        async function uploadFiles(files) {
          if (!files || !files.length || busy) return;
          summarySlot.innerHTML = '';

          const form = new FormData();
          for (const f of files) {
            // Server reads the field name `files`; keep the relative path as the
            // filename so dropped/selected folders keep their structure.
            form.append('files', f, (f._relPath || f.webkitRelativePath || f.name));
          }

          const n = files.length;
          setBusy(true, n === 1 ? 'Reading your document…' : `Reading your ${n} documents…`);
          // Bank statements are transcribed line-by-line and can take a minute.
          const slowHint = setTimeout(() => {
            if (busy) busyText.textContent = 'Still reading… bank statements with lots of lines can take a minute.';
          }, 8000);

          const r = await FA.api('/api/upload', { method: 'POST', body: form });
          clearTimeout(slowHint);
          setBusy(false);

          if (!r || r.error) {
            summarySlot.appendChild(el('div', { class: 'banner banner-warn', style: { marginTop: '18px' } },
              (r && r.error) || 'Something went wrong reading those. Please try again.'));
            return;
          }

          summarySlot.appendChild(summaryNode(FA, r));

          // Pop a notification pointing at whatever now needs review.
          const bankTxns = (Array.isArray(r.bank) ? r.bank : []).reduce((s, o) => s + (Number(o && o.added) || 0), 0);
          const draftCount = (Array.isArray(r.events) ? r.events : []).length;
          if (bankTxns) FA.toast(bankTxns + ' transaction' + (bankTxns === 1 ? '' : 's') + ' imported — waiting for review in Bank statements.', '');
          else if (draftCount) FA.toast(draftCount + ' transaction' + (draftCount === 1 ? '' : 's') + ' drafted — waiting in Review.', '');
          else FA.toast('Documents read.', 'success');

          // New drafts / books / period may exist now — refresh list + chrome.
          try { await loadList(); } catch (_) {}
          try { FA.refreshChrome(); } catch (_) {}
        }

        // Wire inputs.
        fileInput.addEventListener('change', () => {
          if (fileInput.files && fileInput.files.length) uploadFiles(Array.from(fileInput.files));
          fileInput.value = '';
        });
        folderInput.addEventListener('change', () => {
          if (folderInput.files && folderInput.files.length) uploadFiles(Array.from(folderInput.files));
          folderInput.value = '';
        });

        // Drag/drop.
        ['dragenter', 'dragover'].forEach((ev) =>
          dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); if (!busy) dz.classList.add('drag'); }));
        ['dragleave', 'dragend'].forEach((ev) =>
          dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag'); }));
        dz.addEventListener('drop', async (e) => {
          e.preventDefault(); e.stopPropagation();
          dz.classList.remove('drag');
          if (busy) return;
          const files = await collectDroppedFiles(e.dataTransfer);
          if (files.length) uploadFiles(files);
          else {
            summarySlot.innerHTML = '';
            summarySlot.appendChild(el('div', { class: 'banner banner-warn', style: { marginTop: '18px' } },
              "We couldn't find any files in what you dropped. Try the 'Choose files' button instead."));
          }
        });

        // Doc-upload header band (visual) above the dropzone.
        const uploadHeader = el('div', {
          class: 'spread',
          style: {
            alignItems: 'center', gap: '12px', padding: '14px 18px',
            background: 'linear-gradient(90deg, rgba(73,79,223,.08), rgba(199,239,62,.10))',
            border: '1px solid var(--hairline-light)', borderRadius: '16px 16px 0 0', borderBottom: '0',
          },
        },
          el('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
            el('span', {
              style: {
                width: '30px', height: '30px', borderRadius: '9999px', background: 'var(--primary)',
                color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }, html: FA.icon('upload'),
            }),
            el('div', null,
              el('div', { style: { fontWeight: '600', fontFamily: 'var(--font-display)' } }, 'Upload documents'),
              el('div', { class: 'muted', style: { fontSize: '12px' } }, 'Statements · agreements · invoices · resolutions'))),
          el('div', { class: 'row', style: { gap: '6px' } },
            ['PDF', 'Word', 'Image', 'CSV', 'Excel', 'ZIP'].map(function (t) {
              return el('span', { class: 'badge muted', style: { fontSize: '11px' } }, t);
            })));
        const uploadCard = el('div', {
          style: { margin: '20px 0 0', border: '1px solid var(--hairline-light)', borderRadius: '0 0 16px 16px', borderTop: '0' },
        }, dz);
        mount.appendChild(el('div', null, uploadHeader, uploadCard, fileInput, folderInput, summarySlot));

        // --- Document list + organise toolbar ---------------------------------
        const org = { q: '', type: 'all', group: 'none', sort: 'newest' };
        let allDocs = [];

        const listHead = el('div', { class: 'spread', style: { margin: '30px 0 12px' } },
          el('h2', { class: 'section-title', style: { fontSize: '17px', margin: '0' } }, 'Documents'),
          el('span', { class: 'muted', id: 'docCount' }, ''));

        // Type filter chips.
        const TYPES = [
          ['all', 'All'], ['EVENT', 'Transactions'], ['BANK', 'Bank'], ['ARAP', 'Invoices & bills'],
          ['EVIDENCE', 'Supporting'], ['NEEDS', 'Needs a look'],
        ];
        const chipRow = el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
        TYPES.forEach(([key, label]) => {
          const chip = el('button', {
            class: 'btn btn-sm ' + (org.type === key ? 'btn-primary' : 'btn-ghost'),
            'data-type': key,
            onclick: () => { org.type = key; chipRow.querySelectorAll('button').forEach((b) => { b.className = 'btn btn-sm ' + (b.getAttribute('data-type') === key ? 'btn-primary' : 'btn-ghost'); }); paint(); },
          }, label);
          chipRow.appendChild(chip);
        });

        const search = el('input', {
          class: 'input', type: 'search', placeholder: 'Search documents…',
          style: { maxWidth: '240px' },
          oninput: (e) => { org.q = (e.target.value || '').toLowerCase(); paint(); },
        });
        const groupSel = el('select', { class: 'input', style: { maxWidth: '170px' },
          onchange: (e) => { org.group = e.target.value; paint(); } },
          el('option', { value: 'none' }, 'Group: none'),
          el('option', { value: 'type' }, 'Group: by type'),
          el('option', { value: 'investee' }, 'Group: by company'),
          el('option', { value: 'folder' }, 'Group: by folder'));
        const sortSel = el('select', { class: 'input', style: { maxWidth: '150px' },
          onchange: (e) => { org.sort = e.target.value; paint(); } },
          el('option', { value: 'newest' }, 'Newest first'),
          el('option', { value: 'name' }, 'Name (A–Z)'));

        const toolbar = el('div', {
          class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap', margin: '0 0 14px' },
        }, search, groupSel, sortSel);

        const listBody = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
        mount.appendChild(el('div', null, listHead, chipRow, toolbar, listBody));

        // --- Filter / sort / group + render -----------------------------------
        function classGroup(cls) {
          if (cls === 'EVENT') return 'Transactions';
          if (cls === 'BANK') return 'Bank statements';
          if (cls === 'ARAP') return 'Invoices & bills';
          if (cls === 'EVIDENCE') return 'Supporting documents';
          if (cls === 'DUPLICATE') return 'Duplicates';
          return 'Needs a look';
        }
        function matchesType(cls) {
          if (org.type === 'all') return true;
          if (org.type === 'NEEDS') return cls === 'UNKNOWN' || cls === 'ERROR' || cls === 'DUPLICATE';
          return cls === org.type;
        }
        function paint() {
          const countNode = document.getElementById('docCount');
          listBody.innerHTML = '';
          let docs = allDocs.filter((d) => {
            const cls = String((d && d.classification) || '').toUpperCase();
            if (!matchesType(cls)) return false;
            if (org.q) {
              const hay = [d.fileName, d.note, d.relatedInvestee, d.folderPath, classGroup(cls)].join(' ').toLowerCase();
              if (!hay.includes(org.q)) return false;
            }
            return true;
          });
          docs.sort((a, b) => org.sort === 'name'
            ? String((a && a.fileName) || '').localeCompare(String((b && b.fileName) || ''))
            : String((b && b.createdAt) || '').localeCompare(String((a && a.createdAt) || '')));

          if (countNode) countNode.textContent = docs.length
            ? docs.length + ' of ' + allDocs.length + ' document' + (allDocs.length === 1 ? '' : 's')
            : (allDocs.length ? '0 of ' + allDocs.length : '');

          if (!docs.length) {
            listBody.appendChild(el('div', { class: 'empty' },
              allDocs.length ? 'No documents match this view.' : 'No documents yet — drop some above to get started.'));
            return;
          }

          if (org.group === 'none') {
            docs.forEach((d) => listBody.appendChild(docRow(d)));
            return;
          }
          // Group into buckets.
          const keyOf = (d) => {
            const cls = String((d && d.classification) || '').toUpperCase();
            if (org.group === 'type') return classGroup(cls);
            if (org.group === 'investee') return d.relatedInvestee || '— Not linked to a company';
            return (d.folderPath && String(d.folderPath).trim()) || '— No folder';
          };
          const groups = new Map();
          docs.forEach((d) => { const k = keyOf(d); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
          [...groups.keys()].sort((a, b) => a.localeCompare(b)).forEach((k) => {
            listBody.appendChild(el('div', {
              class: 'muted', style: { fontWeight: '600', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', margin: '10px 0 2px' },
            }, k + ' · ' + groups.get(k).length));
            groups.get(k).forEach((d) => listBody.appendChild(docRow(d)));
          });
        }

        function docRow(d) {
          d = d || {};
          const meta = classMeta(d.classification);
          const cls = String(d.classification || '').toUpperCase();
          // Show the friendly reason for a duplicate; for a read error show a plain
          // message (never the raw technical note); otherwise the folder + label.
          const sub = cls === 'DUPLICATE' && d.note
            ? d.note
            : cls === 'ERROR'
              ? 'We couldn’t read this one — please try uploading it again.'
              : (cls === 'EVIDENCE' && d.relatedInvestee && d.note)
                ? d.note // "Ownership evidence for <investee> — supporting document, not posted."
                : (cls === 'UNKNOWN' && d.note)
                  ? d.note // e.g. "The AI reader is out of API credits…" — an honest reason, not a vague "needs a look".
                  : [d.folderPath, meta.label].filter(Boolean).join(' · ');
          const right = [el('span', { class: meta.cls }, meta.label)];
          // A supporting document linked to a holding shows the investee it evidences.
          if (cls === 'EVIDENCE' && d.relatedInvestee) {
            right.unshift(el('span', { class: 'badge blue', title: 'Ownership evidence for ' + d.relatedInvestee },
              '↳ ' + d.relatedInvestee));
          }
          if (d.storedPath && d.id != null) {
            right.push(el('a', {
              class: 'btn btn-ghost btn-sm',
              href: '/api/documents/' + encodeURIComponent(d.id) + '/file',
              target: '_blank', rel: 'noopener',
            }, 'Open'));
          }
          const mainRow = el('div', {
            class: 'row',
            style: {
              gap: '14px', padding: '14px 16px', alignItems: 'center',
              border: '1px solid var(--hairline-light)', borderRadius: '14px',
            },
          },
            el('div', {
              class: 'doc-ico',
              style: {
                width: '38px', height: '38px', borderRadius: '10px', flex: 'none',
                background: 'var(--surface-soft)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', color: 'var(--mute)',
              },
              html: FA.icon('documents'),
            }),
            el('div', { style: { flex: '1', minWidth: '0' } },
              el('div', { style: { fontWeight: '600', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                d.fileName || '(document)'),
              el('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } },
                sub || (d.createdAt ? FA.fmtDate(d.createdAt) : '—'))),
            el('div', { class: 'row', style: { gap: '10px', flex: 'none', alignItems: 'center' } }, right));

          // For a document the portal couldn't confidently place (or one filed as
          // generic supporting), offer clear actions: what should we do with it?
          const needsDecision = cls === 'UNKNOWN' || cls === 'ERROR' || cls === 'EVIDENCE';
          if (!needsDecision) return mainRow;

          const CHOICES = [
            { action: 'bank', label: 'It’s a bank statement' },
            { action: 'invoice', label: 'It’s an invoice / bill' },
            { action: 'journal', label: 'Suggest a journal entry' },
            { action: 'supporting', label: 'Keep as supporting (no entry)' },
          ];
          const actionsBar = el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', padding: '0 16px 4px' } },
            el('span', { class: 'muted', style: { fontSize: '11.5px', letterSpacing: '.3px', textTransform: 'uppercase', fontWeight: '600', marginRight: '4px' } },
              'What should we do with this?'));
          CHOICES.forEach(function (c) {
            const btn = el('button', { class: 'btn btn-ghost btn-sm', style: { fontSize: '12px' } }, c.label);
            btn.addEventListener('click', async function () {
              actionsBar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
              btn.textContent = 'Working…';
              const rr = await FA.api('/api/documents/' + encodeURIComponent(d.id) + '/reclassify', { json: { action: c.action } });
              if (rr && rr.error) { FA.toast(rr.error, 'error'); actionsBar.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); btn.textContent = c.label; return; }
              const k = rr && rr.outcome && rr.outcome.kind;
              FA.toast(k === 'BANK' ? 'Imported as a bank statement.' : k === 'ARAP' ? 'Filed to Debtors & Creditors.' : k === 'EVENT' ? 'Drafted for review.' : k === 'EVIDENCE' ? 'Filed as supporting.' : (rr.outcome && rr.outcome.message) || 'Done.',
                k === 'ERROR' ? 'error' : 'success');
              FA.refreshChrome();
              loadList();
            });
            actionsBar.appendChild(btn);
          });
          return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, mainRow, actionsBar);
        }

        async function loadList() {
          const r = await FA.api('/api/documents');
          if (r && r.error) {
            allDocs = [];
            listBody.innerHTML = '';
            document.getElementById('docCount').textContent = '';
            listBody.appendChild(el('div', { class: 'empty' },
              'We couldn’t load your documents just now. Please refresh and try again.'));
            return;
          }
          if (Array.isArray(r)) allDocs = r;
          else if (r && Array.isArray(r.documents)) allDocs = r.documents;
          else if (r && Array.isArray(r.docs)) allDocs = r.docs;
          else allDocs = [];
          paint();
        }

        await loadList();
      } catch (e) {
        // Never throw — show a friendly fallback.
        try {
          mount.appendChild(FA.el('div', { class: 'empty' },
            'Something went wrong loading this screen.'));
        } catch (_) {}
      }
    },
  });
})();
