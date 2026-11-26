/*! GENERATED COPY — do not edit here.
 * Source of truth: assets/pd-radio-discovery.js (shared with the browser).
 * Firebase deploys only the functions/ directory, so the module is mirrored.
 * Refresh with: npm run sync:radio (scripts/sync-radio-modules.mjs). */
/*!
 * Prayer Dome Radio — automatic gospel music discovery
 * ---------------------------------------------------------------------------
 * Searches free, legally-clear catalogues and normalises the results into
 * the same track shape the AutoDJ already plays (worshipSongs fields).
 *
 * Sources (all free, no paid API, no scraping of commercial platforms):
 *
 *   1. Internet Archive (archive.org) — advancedsearch API, no key needed.
 *      Only items whose licence field is public-domain / CC0 / CC-BY /
 *      CC-BY-SA are auto-approved. Everything else is returned as
 *      "review required" and is never auto-broadcast.
 *   2. Wikimedia Commons — public-domain hymns and gospel recordings.
 *      Commons files are PD or CC; the licence string is kept on the track.
 *   3. Jamendo — Creative Commons catalogue. Jamendo's default licence is
 *      CC BY-NC-ND (non-commercial, no derivatives), so Jamendo results are
 *      ALWAYS "review required": an administrator must confirm the use is
 *      permitted before approval. A free Jamendo client_id is required;
 *      without one the source is skipped, never faked.
 *
 * Nothing here downloads from YouTube, Spotify, SoundCloud or any other
 * commercial platform, and nothing is labelled "free" unless the source
 * licence says so. Broken audio is detected by the listener engine, which
 * skips a track that fails to play and records the failure.
 *
 * Shared between browser, Vercel (api/radio.js) and scripts — no deps.
 */
(function (global) {
  'use strict';

  var CATEGORIES = {
    'african-gospel': { label: 'African gospel', query: 'african gospel hymn' },
    'zambian-gospel': { label: 'Zambian gospel', query: 'zambia gospel hymn choir' },
    'south-african-gospel': { label: 'South African gospel', query: 'south africa gospel choir hymn' },
    'nigerian-gospel': { label: 'Nigerian gospel', query: 'nigeria gospel hymn' },
    'international-gospel': { label: 'International gospel', query: 'gospel hymn choir' },
    'contemporary': { label: 'Contemporary Christian music', query: 'contemporary christian worship hymn' },
    'traditional': { label: 'Traditional gospel', query: 'traditional hymn gospel' },
    'praise': { label: 'Gospel praise', query: 'praise hymn gospel' },
    'gospel-worship': { label: 'Gospel worship', query: 'worship hymn gospel' },
    'instrumental-worship': { label: 'Instrumental worship', query: 'instrumental worship hymn piano' },
    'inspirational': { label: 'Christian inspirational music', query: 'christian inspirational hymn' }
  };

  var AUTO_APPROVE_LICENCES = [
    'public domain', 'public-domain', 'cc0', 'cc-by', 'cc-by-sa',
    'creative commons attribution', 'pd-', 'publicdomain'
  ];

  function licenceText(row) {
    if (typeof row === 'string') return row.toLowerCase();
    return String((row && (row.license || row.licence || row.rights || row.licenseStatus)) || '').toLowerCase();
  }

  function isAutoApprovable(row) {
    var text = licenceText(row);
    if (!text) return false;
    if (text.indexOf('noncommercial') !== -1 || text.indexOf('non-commercial') !== -1 ||
        text.indexOf('-nc') !== -1 || text.indexOf('nc-') !== -1 ||
        text.indexOf('no-deriv') !== -1 || text.indexOf('noderiv') !== -1 ||
        /(^|[^a-z])nd([^a-z]|$)|-nd\b/.test(text)) return false;
    for (var i = 0; i < AUTO_APPROVE_LICENCES.length; i++) {
      if (text.indexOf(AUTO_APPROVE_LICENCES[i]) !== -1) return true;
    }
    return false;
  }

  function cleanText(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 300);
  }

  function toTrack(row) {
    var r = row || {};
    var title = cleanText(r.title || r.name || 'Untitled gospel recording', 160);
    var artist = cleanText(r.artist || r.creator || r.uploader || 'Unknown artist', 160);
    var audioUrl = String(r.audioUrl || r.url || r.downloadUrl || '').trim();
    var licence = cleanText(r.license || r.licence || r.rights || r.licenseStatus || '', 120);
    var auto = isAutoApprovable(r);
    var category = CATEGORIES[r.category] ? r.category : 'gospel-worship';
    return {
      title: title,
      artist: artist,
      album: cleanText(r.album || '', 160),
      genre: category,
      category: category,
      audioUrl: audioUrl,
      source: cleanText(r.source || 'Free catalogue', 160),
      sourceUrl: cleanText(r.sourceUrl || r.pageUrl || '', 400),
      licenseStatus: auto ? 'public-domain' : 'licensed',
      license: licence,
      permissionConfirmed: auto,
      approved: auto,
      reviewRequired: !auto,
      durationSeconds: Number(r.durationSeconds || r.duration || 0) || 0,
      discoveredBy: cleanText(r.source || '', 80),
      discoveredAt: new Date().toISOString(),
      notes: 'Discovered automatically from ' + cleanText(r.source || 'a free catalogue', 80) +
        (licence ? '. Licence recorded: ' + licence + '.' : '. Licence must be confirmed before broadcast.')
    };
  }

  function isPlayableTrack(row) {
    return !!(row && row.audioUrl && /^https:\/\//i.test(row.audioUrl) &&
      /\.(mp3|ogg|oga|wav|m4a|opus|flac)(\?|$)/i.test(row.audioUrl));
  }

  /* --- Internet Archive -------------------------------------------------- */
  function archiveSearchUrl(query, rows) {
    var q = 'mediatype:audio AND (' + query + ') AND (licenseurl:*publicdomain* OR licenseurl:*creativecommons* OR rights:*public domain*)';
    var params = new URLSearchParams({
      q: q,
      fl: 'identifier,title,creator,description,licenseurl,rights,mediatype',
      rows: String(rows || 20),
      page: '1',
      output: 'json'
    });
    return 'https://archive.org/advancedsearch.php?' + params.toString();
  }

  function parseArchive(json, category) {
    var docs = (json && json.response && json.response.docs) || [];
    return docs.map(function (doc) {
      var id = cleanText(doc.identifier, 120);
      if (!id) return null;
      var licence = cleanText(doc.licenseurl || doc.rights || '', 120);
      return toTrack({
        title: doc.title,
        artist: Array.isArray(doc.creator) ? doc.creator.join(', ') : doc.creator,
        audioUrl: 'https://archive.org/download/' + encodeURIComponent(id) + '/' + encodeURIComponent(id) + '.mp3',
        source: 'Internet Archive',
        sourceUrl: 'https://archive.org/details/' + encodeURIComponent(id),
        license: licence || 'public domain',
        category: category
      });
    }).filter(Boolean);
  }

  /* --- Wikimedia Commons ------------------------------------------------- */
  function commonsSearchUrl(query, rows) {
    var params = new URLSearchParams({
      action: 'query', format: 'json', generator: 'search',
      gsrsearch: query + ' filetype:audio', gsrnamespace: '6', gsrlimit: String(rows || 20),
      prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: '0'
    });
    return 'https://commons.wikimedia.org/w/api.php?' + params.toString();
  }

  function parseCommons(json, category) {
    var pages = (json && json.query && json.query.pages) || {};
    return Object.keys(pages).map(function (key) {
      var page = pages[key] || {};
      var info = (page.imageinfo || [])[0] || {};
      var meta = info.extmetadata || {};
      var licence = cleanText((meta.LicenseShortName && meta.LicenseShortName.value) || '', 120);
      var artist = cleanText((meta.Artist && meta.Artist.value || '').replace(/<[^>]+>/g, ''), 160);
      var url = String(info.url || '');
      if (!url || !/\.(mp3|ogg|oga|wav|opus)$/i.test(url)) return null;
      return toTrack({
        title: page.title || 'Commons gospel recording',
        artist: artist || 'Wikimedia Commons contributor',
        audioUrl: url,
        source: 'Wikimedia Commons',
        sourceUrl: info.descriptionurl || '',
        license: licence || 'public domain',
        category: category
      });
    }).filter(Boolean);
  }

  /* --- Jamendo (review-required only) ------------------------------------ */
  function jamendoSearchUrl(query, rows, clientId) {
    var params = new URLSearchParams({
      client_id: clientId || '', search: query, format: 'json',
      limit: String(rows || 20), audioformat: 'mp3', order: 'popularity_total'
    });
    return 'https://api.jamendo.com/v3.0/tracks/?' + params.toString();
  }

  function parseJamendo(json, category) {
    var results = (json && json.results) || [];
    return results.map(function (row) {
      return toTrack({
        title: row.name,
        artist: row.artist_name,
        album: row.album_name,
        audioUrl: row.audio,
        source: 'Jamendo',
        sourceUrl: row.shareurl || '',
        license: row.license || 'CC BY-NC-ND (review required)',
        category: category
      });
    }).filter(function (row) { return row.audioUrl; });
  }

  function dedupe(tracks) {
    var seen = {};
    return (tracks || []).filter(function (row) {
      var key = (row.audioUrl || '').toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  var api = {
    CATEGORIES: CATEGORIES,
    AUTO_APPROVE_LICENCES: AUTO_APPROVE_LICENCES,
    isAutoApprovable: isAutoApprovable,
    isPlayableTrack: isPlayableTrack,
    toTrack: toTrack,
    archiveSearchUrl: archiveSearchUrl,
    parseArchive: parseArchive,
    commonsSearchUrl: commonsSearchUrl,
    parseCommons: parseCommons,
    jamendoSearchUrl: jamendoSearchUrl,
    parseJamendo: parseJamendo,
    dedupe: dedupe
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PD_RADIO_DISCOVERY = api;
})(typeof window !== 'undefined' ? window : globalThis);
