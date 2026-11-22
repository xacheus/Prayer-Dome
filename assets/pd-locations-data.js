/*!
 * Prayer Dome — official church locations and real distance maths
 * ===========================================================================
 * Coordinates are NOT invented. Each one was resolved from the official
 * Google Maps place link supplied by the ministry and matched against the
 * place name Google returns for that link:
 *
 *   Freedom Zambia          maps.app.goo.gl/rZXU1owB82cCMi166
 *     Google place: "Prayer Dome Zambia" — Chama 54049, Zambia
 *     3d -11.193343   4d 33.1525404   plus code R543+M2
 *
 *   Prayer Dome Mahlabane   maps.app.goo.gl/5E8iQHP6hqJT4JCY7
 *     Google place: "Prayer Dome Mahlabane Eswatini" — GG67+C6, Mahlabane
 *     3d -26.4889087  4d 31.5130595   plus code GG67+C6
 *
 *   Prayer Dome Hluthi      maps.app.goo.gl/Q2ZxSgGysAuRVmKq5
 *     Google place: "Prayer Dome Hluthi Eswatini" — QJJ7+8WC, Hluti
 *     3d -27.2191875  4d 31.6147656   plus code QJJ7+8W
 *
 * Mahlabane and Hluthi are different congregations in different parts of
 * Eswatini. Their links and coordinates must never be swapped: Mahlabane is
 * the northern one (near Manzini), Hluthi is the southern one (Shiselweni).
 *
 * The existing "Cork, Ireland" entry is deliberately absent from this file.
 * It is an existing branch record that must stay exactly as it is on the
 * home page and in the admin console; this module neither renames, moves,
 * duplicates nor recomputes it.
 *
 * Distance is straight-line (great-circle) distance, computed with the
 * Haversine formula. It is labelled as such everywhere it is displayed; the
 * road distance is always longer, so every card also offers real directions.
 */
(function (global) {
  'use strict';

  var EARTH_RADIUS_M = 6371008.8; // IUGG mean Earth radius, metres

  var OFFICIAL = [
    {
      id: 'freedom-zambia',
      name: 'Freedom Zambia',
      country: 'Zambia',
      province: 'Muchinga',
      district: 'Chama',
      town: 'Chama',
      address: 'Chama 54049, Zambia',
      plusCode: 'R543+M2',
      lat: -11.193343,
      lng: 33.1525404,
      mapUrl: 'https://maps.app.goo.gl/rZXU1owB82cCMi166',
      directionsQuery: 'Prayer Dome Zambia, Chama, Zambia',
      phone: '+260 97 3028342',
      email: 'info@prayerdome.net',
      leader: '',
      image: '/assets/hero-worship.jpg',
      status: 'active',
      priority: 1,
      official: true,
      note: 'Central hub for Zambia'
    },
    {
      id: 'prayer-dome-mahlabane',
      name: 'Prayer Dome Mahlabane',
      country: 'Eswatini',
      province: 'Manzini',
      district: 'Mahlabane',
      town: 'Mahlabane',
      address: 'Mahlabane, Eswatini',
      plusCode: 'GG67+C6',
      lat: -26.4889087,
      lng: 31.5130595,
      mapUrl: 'https://maps.app.goo.gl/5E8iQHP6hqJT4JCY7',
      directionsQuery: 'Prayer Dome Mahlabane Eswatini, Mahlabane, Eswatini',
      phone: '+268 7813 5065',
      email: 'info@prayerdome.net',
      leader: '',
      image: '/assets/hero-worship.jpg',
      status: 'active',
      priority: 2,
      official: true,
      note: 'Northern Eswatini congregation'
    },
    {
      id: 'prayer-dome-hluthi',
      name: 'Prayer Dome Hluthi',
      country: 'Eswatini',
      province: 'Shiselweni',
      district: 'Hluthi',
      town: 'Hluthi',
      address: 'Hluthi, Eswatini',
      plusCode: 'QJJ7+8W',
      lat: -27.2191875,
      lng: 31.6147656,
      mapUrl: 'https://maps.app.goo.gl/Q2ZxSgGysAuRVmKq5',
      directionsQuery: 'Prayer Dome Hluthi Eswatini, Hluti, Eswatini',
      phone: '+268 7647 6648',
      email: 'info@prayerdome.net',
      leader: '',
      image: '/assets/hero-worship.jpg',
      status: 'active',
      priority: 3,
      official: true,
      note: 'Southern Eswatini congregation'
    }
  ];

  function toRadians(value) {
    return (Number(value) * Math.PI) / 180;
  }

  /** Great-circle distance in metres between two WGS-84 points. */
  function haversineMetres(lat1, lon1, lat2, lon2) {
    var a1 = Number(lat1);
    var o1 = Number(lon1);
    var a2 = Number(lat2);
    var o2 = Number(lon2);
    if (![a1, o1, a2, o2].every(Number.isFinite)) return NaN;
    var dLat = toRadians(a2 - a1);
    var dLon = toRadians(o2 - o1);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(a1)) * Math.cos(toRadians(a2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  /**
   * Human distance. Under one kilometre it is metres (rounded to 10 m);
   * from one kilometre up it is kilometres, one decimal below 100 km and
   * whole kilometres above that. Nothing is ever shown as "0 km" for a
   * place the visitor is standing in — it reads "40 m".
   */
  function formatDistance(metres) {
    var m = Number(metres);
    if (!Number.isFinite(m) || m < 0) return '';
    if (m < 1000) {
      var rounded = Math.round(m / 10) * 10;
      if (rounded < 10) rounded = 10;
      return rounded + ' m';
    }
    var km = m / 1000;
    return (km >= 100 ? km.toFixed(0) : km.toFixed(1)) + ' km';
  }

  /** The full form used in the cards: "2.4 km away". */
  function formatDistanceAway(metres) {
    var text = formatDistance(metres);
    return text ? text + ' away' : '';
  }

  /** Nearest branch to a point, or null when no branch has coordinates. */
  function nearest(lat, lng, branches) {
    var list = branches || OFFICIAL;
    var best = null;
    for (var i = 0; i < list.length; i += 1) {
      var branch = list[i];
      if (!branch || branch.lat == null || branch.lng == null) continue;
      var metres = haversineMetres(lat, lng, branch.lat, branch.lng);
      if (!Number.isFinite(metres)) continue;
      if (!best || metres < best.metres) best = { branch: branch, metres: metres };
    }
    return best;
  }

  /** Deep-ish copy so a caller cannot mutate the canonical list. */
  function clone(list) {
    return (list || OFFICIAL).map(function (branch) {
      return Object.assign({}, branch);
    });
  }

  function byPriority(a, b) {
    var pa = a && a.priority != null ? Number(a.priority) : 999;
    var pb = b && b.priority != null ? Number(b.priority) : 999;
    if (pa !== pb) return pa - pb;
    return String(a && a.name).localeCompare(String(b && b.name));
  }

  /** Directions URL that lets Google resolve the named place. */
  function directionsUrl(branch) {
    if (!branch) return 'https://maps.app.goo.gl/rZXU1owB82cCMi166';
    var target = branch.directionsQuery ||
      [branch.name, branch.town, branch.country].filter(Boolean).join(', ');
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(target);
  }

  /** Embeddable map for one branch, using its real coordinates. */
  function embedUrl(branch, zoom) {
    if (!branch || branch.lat == null || branch.lng == null) return '';
    return 'https://www.google.com/maps?q=' + Number(branch.lat) + ',' + Number(branch.lng) +
      '&z=' + (zoom || 14) + '&output=embed';
  }

  var api = {
    OFFICIAL: OFFICIAL,
    haversineMetres: haversineMetres,
    formatDistance: formatDistance,
    formatDistanceAway: formatDistanceAway,
    nearest: nearest,
    clone: clone,
    byPriority: byPriority,
    directionsUrl: directionsUrl,
    embedUrl: embedUrl
  };

  global.PDLocationsData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
