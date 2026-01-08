// Browser environment - use fetch API instead of axios
// Axios-like wrapper using fetch
const axios = {
    async request(config) {
        const url = new URL(config.url);
        if (config.params) {
            Object.keys(config.params).forEach(key => 
                url.searchParams.append(key, config.params[key])
            );
        }
        
        const response = await fetch(url.toString(), {
            method: config.method || 'GET',
            headers: config.headers,
            body: config.data ? JSON.stringify(config.data) : undefined
        });
        
        const data = await response.json();
        
        return {
            status: response.status,
            data: data,
            headers: response.headers
        };
    }
};

// Polygon.io REST client (read-only: quotes + candles)
// This is wired as a drop-in market data source for the existing app.
class PolygonAPI {
    constructor() {
        // Load API key from localStorage (user must input their own key)
        this.apiKey = this.loadApiKey();
        this.baseUrl = 'https://api.polygon.io';
    }

    loadApiKey() {
        // Check localStorage for user's personal API key
        const savedKey = localStorage.getItem('POLYGON_API_KEY');
        if (savedKey && savedKey.trim()) {
            console.log('✅ Loaded Polygon API key from localStorage');
            return savedKey.trim();
        }
        
        // No key found - user needs to add one in Settings
        console.warn('⚠️ No Polygon API key found. Please add your key in Settings.');
        return null;
    }

    saveApiKey(key) {
        if (!key || !key.trim()) {
            throw new Error('API key cannot be empty');
        }
        const trimmedKey = key.trim();
        localStorage.setItem('POLYGON_API_KEY', trimmedKey);
        this.apiKey = trimmedKey;
        console.log('✅ Polygon API key saved successfully');
        return true;
    }

    hasApiKey() {
        return this.apiKey && this.apiKey.trim().length > 0;
    }

    log(msg, type = 'info') {
        // Logging disabled for performance
        return;
    }

    requireKey() {
        if (!this.apiKey) {
            const msg = '⚠️ Polygon API key required. Please add your key in Settings (⚙️ icon).';
            this.log(msg, 'error');
            throw new Error(msg);
        }
    }

    async request(path, params = {}) {
        this.requireKey();

        const url = `${this.baseUrl}${path}`;
        const config = {
            method: 'GET',
            url,
            params: {
                ...params,
                apiKey: this.apiKey,
            },
            validateStatus: function (status) {
                // Accept any status to prevent axios from throwing on 404
                return true;
            }
        };

        try {
            this.log(`[REQUEST][Polygon] GET ${url}`, 'api');
            const res = await axios(config);
            
            // Check status and throw for non-2xx (but silently, no axios error)
            if (res.status >= 400) {
                const errMsg = `HTTP ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}`;
                throw new Error(errMsg);
            }
            
            this.log(`[RESPONSE][Polygon] ${res.status} - ${JSON.stringify(res.data).substring(0, 200)}`, 'api');
            return res.data;
        } catch (e) {
            const errMsg = e.response
                ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).substring(0, 200)}`
                : e.message;
            this.log(`[Polygon ERROR] ${path} - ${errMsg}`, 'error');
            throw new Error(errMsg);
        }
    }

    /**
     * Get current quote snapshot for a symbol.
     * Returns a Webull-like shape: { close, high, low, open, bid, ask, last }.
     */
    async getQuote(symbol) {
        if (!symbol) throw new Error('Polygon getQuote requires symbol');
        const clean = String(symbol).toUpperCase().trim();

        // Use snapshot endpoint for day OHLC + last trade/quote.
        const data = await this.request(`/v2/snapshot/locale/us/markets/stocks/tickers/${clean}`);
        const t = data && data.ticker ? data.ticker : null;

        const day = t && t.day ? t.day : {};
        const lt = t && t.lastTrade ? t.lastTrade : {};
        const lq = t && t.lastQuote ? t.lastQuote : {};

        const dayClose = day.c != null ? Number(day.c) : null;
        const lastTrade = lt.p != null ? Number(lt.p) : null;

        // Prefer last trade for live candles; fall back to day's close when needed.
        const close = (lastTrade != null && isFinite(lastTrade))
            ? lastTrade
            : (dayClose != null && isFinite(dayClose) ? dayClose : null);

        const open = day.o != null ? Number(day.o) : close;
        const high = day.h != null ? Number(day.h) : close;
        const low  = day.l != null ? Number(day.l) : close;

        const bid = lq.p != null ? Number(lq.p) : (lq.bid != null ? Number(lq.bid) : null);
        const ask = lq.ask != null ? Number(lq.ask) : null;

        return {
            close,
            open,
            high,
            low,
            bid,
            ask,
            last: close,
            status: 'A', // treat as active; app uses time-based open/close separately
        };
    }

    /**
     * Get recent intraday candles as Lightweight Charts-compatible objects.
     * Returns { data: [{ time, open, high, low, close }]} to match existing loader expectations.
     *
     * Implementation detail:
     * - For 1-minute timeframe, we explicitly fetch **yesterday and today** (EST)
     *   so that PDH/PDL always sit on visible previous-day candles instead of
     *   floating over empty space.
     */
    async getHistoricalBars(symbol, timeframe = 'm1', count = 390) {
        if (!symbol) throw new Error('Polygon getHistoricalBars requires symbol');
        const clean = String(symbol).toUpperCase().trim();

        // Map timeframe -> Polygon range
        let tf = { mult: 1, timespan: 'minute' };
        let daysToFetch = 2; // Default: yesterday + today for intraday
        
        switch(timeframe) {
            case 'm1':
                tf = { mult: 1, timespan: 'minute' };
                daysToFetch = 2;
                break;
            case 'm5':
                tf = { mult: 5, timespan: 'minute' };
                daysToFetch = 5;
                break;
            case 'm15':
                tf = { mult: 15, timespan: 'minute' };
                daysToFetch = 10;
                break;
            case 'm30':
                tf = { mult: 30, timespan: 'minute' };
                daysToFetch = 15;
                break;
            case 'h1':
                tf = { mult: 1, timespan: 'hour' };
                daysToFetch = 30;
                break;
            case 'd1':
            case '1d':
                tf = { mult: 1, timespan: 'day' };
                daysToFetch = Math.max(count, 100);
                break;
            default:
                tf = { mult: 1, timespan: 'minute' };
                daysToFetch = 2;
        }

        // Work in EST so dates match US market sessions.
        const nowEst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        
        // For intraday charts, fetch more days to account for weekends
        // (e.g., if it's Monday morning, we need to go back to Friday)
        const daysToFetchAdjusted = timeframe === 'm1' || timeframe === 'm5' ? daysToFetch + 3 : daysToFetch;
        const startDate = new Date(nowEst.getTime() - daysToFetchAdjusted * 24 * 60 * 60 * 1000);

        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        const fromStr = fmt(startDate);
        const toStr = fmt(nowEst);

        // Fetch historical data for the date range
        const data = await this.request(
            `/v2/aggs/ticker/${clean}/range/${tf.mult}/${tf.timespan}/${fromStr}/${toStr}`,
            { limit: 50000 } // High limit to get all data in range
        );

        const results = Array.isArray(data && data.results) ? data.results : [];
        let candles = results
            .map(r => {
                const t = typeof r.t === 'number' ? r.t : null; // ms
                const o = Number(r.o);
                const h = Number(r.h);
                const l = Number(r.l);
                const c = Number(r.c);
                if (!t || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) return null;
                return {
                    time: Math.floor(t / 1000),
                    open: o,
                    high: h,
                    low: l,
                    close: c,
                };
            })
            .filter(Boolean);

        // Ensure chronological order and trim to requested count from the end.
        candles.sort((a, b) => a.time - b.time);
        if (candles.length > count) {
            candles = candles.slice(-count);
        }
        
        return { data: candles };
    }

    /**
     * Get previous regular session OHLC (Polygon "prev" endpoint).
     * Returns { high, low, open, close } or null if unavailable.
     */
    async getPreviousDayOhlc(symbol) {
        if (!symbol) throw new Error('Polygon getPreviousDayOhlc requires symbol');
        const clean = String(symbol).toUpperCase().trim();

        const data = await this.request(`/v2/aggs/ticker/${clean}/prev`);
        const results = Array.isArray(data && data.results) ? data.results : [];
        if (!results.length) return null;

        const r = results[0];
        const open = Number(r.o);
        const high = Number(r.h);
        const low  = Number(r.l);
        const close = Number(r.c);
        if (![open, high, low, close].every(v => isFinite(v))) return null;

        return { open, high, low, close };
    }

    /**
     * Get an options contract snapshot for a given underlying/strike/expiry guess.
     * This uses Polygon's v3 snapshot for options and tries to pick the contract
     * whose strike & expiration are closest to the requested values.
     *
     * Returns a lightweight object:
     * { price, strike, expiration, symbol, raw }
     */
    async getOptionForStrike(underlyingSymbol, strike, daysToExpiry, optionType = 'call') {
        if (!underlyingSymbol) throw new Error('Polygon getOptionForStrike requires underlyingSymbol');
        if (!strike) throw new Error('Polygon getOptionForStrike requires strike');

        const clean = String(underlyingSymbol).toUpperCase().trim();
        const targetStrike = Number(strike);
        const typeCode = optionType === 'put' ? 'put' : 'call';

        // Estimate target expiration date in EST from daysToExpiry
        const nowEst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const targetExpiry = new Date(nowEst.getTime() + (Number(daysToExpiry) || 0) * 24 * 60 * 60 * 1000);

        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        // Fetch all option snapshots for this underlying with high limit to get all strikes.
        // Default limit is often very low (10-50), we need to request more.
        const data = await this.request(`/v3/snapshot/options/${clean}`, { 
            limit: 250,  // Request up to 250 contracts
            order: 'asc'
        });
        const results = Array.isArray(data && data.results) ? data.results : [];
        if (!results.length) {
            this.log(`No Polygon option snapshots for ${clean}`, 'warn');
            return null;
        }
        
        this.log(`✓ Polygon returned ${results.length} option contracts for ${clean}`, 'success');
        
        // Log first contract structure for debugging
        if (results[0]) {
            this.log(`Sample contract structure: ${JSON.stringify(results[0]).substring(0, 500)}`, 'debug');
        }

        const msPerDay = 24 * 60 * 60 * 1000;
        let best = null;
        let bestScore = Infinity;
        
        // Collect available strikes for this type
        const availableStrikes = [];

        // First pass: Try to find EXACT strike match (within $2.50)
        for (const r of results) {
            if (!r) continue;
            const details = r.details || r;
            const contractType = (details.contract_type || details.type || '').toString().toLowerCase();
            if (contractType && contractType !== typeCode) continue;

            const s = Number(details.strike_price || details.strike || NaN);
            if (!isFinite(s)) continue;
            
            availableStrikes.push(s);

            const expStr = details.expiration_date || details.expiry || null;
            if (!expStr) continue;
            const expDate = new Date(expStr + 'T00:00:00Z');
            if (isNaN(expDate.getTime())) continue;

            const strikeDiff = Math.abs(s - targetStrike);
            
            // Only consider options within $2.50 of target strike
            if (strikeDiff > 2.5) continue;
            
            const dayDiff = Math.abs((expDate.getTime() - targetExpiry.getTime()) / msPerDay);

            // Heavily weighted score: strike match is 1000x more important than expiry
            const score = strikeDiff * 1000 + dayDiff;
            if (score < bestScore) {
                bestScore = score;
                best = { snapshot: r, details, strike: s, expiration: expStr };
            }
        }

        if (!best) {
            const uniqueStrikes = [...new Set(availableStrikes)].sort((a, b) => a - b);
            this.log(`❌ No ${typeCode} option found for strike $${targetStrike}. Available ${typeCode} strikes: ${uniqueStrikes.slice(0, 20).join(', ')}`, 'error');
            return null;
        }

        this.log(`✓ Found option: ${best.details.ticker || 'unknown'} strike ${best.strike} exp ${best.expiration}`, 'success');

        // Log full snapshot structure for debugging
        this.log(`Snapshot keys: ${Object.keys(best.snapshot).join(', ')}`, 'debug');
        
        const day = best.snapshot.day || {};
        const lastQuote = best.snapshot.last_quote || best.snapshot.lastQuote || {};
        
        // Try multiple possible locations for Greeks
        const greeks = best.snapshot.greeks || 
                      best.snapshot.implied_volatility || 
                      best.details.greeks ||
                      best.snapshot.underlying_asset?.greeks ||
                      {};
        
        if (greeks && Object.keys(greeks).length > 0) {
            this.log(`✓ Greeks found: ${JSON.stringify(greeks)}`, 'success');
        } else {
            this.log(`⚠️ Greeks object empty or missing. Full snapshot: ${JSON.stringify(best.snapshot).substring(0, 800)}`, 'warn');
        }

        let price = null;
        const close = Number(day.close ?? day.c ?? NaN);
        const last = Number(lastQuote.last ?? lastQuote.price ?? lastQuote.p ?? NaN);
        const bid = Number(lastQuote.bid ?? lastQuote.P ?? NaN);
        const ask = Number(lastQuote.ask ?? lastQuote.p ?? NaN);
        const mid = (isFinite(bid) && isFinite(ask)) ? (bid + ask) / 2 : NaN;

        if (isFinite(last)) price = last;
        else if (isFinite(close)) price = close;
        else if (isFinite(mid)) price = mid;
        else if (isFinite(bid)) price = bid;
        
        if (!isFinite(price)) {
            this.log(`⚠️ No valid price for option. Day: ${JSON.stringify(day).substring(0, 80)}, Quote: ${JSON.stringify(lastQuote).substring(0, 80)}`, 'warn');
            this.log(`Full snapshot: ${JSON.stringify(best.snapshot).substring(0, 300)}`, 'warn');
            return null;
        }

        const symbol = best.details.ticker || best.details.symbol || null;
        const delta = Number(greeks.delta ?? NaN);
        
        if (!isFinite(delta) && Object.keys(greeks).length === 0) {
            this.log(`⚠️ No Greeks data in Polygon response. Your API key may not have Options Greeks access.`, 'warn');
        }
        
        this.log(`✓ Option price: $${price.toFixed(2)}, delta: ${isFinite(delta) ? delta.toFixed(4) : 'N/A'}`, 'success');

        return {
            price,
            strike: best.strike,
            expiration: best.expiration,
            symbol,
            delta: isFinite(delta) ? delta : null,
            raw: best.snapshot,
        };
    }

    /**
     * Get all available strikes for a given underlying symbol and option type.
     * Returns sorted array of unique strike prices that are available for the given expiry window.
     * 
     * @param {string} underlyingSymbol - Stock symbol (e.g., 'AAPL')
     * @param {number} daysToExpiry - Target days to expiration
     * @param {string} optionType - 'call' or 'put'
     * @returns {Promise<number[]>} - Sorted array of available strike prices
     */
    async getAvailableStrikes(underlyingSymbol, daysToExpiry = 7, optionType = 'call') {
        if (!underlyingSymbol) throw new Error('Polygon getAvailableStrikes requires underlyingSymbol');

        const clean = String(underlyingSymbol).toUpperCase().trim();
        const typeCode = optionType === 'put' ? 'put' : 'call';

        // Estimate target expiration date in EST
        const nowEst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const targetExpiry = new Date(nowEst.getTime() + (Number(daysToExpiry) || 0) * 24 * 60 * 60 * 1000);

        // Fetch all option snapshots for this underlying
        const data = await this.request(`/v3/snapshot/options/${clean}`, { 
            limit: 250,
            order: 'asc'
        });
        const results = Array.isArray(data && data.results) ? data.results : [];
        if (!results.length) {
            this.log(`No Polygon option snapshots for ${clean}`, 'warn');
            return [];
        }
        
        this.log(`✓ Polygon returned ${results.length} option contracts for ${clean}`, 'info');

        const msPerDay = 24 * 60 * 60 * 1000;
        const strikes = new Set();
        const expiryWindow = 14; // Look for options within 14 days of target expiry

        for (const r of results) {
            if (!r) continue;
            const details = r.details || r;
            const contractType = (details.contract_type || details.type || '').toString().toLowerCase();
            if (contractType && contractType !== typeCode) continue;

            const s = Number(details.strike_price || details.strike || NaN);
            if (!isFinite(s)) continue;

            const expStr = details.expiration_date || details.expiry || null;
            if (!expStr) {
                strikes.add(s); // Include strikes even without expiry
                continue;
            }

            const expDate = new Date(expStr + 'T00:00:00Z');
            if (isNaN(expDate.getTime())) {
                strikes.add(s);
                continue;
            }

            // Filter by expiry window - include strikes within reasonable date range
            const dayDiff = Math.abs((expDate.getTime() - targetExpiry.getTime()) / msPerDay);
            if (dayDiff <= expiryWindow) {
                strikes.add(s);
            }
        }

        const sortedStrikes = Array.from(strikes).sort((a, b) => a - b);
        this.log(`✓ Found ${sortedStrikes.length} unique ${typeCode} strikes for ${clean}`, 'info');
        
        return sortedStrikes;
    }
}

// WebSocket client for real-time streaming trade data from Polygon
class PolygonWebSocket {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.polygonApi = null; // Reference to PolygonAPI instance for key management
        this.ws = null;
        this.subscriptions = new Set();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000; // Start with 1 second
        this.isConnected = false;
        this.isConnecting = false;
        this.shouldReconnect = true;
        
        // Callbacks
        this.onTrade = null;        // (symbol, price, tradeData) => {}
        this.onMinuteBar = null;    // (symbol, candle) => {}
        this.onSecondBar = null;    // (symbol, candle) => {}
        this.onConnected = null;    // () => {}
        this.onDisconnected = null; // (reason) => {}
        this.onError = null;        // (error) => {}
        
        // Track last price to detect changes
        this.lastPrices = new Map();
        
        // Latency tracking
        this.lastTradeTime = null;
        this.latencyMs = 0;
    }

    connect() {
        // Check if API key exists before attempting connection
        if (!this.apiKey || !this.apiKey.trim()) {
            console.error('❌ Cannot connect to Polygon: No API key configured');
            console.error('⚠️ Please add your Polygon API key in Settings (⚙️ icon)');
            if (this.onError) {
                this.onError(new Error('No Polygon API key configured. Add your key in Settings.'));
            }
            return;
        }

        if (this.isConnecting || this.isConnected) {
            console.log('📡 WebSocket already connected or connecting');
            return;
        }

        this.isConnecting = true;
        this.shouldReconnect = true;

        try {
            // Polygon WebSocket endpoint for stocks
            const wsUrl = 'wss://socket.polygon.io/stocks';
            
            console.log('🔌 Connecting to Polygon WebSocket...');
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('✅ WebSocket connected to Polygon');
                this.isConnected = true;
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                this.reconnectDelay = 1000;

                // Authenticate
                this.send({ action: 'auth', params: this.apiKey });

                if (this.onConnected) {
                    this.onConnected();
                }
            };

            this.ws.onmessage = (event) => {
                try {
                    const messages = JSON.parse(event.data);
                    
                    // Polygon sends arrays of messages
                    if (!Array.isArray(messages)) return;

                    for (const msg of messages) {
                        this.handleMessage(msg);
                    }
                } catch (e) {
                    console.error('❌ Error parsing WebSocket message:', e);
                }
            };

            this.ws.onerror = (error) => {
                console.error('❌ WebSocket error:', error);
                if (this.onError) {
                    this.onError(error);
                }
            };

            this.ws.onclose = (event) => {
                console.log(`🔌 WebSocket disconnected: ${event.code} - ${event.reason}`);
                this.isConnected = false;
                this.isConnecting = false;

                if (this.onDisconnected) {
                    this.onDisconnected(event.reason || 'Connection closed');
                }

                // Attempt reconnection with exponential backoff
                if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
                    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                    
                    setTimeout(() => {
                        this.connect();
                    }, delay);
                } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    console.error('❌ Max reconnection attempts reached. Please refresh the app.');
                }
            };

        } catch (e) {
            console.error('❌ Failed to create WebSocket:', e);
            this.isConnecting = false;
            if (this.onError) {
                this.onError(e);
            }
        }
    }

    handleMessage(msg) {
        if (!msg || !msg.ev) return;

        // Track message types (for debugging if needed)
        if (!this._messageTypeCount) {
            this._messageTypeCount = {};
            this._lastMessageTypeLog = Date.now();
        }
        this._messageTypeCount[msg.ev] = (this._messageTypeCount[msg.ev] || 0) + 1;

        // Handle different message types
        switch (msg.ev) {
            case 'status':
                this.handleStatus(msg);
                break;
            case 'T':  // Trade message
                this.handleTrade(msg);
                break;
            case 'A':  // Aggregate (second bar)
                this.handleAggregate(msg);
                break;
            case 'AM': // Aggregate minute
                this.handleMinuteAggregate(msg);
                break;
            default:
                // Unknown message type - log it
                console.warn('❓ Unknown message type:', msg.ev, msg);
                break;
        }
    }

    handleStatus(msg) {
        console.log(`📡 Polygon Status: ${msg.status} - ${msg.message}`);
        
        // After successful auth, resubscribe to any symbols we were watching
        if (msg.status === 'auth_success' && this.subscriptions.size > 0) {
            console.log(`🔄 Resubscribing to ${this.subscriptions.size} symbols...`);
            this.subscriptions.forEach(symbol => {
                this.send({ action: 'subscribe', params: `AM.${symbol},A.${symbol},T.${symbol}` });
            });
        }
    }

    handleTrade(msg) {
        // Trade message format:
        // { ev: 'T', sym: 'AAPL', p: 150.25, s: 100, t: 1234567890000, ... }
        
        // 🔍 DEBUG: Log full message to see ALL fields Polygon sends
        if (!this._debugLoggedTrade) {
            console.log('🔍 FULL POLYGON TRADE MESSAGE (first trade):', JSON.stringify(msg, null, 2));
            this._debugLoggedTrade = true;
        }
        
        const symbol = msg.sym;
        const price = msg.p;
        const size = msg.s || 0;
        const timestamp = msg.t; // milliseconds since epoch
        const conditions = msg.c || []; // Trade conditions array
        const exchange = msg.x || null; // Exchange ID

        if (!symbol || !price) return;

        // 🚫 FILTER BAD PRINTS: Exclude trades with non-regular conditions
        // These trades should NOT be included in OHLC candles (this is what TradingView does!)
        const excludedConditions = [
            10, // Intermarket Sweep
            12, // Form T (late report, after-hours)
            14, // Out of Sequence
            15, // Cancelled
            16, // Error
            21, // Next Day
            37, // Average Price Trade
            38, // Odd Lot Trade (< 100 shares)
            41, // Derivatively priced
            52, // Derivative Priced
            53, // Re-opening Prints
            54, // Seller
            55, // Sold Last
            56, // Sold Last and Stopped Stock
            57, // Sold Out
            58, // Sold Out of Sequence
        ];

        // Check if trade has any excluded conditions
        const hasExcludedCondition = conditions.some(c => excludedConditions.includes(c));
        
        if (hasExcludedCondition) {
            // 🎯 THIS IS THE KEY! TradingView filters these OUT before building candles
            // That's why they don't show "rejected trades" - they never see them!
            // Silently skip (no log spam)
            return;
        }

        // Calculate latency (time from trade to now)
        const now = Date.now();
        const latency = now - timestamp;
        this.latencyMs = latency;
        this.lastTradeTime = now;

        // Track price changes
        const lastPrice = this.lastPrices.get(symbol);
        const priceChanged = !lastPrice || Math.abs(price - lastPrice) > 0.001;
        
        if (priceChanged) {
            this.lastPrices.set(symbol, price);
            
            // Log significant updates (throttled to avoid spam)
            if (!this._lastLogTime || now - this._lastLogTime > 5000) {
                console.log(`💹 ${symbol}: $${price.toFixed(2)} | Size: ${size} | Latency: ${latency}ms`);
                this._lastLogTime = now;
            }

            // Conditions are now properly filtered - no need to log them

            // Call the trade callback
            if (this.onTrade) {
                this.onTrade(symbol, price, {
                    size,
                    timestamp,
                    latency,
                    conditions,
                    exchange,
                    raw: msg
                });
            }
        }
    }

    handleAggregate(msg) {
        // Second-level aggregate bar format:
        // { ev: 'A', sym: 'AAPL', o: 150.20, h: 150.30, l: 150.15, c: 150.25, v: 1000, s: start_ts, e: end_ts }
        
        const symbol = msg.sym;
        if (!symbol) return;

        const candle = {
            time: Math.floor(msg.s / 1000), // Convert ms to seconds for chart
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v
        };

        // Validate candle data
        if (!isFinite(candle.open) || !isFinite(candle.high) || 
            !isFinite(candle.low) || !isFinite(candle.close)) {
            return;
        }

        // Call the second bar callback (used for validation, not primary updates)
        if (this.onSecondBar) {
            this.onSecondBar(symbol, candle);
        }
    }

    handleMinuteAggregate(msg) {
        // Minute-level aggregate bar format (pre-built by Polygon, market-time aligned):
        // { ev: 'AM', sym: 'AAPL', o: 150.20, h: 150.30, l: 150.15, c: 150.25, 
        //   v: 10000, av: 5000000, s: start_ts, e: end_ts }
        
        const symbol = msg.sym;
        if (!symbol) return;

        // Use the START timestamp of the minute bar (s) - this is already aligned to market time
        // Polygon aligns these to exact minute boundaries in EST
        const candle = {
            time: Math.floor(msg.s / 1000), // Convert ms to seconds for chart
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v,
            vwap: msg.vw || null, // Volume-weighted average price
            trades: msg.n || 0,    // Number of trades
            raw: msg
        };

        // Validate candle data
        if (!isFinite(candle.open) || !isFinite(candle.high) || 
            !isFinite(candle.low) || !isFinite(candle.close)) {
            console.warn(`⚠️ Invalid minute bar data for ${symbol}:`, msg);
            return;
        }

        const now = Date.now();
        const latency = now - msg.e; // Latency from bar end time
        
        // Log minute bars (throttled)
        if (!this._lastMinuteLogTime || now - this._lastMinuteLogTime > 10000) {
            console.log(`📊 ${symbol} Minute Bar: O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)} | Latency: ${latency}ms`);
            this._lastMinuteLogTime = now;
        }

        // Update last price
        this.lastPrices.set(symbol, candle.close);

        // Call the minute bar callback
        if (this.onMinuteBar) {
            this.onMinuteBar(symbol, candle);
        }
    }

    subscribe(symbol) {
        if (!symbol) return;
        
        const cleanSymbol = String(symbol).toUpperCase().trim();
        
        // Add to subscriptions set
        this.subscriptions.add(cleanSymbol);

        // If connected, subscribe immediately
        if (this.isConnected) {
            const subscriptionParams = `AM.${cleanSymbol},A.${cleanSymbol},T.${cleanSymbol}`;
            console.log(`📊 Subscribing to real-time data for ${cleanSymbol}`);
            console.log(`   └─ Subscription: "${subscriptionParams}"`);
            console.log(`   └─ AM = Minute bars (completed candles)`);
            console.log(`   └─ A = Second bars (historical validation)`);
            console.log(`   └─ T = Live trades (instant current updates)`);
            // HYBRID APPROACH (like TradingView):
            // - AM bars for completed minutes
            // - T trades for instant current-second updates
            // - A bars to validate/correct past seconds
            this.send({ action: 'subscribe', params: subscriptionParams });
        } else {
            console.log(`📊 Queued subscription for ${cleanSymbol} (will subscribe when connected)`);
            // Will auto-subscribe when connection is established
            if (!this.isConnecting) {
                this.connect();
            }
        }
    }

    unsubscribe(symbol) {
        if (!symbol) return;
        
        const cleanSymbol = String(symbol).toUpperCase().trim();
        
        // Remove from subscriptions
        this.subscriptions.delete(cleanSymbol);

        // If connected, unsubscribe
        if (this.isConnected) {
            console.log(`📊 Unsubscribing from ${cleanSymbol}`);
            this.send({ action: 'unsubscribe', params: `AM.${cleanSymbol},A.${cleanSymbol},T.${cleanSymbol}` });
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        console.log('🔌 Disconnecting WebSocket...');
        this.shouldReconnect = false;
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.isConnected = false;
        this.isConnecting = false;
        this.subscriptions.clear();
    }

    getStatus() {
        return {
            connected: this.isConnected,
            connecting: this.isConnecting,
            subscriptions: Array.from(this.subscriptions),
            latency: this.latencyMs,
            lastTradeTime: this.lastTradeTime
        };
    }
}

// Export both REST API and WebSocket
const polygonApi = new PolygonAPI();
const polygonWebSocket = new PolygonWebSocket(polygonApi.apiKey);
polygonWebSocket.polygonApi = polygonApi; // Link for key updates

// Export for browser
if (typeof window !== 'undefined') {
    window.polygonApi = polygonApi;
    window.polygonWebSocket = polygonWebSocket;
    window.PolygonAPI = PolygonAPI;
}


