const express = require('express');
const router = express.Router();
const Memory = require('../models/Memory');

function buildIdeaLinks(memories) {
  const links = [];
  const contradictions = [
    ['joy', 'grief'],
    ['love', 'anger'],
    ['hope', 'despair'],
    ['fear', 'relief'],
    ['light', 'dark'],
    ['home', 'loss']
  ];
  const absenceTags = new Set(['unsaid', 'silence', 'absence', 'missing', 'hollow']);
  for (let i = 0; i < memories.length; i += 1) {
    for (let j = i + 1; j < memories.length; j += 1) {
      const a = memories[i];
      const b = memories[j];
      if (!a || !b) continue;
      let score = 0;
      let reason = '';
      const aMood = String(a.mood || '').toLowerCase();
      const bMood = String(b.mood || '').toLowerCase();
      const sameMood = aMood && bMood && aMood === bMood;
      const hasContradiction = contradictions.some(
        ([left, right]) => (aMood.includes(left) && bMood.includes(right)) || (aMood.includes(right) && bMood.includes(left))
      );
      if (hasContradiction) {
        score += 2;
        reason = 'shared contradiction';
      }
      if (sameMood) {
        score += 2;
        reason = reason || 'shared mood';
      }
      const aCore = (a.themeVector?.emotionalCore || []).map((entry) => String(entry.label || '').toLowerCase());
      const bCore = (b.themeVector?.emotionalCore || []).map((entry) => String(entry.label || '').toLowerCase());
      const sharedCore = aCore.filter((label) => label && bCore.includes(label));
      if (sharedCore.length) {
        score += 2;
        reason = reason || 'shared emotional core';
      }
      const sharedTags = (a.tags || []).filter((tag) => (b.tags || []).includes(tag));
      if (sharedTags.length) {
        score += Math.min(sharedTags.length, 2);
        reason = reason || 'shared image';
      }
      const aAbsence = (a.tags || []).some((tag) => absenceTags.has(String(tag).toLowerCase()));
      const bAbsence = (b.tags || []).some((tag) => absenceTags.has(String(tag).toLowerCase()));
      if (aAbsence && bAbsence) {
        score += 1;
        reason = reason || 'shared absence';
      }
      if (sameMood && score < 2) {
        links.push({
          id: `family:${a._id}-${b._id}`,
          fromId: String(a._id),
          toId: String(b._id),
          type: 'family',
          score: 1,
          reason: 'shared family'
        });
        continue;
      }
      if (score < 2) continue;
      links.push({
        id: `idea:${a._id}-${b._id}`,
        fromId: String(a._id),
        toId: String(b._id),
        type: sameMood ? 'family' : 'idea',
        score,
        reason
      });
    }
  }
  links.sort((x, y) => y.score - x.score);
  return links.slice(0, 140);
}

router.get('/', async (req, res) => {
  try {
    const memories = await Memory.find().sort({ createdAt: -1 }).limit(200);
    const ideaLinks = buildIdeaLinks(memories);
    res.json(ideaLinks);
  } catch (err) {
    res.status(500).json({ error: 'Link generation failed' });
  }
});

module.exports = router;
