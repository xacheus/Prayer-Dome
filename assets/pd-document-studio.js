/*!
 * Prayer Dome — Document Studio
 * ===========================================================================
 * Official letters, memorandums, notices, reports, appointments, certificates
 * and policies, produced inside the admin console and exported as PDF, DOCX,
 * PNG or JPG.
 *
 * Records live in Firestore (`documents`) and are administrator-only. Every
 * save, approval, publication, signature and export appends to the document's
 * `audit` array, so the console can always answer who did what and when.
 *
 * Signatures are never invented. The studio lets an authorised signatory draw
 * on a canvas or upload their own signature image, and requires their name,
 * designation and signing date before a document can be approved. An unsigned
 * document exports with a blank signature line, not a fabricated one.
 */
(function (global) {
  'use strict';

  var COLLECTION = 'documents';
  var TYPES = [
    { id: 'letter', label: 'Official Letter' },
    { id: 'memorandum', label: 'Memorandum' },
    { id: 'announcement', label: 'Announcement' },
    { id: 'notice', label: 'Notice' },
    { id: 'report', label: 'Report' },
    { id: 'recommendation', label: 'Recommendation' },
    { id: 'appointment', label: 'Appointment' },
    { id: 'invitation', label: 'Invitation' },
    { id: 'appreciation', label: 'Appreciation Letter' },
    { id: 'certificate', label: 'Certificate' },
    { id: 'policy', label: 'Policy' },
    { id: 'internal', label: 'Internal Communication' }
  ];

  var state = {
    docs: [],
    current: null,
    signatureDirty: false,
    loading: false,
    bound: false,
    bridgeWait: 0
  };

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function bridge() {
    return global.PDAdmin && global.PDAdmin.firestore ? global.PDAdmin : null;
  }

  function toast(message, type) {
    if (global.PDAdmin && typeof global.PDAdmin.toast === 'function') global.PDAdmin.toast(message, type || 'success');
    else if (global.toast) global.toast(message, type || 'success');
  }

  function userLabel() {
    var user = global.PDAdmin && global.PDAdmin.auth && global.PDAdmin.auth.currentUser;
    if (!user) return 'Administrator';
    return user.displayName || user.email || 'Administrator';
  }

  function nowIso() { return new Date().toISOString(); }

  function todayValue() {
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function nextReference() {
    var year = new Date().getFullYear();
    var sequence = String(state.docs.length + 1).padStart(3, '0');
    return 'PD/DOC/' + year + '/' + sequence;
  }

  function typeLabel(id) {
    var found = TYPES.filter(function (type) { return type.id === id; })[0];
    return found ? found.label : 'Official Document';
  }

  /* ------------------------------------------------------------ signature */
  function signaturePadReady() {
    var canvas = $('docSignaturePad');
    if (!canvas || canvas.dataset.ready === 'true') return;
    var ctx = canvas.getContext('2d');
    var drawing = false;
    var last = null;
    var resize = function () {
      var ratio = Math.max(global.devicePixelRatio || 1, 1);
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var stored = canvas.dataset.drawn === 'true' ? canvas.toDataURL('image/png') : '';
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#10233f';
      if (stored) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, rect.width, rect.height); };
        img.src = stored;
      }
    };
    var point = function (event) {
      var rect = canvas.getBoundingClientRect();
      var touch = event.touches && event.touches[0];
      var clientX = touch ? touch.clientX : event.clientX;
      var clientY = touch ? touch.clientY : event.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top };
    };
    var start = function (event) {
      event.preventDefault();
      drawing = true;
      last = point(event);
      canvas.dataset.drawn = 'true';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
    };
    var move = function (event) {
      if (!drawing) return;
      event.preventDefault();
      var next = point(event);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      last = next;
    };
    var stop = function () {
      drawing = false;
      state.signatureDirty = true;
    };
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    global.addEventListener('pointerup', stop);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', stop);
    canvas.dataset.ready = 'true';
    resize();
    global.addEventListener('resize', resize);
  }

  function signatureDataUrl() {
    var canvas = $('docSignaturePad');
    if (canvas && canvas.dataset.drawn === 'true') {
      try { return canvas.toDataURL('image/png'); } catch (error) { return ''; }
    }
    var preview = $('docSignaturePreview');
    if (preview && preview.dataset.data) return preview.dataset.data;
    return '';
  }

  function clearSignature() {
    var canvas = $('docSignaturePad');
    if (canvas) {
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.dataset.drawn = 'false';
    }
    var preview = $('docSignaturePreview');
    if (preview) {
      preview.removeAttribute('src');
      preview.dataset.data = '';
      preview.hidden = true;
    }
    state.signatureDirty = true;
  }

  function uploadSignature(event) {
    var input = event && event.target ? event.target : $('docSignatureFile');
    var file = input && input.files && input.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('Choose a PNG or JPG image of the signature.', 'error');
      return;
    }
    if (file.size > 400 * 1024) {
      toast('Signature images must stay under 400 KB.', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var preview = $('docSignaturePreview');
      if (preview) {
        preview.src = String(reader.result);
        preview.dataset.data = String(reader.result);
        preview.hidden = false;
      }
      var canvas = $('docSignaturePad');
      if (canvas) {
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.dataset.drawn = 'false';
      }
      state.signatureDirty = true;
      toast('Signature image attached to this document.', 'success');
    };
    reader.onerror = function () { toast('That image could not be read.', 'error'); };
    reader.readAsDataURL(file);
  }

  /* -------------------------------------------------------------- helpers */
  function formatDateLabel(value) {
    if (!value) return '';
    var date = new Date(value + (String(value).length === 10 ? 'T12:00:00' : ''));
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function paragraphs(text) {
    return String(text || '')
      .split(/\n{2,}/)
      .map(function (block) { return block.trim(); })
      .filter(Boolean);
  }

  function hydrateForm(doc) {
    state.current = doc || null;
    $('docId').value = doc && doc.id ? doc.id : '';
    $('docType').value = (doc && doc.type) || 'letter';
    $('docTitle').value = (doc && doc.title) || '';
    $('docRef').value = (doc && doc.ref) || nextReference();
    $('docDate').value = (doc && doc.date) || todayValue();
    $('docFrom').value = (doc && doc.fromName) || 'Prayer Dome Ministry';
    $('docTo').value = (doc && doc.toName) || '';
    $('docSubject').value = (doc && doc.subject) || '';
    $('docBody').value = (doc && doc.body) || '';
    $('docAttachments').value = (doc && doc.attachments) || '';
    $('docSignatoryName').value = (doc && doc.signatoryName) || '';
    $('docSignatoryRole').value = (doc && doc.signatoryDesignation) || '';
    $('docSignedDate').value = (doc && doc.signedDate) || todayValue();
    $('docStatus').value = (doc && doc.status) || 'draft';

    var preview = $('docSignaturePreview');
    if (preview) {
      if (doc && doc.signature) {
        preview.src = doc.signature;
        preview.dataset.data = doc.signature;
        preview.hidden = false;
      } else {
        preview.removeAttribute('src');
        preview.dataset.data = '';
        preview.hidden = true;
      }
    }
    clearSignature();
    if (doc && doc.signature) {
      var previewAgain = $('docSignaturePreview');
      if (previewAgain) {
        previewAgain.src = doc.signature;
        previewAgain.dataset.data = doc.signature;
        previewAgain.hidden = false;
      }
    }
    renderAudit(doc);
    renderPreview();
  }

  function collectForm() {
    return {
      type: $('docType').value,
      title: $('docTitle').value.trim(),
      ref: $('docRef').value.trim(),
      date: $('docDate').value,
      fromName: $('docFrom').value.trim(),
      toName: $('docTo').value.trim(),
      subject: $('docSubject').value.trim(),
      body: $('docBody').value,
      attachments: $('docAttachments').value.trim(),
      signatoryName: $('docSignatoryName').value.trim(),
      signatoryDesignation: $('docSignatoryRole').value.trim(),
      signedDate: $('docSignedDate').value,
      signature: signatureDataUrl(),
      status: $('docStatus').value || 'draft'
    };
  }

  function validate(form, requireSignature) {
    if (!form.title) return 'Give the document a title.';
    if (!form.subject) return 'Add a subject line.';
    if (!form.body.trim()) return 'The document body cannot be empty.';
    if (requireSignature) {
      if (!form.signature) return 'Draw or upload the signature before approving this document.';
      if (!form.signatoryName) return 'Enter the signatory’s full name.';
      if (!form.signatoryDesignation) return 'Enter the signatory’s designation.';
      if (!form.signedDate) return 'Enter the signing date.';
    }
    return '';
  }

  /* ----------------------------------------------------------------- list */
  function renderList() {
    var host = $('docStudioList');
    if (!host) return;
    if (!state.docs.length) {
      host.innerHTML = '<p class="doc-empty"><i class="pd-i pd-i-file-text" aria-hidden="true"></i> No documents yet. Create the first one on the right.</p>';
      return;
    }
    host.innerHTML = state.docs.map(function (doc) {
      var status = doc.status || 'draft';
      return '<button type="button" class="doc-list-item' + (state.current && state.current.id === doc.id ? ' is-active' : '') + '" data-doc="' + esc(doc.id) + '">' +
        '<span class="doc-list-badge doc-status-' + esc(status) + '">' + esc(status) + '</span>' +
        '<span class="doc-list-title">' + esc(doc.title || 'Untitled document') + '</span>' +
        '<span class="doc-list-meta">' + esc(typeLabel(doc.type)) + ' · ' + esc(doc.ref || '') + '</span>' +
        '<span class="doc-list-date">' + esc(formatDateLabel(doc.date)) + '</span>' +
      '</button>';
    }).join('');
    host.querySelectorAll('[data-doc]').forEach(function (button) {
      button.addEventListener('click', function () { load(button.getAttribute('data-doc')); });
    });
  }

  function renderAudit(doc) {
    var host = $('docAudit');
    if (!host) return;
    var audit = (doc && Array.isArray(doc.audit) ? doc.audit : []).slice().reverse();
    if (!audit.length) {
      host.innerHTML = '<li><span>No activity recorded yet.</span></li>';
      return;
    }
    host.innerHTML = audit.map(function (entry) {
      var when = entry.at && entry.at.toDate ? entry.at.toDate() : new Date(entry.at || Date.now());
      var label = when && !isNaN(when.getTime())
        ? when.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      return '<li><strong>' + esc(entry.action || 'updated') + '</strong> — ' +
        esc(entry.by || 'Administrator') + (entry.note ? ' · ' + esc(entry.note) : '') +
        '<span class="doc-audit-time">' + esc(label) + '</span></li>';
    }).join('');
  }

  function renderPreview() {
    var host = $('docPreview');
    if (!host) return;
    var form = collectForm();
    var body = paragraphs(form.body);
    var signatureBlock = form.signature
      ? '<img src="' + form.signature + '" alt="Signature of ' + esc(form.signatoryName) + '" class="doc-sheet-signature">'
      : '<div class="doc-sheet-signspace"></div>';
    host.innerHTML = '' +
      '<div class="doc-sheet" id="docSheet">' +
        '<header class="doc-sheet-head">' +
          '<img src="/assets/logo.png" alt="Prayer Dome logo" class="doc-sheet-logo">' +
          '<div class="doc-sheet-org">' +
            '<strong>PRAYER DOME MINISTRY</strong>' +
            '<span>A House of Prayer for All Nations</span>' +
            '<span>Chama · Mahlabane · Hluthi · Cork · Online</span>' +
          '</div>' +
        '</header>' +
        '<div class="doc-sheet-meta">' +
          '<span><strong>Ref:</strong> ' + esc(form.ref || '—') + '</span>' +
          '<span><strong>Date:</strong> ' + esc(formatDateLabel(form.date)) + '</span>' +
        '</div>' +
        '<h2 class="doc-sheet-title">' + esc(form.title || 'Untitled document') + '</h2>' +
        '<p class="doc-sheet-subject"><strong>Subject:</strong> ' + esc(form.subject || '—') + '</p>' +
        '<div class="doc-sheet-routing">' +
          '<p><strong>From:</strong> ' + esc(form.fromName || '—') + '</p>' +
          '<p><strong>To:</strong> ' + esc(form.toName || '—') + '</p>' +
        '</div>' +
        '<div class="doc-sheet-body">' +
          (body.length ? body.map(function (block) {
            return '<p>' + esc(block).replace(/\n/g, '<br>') + '</p>';
          }).join('') : '<p class="doc-sheet-placeholder">The document body will appear here.</p>') +
        '</div>' +
        (form.attachments ? '<p class="doc-sheet-attachments"><strong>Attachments:</strong> ' + esc(form.attachments) + '</p>' : '') +
        '<div class="doc-sheet-sign">' +
          signatureBlock +
          '<div class="doc-sheet-signline"></div>' +
          '<strong>' + esc(form.signatoryName || '________________________') + '</strong>' +
          '<span>' + esc(form.signatoryDesignation || 'Designation') + '</span>' +
          '<span>Signed: ' + esc(formatDateLabel(form.signedDate)) + '</span>' +
        '</div>' +
        '<footer class="doc-sheet-foot">Prayer Dome Ministry · prayerdome.net · info@prayerdome.net</footer>' +
      '</div>';
  }

  /* ------------------------------------------------------------ persistence */
  async function refresh() {
    var api = bridge();
    if (!api) return;
    try {
      var store = api.firestore;
      var snapshot = await store.getDocs(store.query(store.collection(api.db, COLLECTION), store.orderBy('updatedAt', 'desc'), store.limit(100)));
      state.docs = [];
      snapshot.forEach(function (entry) {
        state.docs.push(Object.assign({ id: entry.id }, entry.data()));
      });
      renderList();
    } catch (error) {
      console.error('Document list failed:', error);
      var host = $('docStudioList');
      if (host) {
        host.innerHTML = '<p class="doc-empty doc-empty-error"><i class="pd-i pd-i-triangle-alert" aria-hidden="true"></i> ' +
          (error && error.code === 'permission-denied'
            ? 'Your account does not have Document Studio access.'
            : 'Documents could not be loaded. Check the connection and try again.') + '</p>';
      }
    }
  }

  async function load(id) {
    var api = bridge();
    if (!api || !id) return;
    try {
      var store = api.firestore;
      var snapshot = await store.getDoc(store.doc(api.db, COLLECTION, id));
      if (!snapshot.exists()) { toast('That document no longer exists.', 'error'); return; }
      hydrateForm(Object.assign({ id: snapshot.id }, snapshot.data()));
      renderList();
      var editor = $('docStudioEditor');
      if (editor) editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error(error);
      toast('Could not open that document.', 'error');
    }
  }

  async function save(nextStatus) {
    var api = bridge();
    if (!api) { toast('Document Studio is still starting. Try again in a moment.', 'error'); return; }
    var form = collectForm();
    var status = nextStatus || form.status || 'draft';
    var requireSignature = status === 'approved' || status === 'published';
    var problem = validate(form, requireSignature);
    if (problem) { toast(problem, 'error'); return; }
    form.status = status;
    var id = $('docId').value;
    var action = id ? (status === 'draft' ? 'edited' : status === 'approved' ? 'approved' : 'published') : 'created';
    var entry = { action: action, by: userLabel(), at: nowIso() };
    try {
      var store = api.firestore;
      if (id) {
        var existing = state.docs.filter(function (doc) { return doc.id === id; })[0];
        var audit = (existing && Array.isArray(existing.audit) ? existing.audit : []).concat([entry]);
        await store.updateDoc(store.doc(api.db, COLLECTION, id), Object.assign({}, form, {
          audit: audit,
          updatedAt: store.serverTimestamp(),
          signedAt: requireSignature ? (existing && existing.signedAt) || store.serverTimestamp() : null
        }));
      } else {
        var created = await store.addDoc(store.collection(api.db, COLLECTION), Object.assign({}, form, {
          audit: [entry],
          createdAt: store.serverTimestamp(),
          updatedAt: store.serverTimestamp(),
          createdBy: userLabel(),
          signedAt: requireSignature ? store.serverTimestamp() : null
        }));
        $('docId').value = created.id;
      }
      $('docStatus').value = status;
      toast('Document saved as ' + status + '.', 'success');
      await refresh();
      renderPreview();
    } catch (error) {
      console.error('Document save failed:', error);
      toast(error && error.code === 'permission-denied'
        ? 'Your account does not have permission to save documents.'
        : 'The document could not be saved. Please try again.', 'error');
    }
  }

  async function remove(id) {
    var api = bridge();
    if (!api) return;
    var target = state.docs.filter(function (doc) { return doc.id === id; })[0];
    if (!target) return;
    if (!global.confirm('Delete “' + (target.title || 'this document') + '”?\n\nThe audit trail is removed with it. Approved and published documents should normally be kept.')) return;
    try {
      var store = api.firestore;
      await store.deleteDoc(store.doc(api.db, COLLECTION, id));
      if ($('docId').value === id) newDoc();
      toast('Document deleted.', 'success');
      await refresh();
    } catch (error) {
      toast('Could not delete that document.', 'error');
    }
  }

  function newDoc() {
    hydrateForm(null);
    var editor = $('docStudioEditor');
    if (editor) editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var title = $('docTitle');
    if (title) title.focus();
    renderList();
  }

  /* ------------------------------------------------------------------ DOCX */
  /* A minimal, standards-correct .docx writer: ZIP (stored, CRC-32) containing
     the OOXML parts Word/LibreOffice expect. No library, no server, and the
     signature image travels inside the file as word/media/signature.png. */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function base64Bytes(dataUrl) {
    var base64 = String(dataUrl || '').split(',')[1] || '';
    var binary = global.atob ? global.atob(base64) : '';
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function zipStore(files) {
    var encoder = new TextEncoder();
    var chunks = [];
    var central = [];
    var offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    files.forEach(function (file) {
      var nameBytes = encoder.encode(file.name);
      var data = file.bytes instanceof Uint8Array ? file.bytes : encoder.encode(String(file.content || ''));
      var crc = crc32(data);
      var local = new Uint8Array(30 + nameBytes.length);
      var view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true); // stored
      view.setUint16(10, dosTime, true);
      view.setUint16(12, dosDate, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      var header = new Uint8Array(46 + nameBytes.length);
      var hview = new DataView(header.buffer);
      hview.setUint32(0, 0x02014b50, true);
      hview.setUint16(4, 20, true);
      hview.setUint16(6, 20, true);
      hview.setUint16(8, 0, true);
      hview.setUint16(10, 0, true);
      hview.setUint16(12, dosTime, true);
      hview.setUint16(14, dosDate, true);
      hview.setUint32(16, crc, true);
      hview.setUint32(20, data.length, true);
      hview.setUint32(24, data.length, true);
      hview.setUint16(28, nameBytes.length, true);
      hview.setUint16(30, 0, true);
      hview.setUint16(32, 0, true);
      hview.setUint16(34, 0, true);
      hview.setUint16(36, 0, true);
      hview.setUint32(38, 0, true);
      hview.setUint32(42, offset, true);
      header.set(nameBytes, 46);
      central.push(header);

      offset += local.length + data.length;
    });

    var centralSize = central.reduce(function (sum, part) { return sum + part.length; }, 0);
    var end = new Uint8Array(22);
    var eview = new DataView(end.buffer);
    eview.setUint32(0, 0x06054b50, true);
    eview.setUint16(4, 0, true);
    eview.setUint16(6, 0, true);
    eview.setUint16(8, files.length, true);
    eview.setUint16(10, files.length, true);
    eview.setUint32(12, centralSize, true);
    eview.setUint32(16, offset, true);
    eview.setUint16(20, 0, true);

    var all = chunks.concat(central, [end]);
    var total = all.reduce(function (sum, part) { return sum + part.length; }, 0);
    var out = new Uint8Array(total);
    var position = 0;
    all.forEach(function (part) { out.set(part, position); position += part.length; });
    return out;
  }

  function xmlEscape(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function wParagraph(text, options) {
    var opts = options || {};
    var props = '<w:pPr>';
    if (opts.align) props += '<w:jc w:val="' + opts.align + '"/>';
    if (opts.spacingAfter != null) props += '<w:spacing w:after="' + opts.spacingAfter + '"/>';
    props += '<w:rPr>' +
      (opts.bold ? '<w:b/>' : '') +
      (opts.size ? '<w:sz w:val="' + opts.size + '"/><w:szCs w:val="' + opts.size + '"/>' : '') +
      (opts.color ? '<w:color w:val="' + opts.color + '"/>' : '') +
      '</w:rPr></w:pPr>';
    var runs = String(text == null ? '' : text).split('\n').map(function (line) {
      return '<w:r><w:t xml:space="preserve">' + xmlEscape(line) + '</w:t></w:r>';
    }).join('<w:r><w:br/></w:r>');
    return '<w:p>' + props + (runs || '<w:r><w:t xml:space="preserve"></w:t></w:r>') + '</w:p>';
  }

  function buildDocx(form) {
    var hasSignature = !!form.signature;
    var body = [];
    body.push(wParagraph('PRAYER DOME MINISTRY', { bold: true, size: 36, align: 'center', color: '0A4D9B', spacingAfter: 40 }));
    body.push(wParagraph('A House of Prayer for All Nations · Chama · Mahlabane · Hluthi · Cork', { size: 18, align: 'center', color: '64748B', spacingAfter: 240 }));
    body.push(wParagraph('Ref: ' + (form.ref || '—') + '          Date: ' + formatDateLabel(form.date), { size: 20, spacingAfter: 240 }));
    body.push(wParagraph(form.title || typeLabel(form.type), { bold: true, size: 30, align: 'center', spacingAfter: 160 }));
    body.push(wParagraph('Subject: ' + (form.subject || '—'), { bold: true, size: 22, spacingAfter: 160 }));
    body.push(wParagraph('From: ' + (form.fromName || '—'), { size: 22, spacingAfter: 40 }));
    body.push(wParagraph('To: ' + (form.toName || '—'), { size: 22, spacingAfter: 200 }));

    paragraphs(form.body).forEach(function (block) {
      body.push(wParagraph(block, { size: 22, spacingAfter: 160 }));
    });

    if (form.attachments) {
      body.push(wParagraph('Attachments: ' + form.attachments, { size: 20, spacingAfter: 200 }));
    }

    body.push(wParagraph('', { spacingAfter: 240 }));
    if (hasSignature) {
      body.push('<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="1828800" cy="609600"/>' +
        '<wp:docPr id="1" name="Authorized signature"/>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:nvPicPr><pic:cNvPr id="1" name="signature.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="609600"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>');
    } else {
      body.push(wParagraph('______________________________', { size: 22, spacingAfter: 0 }));
    }
    body.push(wParagraph(form.signatoryName || 'Authorized signatory', { bold: true, size: 22, spacingAfter: 0 }));
    body.push(wParagraph(form.signatoryDesignation || '', { size: 20, color: '64748B', spacingAfter: 0 }));
    body.push(wParagraph('Signed: ' + formatDateLabel(form.signedDate), { size: 20, color: '64748B', spacingAfter: 240 }));
    body.push(wParagraph('Prayer Dome Ministry · prayerdome.net · info@prayerdome.net', { size: 16, color: '94A3B8', align: 'center' }));

    var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<w:body>' + body.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
      '</w:body></w:document>';

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (hasSignature ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>';

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';

    var documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      (hasSignature ? '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/signature.png"/>' : '') +
      '</Relationships>';

    var files = [
      { name: '[Content_Types].xml', content: contentTypes },
      { name: '_rels/.rels', content: rels },
      { name: 'word/document.xml', content: documentXml },
      { name: 'word/_rels/document.xml.rels', content: documentRels }
    ];
    if (hasSignature) {
      files.push({ name: 'word/media/signature.png', bytes: base64Bytes(form.signature) });
    }
    return zipStore(files);
  }

  /* --------------------------------------------------------------- exports */
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function safeName(form) {
    var base = (form.ref || form.title || 'Prayer-Dome-document')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'Prayer-Dome-document';
  }

  var pendingExport = '';

  async function exportAs(format) {
    var api = bridge();
    var form = collectForm();
    var problem = validate(form, false);
    if (problem) { toast(problem, 'error'); return; }
    var name = safeName(form);
    try {
      if (format === 'docx') {
        var bytes = buildDocx(form);
        download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), name + '.docx');
        toast('DOCX created — the signature image is inside the file.', 'success');
      } else if (format === 'pdf') {
        pendingExport = 'pdf';
        openPrintSheet(form);
        toast('Choose “Save as PDF” in the print dialog.', 'info');
      } else if (format === 'png' || format === 'jpg') {
        var sheet = $('docSheet');
        if (!sheet || typeof global.html2canvas !== 'function') {
          toast('Image export needs the document preview. Reload the console and try again.', 'error');
          return;
        }
        var canvas = await global.html2canvas(sheet, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
        var mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
        var dataUrl = canvas.toDataURL(mime, 0.94);
        var link = document.createElement('a');
        link.href = dataUrl;
        link.download = name + '.' + (format === 'jpg' ? 'jpg' : 'png');
        link.click();
        toast('Document image saved.', 'success');
      }
      await logExport(format, api);
    } catch (error) {
      console.error('Export failed:', error);
      toast('The document could not be exported. Please try again.', 'error');
    }
  }

  async function logExport(format, api) {
    var id = $('docId').value;
    if (!id || !api) return;
    try {
      var store = api.firestore;
      var existing = state.docs.filter(function (doc) { return doc.id === id; })[0];
      var audit = (existing && Array.isArray(existing.audit) ? existing.audit : []).concat([{
        action: 'exported ' + String(format).toUpperCase(),
        by: userLabel(),
        at: nowIso()
      }]);
      await store.updateDoc(store.doc(api.db, COLLECTION, id), { audit: audit, updatedAt: store.serverTimestamp() });
      await refresh();
    } catch (error) {
      // An export must still succeed if the audit write is offline.
      console.warn('Export audit entry not saved:', error && error.message);
    }
  }

  function openPrintSheet(form) {
    var win = global.open('', '_blank');
    if (!win) { toast('Allow pop-ups for the admin console to print or save a PDF.', 'error'); return; }
    var body = paragraphs(form.body).map(function (block) {
      return '<p>' + esc(block).replace(/\n/g, '<br>') + '</p>';
    }).join('');
    var signature = form.signature
      ? '<img src="' + form.signature + '" alt="Signature">'
      : '<div style="height:38px"></div>';
    win.document.write('<!DOCTYPE html><html><head><title>' + esc(form.title || 'Prayer Dome document') + '</title>' +
      '<style>' +
      '@page{size:A4;margin:18mm}body{font-family:Georgia,"Times New Roman",serif;color:#10233f;line-height:1.7;font-size:12pt}' +
      '.head{display:flex;gap:14px;align-items:center;border-bottom:3px solid #0A4D9B;padding-bottom:10px;margin-bottom:18px}' +
      '.head img{width:54px;height:54px;object-fit:contain}' +
      '.org strong{display:block;font-size:15pt;letter-spacing:.08em;color:#0A4D9B}' +
      '.org span{display:block;font-size:8.5pt;color:#5b6b82;letter-spacing:.06em;text-transform:uppercase}' +
      '.meta{display:flex;justify-content:space-between;font-size:10pt;color:#334155;margin-bottom:14px}' +
      'h1{font-size:15pt;text-align:center;margin:6px 0 14px;text-transform:uppercase;letter-spacing:.04em}' +
      '.subject{font-weight:700;margin-bottom:14px}.routing p{margin:0 0 4px;font-size:10.5pt}' +
      '.body{margin-top:16px}.sign{margin-top:38px;page-break-inside:avoid}' +
      '.sign img{max-height:60px;max-width:220px;object-fit:contain;display:block;margin-bottom:4px}' +
      '.sign .line{width:240px;border-top:1px solid #10233f;margin-bottom:4px}' +
      '.sign strong{display:block;font-size:11pt}.sign span{display:block;font-size:9.5pt;color:#5b6b82}' +
      '.foot{margin-top:30px;border-top:1px solid #dbe3ee;padding-top:8px;font-size:8pt;color:#94a3b8;text-align:center}' +
      '</style></head><body>' +
      '<div class="head"><img src="/assets/logo.png" alt=""><div class="org"><strong>PRAYER DOME MINISTRY</strong>' +
      '<span>A House of Prayer for All Nations</span><span>Chama · Mahlabane · Hluthi · Cork · Online</span></div></div>' +
      '<div class="meta"><span><strong>Ref:</strong> ' + esc(form.ref || '—') + '</span><span><strong>Date:</strong> ' + esc(formatDateLabel(form.date)) + '</span></div>' +
      '<h1>' + esc(form.title || typeLabel(form.type)) + '</h1>' +
      '<p class="subject">Subject: ' + esc(form.subject || '—') + '</p>' +
      '<div class="routing"><p><strong>From:</strong> ' + esc(form.fromName || '—') + '</p><p><strong>To:</strong> ' + esc(form.toName || '—') + '</p></div>' +
      '<div class="body">' + body + '</div>' +
      (form.attachments ? '<p><strong>Attachments:</strong> ' + esc(form.attachments) + '</p>' : '') +
      '<div class="sign">' + signature + '<div class="line"></div><strong>' + esc(form.signatoryName || '________________________') + '</strong>' +
      '<span>' + esc(form.signatoryDesignation || 'Designation') + '</span><span>Signed: ' + esc(formatDateLabel(form.signedDate)) + '</span></div>' +
      '<div class="foot">Prayer Dome Ministry · prayerdome.net · info@prayerdome.net</div>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>' +
      '</body></html>');
    win.document.close();
  }

  /* ------------------------------------------------------------------ init */
  function bind() {
    if (state.bound) return;
    state.bound = true;
    signaturePadReady();
    var form = $('docStudioForm');
    if (form) {
      form.addEventListener('input', function () { renderPreview(); });
      form.addEventListener('change', function () { renderPreview(); });
      form.addEventListener('submit', function (event) { event.preventDefault(); save(); });
    }
    var file = $('docSignatureFile');
    if (file) file.addEventListener('change', uploadSignature);
    var search = $('docStudioSearch');
    if (search) {
      search.addEventListener('input', function () {
        var term = search.value.trim().toLowerCase();
        var host = $('docStudioList');
        if (!host) return;
        host.querySelectorAll('[data-doc]').forEach(function (button) {
          var text = button.textContent.toLowerCase();
          button.hidden = !!term && text.indexOf(term) === -1;
        });
      });
    }
    renderPreview();
  }

  function waitForBridge() {
    if (bridge()) {
      bind();
      refresh();
      return;
    }
    state.bridgeWait += 1;
    if (state.bridgeWait > 80) {
      var host = $('docStudioList');
      if (host) host.innerHTML = '<p class="doc-empty doc-empty-error"><i class="pd-i pd-i-triangle-alert" aria-hidden="true"></i> The admin session did not start. Reload the console and sign in again.</p>';
      return;
    }
    global.setTimeout(waitForBridge, 250);
  }

  function init() {
    if (typeof document === 'undefined' || !$('docStudioList')) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', waitForBridge, { once: true });
    } else {
      waitForBridge();
    }
  }

  var api = {
    TYPES: TYPES,
    init: init,
    refresh: refresh,
    newDoc: newDoc,
    load: load,
    save: save,
    remove: remove,
    approve: function () { return save('approved'); },
    publish: function () { return save('published'); },
    exportAs: exportAs,
    clearSignature: clearSignature,
    uploadSignature: uploadSignature,
    renderPreview: renderPreview,
    buildDocx: buildDocx,
    state: state
  };

  global.PDDoc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  init();
})(typeof window !== 'undefined' ? window : globalThis);
