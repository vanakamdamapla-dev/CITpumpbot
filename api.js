const axios = require('axios');
const JSONStream = require('JSONStream');

async function fetchMeteoraPools(onPool) {
    try {
        const response = await axios({
            method: 'get',
            url: 'https://dlmm-api.meteora.ag/pair/all',
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        return new Promise((resolve, reject) => {
            const stream = response.data.pipe(JSONStream.parse('*'));
            stream.on('data', pool => {
                if (onPool) onPool(pool);
            });
            stream.on('end', () => resolve());
            stream.on('error', err => reject(err));
        });
    } catch (error) {
        console.error('Error fetching Meteora API:', error.message);
        return false;
    }
}

// Calculate a proxy Organic Score based on DexScreener Transaction and Volume metrics
// Note: "Organic Score" is a proprietary string usually fetched from third party security APIs like GMGN.
// Since Meteora doesn't provide it, we calculate a proxy score out of 100 based on healthy Buy/Sell ratios.
function calculateOrganicScore(dexPairData) {
    if (!dexPairData || !dexPairData.txns || !dexPairData.txns.h1) {
        return 85.0; // Fallback
    }

    const { buys, sells } = dexPairData.txns.h1;
    const totalTxns = buys + sells;

    if (totalTxns < 10) return 50.0; // Dead/Low activity pool

    // Ideal organic ratio is roughly 1:1 to 60:40. Extremely high buy/sell ratios (like 99% buys) usually indicate botting/wash trading.
    const buyRatio = buys / totalTxns;

    let score = 99.0;

    // Penalize heavily skewed ratios (wash trading)
    if (buyRatio > 0.80 || buyRatio < 0.20) {
        score -= 25.0;
    } else if (buyRatio > 0.65 || buyRatio < 0.35) {
        score -= 10.0;
    }

    // Reward high transaction counts (more unique organic participation)
    if (totalTxns > 500) score += 5.0;
    else if (totalTxns < 50) score -= 15.0;

    // Cap at 99.9 and floor at 10.0
    return Math.min(Math.max(score, 10.0), 99.9);
}

// Fetch market data from DexScreener using base token address (mint_x/mint_y)
async function getDexScreenerData(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            // Sort by liquidity to get the most representative pair for the token
            const sortedPairs = response.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
            const pair = sortedPairs[0];

            const organicScore = calculateOrganicScore(pair);

            return {
                priceChange5m: pair.priceChange?.m5 || 0,
                mcap: pair.fdv || pair.marketCap || 0,
                organicScore: organicScore
            };
        }
    } catch (error) {
        console.error(`Error fetching DexScreener data for token ${tokenAddress}:`, error.message);
    }
    // Fallback if not found on DexScreener
    return {
        priceChange5m: 0,
        mcap: 0,
        organicScore: 85.0
    };
}

module.exports = {
    fetchMeteoraPools,
    getDexScreenerData
};
