/*!
 * Prayer Dome Radio — daily programme scripts
 * ---------------------------------------------------------------------------
 * These are AI-assisted drafts for the nine daily programmes. They are NOT
 * published on their own. `radio.html` only reads a script after an
 * administrator has approved that programme/day in the Radio Programming
 * console, which writes `radioScripts/{programmeId}-{weekday}`:
 *
 *   { programmeId, weekday, script, status: 'approved', reviewedBy, reviewedAt }
 *
 * Until then the page says the briefing is awaiting review. No script claims a
 * live studio or a live presenter; the schedule is scheduled content.
 */
(function (global) {
  'use strict';

  var WEEKDAY_OPENERS = [
    'Welcome to a Sunday edition of Prayer Dome Radio. However this week has looked, you are welcome here.',
    'Welcome to a Monday edition of Prayer Dome Radio. Begin the week with your heart open to God.',
    'Welcome to a Tuesday edition of Prayer Dome Radio. There is room here to pause and be strengthened.',
    'Welcome to a Wednesday edition of Prayer Dome Radio. Take a breath; grace meets you in the middle of the week.',
    'Welcome to a Thursday edition of Prayer Dome Radio. Let the Word of God settle the noise of the day.',
    'Welcome to a Friday edition of Prayer Dome Radio. Bring the week before God and leave nothing unsaid.',
    'Welcome to a Saturday edition of Prayer Dome Radio. Rest is not an afterthought; it is part of following God.'
  ];

  var PROGRAMMES = {
    'morning-prayer': {
      title: 'Morning Prayer',
      body: 'This is Morning Prayer. We turn to the Lord before the plans of the day take hold. Pray with us for families waking up, for children going to school, for workers travelling, and for every household carrying a quiet burden. Lord, let Your mercy be new this morning. Give us listening hearts and willing hands. Keep our words gentle and our steps honest. We ask for Your peace over Zambia, Eswatini, South Africa, Malawi and Ireland, and over every place where someone is praying with us.'
    },
    'bible-teaching': {
      title: 'Bible Teaching',
      body: 'This is Bible Teaching. We open the Scriptures without adding to them and without taking away from them. Today, ask the Holy Spirit to make one verse plain enough to obey, not merely interesting enough to discuss. Take your time. A single truth lived out is worth more than many ideas left untouched. If you can, read the passage in your own Bible alongside this programme and write down one thing you will do because of it.'
    },
    'gospel-worship': {
      title: 'Gospel Worship',
      body: 'This is Gospel Worship, a programme of music from the Prayer Dome worship library. Every track is published with its title, artist, duration and rights information, and only licensed, public-domain or original recordings are played here. Let the words direct your attention to Christ. You do not need to perform anything for God; simply receive His presence and sing along where you can.'
    },
    'encouragement': {
      title: 'Encouragement',
      body: 'This is Encouragement. If today has left you tired, you are not outside the reach of God. The Bible does not promise a life without pressure; it promises a Shepherd who stays near. You do not have to solve everything before you pray. Bring the honest sentence: “Lord, I need help.” Then take one small, faithful step — make the call, open the Word, ask for prayer, or rest. You are not forgotten.'
    },
    'scripture-reflection': {
      title: 'Scripture Reflection',
      body: 'This is Scripture Reflection. We slow down with one passage and listen for the character of God in it. Notice what the text says about God before you ask what it says about you. Let one phrase stay with you through the afternoon. Write it on paper if you can, and return to it when the day gets loud. The goal is not to master the verse, but to let the verse steady you.'
    },
    'afternoon-worship': {
      title: 'Afternoon Worship',
      body: 'This is Afternoon Worship, a programme of music from the Prayer Dome worship library. Every track is published with its title, artist, duration and rights information; only licensed, public-domain or original recordings are played. If the afternoon has been heavy, let these songs carry you back to the presence of God. Listen more than you speak. Let one line of truth become your prayer.'
    },
    'evening-prayer': {
      title: 'Evening Prayer',
      body: 'This is Evening Prayer. As the day closes, bring what was good and what was hard. Thank God for the kindness you received and the strength you were given. Name the places where you fell short, receive His forgiveness, and forgive where you have been wounded. Pray for those who will sleep in difficult circumstances tonight. Ask the Lord to guard your home and give you rest.'
    },
    'announcements': {
      title: 'Announcements',
      body: 'This is the Announcements programme. Here we read the approved notices of Prayer Dome Ministries: service times, prayer meetings, practical arrangements and invitations to gather. Announcements are reviewed by the church office before they are published, and any live service is announced only when the church has actually scheduled one. Please use the contact details on the website if you need clarification.'
    },
    'night-watch': {
      title: 'Night Watch & Worship',
      body: 'This is Night Watch, a quiet space of worship and prayer through the night. Keep the volume low and let the music hold the room. You do not need a long speech; a short prayer is enough. Pray for peace in homes, protection for travellers, comfort for the grieving and rest for the anxious. The Lord neither slumbers nor sleeps, and He is present in the silent hours.'
    }
  };

  function cleanDay(value) {
    var day = Number(value);
    return day >= 0 && day <= 6 ? day : 0;
  }

  function defaultScript(programmeId, weekday) {
    var programme = PROGRAMMES[String(programmeId || '').toLowerCase()];
    if (!programme) return '';
    return WEEKDAY_OPENERS[cleanDay(weekday)] + '\n\n' + programme.body + '\n\n' +
      'This has been ' + programme.title + ' on Prayer Dome Radio. Thank you for listening.';
  }

  global.PD_RADIO_SCRIPTS = {
    aiAssisted: true,
    weekdayOpeners: WEEKDAY_OPENERS,
    programmes: PROGRAMMES,
    welcome: 'Welcome to Prayer Dome Radio. Before the music begins, receive this simple greeting: you are welcome, you are among family, and you are prayed for. Let the Word of God and worship set the tone for this time.',
    closing: 'You have been listening to Prayer Dome Radio. Go in peace, carry the Word with you, and remember that Prayer Dome Ministries prays for you. A house of prayer for all nations.',
    scriptFor: defaultScript,
    ids: function () { return Object.keys(PROGRAMMES); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
