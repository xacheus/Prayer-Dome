/*!
 * Prayer Dome — support plans, subscriptions and money helpers
 * ---------------------------------------------------------------------------
 * One catalogue and one set of rules for the member-facing support page and
 * the administrator console. This file is deliberately dependency-free so it
 * can run before Firebase has loaded.
 *
 * Money rules enforced by the server (functions/billing.js):
 *   catalogue -> pending payment -> evidence submitted -> administrator
 *   verification -> active subscription / wallet credit.
 *
 * The browser never activates a plan and never moves a wallet balance. This
 * module only renders what Firestore already says and prepares checkout calls.
 */
(function (global) {
  'use strict';

  var ORGANIZATION = {
    name: 'PRAYER DOME',
    legalName: 'PRAYER DOME',
    tagline: 'House of Prayer for All Nations',
    website: 'prayerdome.net',
    email: 'info@prayerdome.net',
    phone: ''
  };

  var FOUNDER = {
    name: 'S. K. MASUKU',
    title: 'Founder and President',
    organization: 'PRAYER DOME'
  };

  /* Membership cards must never publish the internal role "admin" as a
     department. Permissions stay exactly as they are; only the printed label
     changes. */
  var DEPARTMENT_LABELS = {
    admin: 'TEAM MANAGEMENT',
    finance: 'FINANCE',
    leader: 'LEADERSHIP',
    pastor: 'PASTORAL TEAM',
    member: 'MEMBERSHIP'
  };

  // Channel names only. Every number, bank account and label comes from
  // settings/payments; this list just keeps older callers from guessing.
  var PAYMENT_METHODS = [
    { id: 'mobile-money', label: 'Mobile Money' },
    { id: 'bank-transfer', label: 'Bank transfer' },
    { id: 'cash-office', label: 'Cash at the ministry office' },
    { id: 'whatsapp', label: 'WhatsApp' }
  ];

  /* The official number is configuration, never source code. Checkout receives
     it from settings/payments through the billing callable, and the support
     page shows the same value from the authorised finance settings. */
  var PAYMENT_INSTRUCTIONS = 'Send the exact amount using the official PRAYER DOME payment ' +
    'method shown at checkout. Put the payment reference on the payment, then upload a clear ' +
    'receipt. A plan is activated only after the finance team checks the payment against the ' +
    'ministry account.';

  var PAYMENT_METHOD_TYPE_LABELS = {
    'mobile-money': 'Mobile Money',
    'bank-transfer': 'Bank transfer',
    'cash-office': 'Cash at the ministry office',
    whatsapp: 'WhatsApp'
  };

  function slug(value) {
    return String(value == null ? '' : value)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* The admin console, give page and support page all receive the same
     settings/payments shape. Older documents only hold one Mobile Money
     number, so they are lifted into a single-method list here instead of
     every page growing its own fallback. */
  function normalizePaymentMethod(value, index) {
    if (!value || typeof value !== 'object') return null;
    var type = slug(value.type) || 'mobile-money';
    if (!PAYMENT_METHOD_TYPE_LABELS[type]) type = 'mobile-money';
    return {
      id: slug(value.id) || ('method-' + (Number(index) + 1)),
      type: type,
      label: String(value.label || '').trim() || PAYMENT_METHOD_TYPE_LABELS[type],
      enabled: value.enabled !== false,
      scope: ['both', 'give', 'support'].indexOf(String(value.scope)) !== -1 ? String(value.scope) : 'both',
      order: Number(value.order) || (Number(index) + 1),
      number: String(value.number || '').trim(),
      accountNumber: String(value.accountNumber || '').trim(),
      accountName: String(value.accountName || '').trim(),
      network: String(value.network || '').trim(),
      bankName: String(value.bankName || '').trim(),
      branchCode: String(value.branchCode || '').trim(),
      swift: String(value.swift || '').trim(),
      currency: String(value.currency || 'SZL').toUpperCase(),
      instructions: String(value.instructions || '').trim()
    };
  }

  function usablePaymentMethod(method) {
    if (!method || method.enabled === false) return false;
    if (method.type === 'bank-transfer') return Boolean(method.bankName && method.accountNumber);
    if (method.type === 'cash-office') return Boolean(method.instructions || method.accountName);
    return String(method.number || '').replace(/\D/g, '').length >= 9;
  }

  function paymentMethodsFromSettings(settings) {
    var row = settings || {};
    var methods = Array.isArray(row.methods) ? row.methods.map(normalizePaymentMethod).filter(Boolean) : [];
    const legacyNumber = String(row.mobileMoneyNumber || row.number || '').trim();
    if (!methods.length && legacyNumber) {
      methods = [normalizePaymentMethod({
        id: 'official-mobile-money',
        type: 'mobile-money',
        label: String(row.network || '').trim() || PAYMENT_METHOD_TYPE_LABELS['mobile-money'],
        enabled: true,
        scope: 'both',
        order: 1,
        number: legacyNumber,
        accountName: row.accountName,
        network: row.network,
        instructions: row.instructions
      }, 0)];
    }
    return methods.sort(function (a, b) { return (a.order - b.order) || a.label.localeCompare(b.label); });
  }

  function paymentMethodsFor(settings, scope) {
    return paymentMethodsFromSettings(settings)
      .filter(usablePaymentMethod)
      .filter(function (method) { return !scope || method.scope === 'both' || method.scope === scope; });
  }

  /* Prices are USD per month. Every plan is a monthly subscription inside a
     12-month support programme. Keep these values in step with
     functions/billing-catalog.js — tests/billing.test.js compares the two. */
  var PLANS = [
    {
      id: 'education-bronze', program: 'Education', claimType: 'Education', tier: 'Bronze',
      name: 'Education Support · Bronze', price: 5, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 10, active: true, theme: 'education',
      summary: 'School fees and everyday learning needs for one child.',
      benefits: ['School fees and exam contributions', 'Books, uniforms and stationery', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'education-gold', program: 'Education', claimType: 'Education', tier: 'Gold',
      name: 'Education Support · Gold', price: 50, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 20, active: true, theme: 'education',
      summary: 'Secondary-school tuition and the costs around a full school term.',
      benefits: ['Secondary-school tuition', 'Books, uniforms, exam and transport costs', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'education-platinum', program: 'Education', claimType: 'Education', tier: 'Platinum',
      name: 'Education Support · Platinum', price: 100, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 30, active: true, theme: 'education',
      summary: 'Tertiary and college tuition support.',
      benefits: ['College and university tuition', 'Registration, books and examination fees', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'education-diamond', program: 'Education', claimType: 'Education', tier: 'Diamond',
      name: 'Education Support · Diamond', price: 500, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 40, active: true, theme: 'education',
      summary: 'University and international study support.',
      benefits: ['University and international tuition', 'Accommodation, travel and study materials review', '12-month education fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-bronze', program: 'Business', claimType: 'Business', tier: 'Bronze',
      name: 'Business Seeding · Bronze', price: 5, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 50, active: true, theme: 'business',
      summary: 'Stock, tools and small equipment for a micro-business.',
      benefits: ['Stock and trading goods', 'Tools and small equipment', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-gold', program: 'Business', claimType: 'Business', tier: 'Gold',
      name: 'Business Seeding · Gold', price: 50, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 60, active: true, theme: 'business',
      summary: 'Equipment and working capital for a small enterprise.',
      benefits: ['Machinery and business equipment', 'Working capital for a small enterprise', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-platinum', program: 'Business', claimType: 'Business', tier: 'Platinum',
      name: 'Business Seeding · Platinum', price: 100, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 70, active: true, theme: 'business',
      summary: 'Expansion capital for an established small business.',
      benefits: ['Business expansion capital', 'Equipment upgrade and stock expansion', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'business-diamond', program: 'Business', claimType: 'Business', tier: 'Diamond',
      name: 'Business Seeding · Diamond', price: 500, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 80, active: true, theme: 'business',
      summary: 'Enterprise-scale capital and equipment support.',
      benefits: ['Enterprise capital and equipment', 'Premises, machinery and stock review', '12-month business fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'compassion-basic', program: 'Compassion', claimType: 'Funeral', tier: 'Basic',
      name: 'Compassion Cover · Basic', price: 2.5, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 90, active: true, theme: 'compassion',
      summary: 'Dignified funeral support for a member’s immediate household.',
      benefits: ['Funeral contribution for immediate family', 'Practical support for the household', '12-month compassion fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'compassion-standard', program: 'Compassion', claimType: 'Funeral', tier: 'Standard',
      name: 'Compassion Cover · Standard', price: 25, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 100, active: true, theme: 'compassion',
      summary: 'Extended-family funeral and bereavement support.',
      benefits: ['Extended-family funeral contribution', 'Transport and bereavement costs review', '12-month compassion fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    },
    {
      id: 'compassion-premium', program: 'Compassion', claimType: 'Funeral', tier: 'Premium',
      name: 'Compassion Cover · Premium', price: 50, currency: 'USD', billingPeriod: 'monthly',
      durationMonths: 1, programMonths: 12, order: 110, active: true, theme: 'compassion',
      summary: 'Full funeral support for a wider family circle.',
      benefits: ['Full funeral and memorial contribution', 'Wider family and travel costs review', '12-month compassion fund tracking', 'Claim review after the programme matures'],
      paymentInstructions: PAYMENT_INSTRUCTIONS
    }
  ];

  var PROGRAM_ORDER = ['Education', 'Business', 'Compassion'];

  var PROGRAM_THEMES = {
    Education: { color: '#0A4D9B', icon: 'pd-i-graduation-cap' },
    Business: { color: '#1e3a5f', icon: 'pd-i-briefcase' },
    Compassion: { color: '#7c2d12', icon: 'pd-i-hand-heart' }
  };

  /* -------------------------------------------------------------------------
     Public programme layer
     -------------------------------------------------------------------------
     Four programme cards are shown on /support. They are a presentation layer
     over records that already exist:

       Business Education        -> Business Seeding plans
       Financial Cover           -> Compassion Cover plans
       Savings Programme         -> the member's Secure Wallet balance
       Community & Family Support -> Education Support plans

     No price, benefit or eligibility rule is invented here. Plan prices and
     benefits come from `supportPlans` (or the catalogue above), and savings
     contributions use the wallet deposit callable. Administrators may override
     the wording, image, eligibility and availability in `supportProgrammes`;
     these objects are the fallback when that collection is empty.
     ---------------------------------------------------------------------- */
  var SUPPORT_PROGRAMMES = [
    {
      id: 'business-education',
      name: 'Business Education',
      eyebrow: 'Enterprise & skills',
      description: 'Practical business learning and enterprise development support for members building a household business. Short lessons in planning, record-keeping and pricing sit alongside the existing Business Seeding plans.',
      image: '/assets/support/support-business.jpg',
      imageAlt: 'A business owner recording sales in a fabric shop',
      planPrograms: ['Business'],
      kind: 'plans',
      eligibility: 'Approved Prayer Dome member, 18 or older, with a business idea or an existing micro-enterprise. Complete the Business Basics lesson before a support claim is reviewed.',
      availability: 'Open',
      note: 'Business Seeding plans are monthly contributions inside a 12-month programme. Support is released only after the programme matures and a claim is reviewed and approved.',
      order: 10,
      active: true
    },
    {
      id: 'financial-cover',
      name: 'Financial Cover',
      eyebrow: 'Bereavement & household cover',
      description: 'A shared funeral and bereavement fund for members and their households, delivered through the existing Compassion Cover plans. It is a community contribution programme, not a commercial insurance policy or an investment.',
      image: '/assets/support/support-funeral.jpg',
      imageAlt: 'A family being comforted at a funeral service',
      planPrograms: ['Compassion'],
      kind: 'plans',
      eligibility: 'Approved member with an active Compassion Cover plan. The claim must relate to a named household member, and the documents listed on the claim form are required.',
      availability: 'Open',
      note: 'No cash amount is promised before a claim is reviewed and approved. Contributions do not earn interest and do not create a transferable insurance policy.',
      order: 20,
      active: true
    },
    {
      id: 'savings-programme',
      name: 'Savings Programme',
      eyebrow: 'Save with a clear record',
      description: 'Set aside what you can in your Prayer Dome Secure Wallet. Every verified contribution is recorded, your balance stays visible, and you can request a withdrawal when you need it. Savings are held as a balance — they are not invested and do not earn interest.',
      image: '/assets/support/support-savings.jpg',
      imageAlt: 'Hands placing coins into a savings jar beside a mobile phone',
      planPrograms: [],
      kind: 'savings',
      contributionOptions: [5, 10, 25, 50, 100, 250],
      eligibility: 'Approved member with a Secure Wallet. Contributions are credited only after finance verifies the payment. Withdrawals are reviewed by finance and paid to your Mobile Money number; the minimum withdrawal is $10.00.',
      availability: 'Open',
      note: 'The Savings Programme is a member-held balance in the ministry wallet. It is not a bank account, an investment product or an interest-bearing deposit.',
      order: 30,
      active: true
    },
    {
      id: 'community-family',
      name: 'Community & Family Support',
      eyebrow: 'Households & learning',
      description: 'Education Support plans help households with school fees, books, uniforms and study costs, from primary school to tertiary study. The programme also points members to practical family and community resources.',
      image: '/assets/support/support-community.jpg',
      imageAlt: 'A family sharing a meal together',
      planPrograms: ['Education'],
      kind: 'plans',
      eligibility: 'Approved member with an active Education Support plan and a learner in the household. School or institution documents are required when a claim is reviewed.',
      availability: 'Open',
      note: 'Education Support plans are monthly contributions inside a 12-month programme. Claim review happens after the programme matures; a plan does not guarantee a fixed payout.',
      order: 40,
      active: true
    }
  ];

  function normalizeProgramme(value, id) {
    var row = Object.assign({}, value || {});
    row.id = String(row.id || id || '').trim().toLowerCase();
    row.name = String(row.name || row.title || row.id);
    row.eyebrow = String(row.eyebrow || '');
    row.description = String(row.description || row.summary || '');
    row.image = String(row.image || '/assets/support/support-education.jpg');
    row.imageAlt = String(row.imageAlt || row.name);
    row.kind = row.kind === 'savings' ? 'savings' : 'plans';
    row.planPrograms = Array.isArray(row.planPrograms) ? row.planPrograms.map(String) : [];
    row.contributionOptions = Array.isArray(row.contributionOptions)
      ? row.contributionOptions.map(Number).filter(function (n) { return isFinite(n) && n >= 5; })
      : [5, 10, 25, 50, 100, 250];
    // A programme card is a doorway, never a price list. Prices live only in
    // supportPlans; a savings card links to no plan at all.
    delete row.price;
    delete row.currency;
    if (row.kind === 'savings') row.planPrograms = [];
    row.eligibility = String(row.eligibility || '');
    row.availability = String(row.availability || (row.active === false ? 'Closed' : 'Open'));
    row.note = String(row.note || '');
    row.order = Number.isFinite(Number(row.order)) ? Number(row.order) : 1000;
    row.active = row.active !== false && row.availability !== 'Closed';
    return row;
  }

  var STATUS_LABELS = {
    draft: 'Draft',
    pending_payment: 'Awaiting payment',
    pending_verification: 'Pending verification',
    pending_review: 'Pending review',
    processing: 'Processing',
    paid: 'Paid',
    approved: 'Approved',
    active: 'Active',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    expired: 'Expired',
    suspended: 'Suspended',
    revoked: 'Revoked'
  };

  function money(amount, currency) {
    var value = Number(amount);
    if (!isFinite(value)) value = 0;
    var code = String(currency || 'USD').toUpperCase();
    if (code === 'SZL') return 'E' + value.toFixed(2);
    if (code === 'USD') return '$' + value.toFixed(2);
    return code + ' ' + value.toFixed(2);
  }

  function planById(id) {
    var wanted = String(id || '').toLowerCase();
    for (var index = 0; index < PLANS.length; index += 1) {
      if (PLANS[index].id === wanted) return PLANS[index];
    }
    return null;
  }

  function plansByProgram() {
    var grouped = {};
    PROGRAM_ORDER.forEach(function (program) { grouped[program] = []; });
    PLANS.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (plan) {
      if (!grouped[plan.program]) grouped[plan.program] = [];
      grouped[plan.program].push(plan);
    });
    return grouped;
  }

  function toDate(value) {
    if (!value) return null;
    try {
      if (typeof value.toDate === 'function') return value.toDate();
      if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
      var parsed = value instanceof Date ? value : new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch (error) { return null; }
  }

  function formatDate(value) {
    var date = toDate(value);
    if (!date) return '';
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function addMonths(value, months) {
    var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (isNaN(date.getTime())) date = new Date();
    var targetMonth = date.getMonth() + Number(months || 0);
    var day = date.getDate();
    date.setDate(1);
    date.setMonth(targetMonth);
    var lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return date;
  }

  /* An expired record is never displayed as active even if a scheduled job has
     not caught up yet. Expiry is evaluated from the stored expiry date. */
  function effectiveStatus(record, now) {
    var row = record || {};
    var status = String(row.status || 'pending_payment');
    var expiry = toDate(row.expiresAt || row.expiryDate || row.validUntil);
    if (expiry && (status === 'active' || status === 'approved') && expiry.getTime() < (now || new Date()).getTime()) {
      return 'expired';
    }
    return status;
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || '').replace(/_/g, ' ');
  }

  function statusTone(status) {
    if (status === 'active' || status === 'approved' || status === 'paid') return 'ok';
    if (status === 'rejected' || status === 'revoked' || status === 'expired' || status === 'suspended' || status === 'cancelled' || status === 'failed') return 'bad';
    return 'warn';
  }

  function departmentLabel(roleOrDepartment) {
    var value = String(roleOrDepartment || '').trim();
    if (!value) return 'MEMBERSHIP';
    var key = value.toLowerCase();
    if (DEPARTMENT_LABELS[key]) return DEPARTMENT_LABELS[key];
    return value.toUpperCase();
  }

  function newReference(kind) {
    var prefix = kind === 'wallet_deposit' ? 'PD-WAL' : 'PD-SUB';
    var date = new Date();
    var stamp = String(date.getUTCFullYear()) +
      String(date.getUTCMonth() + 1).padStart(2, '0') +
      String(date.getUTCDate()).padStart(2, '0');
    var bytes = [];
    try {
      if (global.crypto && global.crypto.getRandomValues) {
        var buffer = new Uint8Array(5);
        global.crypto.getRandomValues(buffer);
        bytes = Array.prototype.slice.call(buffer);
      }
    } catch (error) { /* fall through */ }
    if (!bytes.length) {
      for (var index = 0; index < 5; index += 1) bytes.push(Math.floor(Math.random() * 256));
    }
    return prefix + '-' + stamp + '-' + bytes.map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }

  function idempotencyKey() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (error) { /* fall through */ }
    return 'checkout-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // A callable failure is not one problem. A missing deployment, an expired
  // session, a busy service and a rejected business rule all arrive here, so
  // each needs its own sentence. The raw code is kept (and returned to the
  // console) instead of being replaced by one catch-all notice.
  var BILLING_TRANSIENT_CODES = ['unavailable', 'internal', 'deadline-exceeded',
    'resource-exhausted', 'unknown', 'aborted'];

  function billingErrorCode(error) {
    var code = String((error && error.code) || '').toLowerCase();
    while (/^(firebase|functions)\//.test(code)) {
      code = code.replace(/^(firebase|functions)\//, '');
    }
    var raw = String((error && error.message) || '');
    if (!code) {
      if (/not found/i.test(raw)) code = 'not-found';
      else if (/unavailable/i.test(raw)) code = 'unavailable';
      else if (/internal/i.test(raw)) code = 'internal';
      else if (/permission/i.test(raw)) code = 'permission-denied';
      else if (/unauthenticated|sign in/i.test(raw)) code = 'unauthenticated';
      else if (/deadline|timed out/i.test(raw)) code = 'deadline-exceeded';
    }
    return code || 'unknown';
  }

  function billingRetryable(error) {
    return BILLING_TRANSIENT_CODES.indexOf(billingErrorCode(error)) !== -1;
  }

  function billingServerError(error) {
    var details = error && error.details;
    return Boolean(details && (details.billing === true || details.billing === 'true'));
  }

  function billingErrorCopy(error, options) {
    var code = billingErrorCode(error);
    var raw = String((error && error.message) || '')
      .replace(/^FirebaseError:\s*/i, '').trim();
    var staff = Boolean(options && options.staff);
    var fromServer = billingServerError(error);
    var retry = ' Please retry in a moment.';
    var contact = staff
      ? ''
      : ' If it continues, contact info@prayerdome.net and quote code ' + code + '.';

    switch (code) {
      case 'not-found':
        // A callable that is missing answers with a bare not-found. A server
        // decision says which record was missing, and that wording is safer
        // and more useful than calling the whole service unavailable.
        if (raw && (fromServer || !/^(not[- ]?found|the requested resource was not found\.?|404.*)$/i.test(raw))) {
          return raw;
        }
        return staff
          ? 'The billing function is not deployed for this project. Run "firebase deploy --only functions:billing --project prayer-dome", then retry.'
          : 'Billing is not available on this site yet. Please contact info@prayerdome.net and quote code not-found.';
      case 'unauthenticated':
        return fromServer && raw ? raw : 'Your sign-in has expired. Sign in again and retry.';
      case 'permission-denied':
        if (raw && (fromServer || !/missing or insufficient permissions|permission[- ]denied/i.test(raw))) {
          return raw;
        }
        return 'This account is not allowed to use billing yet. Ask the ministry office to approve your membership.';
      case 'unavailable':
      case 'deadline-exceeded':
        if (fromServer && raw) return raw;
        return 'Billing did not respond in time; the request was not completed.' + retry + contact;
      case 'resource-exhausted':
        return 'Billing is busy right now. Wait a moment and retry.';
      case 'internal':
        if (fromServer && raw) return raw;
        return 'Billing hit an internal error; the server did not confirm the request.' + retry + contact;
      case 'cancelled':
        return 'The billing request was cancelled before it finished. Please retry.';
      case 'failed-precondition':
      case 'invalid-argument':
      case 'already-exists':
      case 'out-of-range':
        return raw || ('Billing could not accept that request.' + retry);
      default:
        if (raw && !/^(internal|unknown|error)$/i.test(raw)) {
          return raw;
        }
        return 'Billing could not complete this request.' + retry + contact;
    }
  }

  function planPeriodLabel(plan) {
    var row = plan || {};
    if (row.billingPeriod === 'monthly') return 'per month';
    if (row.billingPeriod === 'annual') return 'per year';
    return row.billingPeriod ? 'per ' + row.billingPeriod : 'per month';
  }

  function normalizePlan(value, id) {
    var row = Object.assign({}, value || {});
    row.id = String(row.id || id || '').toLowerCase();
    row.price = Number(row.price != null ? row.price : row.monthlyAmount) || 0;
    row.currency = String(row.currency || 'USD').toUpperCase();
    row.billingPeriod = row.billingPeriod || 'monthly';
    row.durationMonths = Number(row.durationMonths) || 1;
    row.programMonths = Number(row.programMonths) || 12;
    row.active = row.active !== false;
    row.order = Number.isFinite(Number(row.order)) ? Number(row.order) : 1000;
    row.benefits = Array.isArray(row.benefits) ? row.benefits.filter(Boolean) : [];
    row.paymentInstructions = row.paymentInstructions || PAYMENT_INSTRUCTIONS;
    row.name = row.name || row.title || row.id;
    row.program = row.program || 'Support';
    row.tier = row.tier || '';
    row.summary = row.summary || '';
    return row;
  }

  global.PDBilling = {
    ORGANIZATION: ORGANIZATION,
    FOUNDER: FOUNDER,
    DEPARTMENT_LABELS: DEPARTMENT_LABELS,
    PAYMENT_METHODS: PAYMENT_METHODS,
    PAYMENT_INSTRUCTIONS: PAYMENT_INSTRUCTIONS,
    PAYMENT_METHOD_TYPE_LABELS: PAYMENT_METHOD_TYPE_LABELS,
    normalizePaymentMethod: normalizePaymentMethod,
    usablePaymentMethod: usablePaymentMethod,
    paymentMethodsFromSettings: paymentMethodsFromSettings,
    paymentMethodsFor: paymentMethodsFor,
    PLANS: PLANS,
    SUPPORT_PROGRAMMES: SUPPORT_PROGRAMMES,
    PROGRAM_ORDER: PROGRAM_ORDER,
    PROGRAM_THEMES: PROGRAM_THEMES,
    STATUS_LABELS: STATUS_LABELS,
    money: money,
    planById: planById,
    plansByProgram: plansByProgram,
    toDate: toDate,
    formatDate: formatDate,
    addMonths: addMonths,
    effectiveStatus: effectiveStatus,
    statusLabel: statusLabel,
    statusTone: statusTone,
    departmentLabel: departmentLabel,
    newReference: newReference,
    idempotencyKey: idempotencyKey,
    billingErrorCode: billingErrorCode,
    billingErrorCopy: billingErrorCopy,
    billingServerError: billingServerError,
    billingRetryable: billingRetryable,
    planPeriodLabel: planPeriodLabel,
    normalizePlan: normalizePlan,
    normalizeProgramme: normalizeProgramme
  };
})(typeof window !== 'undefined' ? window : globalThis);
