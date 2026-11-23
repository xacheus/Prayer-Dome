/*!
 * Prayer Dome — the built-in team roster
 * ---------------------------------------------------------------------------
 * The roster the ministry started with. It doubles as the offline fallback on
 * /team and as the seed for a brand-new Firestore `teamMembers` collection, so
 * an administrator's first edit never makes the rest of the team disappear.
 *
 * Loaded before the page scripts on both /team and the admin console.
 */
(function (global) {
  'use strict';
  var TEAM = [
  {
    "name": "Seedwell Khayalethu Masuku",
    "title": "Founder and President",
    "category": "founder",
    "image": "https://i.ibb.co/RTbNh1hB/founder-2.jpg",
    "description": "Visionary leader called to raise prayer warriors across nations. Founder of Prayer Dome Ministry with a heart for intercession and revival.",
    "country": "Eswatini/Zambia",
    "scripture": "Matthew 21:13",
    "role": "",
    "order": 1,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-seedwell-k-masuku"
  },
  {
    "name": "Pastor Philmon Gumbi",
    "title": "Prayer Dome Pastor - Eswatini",
    "category": "eswatini",
    "image": "https://i.ibb.co/6c7wRtJW/philmon.jpg",
    "description": "Committed to leading prayer services and preaching the Word. Passionate about seeing lives transformed through the power of prayer.",
    "country": "Eswatini",
    "role": "Senior Pastor",
    "order": 2,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-philmon-gumbi"
  },
  {
    "name": "Pastor Sabelo Simelane",
    "title": "Prayer Dome Pastor - Eswatini",
    "category": "eswatini",
    "image": "https://i.ibb.co/tp58qGfQ/sabelo-1.jpg",
    "description": "Focuses on intercession, counseling, and encouraging members. Dedicated to spiritual growth and discipleship.",
    "country": "Eswatini",
    "role": "Pastor",
    "order": 3,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-sabelo-simelane"
  },
  {
    "name": "Pastor Dumsani Nxumalo",
    "title": "Prayer Dome Pastor - Eswatini",
    "category": "eswatini",
    "image": "https://i.ibb.co/gFgBhyqG/dumisa.jpg",
    "description": "Leads worship and prayer sessions. Anointed worship leader with a heart for prophetic worship.",
    "country": "Eswatini",
    "role": "Worship Pastor",
    "order": 4,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-dumsani-nxumalo"
  },
  {
    "name": "Pastor Andile Makhanya",
    "title": "Prayer Dome Pastor - Eswatini",
    "category": "eswatini",
    "image": "https://i.ibb.co/xqHjHqr6/ma.jpg",
    "description": "Serves with dedication and spiritual leadership. Committed to teaching and equipping believers.",
    "country": "Eswatini",
    "role": "Teaching Pastor",
    "order": 5,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-andile-makhanya"
  },
  {
    "name": "Pastor Jerome Mkhabela",
    "title": "Prayer Dome Pastor - Eswatini",
    "category": "eswatini",
    "image": "https://i.ibb.co/ksTrfSfp/alan.jpg",
    "description": "Committed to preaching the Word of God. Passionate about evangelism and outreach.",
    "country": "Eswatini",
    "role": "Evangelist",
    "order": 6,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-jerome-mkhabela"
  },
  {
    "name": "Pastor Zacheus Simbaya",
    "title": "Prayer Dome Pastor - Zambia",
    "category": "zambia",
    "image": "https://i.ibb.co/B2r1xPLb/pst.jpg",
    "description": "Devoted to spiritual growth and leadership development. Oversees Prayer Dome Zambia operations.",
    "country": "Zambia",
    "role": "Lead Pastor",
    "order": 7,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-zacheus-simbaya"
  },
  {
    "name": "Pastor Alex Mushawa",
    "title": "Prayer Dome Pastor - Zambia",
    "category": "zambia",
    "image": "https://i.ibb.co/sJMzbpQC/al-1.jpg",
    "description": "Faithfully serves in ministry focusing on teaching. Passionate about youth discipleship.",
    "country": "Zambia",
    "role": "Associate Pastor",
    "order": 8,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-pastor-alex-mushawa"
  },
  {
    "name": "Nomvula Masuku",
    "title": "Praise & Worship Leader",
    "category": "worship",
    "image": "https://i.ibb.co/ksK9tLk1/pnw.jpg",
    "description": "Leads worship and oversees Compassionate Ministry. Anointed singer with a heart for prophetic worship.",
    "country": "Eswatini",
    "role": "Worship Director",
    "order": 9,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-nomvula-masuku"
  },
  {
    "name": "Tengetile Mkhabela",
    "title": "Secretary - Worship Ministry",
    "category": "worship",
    "image": "https://i.ibb.co/21YBRMzK/nom.jpg",
    "description": "Ensures proper communication and organization. Coordinates worship team schedules and events.",
    "country": "Eswatini",
    "role": "Administrator",
    "order": 10,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-tengetile-mkhabela"
  },
  {
    "name": "Nondumiso Simelane",
    "title": "Compassionate Ministry - Eswatini",
    "category": "worship",
    "image": "https://i.ibb.co/qFL3KxMr/tenge.jpg",
    "description": "Leads caring and support initiatives for people. Coordinates outreach and community support programs.",
    "country": "Eswatini",
    "role": "Outreach Coordinator",
    "order": 11,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-nondumiso-simelane"
  },
  {
    "name": "Gabsile Makhanya",
    "title": "Praise & Worship Leader",
    "category": "worship",
    "image": "https://i.ibb.co/27zgJ7fL/cnc.jpg",
    "description": "Leads worship and oversees Compassionate Ministry. Gifted vocalist and worship leader.",
    "country": "Eswatini",
    "role": "Worship Leader",
    "order": 12,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-gabsile-makhanya"
  },
  {
    "name": "Petrina Kumwenda",
    "title": "Praise and Worship - Zambia",
    "category": "worship",
    "image": "https://i.ibb.co/S4G3vhMt/pet.jpg",
    "description": "Devoted praise and worshiper using her gift of music. Leads worship in Zambia services.",
    "country": "Zambia",
    "role": "Worship Leader",
    "order": 13,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-petrina-kumwenda"
  },
  {
    "name": "Compassionate Ministry",
    "title": "Children's Ministry",
    "category": "ministries",
    "image": "https://i.ibb.co/rG15FCg5/cd.jpg",
    "description": "Dedicated to nurturing spiritual growth of children. Weekly Sunday school and children's programs.",
    "country": "Eswatini",
    "role": "Children's Ministry",
    "order": 14,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-compassionate-ministry"
  },
  {
    "name": "Ngculwini Prayer Dome",
    "title": "Prayer Center - Eswatini",
    "category": "ministries",
    "image": "https://i.ibb.co/qKCwrZ1/pd.jpg",
    "description": "Vibrant prayer community dedicated to intercession. 24/7 prayer coverage and weekly prayer meetings.",
    "country": "Eswatini",
    "role": "Prayer Center",
    "order": 15,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-ngculwini-prayer-dome"
  },
  {
    "name": "Hluthi Prayer Dome",
    "title": "Prayer Center - Eswatini",
    "category": "ministries",
    "image": "https://i.ibb.co/Kc7HhZd1/lv.jpg",
    "description": "Growing community of believers committed to prayer. Evangelism and discipleship programs.",
    "country": "Eswatini",
    "role": "Prayer Center",
    "order": 16,
    "archived": false,
    "deceased": false,
    "lateLabel": "Late",
    "id": "team-hluthi-prayer-dome"
  }
];

  global.PD_TEAM_DEFAULT = TEAM;
  global.PDTeamData = {
    roster: function () { return TEAM.map(function (m) { return Object.assign({}, m); }); },
    byId: function (id) { return TEAM.filter(function (m) { return m.id === id; })[0] || null; }
  };
})(window);
