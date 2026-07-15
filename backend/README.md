# DevTools Pro Backend

Replaces Google Sheets with **Supabase (free PostgreSQL)**. Automatically attaches Google Meet links and sends setup notes when users submit their details.

## Features

- **Supabase PostgreSQL** — Free tier: 500MB storage, unlimited API requests, no expiry
- **Auto Meet Link** — Assigns a Google Meet link from your pre-created pool
- **Auto Setup Note** — "Team will join in 5 minutes" message included automatically
- **Duplicate Detection** — Prevents same UTR from being submitted twice
- **WhatsApp Integration** — Returns pre-formatted WhatsApp message with Meet link
- **Admin Endpoints** — View all submissions, check stats

## Setup (One-time)

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) → Sign up (free)
2. Click **New Project** → give it a name + password
3. Wait for project to spin up (~30 seconds)

### 2. Create Database Tables

Run each of these SQL scripts in **Supabase dashboard → SQL Editor → New Query**, one at a time. All scripts are idempotent — safe to re-run on an existing database.

| File | What it creates | When to run |
| ---- | --------------- | ----------- |
| `setup-db.sql`                | `submissions` table + RLS lockdown       | First-time setup |
| `setup-users.sql`             | `users` table + soft-delete + phone audit columns | First-time setup, and re-run after v1.3 upgrade to add `phone_updated_at` / `phone_updated_by` |
| `setup-payments.sql`          | `payments` table + screenshot metadata columns    | First-time setup, and re-run after v1.3 upgrade to add `screenshot_*` columns |
| `setup-payment-screenshots.sql` | `payment_screenshots` blob table                | New in v1.3 — required for the payment-screenshot upload flow |
| `setup-notifications.sql`     | `notifications` table                             | New in v1.3 — required for admin → user dashboard notifications |
| `setup-reviews.sql`           | `reviews` table                                   | First-time setup |

You should see "Success" ✓ after each script.

### 3. Get Your API Keys

1. Go to **Settings** → **API**
2. Copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **anon public** key → this is your `SUPABASE_KEY`

### 4. Configure Environment

```bash
cd backend
cp .env.example .env
# Edit .env with your Supabase URL + Key and Meet links
```

### 5. Run Locally

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| POST | `/api/submit` | Submit user details (main endpoint) |
| GET | `/api/submissions` | Get all submissions (admin) |
| GET | `/api/check-utr/:utrId` | Check if UTR exists |
| GET | `/api/stats` | Get submission statistics |

### POST /api/submit

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "selectedPlan": "Pro+ — ₹1,892/month (2,000 credits)",
  "utrId": "ABC123456789",
  "submissionTimestamp": "2025-01-15T10:30:00.000Z"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Submission saved successfully",
  "data": {
    "id": "uuid-here",
    "meetLink": "https://meet.google.com/xxx-yyyy-zzz",
    "setupNote": "Our team will join the Google Meet within 5 minutes for setup.",
    "whatsappUrl": "https://api.whatsapp.com/send?phone=...",
    "whatsappMessage": "Full formatted message with Meet link",
    "quickReply": "Short confirmation message"
  }
}
```

## Deploy to Render.com (FREE)

1. Push this `backend/` folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set root directory to `backend`
5. Build command: `npm install`
6. Start command: `npm start`
7. Add environment variables:
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_KEY` = your Supabase anon key
   - `MEET_LINK_1` = your Google Meet link
   - `MEET_LINK_2` = another Meet link
   - `FRONTEND_URL` = your GitHub Pages URL
8. Deploy!

Your backend URL will be: `https://your-app.onrender.com`

## Deploy to Railway (FREE)

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set root directory to `backend`
4. Add env vars in Railway dashboard
5. Deploy!

## Setup Google Meet Links

1. Go to [meet.google.com](https://meet.google.com)
2. Click "New meeting" → "Create a meeting for later"
3. Copy the link
4. Repeat 2-3 times for a pool of links
5. Add to your `.env` file as `MEET_LINK_1`, `MEET_LINK_2`, etc.

The system rotates through these links (round-robin) for each new submission.

## Update Frontend

After deploying, update `script.js` line 6:
```javascript
const API_ENDPOINT = 'https://your-app.onrender.com/api/submit';
```

## Why Supabase?

- **Free forever** — No credit card needed, 500MB storage
- **Real PostgreSQL** — Proper relational DB with indexes, constraints
- **Always on** — Data persists across deploys (unlike file-based storage on Render free tier)
- **Dashboard** — View/edit data directly at supabase.com
- **Auto backups** — Daily backups on free tier
