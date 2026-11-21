/*!
 * Prayer Dome — server-side verse bank for push dispatch.
 * A small mirror of the four daily slots in assets/pd-verse-data.js so the
 * scheduled Cloud Function can send the same kind of verse when the app is
 * closed. Admin overrides come from Firestore `verseSchedule/{YYYY-MM-DD}`.
 */
'use strict';

const SLOTS = [
  {
    "id": "morning",
    "label": "Morning Verse",
    "defaultTime": "06:30",
    "greeting": "Good morning"
  },
  {
    "id": "midday",
    "label": "Midday Verse",
    "defaultTime": "12:00",
    "greeting": "Grace for midday"
  },
  {
    "id": "afternoon",
    "label": "Afternoon Verse",
    "defaultTime": "15:30",
    "greeting": "Strength this afternoon"
  },
  {
    "id": "evening",
    "label": "Evening Verse",
    "defaultTime": "20:00",
    "greeting": "Rest well tonight"
  }
];

const VERSES = {
  "morning": [
    {
      "ref": "Isaiah 40:31",
      "text": "But those who hope in the LORD will renew their strength. They will soar on wings like eagles; they will run and not grow weary, they will walk and not be faint."
    },
    {
      "ref": "Psalm 59:16",
      "text": "But I will sing of your strength, in the morning I will sing of your love; for you are my fortress, my refuge in times of trouble."
    },
    {
      "ref": "Isaiah 41:10",
      "text": "So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you; I will uphold you with my righteous right hand."
    },
    {
      "ref": "Deuteronomy 31:6",
      "text": "Be strong and courageous. Do not be afraid or terrified because of them, for the LORD your God goes with you; he will never leave you nor forsake you."
    },
    {
      "ref": "Lamentations 3:22-23",
      "text": "Because of the LORD’s great love we are not consumed, for his compassions never fail. They are new every morning; great is your faithfulness."
    }
  ],
  "midday": [
    {
      "ref": "1 Peter 5:7",
      "text": "Cast all your anxiety on him because he cares for you."
    },
    {
      "ref": "2 Corinthians 12:9",
      "text": "But he said to me, “My grace is sufficient for you, for my power is made perfect in weakness.”"
    },
    {
      "ref": "Psalm 119:105",
      "text": "Your word is a lamp for my feet, a light on my path."
    },
    {
      "ref": "Psalm 145:18",
      "text": "The LORD is near to all who call on him, to all who call on him in truth."
    },
    {
      "ref": "Psalm 46:1",
      "text": "God is our refuge and strength, an ever-present help in trouble."
    }
  ],
  "afternoon": [
    {
      "ref": "Isaiah 30:15",
      "text": "In repentance and rest is your salvation, in quietness and trust is your strength."
    },
    {
      "ref": "Psalm 73:26",
      "text": "My flesh and my heart may fail, but God is the strength of my heart and my portion forever."
    },
    {
      "ref": "John 15:5",
      "text": "“I am the vine; you are the branches. If you remain in me and I in you, you will bear much fruit; apart from me you can do nothing.”"
    },
    {
      "ref": "Romans 12:12",
      "text": "Be joyful in hope, patient in affliction, faithful in prayer."
    },
    {
      "ref": "Philippians 4:6-7",
      "text": "Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God. And the peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus."
    }
  ],
  "evening": [
    {
      "ref": "Psalm 42:8",
      "text": "By day the LORD directs his love, at night his song is with me — a prayer to the God of my life."
    },
    {
      "ref": "Ephesians 4:26",
      "text": "“In your anger do not sin”: Do not let the sun go down while you are still angry."
    },
    {
      "ref": "Numbers 6:24-26",
      "text": "The LORD bless you and keep you; the LORD make his face shine on you and be gracious to you; the LORD turn his face toward you and give you peace."
    },
    {
      "ref": "Zephaniah 3:17",
      "text": "The LORD your God is with you, the Mighty Warrior who saves. He will take great delight in you; in his love he will no longer rebuke you, but will rejoice over you with singing."
    },
    {
      "ref": "Psalm 63:6",
      "text": "On my bed I remember you; I think of you through the watches of the night."
    }
  ]
};

function dayIndex(date) {
  const start = Date.UTC(2024, 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000);
}

function verseFor(slotId, date) {
  const slotIndex = Math.max(0, SLOTS.findIndex((s) => s.id === slotId));
  const pool = VERSES[SLOTS[slotIndex].id] || VERSES.morning;
  const verse = pool[Math.abs(dayIndex(date || new Date())) % pool.length];
  const slot = SLOTS[slotIndex];
  return { slot: slot.id, slotLabel: slot.label, reference: verse.ref, text: verse.text, translation: 'NIV' };
}

module.exports = { SLOTS, VERSES, verseFor };
