// server/models/Memory.js // This is the schema or the blueprint for the database
const mongoose = require('mongoose');

// 1. DEFINE THE BLUEPRINT
const MemorySchema = new mongoose.Schema({
  // A. The Human Data (What the user types)
  text: {
    type: String,
    required: true, // A memory must have text
  },
  voiceNoteUrl: {
    type: String,
    default: "",
  },
  metadata: {
    emotion: {
      type: String,
      default: "",
    },
    setting: {
      type: String,
      default: "",
    },
    timeDistance: {
      type: String,
      default: "",
    },
    confusion: {
      type: String,
      default: "",
    },
  },
  location: {
    type: String,
    default: "Unknown", // If they don't say where, we mark it 'Unknown'
  },
  mood: {
    type: String,
    required: true,
  },

  tags: {
    type: [String],
    default: [],
  },

  color: {
    type: String,
    default: "#FFFFFF",
  },

  themeVector: {
    emotionalCore: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    narrativeState: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    relationalFocus: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    temporalOrientation: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    spatialIntimacy: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },

  links: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },
  
  // B. The AI Data (The Math)
  
  embedding: {
    type: [Number], 
    required: true,
  },

  // C. Metadata (Automatic)
  createdAt: {
    type: Date,
    default: Date.now, // Automatically set the time when saved
  }
});

// 2. COMPILE THE MODEL

const Memory = mongoose.model('Memory', MemorySchema);

// 3. EXPORT IT

module.exports = Memory;
