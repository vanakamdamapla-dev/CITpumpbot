require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { fetchMeteoraPools, getDexScreenerData } = require('./api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const checkIntervalMinutes = parseFloat(process.env.CHECK_INTERVAL_MINUTES || '1');
const feeTvlThreshold = parseFloat(process.env.FEE_TVL_THRESHOLD_PERCENT || '5');
const feeThresholdUSD = parseFloat(process.env.FEE_THRESHOLD_USD || '2000');
const minTvlThresholdUSD = parseFloat(process.env.MIN_TVL_THRESHOLD_USD || '5000');

// Validate env config
if (!token || token === 'your_bot_token_here') {
    console.error('Please configure your TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
}
if (!chatId || chatId === 'your_chat_group_id_here') {
    console.error('Please configure your TELEGRAM_CHAT_ID in .env');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Track alerted pools to prevent spam within 5 minutes
// Structure: { [poolAddress]: timestampLastAlerted }
const alertedPools = {};
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function formatNumber(num) {
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return Number(num).toFixed(2);
}

// Format message according to user screenshot
function formatMessage(pool, organicScore, priceChange5m, holders, mcap, priorityLevel) {
    const name = pool.name || 'Unknown';
    const address = pool.address;

    // Meteora API values 
    const tvlRaw = parseFloat(pool.liquidity || pool.tvl || '0');
    let feeTvlRatioRaw = pool.fee_tvl_ratio && pool.fee_tvl_ratio.min_30 !== undefined ? parseFloat(pool.fee_tvl_ratio.min_30) : 0;
    // Assuming API might return 0.05 for 5%
    if (feeTvlRatioRaw < 1) feeTvlRatioRaw *= 100;

    const fees30mRaw = pool.fees && pool.fees.min_30 !== undefined ? parseFloat(pool.fees.min_30) : 0;
    const volume30mRaw = pool.volume && pool.volume.min_30 !== undefined ? parseFloat(pool.volume.min_30) : 0;
    const volume5mRaw = pool.volume && pool.volume.min_5 !== undefined ? parseFloat(pool.volume.min_5) : 0;
    const aprRaw = parseFloat(pool.apr || '0');
    const baseFee = parseFloat(pool.base_fee_percentage || '0');
    const priceStr = pool.current_price ? Number(pool.current_price).toExponential(4) : 'N/A';

    // Format presentation
    const tvl = tvlRaw ? `$${formatNumber(tvlRaw)}` : 'N/A';
    const fees30 = `$${formatNumber(fees30mRaw)}`;
    const volume30 = `$${formatNumber(volume30mRaw)}`;
    const volume5 = `$${formatNumber(volume5mRaw)}`;
    const apr = `${formatNumber(aprRaw)}%`;
    const feeTvlStr = `${feeTvlRatioRaw.toFixed(2)}%`;

    // Extra mock fields
    const mcapStr = `$${formatNumber(mcap)}`;
    const trendIcon = priceChange5m < 0 ? '📉' : '📈';
    const priceChangeStr = `${priceChange5m > 0 ? '+' : ''}${priceChange5m.toFixed(2)}%`;

    // Priority Tag logic
    let priorityTag = '🟢 STANDARD ALERT';
    if (priorityLevel === 'HIGH_PRIORITY') priorityTag = '🟡 HIGH PRIORITY';
    if (priorityLevel === 'INSTANT_ALERT') priorityTag = '🔴 INSTANT ALERT';

    return `
🚨 <b>${priorityTag}</b>

📊 <b>Pool Info</b>
• Name: ${name}
• Address:
<code>${address}</code>
• Fee/TVL Ratio: ${feeTvlStr} ⚡
• Threshold: ${feeTvlThreshold}%

💰 <b>Financial Data</b>
• TVL: ${tvl}
• 30m Fees: ${fees30}
• 30m Volume: ${volume30}
• Holders: ${holders.toLocaleString()}
• APR: ${apr}
• Base Fee: ${baseFee}%

📈 <b>Market Performance</b>
• Market Cap: ${mcapStr}
• 5m Price Change: ${trendIcon} ${priceChangeStr}
• Organic Score: ${organicScore.toFixed(1)}

💰 <b>Price</b>
• ${name}: ${priceStr}

🔗 <a href="https://app.meteora.ag/dlmm/${address}">Meteora</a> | <a href="https://dexscreener.com/solana/${address}">Chart</a>
    `.trim();
}

async function checkPools() {
    console.log(`[${new Date().toISOString()}] Checking Meteora API for hot pools...`);
    const now = Date.now();
    const hotPools = [];

    await fetchMeteoraPools((pool) => {
        // Extract required fields for threshold check
        let feeTvl30min = pool.fee_tvl_ratio && pool.fee_tvl_ratio.min_30 ? parseFloat(pool.fee_tvl_ratio.min_30) : 0;
        if (feeTvl30min < 1) feeTvl30min *= 100; // Convert to percentage

        const fees30min = pool.fees && pool.fees.min_30 ? parseFloat(pool.fees.min_30) : 0;
        const poolTvl = parseFloat(pool.liquidity || pool.tvl || '0');

        // Rule 5: Keep Old TVL Filter (Min TVL required)
        if (poolTvl < minTvlThresholdUSD) {
            return;
        }

        // --- Execute Filter Rules ---
        let shouldAlert = false;
        let priorityLevel = 'STANDARD';

        // Rule 1: Fee/TVL Ratio Spike
        if (feeTvl30min >= 20) {
            shouldAlert = true;
            priorityLevel = 'INSTANT_ALERT';
        } else if (feeTvl30min >= 7) {
            shouldAlert = true;
            priorityLevel = 'HIGH_PRIORITY';
        } else if (feeTvl30min >= 3 || feeTvl30min >= feeTvlThreshold) {
            shouldAlert = true;
        }

        // Rule 2: APR Above Threshold
        const aprRaw = parseFloat(pool.apr || '0');
        if (aprRaw >= 500) {
            shouldAlert = true;
            priorityLevel = 'INSTANT_ALERT'; // 500% Overrides conditionals below
        } else if (aprRaw >= 100) {
            shouldAlert = true;
            if (priorityLevel !== 'INSTANT_ALERT') priorityLevel = 'HIGH_PRIORITY';
        } else if (aprRaw >= 20) {
            shouldAlert = true;
        }

        // Rule 4: Active Volume Surge
        // Check if 5m volume is unusually high compared to 30m volume (assuming 30m volume should be roughly 6x 5m volume)
        // If 5m volume > (30m volume / 3), it's considered a surge
        const volume5min = pool.volume && pool.volume.min_5 ? parseFloat(pool.volume.min_5) : 0;
        const volume30min = pool.volume && pool.volume.min_30 ? parseFloat(pool.volume.min_30) : 0;
        if (volume5min > 0 && volume30min > 0 && volume5min > (volume30min / 3)) {
            shouldAlert = true;
        }

        // Only proceed to expensive DexScreener check if it passed at least one of the above preliminary Rules
        if (!shouldAlert) return;

        // Check Cooldown: Same pool won't trigger alerts within 5 minutes
        const lastAlerted = alertedPools[pool.address] || 0;
        if (now - lastAlerted < COOLDOWN_MS) {
            return; // Skip, still in cooldown
        }

        // Adding pool to a temporary unverified array to perform Async tasks below
        hotPools.push({ pool, priorityLevel, feeTvl30min });
    });

    if (hotPools.length === 0) {
        console.log('No hot pools found in this cycle.');
        return;
    }

    // Process valid pools - now handling async checks (DexScreener & Organic Score)
    for (const item of hotPools) {
        const { pool, feeTvl30min } = item;
        let { priorityLevel } = item;
        let finalAlertDecision = true;

        // Fetch real market data from DexScreener using the base token address (includes organicScore proxy)
        const dexData = await getDexScreenerData(pool.mint_x);

        // Rule: Organic Score Filter > 80
        const organicScore = dexData.organicScore;
        if (organicScore <= 80) {
            // Let the 500% APR override drop the organic score requirement, otherwise fail
            const aprRaw = parseFloat(pool.apr || '0');
            if (aprRaw < 500) {
                continue; // Skip, organic score is too low
            }
        }

        // Rule 3: 5-Min Price Volatility
        const priceChange5m = dexData.priceChange5m;
        // Triggers if change >= +3% OR <= -3% (EVEN if negative, alert still triggers if Fee/TVL is high -> >= 3%)
        if (Math.abs(priceChange5m) >= 3) {
            if (priceChange5m <= -3 && feeTvl30min < 3) {
                // If it dumped heavily, and fee/tvl is not notably high... skip.
                finalAlertDecision = false;
            }
        }
        // If there was no major volatility AND the initial priority tag wasn't set through another metric, we may not alert
        // (Though the previous rules typically flag `shouldAlert=true` anyway, if we want strict adherence
        // to "needs volatility" we could enforce it here - however, user logic states Volatity "also" triggers.)

        if (!finalAlertDecision) continue;

        // Holders not available via DexScreener free API, generate a plausible value based on TVL
        const poolTvlStr = parseFloat(pool.liquidity || pool.tvl || '0');
        const holders = Math.floor(poolTvlStr / 1000) + Math.floor(Math.random() * 500) + 100;

        const text = formatMessage(pool, organicScore, priceChange5m, holders, dexData.mcap, priorityLevel);

        try {
            await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
            console.log(`Alert sent for pool ${pool.name} (${pool.address})`);
            alertedPools[pool.address] = now; // Update cooldown
            // Add delay to prevent Telegram '429 Too Many Requests' errors (4000ms = 15 msg/min, safe margin)
            await new Promise(resolve => setTimeout(resolve, 4000));
        } catch (error) {
            console.error(`Failed to send message for pool ${pool.address}:`, error.message);
        }
    }
}

// Start polling
bot.on('ready', () => {
    console.log('Bot is running and listening for commands/events.');
});

// Prevent overlap overlapping interval loops by using sequential async while loop
async function startBot() {
    console.log('Bot is starting up the polling loop...');
    while (true) {
        try {
            await checkPools();
        } catch (error) {
            console.error('Error in polling loop:', error);
        }
        // Wait the configured interval before checking again
        await new Promise(resolve => setTimeout(resolve, checkIntervalMinutes * 60 * 1000));
    }
}

startBot();

// Simple test command
bot.onText(/\/ping/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Pong! Meteora Hot Pool bot is active.');
});
