/**
 * WebullCandlesPoller - Real-time candle updates using Webull's API (Browser Version)
 * 
 * Polls Webull's /kdata/latest endpoint for real-time candle data.
 * Provides callbacks similar to Polygon WebSocket for seamless integration.
 */
class WebullCandlesPoller {
    constructor() {
        this.webullApi = null; // Will be set by setAPI()
        this.pollInterval = null;
        this.isRunning = false;
        this.currentTickerId = null;
        this.currentSymbol = null;
        this.lastCandleTime = null;
        this.historicalCandles = [];
        
        // Polling configuration
        this.POLL_INTERVAL_MS = 250; // Poll every 250ms (4x per second) for ultra-smooth TradingView-like updates
        this.INITIAL_HISTORY_COUNT = 800; // Number of historical candles to load
        
        // Callbacks (set by app.js)
        this.onMinuteBar = null;       // (symbol, candle) => void - Called when a new/updated candle arrives
        this.onConnected = null;        // () => void - Called when poller starts
        this.onDisconnected = null;     // (reason) => void - Called when poller stops
        this.onError = null;            // (error) => void - Called on errors
        this.onInitialLoad = null;      // (candles) => void - Called with initial historical data
        
        // Error tracking
        this.consecutiveErrors = 0;
        this.MAX_CONSECUTIVE_ERRORS = 5;
    }
    
    /**
     * Set the Webull API instance
     * @param {Object} apiInstance - Instance of WebullAPI class
     */
    setAPI(apiInstance) {
        this.webullApi = apiInstance;
        console.log('✅ Webull API set on candles poller');
    }
    
    /**
     * Start polling for real-time candles
     * @param {string} tickerId - Webull ticker ID (e.g., "913255598")
     * @param {string} symbol - Symbol for display (e.g., "TSLA")
     * @param {boolean} loadHistory - Whether to load historical candles first (default: true)
     */
    async start(tickerId, symbol, loadHistory = true) {
        if (this.isRunning) {
            console.log('⚠️ Webull candles poller already running, stopping previous instance...');
            this.stop();
        }
        
        this.currentTickerId = tickerId;
        this.currentSymbol = symbol;
        this.lastCandleTime = null;
        this.consecutiveErrors = 0;
        
        console.log(`🚀 Starting Webull candles poller for ${symbol} (ID: ${tickerId})...`);
        
        // Load historical candles first
        if (loadHistory) {
            if (!this.webullApi) {
                console.error('❌ Webull API instance not set. Call setAPI() first.');
                return;
            }
            
            try {
                const historyResult = await this.webullApi.getHistoricalBars(tickerId, 'm1', this.INITIAL_HISTORY_COUNT);
                
                if (historyResult && historyResult.data && historyResult.data.length > 0) {
                    this.historicalCandles = historyResult.data;
                    console.log(`✅ Loaded ${this.historicalCandles.length} historical candles for ${symbol}`);
                    
                    // Track the last candle time
                    const lastCandle = this.historicalCandles[this.historicalCandles.length - 1];
                    this.lastCandleTime = lastCandle.time;
                    
                    // Call initial load callback
                    if (this.onInitialLoad) {
                        this.onInitialLoad(this.historicalCandles);
                    }
                } else {
                    console.error(`❌ Failed to load historical candles for ${symbol} - no data in response`);
                    if (this.onError) {
                        this.onError(new Error('Failed to load historical candles'));
                    }
                    return false;
                }
            } catch (error) {
                console.error('❌ Error loading historical candles:', error.message);
                if (this.onError) {
                    this.onError(error);
                }
                return false;
            }
        }
        
        // Start polling
        this.isRunning = true;
        if (this.onConnected) {
            this.onConnected();
        }
        
        // Initial poll
        this.poll();
        
        // Set up polling interval
        this.pollInterval = setInterval(() => {
            this.poll();
        }, this.POLL_INTERVAL_MS);
        
        console.log(`✅ Webull candles poller started (polling every ${this.POLL_INTERVAL_MS}ms)`);
        return true;
    }
    
    /**
     * Stop polling
     */
    stop(reason = 'Stopped by user') {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        
        this.isRunning = false;
        this.currentTickerId = null;
        this.currentSymbol = null;
        
        console.log(`⏹️ Webull candles poller stopped: ${reason}`);
        
        if (this.onDisconnected) {
            this.onDisconnected(reason);
        }
    }
    
    /**
     * Poll for latest candle data
     */
    async poll() {
        if (!this.isRunning || !this.currentTickerId) {
            return;
        }
        
        try {
            // Fetch latest candle
            const result = await this.webullApi.getLatestCandle(this.currentTickerId, 'm1');
            
            if (!result || !result.data || result.data.length === 0) {
                return; // No new data
            }
            
            const latestCandle = result.data[0];
            
            // Check if this is a new/updated candle
            if (!this.lastCandleTime || latestCandle.time !== this.lastCandleTime) {
                this.lastCandleTime = latestCandle.time;
                
                // Emit candle update
                if (this.onMinuteBar) {
                    this.onMinuteBar(this.currentSymbol, {
                        time: latestCandle.time,
                        open: latestCandle.open,
                        high: latestCandle.high,
                        low: latestCandle.low,
                        close: latestCandle.close,
                        volume: latestCandle.volume
                    });
                }
                
                // Reset error counter on success
                this.consecutiveErrors = 0;
            }
        } catch (error) {
            this.consecutiveErrors++;
            console.error(`❌ Poll error (${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS}):`, error.message);
            
            if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
                console.error('❌ Too many consecutive errors, stopping poller');
                this.stop('Too many consecutive errors');
                if (this.onError) {
                    this.onError(new Error('Too many consecutive poll errors'));
                }
            }
        }
    }
}

// Make available globally
if (typeof window !== 'undefined') {
    window.WebullCandlesPoller = WebullCandlesPoller;
}

