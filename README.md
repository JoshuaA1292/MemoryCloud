# The Cloud

Full-stack app with a Vite/React frontend and an Express/MongoDB backend.

## Structure
- `client/` Vite + React app
- `server/` Express API + MongoDB + Gemini

## Local Development
1. Backend
   - Copy `server/.env.example` to `server/.env` and fill values.
   - Install and run:
     - `cd server`
     - `npm install`
     - `npm start`
2. Frontend
   - Optional: create `client/.env.local` with:
     - `VITE_API_BASE_URL=http://127.0.0.1:8080`
   - Install and run:
     - `cd client`
     - `npm install`
     - `npm run dev`

## Environment Variables
Backend (`server/.env`)
- `MONGO_URI` MongoDB connection string
- `GEMINI_API_KEY` Gemini API key
- `PORT` (optional) server port
- `CORS_ORIGIN` (optional) comma-separated allowed origins

Frontend (`client/.env.local`)
- `VITE_API_BASE_URL` Base URL for the API (no trailing `/api` required)

## Deploy (Render)
Backend Web Service
- Root: `server`
- Build: `npm install`
- Start: `npm start`
- Env vars: `MONGO_URI`, `GEMINI_API_KEY`, `CORS_ORIGIN`, optional `PORT`

Frontend Static Site
- Root: `client`
- Build: `npm install && npm run build`
- Publish directory: `dist`
- Env vars: `VITE_API_BASE_URL` set to your Render backend URL

## Notes
- Do not commit `.env` files. Use Render environment variables for production.
