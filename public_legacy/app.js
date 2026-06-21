/* ===========================================================
   Fund Autopilot — frontend logic (vanilla JS).
   Talks to the API documented in CONTRACT.md §9.
   Designed to be resilient: every fetch is guarded, every
   shape is treated as possibly-missing, and errors surface
   as friendly inline messages.
   =========================================================== */

'use strict';

/* ---------- tiny helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Format a number as money. Falls back gracefully on junk input. */
function money(n, currency) {
  const num = Number(n);
  if (!isFinite(num)) return '—';
  const formatted = num.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!currency || currency === 'EUR') return '€' + formatted;
  return formatted + ' ' + currency;
}

/** Format an ISO-ish date string into something friendly. */
function friendlyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Turn a "YYYY-MM" period into a friendly "April 2025". */
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function friendlyMonth(period) {
  if (!period || typeof period !== 'string') return '';
  const m = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!m) return String(period);
  const year = m[1];
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return String(period);
  return MONTH_NAMES[idx] + ' ' + year;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Safe JSON fetch. Returns {ok, data, error}. Never throws. */
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `Something went wrong (${res.status}). Please try again.`;
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, data: data || {} };
  } catch (e) {
    return { ok: false, error: "We couldn't reach the app. Is it still running? Please refresh and try again." };
  }
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' toast-error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

/* ---------- friendly label maps ---------- */

const EVENT_LABELS = {
  ACQUISITION:      'Bought shares',
  DISPOSAL:         'Sold shares',
  LOAN_ADVANCE:     'Loan advanced',
  LOAN_REPAYMENT:   'Loan repaid',
  DISTRIBUTION:     'Dividend / distribution received',
  INTEREST_ACCRUAL: 'Interest accrued',
  FX_REVAL:         'Currency revaluation',
  WRITE_OFF:        'Write-off',
};
function eventLabel(t) { return EVENT_LABELS[t] || (t ? String(t).replace(/_/g, ' ').toLowerCase() : 'Transaction'); }

/* ---------- chart of accounts (for the bank "Post to" dropdown) ----------
   Hardcoded per CONTRACT §12 — the small operating chart. accountName()
   elsewhere resolves codes; here we need the picklist for the UI. */
const CHART_ACCOUNTS = [
  { code: '030',  name: 'Investments in shares (control)' },
  { code: '032',  name: 'Loans granted (control)' },
  { code: '1010', name: 'Bank' },
  { code: '1100', name: 'Debtors' },
  { code: '2010', name: 'Creditors' },
  { code: '2300', name: 'Borrowings' },
  { code: '4000', name: 'Investment income' },
  { code: '4010', name: 'Other income' },
  { code: '6000', name: 'Rent' },
  { code: '6100', name: 'Legal & professional' },
  { code: '6200', name: 'Office costs' },
  { code: '6300', name: 'Bank charges' },
  { code: '6400', name: 'Interest payable' },
  { code: '6500', name: 'Salaries' },
  { code: '6800', name: 'Foreign exchange gain/loss' },
  { code: '6850', name: 'Investment write-offs' },
  { code: '9999', name: 'Suspense — to review' },
];
const CHART_NAME_BY_CODE = CHART_ACCOUNTS.reduce((m, a) => { m[a.code] = a.name; return m; }, {});
function chartName(code) { return CHART_NAME_BY_CODE[code] || (code ? String(code) : '—'); }

/* ===========================================================
   PERIODS (monthly working-month filter)
   =========================================================== */

/* The currently selected filter value: 'all' or a 'YYYY-MM' string.
   Drives the drafts list, all three reports and the CSV export links. */
let selectedPeriod = 'all';
let currentPeriod = null;        // the server's "working month" (settings.currentPeriod)
let suggestedPeriod = '2025-04'; // default for the "start new month" picker

/** Build a query string carrying the active period filter (omitted when 'all'). */
function periodQuery(extra) {
  const params = new URLSearchParams();
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) params.set(k, v);
    }
  }
  if (selectedPeriod && selectedPeriod !== 'all') params.set('period', selectedPeriod);
  const s = params.toString();
  return s ? '?' + s : '';
}

/* ===========================================================
   1. HEALTH / STATUS PILL
   =========================================================== */

async function loadHealth() {
  const pill = $('#statusPill');
  const text = $('#statusPillText');
  const r = await api('/api/health');
  if (!r.ok) {
    pill.className = 'pill pill-missing';
    pill.title = "Couldn't check the AI connection.";
    text.textContent = 'AI status unknown';
    return;
  }
  const configured = !!r.data.aiConfigured;
  if (configured) {
    pill.className = 'pill pill-ready';
    pill.title = r.data.model ? ('Using model: ' + r.data.model) : 'The AI is connected and ready.';
    text.textContent = 'AI ready';
    $('#keyHint').hidden = true;
  } else {
    pill.className = 'pill pill-missing';
    pill.title = 'Add your API key in the .env file to switch on document reading.';
    text.textContent = 'Add your API key';
    $('#keyHint').hidden = false;
  }
}

/* ===========================================================
   PERIOD TOOLBAR
   =========================================================== */

/** Suggest the month AFTER the latest period present, else '2025-04'. */
function suggestNextMonth(periods) {
  const list = Array.isArray(periods) ? periods.map((p) => p && p.period).filter(Boolean) : [];
  if (!list.length) return '2025-04';
  const latest = list.slice().sort().pop();
  const m = /^(\d{4})-(\d{2})$/.exec(latest);
  if (!m) return '2025-04';
  let year = Number(m[1]);
  let mon = Number(m[2]) + 1; // 1..12 -> next
  if (mon > 12) { mon = 1; year += 1; }
  return year + '-' + String(mon).padStart(2, '0');
}

async function loadPeriods() {
  const filter = $('#periodFilter');
  const workingMonth = $('#workingMonth');

  const r = await api('/api/periods');
  if (!r.ok) {
    // Keep the toolbar usable even if the endpoint is unavailable.
    workingMonth.textContent = 'All months';
    return;
  }

  const periods = Array.isArray(r.data.periods) ? r.data.periods : [];
  currentPeriod = r.data.current || null;
  suggestedPeriod = (r.data.suggested && String(r.data.suggested)) || suggestNextMonth(periods);

  workingMonth.textContent = currentPeriod ? friendlyMonth(currentPeriod) : 'All months';

  // If the previously selected filter no longer exists, fall back to 'all'.
  const known = new Set(['all', ...periods.map((p) => p && p.period).filter(Boolean)]);
  if (!known.has(selectedPeriod)) selectedPeriod = 'all';

  // Rebuild the dropdown.
  filter.innerHTML = '';
  filter.appendChild(el('option', { value: 'all', text: 'All months' }));
  periods.forEach((p) => {
    if (!p || !p.period) return;
    const pending = Number(p.pending) || 0;
    const posted = Number(p.posted) || 0;
    const label = `${friendlyMonth(p.period)} (${pending} to review · ${posted} booked)`;
    filter.appendChild(el('option', { value: p.period, text: label }));
  });
  filter.value = selectedPeriod;
}

function wirePeriodToolbar() {
  const filter = $('#periodFilter');
  const startBtn = $('#startMonthBtn');
  const picker = $('#monthPicker');
  const pickerInput = $('#monthPickerInput');
  const confirmBtn = $('#confirmMonthBtn');
  const cancelBtn = $('#cancelMonthBtn');

  filter.addEventListener('change', async () => {
    selectedPeriod = filter.value || 'all';
    updateExportLink();
    await Promise.all([loadDrafts(), loadCurrentReport()]);
  });

  startBtn.addEventListener('click', () => {
    const showing = !picker.hidden;
    if (showing) { picker.hidden = true; return; }
    pickerInput.value = suggestedPeriod || '2025-04';
    picker.hidden = false;
    pickerInput.focus();
  });

  cancelBtn.addEventListener('click', () => { picker.hidden = true; });

  confirmBtn.addEventListener('click', async () => {
    const period = (pickerInput.value || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) {
      toast('Please pick a valid month.', true);
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Starting…';
    const r = await api('/api/period', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period }),
    });
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Start this month';
    if (!r.ok) { toast(r.error, true); return; }
    picker.hidden = true;
    // The new month becomes both the working month AND the active filter.
    selectedPeriod = period;
    toast(`Started ${friendlyMonth(period)}.`);
    await refreshAll();
  });
}

/** Refresh everything that depends on the period/data. */
async function refreshAll() {
  updateExportLink();
  await loadPeriods();         // re-reads current + counts; may clamp selectedPeriod
  $('#periodFilter').value = selectedPeriod;
  updateExportLink();
  await Promise.all([loadDrafts(), loadCurrentReport()]);
}

/* ===========================================================
   2. UPLOAD
   =========================================================== */

const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const folderInput = $('#folderInput');

function wireUpload() {
  $('#chooseFilesBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  $('#chooseFolderBtn').addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) uploadFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    if (folderInput.files && folderInput.files.length) uploadFiles(Array.from(folderInput.files));
    folderInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('is-dragover'); }));
  ['dragleave', 'dragend'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('is-dragover'); }));

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove('is-dragover');
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) uploadFiles(files);
    else uploadError("We couldn't find any files in what you dropped. Try the 'Choose files' button instead.");
  });
}

/** Gather files from a drop, walking folders where the browser allows it. */
async function collectDroppedFiles(dt) {
  // Prefer the directory-walking API when available (handles dropped folders).
  const items = dt && dt.items ? Array.from(dt.items) : [];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);

  if (entries.length) {
    const out = [];
    await Promise.all(entries.map((entry) => walkEntry(entry, out)));
    if (out.length) return out;
  }
  // Fallback to the flat file list.
  return dt && dt.files ? Array.from(dt.files) : [];
}

function walkEntry(entry, out, path = '') {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file((file) => {
        try { file._relPath = path + file.name; } catch (_) {}
        out.push(file);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          await Promise.all(batch.map((e) => walkEntry(e, out, path + entry.name + '/')));
          readBatch(); // directories may need multiple reads
        }, () => resolve());
      };
      readBatch();
    } else resolve();
  });
}

function setUploadBusy(busy, text) {
  const prog = $('#uploadProgress');
  prog.hidden = !busy;
  if (text) $('#uploadProgressText').textContent = text;
  dropZone.style.pointerEvents = busy ? 'none' : '';
  dropZone.style.opacity = busy ? '0.6' : '';
}

function uploadError(msg) {
  const box = $('#uploadError');
  box.textContent = msg;
  box.hidden = false;
}

async function uploadFiles(files) {
  $('#uploadError').hidden = true;
  $('#uploadResult').hidden = true;

  const form = new FormData();
  for (const f of files) {
    // The server expects the field name `files[]`.
    form.append('files[]', f, (f._relPath || f.webkitRelativePath || f.name));
  }

  const n = files.length;
  setUploadBusy(true, n === 1 ? 'Reading your document…' : `Reading your ${n} documents…`);

  const r = await api('/api/upload', { method: 'POST', body: form });
  setUploadBusy(false);

  if (!r.ok) {
    uploadError(r.error);
    return;
  }
  renderUploadSummary(r.data);

  // New drafts and books may exist now (and possibly a new month) — refresh everything.
  await refreshAll();
}

function renderUploadSummary(data) {
  const events   = Array.isArray(data.events)   ? data.events   : [];
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  const unknown  = Array.isArray(data.unknown)  ? data.unknown  : [];
  const errors   = Array.isArray(data.errors)   ? data.errors   : [];
  const processed = Number(data.processed) ||
    (events.length + evidence.length + unknown.length + errors.length);

  const attention = unknown.length + errors.length;

  const box = $('#uploadResult');
  box.innerHTML = '';

  // Plain-language headline.
  const parts = [];
  parts.push(`Read ${processed} document${processed === 1 ? '' : 's'}`);
  const detail = [];
  detail.push(`${events.length} transaction${events.length === 1 ? '' : 's'} to review`);
  if (evidence.length) detail.push(`${evidence.length} supporting file${evidence.length === 1 ? '' : 's'} filed`);
  if (attention) detail.push(`${attention} need${attention === 1 ? 's' : ''} your attention`);

  box.appendChild(el('h3', { text: parts[0] + ' — ' + detail.join(', ') + '.' }));

  const chips = el('div', { class: 'result-chips' });
  chips.appendChild(makeChip(events.length, 'to review'));
  chips.appendChild(makeChip(evidence.length, 'filed'));
  if (attention) chips.appendChild(makeChip(attention, 'need attention', true));
  box.appendChild(chips);

  // If anything needs attention, list the filenames helpfully.
  const flagged = [].concat(unknown, errors)
    .map((o) => (o && (o.fileName || o.file || o.name)) || null)
    .filter(Boolean);
  if (flagged.length) {
    const d = el('div', { class: 'result-detail' });
    d.appendChild(el('span', { text: "We weren't sure what to do with these — they're saved, but you may want to check them:" }));
    const ul = el('ul');
    flagged.slice(0, 12).forEach((name) => ul.appendChild(el('li', { text: name })));
    if (flagged.length > 12) ul.appendChild(el('li', { text: `…and ${flagged.length - 12} more` }));
    d.appendChild(ul);
    box.appendChild(d);
  }

  box.hidden = false;
}

function makeChip(n, label, attention = false) {
  return el('span', { class: 'result-chip' + (attention ? ' attention' : '') }, [
    el('span', { class: 'n', text: String(n) }),
    el('span', { text: ' ' + label }),
  ]);
}

/* ===========================================================
   3. REVIEW & APPROVE
   =========================================================== */

async function loadDrafts() {
  const list = $('#reviewList');
  const empty = $('#reviewEmpty');
  const approveAll = $('#approveAllBtn');

  const r = await api('/api/drafts' + periodQuery({ status: 'PENDING' }));
  if (!r.ok) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.querySelector('p').textContent = r.error;
    approveAll.hidden = true;
    return;
  }

  const drafts = Array.isArray(r.data.drafts) ? r.data.drafts : [];
  list.innerHTML = '';

  if (!drafts.length) {
    empty.hidden = false;
    empty.querySelector('p').textContent =
      'Nothing to review yet. Once you add documents above, anything that looks like a transaction will appear here for your approval.';
    approveAll.hidden = true;
    return;
  }

  empty.hidden = true;
  approveAll.hidden = false;
  drafts.forEach((d) => list.appendChild(buildDraftCard(d)));
}

function confidenceChip(confidence) {
  if (confidence == null || !isFinite(Number(confidence))) return null;
  let pct = Number(confidence);
  if (pct <= 1) pct = pct * 100;          // accept 0..1 or 0..100
  pct = Math.round(pct);
  let cls = 'conf-low';
  if (pct >= 85) cls = 'conf-high';
  else if (pct >= 60) cls = 'conf-mid';
  return el('span', { class: 'conf-chip ' + cls, title: 'How sure the AI was about reading this document.' }, [
    aiSparkIcon(), el('span', { text: `AI confidence ${pct}%` }),
  ]);
}

function aiSparkIcon() {
  const span = el('span', {});
  span.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2zm6 11l.9 2.5L21.5 16l-2.6.9L18 19.5l-.9-2.6L14.5 16l2.6-.5L18 13zM6 15l.7 2L9 17.7l-2.3.7L6 21l-.7-2.6L3 17.7 5.3 17 6 15z"/></svg>';
  return span;
}

function buildDraftCard(d) {
  const card = el('div', { class: 'draft-card' });
  card.dataset.id = d.id;

  const src = d.sourceFigures || {};
  const lines = Array.isArray(d.lines) ? d.lines : [];

  /* head: investee + event + date, confidence chip on the right */
  const head = el('div', { class: 'draft-head' });
  const left = el('div', { class: 'draft-head-left' }, [
    el('span', { class: 'event-badge' }, [el('span', { text: eventLabel(d.eventType) })]),
    el('h3', { class: 'draft-investee', text: d.investeeName || 'Unnamed investee' }),
    el('p', { class: 'draft-meta', text: [friendlyDate(d.txnDate), d.docName ? ('from ' + d.docName) : null].filter(Boolean).join('  •  ') }),
  ]);
  head.appendChild(left);
  const chip = confidenceChip(d.confidence);
  if (chip) head.appendChild(chip);
  card.appendChild(head);

  /* needs-attention notice (e.g. missing carrying cost) */
  if (d.rationale && /carry|attention|missing|needs/i.test(d.rationale)) {
    card.appendChild(el('div', { class: 'needs-attn', text: '⚠ ' + d.rationale }));
  }

  /* live source-document preview */
  card.appendChild(buildDocPreview(d));

  /* compare: said vs booked */
  const compare = el('div', { class: 'compare' });

  // "What the document said" (AI read)
  const saidCol = el('div', { class: 'compare-col said' });
  saidCol.appendChild(el('div', { class: 'compare-label' }, [
    el('span', { text: 'What the document said' }),
    el('span', { class: 'tag tag-ai', title: 'The AI read these figures straight off your document.' }, [aiSparkIcon(), el('span', { text: 'AI read' })]),
  ]));
  saidCol.appendChild(buildSaidFigures(src));
  compare.appendChild(saidCol);

  // "What we booked" (engine calculated)
  const bookedCol = el('div', { class: 'compare-col booked' });
  bookedCol.appendChild(el('div', { class: 'compare-label' }, [
    el('span', { text: 'What we booked' }),
    el('span', { class: 'tag tag-calc', title: 'The engine calculated and balanced these entries — not the AI.' }, [el('span', { text: '🧮 we calculated' })]),
  ]));
  bookedCol.appendChild(buildJournalTable(lines));
  const fx = buildFxLine(d.engineFigures);
  if (fx) bookedCol.appendChild(fx);
  compare.appendChild(bookedCol);

  card.appendChild(compare);

  /* citation */
  if (d.citation) {
    const cit = el('div', { class: 'draft-citation' });
    cit.appendChild(el('span', { class: 'ci-label', text: 'Where this came from: ' }));
    cit.appendChild(el('blockquote', { text: d.citation }));
    card.appendChild(cit);
  }

  /* actions */
  const actions = el('div', { class: 'draft-actions' });
  const rejectBtn = el('button', { class: 'btn btn-reject', text: 'Reject' });
  const approveBtn = el('button', { class: 'btn btn-approve', text: 'Approve' });
  rejectBtn.addEventListener('click', () => rejectDraft(d.id, card, rejectBtn, approveBtn));
  approveBtn.addEventListener('click', () => approveDraft(d.id, card, rejectBtn, approveBtn));
  actions.appendChild(rejectBtn);
  actions.appendChild(approveBtn);
  card.appendChild(actions);

  return card;
}

function buildSaidFigures(src) {
  const wrap = el('div', {});
  const rows = [];
  if (src.amount != null && isFinite(Number(src.amount))) {
    rows.push(['Amount', money(src.amount, src.currency)]);
  }
  if (src.quantity != null && isFinite(Number(src.quantity))) {
    rows.push(['Quantity', Number(src.quantity).toLocaleString('en-GB')]);
  }
  if (src.fairValue != null && isFinite(Number(src.fairValue))) {
    rows.push(['Fair value', money(src.fairValue, src.currency)]);
  }
  if (src.currency) {
    rows.push(['Currency', String(src.currency)]);
  }
  if (!rows.length) {
    wrap.appendChild(el('p', { class: 'fig-empty', text: 'No figures were read from this document.' }));
    return wrap;
  }
  rows.forEach(([k, v]) => {
    wrap.appendChild(el('div', { class: 'fig-row' }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: v }),
    ]));
  });
  return wrap;
}

function buildJournalTable(lines) {
  if (!lines.length) {
    return el('p', { class: 'fig-empty', text: 'No entries were booked.' });
  }
  const table = el('table', { class: 'jtable' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', { class: 'acct', text: 'Account' }),
      el('th', { class: 'num', text: 'Debit' }),
      el('th', { class: 'num', text: 'Credit' }),
    ]),
  ]);
  table.appendChild(thead);

  const tbody = el('tbody');
  let totalDr = 0, totalCr = 0;
  lines.forEach((ln) => {
    const amt = Number(ln.amount) || 0;
    const isDebit = amt >= 0;
    const abs = Math.abs(amt);
    if (isDebit) totalDr += abs; else totalCr += abs;

    const acct = el('td', { class: 'acct' });
    acct.appendChild(el('span', { class: 'acct-name', text: ln.accountName || ln.accountCode || 'Account' }));
    if (ln.description) acct.appendChild(el('span', { class: 'acct-desc', text: ln.description }));

    tbody.appendChild(el('tr', {}, [
      acct,
      isDebit ? el('td', { class: 'num', text: money(abs) }) : el('td', { class: 'num muted', text: '—' }),
      !isDebit ? el('td', { class: 'num', text: money(abs) }) : el('td', { class: 'num muted', text: '—' }),
    ]));
  });
  table.appendChild(tbody);

  table.appendChild(el('tfoot', {}, [
    el('tr', {}, [
      el('td', { class: 'acct', text: 'Total' }),
      el('td', { class: 'num', text: money(totalDr) }),
      el('td', { class: 'num', text: money(totalCr) }),
    ]),
  ]));
  return table;
}

/** A clear "exchange rate used" line for converted (non-EUR) entries. */
function buildFxLine(engineFigures) {
  const ef = engineFigures || {};
  const rate = ef.fxRate;
  const currency = ef.originalCurrency || ef.currency;

  // EUR entries (no conversion) carry a null rate — show a quiet note.
  if (rate == null || !isFinite(Number(rate))) {
    if (currency && currency !== 'EUR') return null; // unknown rate; stay silent rather than mislead
    return el('div', { class: 'fx-line fx-none' }, [
      el('span', { text: 'No conversion (EUR).' }),
    ]);
  }

  const rateStr = Number(rate).toLocaleString('en-GB', { maximumFractionDigits: 6 });
  const cur = currency || '';
  const dateBit = ef.fxRateDate ? ` (as at ${friendlyDate(ef.fxRateDate)})` : '';
  return el('div', { class: 'fx-line', title: 'The engine converted this using the bundled ECB rate for that date.' }, [
    el('span', { class: 'fx-icon', text: '⇄ ' }),
    el('span', { class: 'fx-label', text: 'Exchange rate used: ' }),
    el('span', { class: 'fx-value', text: `1 EUR = ${rateStr} ${cur}${dateBit}` }),
  ]);
}

/** Compact FX-rate cell for the ledger table: "1.0423 PLN" or "—". */
function fxCell(row) {
  const r = row || {};
  const rate = r.fxRate;
  if (rate == null || !isFinite(Number(rate))) return '—';
  const rateStr = Number(rate).toLocaleString('en-GB', { maximumFractionDigits: 6 });
  const cur = r.originalCurrency || r.currency || '';
  return cur ? `${rateStr} ${cur}` : rateStr;
}

/** Live preview of the source document inside a review card. */
function buildDocPreview(d) {
  const wrap = el('details', { class: 'doc-preview', open: 'open' });
  const summary = el('summary', { class: 'doc-summary' }, [
    el('span', { class: 'doc-summary-title', text: '📄 Source document' }),
  ]);
  wrap.appendChild(summary);

  const docId = d.documentId;
  const body = el('div', { class: 'doc-body' });

  if (!docId) {
    body.appendChild(el('p', { class: 'doc-empty', text: 'No preview available for this entry.' }));
    wrap.appendChild(body);
    return wrap;
  }

  const url = `/api/documents/${encodeURIComponent(docId)}/file`;
  const name = (d.docName || '').toLowerCase();
  const mime = (d.docMime || d.mime || '').toLowerCase();

  const isPdf = mime.includes('pdf') || /\.pdf$/.test(name);
  const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);

  // Header note + open-in-new-tab link.
  if (d.docName) summary.appendChild(el('span', { class: 'doc-summary-name', text: d.docName }));

  if (isImage) {
    const img = el('img', {
      class: 'doc-img', src: url, alt: d.docName || 'Source document',
      loading: 'lazy',
    });
    img.addEventListener('error', () => {
      img.remove();
      body.appendChild(el('p', { class: 'doc-empty', text: "Couldn't load this image. Use the link below to open it." }));
    });
    body.appendChild(img);
  } else if (isPdf) {
    // <iframe> renders PDFs inline in modern browsers.
    body.appendChild(el('iframe', {
      class: 'doc-frame', src: url, title: d.docName || 'Source document', loading: 'lazy',
    }));
  } else {
    // Unknown type — offer a safe open/download link instead of guessing.
    body.appendChild(el('p', { class: 'doc-empty', text: 'This file type can\'t be previewed here, but you can open it.' }));
  }

  body.appendChild(el('div', { class: 'doc-actions' }, [
    el('a', { class: 'doc-open', href: url, target: '_blank', rel: 'noopener', text: 'Open in new tab ↗' }),
  ]));

  wrap.appendChild(body);
  return wrap;
}

function disableCard(card, ...btns) { btns.forEach((b) => { if (b) b.disabled = true; }); }
function enableCard(card, ...btns) { btns.forEach((b) => { if (b) b.disabled = false; }); }

async function approveDraft(id, card, rejectBtn, approveBtn) {
  disableCard(card, rejectBtn, approveBtn);
  approveBtn.textContent = 'Approving…';
  const r = await api(`/api/drafts/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (!r.ok) {
    approveBtn.textContent = 'Approve';
    enableCard(card, rejectBtn, approveBtn);
    toast(r.error, true);
    return;
  }
  removeCard(card);
  toast('Approved and added to your books.');
  await afterDraftChange();
}

async function rejectDraft(id, card, rejectBtn, approveBtn) {
  disableCard(card, rejectBtn, approveBtn);
  rejectBtn.textContent = 'Rejecting…';
  const r = await api(`/api/drafts/${encodeURIComponent(id)}/reject`, { method: 'POST' });
  if (!r.ok) {
    rejectBtn.textContent = 'Reject';
    enableCard(card, rejectBtn, approveBtn);
    toast(r.error, true);
    return;
  }
  removeCard(card);
  toast('Rejected — left out of your books.');
  await afterDraftChange();
}

function removeCard(card) {
  card.classList.add('removing');
  setTimeout(() => {
    card.remove();
    if (!$('#reviewList').children.length) {
      $('#reviewEmpty').hidden = false;
      $('#reviewEmpty').querySelector('p').textContent =
        'All caught up — nothing left to review. Add more documents above whenever you like.';
      $('#approveAllBtn').hidden = true;
    }
  }, 260);
}

async function afterDraftChange() {
  // Counts on the period dropdown shift when a draft is approved/rejected.
  await Promise.all([loadCurrentReport(), loadPeriods()]);
  $('#periodFilter').value = selectedPeriod;
}

function wireApproveAll() {
  $('#approveAllBtn').addEventListener('click', async () => {
    const btn = $('#approveAllBtn');
    const count = $('#reviewList').children.length;
    if (!count) return;
    btn.disabled = true;
    btn.textContent = 'Approving all…';
    const r = await api('/api/drafts/approve-all', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = 'Approve all';
    if (!r.ok) { toast(r.error, true); return; }
    const n = Number(r.data.approved) || count;
    toast(`Approved ${n} transaction${n === 1 ? '' : 's'}.`);
    await refreshAll();
  });
}

/* ===========================================================
   4. BOOKS & REPORTS
   =========================================================== */

const TAB_INFO = {
  'portfolio':     { hint: 'A snapshot of what each holding is worth in your books.', export: '/api/export/portfolio' },
  'ledger':        { hint: 'Every approved entry, line by line.',                     export: '/api/export/ledger' },
  'trial-balance': { hint: 'Each account totalled up — debits should equal credits.', export: '/api/export/trial-balance' },
};
let activeTab = 'portfolio';

/** Keep the "Download CSV" link in sync with the active tab + period filter. */
function updateExportLink() {
  const info = TAB_INFO[activeTab] || TAB_INFO.portfolio;
  $('#downloadCsvBtn').setAttribute('href', info.export + periodQuery());
}

function wireTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('is-active')) return;
      $$('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      activeTab = tab.dataset.tab;
      const info = TAB_INFO[activeTab];
      $('#tabHint').textContent = info.hint;
      updateExportLink();
      loadCurrentReport();
    });
  });
}

function loadCurrentReport() {
  if (activeTab === 'portfolio') return loadPortfolio();
  if (activeTab === 'ledger') return loadLedger();
  if (activeTab === 'trial-balance') return loadTrialBalance();
}

function showReportLoading() {
  $('#reportBody').innerHTML =
    '<div class="report-loading"><span class="spinner"></span><span>Totting up your books…</span></div>';
}

function showReportEmpty(msg) {
  $('#reportBody').innerHTML = `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`;
}

function tableEl(headers, rows, footer) {
  const table = el('table', { class: 'rtable' });
  table.appendChild(el('thead', {}, [
    el('tr', {}, headers.map((h) =>
      el('th', { class: h.num ? 'num' : '', text: h.label }))),
  ]));
  const tbody = el('tbody');
  rows.forEach((cells) => {
    tbody.appendChild(el('tr', {}, cells.map((c) =>
      el('td', { class: c.num ? 'num' : '', text: c.text }))));
  });
  table.appendChild(tbody);
  if (footer && footer.length) {
    table.appendChild(el('tfoot', {}, [
      el('tr', {}, footer.map((c) =>
        el('td', { class: c.num ? 'num' : '', text: c.text }))),
    ]));
  }
  return table;
}

async function loadPortfolio() {
  showReportLoading();
  const r = await api('/api/report/portfolio' + periodQuery());
  if (!r.ok) { showReportEmpty(r.error); return; }
  const rows = Array.isArray(r.data.rows) ? r.data.rows : [];
  if (!rows.length) {
    showReportEmpty('No holdings yet. Approve a "Bought shares" or "Loan advanced" transaction and it will appear here.');
    return;
  }
  const body = tableEl(
    [{ label: 'Investee' }, { label: 'Type' }, { label: 'Account' }, { label: 'Carrying value', num: true }],
    rows.map((row) => ([
      { text: row.investeeName || '—' },
      { text: prettyInstrument(row.instrument) },
      { text: row.controlCode || '—' },
      { text: money(row.carryingValue, row.currency), num: true },
    ])),
    buildPortfolioFooter(r.data.totals),
  );
  $('#reportBody').innerHTML = '';
  $('#reportBody').appendChild(body);
}

function prettyInstrument(i) {
  if (i === 'SHARES') return 'Shares';
  if (i === 'LOAN') return 'Loan';
  return i || '—';
}

function buildPortfolioFooter(totals) {
  // totals shape is per control code per the contract; sum to a grand total defensively.
  if (!totals) return null;
  let grand = 0;
  if (Array.isArray(totals)) {
    totals.forEach((t) => { grand += Number(t && (t.total ?? t.carryingValue)) || 0; });
  } else if (typeof totals === 'object') {
    Object.values(totals).forEach((v) => {
      grand += (v && typeof v === 'object') ? (Number(v.total ?? v.carryingValue) || 0) : (Number(v) || 0);
    });
  } else {
    grand = Number(totals) || 0;
  }
  if (!isFinite(grand)) return null;
  return [{ text: 'Total' }, { text: '' }, { text: '' }, { text: money(grand), num: true }];
}

async function loadLedger() {
  showReportLoading();
  const r = await api('/api/report/ledger' + periodQuery());
  if (!r.ok) { showReportEmpty(r.error); return; }
  const lines = Array.isArray(r.data.lines) ? r.data.lines : [];
  if (!lines.length) {
    showReportEmpty('Your ledger is empty. Approve a transaction above and its entries will show here.');
    return;
  }
  const rows = lines.map((ln) => {
    const amt = Number(ln.amount) || 0;
    const isDebit = amt >= 0;
    const abs = Math.abs(amt);
    return [
      { text: friendlyDate(ln.txnDate) },
      { text: ln.investeeName || '—' },
      { text: ln.accountName || ln.accountCode || '—' },
      { text: isDebit ? money(abs) : '', num: true },
      { text: !isDebit ? money(abs) : '', num: true },
      { text: fxCell(ln), num: true },
    ];
  });
  const body = tableEl(
    [{ label: 'Date' }, { label: 'Investee' }, { label: 'Account' }, { label: 'Debit', num: true }, { label: 'Credit', num: true }, { label: 'FX rate', num: true }],
    rows,
  );
  $('#reportBody').innerHTML = '';
  $('#reportBody').appendChild(body);
}

async function loadTrialBalance() {
  showReportLoading();
  const r = await api('/api/report/trial-balance' + periodQuery());
  if (!r.ok) { showReportEmpty(r.error); return; }
  const rows = Array.isArray(r.data.rows) ? r.data.rows : [];
  if (!rows.length) {
    showReportEmpty('Nothing to balance yet. Once you approve transactions, each account total appears here.');
    return;
  }
  const tableRows = rows.map((row) => {
    // A row may carry an explicit debit/credit, or a single signed balance.
    let dr = row.debit, cr = row.credit;
    if (dr == null && cr == null) {
      const bal = Number(row.balance ?? row.amount) || 0;
      dr = bal >= 0 ? bal : 0;
      cr = bal < 0 ? -bal : 0;
    }
    return [
      { text: row.accountCode || '—' },
      { text: row.accountName || '—' },
      { text: Number(dr) ? money(dr) : '', num: true },
      { text: Number(cr) ? money(cr) : '', num: true },
    ];
  });
  const t = r.data.totals || {};
  const footer = [
    { text: 'Total' }, { text: '' },
    { text: money(Number(t.debit ?? t.debits) || sumCol(tableRows, 2)), num: true },
    { text: money(Number(t.credit ?? t.credits) || sumCol(tableRows, 3)), num: true },
  ];
  const body = tableEl(
    [{ label: 'Code' }, { label: 'Account' }, { label: 'Debit', num: true }, { label: 'Credit', num: true }],
    tableRows, footer,
  );
  $('#reportBody').innerHTML = '';
  $('#reportBody').appendChild(body);
}

function sumCol(rows, idx) {
  return rows.reduce((acc, cells) => {
    const txt = (cells[idx] && cells[idx].text) || '';
    const num = Number(String(txt).replace(/[^0-9.\-]/g, ''));
    return acc + (isFinite(num) ? num : 0);
  }, 0);
}

/* ===========================================================
   5. START OVER
   =========================================================== */

function wireStartOver() {
  $('#startOverBtn').addEventListener('click', async () => {
    const ok = window.confirm(
      'Start over? This permanently deletes every document, draft and approved entry. This cannot be undone.');
    if (!ok) return;
    const btn = $('#startOverBtn');
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    const r = await api('/api/reset', { method: 'POST' });
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = 'Start over';
      toast(r.error, true);
      return;
    }
    window.location.reload();
  });
}

/* ===========================================================
   TOP-LEVEL SECTION NAV (Investments / Bank / Debtors / Loans)
   =========================================================== */

let activeView = 'investments';
const loadedViews = new Set(['investments']); // lazy-load each view once

function wireSectionNav() {
  $$('.snav').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (!view || view === activeView) return;
      activeView = view;
      $$('.snav').forEach((b) => b.classList.toggle('is-active', b === btn));
      $$('.view').forEach((v) => { v.hidden = v.id !== ('view-' + view); });
      // The working-month toolbar only applies to the Investments flow.
      const periodBar = $('.period-bar');
      if (periodBar) periodBar.hidden = (view !== 'investments');
      loadViewIfNeeded(view);
    });
  });
}

function loadViewIfNeeded(view) {
  // Bank, AR/AP and Loans data only matter while their view is on screen;
  // load on first open, then leave the user in control via Refresh/upload.
  if (loadedViews.has(view)) return;
  loadedViews.add(view);
  if (view === 'bank') loadBankAccounts();
  if (view === 'arap') loadAging();
  if (view === 'loans') loadLoans();
}

/* ===========================================================
   GENERIC UPLOAD-ZONE WIRING (reused by Bank + Debtors/Creditors)
   =========================================================== */

/** Wire a dropzone + hidden input + choose-button to an upload handler. */
function wireDropzone({ zone, input, button, onFiles, accept }) {
  const z = $(zone), inp = $(input), btn = $(button);
  if (!z || !inp) return;

  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); inp.click(); });
  z.addEventListener('click', () => inp.click());
  z.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); }
  });
  inp.addEventListener('change', () => {
    if (inp.files && inp.files.length) onFiles(Array.from(inp.files));
    inp.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    z.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); z.classList.add('is-dragover'); }));
  ['dragleave', 'dragend'].forEach((ev) =>
    z.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); z.classList.remove('is-dragover'); }));
  z.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    z.classList.remove('is-dragover');
    const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (accept) {
      const filtered = files.filter((f) => accept.test(f.name || ''));
      if (files.length && !filtered.length) { onFiles([]); return; }
      onFiles(filtered.length ? filtered : files);
    } else {
      onFiles(files);
    }
  });
}

function setBusy(progressSel, textSel, zoneSel, busy, text) {
  const prog = $(progressSel);
  if (prog) prog.hidden = !busy;
  if (text && $(textSel)) $(textSel).textContent = text;
  const z = $(zoneSel);
  if (z) { z.style.pointerEvents = busy ? 'none' : ''; z.style.opacity = busy ? '0.6' : ''; }
}

/** POST files[] to an endpoint, returning the guarded api() result. */
function postFiles(path, files) {
  const form = new FormData();
  for (const f of files) form.append('files[]', f, f.name);
  return api(path, { method: 'POST', body: form });
}

/* ===========================================================
   BANK
   =========================================================== */

let bankAccounts = [];
let bankSelectedAccountId = null;

function wireBank() {
  wireDropzone({
    zone: '#bankDropZone', input: '#bankFileInput', button: '#bankChooseBtn',
    accept: /\.(pdf|csv)$/i,
    onFiles: (files) => {
      if (!files.length) {
        bankUploadError("Please choose PDF or CSV bank statements.");
        return;
      }
      uploadBankStatements(files);
    },
  });
  $('#bankAccountPicker').addEventListener('change', (e) => {
    bankSelectedAccountId = e.target.value || null;
    renderBankAccount();
  });
}

function bankUploadError(msg) {
  const box = $('#bankUploadError');
  if (!box) return;
  box.textContent = msg;
  box.hidden = false;
}

async function uploadBankStatements(files) {
  $('#bankUploadError').hidden = true;
  $('#bankUploadResult').hidden = true;
  const n = files.length;
  setBusy('#bankUploadProgress', '#bankUploadProgressText', '#bankDropZone', true,
    n === 1 ? 'Reading your statement…' : `Reading your ${n} statements…`);

  const r = await postFiles('/api/bank/upload', files);
  setBusy('#bankUploadProgress', '#bankUploadProgressText', '#bankDropZone', false);

  if (!r.ok) { bankUploadError(r.error); return; }
  renderBankUploadSummary(r.data, n);
  await loadBankAccounts();
}

/** Plain-language summary, e.g. "Read 2 statements · 1 new month added · May–June skipped · balances tie". */
function renderBankUploadSummary(data, fileCount) {
  const box = $('#bankUploadResult');
  if (!box) return;
  box.innerHTML = '';

  // The route may aggregate results in a few shapes — gather defensively.
  const results = Array.isArray(data.results) ? data.results
    : Array.isArray(data.statements) ? data.statements : [];
  const read = Number(data.read ?? data.processed ?? results.length ?? fileCount) || fileCount || 0;

  let added = Number(data.added);
  let skipped = [];
  let footingOk = data.footingOk;
  let footingDiff = Number(data.footingDiff);

  if (!isFinite(added) || results.length) {
    added = 0; let allTie = true; let anyTie = false;
    results.forEach((res) => {
      added += Number(res && res.added) || 0;
      const sm = (res && res.skippedMonths) || [];
      if (Array.isArray(sm)) skipped = skipped.concat(sm);
      if (res && res.footingOk === false) allTie = false;
      if (res && res.footingOk === true) anyTie = true;
    });
    if (footingOk == null) footingOk = anyTie ? allTie : undefined;
  }
  if (Array.isArray(data.skippedMonths)) skipped = skipped.concat(data.skippedMonths);
  skipped = Array.from(new Set(skipped.filter(Boolean))).sort();

  const parts = [];
  parts.push(`Read ${read} statement${read === 1 ? '' : 's'}`);
  if (isFinite(added)) parts.push(`${added} new month${added === 1 ? '' : 's'} added`);
  if (skipped.length) parts.push(`${summariseMonths(skipped)} skipped (already loaded)`);
  if (footingOk === true) parts.push('balances tie');
  else if (footingOk === false) parts.push(`doesn't tie${isFinite(footingDiff) ? ` (diff ${money(Math.abs(footingDiff))})` : ''}`);

  box.appendChild(el('h3', { text: parts.join(' · ') + '.' }));
  box.hidden = false;
}

/** "2025-05","2025-06" -> "May–June 2025"; mixed years fall back to a list. */
function summariseMonths(periods) {
  const list = (periods || []).filter(Boolean).slice().sort();
  if (!list.length) return '';
  if (list.length === 1) return friendlyMonth(list[0]);
  const years = new Set(list.map((p) => p.slice(0, 4)));
  if (years.size === 1) {
    const names = list.map((p) => {
      const idx = Number(p.slice(5, 7)) - 1;
      return (idx >= 0 && idx < 12) ? MONTH_NAMES[idx] : p;
    });
    return `${names[0]}–${names[names.length - 1]} ${list[0].slice(0, 4)}`;
  }
  return list.map(friendlyMonth).join(', ');
}

async function loadBankAccounts() {
  const r = await api('/api/bank/accounts');
  const picker = $('#bankAccountPicker');
  const wrap = $('#bankAccountPickerWrap');
  const empty = $('#bankEmpty');

  if (!r.ok) {
    bankAccounts = [];
    empty.hidden = false;
    empty.querySelector('p').textContent = r.error;
    wrap.hidden = true;
    $('#bankStatements').innerHTML = '';
    $('#bankBody').innerHTML = '';
    return;
  }

  bankAccounts = Array.isArray(r.data.accounts) ? r.data.accounts : [];
  if (!bankAccounts.length) {
    empty.hidden = false;
    empty.querySelector('p').textContent = 'No bank statements yet — upload one above.';
    wrap.hidden = true;
    $('#bankStatements').innerHTML = '';
    $('#bankBody').innerHTML = '';
    return;
  }

  empty.hidden = true;
  wrap.hidden = bankAccounts.length <= 1 ? false : false; // always show picker
  picker.innerHTML = '';
  bankAccounts.forEach((a) => {
    if (!a || !a.id) return;
    const label = [a.bankName, a.accountRef].filter(Boolean).join(' · ') || a.id;
    picker.appendChild(el('option', { value: a.id, text: label + (a.currency && a.currency !== 'EUR' ? ` (${a.currency})` : '') }));
  });

  // Keep selection if still valid, else pick the first.
  if (!bankSelectedAccountId || !bankAccounts.some((a) => a.id === bankSelectedAccountId)) {
    bankSelectedAccountId = bankAccounts[0].id;
  }
  picker.value = bankSelectedAccountId;
  await renderBankAccount();
}

async function renderBankAccount() {
  const statementsBox = $('#bankStatements');
  const body = $('#bankBody');
  statementsBox.innerHTML = '';
  body.innerHTML = '<div class="report-loading"><span class="spinner"></span><span>Loading transactions…</span></div>';

  if (!bankSelectedAccountId) { body.innerHTML = ''; return; }

  const [stmtRes, txnRes] = await Promise.all([
    api('/api/bank/statements'),
    api('/api/bank/transactions?accountId=' + encodeURIComponent(bankSelectedAccountId)),
  ]);

  // Statements for this account, with footing badges.
  if (stmtRes.ok) {
    const all = Array.isArray(stmtRes.data.statements) ? stmtRes.data.statements : [];
    const mine = all.filter((s) => s && s.bankAccountId === bankSelectedAccountId);
    if (mine.length) statementsBox.appendChild(buildStatementCards(mine));
  }

  if (!txnRes.ok) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(txnRes.error)}</p></div>`; return; }
  const txns = Array.isArray(txnRes.data.transactions) ? txnRes.data.transactions : [];
  body.innerHTML = '';
  if (!txns.length) {
    body.appendChild(el('div', { class: 'empty-state' }, [el('p', { text: 'No transactions on this account yet.' })]));
    return;
  }
  body.appendChild(buildBankTxnTable(txns));
}

function buildStatementCards(statements) {
  const wrap = el('div', { class: 'stmt-cards' });
  statements
    .slice()
    .sort((a, b) => String(a.periodStart || '').localeCompare(String(b.periodStart || '')))
    .forEach((s) => {
      const tie = !!s.footingOk;
      const diff = Number(s.footingDiff) || 0;
      const badge = el('span', {
        class: 'foot-badge ' + (tie ? 'tie' : 'notie'),
        title: tie ? 'Opening + movements equals the closing balance.' : 'The figures on this statement don\'t add up to the closing balance.',
      }, [el('span', { text: tie ? '✓ balances tie' : `⚠ doesn't tie (diff ${money(Math.abs(diff))})` })]);

      const period = [s.periodStart, s.periodEnd].filter(Boolean).map(friendlyDate).join(' – ');
      wrap.appendChild(el('div', { class: 'stmt-card' }, [
        el('div', { class: 'stmt-card-head' }, [
          el('span', { class: 'stmt-name', text: s.fileName || 'Statement' }),
          badge,
        ]),
        el('div', { class: 'stmt-meta' }, [
          period ? el('span', { class: 'stmt-period', text: period }) : null,
          el('span', { class: 'stmt-bal' }, [
            el('span', { class: 'k', text: 'Opening ' }),
            el('strong', { text: money(s.openingBalance) }),
            el('span', { class: 'k', text: '  Closing ' }),
            el('strong', { text: money(s.closingBalance) }),
          ]),
        ]),
      ]));
    });
  return wrap;
}

function buildBankTxnTable(txns) {
  const table = el('table', { class: 'rtable bank-table' });
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', { text: 'Date' }),
      el('th', { text: 'Description' }),
      el('th', { class: 'num', text: 'Money in' }),
      el('th', { class: 'num', text: 'Money out' }),
      el('th', { class: 'num', text: 'Running balance' }),
      el('th', { text: 'Post to' }),
      el('th', { class: 'doc-col', text: 'Doc' }),
    ]),
  ]));
  const tbody = el('tbody');
  txns.forEach((t) => tbody.appendChild(buildBankTxnRow(t)));
  table.appendChild(tbody);
  return table;
}

function buildBankTxnRow(t) {
  const amt = Number(t.amount) || 0;
  const moneyIn = amt > 0 ? money(amt) : '';
  const moneyOut = amt < 0 ? money(Math.abs(amt)) : '';
  const bal = (t.balance == null || !isFinite(Number(t.balance))) ? '' : money(t.balance);

  const tr = el('tr', { class: 'bank-row status-' + String(t.status || '').toLowerCase() });
  tr.appendChild(el('td', { text: friendlyDate(t.date) }));
  tr.appendChild(el('td', { class: 'desc', text: t.description || '—' }));
  tr.appendChild(el('td', { class: 'num in', text: moneyIn }));
  tr.appendChild(el('td', { class: 'num out', text: moneyOut }));
  tr.appendChild(el('td', { class: 'num', text: bal }));

  // Post-to cell (REVIEW = editable; AUTO = pre-filled + approve; POSTED = locked)
  tr.appendChild(buildPostToCell(t));

  // Linked document
  const docTd = el('td', { class: 'doc-col' });
  if (t.matchedDocumentId) {
    docTd.appendChild(el('a', {
      class: 'doc-link', href: `/api/documents/${encodeURIComponent(t.matchedDocumentId)}/file`,
      target: '_blank', rel: 'noopener', title: 'Open the matched document', text: '📎',
    }));
  } else {
    docTd.appendChild(el('span', { class: 'doc-none', text: '—' }));
  }
  tr.appendChild(docTd);
  return tr;
}

function buildPostToCell(t) {
  const td = el('td', { class: 'postto' });
  const status = String(t.status || '').toUpperCase();
  const code = t.postToCode || '';
  const name = t.postToName || chartName(code);

  if (status === 'POSTED') {
    td.appendChild(el('span', { class: 'posted-acct' }, [
      el('span', { class: 'pt-name', text: name || '—' }),
      el('span', { class: 'pt-tag posted', text: 'posted' }),
    ]));
    return td;
  }

  if (status === 'AUTO') {
    // Pre-filled suggestion + an "auto" tag + an Approve button.
    const row = el('div', { class: 'postto-auto' });
    row.appendChild(el('span', { class: 'pt-name', text: name || '—' }));
    row.appendChild(el('span', { class: 'pt-tag auto', title: 'We picked this automatically — approve if it looks right.', text: 'auto' }));
    const approve = el('button', { class: 'btn btn-approve btn-xs', text: 'Approve' });
    approve.addEventListener('click', () => approveBankTxn(t.id, approve));
    row.appendChild(approve);
    td.appendChild(row);
    return td;
  }

  // REVIEW (default): an editable account dropdown the user sets.
  const sel = el('select', { class: 'postto-select', 'aria-label': 'Choose the account to post this to' });
  sel.appendChild(el('option', { value: '', text: 'Choose account…' }));
  CHART_ACCOUNTS.forEach((a) => {
    const opt = el('option', { value: a.code, text: `${a.code} · ${a.name}` });
    if (a.code === code) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const chosen = sel.value;
    if (!chosen) return;
    postBankTxnTo(t.id, chosen, sel);
  });
  td.appendChild(sel);
  return td;
}

async function postBankTxnTo(id, code, selectEl) {
  if (selectEl) selectEl.disabled = true;
  const r = await api(`/api/bank/transactions/${encodeURIComponent(id)}/post-to`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    if (selectEl) selectEl.disabled = false;
    toast(r.error, true);
    return;
  }
  toast(`Posted to ${chartName(code)}.`);
  await renderBankAccount();
}

async function approveBankTxn(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
  const r = await api(`/api/bank/transactions/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (!r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = 'Approve'; }
    toast(r.error, true);
    return;
  }
  toast('Posted to your books.');
  await renderBankAccount();
}

/* ===========================================================
   DEBTORS & CREDITORS (aging)
   =========================================================== */

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function wireArAp() {
  wireDropzone({
    zone: '#arapDropZone', input: '#arapFileInput', button: '#arapChooseBtn',
    onFiles: (files) => { if (files.length) uploadArAp(files); },
  });
  const asOf = $('#agingAsOf');
  asOf.value = todayIso();
  asOf.addEventListener('change', () => loadAging());
}

function arapUploadError(msg) {
  const box = $('#arapUploadError');
  if (!box) return;
  box.textContent = msg;
  box.hidden = false;
}

async function uploadArAp(files) {
  $('#arapUploadError').hidden = true;
  $('#arapUploadResult').hidden = true;
  const n = files.length;
  setBusy('#arapUploadProgress', '#arapUploadProgressText', '#arapDropZone', true,
    n === 1 ? 'Reading your invoice…' : `Reading your ${n} invoices…`);

  const r = await postFiles('/api/aging/upload', files);
  setBusy('#arapUploadProgress', '#arapUploadProgressText', '#arapDropZone', false);

  if (!r.ok) { arapUploadError(r.error); return; }

  const box = $('#arapUploadResult');
  const items = Array.isArray(r.data.items) ? r.data.items : [];
  const read = Number(r.data.read ?? r.data.processed ?? items.length ?? n) || n;
  let recv = Number(r.data.receivables);
  let pay = Number(r.data.payables);
  if (!isFinite(recv) || !isFinite(pay)) {
    recv = items.filter((i) => i && i.kind === 'RECEIVABLE').length;
    pay = items.filter((i) => i && i.kind === 'PAYABLE').length;
  }
  const detail = [];
  if (isFinite(recv) && (recv || pay)) detail.push(`${recv} debtor${recv === 1 ? '' : 's'}`);
  if (isFinite(pay) && (recv || pay)) detail.push(`${pay} creditor${pay === 1 ? '' : 's'}`);
  box.innerHTML = '';
  box.appendChild(el('h3', { text: `Read ${read} file${read === 1 ? '' : 's'}${detail.length ? ' — ' + detail.join(', ') : ''}.` }));
  box.hidden = false;

  await loadAging();
}

const AGING_BUCKETS = [
  { key: 'current',  label: 'Current' },
  { key: 'd1_30',    label: '1–30' },
  { key: 'd31_60',   label: '31–60' },
  { key: 'd61_90',   label: '61–90' },
  { key: 'd90_plus', label: '90+' },
];

async function loadAging() {
  const body = $('#agingBody');
  const empty = $('#agingEmpty');
  const asOf = ($('#agingAsOf') && $('#agingAsOf').value) || todayIso();

  body.innerHTML = '<div class="report-loading"><span class="spinner"></span><span>Totting up who owes what…</span></div>';

  const r = await api('/api/aging?asOf=' + encodeURIComponent(asOf));
  if (!r.ok) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.querySelector('p').textContent = r.error;
    return;
  }

  const receivables = r.data.receivables || {};
  const payables = r.data.payables || {};
  const hasRecv = sideHasData(receivables);
  const hasPay = sideHasData(payables);

  body.innerHTML = '';
  if (!hasRecv && !hasPay) {
    empty.hidden = false;
    empty.querySelector('p').textContent = 'No invoices or bills yet — upload one above.';
    return;
  }
  empty.hidden = true;

  body.appendChild(buildAgingSide('Receivables (debtors)', 'Customers who owe the fund.', receivables, hasRecv));
  body.appendChild(buildAgingSide('Payables (creditors)', 'Suppliers the fund owes.', payables, hasPay));
}

function sideHasData(side) {
  if (!side || typeof side !== 'object') return false;
  if (Number(side.total)) return true;
  const bc = Array.isArray(side.byCounterparty) ? side.byCounterparty : [];
  return bc.length > 0;
}

function bucketsOf(obj) {
  const b = (obj && obj.buckets) || {};
  return AGING_BUCKETS.map((bk) => Number(b[bk.key]) || 0);
}

function buildAgingSide(title, help, side, hasData) {
  const wrap = el('div', { class: 'aging-block' });
  wrap.appendChild(el('h3', { class: 'aging-title', text: title }));
  wrap.appendChild(el('p', { class: 'aging-help', text: help }));

  if (!hasData) {
    wrap.appendChild(el('div', { class: 'empty-state' }, [el('p', { text: 'Nothing outstanding here.' })]));
    return wrap;
  }

  const table = el('table', { class: 'rtable aging-table' });
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', { text: 'Counterparty' }),
      ...AGING_BUCKETS.map((b) => el('th', { class: 'num', text: b.label })),
      el('th', { class: 'num', text: 'Total' }),
    ]),
  ]));

  const tbody = el('tbody');
  const rows = Array.isArray(side.byCounterparty) ? side.byCounterparty : [];
  rows.forEach((row) => {
    const vals = bucketsOf(row);
    const total = Number(row.total) || vals.reduce((a, b) => a + b, 0);
    tbody.appendChild(el('tr', {}, [
      el('td', { text: row.counterparty || '—' }),
      ...vals.map((v) => el('td', { class: 'num', text: v ? money(v) : '' })),
      el('td', { class: 'num', text: money(total) }),
    ]));
  });
  table.appendChild(tbody);

  const totVals = bucketsOf(side);
  const grand = Number(side.total) || totVals.reduce((a, b) => a + b, 0);
  table.appendChild(el('tfoot', {}, [
    el('tr', {}, [
      el('td', { text: 'Total' }),
      ...totVals.map((v) => el('td', { class: 'num', text: money(v) })),
      el('td', { class: 'num', text: money(grand) }),
    ]),
  ]));

  wrap.appendChild(table);
  return wrap;
}

/* ===========================================================
   LOANS
   =========================================================== */

function wireLoans() {
  $('#loansRefreshBtn').addEventListener('click', () => loadLoans());
}

async function loadLoans() {
  const body = $('#loansBody');
  const empty = $('#loansEmpty');
  body.innerHTML = '<div class="report-loading"><span class="spinner"></span><span>Gathering your loans…</span></div>';

  const r = await api('/api/loans');
  if (!r.ok) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.querySelector('p').textContent = r.error;
    return;
  }

  const loans = Array.isArray(r.data.loans) ? r.data.loans : [];
  body.innerHTML = '';
  if (!loans.length) {
    empty.hidden = false;
    empty.querySelector('p').textContent =
      'No loans yet. Once you approve a loan advance or post a bank line to a loan account, it will appear here.';
    return;
  }
  empty.hidden = true;
  body.appendChild(buildLoansTable(loans, r.data.totals || {}));
}

function loanDirectionLabel(dir) {
  if (dir === 'GRANTED') return 'Lent out';
  if (dir === 'BORROWED') return 'Borrowed';
  return dir || '—';
}

function buildLoansTable(loans, totals) {
  const table = el('table', { class: 'rtable loans-table' });
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', { class: 'expand-col', text: '' }),
      el('th', { text: 'Party' }),
      el('th', { text: 'Direction' }),
      el('th', { class: 'num', text: 'Advanced' }),
      el('th', { class: 'num', text: 'Repaid' }),
      el('th', { class: 'num', text: 'Outstanding' }),
      el('th', { text: 'Last activity' }),
    ]),
  ]));

  const tbody = el('tbody');
  loans.forEach((loan, idx) => {
    const events = Array.isArray(loan.events) ? loan.events : [];
    const hasEvents = events.length > 0;
    const cur = loan.currency;

    const caret = el('span', { class: 'caret', text: hasEvents ? '▸' : '' });
    const mainTr = el('tr', { class: 'loan-row' + (hasEvents ? ' expandable' : '') });
    mainTr.appendChild(el('td', { class: 'expand-col' }, [caret]));
    mainTr.appendChild(el('td', { class: 'party', text: loan.party || '—' }));
    mainTr.appendChild(el('td', { text: loanDirectionLabel(loan.direction) }));
    mainTr.appendChild(el('td', { class: 'num', text: money(loan.advanced, cur) }));
    mainTr.appendChild(el('td', { class: 'num', text: money(loan.repaid, cur) }));
    mainTr.appendChild(el('td', { class: 'num outstanding', text: money(loan.outstanding, cur) }));
    mainTr.appendChild(el('td', { text: loan.lastEventDate ? friendlyDate(loan.lastEventDate) : '—' }));
    tbody.appendChild(mainTr);

    if (hasEvents) {
      const detailTr = el('tr', { class: 'loan-detail', hidden: 'hidden' });
      const cell = el('td', { colspan: '7' });
      cell.appendChild(buildLoanEvents(events, cur));
      detailTr.appendChild(cell);
      tbody.appendChild(detailTr);

      mainTr.classList.add('clickable');
      mainTr.addEventListener('click', () => {
        const open = detailTr.hidden;
        detailTr.hidden = !open;
        caret.textContent = open ? '▾' : '▸';
        mainTr.classList.toggle('is-open', open);
      });
    }
  });
  table.appendChild(tbody);

  // Totals row (granted/borrowed/outstanding).
  const granted = Number(totals.granted);
  const borrowed = Number(totals.borrowed);
  const outstanding = Number(totals.outstanding);
  table.appendChild(el('tfoot', {}, [
    el('tr', {}, [
      el('td', { class: 'expand-col', text: '' }),
      el('td', { text: 'Total' }),
      el('td', { text: '' }),
      el('td', { class: 'num', text: isFinite(granted) ? money(granted) : '' }),
      el('td', { class: 'num', text: '' }),
      el('td', { class: 'num outstanding', text: isFinite(outstanding) ? money(outstanding) : '' }),
      el('td', { text: '' }),
    ]),
  ]));
  return table;
}

function buildLoanEvents(events, currency) {
  const wrap = el('div', { class: 'loan-events' });
  const table = el('table', { class: 'loan-events-table' });
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', { text: 'Date' }),
      el('th', { text: 'What happened' }),
      el('th', { class: 'num', text: 'Amount' }),
      el('th', { text: 'Source' }),
    ]),
  ]));
  const tbody = el('tbody');
  events
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .forEach((ev) => {
      const isAdvance = ev.type === 'ADVANCE';
      tbody.appendChild(el('tr', {}, [
        el('td', { text: friendlyDate(ev.date) }),
        el('td', {}, [el('span', { class: 'loan-ev-type ' + (isAdvance ? 'adv' : 'rep'), text: isAdvance ? 'Advanced' : 'Repaid' })]),
        el('td', { class: 'num', text: money(ev.amount, currency) }),
        el('td', { class: 'src', text: ev.source || '—' }),
      ]));
    });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/* ===========================================================
   BOOT
   =========================================================== */

function init() {
  wireUpload();
  wireApproveAll();
  wireTabs();
  wireStartOver();
  wirePeriodToolbar();
  wireSectionNav();
  wireBank();
  wireArAp();
  wireLoans();

  // Initial loads — each is independently guarded.
  loadHealth();
  loadPeriods().then(() => { $('#periodFilter').value = selectedPeriod; });
  updateExportLink();
  loadDrafts();
  loadPortfolio();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
