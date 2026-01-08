/**
 * On-Demand Option Chain Fetcher (Browser Version)
 * Fetches options for any ticker automatically when user clicks it
 */

class OptionFetcher {
    constructor(credentials) {
        this.credentials = credentials;
    }

    /**
     * Fetch option chain for a ticker
     * @param {number} tickerId - Webull ticker ID
     * @param {string} symbol - Stock symbol (for logging)
     * @returns {Promise<Object>} Processed option chain
     */
    async fetchOptionChain(tickerId, symbol) {
        console.log(`📊 Fetching options for ${symbol} (ID: ${tickerId})...`);
        
        const url = 'https://quotes-gw.webullfintech.com/api/quote/option/strategy/list';
        
        // Build headers
        const headers = {
            'accept': '*/*',
            'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'access_token': this.credentials.web_lt,
            'app': 'global',
            'app-group': 'broker',
            'appid': 'wb_web_app',
            'content-type': 'application/json',
            'device-type': 'Web',
            'did': this.credentials.web_did,
            'hl': 'en',
            'os': 'web',
            'osv': 'i9zh',
            'ph': 'Windows Chrome',
            'platform': 'web',
            'reqid': this.generateReqId(),
            't_time': Date.now().toString(),
            'tz': 'America/New_York',
            'ver': '6.2.0',
            'x-sv': 'xodp2vg9'
        };

        const body = {
            tickerId: parseInt(tickerId),
            count: -1  // Get all strikes
        };

        // Generate signature
        const signature = this.generateSignature({ url, headers, body });
        headers['x-s'] = signature;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            
            if (data.success === false) {
                console.error(`❌ API error: ${data.msg || 'Unknown error'}`);
                throw new Error(data.msg || 'API returned error');
            }
            
            // Process the option chain
            const options = this.processOptionChain(data);
            return options;
        } catch (error) {
            console.error('❌ Fetch error:', error);
            throw error;
        }
    }

    /**
     * Process raw API response into standardized format
     */
    processOptionChain(data) {
        const options = {};
        
        if (data.expireDateList && Array.isArray(data.expireDateList)) {
            data.expireDateList.forEach((expiryGroup) => {
                const expiry = expiryGroup.from?.date;
                
                if (!expiry) return;
                
                if (!options[expiry]) {
                    options[expiry] = [];
                }
                
                // Process calls
                if (expiryGroup.call && Array.isArray(expiryGroup.call)) {
                    expiryGroup.call.forEach(opt => {
                        options[expiry].push({
                            type: 'call',
                            strike: opt.strikePrice,
                            bid: opt.bidList?.[0]?.price || 0,
                            ask: opt.askList?.[0]?.price || 0,
                            last: opt.latestPriceVo?.price || 0,
                            volume: opt.latestPriceVo?.volume || 0,
                            openInterest: opt.openInterest || 0,
                            delta: opt.delta || 0,
                            gamma: opt.gamma || 0,
                            theta: opt.theta || 0,
                            vega: opt.vega || 0,
                            iv: opt.impliedVolatility || 0,
                            optionId: opt.tickerId,
                            symbol: opt.symbol,
                            expiry: expiry
                        });
                    });
                }
                
                // Process puts
                if (expiryGroup.put && Array.isArray(expiryGroup.put)) {
                    expiryGroup.put.forEach(opt => {
                        options[expiry].push({
                            type: 'put',
                            strike: opt.strikePrice,
                            bid: opt.bidList?.[0]?.price || 0,
                            ask: opt.askList?.[0]?.price || 0,
                            last: opt.latestPriceVo?.price || 0,
                            volume: opt.latestPriceVo?.volume || 0,
                            openInterest: opt.openInterest || 0,
                            delta: opt.delta || 0,
                            gamma: opt.gamma || 0,
                            theta: opt.theta || 0,
                            vega: opt.vega || 0,
                            iv: opt.impliedVolatility || 0,
                            optionId: opt.tickerId,
                            symbol: opt.symbol,
                            expiry: expiry
                        });
                    });
                }
            });
        }
        
        return options;
    }

    /**
     * Generate request ID (random UUID-like string)
     */
    generateReqId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Generate signature for Webull API
     */
    generateSignature(params) {
        // Simplified signature - in production, use server-side signing
        const timestamp = Date.now();
        return `${timestamp}`;
    }
}

// Make available globally
if (typeof window !== 'undefined') {
    window.OptionFetcher = OptionFetcher;
}

