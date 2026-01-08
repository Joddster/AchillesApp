/**
 * Electron IPC Renderer Shim for Browser
 * Provides browser-compatible replacements for Electron IPC calls
 */

// Mock ipcRenderer for browser environment
const ipcRenderer = {
    send: function(channel, ...args) {
        console.log(`[IPC Mock] send: ${channel}`, args);
        
        // Handle specific channels that need browser implementations
        switch(channel) {
            case 'update-app-title':
                document.title = args[0] || 'Robinhood Trading Desk';
                break;
            case 'open-new-window':
                window.open(window.location.href, '_blank');
                break;
            case 'clear-browser-view':
                // No-op in browser
                break;
            case 'save-option-cache':
                // Save to localStorage instead
                const cacheData = args[0];
                if (cacheData) {
                    try {
                        let cache = JSON.parse(localStorage.getItem('optionCache') || '{"options":{},"symbolMap":{}}');
                        cache.options[cacheData.ticker] = cacheData.options;
                        cache.lastUpdate = cacheData.lastUpdate;
                        if (!cache.symbolMap) cache.symbolMap = {};
                        cache.symbolMap[cacheData.tickerId.toString()] = cacheData.ticker;
                        localStorage.setItem('optionCache', JSON.stringify(cache));
                        console.log(`✅ Saved ${cacheData.ticker} options to localStorage`);
                    } catch (error) {
                        console.error('❌ Failed to save option cache:', error);
                    }
                }
                break;
        }
    },
    
    on: function(channel, callback) {
        console.log(`[IPC Mock] on: ${channel}`);
        // Store listeners for potential future use
        if (!this._listeners) this._listeners = {};
        if (!this._listeners[channel]) this._listeners[channel] = [];
        this._listeners[channel].push(callback);
    },
    
    once: function(channel, callback) {
        console.log(`[IPC Mock] once: ${channel}`);
        const wrappedCallback = (...args) => {
            callback(...args);
            this.removeListener(channel, wrappedCallback);
        };
        this.on(channel, wrappedCallback);
    },
    
    removeListener: function(channel, callback) {
        if (this._listeners && this._listeners[channel]) {
            const index = this._listeners[channel].indexOf(callback);
            if (index > -1) {
                this._listeners[channel].splice(index, 1);
            }
        }
    },
    
    invoke: async function(channel, ...args) {
        console.log(`[IPC Mock] invoke: ${channel}`, args);
        
        // Handle specific invoke channels
        switch(channel) {
            case 'puppeteer-login':
                // In browser, we can't do puppeteer login
                // User must use manual token entry
                throw new Error('Automated login not available in browser. Please use manual token entry.');
                
            case 'refresh-option-cache':
                // In browser, we can't spawn processes
                // Return mock success
                return { success: true, message: 'Cache refresh not available in browser mode' };
                
            case 'clear-webull-session':
                // Clear localStorage tokens
                localStorage.removeItem('wb_access_token');
                localStorage.removeItem('wb_device_id');
                localStorage.removeItem('wb_trade_token');
                localStorage.removeItem('wb_account_id');
                return { success: true, clearedCount: 4 };
                
            default:
                return { success: false, error: 'Unknown IPC channel' };
        }
    },
    
    _listeners: {}
};

// Make available globally
if (typeof window !== 'undefined') {
    window.ipcRenderer = ipcRenderer;
}

