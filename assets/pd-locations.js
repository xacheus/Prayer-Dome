/*!
 * Prayer Dome — "Find a Prayer Dome Near You"
 * ===========================================================================
 * The page shows the three official branches and asks the device for its real
 * GPS position. Distances are computed from those two sets of coordinates with
 * the Haversine formula and displayed in metres or kilometres. Nothing here
 * guesses: if permission is refused, the branches are still shown, but the
 * distance line says so and a retry button is offered.
 *
 * Extra branches added by an administrator live in Firestore
 * (`churchLocations`, active rows only) and are merged into the same list, so
 * opening a new congregation never needs a source-code change.
 */
(function (global) {
  'use strict';

  var data = global.PDLocationsData;
  if (!data) return;

  var state = {
    branches: data.clone(data.OFFICIAL),
    position: null,
    nearestId: null,
    distances: {},
    status: 'idle',
    map: null,
    markers: {}
  };

  var el = {};

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function locationLine(branch) {
    var town = branch.town || branch.district || '';
    return [town, branch.country].filter(Boolean).join(', ');
  }

  function branchCard(branch) {
    var isNearest = state.nearestId === branch.id;
    var metres = state.distances[branch.id];
    var distanceText;
    if (Number.isFinite(metres)) {
      distanceText = '<i class="pd-i pd-i-route" aria-hidden="true"></i> ' +
        escapeHtml(data.formatDistanceAway(metres)) +
        ' <span class="loc-distance-kind">straight line</span>';
    } else if (state.status === 'denied') {
      distanceText = '<i class="pd-i pd-i-map-pin-off" aria-hidden="true"></i> Distance needs location permission';
    } else if (state.status === 'locating') {
      distanceText = '<i class="pd-i pd-i-loader-circle pd-i-spin" aria-hidden="true"></i> Finding your distance…';
    } else {
      distanceText = '<i class="pd-i pd-i-map-pin" aria-hidden="true"></i> Distance unavailable';
    }

    return '' +
      '<article class="loc-card' + (isNearest ? ' is-nearest' : '') + '" data-branch-id="' + escapeHtml(branch.id) + '">' +
        (isNearest ? '<span class="loc-nearest"><i class="pd-i pd-i-locate-fixed" aria-hidden="true"></i> Nearest to you</span>' : '') +
        '<div class="loc-card-head">' +
          '<div class="loc-icon"><i class="pd-i pd-i-church" aria-hidden="true"></i></div>' +
          '<div class="loc-title-wrap">' +
            '<h3 class="loc-name">' + escapeHtml(branch.name) + '</h3>' +
            '<p class="loc-place">' + escapeHtml(locationLine(branch)) + '</p>' +
          '</div>' +
          '<span class="loc-country">' + escapeHtml(branch.country) + '</span>' +
        '</div>' +
        '<p class="loc-distance" data-distance>' + distanceText + '</p>' +
        '<dl class="loc-facts">' +
          (branch.plusCode ? '<div><dt>Plus code</dt><dd>' + escapeHtml(branch.plusCode) + '</dd></div>' : '') +
          (branch.phone ? '<div><dt>Phone</dt><dd><a href="tel:' + escapeHtml(branch.phone.replace(/\s+/g, '')) + '">' + escapeHtml(branch.phone) + '</a></dd></div>' : '') +
          (branch.province ? '<div><dt>Region</dt><dd>' + escapeHtml(branch.province) + '</dd></div>' : '') +
        '</dl>' +
        '<div class="loc-actions">' +
          '<a class="loc-btn loc-btn-primary" href="' + escapeHtml(branch.mapUrl) + '" target="_blank" rel="noopener">' +
            '<i class="pd-i pd-i-map-pinned" aria-hidden="true"></i> View on Map</a>' +
          '<a class="loc-btn" href="' + escapeHtml(data.directionsUrl(branch)) + '" target="_blank" rel="noopener">' +
            '<i class="pd-i pd-i-navigation" aria-hidden="true"></i> Get Directions</a>' +
          '<button class="loc-btn loc-btn-quiet" type="button" data-map-branch="' + escapeHtml(branch.id) + '">' +
            '<i class="pd-i pd-i-layers" aria-hidden="true"></i> Show on map</button>' +
        '</div>' +
      '</article>';
  }

  function render() {
    if (!el.grid) return;
    el.grid.innerHTML = state.branches.map(branchCard).join('');
    el.grid.querySelectorAll('[data-map-branch]').forEach(function (button) {
      button.addEventListener('click', function () {
        selectBranch(button.getAttribute('data-map-branch'), true);
      });
    });
    if (el.count) {
      el.count.textContent = String(state.branches.length);
    }
    if (el.select) {
      el.select.innerHTML = state.branches.map(function (branch) {
        return '<option value="' + escapeHtml(branch.id) + '">' +
          escapeHtml(branch.name) + ' — ' + escapeHtml(locationLine(branch)) + '</option>';
      }).join('');
      if (state.branches[0]) el.select.value = state.branches[0].id;
    }
    updateMapMarkers();
  }

  function setStatus(kind, message) {
    state.status = kind;
    if (!el.status) return;
    el.status.className = 'loc-status loc-status-' + kind;
    el.status.innerHTML = message;
  }

  function refreshDistances() {
    if (!state.position) return;
    state.distances = {};
    state.nearestId = null;
    var best = null;
    state.branches.forEach(function (branch) {
      if (branch.lat == null || branch.lng == null) return;
      var metres = data.haversineMetres(state.position.lat, state.position.lng, branch.lat, branch.lng);
      if (!Number.isFinite(metres)) return;
      state.distances[branch.id] = metres;
      if (!best || metres < best.metres) best = { id: branch.id, metres: metres };
    });
    state.nearestId = best ? best.id : null;
    render();
    if (best) {
      var branch = state.branches.filter(function (b) { return b.id === best.id; })[0];
      setStatus('ready',
        '<i class="pd-i pd-i-circle-check" aria-hidden="true"></i> Your location was detected. ' +
        'The nearest congregation is <strong>' + escapeHtml(branch ? branch.name : '') + '</strong>, ' +
        '<strong>' + escapeHtml(data.formatDistanceAway(best.metres)) + '</strong> in a straight line. ' +
        '<span class="loc-status-note">Road distance is longer — use Get Directions for the driving route.</span>');
    }
  }

  function requestLocation() {
    if (!global.navigator || !navigator.geolocation) {
      setStatus('unsupported',
        '<i class="pd-i pd-i-info" aria-hidden="true"></i> This browser cannot read a device location. ' +
        'The branches below are still accurate — open one in Google Maps for directions.');
      render();
      return;
    }
    setStatus('locating',
      '<i class="pd-i pd-i-loader-circle pd-i-spin" aria-hidden="true"></i> Requesting your device location… ' +
      '<span class="loc-status-note">Your position is used only in this browser to calculate distances.</span>');
    render();
    navigator.geolocation.getCurrentPosition(function (position) {
      state.position = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      };
      refreshDistances();
    }, function (error) {
      var denied = error && (error.code === 1 || error.code === error.PERMISSION_DENIED);
      state.position = null;
      state.distances = {};
      state.nearestId = null;
      setStatus(denied ? 'denied' : 'error',
        '<i class="pd-i pd-i-map-pin-off" aria-hidden="true"></i> ' +
        (denied
          ? 'Location permission was refused, so no distances are shown. '
          : 'Your location could not be read, so no distances are shown. ') +
        'You can still view every branch and open directions.' +
        ' <button type="button" class="loc-retry" id="pdLocRetryInline">Try again</button>');
      render();
      bindRetry();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    bindRetry();
  }

  function bindRetry() {
    [document.getElementById('pdLocRetry'), document.getElementById('pdLocRetryInline')].forEach(function (button) {
      if (!button) return;
      button.addEventListener('click', function (event) {
        event.preventDefault();
        requestLocation();
      });
    });
  }

  /* ------------------------------------------------------------------ map */
  function buildLeafletMap() {
    if (!global.L || !el.mapCanvas) return false;
    try {
      var map = global.L.map(el.mapCanvas, {
        scrollWheelZoom: false,
        attributionControl: true
      }).setView([data.OFFICIAL[0].lat, data.OFFICIAL[0].lng], 5);
      global.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
      state.map = map;
      state.branches.forEach(function (branch) {
        if (branch.lat == null || branch.lng == null) return;
        var marker = global.L.marker([branch.lat, branch.lng], {
          title: branch.name,
          alt: branch.name,
          riseOnHover: true
        }).addTo(map);
        marker.bindPopup(
          '<strong class="loc-popup-name">' + escapeHtml(branch.name) + '</strong><br>' +
          '<span>' + escapeHtml(locationLine(branch)) + '</span><br>' +
          '<span data-popup-distance="' + escapeHtml(branch.id) + '"></span><br>' +
          '<a href="' + escapeHtml(branch.mapUrl) + '" target="_blank" rel="noopener">View on Google Maps</a>'
        );
        state.markers[branch.id] = marker;
      });
      fitMap();
      return true;
    } catch (error) {
      state.map = null;
      return false;
    }
  }

  function fitMap() {
    if (!state.map || !global.L) return;
    var points = state.branches
      .filter(function (branch) { return branch.lat != null && branch.lng != null; })
      .map(function (branch) { return [branch.lat, branch.lng]; });
    if (!points.length) return;
    if (points.length === 1) {
      state.map.setView(points[0], 13);
      return;
    }
    try { state.map.fitBounds(points, { padding: [30, 30] }); } catch (error) { /* keep default view */ }
  }

  function fallbackMap(branch) {
    if (!el.mapFrame) return;
    var frame = el.mapFrame;
    frame.src = data.embedUrl(branch, 13);
    frame.hidden = false;
    if (el.mapCanvas) el.mapCanvas.hidden = true;
  }

  function updateMapMarkers() {
    if (!state.map) {
      if (el.select && el.mapFrame) {
        var chosen = state.branches.filter(function (b) { return b.id === el.select.value; })[0] ||
          state.branches[0];
        if (chosen) fallbackMap(chosen);
      }
      return;
    }
    state.branches.forEach(function (branch) {
      var marker = state.markers[branch.id];
      if (!marker) return;
      var metres = state.distances[branch.id];
      var popup = marker.getPopup();
      if (popup && popup.getElement()) {
        var line = popup.getElement().querySelector('[data-popup-distance="' + branch.id + '"]');
        if (line) line.textContent = Number.isFinite(metres) ? data.formatDistanceAway(metres) : '';
      }
    });
  }

  function selectBranch(id, scroll) {
    var branch = state.branches.filter(function (b) { return b.id === id; })[0];
    if (!branch) return;
    if (el.select) el.select.value = branch.id;
    if (state.map && state.markers[branch.id]) {
      state.map.setView([branch.lat, branch.lng], 14);
      state.markers[branch.id].openPopup();
    } else {
      fallbackMap(branch);
    }
    if (scroll && el.mapSection) {
      el.mapSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function addBranches(extra) {
    if (!Array.isArray(extra) || !extra.length) return;
    var known = {};
    state.branches.forEach(function (branch) { known[branch.id] = true; });
    var added = 0;
    extra.forEach(function (raw) {
      if (!raw || known[raw.id]) return;
      if (raw.status && raw.status !== 'active') return;
      if (raw.lat == null || raw.lng == null) return;
      var branch = {
        id: raw.id,
        name: raw.name || 'Prayer Dome',
        country: raw.country || '',
        province: raw.province || '',
        district: raw.district || '',
        town: raw.town || raw.district || '',
        address: raw.address || '',
        plusCode: raw.plusCode || '',
        lat: Number(raw.lat),
        lng: Number(raw.lng),
        mapUrl: raw.mapUrl || '',
        directionsQuery: raw.directionsQuery || [raw.name, raw.town, raw.country].filter(Boolean).join(', '),
        phone: raw.phone || '',
        email: raw.email || '',
        leader: raw.leader || '',
        image: raw.image || '',
        status: 'active',
        priority: raw.priority != null ? Number(raw.priority) : 100,
        official: false
      };
      if (!Number.isFinite(branch.lat) || !Number.isFinite(branch.lng)) return;
      state.branches.push(branch);
      known[branch.id] = true;
      added += 1;
    });
    if (!added) return;
    state.branches.sort(data.byPriority);
    if (state.position) {
      refreshDistances();
    } else {
      render();
      fitMap();
    }
  }

  function init(options) {
    el.grid = document.getElementById('pdLocationGrid');
    el.status = document.getElementById('pdLocStatus');
    el.count = document.getElementById('pdLocationCount');
    el.select = document.getElementById('pdMapBranchSelect');
    el.mapCanvas = document.getElementById('pdMapCanvas');
    el.mapFrame = document.getElementById('pdMapFrame');
    el.mapSection = document.getElementById('pdMapSection');
    if (!el.grid) return;

    render();
    bindRetry();
    if (el.select) {
      el.select.addEventListener('change', function () { selectBranch(el.select.value, false); });
    }

    var usingLeaflet = buildLeafletMap();
    if (!usingLeaflet && el.mapFrame) {
      el.mapFrame.hidden = false;
      fallbackMap(state.branches[0]);
    }

    // Ask the browser for real GPS on arrival. The prompt is the browser's
    // own; the visitor can refuse and still use every branch card.
    var auto = !options || options.autoLocate !== false;
    if (auto) {
      var start = function () { requestLocation(); };
      if (document.readyState === 'complete') global.setTimeout(start, 500);
      else global.addEventListener('load', function () { global.setTimeout(start, 500); }, { once: true });
    } else {
      setStatus('idle',
        '<i class="pd-i pd-i-locate-fixed" aria-hidden="true"></i> Tap <strong>Find my nearest branch</strong> ' +
        'to calculate real distances from this device.');
    }
  }

  var api = {
    init: init,
    addBranches: addBranches,
    requestLocation: requestLocation,
    selectBranch: selectBranch,
    state: state
  };

  global.PDLocations = api;
})(typeof window !== 'undefined' ? window : globalThis);
