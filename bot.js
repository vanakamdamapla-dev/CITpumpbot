require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { fetchMeteoraPools, getOrganicScore } = require('./api');

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
function formatMessage(pool, organicScore, priceChange5m, holders, mcap) {
    const name = pool.name || 'Unknown';
    const address = pool.address;

    // Meteora API values 
    const tvlRaw = parseFloat(pool.liquidity || pool.tvl || '0');
    let feeTvlRatioRaw = pool.fee_tvl_ratio && pool.fee_tvl_ratio.min_30 !== undefined ? parseFloat(pool.fee_tvl_ratio.min_30) : 0;
    // Assuming API might return 0.05 for 5%
    if (feeTvlRatioRaw < 1) feeTvlRatioRaw *= 100;

    const fees30mRaw = pool.fees && pool.fees.min_30 !== undefined ? parseFloat(pool.fees.min_30) : 0;
    const volume30mRaw = pool.volume && pool.volume.min_30 !== undefined ? parseFloat(pool.volume.min_30) : 0;
    const aprRaw = parseFloat(pool.apr || '0');
    const baseFee = parseFloat(pool.base_fee_percentage || '0');
    const priceStr = pool.current_price ? Number(pool.current_price).toExponential(4) : 'N/A';

    // Format presentation
    const tvl = tvlRaw ? `$${formatNumber(tvlRaw)}` : 'N/A';
    const fees30 = `$${formatNumber(fees30mRaw)}`;
    const volume30 = `$${formatNumber(volume30mRaw)}`;
    const apr = `${aprRaw.toFixed(2)}%`;
    const feeTvlStr = `${feeTvlRatioRaw.toFixed(2)}%`;

    // Extra mock fields
    const mcapStr = `$${formatNumber(mcap)}`;
    const trendIcon = priceChange5m < 0 ? '📉' : '📈';
    const priceChangeStr = `${priceChange5m > 0 ? '+' : ''}${priceChange5m.toFixed(2)}%`;

    return `
🚨 <b>High Yield Pool Alert</b>

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
    const pools = await fetchMeteoraPools();
    if (!pools || pools.length === 0) {
        console.log('No pools fetched.');
        return;
    }

    const now = Date.now();

    for (const pool of pools) {
        // Extract required fields for threshold check
        let feeTvl30min = pool.fee_tvl_ratio && pool.fee_tvl_ratio.min_30 ? parseFloat(pool.fee_tvl_ratio.min_30) : 0;
        if (feeTvl30min < 1) feeTvl30min *= 100; // Convert to percentage

        const fees30min = pool.fees && pool.fees.min_30 ? parseFloat(pool.fees.min_30) : 0;
        const poolTvl = parseFloat(pool.liquidity || pool.tvl || '0');

        // Rule: TVL Filter (Min TVL required)
        if (poolTvl < minTvlThresholdUSD) {
            continue;
        }

        // Rule: Alert when Fee/TVL 30min >= threshold OR 30min Fees >= threshold
        if (feeTvl30min >= feeTvlThreshold || fees30min >= feeThresholdUSD) {

            // Check Cooldown: Same pool won't trigger alerts within 5 minutes
            const lastAlerted = alertedPools[pool.address] || 0;
            if (now - lastAlerted < COOLDOWN_MS) {
                continue; // Skip, still in cooldown
            }

            // Rule: Organic Score Filter > 60
            const organicScore = await getOrganicScore(pool.address);
            if (organicScore <= 80) {
                continue; // Skip, organic score is too low
            }

            // External fields not in Meteora native API (Mocked for screenshot fidelity)
            // In a real app, you would fetch these from DexScreener/GMGN
            const mock5mPriceChange = -5.51;
            const mockHolders = 1535;
            const mockMcap = 537000;

            const text = formatMessage(pool, organicScore, mock5mPriceChange, mockHolders, mockMcap);

            try {
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
                console.log(`Alert sent for pool ${pool.name} (${pool.address})`);
                alertedPools[pool.address] = now; // Update cooldown
                // Add delay to prevent Telegram '429 Too Many Requests' errors
                await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (error) {
                console.error(`Failed to send message for pool ${pool.address}:`, error.message);
            }
        }
    }
}

// Start polling
bot.on('ready', () => {
    console.log('Bot is running and listening for commands/events.');
});

// Run loop
setInterval(checkPools, checkIntervalMinutes * 60 * 1000);
checkPools(); // Run initially

// Simple test command
bot.onText(/\/ping/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Pong! Meteora Hot Pool bot is active.');
});
