# Deploying to Railway.app

Deploying to Railway is simple and gives you $5 of free credits every month, enough to run this bot 24/7 constantly.

## Step 1: Push your code to GitHub
Railway builds your project directly from a GitHub repository.

1. Open a terminal in `Desktop/Telegram Bot/`
2. Initialize Git and commit the code:
   ```bash
   git init
   git add bot.js api.js package.json package-lock.json railway.json
   git commit -m "Initial commit"
   ```
   *Note: Do NOT add your `.env` file to github as someone could steal your Bot Token.*
3. Go to [GitHub.com](https://github.com), create a new **Private** repository.
4. Copy the two commands github gives you to push an existing repository and run them in your terminal.

## Step 2: Deploy on Railway
1. Go to [Railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Select your repository.
4. Click **Add Variables** before deploying. Add the exact contents of your `.env` file here:
   - `TELEGRAM_BOT_TOKEN="your_token"`
   - `TELEGRAM_CHAT_ID="-1003366098435"`
   - `CHECK_INTERVAL_MINUTES="5"`
   - `FEE_TVL_THRESHOLD_PERCENT="5"`
   - `FEE_THRESHOLD_USD="2000"`
   - `MIN_TVL_THRESHOLD_USD="3000"`
5. Click **Deploy**.

## Step 3: Monitor
Once deployed, Railway will automatically find the `railway.json` file I just created, which tells it to run `node bot.js` and restart automatically if it ever crashes. You can view the live console output on the Railway dashboard!
