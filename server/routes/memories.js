const express = require('express');
const router = express.Router();
const Memory = require('../models/Memory');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cosineSimilarity = require('cosine-similarity');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

// RATE LIMIT TRACKING
let requestCount = 0;
let rateLimitResetTime = Date.now() + 60000; // Reset every minute

function checkRateLimit() {
  const now = Date.now();
  if (now >= rateLimitResetTime) {
    requestCount = 0;
    rateLimitResetTime = now + 60000;
  }
  
  if (requestCount >= 14) { // Stay under 15/min limit
    return false;
  }
  
  requestCount++;
  return true;
}

// OFFLINE MODE FALLBACK
const OFFLINE_MOODS = [
  { name: 'Memory', color: '#9CA3AF' },
  { name: 'Reflection', color: '#60A5FA' },
  { name: 'Longing', color: '#A78BFA' },
  { name: 'Quiet Joy', color: '#34D399' },
  { name: 'Tension', color: '#F87171' },
  { name: 'Relief', color: '#FBBF24' },
  { name: 'Grief', color: '#6B7280' },
  { name: 'Wonder', color: '#EC4899' }
];

function getOfflineMood() {
  const random = OFFLINE_MOODS[Math.floor(Math.random() * OFFLINE_MOODS.length)];
  return {
    mood: random.name,
    tags: ['Offline', 'Auto-classified'],
    color: random.color,
    themeVector: {
      emotionalCore: [{ label: 'memory', weight: 1 }],
      narrativeState: [{ label: 'unfinished', weight: 1 }],
      relationalFocus: [{ label: 'self', weight: 1 }],
      temporalOrientation: [{ label: 'memory', weight: 1 }],
      spatialIntimacy: [{ label: 'private', weight: 1 }]
    },
    offlineMode: true
  };
}

// HELPER: Clean JSON from AI
function cleanAIResponse(text) {
  let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON found");
  return clean.substring(start, end + 1);
}

function normalizeAnalysis(analysis) {
  const moodRaw = analysis?.mood || analysis?.emotion || analysis?.Mood || analysis?.Emotion;
  const mood = typeof moodRaw === 'string' && moodRaw.trim() ? moodRaw.trim() : 'Fragment';
  const tags = Array.isArray(analysis?.tags)
    ? analysis.tags.filter(Boolean).slice(0, 5)
    : ['Raw', 'Unsorted'];
  const color = typeof analysis?.color === 'string' && analysis.color.trim() ? analysis.color.trim() : '#FFFFFF';
  const themeVector = normalizeThemeVector(analysis?.themeVector);
  
  return { mood, tags, color, themeVector };
}

function normalizeAxis(entries, fallbackLabel) {
  if (!Array.isArray(entries)) {
    return [{ label: fallbackLabel, weight: 1 }];
  }
  const cleaned = entries
    .map((entry) => {
      const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
      const weight = typeof entry?.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 0;
      return label ? { label, weight: Math.max(0, weight) } : null;
    })
    .filter(Boolean)
    .slice(0, 4);

  const total = cleaned.reduce((sum, item) => sum + item.weight, 0);
  if (!cleaned.length || total <= 0) {
    return [{ label: fallbackLabel, weight: 1 }];
  }
  return cleaned.map((item) => ({ label: item.label, weight: item.weight / total }));
}

function normalizeThemeVector(themeVector) {
  return {
    emotionalCore: normalizeAxis(themeVector?.emotionalCore, 'memory'),
    narrativeState: normalizeAxis(themeVector?.narrativeState, 'unfinished'),
    relationalFocus: normalizeAxis(themeVector?.relationalFocus, 'self'),
    temporalOrientation: normalizeAxis(themeVector?.temporalOrientation, 'memory'),
    spatialIntimacy: normalizeAxis(themeVector?.spatialIntimacy, 'private'),
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => String(tag || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function isValidEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length < 8) return false;
  const energy = embedding.reduce((sum, value) => sum + Math.abs(value || 0), 0);
  return energy > 0;
}

async function embedText(text) {
  if (!checkRateLimit()) {
    console.warn("⚠️ Rate limit reached, skipping embedding");
    return [0, 0, 0];
  }
  
  try {
    const result = await embeddingModel.embedContent(text);
    const values = result?.embedding?.values;
    if (isValidEmbedding(values)) return values;
  } catch (error) {
    if (error.message?.includes('quota') || error.message?.includes('limit')) {
      console.warn("⚠️ Rate limit hit during embedding:", error.message);
      return [0, 0, 0];
    }
    console.error("Embedding Error:", error);
  }
  return [0, 0, 0];
}

function axisToMap(axis) {
  const map = new Map();
  if (!Array.isArray(axis)) return map;
  axis.forEach((entry) => {
    const label = typeof entry?.label === 'string' ? entry.label.trim().toLowerCase() : '';
    const weight = typeof entry?.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 0;
    if (!label || weight <= 0) return;
    map.set(label, (map.get(label) || 0) + weight);
  });
  return map;
}

function normalizeAxisFromMap(map) {
  const entries = Array.from(map.entries()).map(([label, weight]) => ({ label, weight }));
  return normalizeAxis(entries, 'memory');
}

function axisSimilarity(leftAxis, rightAxis) {
  const leftMap = axisToMap(leftAxis);
  const rightMap = axisToMap(rightAxis);
  if (!leftMap.size || !rightMap.size) return 0;
  let score = 0;
  leftMap.forEach((weight, label) => {
    const rightWeight = rightMap.get(label) || 0;
    score += weight * rightWeight;
  });
  return score;
}

function themeSimilarity(leftVector, rightVector) {
  const axes = ['emotionalCore', 'narrativeState', 'relationalFocus', 'temporalOrientation', 'spatialIntimacy'];
  const scores = axes.map((axis) => axisSimilarity(leftVector?.[axis], rightVector?.[axis]));
  const total = scores.reduce((sum, value) => sum + value, 0);
  return scores.length ? total / scores.length : 0;
}

function tagSimilarity(leftTags, rightTags) {
  const left = new Set(normalizeTags(leftTags));
  const right = new Set(normalizeTags(rightTags));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  left.forEach((tag) => {
    if (right.has(tag)) intersection += 1;
  });
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

function buildFamilyStats(memories) {
  const families = new Map();
  memories.forEach((memory) => {
    const mood = typeof memory?.mood === 'string' ? memory.mood.trim() : '';
    if (!mood) return;
    if (!families.has(mood)) {
      families.set(mood, {
        mood,
        embeddingSum: [],
        embeddingCount: 0,
        themeMaps: {
          emotionalCore: new Map(),
          narrativeState: new Map(),
          relationalFocus: new Map(),
          temporalOrientation: new Map(),
          spatialIntimacy: new Map(),
        },
        tagCounts: new Map(),
      });
    }
    const stats = families.get(mood);
    const embedding = Array.isArray(memory.embedding) ? memory.embedding : null;
    if (isValidEmbedding(embedding)) {
      if (!stats.embeddingSum.length) {
        stats.embeddingSum = embedding.map((value) => value || 0);
      } else {
        stats.embeddingSum = stats.embeddingSum.map((value, index) => value + (embedding[index] || 0));
      }
      stats.embeddingCount += 1;
    }
    const themeVector = memory.themeVector || {};
    Object.keys(stats.themeMaps).forEach((axis) => {
      const axisEntries = Array.isArray(themeVector[axis]) ? themeVector[axis] : [];
      axisEntries.forEach((entry) => {
        const label = typeof entry?.label === 'string' ? entry.label.trim().toLowerCase() : '';
        const weight = typeof entry?.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 0;
        if (!label || weight <= 0) return;
        const map = stats.themeMaps[axis];
        map.set(label, (map.get(label) || 0) + weight);
      });
    });
    normalizeTags(memory.tags).forEach((tag) => {
      stats.tagCounts.set(tag, (stats.tagCounts.get(tag) || 0) + 1);
    });
  });

  const familyStats = [];
  families.forEach((stats) => {
    const embedding =
      stats.embeddingCount > 0
        ? stats.embeddingSum.map((value) => value / stats.embeddingCount)
        : null;
    const themeVector = {};
    Object.keys(stats.themeMaps).forEach((axis) => {
      themeVector[axis] = normalizeAxisFromMap(stats.themeMaps[axis]);
    });
    const tags = Array.from(stats.tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag]) => tag);
    familyStats.push({ mood: stats.mood, embedding, themeVector, tags });
  });

  return familyStats;
}

function scoreFamilyMatch(candidate, family) {
  const hasEmbedding = isValidEmbedding(candidate.embedding) && isValidEmbedding(family.embedding);
  const embeddingScore = hasEmbedding ? cosineSimilarity(candidate.embedding, family.embedding) : 0;
  const themeScore = themeSimilarity(candidate.themeVector, family.themeVector);
  const tagScore = tagSimilarity(candidate.tags, family.tags);

  let weights = { embedding: 0.6, theme: 0.25, tags: 0.15 };
  if (!hasEmbedding) {
    weights = { embedding: 0, theme: 0.65, tags: 0.35 };
  }
  const totalWeight = weights.embedding + weights.theme + weights.tags || 1;
  const score =
    (embeddingScore * weights.embedding + themeScore * weights.theme + tagScore * weights.tags) / totalWeight;

  return { score, components: { embeddingScore, themeScore, tagScore, hasEmbedding } };
}

async function proposeNewFamilyName(text, existingFamilies) {
  if (!checkRateLimit()) {
    console.warn("⚠️ Rate limit reached, using offline mode");
    return null;
  }
  
  const prompt = `You are naming a new emotional family for a personal story.

Existing families:
${existingFamilies.map((family) => `- ${family}`).join('\n')}

Story:
"${text}"

Return ONLY valid JSON:
{
  "mood": "New family name that is distinct from the existing families"
}`;

  try {
    const result = await model.generateContent(prompt);
    const jsonStr = cleanAIResponse(result.response.text());
    const parsed = JSON.parse(jsonStr);
    const mood = typeof parsed?.mood === 'string' ? parsed.mood.trim() : '';
    return mood || null;
  } catch (error) {
    if (error.message?.includes('quota') || error.message?.includes('limit')) {
      console.warn("⚠️ Rate limit hit during family naming");
      return null;
    }
    console.error("New Family Naming Error:", error);
    return null;
  }
}

async function broadenMoodName(mood, existingFamilies) {
  if (!mood || typeof mood !== 'string') return null;
  if (!checkRateLimit()) {
    console.warn("⚠️ Rate limit reached, skipping mood broadening");
    return null;
  }
  
  const prompt = `You are refining an emotional family name to be broader and more archetypal.

Current family name:
"${mood}"

Existing families:
${existingFamilies.map((family) => `- ${family}`).join('\n')}

Rules:
- Return a broader concept (1-3 words).
- Avoid overly specific phrases, verbs, or event-like titles.
- Prefer timeless emotional categories (e.g., "Longing", "Grief", "Quiet Joy", "Tension", "Relief").
- If the current name is already broad enough, return it unchanged.

Return ONLY valid JSON:
{
  "mood": "Broader family name"
}`;

  try {
    const result = await model.generateContent(prompt);
    const jsonStr = cleanAIResponse(result.response.text());
    const parsed = JSON.parse(jsonStr);
    const nextMood = typeof parsed?.mood === 'string' ? parsed.mood.trim() : '';
    if (!nextMood) return null;
    return nextMood;
  } catch (error) {
    if (error.message?.includes('quota') || error.message?.includes('limit')) {
      console.warn("⚠️ Rate limit hit during mood broadening");
      return null;
    }
    console.error("Broaden Mood Error:", error);
    return null;
  }
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { emotion: '', setting: '', timeDistance: '', confusion: '' };
  }
  return {
    emotion: typeof metadata.emotion === 'string' ? metadata.emotion.trim() : '',
    setting: typeof metadata.setting === 'string' ? metadata.setting.trim() : '',
    timeDistance: typeof metadata.timeDistance === 'string' ? metadata.timeDistance.trim() : '',
    confusion: typeof metadata.confusion === 'string' ? metadata.confusion.trim() : '',
  };
}

function normalizeLinkPayload(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') {
    return { url: payload.trim(), label: 'Response', type: 'External', notes: '' };
  }
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : 'Response';
  const type = typeof payload.type === 'string' && payload.type.trim() ? payload.type.trim() : 'External';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  if (!url) return null;
  return { url, label, type, notes, createdAt: new Date() };
}

// GET ALL
router.get('/', async (req, res) => {
  try {
    const memories = await Memory.find().sort({ createdAt: -1 }).limit(100);
    res.json(memories);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// GET EXISTING MOOD FAMILIES
router.get('/families', async (req, res) => {
  try {
    const families = await Memory.distinct('mood');
    res.json(families);
  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

// POST (INGEST) - CONTEXT-AWARE CLASSIFICATION WITH RATE LIMIT HANDLING
router.post('/', async (req, res) => {
  try {
    const { text, voiceNoteUrl, metadata } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }
    console.log("📥 Ingesting:", text.substring(0, 50) + "...");

    // GET EXISTING MOOD FAMILIES
    const existingFamilies = await Memory.distinct('mood');
    console.log("📚 Existing families:", existingFamilies);

    let analysis;
    let offlineMode = false;

    // CHECK RATE LIMIT BEFORE AI CALL
    if (!checkRateLimit()) {
      console.warn("🔴 OFFLINE MODE: Rate limit reached");
      analysis = getOfflineMood();
      offlineMode = true;
    } else {
      // CONTEXT-AWARE PROMPT
      const prompt = `Analyze this personal story for emotional classification: "${text}"

${existingFamilies.length > 0 ? `
EXISTING MOOD FAMILIES in the archive:
${existingFamilies.map(f => `- ${f}`).join('\n')}

First, check if this story fits into one of the EXISTING families above. Only create a NEW family name if:
1. The story's emotion is distinctly different from all existing families
2. The nuance cannot be captured by any existing family
3. It represents a genuinely new emotional territory

If it fits an existing family, use that exact name.
` : `
This is one of the first stories in the archive. Create an evocative mood family name.
`}

CLASSIFICATION GUIDELINES:
- Mood family names should be poetic but clear (e.g., "Grief", "Quiet Joy", "Longing", "Relief")
- Be specific enough to be meaningful but broad enough to hold multiple stories
- Avoid overly narrow classifications that would only fit one story
- Think about emotional resonance and thematic kinship

Return ONLY valid JSON:
{
  "mood": "Family name (existing or new)",
  "reasoning": "Brief explanation of why this family fits or why a new one was needed",
  "tags": ["keyword1", "keyword2", "keyword3"],
  "color": "#HEXCODE",
  "themeVector": {
    "emotionalCore": [{"label": "primary_emotion", "weight": 0.7}, {"label": "secondary_emotion", "weight": 0.3}],
    "narrativeState": [{"label": "unfinished", "weight": 0.6}, {"label": "resolved", "weight": 0.4}],
    "relationalFocus": [{"label": "self", "weight": 0.5}, {"label": "family", "weight": 0.5}],
    "temporalOrientation": [{"label": "memory", "weight": 0.8}, {"label": "present", "weight": 0.2}],
    "spatialIntimacy": [{"label": "private", "weight": 0.7}, {"label": "public", "weight": 0.3}]
  }
}`;

      try {
        const result = await model.generateContent(prompt);
        const rawText = result.response.text();
        
        const jsonStr = cleanAIResponse(rawText);
        analysis = JSON.parse(jsonStr);
        console.log("🎨 AI Classification:", analysis.mood);
        console.log("💭 Reasoning:", analysis.reasoning);
      } catch (parseError) {
        if (parseError.message?.includes('quota') || parseError.message?.includes('limit')) {
          console.warn("🔴 OFFLINE MODE: Rate limit hit during classification");
          analysis = getOfflineMood();
          offlineMode = true;
        } else {
          console.error("AI Parse Error:", parseError);
          analysis = { mood: "Memory", tags: ["Raw", "Unsorted"], color: "#CCCCCC" };
        }
      }
    }

    const normalized = normalizeAnalysis(analysis);
    const themeVector = normalized.themeVector || normalizeThemeVector(analysis?.themeVector);
    const normalizedMetadata = normalizeMetadata(metadata);
    const embedding = await embedText(text);

    let finalMood = normalized.mood;
    let isNewFamily = false;
    let clusterDecision = { decidedBy: offlineMode ? 'offline' : 'ai', bestMatch: null, bestScore: null };

    if (!offlineMode && existingFamilies.length > 0) {
      const sampleMemories = await Memory.find({ mood: { $in: existingFamilies } })
        .select('mood embedding themeVector tags')
        .sort({ createdAt: -1 })
        .limit(400);
      const familyStats = buildFamilyStats(sampleMemories);
      const candidate = { embedding, themeVector, tags: normalized.tags };
      const scoredFamilies = familyStats
        .map((family) => {
          const scored = scoreFamilyMatch(candidate, family);
          return {
            mood: family.mood,
            score: scored.score,
            components: scored.components,
          };
        })
        .sort((a, b) => b.score - a.score);

      const best = scoredFamilies[0];
      const second = scoredFamilies[1];
      const aiScore = scoredFamilies.find((entry) => entry.mood === normalized.mood);
      const hasEmbedding = isValidEmbedding(embedding) && Boolean(best?.components?.hasEmbedding);
      const threshold = hasEmbedding ? 0.62 : 0.52;
      const strongThreshold = hasEmbedding ? 0.72 : 0.6;
      const margin = 0.08;
      const bestMargin = best ? best.score - (second?.score || 0) : 0;

      if (best && best.score >= threshold && (bestMargin >= margin || best.score >= strongThreshold)) {
        finalMood = best.mood;
        isNewFamily = false;
        clusterDecision = { decidedBy: 'similarity', bestMatch: best.mood, bestScore: best.score };
      } else if (!existingFamilies.includes(normalized.mood)) {
        finalMood = normalized.mood;
        isNewFamily = true;
        clusterDecision = { decidedBy: 'ai-new', bestMatch: best?.mood || null, bestScore: best?.score || null };
      } else if (aiScore && aiScore.score >= threshold - 0.05) {
        finalMood = normalized.mood;
        isNewFamily = false;
        clusterDecision = { decidedBy: 'ai-existing', bestMatch: best?.mood || null, bestScore: best?.score || null };
      } else {
        const suggestedMood = await proposeNewFamilyName(text, existingFamilies);
        finalMood = suggestedMood || normalized.mood;
        isNewFamily = !existingFamilies.includes(finalMood);
        clusterDecision = { decidedBy: 'ai-override', bestMatch: best?.mood || null, bestScore: best?.score || null };
      }

      console.log("🧭 Cluster decision:", clusterDecision);
      if (best) {
        console.log("🔍 Best match:", best.mood, "score", best.score.toFixed(3));
      }
    }

    if (!offlineMode && isNewFamily) {
      const broadened = await broadenMoodName(finalMood, existingFamilies);
      if (broadened && broadened !== finalMood) {
        finalMood = broadened;
        isNewFamily = !existingFamilies.includes(finalMood);
      }
    }

    const newMemory = new Memory({
      text,
      voiceNoteUrl: typeof voiceNoteUrl === 'string' ? voiceNoteUrl.trim() : '',
      metadata: normalizedMetadata,
      location: "The Strata",
      mood: finalMood,
      tags: normalized.tags,
      color: normalized.color,
      themeVector,
      embedding
    });

    await newMemory.save();
    
    // Check if this created a new family
    if (!existingFamilies.length) {
      isNewFamily = true;
    }
    
    if (offlineMode) {
      console.log("🔴 OFFLINE MODE:", finalMood);
    } else {
      console.log(isNewFamily ? "🌟 NEW FAMILY CREATED:" : "✅ Added to existing family:", finalMood);
    }
    
    res.json({
      ...newMemory.toObject(),
      isNewFamily,
      reasoning: analysis.reasoning || 'Classified in offline mode due to rate limiting',
      clusterDecision,
      offlineMode
    });

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: "Ingestion Failed" });
  }
});

// FILM BRIEF FOR MOOD FAMILY
router.post('/family/brief', async (req, res) => {
  try {
    const { mood } = req.body;
    if (!mood) return res.status(400).json({ error: "Mood family required" });

    const memories = await Memory.find({ mood }).limit(10);
    if (!memories.length) {
      return res.status(404).json({ error: "No memories found for this mood" });
    }

    if (!checkRateLimit()) {
      return res.status(429).json({ 
        error: "Rate limit reached. Please wait a moment and try again." 
      });
    }

    const storySample = memories.slice(0, 3).map(m => m.text).join(' ... ');
    
    const prompt = `You are a creative director analyzing a collection of personal stories classified as "${mood}".

Sample stories from this emotional family:
"${storySample}"

Total stories in this family: ${memories.length}

Create a filmmaker's brief for a short film exploring this emotional territory.

Return ONLY valid JSON:
{
  "title": "Suggested film title",
  "logline": "One sentence premise that captures the essence",
  "visualStyle": "Cinematography and lighting direction (2-3 sentences)",
  "soundscape": "Audio design suggestions",
  "directorNote": "Artistic guidance for capturing this emotion authentically",
  "keyMoments": ["Scene idea 1", "Scene idea 2", "Scene idea 3"]
}`;

    const result = await model.generateContent(prompt);
    const jsonStr = cleanAIResponse(result.response.text());
    const brief = JSON.parse(jsonStr);
    
    res.json({ 
      mood, 
      count: memories.length,
      ...brief 
    });
    
  } catch (e) {
    if (e.message?.includes('quota') || e.message?.includes('limit')) {
      return res.status(429).json({ 
        error: "Rate limit reached. Please wait a moment and try again." 
      });
    }
    console.error("Family Brief Error:", e);
    res.status(500).json({ error: "Brief generation failed" });
  }
});

// COMPETITION BRIEF (for individual memory)
router.post('/competition/brief', async (req, res) => {
  try {
    const { memoryId } = req.body;
    const memory = await Memory.findById(memoryId);
    if (!memory) return res.status(404).json({ error: "Memory not found" });
    
    if (!checkRateLimit()) {
      return res.status(429).json({ 
        error: "Rate limit reached. Please wait a moment and try again." 
      });
    }
    
    const prompt = `Create a filmmaker's brief for this personal story: "${memory.text}"

Mood Family: ${memory.mood}
Tags: ${memory.tags.join(', ')}

Return ONLY valid JSON:
{
  "logline": "One sentence story summary",
  "visualStyle": "Camera angles, lighting, color palette (2-3 sentences)",
  "soundDesign": "Audio atmosphere and music suggestions",
  "directorNote": "Key artistic advice for authentic emotional portrayal",
  "castingNote": "Character guidance"
}`;
    
    const result = await model.generateContent(prompt);
    const jsonStr = cleanAIResponse(result.response.text());
    const brief = JSON.parse(jsonStr);
    
    res.json(brief);
    
  } catch (e) {
    if (e.message?.includes('quota') || e.message?.includes('limit')) {
      return res.status(429).json({ 
        error: "Rate limit reached. Please wait a moment and try again." 
      });
    }
    console.error("Competition Brief Error:", e);
    res.status(500).json({ error: "Brief Failed" });
  }
});

// ATTACH RESPONSE LINK
router.post('/:id/links', async (req, res) => {
  try {
    const linkPayload = normalizeLinkPayload(req.body);
    if (!linkPayload) return res.status(400).json({ error: "Valid link required" });

    const memory = await Memory.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { links: linkPayload } },
      { new: true }
    );

    if (!memory) return res.status(404).json({ error: "Memory not found" });
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: "Link Failed" });
  }
});

// BACKGROUND RE-CLASSIFICATION WORKER
let isReprocessing = false;

async function reprocessOfflineMemories() {
  if (isReprocessing) {
    console.log("⏳ Reprocessing already in progress, skipping...");
    return;
  }

  try {
    isReprocessing = true;
    
    // Find up to 10 memories that were auto-classified in offline mode
    const offlineMemories = await Memory.find({ tags: 'offline' })
      .sort({ createdAt: 1 }) // Oldest first
      .limit(10);

    if (!offlineMemories.length) {
      console.log("✅ No offline memories to reprocess");
      return;
    }

    console.log(`🔄 Found ${offlineMemories.length} offline memories to reprocess`);

    for (const memory of offlineMemories) {
      // Check rate limit before each memory
      if (!checkRateLimit()) {
        console.log("⚠️ Rate limit reached during reprocessing, will continue next cycle");
        break;
      }

      try {
        console.log(`🔄 Reprocessing: ${memory.text.substring(0, 40)}...`);

        // Get existing families for context
        const existingFamilies = await Memory.distinct('mood');

        // Re-run AI classification
        const prompt = `Analyze this personal story for emotional classification: "${memory.text}"

${existingFamilies.length > 0 ? `
EXISTING MOOD FAMILIES in the archive:
${existingFamilies.map(f => `- ${f}`).join('\n')}

First, check if this story fits into one of the EXISTING families above. Only create a NEW family name if:
1. The story's emotion is distinctly different from all existing families
2. The nuance cannot be captured by any existing family
3. It represents a genuinely new emotional territory

If it fits an existing family, use that exact name.
` : `
This is one of the first stories in the archive. Create an evocative mood family name.
`}

CLASSIFICATION GUIDELINES:
- Mood family names should be poetic but clear (e.g., "Grief", "Quiet Joy", "Longing", "Relief")
- Be specific enough to be meaningful but broad enough to hold multiple stories
- Avoid overly narrow classifications that would only fit one story
- Think about emotional resonance and thematic kinship

Return ONLY valid JSON:
{
  "mood": "Family name (existing or new)",
  "reasoning": "Brief explanation of why this family fits or why a new one was needed",
  "tags": ["keyword1", "keyword2", "keyword3"],
  "color": "#HEXCODE",
  "themeVector": {
    "emotionalCore": [{"label": "primary_emotion", "weight": 0.7}, {"label": "secondary_emotion", "weight": 0.3}],
    "narrativeState": [{"label": "unfinished", "weight": 0.6}, {"label": "resolved", "weight": 0.4}],
    "relationalFocus": [{"label": "self", "weight": 0.5}, {"label": "family", "weight": 0.5}],
    "temporalOrientation": [{"label": "memory", "weight": 0.8}, {"label": "present", "weight": 0.2}],
    "spatialIntimacy": [{"label": "private", "weight": 0.7}, {"label": "public", "weight": 0.3}]
  }
}`;

        const result = await model.generateContent(prompt);
        const rawText = result.response.text();
        const jsonStr = cleanAIResponse(rawText);
        const analysis = JSON.parse(jsonStr);

        const normalized = normalizeAnalysis(analysis);
        const themeVector = normalized.themeVector || normalizeThemeVector(analysis?.themeVector);
        
        // Re-generate embedding
        const embedding = await embedText(memory.text);

        // Perform clustering analysis
        let finalMood = normalized.mood;
        const sampleMemories = await Memory.find({ 
          mood: { $in: existingFamilies },
          _id: { $ne: memory._id } // Exclude current memory
        })
          .select('mood embedding themeVector tags')
          .sort({ createdAt: -1 })
          .limit(400);

        if (sampleMemories.length > 0) {
          const familyStats = buildFamilyStats(sampleMemories);
          const candidate = { embedding, themeVector, tags: normalized.tags };
          const scoredFamilies = familyStats
            .map((family) => {
              const scored = scoreFamilyMatch(candidate, family);
              return { mood: family.mood, score: scored.score };
            })
            .sort((a, b) => b.score - a.score);

          const best = scoredFamilies[0];
          const hasEmbedding = isValidEmbedding(embedding) && best?.components?.hasEmbedding;
          const threshold = hasEmbedding ? 0.62 : 0.52;

          if (best && best.score >= threshold) {
            finalMood = best.mood;
          }
        }

        // Check if new family should be broadened
        const isNewFamily = !existingFamilies.includes(finalMood);
        if (isNewFamily) {
          const broadened = await broadenMoodName(finalMood, existingFamilies);
          if (broadened && broadened !== finalMood) {
            finalMood = broadened;
          }
        }

        // Update the memory
        memory.mood = finalMood;
        memory.tags = normalized.tags; // Remove 'offline' tag
        memory.color = normalized.color;
        memory.themeVector = themeVector;
        memory.embedding = embedding;
        
        await memory.save();

        console.log(`✅ Reprocessed → ${finalMood}`);

        // Small delay between memories to be respectful of API
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        if (error.message?.includes('quota') || error.message?.includes('limit')) {
          console.log("⚠️ Rate limit hit during reprocessing, stopping for this cycle");
          break;
        }
        console.error(`❌ Failed to reprocess memory ${memory._id}:`, error.message);
        // Continue with next memory even if one fails
      }
    }

  } catch (error) {
    console.error("Background reprocessing error:", error);
  } finally {
    isReprocessing = false;
  }
}

// Start background worker - runs every 5 minutes
const REPROCESS_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(reprocessOfflineMemories, REPROCESS_INTERVAL);

// Run once on startup (after 30 seconds to let server fully initialize)
setTimeout(() => {
  console.log("🚀 Starting background reprocessing worker...");
  reprocessOfflineMemories();
}, 30000);

module.exports = router;