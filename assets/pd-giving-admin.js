/* Prayer Dome — Giving & Donations administration.
 *
 * This module deliberately talks only to Firestore. Giving records are
 * created by the public give page with status 'pending'; this console is the
 * only place a record becomes approved, received or rejected. Totals count
 * only 'received' rows, so pending money is never presented as income.
 */
(function () {
  'use strict';

  const bridge = window.PDAdmin;
  if (!bridge) return;
  const store = bridge.firestore || {};
  const {
    collection, getDocs, doc, updateDoc, addDoc, serverTimestamp
  } = store;

  const CATEGORY_LABELS = {
    'church-support': 'Church support',
    'general-offering': 'General offering',
    'missions': 'Missions',
    'evangelism': 'Evangelism',
    'building-projects': 'Building projects',
    other: 'Other'
  };
  const STATUS_LABELS = {
    pending: 'Pending review',
    approved: 'Approved',
    received: 'Received',
    rejected: 'Rejected'
  };
  const STATUS_COLORS = {
    pending: '#b45309',
    approved: '#1d4ed8',
    received: '#15803d',
    rejected: '#b91c1c'
  };
  const STATUS_ALIASES = {
    pending_verification: 'pending',
    awaiting_verification: 'pending',
    verified: 'received',
    confirmed: 'received',
    paid: 'received',
    completed: 'received',
    declined: 'rejected',
    failed: 'rejected'
  };
  const CATEGORY_ALIASES = {
    'general offering': 'general-offering',
    'general-offerings': 'general-offering',
    tithes: 'church-support',
    'church development': 'building-projects',
    'special donations': 'other',
    'building project': 'building-projects'
  };

  let records = [];
  let recordsById = new Map();
  let duplicateTransactionRefs = new Set();
  let loading = false;

  function collectDuplicateTransactionRefs(rows) {
    const seen = new Map();
    rows.forEach(function (row) {
      const key = String(row.transactionReference || '').trim().toLowerCase();
      if (key.length < 4) return;
      seen.set(key, (seen.get(key) || 0) + 1);
    });
    return new Set(Array.from(seen.entries()).filter(function (entry) { return entry[1] > 1; }).map(function (entry) { return entry[0]; }));
  }

  function isDuplicateTransaction(row) {
    return duplicateTransactionRefs.has(String(row.transactionReference || '').trim().toLowerCase());
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function money(value, currency) {
    const amount = Number(value || 0);
    const code = String(currency || 'SZL').toUpperCase();
    try {
      return code + ' ' + amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch (error) {
      return code + ' ' + amount.toFixed(2);
    }
  }

  function timestampOf(row) {
    const value = row.createdAt || row.timestamp || row.receivedAt || null;
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function dateLabel(value) {
    const date = value instanceof Date ? value : null;
    if (!date) return '—';
    return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function normalise(id, row) {
    const donor = String(row.donorName || row.donor || row.contributorName || 'Anonymous').trim() || 'Anonymous';
    const rawCategory = String(row.category || '').trim();
    const category = CATEGORY_LABELS[rawCategory] ? rawCategory : (CATEGORY_ALIASES[rawCategory.toLowerCase()] || rawCategory || 'other');
    const rawStatus = String(row.status || 'pending').trim().toLowerCase();
    return {
      id: id,
      reference: String(row.reference || id),
      donor: donor,
      donorEmail: String(row.donorEmail || ''),
      donorUid: String(row.donorUid || ''),
      amount: Number(row.amount || 0),
      currency: String(row.currency || 'SZL').toUpperCase(),
      category: category,
      purpose: String(row.purpose || ''),
      method: String(row.method || row.methodLabel || 'Unknown'),
      methodType: String(row.methodType || ''),
      transactionReference: String(row.transactionReference || row.transactionRef || ''),
      receiptUrl: String(row.receiptUrl || row.receipt || ''),
      receiptPath: String(row.receiptPath || ''),
      note: String(row.note || ''),
      status: STATUS_ALIASES[rawStatus] || rawStatus || 'pending',
      receivedAt: timestampOf({ createdAt: row.receivedAt || row.confirmedAt }),
      reviewedAt: timestampOf({ createdAt: row.reviewedAt || row.approvedAt }),
      receivedRaw: row.receivedAt || row.confirmedAt || null,
      rejectionReason: String(row.rejectionReason || ''),
      receiptNumber: String(row.receiptNumber || ''),
      createdAt: timestampOf(row),
      raw: row
    };
  }

  function categoryLabel(row) {
    return CATEGORY_LABELS[row.category] || row.purpose || row.category || 'Other';
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || status;
  }

  function readFilters() {
    return {
      search: String((document.getElementById('givingSearch') || {}).value || '').trim().toLowerCase(),
      category: String((document.getElementById('givingCategoryFilter') || {}).value || 'all'),
      method: String((document.getElementById('givingMethodFilter') || {}).value || 'all'),
      status: String((document.getElementById('givingStatusFilter') || {}).value || 'all'),
      from: String((document.getElementById('givingFrom') || {}).value || ''),
      to: String((document.getElementById('givingTo') || {}).value || '')
    };
  }

  function filtered() {
    const f = readFilters();
    const from = f.from ? new Date(f.from + 'T00:00:00') : null;
    const to = f.to ? new Date(f.to + 'T23:59:59.999') : null;
    return records.filter(function (row) {
      if (f.category !== 'all' && row.category !== f.category) return false;
      if (f.method !== 'all' && row.method !== f.method) return false;
      if (f.status !== 'all' && row.status !== f.status) return false;
      if (from && (!row.createdAt || row.createdAt < from)) return false;
      if (to && (!row.createdAt || row.createdAt > to)) return false;
      if (f.search) {
        const haystack = [row.donor, row.donorEmail, row.reference, row.transactionReference, row.method, categoryLabel(row)]
          .join(' ').toLowerCase();
        if (!haystack.includes(f.search)) return false;
      }
      return true;
    });
  }

  function renderMethodOptions() {
    const select = document.getElementById('givingMethodFilter');
    if (!select) return;
    const current = select.value || 'all';
    const methods = Array.from(new Set(records.map(function (row) { return row.method; }).filter(Boolean))).sort();
    select.innerHTML = '<option value="all">All methods</option>' + methods.map(function (method) {
      return '<option value="' + esc(method) + '">' + esc(method) + '</option>';
    }).join('');
    select.value = methods.includes(current) ? current : 'all';
  }

  function renderSummary(rows) {
    const host = document.getElementById('givingSummary');
    if (!host) return;
    const received = rows.filter(function (row) { return row.status === 'received'; });
    const pending = rows.filter(function (row) { return row.status === 'pending'; });
    const approved = rows.filter(function (row) { return row.status === 'approved'; });
    const totals = {};
    received.forEach(function (row) {
      totals[row.currency] = (totals[row.currency] || 0) + row.amount;
    });
    const confirmed = Object.keys(totals).sort().map(function (code) { return money(totals[code], code); }).join(' · ') || 'SZL 0.00';
    host.innerHTML =
      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px;"><span style="display:block;font-size:.7rem;color:var(--text-sub);">Confirmed contributions (received only)</span><strong style="display:block;font-size:1.15rem;margin:4px 0;">' + esc(confirmed) + '</strong><small style="color:var(--text-sub);">Pending is never counted</small></div>' +
      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px;"><span style="display:block;font-size:.7rem;color:var(--text-sub);">Awaiting review</span><strong style="display:block;font-size:1.15rem;margin:4px 0;">' + pending.length + '</strong><small style="color:var(--text-sub);">' + (pending.length ? 'Needs a decision' : 'Nothing waiting') + '</small></div>' +
      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px;"><span style="display:block;font-size:.7rem;color:var(--text-sub);">Approved, awaiting receipt</span><strong style="display:block;font-size:1.15rem;margin:4px 0;">' + approved.length + '</strong><small style="color:var(--text-sub);">Mark received after money lands</small></div>' +
      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:14px;"><span style="display:block;font-size:.7rem;color:var(--text-sub);">Received records</span><strong style="display:block;font-size:1.15rem;margin:4px 0;">' + received.length + '</strong><small style="color:var(--text-sub);">Filtered range</small></div>';
  }

  function renderRows(rows) {
    const body = document.getElementById('givingList');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text-sub);">No giving records match these filters.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (row) {
      const colour = STATUS_COLORS[row.status] || '#334155';
      const actions = [];
      actions.push('<button class="btn btn-sm btn-outline" type="button" onclick="viewGivingRecord(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-eye"></i> View</button>');
      if (row.receiptUrl || row.receiptPath) {
        actions.push('<button class="btn btn-sm btn-outline" type="button" onclick="openGivingEvidence(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-receipt-text"></i> Receipt</button>');
      }
      if (row.status === 'pending') {
        actions.push('<button class="btn btn-sm btn-primary" type="button" onclick="approveGiving(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-circle-check"></i> Approve</button>');
        actions.push('<button class="btn btn-sm btn-danger" type="button" onclick="rejectGiving(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-circle-x"></i> Reject</button>');
      } else if (row.status === 'approved') {
        actions.push('<button class="btn btn-sm btn-primary" type="button" onclick="markGivingReceived(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-banknote"></i> Mark received</button>');
        actions.push('<button class="btn btn-sm btn-danger" type="button" onclick="rejectGiving(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-circle-x"></i> Reject</button>');
      } else if (row.status === 'received') {
        actions.push('<button class="btn btn-sm btn-outline" type="button" onclick="printGivingReceipt(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-printer"></i> Receipt PDF</button>');
      }
      return '<tr>' +
        '<td>' + esc(dateLabel(row.createdAt)) + '</td>' +
        '<td><strong>' + esc(row.donor) + '</strong>' + (row.donorEmail ? '<br><small style="color:var(--text-sub);">' + esc(row.donorEmail) + '</small>' : '') + '</td>' +
        '<td>' + esc(categoryLabel(row)) + '</td>' +
        '<td><strong>' + esc(money(row.amount, row.currency)) + '</strong></td>' +
        '<td>' + esc(row.method) + '</td>' +
        '<td><code>' + esc(row.reference) + '</code>' + (row.transactionReference ? '<br><small style="color:var(--text-sub);">Tx: ' + esc(row.transactionReference) + '</small>' + (isDuplicateTransaction(row) ? '<br><span class="audit-pill" style="color:#b91c1c;border-color:#b91c1c;">Duplicate tx — check before approving</span>' : '') : '') + '</td>' +
        '<td><span class="audit-pill" style="color:' + colour + ';border-color:' + colour + ';">' + esc(statusLabel(row.status)) + '</span></td>' +
        '<td style="white-space:nowrap;">' + (actions.length ? actions.join(' ') : '—') + '</td>' +
        '<td>' + (row.receiptUrl || row.receiptPath ? '<span class="audit-pill">Attached</span>' : '<span style="color:var(--text-sub);">None</span>') + '</td>' +
      '</tr>';
    }).join('');
  }

  function render() {
    renderMethodOptions();
    const rows = filtered();
    renderSummary(rows);
    renderRows(rows);
    const count = document.getElementById('givingCount');
    if (count) count.textContent = rows.length + ' of ' + records.length + ' records';
  }

  window.loadGivingAdmin = async function () {
    if (loading) return;
    loading = true;
    const body = document.getElementById('givingList');
    if (body) body.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;">Loading giving records…</td></tr>';
    try {
      // Read every offering so the dashboard is a complete ledger. The admin
      // rules allow this; members can only read their own records.
      const snap = await getDocs(collection(bridge.db, 'offerings'));
      records = snap.docs.map(function (entry) { return normalise(entry.id, entry.data()); });
      records.sort(function (a, b) {
        return (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0);
      });
      recordsById = new Map(records.map(function (row) { return [row.id, row]; }));
      duplicateTransactionRefs = collectDuplicateTransactionRefs(records);
      render();
    } catch (error) {
      console.error('Giving records could not be loaded:', error);
      if (body) body.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;color:#b91c1c;">Could not load giving records: ' + esc(error.message || 'unknown error') + '. Check that this account is an administrator.</td></tr>';
      bridge.toast('Could not load giving records: ' + (error.message || 'unknown error'), 'error');
    } finally {
      loading = false;
    }
  };

  window.refreshGivingAdmin = function () { return window.loadGivingAdmin(); };
  window.filterGivingAdmin = function () { render(); };
  window.resetGivingFilters = function () {
    ['givingSearch', 'givingFrom', 'givingTo'].forEach(function (id) {
      const node = document.getElementById(id);
      if (node) node.value = '';
    });
    ['givingCategoryFilter', 'givingMethodFilter', 'givingStatusFilter'].forEach(function (id) {
      const node = document.getElementById(id);
      if (node) node.value = 'all';
    });
    render();
  };

  function detailRow(label, value, options) {
    const opts = options || {};
    const content = opts.html ? String(value == null ? '' : value) : esc(value == null || value === '' ? '—' : value);
    return '<div style="display:grid;grid-template-columns:160px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">' +
      '<span style="color:var(--text-sub);font-size:.78rem;">' + esc(label) + '</span><span style="overflow-wrap:anywhere;">' + content + '</span></div>';
  }

  window.viewGivingRecord = function (id) {
    const row = recordsById.get(id);
    if (!row) return bridge.toast('That record is no longer in the list. Refresh and try again.', 'error');
    const body = document.getElementById('givingDetailBody');
    const footer = document.getElementById('givingDetailActions');
    if (body) {
      body.innerHTML =
        detailRow('Reference', '<code>' + esc(row.reference) + '</code>', { html: true }) +
        detailRow('Contributor', row.donor) +
        detailRow('Email', row.donorEmail) +
        detailRow('Category', categoryLabel(row)) +
        detailRow('Amount', '<strong>' + esc(money(row.amount, row.currency)) + '</strong>', { html: true }) +
        detailRow('Method', row.method) +
        detailRow('Transaction ref', '<code>' + esc(row.transactionReference || '—') + '</code>', { html: true }) +
        detailRow('Status', '<strong style="color:' + (STATUS_COLORS[row.status] || '#334155') + ';">' + esc(statusLabel(row.status)) + '</strong>', { html: true }) +
        detailRow('Submitted', dateLabel(row.createdAt)) +
        detailRow('Received', dateLabel(row.receivedAt)) +
        detailRow('Receipt number', row.receiptNumber) +
        detailRow('Note', row.note) +
        detailRow('Rejection reason', row.rejectionReason);
    }
    if (footer) {
      const actions = [];
      if (row.receiptUrl || row.receiptPath) actions.push('<button class="btn btn-outline" type="button" onclick="openGivingEvidence(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-receipt-text"></i> Open receipt</button>');
      if (row.status === 'pending') {
        actions.push('<button class="btn btn-danger" type="button" onclick="rejectGiving(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-circle-x"></i> Reject</button>');
        actions.push('<button class="btn btn-primary" type="button" onclick="approveGiving(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-circle-check"></i> Approve</button>');
      } else if (row.status === 'approved') {
        actions.push('<button class="btn btn-danger" type="button" onclick="rejectGiving(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-circle-x"></i> Reject</button>');
        actions.push('<button class="btn btn-primary" type="button" onclick="markGivingReceived(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-banknote"></i> Mark received</button>');
      } else if (row.status === 'received') {
        actions.push('<button class="btn btn-primary" type="button" onclick="printGivingReceipt(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-printer"></i> Generate receipt</button>');
      }
      actions.push('<button class="btn btn-outline" type="button" onclick="closeModal(\'givingDetailModal\')">Close</button>');
      footer.innerHTML = actions.join(' ');
    }
    const modal = document.getElementById('givingDetailModal');
    if (modal) modal.style.display = 'flex';
  };

  async function writeAudit(action, row, extra) {
    const actor = bridge.auth && bridge.auth.currentUser ? bridge.auth.currentUser : {};
    try {
      await addDoc(collection(bridge.db, 'givingAudit'), Object.assign({
        action: action,
        offeringId: row.id,
        reference: row.reference,
        amount: row.amount,
        currency: row.currency,
        actorUid: actor.uid || '',
        actorEmail: actor.email || '',
        createdAt: serverTimestamp()
      }, extra || {}));
    } catch (error) {
      console.warn('Giving audit entry could not be written:', error && error.message);
    }
  }

  async function updateRecord(id, data, auditAction) {
    const row = recordsById.get(id);
    if (!row) throw new Error('Record not found. Refresh the list.');
    const actor = bridge.auth && bridge.auth.currentUser ? bridge.auth.currentUser : {};
    await updateDoc(doc(bridge.db, 'offerings', id), Object.assign({
      updatedAt: serverTimestamp(),
      reviewedBy: actor.uid || '',
      reviewedByEmail: actor.email || ''
    }, data));
    await writeAudit(auditAction, row, data);
    await window.loadGivingAdmin();
  }

  window.approveGiving = async function (id) {
    const row = recordsById.get(id);
    if (!row) return;
    if (!confirm('Approve ' + money(row.amount, row.currency) + ' from ' + row.donor + '?\n\n' + (isDuplicateTransaction(row) ? 'WARNING: this transaction reference is also used by another giving record. Check both before approving.\n\n' : '') + 'Approval records that the evidence looks correct. The money is still not counted until you mark it received.')) return;
    try {
      window.showLoading();
      await updateRecord(id, {
        status: 'approved',
        approvedAt: serverTimestamp(),
        approvedBy: bridge.auth.currentUser ? bridge.auth.currentUser.uid : ''
      }, 'offering_approved');
      bridge.toast('Giving approved. Mark it received once the money is confirmed in the ministry account.');
      window.closeModal && window.closeModal('givingDetailModal');
    } catch (error) {
      bridge.toast(error.message || 'Could not approve this record.', 'error');
    } finally {
      window.hideLoading();
    }
  };

  window.rejectGiving = async function (id) {
    const row = recordsById.get(id);
    if (!row) return;
    const reason = prompt('Why is this giving record being rejected? (shown to Finance; recorded in the audit log)', row.rejectionReason || '');
    if (reason === null) return;
    const clean = String(reason).trim();
    if (clean.length < 4) return bridge.toast('Give a short reason (at least 4 characters).', 'error');
    if (!confirm('Reject ' + money(row.amount, row.currency) + ' from ' + row.donor + '?')) return;
    try {
      window.showLoading();
      await updateRecord(id, {
        status: 'rejected',
        rejectionReason: clean.slice(0, 500),
        rejectedAt: serverTimestamp(),
        rejectedBy: bridge.auth.currentUser ? bridge.auth.currentUser.uid : ''
      }, 'offering_rejected');
      bridge.toast('Giving rejected and recorded in the audit log.');
      window.closeModal && window.closeModal('givingDetailModal');
    } catch (error) {
      bridge.toast(error.message || 'Could not reject this record.', 'error');
    } finally {
      window.hideLoading();
    }
  };

  window.markGivingReceived = async function (id) {
    const row = recordsById.get(id);
    if (!row) return;
    if (isDuplicateTransaction(row) && !confirm('WARNING: this transaction reference is also used by another giving record. Mark it received anyway?')) return;
    if (!confirm('Mark ' + money(row.amount, row.currency) + ' from ' + row.donor + ' as received?\n\nThis is the only action that adds the gift to confirmed contribution totals.')) return;
    const receiptNumber = row.receiptNumber || ('PD-RCPT-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + row.reference.slice(-6).toUpperCase());
    try {
      window.showLoading();
      await updateRecord(id, {
        status: 'received',
        receivedAt: serverTimestamp(),
        confirmedAt: serverTimestamp(),
        receivedBy: bridge.auth.currentUser ? bridge.auth.currentUser.uid : '',
        confirmedBy: bridge.auth.currentUser ? bridge.auth.currentUser.uid : '',
        receiptNumber: receiptNumber
      }, 'offering_received');
      bridge.toast('Giving marked received. It now counts in confirmed contributions. Receipt ' + receiptNumber + '.');
      window.closeModal && window.closeModal('givingDetailModal');
    } catch (error) {
      bridge.toast(error.message || 'Could not mark this record received.', 'error');
    } finally {
      window.hideLoading();
    }
  };

  window.openGivingEvidence = function (id) {
    const row = recordsById.get(id);
    if (!row) return;
    const url = String(row.receiptUrl || '');
    if (!/^https:\/\//i.test(url)) {
      bridge.toast(row.receiptPath ? 'Open this file from Firebase Storage using the path shown in the record.' : 'No receipt was attached to this gift.', 'error');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  window.printGivingReceipt = function (id) {
    const row = recordsById.get(id);
    if (!row) return;
    if (row.status !== 'received') {
      bridge.toast('Mark the gift received before issuing a receipt.', 'error');
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      bridge.toast('Allow pop-ups for the admin console to open the printable receipt.', 'error');
      return;
    }
    const number = row.receiptNumber || ('PD-RCPT-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + row.reference.slice(-6).toUpperCase());
    const received = row.receivedAt instanceof Date ? row.receivedAt : (row.receivedAt && row.receivedAt.toDate ? row.receivedAt.toDate() : new Date());
    win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc('Giving receipt ' + number) + '</title>' +
      '<style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;padding:0 24px;color:#102a43;}h1{font-size:24px;margin:0;}h2{font-size:16px;letter-spacing:.08em;text-transform:uppercase;color:#0a4d9b;}table{width:100%;border-collapse:collapse;margin:24px 0;}td,th{border-bottom:1px solid #d9e2ec;padding:10px 8px;text-align:left;font-size:14px;}th{color:#627d98;font-weight:600;width:38%;}.brand{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #d4af37;padding-bottom:16px;}.muted{color:#627d98;font-size:12px;line-height:1.5;}.amount{font-size:28px;font-weight:700;color:#0a4d9b;}</style></head><body>' +
      '<div class="brand"><div><h1>PRAYER DOME</h1><div class="muted">Official giving receipt</div></div><div style="text-align:right;"><strong>' + esc(number) + '</strong><div class="muted">' + esc(dateLabel(received)) + '</div></div></div>' +
      '<h2>Received with thanks</h2><table>' +
      '<tr><th>Contributor</th><td>' + esc(row.donor) + '</td></tr>' +
      '<tr><th>Category</th><td>' + esc(categoryLabel(row)) + '</td></tr>' +
      '<tr><th>Payment method</th><td>' + esc(row.method) + '</td></tr>' +
      '<tr><th>Transaction reference</th><td>' + esc(row.transactionReference || '—') + '</td></tr>' +
      '<tr><th>Giving reference</th><td>' + esc(row.reference) + '</td></tr>' +
      '<tr><th>Received on</th><td>' + esc(dateLabel(received)) + '</td></tr>' +
      '</table><div class="amount">' + esc(money(row.amount, row.currency)) + '</div>' +
      '<p class="muted">This receipt confirms that the gift above was checked by the PRAYER DOME finance team and recorded against the church account. It is a giving record, not a tax certificate. PRAYER DOME · prayerdome.net · info@prayerdome.net</p>' +
      '<p class="muted">Receipt ' + esc(number) + ' · printed ' + esc(new Date().toLocaleString('en-GB')) + '</p>' +
      '<script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script></body></html>');
    win.document.close();
  };

  window.downloadGivingCsv = function () {
    const rows = filtered();
    if (!rows.length) return bridge.toast('There are no filtered giving records to export.', 'error');
    const header = ['Date', 'Contributor', 'Email', 'Category', 'Amount', 'Currency', 'Method', 'Transaction reference', 'Giving reference', 'Status', 'Received date', 'Receipt number'];
    const cell = function (value) {
      const text = String(value == null ? '' : value).replace(/"/g, '""');
      return '"' + text + '"';
    };
    const lines = [header.map(cell).join(',')].concat(rows.map(function (row) {
      return [dateLabel(row.createdAt), row.donor, row.donorEmail, categoryLabel(row), row.amount.toFixed(2), row.currency, row.method, row.transactionReference, row.reference, statusLabel(row.status), dateLabel(row.receivedAt), row.receiptNumber].map(cell).join(',');
    }));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'prayer-dome-giving-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    bridge.toast('Exported ' + rows.length + ' giving records.');
  };

  window.PDGivingAdmin = {
    loadGivingAdmin: window.loadGivingAdmin,
    refresh: window.refreshGivingAdmin
  };
})();
