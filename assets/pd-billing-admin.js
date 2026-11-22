/*!
 * Prayer Dome — administrator billing workspace
 * ---------------------------------------------------------------------------
 * Payment verification, subscriptions, wallet transactions, wallet balances,
 * support plans and the audit trail. Every approval and rejection goes through
 * the `billing` callable; this file never writes a balance or an active plan
 * directly.
 */
(function () {
  'use strict';

  const bridge = window.PDAdmin;
  if (!bridge) {
    console.error('Billing admin module: PDAdmin bridge is missing.');
    return;
  }
  const store = bridge.firestore;
  const Billing = window.PDBilling;
  const {
    collection, getDocs, getDoc, doc, query, orderBy, limit
  } = store;

  let payments = [];
  let subscriptions = [];
  let walletTransactions = [];
  let wallets = [];
  let plans = [];
  let activity = [];

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const money = (amount, currency) => Billing ? Billing.money(amount, currency || 'USD') : '$' + Number(amount || 0).toFixed(2);
  const date = (value) => Billing ? Billing.formatDate(value) : '';
  const statusLabel = (status) => Billing ? Billing.statusLabel(status) : String(status || '').replace(/_/g, ' ');
  const statusTone = (status) => Billing ? Billing.statusTone(status) : 'warn';
  const chip = (status) => '<span class="audit-pill ' + statusTone(status) + '">' + esc(statusLabel(status)) + '</span>';
  const loadingRow = (columns, text) => '<tr><td colspan="' + columns + '">' + esc(text) + '</td></tr>';
  const emptyRow = (columns, text) => '<tr><td colspan="' + columns + '" style="text-align:center;color:var(--text-sub);">' + esc(text) + '</td></tr>';

  function toDate(value) {
    return Billing ? Billing.toDate(value) : null;
  }

  function memberName(uid) {
    const cache = window.dashboardPerformanceCache && Array.isArray(window.dashboardPerformanceCache.members)
      ? window.dashboardPerformanceCache.members : [];
    const row = cache.filter((item) => item.id === uid)[0];
    return row ? (row.fullName || row.email || uid) : uid;
  }

  async function callBilling(action, payload) {
    try {
      const callable = bridge.httpsCallable(bridge.cloudFunctions, 'billing');
      const result = await callable(Object.assign({ action }, payload || {}));
      return result.data || {};
    } catch (error) {
      const raw = error && error.message ? error.message : 'The billing service could not be reached.';
      throw new Error(/not found|unavailable|internal/i.test(raw)
        ? 'Billing is temporarily unavailable. Deploy the functions and try again.'
        : raw.replace(/^FirebaseError:\s*/i, ''));
    }
  }

  function refreshAfter(action) {
    if (typeof window.toast === 'function') window.toast(action, 'success');
    Promise.allSettled([
      window.loadPayments ? window.loadPayments() : null,
      window.loadSubscriptions ? window.loadSubscriptions() : null,
      window.loadWalletTransactions ? window.loadWalletTransactions() : null,
      window.loadWalletBalances ? window.loadWalletBalances() : null
    ]).then(() => {
      if (typeof window.loadDashboardPerformance === 'function') window.loadDashboardPerformance();
    });
  }

  /* ---------------------------------------------------------------- dashboard */
  function countSince(rows, fields, days) {
    const floor = new Date();
    floor.setDate(floor.getDate() - days);
    return rows.filter((row) => {
      for (const field of fields) {
        const value = toDate(row[field]);
        if (value && value.getTime() >= floor.getTime()) return true;
      }
      return false;
    }).length;
  }

  window.renderAdminOverview = function () {
    const host = document.getElementById('adminOverviewCards');
    if (!host) return;
    const cache = window.dashboardPerformanceCache || {};
    const members = cache.members || [];
    const paymentRows = cache.payments || [];
    const subs = cache.subscriptions || [];
    const now = new Date();
    const activeSubs = subs.filter((row) => Billing.effectiveStatus(row, now) === 'active');
    const awaiting = paymentRows.filter((row) => row.status === 'pending_verification');
    const approvedPayments = paymentRows.filter((row) => row.status === 'approved' && countSince([row], ['approvedAt', 'updatedAt'], 30) > 0);
    const walletRows = cache.walletTransactions || [];
    const walletAccounts = cache.wallets || [];
    const walletTotal = walletAccounts.reduce((sum, row) => sum + Number(row.balance || 0), 0);
    const cards = [
      { icon: 'pd-i-users', tone: 'blue', value: members.length, label: 'Registered members' },
      { icon: 'pd-i-user-check', tone: 'green', value: members.filter((row) => row.status === 'approved').length, label: 'Active / approved members' },
      { icon: 'pd-i-user-plus', tone: 'gold', value: countSince(members, ['createdAt', 'joinedAt'], 30), label: 'New members · 30 days' },
      { icon: 'pd-i-clock', tone: 'red', value: members.filter((row) => row.status === 'pending').length, label: 'Pending approvals' },
      { icon: 'pd-i-refresh-cw', tone: 'green', value: activeSubs.length, label: 'Active subscriptions' },
      { icon: 'pd-i-shield-check', tone: 'gold', value: awaiting.length, label: 'Payments to verify' },
      { icon: 'pd-i-receipt-text', tone: 'blue', value: approvedPayments.length, label: 'Verified payments · 30 days' },
      { icon: 'pd-i-banknote', tone: 'green', value: money(walletTotal, 'USD'), label: 'Member wallet balances' },
      { icon: 'pd-i-arrow-left-right', tone: 'blue', value: countSince(walletRows, ['createdAt', 'at'], 30), label: 'Wallet transactions · 30 days' },
      { icon: 'pd-i-hand-heart', tone: 'red', value: (cache.claims || []).filter((row) => row.status === 'pending').length, label: 'Claims awaiting review' }
    ];
    host.innerHTML = cards.map((card) =>
      '<div class="kpi-card"><div class="kpi-icon ' + card.tone + '"><i class="pd-i ' + card.icon + '"></i></div>' +
      '<div class="kpi-details"><h3>' + card.value + '</h3><p>' + esc(card.label) + '</p></div></div>'
    ).join('');
  };

  window.renderBillingSnapshot = function () {
    const cache = window.dashboardPerformanceCache || {};
    const paymentsBody = document.getElementById('dashRecentPayments');
    const subsBody = document.getElementById('dashRecentSubscriptions');
    const walletBody = document.getElementById('dashRecentWalletTransactions');
    if (paymentsBody) {
      const rows = (cache.payments || []).slice(0, 5);
      paymentsBody.innerHTML = rows.length ? rows.map((row) => '<tr>' +
        '<td><strong>' + esc(row.planName || row.planId || 'Payment') + '</strong><br><span style="font-family:monospace;font-size:.66rem;color:var(--text-sub);">' + esc(row.reference || row.id) + '</span></td>' +
        '<td>' + esc(row.userName || memberName(row.userId)) + '</td>' +
        '<td>' + esc(money(row.amount, row.currency)) + '</td>' +
        '<td>' + chip(row.status) + '</td>' +
        '<td style="white-space:nowrap;">' + esc(date(row.createdAt)) + '</td>' +
      '</tr>').join('') : emptyRow(5, 'No payment requests yet.');
    }
    if (subsBody) {
      const now = new Date();
      const rows = (cache.subscriptions || []).slice(0, 5);
      subsBody.innerHTML = rows.length ? rows.map((row) => {
        const end = row.currentPeriodEnd || row.expiresAt || row.renewsAt || row.endsAt;
        return '<tr>' +
          '<td>' + esc(row.planName || row.planId || 'Subscription') + '</td>' +
          '<td>' + esc(row.userName || memberName(row.userId)) + '</td>' +
          '<td>' + esc(row.program || row.category || '—') + '</td>' +
          '<td>' + chip(Billing ? Billing.effectiveStatus(row, now) : row.status) + '</td>' +
          '<td style="white-space:nowrap;">' + esc(end ? date(end) : '—') + '</td>' +
        '</tr>';
      }).join('') : emptyRow(5, 'No subscriptions yet.');
    }
    if (walletBody) {
      const rows = (cache.walletTransactions || []).slice(0, 5);
      walletBody.innerHTML = rows.length ? rows.map((row) => '<tr>' +
        '<td><span style="font-family:monospace;font-size:.66rem;">' + esc(row.reference || row.id) + '</span></td>' +
        '<td>' + esc(row.userName || memberName(row.userId)) + '</td>' +
        '<td>' + esc(row.type || row.kind || 'Transaction') + '</td>' +
        '<td>' + esc(money(row.amount, row.currency)) + '</td>' +
        '<td style="white-space:nowrap;">' + esc(date(row.createdAt || row.at)) + '</td>' +
      '</tr>').join('') : emptyRow(5, 'No wallet transactions yet.');
    }
  };

  /* -------------------------------------------------------- payment verification */
  window.loadPayments = async function () {
    const body = document.getElementById('paymentList');
    if (!body) return;
    body.innerHTML = loadingRow(9, 'Loading payment requests…');
    try {
      const snapshot = await getDocs(query(collection(bridge.db, 'paymentRequests'), orderBy('createdAt', 'desc'), limit(250)));
      payments = snapshot.docs.map((entry) => Object.assign({ id: entry.id }, entry.data()));
      renderPayments();
    } catch (error) {
      console.error('Payment load failed:', error);
      body.innerHTML = emptyRow(9, 'Payment requests could not be loaded: ' + error.message);
      const summary = document.getElementById('paymentSummary');
      if (summary) summary.textContent = 'Unavailable';
    }
  };

  function paymentMatchesFilter(row, filter) {
    if (filter === 'all') return true;
    if (filter === 'open') return ['pending_payment', 'pending_verification'].includes(row.status);
    if (filter === 'awaiting') return row.status === 'pending_verification';
    return row.status === filter;
  }

  window.filterPayments = function () {
    renderPayments();
  };

  function renderPayments() {
    const body = document.getElementById('paymentList');
    if (!body) return;
    const filter = (document.getElementById('paymentStatusFilter') || {}).value || 'awaiting';
    const search = String((document.getElementById('paymentSearch') || {}).value || '').trim().toLowerCase();
    const rows = payments.filter((row) => {
      if (!paymentMatchesFilter(row, filter)) return false;
      if (!search) return true;
      return [row.reference, row.userName, row.userEmail, row.planName, row.planId, row.program]
        .join(' ').toLowerCase().includes(search);
    });
    const awaiting = payments.filter((row) => row.status === 'pending_verification').length;
    const open = payments.filter((row) => ['pending_payment', 'pending_verification'].includes(row.status)).length;
    const approved = payments.filter((row) => row.status === 'approved').length;
    const summary = document.getElementById('paymentSummary');
    if (summary) summary.textContent = awaiting + ' awaiting · ' + open + ' open · ' + approved + ' approved';
    if (!rows.length) {
      body.innerHTML = emptyRow(9, 'No payment requests match this filter.');
      return;
    }
    body.innerHTML = rows.map((row) => {
      const evidence = (row.evidencePath || row.evidenceUrl)
        ? '<button class="btn btn-outline btn-sm" type="button" onclick="openPaymentReview(\'' + esc(row.reference) + '\')"><i class="pd-i pd-i-eye"></i> View</button>'
        : '<span style="font-size:.72rem;color:var(--text-sub);">No receipt</span>';
      return '<tr>' +
        '<td>' + esc(date(row.createdAt)) + '</td>' +
        '<td style="font-family:monospace;font-size:.72rem;word-break:break-all;">' + esc(row.reference) + '</td>' +
        '<td><strong>' + esc(row.userName || 'Member') + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(row.userEmail || '') + '</span></td>' +
        '<td>' + esc(row.planName || (row.kind === 'wallet_deposit' ? 'Wallet deposit' : 'Support plan')) + '</td>' +
        '<td><strong>' + money(row.amount, row.currency) + '</strong></td>' +
        '<td>' + esc(row.method || 'mobile-money') + '</td>' +
        '<td>' + chip(row.status) + '</td>' +
        '<td>' + evidence + '</td>' +
        '<td><button class="btn btn-primary btn-sm" type="button" onclick="openPaymentReview(\'' + esc(row.reference) + '\')"><i class="pd-i pd-i-shield-check"></i> Review</button></td>' +
      '</tr>';
    }).join('');
  }

  window.openPaymentReview = async function (reference) {
    const body = document.getElementById('paymentReviewBody');
    const actions = document.getElementById('paymentReviewActions');
    if (!body || !actions) return;
    body.innerHTML = '<div class="spinner" style="width:28px;height:28px;margin:18px auto;"></div>';
    actions.innerHTML = '<button class="btn btn-outline" onclick="closeModal(\'modalPaymentReview\')">Close</button>';
    document.getElementById('modalPaymentReview').style.display = 'flex';
    let row = payments.filter((item) => item.reference === reference)[0];
    if (!row) {
      try {
        const snapshot = await getDoc(doc(bridge.db, 'paymentRequests', reference));
        if (snapshot.exists()) row = Object.assign({ id: snapshot.id }, snapshot.data());
      } catch (error) { /* handled below */ }
    }
    if (!row) {
      body.innerHTML = '<p>Payment request not found.</p>';
      return;
    }
    const evidence = row.evidenceUrl
      ? (/\.pdf($|\?)/i.test(row.evidenceUrl)
        ? '<a class="btn btn-outline btn-sm" href="' + esc(evidenceSource) + '" target="_blank" rel="noopener"><i class="pd-i pd-i-file-text"></i> Open PDF receipt</a>'
        : '<a href="' + esc(evidenceSource) + '" target="_blank" rel="noopener"><img src="' + esc(evidenceSource) + '" alt="Payment receipt" style="max-width:100%;max-height:320px;border-radius:12px;border:1px solid var(--border);"></a>')
      : '<p style="color:var(--pd-red);font-weight:700;">No receipt has been uploaded. This payment cannot be approved.</p>';
    const details = [
      ['Reference', row.reference],
      ['Member', row.userName || row.userEmail || row.userId],
      ['Plan / deposit', row.planName || (row.kind === 'wallet_deposit' ? 'Wallet deposit' : 'Support plan')],
      ['Amount', money(row.amount, row.currency)],
      ['Method', row.method || 'mobile-money'],
      ['Status', statusLabel(row.status)],
      ['Created', date(row.createdAt)],
      ['Submitted', date(row.submittedAt)],
      ['Approved by', row.approvedBy || ''],
      ['Rejection reason', row.rejectionReason || '']
    ].filter((item) => item[1]);
    body.innerHTML =
      '<dl class="verify-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:8px;margin:0 0 16px;">' +
        details.map((item) => '<div style="background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:8px 10px;min-width:0;"><dt style="font-size:.58rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:var(--text-sub);">' + esc(item[0]) + '</dt><dd style="margin:3px 0 0;font-size:.82rem;font-weight:700;overflow-wrap:break-word;">' + esc(item[1]) + '</dd></div>').join('') +
      '</dl>' +
      '<h3 style="font-size:.92rem;margin:0 0 8px;">Payment evidence</h3>' + evidence +
      (row.status === 'pending_verification' ?
        '<div style="margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-elev);">' +
          '<label style="display:flex;gap:10px;align-items:flex-start;font-size:.8rem;line-height:1.5;font-weight:700;"><input id="payVerifiedCheck" type="checkbox" style="width:18px;height:18px;margin-top:1px;"> I checked this receipt against the ministry Mobile Money / bank account and the exact amount and reference match.</label>' +
          '<div class="form-group" style="margin-top:12px;"><label>Verification note (optional)</label><textarea id="payVerificationNote" class="form-control" rows="2" maxlength="500" placeholder="e.g. Matched MTN statement 22 Nov, ref on receipt"></textarea></div>' +
        '</div>' : '') +
      (row.status === 'approved' ? '<p style="margin-top:16px;padding:12px 14px;border-radius:10px;background:rgba(16,185,129,.1);color:#047857;font-weight:700;font-size:.8rem;">Approved by ' + esc(row.approvedBy || 'an administrator') + '. ' + esc(row.verificationNote || '') + '</p>' : '');
    actions.innerHTML =
      (row.status === 'pending_verification'
        ? '<button class="btn btn-danger" type="button" onclick="rejectPayment(\'' + esc(row.reference) + '\')"><i class="pd-i pd-i-circle-x"></i> Reject</button>' +
          '<button class="btn btn-primary" type="button" onclick="confirmApprovePayment(\'' + esc(row.reference) + '\')"><i class="pd-i pd-i-shield-check"></i> Approve verified payment</button>'
        : '<button class="btn btn-outline" type="button" onclick="closeModal(\'modalPaymentReview\')">Close</button>');
  };

  window.confirmApprovePayment = async function (reference) {
    const checkbox = document.getElementById('payVerifiedCheck');
    if (!checkbox || !checkbox.checked) {
      if (typeof window.toast === 'function') window.toast('Tick the verification box first. A receipt alone is not proof.', 'error');
      return;
    }
    const note = (document.getElementById('payVerificationNote') || {}).value || '';
    window.showLoading();
    try {
      const result = await callBilling('payment.approve', { reference, confirmed: true, note });
      window.hideLoading();
      window.closeModal('modalPaymentReview');
      refreshAfter(result && result.status === 'active' ? 'Payment approved — subscription activated.' : 'Payment approved and wallet credited.');
    } catch (error) {
      window.hideLoading();
      if (typeof window.toast === 'function') window.toast(error.message, 'error');
    }
  };

  window.rejectPayment = async function (reference) {
    const reason = window.prompt('Why is this payment rejected? The member sees this reason.');
    if (!reason || reason.trim().length < 4) return;
    window.showLoading();
    try {
      await callBilling('payment.reject', { reference, reason: reason.trim() });
      window.hideLoading();
      window.closeModal('modalPaymentReview');
      refreshAfter('Payment rejected. No plan was activated and no wallet balance changed.');
    } catch (error) {
      window.hideLoading();
      if (typeof window.toast === 'function') window.toast(error.message, 'error');
    }
  };

  /* ------------------------------------------------------------- subscriptions */
  window.loadSubscriptions = async function () {
    const body = document.getElementById('subscriptionList');
    if (!body) return;
    body.innerHTML = loadingRow(9, 'Loading subscriptions…');
    try {
      const snapshot = await getDocs(query(collection(bridge.db, 'subscriptions'), orderBy('updatedAt', 'desc'), limit(250)));
      subscriptions = snapshot.docs.map((entry) => Object.assign({ id: entry.id }, entry.data()));
      renderSubscriptions();
    } catch (error) {
      console.error('Subscriptions load failed:', error);
      body.innerHTML = emptyRow(9, 'Subscriptions could not be loaded: ' + error.message);
    }
  };

  window.filterSubscriptions = function () { renderSubscriptions(); };

  function renderSubscriptions() {
    const body = document.getElementById('subscriptionList');
    if (!body) return;
    const filter = (document.getElementById('subscriptionStatusFilter') || {}).value || 'all';
    const search = String((document.getElementById('subscriptionSearch') || {}).value || '').trim().toLowerCase();
    const now = new Date();
    const rows = subscriptions.map((row) => Object.assign({}, row, { effective: Billing.effectiveStatus(row, now) })).filter((row) => {
      if (filter !== 'all' && row.effective !== filter) return false;
      if (!search) return true;
      return [row.userName, row.userEmail, row.planName, row.paymentRef, row.pendingPaymentRef, row.id]
        .join(' ').toLowerCase().includes(search);
    });
    const active = subscriptions.filter((row) => Billing.effectiveStatus(row, now) === 'active');
    const mrr = active.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const summary = document.getElementById('subscriptionSummary');
    if (summary) summary.textContent = active.length + ' active · ' + money(mrr, 'USD') + '/mo · ' + subscriptions.length + ' records';
    if (!rows.length) {
      body.innerHTML = emptyRow(9, 'No subscriptions match this filter.');
      return;
    }
    body.innerHTML = rows.map((row) => {
      const payment = row.pendingPaymentRef || row.paymentRef || '';
      return '<tr>' +
        '<td><strong>' + esc(row.userName || memberName(row.userId)) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(row.userEmail || row.userId) + '</span></td>' +
        '<td>' + esc(row.planName || row.planId) + '<br><span style="font-size:.68rem;color:var(--text-sub);">' + esc(row.program || '') + ' · ' + esc(row.tier || '') + '</span></td>' +
        '<td><strong>' + money(row.amount, row.currency) + '</strong></td>' +
        '<td>' + chip(row.effective) + '</td>' +
        '<td>' + esc(date(row.activatedAt || row.startDate)) + '</td>' +
        '<td>' + esc(date(row.expiresAt || row.renewalDate)) + '</td>' +
        '<td>' + esc(date(row.programExpiresAt)) + '</td>' +
        '<td style="font-family:monospace;font-size:.68rem;word-break:break-all;">' + esc(payment || '—') + '</td>' +
        '<td><div style="display:flex;gap:5px;flex-wrap:wrap;">' +
          (payment ? '<button class="btn btn-outline btn-sm" type="button" onclick="openPaymentReview(\'' + esc(payment) + '\')"><i class="pd-i pd-i-receipt-text"></i> Payment</button>' : '') +
          (row.userId ? '<button class="btn btn-outline btn-sm" type="button" onclick="viewFullMemberDetails(\'' + esc(row.userId) + '\')"><i class="pd-i pd-i-user"></i> Member</button>' : '') +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  window.expireSubscriptionsNow = async function () {
    if (!window.confirm('Mark every active subscription whose expiry has passed as expired?')) return;
    window.showLoading();
    try {
      const result = await callBilling('subscriptions.expire', {});
      window.hideLoading();
      refreshAfter((result.expired || 0) + ' subscriptions marked expired.');
    } catch (error) {
      window.hideLoading();
      if (typeof window.toast === 'function') window.toast(error.message, 'error');
    }
  };

  /* --------------------------------------------------------- wallet transactions */
  window.loadWalletTransactions = async function () {
    const body = document.getElementById('walletTxList');
    if (!body) return;
    body.innerHTML = loadingRow(8, 'Loading wallet transactions…');
    try {
      const snapshot = await getDocs(query(collection(bridge.db, 'walletTransactions'), orderBy('createdAt', 'desc'), limit(300)));
      walletTransactions = snapshot.docs.map((entry) => Object.assign({ id: entry.id }, entry.data()));
      renderWalletTransactions();
    } catch (error) {
      console.error('Wallet transaction load failed:', error);
      body.innerHTML = emptyRow(8, 'Wallet transactions could not be loaded: ' + error.message);
    }
  };

  window.filterWalletTransactions = function () { renderWalletTransactions(); };

  function renderWalletTransactions() {
    const body = document.getElementById('walletTxList');
    if (!body) return;
    const filter = (document.getElementById('walletTxStatusFilter') || {}).value || 'all';
    const search = String((document.getElementById('walletTxSearch') || {}).value || '').trim().toLowerCase();
    const rows = walletTransactions.filter((row) => {
      if (filter !== 'all' && row.status !== filter) return false;
      if (!search) return true;
      return [row.userName, row.userId, row.reference, row.type, row.status].join(' ').toLowerCase().includes(search);
    });
    const approved = walletTransactions.filter((row) => row.status === 'approved');
    const credits = approved.filter((row) => row.direction !== 'out').reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const summary = document.getElementById('walletTxSummary');
    if (summary) summary.textContent = approved.length + ' approved · ' + money(credits, 'USD') + ' credited · ' + walletTransactions.length + ' records';
    if (!rows.length) {
      body.innerHTML = emptyRow(8, 'No wallet transactions match this filter.');
      return;
    }
    body.innerHTML = rows.map((row) => '<tr>' +
      '<td>' + esc(date(row.createdAt)) + '</td>' +
      '<td>' + esc(row.userName || memberName(row.userId)) + '</td>' +
      '<td>' + esc(row.type || 'deposit') + '</td>' +
      '<td><strong>' + money(row.amount, row.currency) + '</strong></td>' +
      '<td>' + chip(row.status) + '</td>' +
      '<td style="font-family:monospace;font-size:.7rem;word-break:break-all;">' + esc(row.reference || '') + '</td>' +
      '<td>' + (row.balanceAfter != null ? money(row.balanceAfter, row.currency) : '—') + '</td>' +
      '<td><div style="display:flex;gap:5px;flex-wrap:wrap;">' +
        (row.reference ? '<button class="btn btn-outline btn-sm" type="button" onclick="openPaymentReview(\'' + esc(row.reference) + '\')"><i class="pd-i pd-i-receipt-text"></i> Payment</button>' : '') +
        (row.userId ? '<button class="btn btn-outline btn-sm" type="button" onclick="viewFullMemberDetails(\'' + esc(row.userId) + '\')"><i class="pd-i pd-i-user"></i> Member</button>' : '') +
      '</div></td>' +
    '</tr>').join('');
  }

  /* ------------------------------------------------------------ wallet balances */
  window.loadWalletBalances = async function () {
    const body = document.getElementById('walletList');
    if (!body) return;
    body.innerHTML = loadingRow(6, 'Loading wallets…');
    try {
      const snapshot = await getDocs(query(collection(bridge.db, 'wallets'), orderBy('balance', 'desc'), limit(300)));
      wallets = snapshot.docs.map((entry) => Object.assign({ id: entry.id }, entry.data()));
      renderWallets();
    } catch (error) {
      console.error('Wallet balances load failed:', error);
      body.innerHTML = emptyRow(6, 'Wallets could not be loaded: ' + error.message);
    }
  };

  window.filterWallets = function () { renderWallets(); };

  function renderWallets() {
    const body = document.getElementById('walletList');
    if (!body) return;
    const search = String((document.getElementById('walletSearch') || {}).value || '').trim().toLowerCase();
    const rows = wallets.filter((row) => !search || [row.id, row.userId, memberName(row.userId)].join(' ').toLowerCase().includes(search));
    const total = wallets.reduce((sum, row) => sum + Number(row.balance || 0), 0);
    const summary = document.getElementById('walletSummary');
    if (summary) summary.textContent = wallets.length + ' wallets · ' + money(total, 'USD') + ' held';
    if (!rows.length) {
      body.innerHTML = emptyRow(6, 'No wallets match this filter.');
      return;
    }
    body.innerHTML = rows.map((row) => '<tr>' +
      '<td><strong>' + esc(memberName(row.userId || row.id)) + '</strong></td>' +
      '<td style="font-family:monospace;font-size:.7rem;word-break:break-all;">' + esc(row.userId || row.id) + '</td>' +
      '<td><strong>' + money(row.balance, row.currency) + '</strong></td>' +
      '<td>' + esc(row.currency || 'USD') + '</td>' +
      '<td>' + esc(date(row.updatedAt || row.createdAt)) + '</td>' +
      '<td><button class="btn btn-outline btn-sm" type="button" onclick="viewFullMemberDetails(\'' + esc(row.userId || row.id) + '\')"><i class="pd-i pd-i-user"></i> Member</button></td>' +
    '</tr>').join('');
  }

  /* --------------------------------------------------------------- support plans */
  function normalizePlan(row, id) {
    return Billing.normalizePlan(row, id);
  }

  window.loadSupportPlansAdmin = async function () {
    const body = document.getElementById('supportPlanList');
    if (!body) return;
    body.innerHTML = loadingRow(8, 'Loading plans…');
    try {
      const snapshot = await getDocs(collection(bridge.db, 'supportPlans'));
      plans = snapshot.docs.map((entry) => normalizePlan(entry.data(), entry.id)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      renderPlans();
    } catch (error) {
      console.error('Plans load failed:', error);
      body.innerHTML = emptyRow(8, 'Plans could not be loaded: ' + error.message);
    }
  };

  function renderPlans() {
    const body = document.getElementById('supportPlanList');
    if (!body) return;
    if (!plans.length) {
      body.innerHTML = emptyRow(8, 'No plans saved yet. Use “Install standard plans” to publish the standard catalogue.');
      return;
    }
    body.innerHTML = plans.map((plan) => '<tr>' +
      '<td>' + Number(plan.order) + '</td>' +
      '<td><strong>' + esc(plan.name) + '</strong><br><span style="font-size:.7rem;color:var(--text-sub);">' + esc(plan.id) + '</span></td>' +
      '<td>' + esc(plan.program) + '</td>' +
      '<td>' + esc(plan.tier || '—') + '</td>' +
      '<td><strong>' + money(plan.price, plan.currency) + '</strong></td>' +
      '<td>' + esc(plan.billingPeriod) + '</td>' +
      '<td><span class="audit-pill ' + (plan.active ? 'ok' : 'bad') + '">' + (plan.active ? 'Active' : 'Hidden') + '</span></td>' +
      '<td><div style="display:flex;gap:5px;flex-wrap:wrap;">' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="openPlanEditor(\'' + esc(plan.id) + '\')"><i class="pd-i pd-i-square-pen"></i> Edit</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="toggleSupportPlan(\'' + esc(plan.id) + '\')"><i class="pd-i ' + (plan.active ? 'pd-i-eye-off' : 'pd-i-eye') + '"></i> ' + (plan.active ? 'Hide' : 'Show') + '</button>' +
      '</div></td>' +
    '</tr>').join('');
  }

  function planPayload(plan) {
    return {
      id: plan.id,
      name: plan.name,
      program: plan.program,
      claimType: plan.claimType || plan.program,
      tier: plan.tier,
      price: Number(plan.price),
      currency: 'USD',
      billingPeriod: plan.billingPeriod || 'monthly',
      durationMonths: Number(plan.durationMonths) || 1,
      programMonths: Number(plan.programMonths) || 12,
      order: Number(plan.order) || 100,
      active: plan.active !== false,
      theme: plan.theme || String(plan.program || '').toLowerCase(),
      summary: plan.summary || '',
      benefits: plan.benefits || [],
      paymentInstructions: plan.paymentInstructions || (Billing && Billing.PAYMENT_INSTRUCTIONS) || ''
    };
  }

  window.openPlanEditor = function (id) {
    const plan = id ? plans.filter((row) => row.id === id)[0] : null;
    document.getElementById('planId').value = plan ? plan.id : '';
    document.getElementById('planId').readOnly = !!plan;
    document.getElementById('planProgram').value = plan ? plan.program : 'Education';
    document.getElementById('planTier').value = plan ? plan.tier || '' : '';
    document.getElementById('planPrice').value = plan ? plan.price : '';
    document.getElementById('planOrder').value = plan ? plan.order : 100;
    document.getElementById('planActive').checked = plan ? plan.active !== false : true;
    document.getElementById('planName').value = plan ? plan.name : '';
    document.getElementById('planSummary').value = plan ? plan.summary || '' : '';
    document.getElementById('planBenefits').value = plan ? (plan.benefits || []).join('\n') : '';
    document.getElementById('planInstructions').value = plan ? plan.paymentInstructions || '' : (Billing ? Billing.PAYMENT_INSTRUCTIONS : '');
    document.getElementById('modalPlanEditor').style.display = 'flex';
  };

  window.saveSupportPlan = async function () {
    const id = String(document.getElementById('planId').value || '').trim().toLowerCase();
    const payload = planPayload({
      id,
      name: String(document.getElementById('planName').value || '').trim(),
      program: document.getElementById('planProgram').value,
      tier: String(document.getElementById('planTier').value || '').trim(),
      price: Number(document.getElementById('planPrice').value),
      order: Number(document.getElementById('planOrder').value) || 100,
      active: document.getElementById('planActive').checked,
      summary: String(document.getElementById('planSummary').value || '').trim(),
      benefits: String(document.getElementById('planBenefits').value || '').split('\n').map((line) => line.trim()).filter(Boolean),
      paymentInstructions: String(document.getElementById('planInstructions').value || '').trim(),
      billingPeriod: 'monthly',
      durationMonths: 1,
      programMonths: 12
    });
    if (!/^[a-z0-9-]{3,60}$/.test(payload.id)) return window.toast('Use a lowercase plan id with hyphens, e.g. education-bronze.', 'error');
    if (!payload.name || !(payload.price > 0)) return window.toast('Enter a plan name and a positive monthly price.', 'error');
    window.showLoading();
    try {
      await callBilling('plans.save', { plan: payload });
      window.hideLoading();
      window.closeModal('modalPlanEditor');
      window.toast('Plan saved — the member catalogue now shows the new price.');
      await window.loadSupportPlansAdmin();
    } catch (error) {
      window.hideLoading();
      window.toast(error.message, 'error');
    }
  };

  window.toggleSupportPlan = async function (id) {
    const plan = plans.filter((row) => row.id === id)[0];
    if (!plan) return;
    window.showLoading();
    try {
      await callBilling('plans.save', { plan: planPayload(Object.assign({}, plan, { active: !plan.active })) });
      window.hideLoading();
      window.toast(plan.active ? 'Plan hidden from members.' : 'Plan visible to members.');
      await window.loadSupportPlansAdmin();
    } catch (error) {
      window.hideLoading();
      window.toast(error.message, 'error');
    }
  };

  window.installStandardPlans = async function () {
    if (!window.confirm('Write the 11 standard plans to Firestore? Existing plans with the same IDs are updated to the standard price.')) return;
    window.showLoading();
    try {
      const result = await callBilling('plans.install', {});
      window.hideLoading();
      window.toast((result.installed || 11) + ' standard plans installed.');
      await window.loadSupportPlansAdmin();
    } catch (error) {
      window.hideLoading();
      window.toast(error.message, 'error');
    }
  };

  /* ----------------------------------------------------------------- activity */
  async function fetchActivity(max) {
    const [logs, audits] = await Promise.allSettled([
      getDocs(query(collection(bridge.db, 'adminLogs'), orderBy('timestamp', 'desc'), limit(max))),
      getDocs(query(collection(bridge.db, 'billingAudit'), orderBy('createdAt', 'desc'), limit(max)))
    ]);
    const rows = [];
    if (logs.status === 'fulfilled') {
      logs.value.docs.forEach((entry) => {
        const row = entry.data();
        rows.push({
          id: 'log_' + entry.id,
          at: toDate(row.timestamp),
          action: row.action || 'admin_action',
          actor: row.adminEmail || row.adminId || 'Administrator',
          role: 'admin',
          record: typeof row.details === 'string' ? row.details : (row.details && (row.details.membershipId || row.details.memberId || row.details.reference)) || '',
          status: '',
          note: typeof row.details === 'object' && row.details ? JSON.stringify(row.details) : ''
        });
      });
    }
    if (audits.status === 'fulfilled') {
      audits.value.docs.forEach((entry) => {
        const row = entry.data();
        rows.push({
          id: 'audit_' + entry.id,
          at: toDate(row.createdAt),
          action: row.action || 'billing_action',
          actor: row.actorEmail || row.actorUid || 'System',
          role: row.actorRole || 'system',
          record: row.paymentRef || row.subscriptionId || row.walletTransactionId || '',
          status: row.status || '',
          note: row.note || ''
        });
      });
    }
    rows.sort((a, b) => (b.at || 0) - (a.at || 0));
    return rows;
  }

  window.loadRecentActivity = async function () {
    const body = document.getElementById('activityList');
    if (!body) return;
    body.innerHTML = loadingRow(7, 'Loading activity…');
    try {
      activity = await fetchActivity(80);
      renderActivity();
    } catch (error) {
      body.innerHTML = emptyRow(7, 'Activity could not be loaded: ' + error.message);
    }
  };

  window.filterActivity = function () { renderActivity(); };

  function renderActivity() {
    const body = document.getElementById('activityList');
    if (!body) return;
    const search = String((document.getElementById('activitySearch') || {}).value || '').trim().toLowerCase();
    const rows = activity.filter((row) => !search ||
      [row.action, row.actor, row.role, row.record, row.status, row.note].join(' ').toLowerCase().includes(search));
    const summary = document.getElementById('activitySummary');
    if (summary) summary.textContent = rows.length + ' of ' + activity.length + ' records';
    if (!rows.length) {
      body.innerHTML = emptyRow(7, 'No activity matches this filter.');
      return;
    }
    body.innerHTML = rows.map((row) => '<tr>' +
      '<td style="white-space:nowrap;">' + esc(date(row.at)) + '</td>' +
      '<td>' + esc(row.action) + '</td>' +
      '<td>' + esc(row.actor) + '</td>' +
      '<td>' + esc(row.role) + '</td>' +
      '<td style="font-family:monospace;font-size:.68rem;word-break:break-all;">' + esc(row.record) + '</td>' +
      '<td>' + (row.status ? chip(row.status) : '—') + '</td>' +
      '<td style="max-width:280px;white-space:normal;font-size:.74rem;">' + esc(row.note) + '</td>' +
    '</tr>').join('');
  }

  window.loadDashboardRecentActivity = async function () {
    const body = document.getElementById('dashRecentActivityList');
    if (!body) return;
    try {
      const rows = (await fetchActivity(6)).slice(0, 6);
      body.innerHTML = rows.length ? rows.map((row) => '<tr>' +
        '<td style="white-space:nowrap;">' + esc(date(row.at)) + '</td>' +
        '<td>' + esc(row.action) + '</td>' +
        '<td>' + esc(row.actor) + '</td>' +
        '<td style="font-family:monospace;font-size:.68rem;">' + esc(row.record || '—') + '</td>' +
        '<td>' + (row.status ? chip(row.status) : '—') + '</td>' +
      '</tr>').join('') : emptyRow(5, 'No activity recorded yet.');
    } catch (error) {
      body.innerHTML = emptyRow(5, 'Activity unavailable.');
    }
  };

  /* Re-render the overview when the dashboard cache refreshes. */
  window.PDBillingAdmin = {
    loadPayments: window.loadPayments,
    loadSubscriptions: window.loadSubscriptions,
    loadWalletTransactions: window.loadWalletTransactions,
    loadWalletBalances: window.loadWalletBalances,
    loadSupportPlansAdmin: window.loadSupportPlansAdmin,
    loadRecentActivity: window.loadRecentActivity,
    renderBillingSnapshot: window.renderBillingSnapshot
  };

  if (document.getElementById('paymentList') && document.getElementById('view-payment-verification') && document.getElementById('view-payment-verification').classList.contains('active')) {
    window.loadPayments();
  }
})();
