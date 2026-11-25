/*!
 * Prayer Dome — administrator email delivery workspace
 * ---------------------------------------------------------------------------
 * Settings, templates and the delivery log for the transactional email
 * service. All work goes through the `emailAdmin` callable, so the browser
 * never holds a Brevo key and never writes an outbox row directly.
 */
(function () {
  'use strict';

  var state = {
    settings: null,
    categories: {},
    templates: [],
    loaded: false
  };
  var bootTimer = null;

  function bridge() { return window.PDAdmin || null; }

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message, type) {
    var b = bridge();
    if (b && typeof b.toast === 'function') b.toast(message, type || 'success');
    else if (typeof window.toast === 'function') window.toast(message, type || 'success');
  }

  function call(action, payload) {
    var b = bridge();
    if (!b || typeof b.httpsCallable !== 'function') {
      return Promise.reject(new Error('The admin bridge is still loading. Please try again.'));
    }
    var callable;
    try {
      callable = b.httpsCallable(b.cloudFunctions, 'emailAdmin');
    } catch (error) {
      return Promise.reject(new Error('Email delivery is not available until the Cloud Functions are deployed.'));
    }
    return Promise.resolve(callable(Object.assign({ action: action }, payload || {})))
      .then(function (result) { return (result && result.data) || {}; })
      .catch(function (error) {
        var code = String((error && (error.code || error.status)) || '');
        var raw = String((error && error.message) || '').replace(/^FirebaseError:\s*/i, '').trim();
        var message;
        if (/unauthenticated/i.test(code)) {
          message = 'Your administrator session has expired. Sign in again, then retry.';
        } else if (/permission-denied/i.test(code)) {
          message = 'This account is not allowed to manage email delivery. Ask a Prayer Dome administrator to grant access.';
        } else if (/not-found/i.test(code)) {
          message = 'The email service is not deployed for this project yet. An administrator must deploy the email function before this page can send or list messages.';
        } else if (/resource-exhausted/i.test(code)) {
          message = 'The email service is busy or rate-limited. Wait a few minutes and try again.';
        } else if (/failed-precondition/i.test(code)) {
          message = raw || 'Email delivery is not configured yet. Check the sender and Brevo settings below.';
        } else if (/invalid-argument/i.test(code)) {
          message = raw || 'Check the values on this page and try again.';
        } else if (/unavailable/i.test(code) || /deadline-exceeded/i.test(code)) {
          message = raw || 'The email service did not respond in time. Check your connection and retry; if it continues, open the delivery log for the provider error.';
        } else if (/internal/i.test(code)) {
          message = raw || 'The email service hit an unexpected error. Open the delivery log for the exact provider response.';
        } else {
          message = raw || 'The email service could not be reached. Check your connection and try again.';
        }
        throw new Error(message);
      });
  }

  function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function when(value) {
    var date = toDate(value);
    if (!date) return '—';
    return date.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function statusTone(status) {
    if (status === 'delivered') return 'ok';
    if (status === 'accepted' || status === 'sent') return 'warn';
    if (status === 'failed' || status === 'bounced') return 'bad';
    if (status === 'missing_email') return 'bad';
    if (status === 'disabled' || status === 'opted_out') return 'warn';
    return 'warn';
  }

  function chip(status) {
    var label = String(status || 'unknown').replace(/_/g, ' ');
    if (status === 'sent') label = 'accepted (legacy)';
    return '<span class="audit-pill ' + statusTone(status) + '">' + esc(label) + '</span>';
  }

  function renderHealth(logs) {
    var counts = { accepted: 0, delivered: 0, failed: 0, bounced: 0, pending: 0, missing_email: 0, disabled: 0, opted_out: 0 };
    (logs || []).forEach(function (row) {
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] += 1;
      else if (row.status === 'sending') counts.pending += 1;
      else if (row.status === 'sent') counts.accepted += 1;
    });
    var grid = $('emailHealthGrid');
    if (grid) {
      var cards = [
        { key: 'accepted', label: 'Accepted by Brevo', tone: 'blue' },
        { key: 'delivered', label: 'Delivered (provider)', tone: 'green' },
        { key: 'bounced', label: 'Bounced / blocked', tone: 'red' },
        { key: 'failed', label: 'Failed', tone: 'red' },
        { key: 'pending', label: 'Pending / sending', tone: 'gold' },
        { key: 'missing_email', label: 'No email on file', tone: 'red' },
        { key: 'opted_out', label: 'Opted out', tone: 'gold' }
      ];
      grid.innerHTML = cards.map(function (card) {
        return '<div class="kpi-card" style="cursor:default;padding:16px;">' +
          '<div class="kpi-details"><h3 style="margin:0;">' + counts[card.key] + '</h3><p style="margin:2px 0 0;">' + esc(card.label) + '</p></div>' +
          '</div>';
      }).join('');
    }
    var summary = $('emailHealthSummary');
    if (summary) {
      summary.textContent = (logs || []).length
        ? 'Showing the latest ' + logs.length + ' deliveries.'
        : 'No email has been queued yet.';
    }
  }

  function fillSettings(settings) {
    state.settings = settings || {};
    if ($('emailSenderName')) $('emailSenderName').value = state.settings.senderName || 'Prayer Dome';
    if ($('emailSenderEmail')) $('emailSenderEmail').value = state.settings.senderEmail || '';
    if ($('emailReplyTo')) $('emailReplyTo').value = state.settings.replyTo || '';
    if ($('emailEnabled')) $('emailEnabled').checked = state.settings.enabled !== false;
    var b = bridge();
    if ($('emailTestTo') && !$('emailTestTo').value && b && b.auth && b.auth.currentUser && b.auth.currentUser.email) {
      $('emailTestTo').value = b.auth.currentUser.email;
    }
  }

  function renderCategories(categories) {
    state.categories = categories || {};
    var host = $('emailCategoryList');
    if (!host) return;
    var saved = (state.settings && state.settings.categories) || {};
    host.innerHTML = Object.keys(state.categories).map(function (key) {
      return '<label class="notif-pref-item" style="display:flex;justify-content:space-between;gap:10px;align-items:center;">' +
        '<span>' + esc(state.categories[key]) + '</span>' +
        '<input type="checkbox" data-email-category="' + esc(key) + '" ' + (saved[key] === false ? '' : 'checked') + '>' +
        '</label>';
    }).join('');
  }

  function renderTemplates() {
    var select = $('emailTemplateEvent');
    if (!select) return;
    var chosen = select.value;
    select.innerHTML = state.templates.map(function (row) {
      return '<option value="' + esc(row.event) + '">' + esc(row.label) + (row.essential ? ' — essential' : ' — optional') + '</option>';
    }).join('');
    if (chosen && state.templates.some(function (row) { return row.event === chosen; })) select.value = chosen;
    loadTemplate();
  }

  function loadTemplate() {
    var select = $('emailTemplateEvent');
    if (!select) return;
    var row = state.templates.filter(function (item) { return item.event === select.value; })[0];
    if (!row) return;
    if ($('emailTemplateSubject')) $('emailTemplateSubject').value = row.subject || '';
    if ($('emailTemplateHeading')) $('emailTemplateHeading').value = row.heading || '';
    if ($('emailTemplateMessage')) $('emailTemplateMessage').value = row.message || '';
    if ($('emailTemplateActionLabel')) $('emailTemplateActionLabel').value = row.actionLabel || '';
    if ($('emailTemplateActionPath')) $('emailTemplateActionPath').value = row.actionPath || '';
  }

  function providerLabel(row) {
    if (row.providerStatus) return String(row.providerStatus).replace(/_/g, ' ');
    if (row.status === 'accepted') return 'accepted — awaiting provider report';
    if (row.status === 'sent') return 'accepted — legacy record';
    return '—';
  }

  function retryLabel(row) {
    var attempts = Number(row.attempts || 0);
    var next = toDate(row.nextAttemptAt);
    if (row.status === 'delivered') return attempts ? attempts + ' · provider confirmed' : 'provider confirmed';
    if (row.status === 'accepted') return attempts ? attempts + ' · accepted' : 'accepted';
    if (row.status === 'bounced') return attempts + ' · not retried';
    if (next && row.status === 'failed') return attempts + ' · next ' + when(next);
    if (row.status === 'failed' && attempts >= 5) return attempts + ' · retry limit reached';
    return attempts ? String(attempts) : '—';
  }

  function renderLogs(logs) {
    var body = $('emailLogsBody');
    if (!body) return;
    if (!logs || !logs.length) {
      body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sub);">No email deliveries match this filter.</td></tr>';
      renderHealth([]);
      return;
    }
    body.innerHTML = logs.map(function (row) {
      var canRetry = row.retryable !== false && (row.status === 'failed' || row.status === 'pending' || row.status === 'sending');
      var actions = canRetry
        ? '<button class="btn btn-outline btn-sm" type="button" onclick="retryEmailDelivery(\'' + esc(row.id) + '\')"><i class="pd-i pd-i-refresh-cw"></i> Retry</button>'
        : '—';
      var failure = row.failureReason || row.lastError || '';
      return '<tr>' +
        '<td style="white-space:nowrap;">' + esc(when(row.createdAt)) + '</td>' +
        '<td>' + esc(String(row.event || '').replace(/_/g, ' ')) + (row.subject ? '<br><span style="font-size:.68rem;color:var(--text-sub);">' + esc(row.subject) + '</span>' : '') + '</td>' +
        '<td>' + esc(row.recipient || '—') + (row.recipientName ? '<br><span style="font-size:.68rem;color:var(--text-sub);">' + esc(row.recipientName) + '</span>' : '') + '</td>' +
        '<td>' + chip(row.status) + '</td>' +
        '<td>' + esc(providerLabel(row)) + (row.deliveredAt ? '<br><span style="font-size:.66rem;color:var(--text-sub);">' + esc(when(row.deliveredAt)) + '</span>' : '') + '</td>' +
        '<td style="max-width:220px;">' + (failure ? esc(failure) : '—') + '</td>' +
        '<td>' + esc(retryLabel(row)) + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    }).join('');
    renderHealth(logs);
  }

  function loadLogs() {
    var status = ($('emailLogStatus') || {}).value || 'all';
    if ($('emailLogsBody')) {
      $('emailLogsBody').innerHTML = '<tr><td colspan="8"><div class="spinner" style="width:26px;height:26px;"></div></td></tr>';
    }
    return call('logs.list', { limit: 100, status: status })
      .then(function (result) { renderLogs(result.logs || []); return result.logs || []; })
      .catch(function (error) {
        if ($('emailLogsBody')) {
          $('emailLogsBody').innerHTML = '<tr><td colspan="8" style="color:var(--danger,#ef4444);">' + esc(error.message) + '</td></tr>';
        }
        renderHealth([]);
        return [];
      });
  }

  window.checkEmailDiagnostics = function () {
    var host = $('emailDiagnostics');
    if (host) {
      host.style.display = 'block';
      host.style.borderColor = 'var(--border-color)';
      host.innerHTML = '<div class="spinner" style="width:22px;height:22px;display:inline-block;vertical-align:middle;"></div> Checking the server credential with Brevo…';
    }
    return call('diagnostics').then(function (result) {
      var connection = result.connection || {};
      var ok = connection.configured && connection.ok;
      if (host) {
        host.style.display = 'block';
        host.style.borderColor = ok ? 'var(--accent-green)' : 'var(--danger,#ef4444)';
        var lines = [];
        lines.push('<strong style="color:' + (ok ? 'var(--accent-green)' : 'var(--danger,#ef4444)') + ';">'
          + (ok ? 'Brevo credential accepted' : (connection.configured ? 'Brevo rejected the request' : 'Brevo is not configured on the server')) + '</strong>');
        if (connection.message) lines.push(esc(connection.message));
        if (connection.code) lines.push('Reason code: <code>' + esc(connection.code) + '</code>' + (connection.status ? ' (HTTP ' + esc(connection.status) + ')' : ''));
        if (connection.companyName) lines.push('Brevo account: ' + esc(connection.companyName));
        lines.push('Sender: ' + esc((result.sender && result.sender.email) || connection.senderEmail || 'not set')
          + ' · reply-to: ' + esc((result.sender && result.sender.replyTo) || 'not set'));
        if (connection.senderVerified === false) {
          lines.push('<span style="color:var(--danger,#ef4444);">The sender address is not in Brevo’s verified senders list. Verify it in Brevo before sending.</span>');
        } else if (connection.senderVerified === true) {
          lines.push('The sender address is verified in Brevo.');
        }
        lines.push('Messages: ' + esc(Object.keys(result.counts || {}).map(function (key) { return key + ' ' + result.counts[key]; }).join(' · ')));
        if (!connection.configured) {
          lines.push('Set <code>BREVO_API_KEY</code> in Firebase Secret Manager for the functions that send mail, and in Vercel if the newsletter endpoint is used. The key is never entered in this page.');
        } else if (!connection.ok) {
          lines.push('The key is present but Brevo did not accept it. Check that it is an active v3 API key and that the sender address or domain is verified in Brevo.');
        }
        host.innerHTML = lines.map(function (line) { return '<div style="margin:3px 0;">' + line + '</div>'; }).join('');
      }
      return result;
    }).catch(function (error) {
      if (host) {
        host.style.display = 'block';
        host.style.borderColor = 'var(--danger,#ef4444)';
        host.innerHTML = '<strong>Connection check failed.</strong><br>' + esc(error.message);
      }
      toast('Connection check failed: ' + error.message, 'error');
    });
  };

  window.refreshEmailProviderStatus = function () {
    return call('logs.refresh', { limit: 20 }).then(function (result) {
      toast('Provider report checked: ' + (result.checked || 0) + ' message(s), ' + (result.updated || 0) + ' updated.', 'info');
      return loadLogs();
    }).catch(function (error) {
      toast('Provider status could not be refreshed: ' + error.message, 'error');
    });
  };

  window.loadEmailAdmin = function () {
    if (!bridge()) return Promise.resolve(false);
    return Promise.all([
      call('settings.get').then(function (result) {
        fillSettings(result.settings || {});
        renderCategories(result.categories || {});
        return true;
      }).catch(function (error) { toast(error.message, 'error'); return false; }),
      call('templates.list').then(function (result) {
        state.templates = result.templates || [];
        renderTemplates();
        return true;
      }).catch(function () { return false; })
    ]).then(function () {
      state.loaded = true;
      return loadLogs();
    });
  };

  window.loadEmailLogs = loadLogs;
  window.loadEmailTemplate = loadTemplate;

  window.saveEmailSettings = function () {
    var senderEmail = (($('emailSenderEmail') || {}).value || '').trim();
    if (!senderEmail) return toast('Enter the verified sender email address.', 'error');
    var categories = {};
    document.querySelectorAll('[data-email-category]').forEach(function (input) {
      categories[input.getAttribute('data-email-category')] = !!input.checked;
    });
    var button = document.querySelector('#view-email .btn-primary');
    if (button) button.disabled = true;
    return call('settings.save', {
      enabled: !!($('emailEnabled') || {}).checked,
      senderName: (($('emailSenderName') || {}).value || '').trim(),
      senderEmail: senderEmail,
      replyTo: (($('emailReplyTo') || {}).value || '').trim(),
      categories: categories
    }).then(function (result) {
      fillSettings(result.settings || {});
      renderCategories(state.categories);
      toast('Email settings saved. New events use these settings.');
    }).catch(function (error) {
      toast('Settings were not saved: ' + error.message, 'error');
    }).then(function () {
      if (button) button.disabled = false;
    });
  };

  window.saveEmailTemplate = function () {
    var event = ($('emailTemplateEvent') || {}).value;
    if (!event) return toast('Choose an event first.', 'error');
    var subject = (($('emailTemplateSubject') || {}).value || '').trim();
    var heading = (($('emailTemplateHeading') || {}).value || '').trim();
    var message = (($('emailTemplateMessage') || {}).value || '').trim();
    if (!subject || !heading || !message) return toast('Subject, heading and message are required.', 'error');
    return call('templates.save', {
      event: event,
      subject: subject,
      heading: heading,
      message: message,
      actionLabel: (($('emailTemplateActionLabel') || {}).value || '').trim(),
      actionPath: (($('emailTemplateActionPath') || {}).value || '').trim()
    }).then(function () {
      toast('Template saved. Future emails for this event use it.');
      return call('templates.list');
    }).then(function (result) {
      state.templates = result.templates || [];
      renderTemplates();
    }).catch(function (error) {
      toast('Template was not saved: ' + error.message, 'error');
    });
  };

  window.sendEmailTest = function () {
    var to = (($('emailTestTo') || {}).value || '').trim();
    if (!to) return toast('Enter a recipient address for the test.', 'error');
    var button = $('emailTestBtn');
    var stateEl = $('emailTestState');
    if (button) button.disabled = true;
    if (stateEl) stateEl.textContent = 'Sending through Brevo…';
    return call('test', { to: to }).then(function (result) {
      if (stateEl) stateEl.textContent = result && result.sent === false
        ? 'The provider did not accept the test. Check the delivery log for the exact reason.'
        : 'Brevo accepted the test message. That is not proof of delivery; use “Refresh provider status” to check the provider report. Check ' + to + ' and the spam folder.';
      toast('Test message accepted by Brevo. It is in the delivery log.', 'success');
      return loadLogs();
    }).catch(function (error) {
      if (stateEl) stateEl.textContent = 'Test failed: ' + error.message;
      toast('Test email failed: ' + error.message, 'error');
    }).then(function () {
      if (button) button.disabled = false;
    });
  };

  window.retryEmailDelivery = function (id) {
    if (!id) return;
    return call('retry', { id: id }).then(function (result) {
      if (result && result.sent) toast('Brevo accepted the email on retry. Delivery is not yet confirmed; use “Refresh provider status” for the provider report.', 'success');
      else toast('Retry checked: ' + (result && result.reason ? String(result.reason).replace(/_/g, ' ') : 'still not accepted') + '.', 'info');
      return loadLogs();
    }).catch(function (error) {
      toast('Retry failed: ' + error.message, 'error');
    });
  };

  function maybeLoad() {
    var section = $('view-email');
    if (!section) return;
    if (section.classList.contains('active') || window.location.hash === '#email') {
      if (!state.loaded) window.loadEmailAdmin();
    }
  }

  function boot() {
    if (!bridge()) {
      clearTimeout(bootTimer);
      bootTimer = setTimeout(boot, 300);
      return;
    }
    maybeLoad();
    var nav = document.querySelector('.nav-item[data-view="email"]');
    if (nav) nav.addEventListener('click', function () { setTimeout(maybeLoad, 200); });
    window.addEventListener('hashchange', maybeLoad);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
