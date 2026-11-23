/* ==========================================================================
   Prayer Dome — certificate download
   --------------------------------------------------------------------------
   Renders Academy completion certificates to a canvas and downloads them as
   print-ready PDF files (with a PNG option for sharing). Runs entirely in the
   browser — a tiny built-in PDF writer embeds the canvas as a JPEG, so there is
   no external library and no network dependency.

   Usage:
     PDCertificate.download({ name, course, score, id, date });
     PDCertificate.bindButton(button, { name, course, score, id, date });
   ========================================================================== */
(function () {
  'use strict';

  var W = 1600;
  var H = 1131; // A4 landscape ratio
  var NAVY = '#1d2a6b';
  var NAVY_SOFT = '#2b3a8f';
  var GOLD = '#c9a227';
  var GOLD_DARK = '#8f7410';
  var GOLD_LIGHT = '#e6c94f';
  var IVORY = '#fbf7ec';
  var MUTED = '#6b675c';
  var SERIF = "Georgia, 'Times New Roman', serif";
  var VERSE = '“He does everything blamelessly.” — Mark 7:37';
  var ORGANISATION = 'PRAYER DOME';
  var FOUNDER_NAME = 'S. K. MASUKU';
  var FOUNDER_TITLE = 'Founder and President';
  // The founder's official signing mark ships with the site, so a certificate
  // always carries a real signature even before an administrator uploads one.
  var DEFAULT_SIGNATURE_URL = '/assets/pd-signature.png';

  var logoPromise = null;
  var sigPromise = null;

  function loadedPageLogo() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    var images = document.querySelectorAll('img[src*="/assets/logo"]');
    for (var i = 0; i < images.length; i++) {
      if (images[i].complete && images[i].naturalWidth && images[i].naturalHeight) return images[i];
    }
    return null;
  }

  function loadImage(url) {
    if (typeof Image === 'undefined') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      function done(img) { if (!settled) { settled = true; resolve(img); } }
      var img = new Image();
      // Cross-origin media service images must be drawn without tainting the
      // canvas (which would break toDataURL/toBlob on the final certificate).
      try { img.crossOrigin = 'anonymous'; } catch (e) {}
      img.onload = function () { done(img); };
      img.onerror = function () { done(null); };
      img.src = url;
      setTimeout(function () { done(null); }, 1800);
    });
  }

  function loadLogo() {
    if (!logoPromise) {
      logoPromise = new Promise(function (resolve) {
        var settled = false;
        function done(img) { if (!settled) { settled = true; resolve(img); } }
        var onPage = loadedPageLogo();
        if (onPage) { done(onPage); return; }
        if (typeof Image === 'undefined') { done(null); return; }
        var img = new Image();
        // A cloud-hosted logo must not taint the certificate canvas.
        try { img.crossOrigin = 'anonymous'; } catch (e) {}
        img.onload = function () { done(img); };
        img.onerror = function () { done(null); };
        img.src = '/assets/logo.png';
        // A slow or unavailable image must never leave certificate buttons spinning.
        setTimeout(function () { done(null); }, 1800);
      });
    }
    return logoPromise;
  }

  /* ==========================================================================
     Founder signature — the ministry's "official signature" that every future
     certificate automatically uses. The signature lives with the founder's
     name and position in admin's `settings`/`founder` document. Clients cache
     it locally so certificates still render the founder's mark offline.
     ========================================================================== */
  function founderSignatureFromDom() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    try {
      // Admin previews embed the current signature as a data URL so the exact
      // image being saved is what renders.
      var meta = document.querySelector('meta[name="pd-founder-signature"]');
      if (meta && meta.content) return meta.content;
      var img = document.querySelector('img[data-pd-founder-signature]');
      if (img && img.complete && img.naturalWidth && img.naturalHeight) return img.src;
    } catch (e) {}
    return null;
  }

  function founderSignatureFromStorage() {
    try {
      var raw = localStorage.getItem('pd_founder_signature');
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && (parsed.signatureUrl || parsed.administratorSignatureUrl)) {
        return {
          url: parsed.signatureUrl || '',
          name: FOUNDER_NAME,
          title: FOUNDER_TITLE,
          administratorName: parsed.administratorName || '',
          administratorTitle: parsed.administratorTitle || '',
          administratorSignatureUrl: parsed.administratorSignatureUrl || ''
        };
      }
      return null;
    } catch (e) { return null; }
  }

  function normalizeSignatureMeta(meta) {
    if (!meta) return null;
    return {
      url: meta.url || meta.signatureUrl || '',
      name: FOUNDER_NAME,
      title: FOUNDER_TITLE,
      administratorName: meta.administratorName || '',
      administratorTitle: meta.administratorTitle || '',
      administratorSignatureUrl: meta.administratorSignatureUrl || ''
    };
  }

  function loadFounderSignatureData() {
    if (!sigPromise) {
      sigPromise = new Promise(function (resolve) {
        var settled = false;
        function done(meta) { if (!settled) { settled = true; resolve(meta); } }
        try {
          // Firestore is authoritative when signed in.
          var pd = window.PDApp;
          if (pd && pd._fb && pd._fb.auth && pd._fb.auth.currentUser) {
            pd.loadFounderSignature().then(function (m) { done(normalizeSignatureMeta(m)); }).catch(function () { done(null); });
            setTimeout(function () { done(null); }, 2500);
            return;
          }
        } catch (e) {}
        done(founderSignatureFromStorage() || { url: founderSignatureFromDom(), name: FOUNDER_NAME, title: FOUNDER_TITLE, administratorSignatureUrl: '' });
      });
    }
    return sigPromise;
  }

  function loadFounderSignatureImage(meta) {
    // An administrator-uploaded mark wins; the bundled official mark is the
    // permanent fallback so no certificate is ever issued with a blank line.
    return loadImage((meta && meta.url) || DEFAULT_SIGNATURE_URL);
  }

  function loadAdministratorSignatureImage(meta) {
    if (!meta || !meta.administratorSignatureUrl) return Promise.resolve(null);
    return loadImage(meta.administratorSignatureUrl);
  }

  function ellipse(ctx, cx, cy, rx, ry, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function star(ctx, cx, cy, spikes, outerR, innerR, color) {
    var rot = (Math.PI / 2) * 3;
    var step = Math.PI / spikes;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - outerR);
    for (var i = 0; i < spikes; i++) {
      ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR); rot += step;
      ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR); rot += step;
    }
    ctx.lineTo(cx, cy - outerR);
    ctx.closePath();
    ctx.fill();
  }

  function seal(ctx, cx, cy, scale) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale || 1, scale || 1);
    // ribbons
    ctx.fillStyle = NAVY_SOFT;
    ctx.beginPath(); ctx.moveTo(-26, 34); ctx.lineTo(-54, 116); ctx.lineTo(-26, 98); ctx.lineTo(-2, 116); ctx.closePath(); ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.beginPath(); ctx.moveTo(26, 34); ctx.lineTo(54, 116); ctx.lineTo(26, 98); ctx.lineTo(2, 116); ctx.closePath(); ctx.fill();
    // scalloped edge
    for (var i = 0; i < 18; i++) {
      var a = (i / 18) * Math.PI * 2;
      ellipse(ctx, Math.cos(a) * 66, Math.sin(a) * 66, 8, 8, GOLD_DARK);
    }
    ellipse(ctx, 0, 0, 62, 62, GOLD);
    ellipse(ctx, 0, 0, 52, 52, IVORY);
    ctx.strokeStyle = GOLD_DARK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.stroke();
    star(ctx, 0, 2, 5, 30, 13, GOLD);
    ctx.restore();
  }

  function diamond(ctx, cx, cy, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
    ctx.closePath(); ctx.fill();
  }

  function fallbackMark(ctx) {
    // Fast vector fallback for offline WebViews: the certificate still displays
    // a recognisable Prayer Dome book-and-dome mark if the PNG is unavailable.
    ctx.save();
    ctx.translate(W / 2, 184);
    ctx.strokeStyle = NAVY_SOFT;
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(-110, 28); ctx.quadraticCurveTo(-82, -74, 0, -112);
    ctx.quadraticCurveTo(82, -74, 110, 28); ctx.stroke();
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(-96, 44); ctx.lineTo(-8, 82); ctx.lineTo(0, 98); ctx.lineTo(8, 82); ctx.lineTo(96, 44);
    ctx.lineTo(18, 112); ctx.lineTo(0, 124); ctx.lineTo(-18, 112); ctx.closePath(); ctx.fill();
    ctx.fillStyle = NAVY;
    ctx.font = "700 48px " + SERIF;
    ctx.textAlign = 'center';
    ctx.fillText('PD', 0, 12);
    ctx.restore();
  }

  function spaced(ctx, text, cx, y, spacing) {
    var chars = String(text).split('');
    var widths = chars.map(function (c) { return ctx.measureText(c).width; });
    var total = widths.reduce(function (a, b) { return a + b; }, 0) + spacing * Math.max(0, chars.length - 1);
    var x = cx - total / 2;
    var align = ctx.textAlign;
    ctx.textAlign = 'left';
    chars.forEach(function (c, i) { ctx.fillText(c, x, y); x += widths[i] + spacing; });
    ctx.textAlign = align;
  }

  function fitFont(ctx, text, maxWidth, baseSize, style, weight) {
    var size = baseSize;
    while (size > 24) {
      ctx.font = style + ' ' + weight + ' ' + size + 'px ' + SERIF;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 2;
    }
    return size;
  }

  function fmtDate(iso) {
    try {
      var d = iso ? new Date(iso) : new Date();
      if (isNaN(d.getTime())) d = new Date();
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function drawSignatureBlock(ctx, x, name, title, image, fallbackLabel) {
    ctx.save();
    ctx.textAlign = 'center';
    var ruleY = 950;
    var label = String(name || fallbackLabel || '').trim();
    var imageDrawn = false;
    if (image && image.naturalWidth) {
      // The ink sits on the rule, with its lower edge six pixels above the line
      // so a descender never collides with the printed name underneath.
      var sw = 260;
      var sh = (sw * image.naturalHeight) / image.naturalWidth;
      if (sh > 78) { sh = 78; sw = (sh * image.naturalWidth) / image.naturalHeight; }
      try { ctx.drawImage(image, x - sw / 2, ruleY - sh - 6, sw, sh); imageDrawn = true; } catch (e) { imageDrawn = false; }
    }
    ctx.strokeStyle = MUTED; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 150, ruleY); ctx.lineTo(x + 150, ruleY); ctx.stroke();
    ctx.fillStyle = MUTED;
    if (label) {
      var size = Math.min(19, 300 / Math.max(12, label.length) * 2.0);
      ctx.font = '700 ' + Math.max(12, size) + 'px ' + SERIF;
      spaced(ctx, label.toUpperCase(), x, 980, Math.max(1.2, 4.6 - label.length * 0.08));
    }
    ctx.fillStyle = NAVY_SOFT;
    ctx.font = '600 16px ' + SERIF;
    ctx.fillText(title || '', x, 1004);
    ctx.fillStyle = GOLD_DARK;
    ctx.font = '700 13px ' + SERIF;
    spaced(ctx, ORGANISATION, x, 1028, 4);
    ctx.restore();
  }

  function drawMeta(ctx, cx, label, value) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = MUTED;
    ctx.font = '700 14px ' + SERIF;
    spaced(ctx, label, cx, 758, 3.2);
    ctx.fillStyle = NAVY;
    var size = 28;
    ctx.font = '700 ' + size + 'px ' + SERIF;
    while (size > 12 && ctx.measureText(String(value)).width > 340) {
      size -= 1;
      ctx.font = '700 ' + size + 'px ' + SERIF;
    }
    ctx.fillText(String(value), cx, 792);
    ctx.restore();
  }

  function drawMetaDivider(ctx, x) {
    ctx.save();
    ctx.strokeStyle = 'rgba(201, 162, 39, .55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 742); ctx.lineTo(x, 800); ctx.stroke();
    ctx.restore();
  }

  function draw(ctx, opts, logo, sigMeta, sigImg, adminSigImg) {
    var name = String(opts.name || 'Prayer Dome Member');
    var course = String(opts.course || 'Prayer Dome Academy Lesson');
    var score = Math.round(Number(opts.score) || 0);
    var certId = String(opts.id || 'PD-CERT');

    // background
    ctx.fillStyle = IVORY;
    ctx.fillRect(0, 0, W, H);
    var glow = ctx.createRadialGradient(W / 2, H / 2, 120, W / 2, H / 2, W * 0.62);
    glow.addColorStop(0, 'rgba(255, 252, 240, 0.95)');
    glow.addColorStop(1, 'rgba(238, 228, 198, 0.35)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // frame
    ctx.strokeStyle = NAVY; ctx.lineWidth = 14;
    ctx.strokeRect(34, 34, W - 68, H - 68);
    ctx.strokeStyle = GOLD; ctx.lineWidth = 3;
    ctx.strokeRect(58, 58, W - 116, H - 116);
    [[34, 34], [W - 34, 34], [34, H - 34], [W - 34, H - 34]].forEach(function (c) {
      diamond(ctx, c[0], c[1], 12, GOLD);
    });

    // logo
    if (logo && logo.naturalWidth) {
      var lh = 182;
      var lw = (lh * logo.naturalWidth) / logo.naturalHeight;
      if (lw > 260) { lw = 260; lh = (lw * logo.naturalHeight) / logo.naturalWidth; }
      ctx.drawImage(logo, (W - lw) / 2, 88, lw, lh);
    } else {
      fallbackMark(ctx);
    }

    ctx.fillStyle = GOLD_DARK;
    ctx.font = "600 27px " + SERIF;
    spaced(ctx, 'PRAYER DOME ACADEMY', W / 2, 332, 10);

    ctx.textAlign = 'center';
    ctx.fillStyle = NAVY;
    ctx.font = "700 72px " + SERIF;
    ctx.fillText('Certificate of Completion', W / 2, 420);

    // divider
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W / 2 - 250, 452); ctx.lineTo(W / 2 - 24, 452); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W / 2 + 24, 452); ctx.lineTo(W / 2 + 250, 452); ctx.stroke();
    diamond(ctx, W / 2, 452, 10, GOLD);

    ctx.fillStyle = MUTED;
    ctx.font = "italic 27px " + SERIF;
    ctx.fillText('This certifies that', W / 2, 505);

    // recipient name with flourish underline
    var nSize = fitFont(ctx, name, 1100, 64, 'normal', '700');
    ctx.fillStyle = NAVY;
    ctx.font = "700 " + nSize + "px " + SERIF;
    ctx.fillText(name, W / 2, 566);
    var nw = Math.min(ctx.measureText(name).width + 90, 1180);
    ctx.strokeStyle = GOLD; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(W / 2 - nw / 2, 594);
    ctx.quadraticCurveTo(W / 2, 608, W / 2 + nw / 2, 594);
    ctx.stroke();

    ctx.fillStyle = MUTED;
    ctx.font = "italic 27px " + SERIF;
    ctx.fillText('has successfully completed', W / 2, 644);

    var cSize = fitFont(ctx, course, 1280, 46, 'normal', '700');
    ctx.fillStyle = GOLD_DARK;
    ctx.font = "700 " + cSize + "px " + SERIF;
    ctx.fillText(course, W / 2, 700);

    // A clear, three-part record line: the score, the date and the reference
    // all have their own space so the certificate number is never buried in a
    // run-on sentence.
    drawMeta(ctx, 380, 'FINAL SCORE', score + '%');
    drawMeta(ctx, 800, 'COMPLETED', fmtDate(opts.date));
    drawMeta(ctx, 1220, 'CERTIFICATE ID', certId);
    drawMetaDivider(ctx, 590);
    drawMetaDivider(ctx, 1010);

    ctx.fillStyle = NAVY_SOFT;
    ctx.font = "italic 26px " + SERIF;
    ctx.fillText(VERSE, W / 2, 842);

    // Two separate signature areas. The founder block carries the authorised
    // name (S. K. MASUKU), designation and official signing mark. The right
    // block is the authorised administrator who signed this certificate; it
    // stays blank when no administrator signature is configured rather than
    // inventing one.
    var adminName = (sigMeta && sigMeta.administratorName) ? String(sigMeta.administratorName) : '';
    var adminTitle = (sigMeta && sigMeta.administratorTitle) ? String(sigMeta.administratorTitle) : 'Prayer Dome Academy';
    drawSignatureBlock(ctx, 400, FOUNDER_NAME, FOUNDER_TITLE, sigImg);
    drawSignatureBlock(ctx, 1200, adminName, adminName ? adminTitle : 'Prayer Dome Academy', adminSigImg, 'AUTHORISED ADMINISTRATOR');

    // The medal sits in its own lower-left field, clear of both signature
    // blocks and the reference strip.
    seal(ctx, 165, 930, 0.72);

    ctx.save();
    ctx.fillStyle = 'rgba(29, 42, 107, .055)';
    ctx.fillRect(430, 1036, 740, 30);
    ctx.strokeStyle = GOLD; ctx.lineWidth = 1.5;
    ctx.strokeRect(430, 1036, 740, 30);
    ctx.fillStyle = NAVY;
    ctx.font = "700 18px " + SERIF;
    ctx.textAlign = 'center';
    var refText = 'CERTIFICATE REFERENCE  ·  ' + certId;
    if (ctx.measureText(refText).width > 690) {
      refText = 'CERT. REF.  ·  ' + certId;
    }
    var refSize = 18;
    while (refSize > 10 && ctx.measureText(refText).width > 690) {
      refSize -= 1;
      ctx.font = "700 " + refSize + "px " + SERIF;
    }
    ctx.fillText(refText, W / 2, 1057);
    ctx.restore();
  }

  function slug(v) {
    return String(v || 'certificate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'certificate';
  }

  function saveBlob(blob, filename) {
    if (!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 400);
  }

  function dataUrlBlob(canvas) {
    try {
      var dataUrl = canvas.toDataURL('image/png');
      var bin = atob(dataUrl.split(',')[1]);
      var buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new Blob([buf], { type: 'image/png' });
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ PDF
     A certificate is an official document, so the primary download is a PDF.
     Writing the five objects below ourselves keeps the page dependency-free
     and makes the download work on slow mobile connections and offline. */
  function jpegBytes(canvas) {
    var dataUrl;
    try { dataUrl = canvas.toDataURL('image/jpeg', 0.94); }
    catch (e) { return null; }
    if (!dataUrl || dataUrl.indexOf('data:image/jpeg') !== 0) return null;
    var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    try {
      var bin = atob(base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch (e) { return null; }
  }

  function asciiLength(str) {
    // Every PDF syntax byte we emit is ASCII; JPEG payload is counted in bytes.
    return str.length;
  }

  function buildPdf(canvas, jpeg) {
    var w = canvas.width || W;
    var h = canvas.height || H;
    // A4 landscape in PDF points (72 per inch), the standard paper every
    // printer understands. The canvas is the same aspect ratio (1.414).
    var pageW = 842;
    var pageH = 595;
    var content = 'q\n' + pageW + ' 0 0 ' + pageH + ' 0 0 cm\n/Im0 Do\nQ\n';
    var objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n',
      '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream'
    ];

    var chunks = [];
    var total = 0;
    function push(part) {
      if (typeof part === 'string') {
        chunks.push(part);
        total += asciiLength(part);
      } else {
        chunks.push(part);
        total += part.length;
      }
    }

    push('%PDF-1.4\n%PrayerDome\n');
    var offsets = [0];
    for (var i = 0; i < objects.length; i++) {
      offsets.push(total);
      push((i + 1) + ' 0 obj\n' + objects[i]);
      if (i === 3) {
        push(jpeg);
        push('\nendstream\nendobj\n');
      } else {
        push('\nendobj\n');
      }
    }
    var xref = total;
    var xrefText = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (var j = 1; j <= objects.length; j++) {
      xrefText += ('0000000000' + offsets[j]).slice(-10) + ' 00000 n \n';
    }
    push(xrefText);
    push('trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  }

  function pdfBlob(canvas) {
    var jpeg = jpegBytes(canvas);
    if (!jpeg) return null;
    return buildPdf(canvas, jpeg);
  }

  function toBlobP(canvas) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(blob) {
        if (settled) return;
        settled = true;
        resolve(blob || dataUrlBlob(canvas));
      }
      if (canvas.toBlob) {
        try {
          canvas.toBlob(done, 'image/png');
          // Some Android WebViews expose toBlob but never invoke its callback.
          // Fall back to toDataURL so the button always finishes.
          setTimeout(function () { done(null); }, 2500);
          return;
        } catch (e) { /* use the synchronous fallback below */ }
      }
      done(null);
    });
  }

  function render(opts) {
    opts = opts || {};
    var founderWork = loadFounderSignatureData().then(function (meta) {
      return Promise.all([
        loadFounderSignatureImage(meta),
        loadAdministratorSignatureImage(meta)
      ]).then(function (images) {
        return { meta: meta, img: images[0], adminImg: images[1] };
      });
    });
    return Promise.all([loadLogo(), founderWork]).then(function (res) {
      var logo = res[0];
      var founder = res[1] || {};
      // Render at 2.2× (3520 × 2488) so the A4 PDF lands at about 300 dpi. The
      // drawing coordinates stay in the 1600 × 1131 design space.
      var SCALE = 2.2;
      var canvas = document.createElement('canvas');
      canvas.width = W * SCALE;
      canvas.height = H * SCALE;
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is not supported in this browser.');
      if (typeof ctx.scale === 'function') ctx.scale(SCALE, SCALE);
      draw(ctx, opts, logo, founder.meta, founder.img, founder.adminImg);
      return canvas;
    });
  }

  function fileStem(opts) {
    return 'prayer-dome-certificate-' + slug(opts.id || opts.name || 'member');
  }

  function download(opts) {
    opts = opts || {};
    return render(opts).then(function (canvas) {
      var blob = pdfBlob(canvas);
      if (!blob) throw new Error('Could not generate the certificate PDF.');
      saveBlob(blob, fileStem(opts) + '.pdf');
      return true;
    });
  }

  function downloadPng(opts) {
    opts = opts || {};
    return render(opts).then(function (canvas) {
      return toBlobP(canvas);
    }).then(function (blob) {
      if (!blob) throw new Error('Could not generate the certificate image.');
      saveBlob(blob, fileStem(opts) + '.png');
      return true;
    });
  }

  function bindButton(btn, opts) {
    if (!btn) return;
    var original = btn.innerHTML;
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.innerHTML = '<i class="pd-i pd-i-loader-circle pd-i-spin"></i> Preparing…';
      return download(opts).then(function () {
        btn.innerHTML = '<i class="pd-i pd-i-check"></i> Downloaded';
        setTimeout(function () { btn.innerHTML = original; btn.disabled = false; }, 2200);
        // Optional tracking hook (e.g. bump the download counter in Firestore)
        if (typeof opts.onDownload === 'function') {
          try { opts.onDownload(opts); }
          catch (e) { if (window.console) console.error('Certificate tracking hook failed', e); }
        }
      }).catch(function (err) {
        btn.innerHTML = original;
        btn.disabled = false;
        if (window.console) console.error('Certificate download failed', err);
        alert('Sorry, the certificate could not be downloaded in this browser. You can still use Print / Save.');
      });
    });
  }

  // Start loading the official mark before a member presses Download.
  loadLogo();

  window.PDCertificate = {
    download: download,
    downloadPdf: download,
    downloadPng: downloadPng,
    bindButton: bindButton,
    render: render,
    preview: function (opts) {
      return render(opts).then(function (canvas) {
        return canvas.toDataURL('image/png');
      });
    },
    _draw: draw // exposed for tests
  };
})();
