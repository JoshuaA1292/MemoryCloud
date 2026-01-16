// server/index.js

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// MIDDLEWARE
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
  console.log(`🔔 Request received: ${req.method} ${req.url}`);
  next(); // Pass the request to the next handler
});

const memoriesRoute = require('./routes/memories');
const linksRoute = require('./routes/links');

// --- NEW CODE STARTS HERE ---

// DATABASE CONNECTION
// We use an async function to connect because it takes time to reach the cloud.
const connectDB = async () => {
  try {
    // 1. Attempt to connect
    const conn = await mongoose.connect(process.env.MONGO_URI);
    
    // 2. Success message
    // conn.connection.host tells us exactly which server we reached
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    // 3. Error handling
    // If the internet is down or password is wrong, this runs.
    console.error(`❌ Error: ${error.message}`);
    process.exit(1); // Stop the server if DB fails
  }
};

// Call the function we just wrote
connectDB();

// --- NEW CODE ENDS HERE ---

// ROUTES
app.use('/api/memories', memoriesRoute);
app.use('/api/links', linksRoute);


app.get('/', (req, res) => {
  res.send('The Collective Memory Cloud API is Online ☁️');
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
