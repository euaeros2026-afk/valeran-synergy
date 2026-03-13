# Valeran · Deployment Guide
## You need: GitHub account (free), Vercel account (free)

### Step 1 — Get Supabase anon key (2 min)
1. supabase.com → valeran-synergy project
2. Settings → API Keys → Legacy tab
3. Copy the "anon public" key (starts with eyJ...)
4. Open frontend/.env.local and paste it as VITE_SUPABASE_ANON_KEY

### Step 2 — Deploy to Vercel (5 min)
1. Go to vercel.com → sign up with Google (eu.aeros.2026@gmail.com)
2. Click "Add New Project" → "Deploy with CLI"
3. Install CLI: open Terminal, run:
   npm install -g vercel
4. In Terminal, go into the valeran-deploy folder, run:
   vercel login
   vercel
5. Follow prompts → project name: valeran-synergy
6. After deploy, go to Vercel dashboard → your project → Settings → Environment Variables
7. Add ALL variables from the .env file in this folder (copy each one)
8. Then redeploy: vercel --prod

### Step 3 — Custom domain (2 min)
1. Vercel dashboard → your project → Settings → Domains
2. Add: app.synergyventures.eu
3. Vercel shows you a CNAME record to add
4. Go to SuperHosting cPanel → Домейни → Редактор на DNS зони
5. Add CNAME: app → cname.vercel-dns.com → Save
6. Wait 10-30 min for propagation

### Step 4 — Load partner profiles
1. supabase.com → SQL Editor
2. Open partner_profiles.sql from this folder
3. Run it
4. Later: update emails when you have them

### Done! app.synergyventures.eu is live.
### Telegram bot starts automatically and sends the welcome message.
