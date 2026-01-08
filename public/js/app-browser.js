// Browser environment - use global objects instead of require()
const ipcRenderer = window.ipcRenderer; // From electron-shim.js
const WebullAPI = window.WebullAPI; // From webull-api-browser.js
const api = new WebullAPI();
const webullCandlesPoller = window.WebullCandlesPoller ? new window.WebullCandlesPoller() : null;
const ChartManager = window.ChartManager; // From chart.js
const tradeLogic = window.tradeLogic; // From trade-logic.js
const EffectiveDeltaEngine = window.EffectiveDeltaEngine; // From effective-delta-engine.js
const ChartTools = window.ChartTools; // From chart-tools.js
const OptionFetcher = window.OptionFetcher; // From option-fetcher-browser.js
const SlippageExitEngine = window.SlippageExitEngine; // From slippage-exit-engine.js
const optionPricePollerDebug = null; // Disabled in browser

// Global option fetcher instance (initialized when credentials are available)
let optionFetcher = null;

// ==========================================
// DISABLE MOST CONSOLE OUTPUT FOR PERFORMANCE
// ==========================================
// Silence console methods to prevent lag (hundreds of calls per second)
// Keep console.warn/error active temporarily for real account debugging
const noop = () => {};
const originalWarn = console.warn;
const originalError = console.error;
// console.log = noop; // 🔍 TEMPORARILY ENABLED FOR ORDER DEBUGGING
console.info = noop;
// console.warn = noop; // ENABLED for real account debugging
// console.error = noop; // ENABLED for real account debugging
// console.debug = noop; // 🔍 ENABLED for price poller debugging
console.trace = noop;
// ==========================================

// Feature flag: local WebSocket event stream (Chrome extension helper) is OPTIONAL.
// Keep this false to avoid WebSocket error spam when the helper isn't running.
const ENABLE_LOCAL_EVENT_STREAM = false;

// Validate ticker symbol format (used to sanitize localStorage and user input)
function isValidTickerSymbol(ticker) {
    if (!ticker || typeof ticker !== 'string') {
        return false;
    }
    
    const trimmed = ticker.trim().toUpperCase();
    
    // Valid ticker rules:
    // - 1-6 characters (some ETFs/funds are 5-6 chars)
    // - Only letters, numbers, dots, hyphens (common in some markets)
    // - No semicolons, spaces, or other special chars
    const validPattern = /^[A-Z0-9][A-Z0-9.-]{0,5}$/;
    
    if (!validPattern.test(trimmed)) {
        return false;
    }
    
    // Additional check: no consecutive special chars
    if (/[.-]{2,}/.test(trimmed)) {
        return false;
    }
    
    return true;
}

// Sanitize watchlist: remove corrupted/invalid ticker symbols
function sanitizeWatchlist(watchlist) {
    if (!Array.isArray(watchlist)) return ['AAPL', 'TSLA', 'SPY', 'QQQ', 'AMD'];
    
    const cleaned = watchlist.filter(ticker => {
        return isValidTickerSymbol(ticker);
    });
    
    // If all tickers were invalid, return defaults
    return cleaned.length > 0 ? cleaned : ['AAPL', 'TSLA', 'SPY', 'QQQ', 'AMD'];
}

// Load watchlist from localStorage with error handling
function loadWatchlistFromStorage() {
    try {
        const raw = localStorage.getItem('watchlist');
        if (!raw) return ['AAPL', 'TSLA', 'SPY', 'QQQ', 'AMD'];
        
        const parsed = JSON.parse(raw);
        const sanitized = sanitizeWatchlist(parsed);
        
        // If sanitization changed the list, save the cleaned version
        if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
            localStorage.setItem('watchlist', JSON.stringify(sanitized));
        }
        
        return sanitized;
    } catch (e) {
        // Silent fallback to defaults
        return ['AAPL', 'TSLA', 'SPY', 'QQQ', 'AMD'];
    }
}

// State
let appState = {
    isConnected: false,
    watchlist: loadWatchlistFromStorage(),
    selectedTicker: localStorage.getItem('selectedTicker') || 'SPY',
    priorityWatchlist: JSON.parse(localStorage.getItem('priorityWatchlist') || '[]'),
    invalidTickers: new Set(), // Track invalid tickers to stop wasting API calls
    highlightWatchlist: JSON.parse(localStorage.getItem('highlightWatchlist') || '[]'),
    tickerId: null,
    optionTickerId: null, // Currently selected option contract
    currentPrice: 0,
    currentOptionPrice: 0,
    lastPrice: 0, // Track last price to detect actual changes
    stopLoss: 0,
    lastTrade: null,
    paperAccountId: null,
    hasLoggedQuoteStructure: false,
    hasLoggedChainStructure: false,
    hasLoggedOptionError: false,
    hasLoggedMarketClosed: false,
    lastLoggedStatusCode: null,
    hasWarnedStalePrice: false,
    lastPriceChangeTime: null,
    marketActuallyOpen: false, // Time-based market status (don't trust API)
    selectedOptionType: 'call', // Track selected call/put
    selectedStrike: null,
    selectedExpiry: null,
    availableExpiries: [],
    availableStrikes: [],
    strikeCount: 6, // Number of strike buttons to display (6, 10, 20, 30, 50, or 'all')
    optionContractId: null, // Webull option contract ID for trading
    stockTickerId: null, // Underlying stock ticker ID (separate from optionContractId)
    watchlistPrices: {}, // Store prices for watchlist display
    todayCandleTimestamp: null, // Fixed timestamp for today's candle
    todayOpen: 0,
    todayHigh: 0,
    todayLow: 0,
    lastUpdateTimestamp: null, // For network status tracking (quotes / account)
    networkSlowStreak: 0,      // For smoothing network indicator
    networkOkStreak: 0,        // For smoothing network indicator
    
    // Real-time 1-minute candle building
    currentMinuteCandle: null, // Current 1-minute candle being built
    candleHistory: [], // All candles built so far (must stay strictly time-ascending)
    
    // Track last calculated values for debug logging
    lastCalculatedContracts: null,
    
    // Candle persistence
    candleStorageKey: 'candles_', // Will be appended with ticker symbol
    
    // Local order history (for Orders panel)
    orderHistory: [],

    // Auto-exit (stop loss / take profit)
    autoStopEnabled: false,
    autoTpEnabled: false,
    autoStopPrice: null,
    autoTpPrice: null,
    activeAutoOrder: null,
    tpOverrideMode: false, // When true (Trojan mode), TP bar is visual only. Auto-detects Calls/Puts from selectedOptionType.
    originalSymmetricStopPrice: null, // Original SL based on symmetric risk (for secondary stop loss)

    // Session levels
    premarketHigh: null,
    premarketLow: null,
    showPremarketHigh: false,
    showPremarketLow: false,
    showPDH: true,
    showPDL: true,

    // Option pricing source
    optionPriceIsReal: false,   // true when from Polygon/Webull quotes, false when theoretical
    optionDeltaIsReal: false,   // true when delta comes from Polygon options data
    currentOptionDelta: 0,      // latest real delta (Polygon), used for sizing

    // Manual stop-loss overrides
    autoStopBasePrice: null,
    manualStopPrice: null,
    manualStopActive: false,

    // Live position snapshot for current ticker (reserved for future use)
    currentPosition: null,

    // Chart indicators (line series handles by type)
    indicatorSeries: {}
};

// ==================================================
// 📅 MARKET HOURS FILTER
// ==================================================
let hasLoggedMarketHoursFilter = false; // Only log once

// Check if a candle timestamp is during regular market hours (9:30 AM - 4:00 PM EST)
function isMarketHours(timestampSeconds) {
    if (!timestampSeconds || typeof timestampSeconds !== 'number') return false;
    
    const tsMs = timestampSeconds * 1000;
    const est = new Date(new Date(tsMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    
    // Check if weekend
    const dayOfWeek = est.getDay(); // 0 = Sunday, 6 = Saturday
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        if (!hasLoggedMarketHoursFilter) {
            console.log('📅 Market hours filter active - Weekend candles will not be displayed');
            hasLoggedMarketHoursFilter = true;
        }
        return false;
    }
    
    // Check if within market hours (9:30 AM - 4:00 PM EST)
    const hours = est.getHours();
    const minutes = est.getMinutes();
    const timeInMinutes = hours * 60 + minutes;
    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60; // 4:00 PM
    
    if (timeInMinutes < marketOpen || timeInMinutes >= marketClose) {
        if (!hasLoggedMarketHoursFilter) {
            const timeStr = est.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            console.log(`📅 Market hours filter active - Pre-market and after-hours candles will not be displayed (current: ${timeStr} EST)`);
            hasLoggedMarketHoursFilter = true;
        }
        return false;
    }
    
    return true;
}

// Ensure candle arrays are strictly ascending by time (no duplicates / backwards jumps).
// This prevents lightweight-charts from throwing
// "data must be asc ordered by time, index=..., time=..., prev time=..." errors.
function sanitizeCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return [];

    // Defensive copy + sort by time
    const sorted = candles
        .filter(c => {
            // Basic structure validation
            if (!c || typeof c.time !== 'number') return false;
            
            // 🚫 FILTER OUT PRE-MARKET & AFTER-HOURS CANDLES
            if (!isMarketHours(c.time)) {
                // Silently filter - no need to log every filtered candle
                return false;
            }
            
            // Validate OHLC values exist and are valid numbers
            if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
                console.warn(`⚠️ Filtered out candle with invalid OHLC:`, c);
                return false;
            }
            
            // Validate OHLC are positive
            if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
                console.warn(`⚠️ Filtered out candle with non-positive OHLC:`, c);
                return false;
            }
            
            // Validate OHLC relationships
            if (c.high < c.low || c.high < c.open || c.high < c.close || 
                c.low > c.open || c.low > c.close) {
                console.warn(`⚠️ Filtered out candle with invalid OHLC relationship:`, c);
                return false;
            }
            
            // Validate range isn't unrealistic (>20% range in 1 minute is very suspicious)
            const range = c.high - c.low;
            const avgPrice = (c.high + c.low) / 2;
            if (range / avgPrice > 0.20) {
                console.warn(`⚠️ Filtered out candle with unrealistic range: ${(range / avgPrice * 100).toFixed(2)}%`, c);
                return false;
            }
            
            return true;
        })
        .map(c => ({ ...c }))
        .sort((a, b) => a.time - b.time);

    const cleaned = [];
    let lastTime = null;
    let lastClose = null;

    for (const c of sorted) {
        const t = c.time;
        if (lastTime != null && t <= lastTime) {
            // Skip out-of-order or duplicate timestamps
            continue;
        }
        
        // Additional validation: check if candle is within reasonable distance from previous candle
        if (lastClose != null) {
            const closeChange = Math.abs((c.close - lastClose) / lastClose);
            const highChange = Math.abs((c.high - lastClose) / lastClose);
            const lowChange = Math.abs((c.low - lastClose) / lastClose);
            
            // Skip candles that jump >15% from previous close (very suspicious)
            if (closeChange > 0.15 || highChange > 0.15 || lowChange > 0.15) {
                console.warn(`⚠️ Filtered out candle with extreme jump from previous: ${(Math.max(closeChange, highChange, lowChange) * 100).toFixed(2)}%`, c);
                continue;
            }
        }
        
        cleaned.push(c);
        lastTime = t;
        lastClose = c.close;
    }

    return cleaned;
}

// UI Elements (will be populated after DOM is ready)
let ui = {};

const chartManager = new ChartManager('chart-container');
const deltaEngine = new EffectiveDeltaEngine(30, 0.05); // 30 second buffer, $0.05 min movement
let chartTools = null; // Initialize after DOM ready

// Feature flag: when true, use Polygon for STOCK market data (quotes + candles).
// Use Polygon for ALL market data (prices, charts, options, Greeks).
// Webull is used ONLY for trade execution (buy/sell orders).
const USE_POLYGON_MARKET_DATA = true;

// Slippage-aware exit engine (wraps auto-exit order placement)
const slippageExitEngine = new SlippageExitEngine(api, log, {
    slippageToleranceRatio: 0.05,
    defaultTickSize: 0.01
});

// ✅ Give slippage engine access to appState for market status checks
slippageExitEngine.setAppStateRef(appState);

// Persist Risk & Sizing inputs (expected move / target profit) across sessions
function saveRiskSizing() {
    try {
        const payload = {
            move: ui.move ? parseFloat(ui.move.value) || null : null,
            profit: ui.profit ? parseFloat(ui.profit.value) || null : null,
        };
        localStorage.setItem('riskSizing', JSON.stringify(payload));
    } catch (e) {
        console.error('Failed to save riskSizing to localStorage', e);
    }
}

// ==================================================
// 🔔 Custom Alert Modal (Modern UI)
// ==================================================
function showCustomAlert(message, title = null, icon = 'ℹ️', callback = null) {
    const modal = document.getElementById('custom-alert-modal');
    const titleEl = document.getElementById('custom-alert-title');
    const iconEl = document.getElementById('custom-alert-icon');
    const messageEl = document.getElementById('custom-alert-message');
    const okBtn = document.getElementById('custom-alert-ok');
    
    if (!modal || !messageEl) {
        console.warn('Custom alert modal not found, falling back to native alert');
        alert(`${title || 'Notification'}\n\n${message}`);
        if (callback) callback();
        return;
    }
    
    // Set content
    if (title) {
        titleEl.textContent = title;
    } else {
        // Use custom app name if available
        const customName = localStorage.getItem('customAppName') || 'Notification';
        titleEl.textContent = customName;
    }
    iconEl.textContent = icon;
    messageEl.textContent = message;
    
    // Show modal
    modal.style.display = 'flex';
    
    // OK button handler
    const closeAlert = () => {
        modal.style.display = 'none';
        okBtn.removeEventListener('click', closeAlert);
        // Execute callback if provided
        if (callback) callback();
    };
    okBtn.addEventListener('click', closeAlert);
}

// Initialization
function init() {
    // Initialize UI elements NOW that DOM is ready
    ui = {
        loginModal: document.getElementById('login-modal'),
        cacheWarningModal: document.getElementById('cache-warning-modal'),
        cacheWarningMessage: document.getElementById('cache-warning-message'),
        closeCacheWarning: document.getElementById('close-cache-warning'),
        refreshCacheNowBtn: document.getElementById('refresh-cache-now-btn'),
        skipCacheRefreshBtn: document.getElementById('skip-cache-refresh-btn'),
        btnLogin: document.getElementById('btn-login'),
        btnLoginToken: document.getElementById('btn-login-token'),
        btnLoginPuppeteer: document.getElementById('btn-login-puppeteer'),
        btnLogout: document.getElementById('btn-logout'),
        closeLoginModal: document.getElementById('close-login-modal'),
        marketState: document.getElementById('market-state'),
        token: document.getElementById('wb-token'),
        tToken: document.getElementById('wb-t-token'),
        did: document.getElementById('wb-did'),
        accountId: document.getElementById('wb-account-id'),
        modePaper: document.getElementById('mode-paper'),
        modeReal: document.getElementById('mode-real'),
        loginBtnText: document.getElementById('login-btn-text'),
        status: document.getElementById('connection-status'),
        openCalendarBtn: document.getElementById('open-calendar-btn'),
        calendarOverlay: document.getElementById('calendar-overlay'),
        watchlist: document.getElementById('watchlist'),
        addTickerBtn: document.getElementById('add-ticker-btn'),
        addTickerRow: document.getElementById('add-ticker-row'),
        addTickerInput: document.getElementById('add-ticker-input'),
        
        // Trade Panel
        tickerInput: document.getElementById('trade-ticker'),
        refreshOptionsBtn: document.getElementById('refresh-options-btn'),
        refreshOptionsIcon: document.getElementById('refresh-options-icon'),
        refreshOptionsText: document.getElementById('refresh-options-text'),
        refreshOptionsStatus: document.getElementById('refresh-options-status'),
        btnOptionCall: document.getElementById('btn-option-call'),
        btnOptionPut: document.getElementById('btn-option-put'),
        expirySelect: document.getElementById('trade-expiry-select'),
        strikeButtonsSection: document.getElementById('strike-buttons-section'),
        strikeButtonsContainer: document.getElementById('strike-buttons-container'),
        strikeCountSelector: document.getElementById('strike-count-selector'),
        selectedStrikePrice: document.getElementById('selected-strike-price'),
        selectedStrikeLabel: document.getElementById('selected-strike-label'),
        move: document.getElementById('trade-move'),
        profit: document.getElementById('trade-profit-target'),
        stopPrice: document.getElementById('trade-stop-price'),
        
        // Outputs
        outDelta: document.getElementById('calc-delta'),
        outProfitPer: document.getElementById('calc-profit-per'),
        outStrike: document.getElementById('calc-strike'),
        outCost: document.getElementById('calc-cost'),
        outContracts: document.getElementById('calc-contracts'),
        outTotalCost: document.getElementById('calc-total-cost'),
        sizingWarning: document.getElementById('sizing-warning'),
        maxSlippageDisplay: document.getElementById('calc-max-slippage'),
        worstExitPnlDisplay: document.getElementById('calc-worst-exit-pnl'),
        manualContractsOverride: document.getElementById('manual-contracts-override'),
        manualContractsInput: document.getElementById('manual-contracts-input'),
        manualContractsInputContainer: document.getElementById('manual-contracts-input-container'),
        
        // Buttons
        btnBuy: document.getElementById('btn-buy-order'),
        btnSell: document.getElementById('btn-sell-order'),
        
        logs: document.getElementById('logs-container'),
        logsInner: document.getElementById('logs-inner'),
        toggleConsoleBtn: document.getElementById('toggle-console-btn'),
        consoleResizeHandle: document.getElementById('console-resize-handle'),
        consoleTabs: document.querySelectorAll('.console-tab'),
        consoleClearBtn: document.getElementById('console-clear'),
        consoleExportBtn: document.getElementById('console-export'),
        tradePanel: document.querySelector('.trade-panel'),
        tradeEditorToggle: document.getElementById('trade-editor-toggle'),
        tradeEditorReset: document.getElementById('trade-editor-reset'),
        
        // Header Menu Items
        networkIndicator: document.getElementById('network-indicator'),
        networkDot: document.getElementById('network-dot'),
        networkDropdown: document.getElementById('network-dropdown'),
        settingsIcon: document.getElementById('settings-icon'),
        settingsDropdown: document.getElementById('settings-dropdown'),
        userIcon: document.getElementById('user-icon'),
        userDropdown: document.getElementById('user-dropdown'),
        displayAccountId: document.getElementById('display-account-id'),
        
        // Live displays
        liveStockPrice: document.getElementById('live-stock-price'),
        
        // Auto-exit controls
        autoStopCheckbox: document.getElementById('auto-stop-enabled'),
        autoTpCheckbox: document.getElementById('auto-tp-enabled'),
        tpOverrideCheckbox: document.getElementById('tp-override-mode'),
        resetStopLossBtn: document.getElementById('reset-stop-loss'),
        showPremarketHighCheckbox: document.getElementById('show-premarket-high'),
        showPremarketLowCheckbox: document.getElementById('show-premarket-low'),
        showPDHCheckbox: document.getElementById('show-pdh'),
        showPDLCheckbox: document.getElementById('show-pdl'),
        
        // Orders / Positions
        paperCash: document.getElementById('paper-cash'),
        paperEquity: document.getElementById('paper-equity'),
        paperPlToday: document.getElementById('paper-pl-today'),
        paperOpenPnl: document.getElementById('paper-open-pnl'),
        kpiCash: document.getElementById('kpi-cash'),
        kpiPlToday: document.getElementById('kpi-pl-today'),
        kpiOpenPnl: document.getElementById('kpi-open-pnl-kpi'),
        positionsList: document.getElementById('positions-list'),
        ordersList: document.getElementById('orders-list'),
        ordersTabs: document.querySelectorAll('.orders-tab'),
    };
    
    // Apply saved theme on load (supports dark, dark-red, classic, light)
    try {
        const savedTheme = localStorage.getItem('theme');
        const root = document.documentElement;
        const currentThemeLabel = document.getElementById('current-theme');
        const themeToApply = (savedTheme === 'light' || savedTheme === 'dark-red' || savedTheme === 'classic')
            ? savedTheme
            : 'dark';

        // Normalise root classes so CSS tokens can key off theme-*
        root.classList.remove('theme-dark', 'theme-light', 'theme-dark-red', 'theme-classic');
        if (themeToApply === 'light') {
            root.classList.add('theme-light');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Light';
        } else if (themeToApply === 'dark-red') {
            root.classList.add('theme-dark-red');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Dark Red';
        } else if (themeToApply === 'classic') {
            root.classList.add('theme-classic');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Classic';
        } else {
            // Default institutional dark
            root.classList.add('theme-dark');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Dark';
        }

        chartManager.applyTheme(themeToApply);
        // Apply custom candle colors if set
        applyCandleColors();
        // Apply custom TP/SL settings if set
        applySLTPSettings();
    } catch (e) {
        console.error('Failed to restore theme', e);
    }
    
    // Restore saved Risk & Sizing inputs (expected move / target profit)
    try {
        const savedRisk = JSON.parse(localStorage.getItem('riskSizing') || '{}');
        if (ui.move && typeof savedRisk.move === 'number' && !Number.isNaN(savedRisk.move)) {
            ui.move.value = savedRisk.move;
        }
        if (ui.profit && typeof savedRisk.profit === 'number' && !Number.isNaN(savedRisk.profit)) {
            ui.profit.value = savedRisk.profit;
        }
    } catch (e) {
        console.error('Failed to restore riskSizing from localStorage', e);
    }

    renderWatchlist();
    selectTicker(appState.selectedTicker);
    
    // Initialize indicator dropdown checkmarks
    updateIndicatorDropdown();
    
    // Apply custom app name if saved
    const savedAppName = localStorage.getItem('customAppName');
    if (savedAppName) {
        applyCustomAppName(savedAppName);
    }
    
    // Clean up old icon data from localStorage (no longer used)
    localStorage.removeItem('customAppIcon');
    
    // Initialize chart tools
    chartTools = new ChartTools(chartManager);
    log('Chart tools initialized', 'success');

    // Start slippage-aware exit engine event stream (ORDER_UPDATE / POSITIONS_UPDATE / QUOTE_UPDATE)
    // Only if the optional local event helper is enabled and running.
    if (ENABLE_LOCAL_EVENT_STREAM && slippageExitEngine && typeof slippageExitEngine.startEventStream === 'function') {
        slippageExitEngine.startEventStream();
        log('Slippage exit engine started (listening to local Webull event stream)', 'info');
    } else {
        log('Slippage exit engine running in HTTP-only mode (no local event stream)', 'info');
    }
    
    // Restore console visibility preference
    // Default: console hidden on first run (no key set).
    const consoleHiddenPref = localStorage.getItem('consoleHidden') !== '0';
    if (ui.logs && ui.toggleConsoleBtn) {
        if (consoleHiddenPref) {
            ui.logs.classList.add('collapsed');
            ui.toggleConsoleBtn.textContent = '▲ Show Console';
            ui.toggleConsoleBtn.style.bottom = '8px';
        } else {
            ui.logs.classList.remove('collapsed');
            ui.toggleConsoleBtn.textContent = '▼ Hide Console';
            // Default height 140px
            ui.logs.style.height = '140px';
            ui.toggleConsoleBtn.style.bottom = '140px';
        }
    }

    // Event Listeners (with null checks)
    if (ui.btnLoginToken) ui.btnLoginToken.addEventListener('click', handleTokenLogin);
    if (ui.btnLoginPuppeteer) ui.btnLoginPuppeteer.addEventListener('click', handlePuppeteerLogin);
    if (ui.btnLogout) ui.btnLogout.addEventListener('click', handleLogout);
    
    // Refresh Options button
    if (ui.refreshOptionsBtn) {
        ui.refreshOptionsBtn.addEventListener('click', handleRefreshOptions);
    }
    
    // Cache warning modal buttons
    if (ui.closeCacheWarning) {
        ui.closeCacheWarning.addEventListener('click', () => {
            if (ui.cacheWarningModal) ui.cacheWarningModal.style.display = 'none';
        });
    }
    if (ui.refreshCacheNowBtn) {
        ui.refreshCacheNowBtn.addEventListener('click', () => {
            if (ui.cacheWarningModal) ui.cacheWarningModal.style.display = 'none';
            handleRefreshOptions();
        });
    }
    if (ui.skipCacheRefreshBtn) {
        ui.skipCacheRefreshBtn.addEventListener('click', () => {
            if (ui.cacheWarningModal) ui.cacheWarningModal.style.display = 'none';
        });
    }
    
    if (ui.closeLoginModal) {
        ui.closeLoginModal.addEventListener('click', (e) => {
            console.log('Close button clicked!');
            e.preventDefault();
            e.stopPropagation();
            if (ui.loginModal) ui.loginModal.style.display = 'none';
            log('Login modal closed - check logs for errors', 'info');
        });
        console.log('Close modal listener attached');
    } else {
        console.error('Close login modal button not found!');
    }
    
    
    // Account mode switcher (Paper vs Real)
    if (ui.modePaper) {
        ui.modePaper.addEventListener('change', updateLoginMode);
        console.log('Paper mode radio listener attached');
    }
    if (ui.modeReal) {
        ui.modeReal.addEventListener('change', updateLoginMode);
        console.log('Real mode radio listener attached');
    }
    
    if (ui.addTickerBtn && ui.addTickerRow && ui.addTickerInput) {
        ui.addTickerBtn.addEventListener('click', () => {
            const isVisible = ui.addTickerRow.style.display === 'block';
            ui.addTickerRow.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                ui.addTickerInput.value = '';
                ui.addTickerInput.focus();
            }
        });
        ui.addTickerInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addTickerFromInput();
            } else if (e.key === 'Escape') {
                ui.addTickerRow.style.display = 'none';
            }
        });
    }
    
    if (ui.move) {
        ui.move.addEventListener('input', () => {
            saveRiskSizing();
            if (appState.currentPrice > 0) {
                recalculateOptionMetrics();
            }
        });
    }
    if (ui.profit) {
        ui.profit.addEventListener('input', () => {
            saveRiskSizing();
            if (appState.currentPrice > 0) {
                recalculateOptionMetrics();
            }
        });
    }
    if (ui.stopPrice) {
        ui.stopPrice.addEventListener('input', (e) => {
            const p = parseFloat(e.target.value);
            if (!isNaN(p)) {
                chartManager.setStopLoss(p);
                // ✅ Sync with activeAutoOrder so checkAutoExits() can detect hits
                if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
                    appState.activeAutoOrder.stopPrice = p;
                    appState.autoStopPrice = p;
                    // Track placement price and time for crossover detection
                    appState.stopPlacementPrice = appState.currentPrice || p;
                    appState.stopPlacementTime = Date.now();
                }
            }
        });
    }
    if (ui.resetStopLossBtn) {
        ui.resetStopLossBtn.addEventListener('click', () => {
            resetManualStopLoss();
        });
    }

    // Auto-exit checkbox listeners
    if (ui.autoStopCheckbox) {
        ui.autoStopCheckbox.addEventListener('change', (e) => {
            appState.autoStopEnabled = e.target.checked;
            if (!e.target.checked) {
                chartManager.setStopLoss(null);
            } else {
                // If no precomputed level, assume long and use current price ± expected move
                if (appState.autoStopPrice == null && appState.currentPrice) {
                    const expectedMove = parseFloat(ui.move?.value) || 1;
                    appState.autoStopPrice = appState.currentPrice - expectedMove;
                }
                if (appState.autoStopPrice != null) {
                    chartManager.setStopLoss(appState.autoStopPrice);
                }
            }
        });
    }

    if (ui.autoTpCheckbox) {
        ui.autoTpCheckbox.addEventListener('change', (e) => {
            appState.autoTpEnabled = e.target.checked;
            if (!e.target.checked) {
                chartManager.clearTakeProfit();
            } else {
                if (appState.autoTpPrice == null && appState.currentPrice) {
                    const expectedMove = parseFloat(ui.move?.value) || 1;
                    appState.autoTpPrice = appState.currentPrice + expectedMove;
                }
                if (appState.autoTpPrice != null) {
                    chartManager.setTakeProfit(appState.autoTpPrice);
                    // ✅ Sync with activeAutoOrder so checkAutoExits() can detect hits
                    if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
                        appState.activeAutoOrder.tpPrice = appState.autoTpPrice;
                    }
                }
            }
        });
    }

    // ✅ Trojan mode listener (auto-detects Calls vs Puts)
    if (ui.tpOverrideCheckbox) {
        ui.tpOverrideCheckbox.addEventListener('change', (e) => {
            appState.tpOverrideMode = e.target.checked;
            
            const status = e.target.checked ? 'VISUAL ONLY' : 'AUTOMATIC';
            const optionType = appState.selectedOptionType || 'call';
            const direction = optionType === 'put' ? 'SL top→down (inverted)' : 'SL bottom→up';
            log(`Trojan Mode ${e.target.checked ? 'ENABLED' : 'DISABLED'}: TP bar is now ${status}. Auto-detects Calls/Puts (Current: ${optionType.toUpperCase()}, ${direction})`, 'info');
        });
    }

    // ✅ Load default Trojan mode setting on app startup
    try {
        const defaultTrojanEnabled = localStorage.getItem('defaultTrojanEnabled') === 'true';
        
        if (defaultTrojanEnabled && ui.tpOverrideCheckbox) {
            ui.tpOverrideCheckbox.checked = true;
            appState.tpOverrideMode = true;
            log('✅ Trojan Mode auto-enabled from settings (will auto-detect Calls/Puts)', 'success');
        }
    } catch (e) {
        console.error('Failed to load default Trojan mode setting', e);
    }

    // Pre-market session level toggles
    if (ui.showPremarketHighCheckbox) {
        ui.showPremarketHighCheckbox.addEventListener('change', (e) => {
            appState.showPremarketHigh = e.target.checked;
            updatePremarketLines();
        });
    }

    if (ui.showPremarketLowCheckbox) {
        ui.showPremarketLowCheckbox.addEventListener('change', (e) => {
            appState.showPremarketLow = e.target.checked;
            updatePremarketLines();
        });
    }

    // PDH/PDL visibility toggles
    if (ui.showPDHCheckbox) {
        // Initialise from saved state (defaults to true if not set).
        ui.showPDHCheckbox.checked = appState.showPDH !== false;
        appState.showPDH = ui.showPDHCheckbox.checked;
        ui.showPDHCheckbox.addEventListener('change', (e) => {
            appState.showPDH = e.target.checked;
            if (chartManager && typeof chartManager.setPDHVisible === 'function') {
                chartManager.setPDHVisible(appState.showPDH);
            }
        });
    }
    if (ui.showPDLCheckbox) {
        ui.showPDLCheckbox.checked = appState.showPDL !== false;
        appState.showPDL = ui.showPDLCheckbox.checked;
        ui.showPDLCheckbox.addEventListener('change', (e) => {
            appState.showPDL = e.target.checked;
            if (chartManager && typeof chartManager.setPDLVisible === 'function') {
                chartManager.setPDLVisible(appState.showPDL);
            }
        });
    }
    
    // Track option type selection - button-based toggle
    const optionTypeButtons = [ui.btnOptionCall, ui.btnOptionPut];
    optionTypeButtons.forEach(btn => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            const optionType = btn.dataset.type; // 'call' or 'put'
            appState.selectedOptionType = optionType;
            deltaEngine.reset(); // Reset when switching call/put
            log(`Switched to ${optionType.toUpperCase()}`, 'info');
            
            // Update button styles (toggle active state)
            optionTypeButtons.forEach(b => {
                if (b.dataset.type === optionType) {
                    b.classList.add('active');
                    b.style.background = optionType === 'call' ? 'var(--cyber-green)' : '#ff4757';
                    b.style.borderColor = optionType === 'call' ? 'var(--cyber-green)' : '#ff4757';
                    b.style.color = '#fff';
                } else {
                    b.classList.remove('active');
                    b.style.background = 'transparent';
                    b.style.borderColor = 'var(--cyber-border)';
                    b.style.color = 'var(--cyber-text)';
                }
            });
            
            // Repopulate strike buttons for the new option type (if expiry is selected)
            if (appState.selectedExpiry) {
                setupStrikeButtons();
            }
            
            fetchOptionData(); // Immediately fetch option data for new type
            
            // Update preview TP/SL lines for new option type
            updatePreviewTPSL();
        });
    });
    
    // Track expiry selection - CASCADE to populate strike buttons
    if (ui.expirySelect) {
        ui.expirySelect.addEventListener('change', (e) => {
            const selectedDate = e.target.value;
            appState.selectedExpiry = selectedDate;
            
            if (!selectedDate) {
                // No expiry selected - HIDE strike buttons section
                if (ui.strikeButtonsSection) {
                    ui.strikeButtonsSection.style.display = 'none';
                }
                return;
            }
            
            log(`Expiry set to ${selectedDate}`, 'info');
            
            // 🎯 SHOW and POPULATE strike buttons for this expiry
            if (ui.strikeButtonsSection) {
                ui.strikeButtonsSection.style.display = 'block';
            }
            setupStrikeButtons();
            fetchOptionData(); // Immediately fetch option data for new expiry
        });
    }
    
    // Track strike count selector
    if (ui.strikeCountSelector) {
        ui.strikeCountSelector.addEventListener('change', (e) => {
            const count = e.target.value;
            appState.strikeCount = count === 'all' ? 'all' : parseInt(count);
            log(`Strike count changed to ${count}`, 'info');
            setupStrikeButtons(); // Regenerate strikes with new count
        });
    }
    
    // Update preview TP/SL lines when expected move changes
    if (ui.move) {
        ui.move.addEventListener('input', () => {
            updatePreviewTPSL();
        });
    }
    
    // Update preview TP/SL lines when auto-stop/auto-tp toggles change
    if (ui.autoStopCheckbox) {
        ui.autoStopCheckbox.addEventListener('change', () => {
            if (!ui.autoStopCheckbox.checked) {
                // Clear stop loss line when unchecked
                chartManager.clearStopLoss();
            } else {
                updatePreviewTPSL();
            }
        });
    }
    
    if (ui.autoTpCheckbox) {
        ui.autoTpCheckbox.addEventListener('change', () => {
            if (!ui.autoTpCheckbox.checked) {
                // Clear take profit line when unchecked
                chartManager.clearTakeProfit();
            } else {
                updatePreviewTPSL();
            }
        });
    }
    
    // Setup strike buttons (will be populated when stock price is available)
    // Event delegation for strike button clicks
    if (ui.strikeButtonsContainer) {
        ui.strikeButtonsContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.strike-btn');
            if (!btn) return;
            
            const index = parseInt(btn.dataset.index);
            if (!isNaN(index) && appState.availableStrikes && appState.availableStrikes[index]) {
                selectStrike(index);
            }
        });
    }

    if (ui.btnBuy) ui.btnBuy.addEventListener('click', () => executeTrade('BUY'));
    // Big red SELL button → EMERGENCY FLATTEN with aggressive slippage-aware limit
    if (ui.btnSell) ui.btnSell.addEventListener('click', () => emergencySell());

    // Manual contract override checkbox
    if (ui.manualContractsOverride && ui.manualContractsInputContainer) {
        ui.manualContractsOverride.addEventListener('change', (e) => {
            if (e.target.checked) {
                ui.manualContractsInputContainer.style.display = 'block';
                // Pre-fill with current calculated quantity if available
                if (ui.outContracts && ui.outContracts.textContent !== '--') {
                    const currentQty = parseInt(ui.outContracts.textContent.replace(/[^\d]/g, ''));
                    if (currentQty > 0 && ui.manualContractsInput) {
                        ui.manualContractsInput.value = currentQty;
                        
                        // Update total cost for the pre-filled quantity
                        if (ui.outTotalCost) {
                            const optionPrice = appState.currentOptionPrice || 0;
                            if (optionPrice > 0) {
                                const costPerContract = optionPrice * 100;
                                const totalCost = costPerContract * currentQty;
                                ui.outTotalCost.innerText = `$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                                ui.outTotalCost.style.color = totalCost > 10000 ? '#ff1744' : (totalCost > 5000 ? '#ffab00' : '#06ffa5');
                                ui.outTotalCost.title = `Total cost for ${currentQty} contract${currentQty > 1 ? 's' : ''} at $${costPerContract.toFixed(2)} each (MANUAL OVERRIDE)`;
                            }
                        }
                    }
                }
                // Add visual indicator to "Contracts Req." that it's being overridden
                if (ui.outContracts) {
                    ui.outContracts.style.opacity = '0.5';
                    ui.outContracts.title = 'Auto-calculation (currently overridden by manual input)';
                }
            } else {
                ui.manualContractsInputContainer.style.display = 'none';
                // Restore "Contracts Req." display
                if (ui.outContracts) {
                    ui.outContracts.style.opacity = '1';
                }
                // Recalculate total cost based on auto-calculated contracts
                updateCalculations();
            }
        });
        
        // Update manual input visual feedback on input change
        if (ui.manualContractsInput) {
            ui.manualContractsInput.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (val > 0) {
                    e.target.style.borderColor = '#4caf50';
                    
                    // Update total cost for manual quantity
                    if (ui.outTotalCost) {
                        const optionPrice = appState.currentOptionPrice || 0;
                        if (optionPrice > 0) {
                            const costPerContract = optionPrice * 100;
                            const totalCost = costPerContract * val;
                            ui.outTotalCost.innerText = `$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                            ui.outTotalCost.style.color = totalCost > 10000 ? '#ff1744' : (totalCost > 5000 ? '#ffab00' : '#06ffa5');
                            ui.outTotalCost.title = `Total cost for ${val} contract${val > 1 ? 's' : ''} at $${costPerContract.toFixed(2)} each (MANUAL OVERRIDE)`;
                        }
                    }
                } else {
                    e.target.style.borderColor = '#ffab00';
                }
            });
        }
    }

    // Global trade hotkeys
    setupTradeHotkeys();
    
    // Console toggle (like Cursor's terminal toggle)
    if (ui.toggleConsoleBtn && ui.logs) {
        ui.toggleConsoleBtn.addEventListener('click', () => {
            const isCollapsed = ui.logs.classList.toggle('collapsed');
            ui.toggleConsoleBtn.textContent = isCollapsed ? '▲ Show Console' : '▼ Hide Console';
            if (isCollapsed) {
                ui.toggleConsoleBtn.style.bottom = '8px';
                try { localStorage.setItem('consoleHidden', '1'); } catch (e) {}
            } else {
                // Use current height if user resized, otherwise default to 140
                const h = ui.logs.offsetHeight || 140;
                ui.toggleConsoleBtn.style.bottom = `${h}px`;
                try { localStorage.setItem('consoleHidden', '0'); } catch (e) {}
            }
        });
    }

    // Console drag-to-resize
    if (ui.consoleResizeHandle && ui.logs && ui.toggleConsoleBtn) {
        ui.consoleResizeHandle.addEventListener('mousedown', (e) => {
            isResizingConsole = true;
            consoleResizeStartY = e.clientY;
            consoleResizeStartHeight = ui.logs.offsetHeight || 140;
            document.body.style.userSelect = 'none';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizingConsole) return;
            const dy = consoleResizeStartY - e.clientY;
            let newHeight = consoleResizeStartHeight + dy;
            const minH = 80;
            const maxH = Math.max(260, window.innerHeight * 0.6);
            if (newHeight < minH) newHeight = minH;
            if (newHeight > maxH) newHeight = maxH;
            ui.logs.style.height = `${newHeight}px`;
            ui.toggleConsoleBtn.style.bottom = `${newHeight}px`;
        });

        window.addEventListener('mouseup', () => {
            if (!isResizingConsole) return;
            isResizingConsole = false;
            document.body.style.userSelect = '';
        });
    }

    // Console resize via drag handle
    if (ui.consoleResizeHandle && ui.logs && ui.toggleConsoleBtn) {
        ui.consoleResizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizingConsole = true;
            consoleResizeStartY = e.clientY;
            consoleResizeStartHeight = ui.logs.clientHeight || 160;
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingConsole) return;
            const dy = consoleResizeStartY - e.clientY; // drag up = increase height
            let newHeight = consoleResizeStartHeight + dy;
            const minH = 80;
            const maxH = 400;
            newHeight = Math.max(minH, Math.min(maxH, newHeight));
            ui.logs.style.height = `${newHeight}px`;
            ui.toggleConsoleBtn.style.bottom = (newHeight + 8) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isResizingConsole) return;
            isResizingConsole = false;
            document.body.style.userSelect = '';
        });
    }

    // Console tabs (All / Activity / API)
    if (ui.consoleTabs && ui.consoleTabs.length > 0) {
        ui.consoleTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                ui.consoleTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                applyConsoleFilter();
            });
        });
    }

    // Console clear
    if (ui.consoleClearBtn && ui.logsInner) {
        ui.consoleClearBtn.addEventListener('click', () => {
            ui.logsInner.innerHTML = '';
        });
    }

    // Console export (download as text)
    if (ui.consoleExportBtn && ui.logsInner) {
        ui.consoleExportBtn.addEventListener('click', () => {
            const entries = Array.from(ui.logsInner.querySelectorAll('.log-entry'));
            const lines = entries.map(e => e.innerText.replace(/\s+/g, ' ').trim());
            const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `neuralink-console-${Date.now()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    // Trade panel editor mode (reorder/hide sections)
    setupTradePanelEditor();
    
    // Header Menu Dropdowns
    setupHeaderMenus();

    // Orders / Positions panel
    setupOrdersPanel();

    // Chart "Go to Live" button – jump back to latest candles
    const goToLiveBtn = document.getElementById('go-to-real-time');
    if (goToLiveBtn) {
        goToLiveBtn.addEventListener('click', () => {
            try {
                // Reset any vertical scroll in the right trade panel (where you can scroll far down)
                const tradePanel = document.querySelector('.trade-panel');
                if (tradePanel) {
                    tradePanel.scrollTop = 0;
                }

                // Also reset any top-level scroll (if the window/body is scrollable on this platform)
                try {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    document.documentElement.scrollTop = 0;
                    document.body.scrollTop = 0;
                } catch (e) {
                    // ignore
                }

                // Finally, ensure the chart container is brought into view in case any parent is scrollable
                const chartEl = document.getElementById('chart-container');
                if (chartEl && typeof chartEl.scrollIntoView === 'function') {
                    chartEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }

                chartManager.scrollToLatest();
                log('Centered chart on latest candles', 'info');
            } catch (e) {
                console.error('Failed to center chart', e);
            }
        });
    }

    document.addEventListener('api-log', (e) => log(e.detail.msg, e.detail.type, 'api'));
    
    // Chart Event
    document.addEventListener('chart-stop-update', (e) => {
        const price = e.detail.price;
        ui.stopPrice.value = price.toFixed(2);
        
        // ✅ Sync with activeAutoOrder so checkAutoExits() can detect hits
        if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
            appState.activeAutoOrder.stopPrice = price;
            appState.autoStopPrice = price;
        }
    });

    // Take-profit line updated from chart
    document.addEventListener('chart-tp-update', (e) => {
        const price = e.detail.price;
        
        // ✅ Sync with activeAutoOrder so checkAutoExits() can detect hits
        if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
            appState.activeAutoOrder.tpPrice = price;
            appState.autoTpPrice = price;
        }
    });

    // Manual stop-loss from chart double-click or drag
    document.addEventListener('manual-stop-change', (e) => {
        const price = Number(e.detail?.price || 0);
        if (!price || isNaN(price)) return;

        // 🔍 DEBUG: Log SL line movement with full context
        const currentCandle = appState.currentMinuteCandle;
        const candleDisplay = currentCandle 
            ? `O:${currentCandle.open.toFixed(2)} H:${currentCandle.high.toFixed(2)} L:${currentCandle.low.toFixed(2)} C:${currentCandle.close.toFixed(2)}`
            : 'No candle';
        
        // 🎯 Clean SL placement log
        const currentPrice = appState.currentPrice || 0;
        console.log(`🎯 SL placed at $${price.toFixed(2)} | Current price: $${currentPrice.toFixed(2)}`);

        appState.manualStopActive = true;
        appState.manualStopPrice = price;
        appState.autoStopPrice = price;
        
        // 🚨 CRITICAL: Track the price at SL placement and direction to cross
        // This ensures SL only triggers when price CROSSES the line, not because it's already past it
        // Example 1: SL at $215.70, price $215.57 → needs to rise to $215.70
        // Example 2: SL at $215.50, price $215.70 → needs to drop to $215.50
        appState.stopPlacementPrice = currentPrice;
        appState.stopPlacementTime = Date.now();

        chartManager.setStopLoss(price);
        if (ui.stopPrice) {
            ui.stopPrice.value = price.toFixed(2);
        }

        if (appState.activeAutoOrder) {
            appState.activeAutoOrder.stopPrice = price;
        }

        log(`Manual stop-loss set from chart at $${price.toFixed(2)}`, 'info');
        
        // ✅ Save updated state to localStorage
        saveActiveOrderState();
    });
    
    // ✅ NEW: Manual take-profit from chart double right-click or drag
    document.addEventListener('manual-tp-change', (e) => {
        const price = Number(e.detail?.price || 0);
        if (!price || isNaN(price)) return;
        
        const currentPrice = appState.currentPrice || 0;
        console.log(`🎯 TP placed at $${price.toFixed(2)} | Current price: $${currentPrice.toFixed(2)}`);
        
        appState.autoTpPrice = price;
        
        chartManager.setTakeProfit(price);
        
        if (appState.activeAutoOrder) {
            appState.activeAutoOrder.tpPrice = price;
        }
        
        log(`Manual take-profit set from chart at $${price.toFixed(2)}`, 'info');
        
        // ✅ Save updated state to localStorage
        saveActiveOrderState();
    });

    function resetManualStopLoss() {
        if (!chartManager) return;

        appState.manualStopActive = false;
        appState.manualStopPrice = null;
        const base = appState.autoStopBasePrice;
        if (base != null) {
            chartManager.setStopLoss(base);
            if (ui.stopPrice) ui.stopPrice.value = base.toFixed(2);
            if (appState.activeAutoOrder) {
                appState.activeAutoOrder.stopPrice = base;
            }
            log(`Stop-loss reset to auto level at $${base.toFixed(2)}`, 'info');
        } else {
            chartManager.setStopLoss(null);
            if (ui.stopPrice) ui.stopPrice.value = '';
            if (appState.activeAutoOrder) {
                appState.activeAutoOrder.stopPrice = null;
            }
            log('Stop-loss cleared (no auto base level available)', 'info');
        }
    }

    // Hotkeys from Main
    ipcRenderer.on('hotkey-buy', () => ui.btnBuy.click());
    ipcRenderer.on('hotkey-sell', () => ui.btnSell.click());
    ipcRenderer.on('hotkey-kill', () => {
        ui.btnBuy.disabled = true;
        ui.btnSell.disabled = true;
        log('KILL SWITCH ACTIVATED - TRADING DISABLED', 'error');
    });

    log('App initialized. Checking for saved credentials...');
    
    // Setup Webull Candles Poller for real-time market data
    setupWebullCandlesPoller();
    
    // Always try auto-login for Webull (needed for trading and market data)
    tryAutoLogin();
    
    // Check cache status on startup and show warning if needed
    checkCacheOnStartup();
}

// Check option cache status on startup
function checkCacheOnStartup() {
    try {
        const fs = require('fs');
        const path = require('path');
        const cachePath = path.join(__dirname, '..', 'optionDatabase.json');
        
        // Check if cache exists
        if (!fs.existsSync(cachePath)) {
            console.warn('⚠️ No option cache found');
            showCacheWarning('No option cache found. You need to fetch option data before trading.', 'missing');
            return;
        }
        
        // Read cache
        const cacheData = fs.readFileSync(cachePath, 'utf8');
        const cache = JSON.parse(cacheData);
        
        // Count total contracts
        let totalContracts = 0;
        if (cache.options) {
            Object.values(cache.options).forEach(symbol => {
                Object.values(symbol).forEach(expiry => {
                    if (Array.isArray(expiry)) {
                        totalContracts += expiry.length;
                    }
                });
            });
        }
        
        // Check cache age
        let cacheAge = Infinity;
        if (cache.lastUpdate) {
            cacheAge = Date.now() - new Date(cache.lastUpdate).getTime();
        }
        const ageHours = Math.floor(cacheAge / (1000 * 60 * 60));
        
        console.log(`📊 Cache status: ${totalContracts} contracts, ${ageHours} hours old`);
        
        // Show warning if cache is stale (>12 hours) or has too few contracts (<50)
        if (ageHours > 12) {
            showCacheWarning(
                `Your option cache is ${ageHours} hours old. Strike prices may be outdated.`,
                'stale'
            );
        } else if (totalContracts < 50) {
            showCacheWarning(
                `Only ${totalContracts} contracts in cache. You may have limited strike options.`,
                'incomplete'
            );
        }
        
    } catch (error) {
        console.error('Failed to check cache status:', error);
    }
}

// Show cache warning modal
function showCacheWarning(message, type) {
    if (!ui.cacheWarningModal || !ui.cacheWarningMessage) return;
    
    ui.cacheWarningMessage.textContent = message;
    ui.cacheWarningModal.style.display = 'block';
    
    log(`⚠️ ${message}`, 'warn');
}

// Setup Webull Candles Poller for real-time candle updates
function setupWebullCandlesPoller() {
    log('🚀 Initializing Webull candles poller for real-time data...', 'info');
    
    // Set API instance on poller (after API is instantiated)
    webullCandlesPoller.setAPI(api);
    
    // Throttle chart updates to prevent jittery movement
    let lastStrikeUpdate = 0;
    let lastAutoExitCheck = 0;
    
    const STRIKE_UPDATE_INTERVAL = 2000; // Update strikes max once per 2 seconds
    const AUTO_EXIT_CHECK_INTERVAL = 50; // Check auto-exits 20x per second (ultra-fast SL response!)
    
    // Set up poller callbacks
    webullCandlesPoller.onConnected = () => {
        log('✅ Webull candles poller connected - real-time updates active', 'success');
        updateConnectionStatus(true);
    };
    
    webullCandlesPoller.onDisconnected = (reason) => {
        log(`⚠️ Webull candles poller disconnected: ${reason}`, 'warn');
        updateConnectionStatus(false);
    };
    
    webullCandlesPoller.onError = (error) => {
        log(`❌ Webull candles poller error: ${error.message || error}`, 'error');
    };
    
    // Handle initial historical candles load from Webull
    webullCandlesPoller.onInitialLoad = (candles) => {
        log(`📊 Loaded ${candles.length} historical candles from Webull`, 'info');
        
        // Store in app state
        appState.candleHistory = candles.slice(0, -1); // All except the last one
        appState.currentMinuteCandle = candles[candles.length - 1]; // Last one is current
        
        // Update chart with historical data
        const sanitizedCandles = sanitizeCandles(candles);
        if (sanitizedCandles.length > 0) {
            chartManager.updateData(sanitizedCandles);
            
            // Update price from last candle
            const lastCandle = sanitizedCandles[sanitizedCandles.length - 1];
            appState.currentPrice = lastCandle.close;
            appState.lastPrice = lastCandle.close;
            
            log(`✅ Chart initialized with ${sanitizedCandles.length} candles`, 'success');
        }
    };
    
    // Handle real-time minute bars from Webull (updated every second)
    webullCandlesPoller.onMinuteBar = (symbol, candle) => {
        // Only update if this is the currently selected ticker
        if (symbol !== appState.selectedTicker) return;
        
        // Track successful update for network status
        appState.lastUpdateTimestamp = Date.now();
        
        // ✅ Update price from official candle close (syncs currentPrice with chart)
        const wasZeroPrice = appState.currentPrice === 0 || !appState.currentPrice;
        appState.lastPrice = candle.close;
        appState.currentPrice = candle.close;
        
        log(`🕯️ Received 1m candle from Webull: O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)} at ${new Date(candle.time * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} EST`, 'info');
        
        // Update chart with the market-aligned candle
        updateChartWithMinuteBar(candle);
        
        // Force update strike buttons on first price load (to populate after auto-select)
        if (wasZeroPrice && appState.selectedExpiry) {
            setupStrikeButtons();
        }
        
        // Update session highs/lows
        if (candle.high > appState.todayHigh || appState.todayHigh === 0) {
            appState.todayHigh = candle.high;
        }
        if (candle.low < appState.todayLow || appState.todayLow === 0) {
            appState.todayLow = candle.low;
        }
        
        // Throttle strike button updates (expensive operation)
        const now = Date.now();
        if (now - lastStrikeUpdate >= STRIKE_UPDATE_INTERVAL) {
            setupStrikeButtons();
            lastStrikeUpdate = now;
        }
        
        // Check auto-exits (for tight SL response!)
        if (now - lastAutoExitCheck >= AUTO_EXIT_CHECK_INTERVAL) {
            checkAutoExits();
            lastAutoExitCheck = now;
        }
    };
    
    // Track consecutive candle states for bounce-back detection
    if (!appState.candleUpdateHistory) {
        appState.candleUpdateHistory = [];
    }
    
    // ✅ Webull provides complete minute candles (no need for trade-level aggregation)
    // The poller is initialized but not started yet - it will start when a ticker is selected
    log('✅ Webull candles poller initialized and ready', 'success');
}

function updateConnectionStatus(isConnected) {
    // Update any UI indicators if needed
    if (isConnected) {
        appState.isWebSocketConnected = true;
    } else {
        appState.isWebSocketConnected = false;
    }
}

/* ========== OLD DEAD CODE (commented out) ==========
    const oldUnusedTradeCode = function() {
        const now = Date.now();
        if (now - lastChartUpdate >= CHART_UPDATE_INTERVAL) {
            // Validate price is reasonable
            if (!price || !isFinite(price) || price <= 0) {
                return; // Skip invalid prices
            }
            
            // Get current minute timestamp in EST
            const nowUtc = new Date();
            const nowEst = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const currentMinute = new Date(
                nowEst.getFullYear(),
                nowEst.getMonth(),
                nowEst.getDate(),
                nowEst.getHours(),
                nowEst.getMinutes(),
                0,
                0
            );
            const currentMinuteTimestamp = Math.floor(currentMinute.getTime() / 1000);
            
            // Check if we need to start a new candle (minute changed)
            if (!appState.currentMinuteCandle || appState.currentMinuteCandle.time !== currentMinuteTimestamp) {
                // New minute - create fresh candle
                appState.currentMinuteCandle = {
                    time: currentMinuteTimestamp,
                    open: price,
                    high: price,
                    low: price,
                    close: price
                };
                
                // ✅ Update currentPrice for new candle (price is validated by being the open)
                const wasZeroPrice = appState.currentPrice === 0 || !appState.currentPrice;
                appState.currentPrice = price;
                appState.lastPrice = price;
                
                // Muted: New candle log
                // console.log(`🕐 New candle: ${nowEst.toLocaleTimeString('en-US')}`);
                chartManager.updateRealtime(appState.currentMinuteCandle);
                
                // Force update strike buttons on first price load (to populate after auto-select)
                if (wasZeroPrice && appState.selectedExpiry) {
                    setupStrikeButtons();
                }
                
                // ✅ Check SL/TP after new candle starts
                if (now - lastAutoExitCheck >= AUTO_EXIT_CHECK_INTERVAL) {
                    checkAutoExits();
                    lastAutoExitCheck = now;
                }
            } else {
                // Same minute - update existing candle with STRICT validation
                const candle = appState.currentMinuteCandle;
                
                // 🔍 VISUAL SPIKE DEBUGGING: Capture BEFORE state
                const beforeUpdate = {
                    tradePrice: price,
                    candle: {
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close
                    },
                    lastPrice: appState.lastPrice,
                    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 })
                };
                
                // ✅ CONDITION-BASED FILTERING: Trades are now pre-filtered by Polygon based on condition codes
                // Bad prints, late reports, and errors are excluded at the source (in polygon-api.js)
                // This is the SAME approach TradingView uses - filter by trade TYPE, not price jumps!
                // 
                // We still keep a LOOSE price validation as a safety net for extreme outliers
                // But this should rarely trigger now that we're filtering bad condition codes
                if (appState.lastPrice && appState.lastPrice > 0) {
                    const priceDiff = Math.abs(price - appState.lastPrice);
                    if (priceDiff > 0.50) {  // Very loose: $0.50 (only catches extreme errors)
                        console.warn(`🚫 EXTREME OUTLIER: $${price.toFixed(2)} (jumped $${priceDiff.toFixed(2)})`);
                        return; // Skip extreme outlier
                    }
                }
                
                // Also check against candle range with very loose threshold
                const highDiff = price - candle.high;
                const lowDiff = candle.low - price;
                if (highDiff > 0.50 || lowDiff > 0.50) {  // Very loose: $0.50 expansion
                    console.warn(`🚫 EXTREME RANGE EXPANSION: $${price.toFixed(2)} (would expand by $${Math.max(highDiff, lowDiff).toFixed(2)})`);
                    return; // Skip extreme outlier
                }
                
                // ✅ Price is valid - update currentPrice for SL checks (AFTER validation!)
                // This ensures SL only triggers on validated prices that update the chart
                // No need to log price jumps anymore - condition-based filtering handles bad prints!
                
                appState.currentPrice = price;
                appState.lastPrice = price;
                
                const oldHigh = candle.high;
                const oldLow = candle.low;
                const oldClose = candle.close;
                
                // 🎯 SMOOTH OHLC UPDATES: Only update if meaningful change (>$0.02)
                // This prevents visual "jumping" and ensures what you SEE matches trigger levels
                // Critical for accurate SL placement!
                
                // Close: Only update if changed by >$0.02
                const closeChangeDollar = Math.abs(price - candle.close);
                if (closeChangeDollar >= 0.02) {
                    candle.close = price;
                }
                
                // High: Only expand if >$0.02 above current high
                const highExpansion = price - candle.high;
                if (highExpansion > 0.02) {
                    candle.high = price;
                }
                
                // Low: Only expand if >$0.02 below current low
                const lowExpansion = candle.low - price;
                if (lowExpansion > 0.02) {
                    candle.low = price;
                }
                
                // 🚨 CRITICAL: Clear AM bar flag on live trade update
                // This re-enables SL checks after historical correction
                if (appState.candleJustUpdatedByAMBar) {
                    // Muted: AM bar flag cleared
                    // console.log(`✅ Cleared AM bar flag`);
                    appState.candleJustUpdatedByAMBar = false;
                }
                
                // 🔍 Candle spike detection (should be RARE now with condition-based filtering!)
                const highChange = Math.abs(candle.high - oldHigh);
                const lowChange = Math.abs(candle.low - oldLow);
                
                // Only log EXTREME spikes (>$0.50) - these should almost never happen
                if (highChange > 0.50 || lowChange > 0.50) {
                    console.error(`🚨 EXTREME CANDLE SPIKE: Price=$${price.toFixed(2)} | H:+$${highChange.toFixed(2)} L:+$${lowChange.toFixed(2)}`);
                    console.error(`   └─ Old: H:${oldHigh.toFixed(2)} L:${oldLow.toFixed(2)} → New: H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)}`);
                }
                
                // 🔍 Track update history for bounce-back detection
                appState.candleUpdateHistory.push({
                    time: Date.now(),
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    tradePrice: price
                });
                
                // Keep only last 10 updates
                if (appState.candleUpdateHistory.length > 10) {
                    appState.candleUpdateHistory.shift();
                }
                
                // Muted: Bounce-back detection (too noisy)
                // if (appState.candleUpdateHistory.length >= 3) {
                //     const last3 = appState.candleUpdateHistory.slice(-3);
                //     const highSpike = last3[1].high - last3[0].high;
                //     const highReverse = last3[1].high - last3[2].high;
                //     if (highSpike > 0.05 && highReverse > 0.05) {
                //         console.error(`🎢 BOUNCE-BACK (HIGH)`);
                //     }
                // }
                
                chartManager.updateRealtime(candle);
                
                // ✅ Check SL/TP after chart update (price is now validated and synced)
                // Throttled to run max twice per second
                if (now - lastAutoExitCheck >= AUTO_EXIT_CHECK_INTERVAL) {
                    checkAutoExits();
                    lastAutoExitCheck = now;
                }
            }
            
            lastChartUpdate = now;
        }
        
        // Log latency periodically (every 10 seconds)
        if (!appState.lastLatencyLogTime || now - appState.lastLatencyLogTime > 10000) {
            log('WebSocket latency: ' + tradeData.latency + 'ms', 'info');
            appState.lastLatencyLogTime = now;
        }
    };
========== END OLD DEAD CODE ==========  */

    // Auto-login with saved credentials
async function tryAutoLogin() {
    // Check for saved credentials (try last used mode first)
    const lastMode = localStorage.getItem('tradingMode') || 'paper';
    const prefix = `webull_${lastMode}`;
    
    const savedToken = localStorage.getItem(`${prefix}_token`);
    const savedTToken = localStorage.getItem(`${prefix}_t_token`);
    const savedDid = localStorage.getItem(`${prefix}_did`);
    const savedAccountId = localStorage.getItem(`${prefix}_account_id`);
    
    if (savedToken && savedDid && savedAccountId) {
        log(`Found saved ${lastMode.toUpperCase()} credentials, attempting auto-login...`, 'info');
        
        ui.status.className = 'status-badge connecting';
        ui.status.innerText = 'Auto-connecting...';
        
        const result = await api.loginWithToken(savedToken, savedDid, savedAccountId, savedTToken);
        
        if (result.success) {
            appState.isConnected = true;
            
            // Set API reference for price poller (so it can get credentials)
            optionPricePollerDebug.setAPI(api);
            
            // Set account IDs based on login mode
            if (lastMode === 'paper') {
                appState.paperAccountId = savedAccountId;
                api.paperAccountId = savedAccountId;
            } else {
                appState.realAccountId = savedAccountId;
                api.realAccountId = savedAccountId;
            }
            
            ui.status.className = 'status-badge connected';
            ui.status.innerText = 'Connected';
            ui.loginModal.style.display = 'none';
            if (ui.btnLogout) ui.btnLogout.style.display = 'block';
            
            // Update user dropdown with account ID
            if (ui.displayAccountId) {
                ui.displayAccountId.textContent = savedAccountId;
            }
            
            // Toggle connect button visibility
            updateConnectionUI(true);
            
            // Set trading mode
            api.setTradingMode(lastMode);
            updateTradingModeUI(lastMode);
            
            log(`✓ AUTO-LOGIN SUCCESS (${lastMode.toUpperCase()})`, 'success');
            startDataPolling();

            // Ensure initial ticker is fully loaded now that we're connected
            if (appState.selectedTicker) {
                selectTicker(appState.selectedTicker);
            } else if (appState.watchlist && appState.watchlist.length > 0) {
                selectTicker(appState.watchlist[0]);
            }
        } else {
            log(`Auto-login failed: ${result.error}`, 'error');
            log('Please login manually (token may have expired)', 'info');
            ui.status.className = 'status-badge disconnected';
            ui.status.innerText = 'Disconnected';
            // Show login modal
            ui.loginModal.style.display = 'flex';
            // Ensure modal is interactive
            ensureModalInteractive();
            // Pre-fill with saved values for the last used mode
            if (ui.modePaper && ui.modeReal) {
                if (lastMode === 'paper') {
                    ui.modePaper.checked = true;
                } else {
                    ui.modeReal.checked = true;
                }
            }
            updateLoginMode(); // Load the correct credentials for the selected mode
        }
    } else {
        log('No saved credentials found. Please login to Webull for trading.', 'info');
        console.error('💡 No saved credentials - showing login modal');

        // Show login modal on startup if not connected (needed for trading even with Polygon data)
        if (ui.loginModal) {
            console.error('✅ Setting login modal display to flex');
            ui.loginModal.style.display = 'flex';
            // Force show with higher specificity
            ui.loginModal.style.visibility = 'visible';
            ui.loginModal.style.opacity = '1';
            ui.loginModal.style.zIndex = '10000';
            // Ensure fields are interactive
            ensureModalInteractive();
        } else {
            console.error('❌ Login modal element NOT FOUND!');
        }
    }
}

// Logout
async function handleLogout() {
    log('🔓 Logging out...', 'info');
    
    // Clear saved credentials for both modes
    localStorage.removeItem('webull_paper_token');
    localStorage.removeItem('webull_paper_t_token');
    localStorage.removeItem('webull_paper_did');
    localStorage.removeItem('webull_paper_account_id');
    localStorage.removeItem('webull_real_token');
    localStorage.removeItem('webull_real_t_token');
    localStorage.removeItem('webull_real_did');
    localStorage.removeItem('webull_real_account_id');
    // Also clear old format (backward compatibility)
    localStorage.removeItem('webull_access_token');
    localStorage.removeItem('webull_did');
    localStorage.removeItem('webull_account_id');
    
    // Clear WebullAPI instance tokens
    api.accessToken = null;
    api.deviceId = null;
    api.accountId = null;
    api.paperAccountId = null;
    api.paperId = null;
    api.realAccountId = null;
    api.tradeToken = null;
    api.tradeTokenExpireIn = null;
    api.userId = null;
    api.tradingMode = 'PAPER';
    api.hasRealAccount = false;
    api.hasPaperAccount = false;
    
    // Reset state
    appState.isConnected = false;
    appState.paperAccountId = null;
    appState.realAccountId = null;
    
    // Reset auth expired event timestamp (allow fresh events on next login)
    if (api.lastAuthExpiredEvent !== undefined) {
        api.lastAuthExpiredEvent = 0;
    }
    
    // Clear embedded browser session (cookies, storage, etc.)
    try {
        const result = await ipcRenderer.invoke('clear-webull-session');
        if (result.success) {
            log(`✅ Cleared ${result.clearedCount} browser cookies and session data`, 'success');
        } else {
            console.warn('⚠️ Failed to clear browser session:', result.error);
        }
    } catch (error) {
        console.warn('⚠️ Error clearing browser session:', error.message);
    }
    
    // Update UI
    ui.status.className = 'status-badge disconnected';
    ui.status.innerText = 'Disconnected';
    if (ui.btnLogout) ui.btnLogout.style.display = 'none';
    ui.loginModal.style.display = 'flex';
    
    // Ensure modal is interactive
    ensureModalInteractive();
    
    // Toggle connect button visibility
    updateConnectionUI(false);
    
    // Clear and re-enable all form fields
    if (ui.token) {
        ui.token.value = '';
        ui.token.disabled = false;
        ui.token.readOnly = false;
    }
    if (ui.tToken) {
        ui.tToken.value = '';
        ui.tToken.disabled = false;
        ui.tToken.readOnly = false;
    }
    if (ui.did) {
        ui.did.value = '';
        ui.did.disabled = false;
        ui.did.readOnly = false;
    }
    if (ui.accountId) {
        ui.accountId.value = '';
        ui.accountId.disabled = false;
        ui.accountId.readOnly = false;
    }
    if (ui.username) {
        ui.username.value = '';
        ui.username.disabled = false;
        ui.username.readOnly = false;
    }
    if (ui.pass) {
        ui.pass.value = '';
        ui.pass.disabled = false;
        ui.pass.readOnly = false;
    }
    
    // Reset to paper mode by default
    if (ui.modePaper) {
        ui.modePaper.checked = true;
        updateLoginMode();
    }
    
    // Re-enable buttons
    if (ui.btnLoginToken) ui.btnLoginToken.disabled = false;
    if (ui.btnLogin) ui.btnLogin.disabled = false;
    
    log('✅ Logged out successfully - You can now log in with a different account', 'success');
}

// Ensure login modal is fully interactive (fix frozen input fields)
function ensureModalInteractive() {
    if (!ui.loginModal) return;
    
    // Force modal to be interactive
    ui.loginModal.style.pointerEvents = 'auto';
    ui.loginModal.style.userSelect = 'auto';
    
    // Ensure all input fields are enabled and editable
    const inputs = ui.loginModal.querySelectorAll('input, textarea, button');
    inputs.forEach(input => {
        if (input.id !== 'btn-login' && input.id !== 'btn-login-token') {
            // Re-enable all inputs (but not buttons during login)
            input.disabled = false;
            input.readOnly = false;
            input.style.pointerEvents = 'auto';
            input.style.userSelect = 'auto';
        }
    });
    
    console.log('✓ Login modal made interactive');
}

// Update UI elements based on connection state
function updateConnectionUI(isConnected) {
    const connectBtn = document.getElementById('user-connect-webull');
    const logoutBtn = document.getElementById('user-logout');
    
    if (connectBtn) {
        connectBtn.style.display = isConnected ? 'none' : 'block';
    }
    if (logoutBtn) {
        logoutBtn.style.display = isConnected ? 'block' : 'none';
    }
}


// Update login form based on selected account mode (Paper vs Real)
function updateLoginMode() {
    const isPaperMode = ui.modePaper && ui.modePaper.checked;
    const prefix = isPaperMode ? 'paper' : 'real';
    
    // Update mode selector button styles
    const paperBtn = document.getElementById('paper-btn-label');
    const realBtn = document.getElementById('real-btn-label');
    
    if (paperBtn && realBtn) {
        if (isPaperMode) {
            // Paper selected - bright blue
            paperBtn.style.background = '#2196f3';
            paperBtn.style.borderColor = '#1976d2';
            paperBtn.style.color = '#fff';
            paperBtn.style.boxShadow = '0 2px 8px rgba(33, 150, 243, 0.4)';
            // Real unselected - gray
            realBtn.style.background = '#444';
            realBtn.style.borderColor = '#666';
            realBtn.style.color = '#aaa';
            realBtn.style.boxShadow = 'none';
        } else {
            // Real selected - bright red
            realBtn.style.background = '#ff0066';
            realBtn.style.borderColor = '#d50050';
            realBtn.style.color = '#fff';
            realBtn.style.boxShadow = '0 2px 8px rgba(255, 0, 102, 0.4)';
            // Paper unselected - gray
            paperBtn.style.background = '#444';
            paperBtn.style.borderColor = '#666';
            paperBtn.style.color = '#aaa';
            paperBtn.style.boxShadow = 'none';
        }
    }
    
    // Update button text
    if (ui.loginBtnText) {
        ui.loginBtnText.textContent = isPaperMode 
            ? 'Connect to Paper' 
            : 'Connect to Real';
    }
    
    // Update button color
    if (ui.btnLoginToken) {
        ui.btnLoginToken.style.background = isPaperMode ? '#2196f3' : '#ff0066';
    }
    
    // Show/hide t_token field based on mode
    if (ui.tToken) {
        if (isPaperMode) {
            // Hide t_token for paper trading (it's optional and not needed)
            ui.tToken.style.display = 'none';
            ui.tToken.value = ''; // Clear it
        } else {
            // Show t_token for real trading (it's required)
            ui.tToken.style.display = 'block';
        }
    }
    
    // Load saved credentials for this mode
    const savedToken = localStorage.getItem(`webull_${prefix}_token`) || '';
    const savedTToken = localStorage.getItem(`webull_${prefix}_t_token`) || '';
    const savedDid = localStorage.getItem(`webull_${prefix}_did`) || '';
    const savedAccountId = localStorage.getItem(`webull_${prefix}_account_id`) || '';
    
    if (ui.token) ui.token.value = savedToken;
    if (ui.tToken && !isPaperMode) ui.tToken.value = savedTToken; // Only load for real mode
    if (ui.did) ui.did.value = savedDid;
    if (ui.accountId) ui.accountId.value = savedAccountId;
    
    console.log(`✓ Switched to ${prefix.toUpperCase()} mode login`);
}

// Handle manual refresh of option strikes cache
async function handleRefreshOptions() {
    if (!ui.refreshOptionsBtn) return;
    
    const btn = ui.refreshOptionsBtn;
    const icon = ui.refreshOptionsIcon;
    const text = ui.refreshOptionsText;
    const status = ui.refreshOptionsStatus;
    
    // Disable button during refresh
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
    
    // Show loading state
    icon.style.display = 'none';
    text.textContent = 'Refreshing...';
    status.style.display = 'block';
    status.textContent = 'Starting option fetcher...';
    
    log('🔄 Manual option cache refresh requested', 'info');
    
    try {
        // Call main process to run the fetcher
        const result = await ipcRenderer.invoke('refresh-option-cache');
        
        // Success!
        icon.style.display = 'none';
        text.textContent = '✅ Refresh Complete!';
        status.textContent = result.message || 'Cache updated successfully';
        log('✅ Option cache refreshed successfully', 'success');
        
        // Reset button after 3 seconds
        setTimeout(() => {
            icon.style.display = 'none';
            text.textContent = 'Refresh Strikes';
            status.style.display = 'none';
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }, 3000);
        
    } catch (error) {
        // Error
        console.error('❌ Cache refresh failed:', error);
        icon.style.display = 'none';
        text.textContent = '❌ Refresh Failed';
        status.textContent = error.message || 'Failed to refresh cache';
        log(`❌ Cache refresh failed: ${error.message}`, 'error');
        
        // Reset button after 5 seconds
        setTimeout(() => {
            icon.style.display = 'none';
            text.textContent = 'Refresh Strikes';
            status.style.display = 'none';
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }, 5000);
    }
}

// Listen for progress updates from main process
ipcRenderer.on('refresh-progress', (event, message) => {
    if (ui.refreshOptionsStatus) {
        ui.refreshOptionsStatus.textContent = message.trim();
    }
    console.log('📊', message);
});

// Listen for cache update completion
ipcRenderer.on('cache-updated', () => {
    log('📦 Option cache updated, reloading...', 'info');
    // Reload the cache
    api.loadOptionCache();
    // Refresh strikes if ticker is selected
    if (appState.selectedTicker) {
        setupStrikeButtons();
    }
});

// Embedded Browser Login (Primary Method)
async function handlePuppeteerLogin() {
    console.log('🔐 Checking for saved paper credentials...');
    
    // Check if we already have saved credentials
    const savedToken = localStorage.getItem('webull_paper_token');
    const savedDid = localStorage.getItem('webull_paper_did');
    
    if (savedToken && savedDid) {
        // Try auto-login first
        const result = await api.loginWithToken(savedToken, savedDid);
        if (result.success) {
            console.log('✅ Auto-login successful with saved paper credentials');
            appState.isConnected = true;
            ui.status.className = 'status-badge connected';
            ui.status.innerText = 'Connected';
            ui.loginModal.style.display = 'none';
            updateConnectionUI(true);
            startDataPolling();
            return;
        } else {
            console.log('⚠️  Saved credentials invalid - need browser login');
        }
    } else {
        console.log('ℹ️  No saved paper credentials found - need browser login');
    }
    
    console.log('🌐 Opening embedded browser for paper login...');
    
    try {
        // Disable button to prevent multiple clicks
        if (ui.btnLoginPuppeteer) {
            ui.btnLoginPuppeteer.disabled = true;
            ui.btnLoginPuppeteer.textContent = '🔄 Opening browser...';
        }
        
        console.log('📡 Calling main process to create embedded browser...');
        
        // Call main process to create embedded browser
        const result = await ipcRenderer.invoke('puppeteer-login', 'paper');
        
        console.log('📥 Received result from main process:', result);
        
        if (result.success && result.tokens) {
            console.log('✅ Embedded login successful! Processing tokens...');
            
            // Extract tokens
            const tokens = result.tokens;
            console.log('📦 Received tokens:', tokens);
            
            // Validate tokens
            console.log('🔍 Validating tokens...');
            console.log('   Access Token:', tokens.access_token ? tokens.access_token.substring(0, 20) + '...' : 'MISSING');
            console.log('   Device ID:', tokens.device_id ? tokens.device_id.substring(0, 30) + '...' : 'MISSING');
            console.log('   Account ID:', tokens.account_id || 'MISSING (will auto-detect)');
            
            if (!tokens.access_token || !tokens.device_id) {
                throw new Error('Missing required tokens (access_token or device_id)');
            }
            
            // Extract individual tokens
            const accessToken = tokens.access_token;
            const deviceId = tokens.device_id;
            const accountId = tokens.account_id || null;
            
            console.log('📦 Extracted tokens:');
            console.log('   Access Token:', accessToken.substring(0, 20) + '...');
            console.log('   Device ID:', deviceId.substring(0, 30) + '...');
            console.log('   Account ID:', accountId || 'NOT FOUND - will auto-detect');
            
            // Login with tokens
            const loginResult = await api.loginWithToken(accessToken, deviceId, accountId, null);
            
            if (!loginResult.success) {
                throw new Error('Login failed after token extraction');
            }
            
            // Check if account ID is available
            if (!api.accountId && !api.paperAccountId) {
                console.warn('⚠️  WARNING: No account ID available');
                console.warn('   You can still view market data, but trading may not work');
                console.warn('   Please manually enter your account ID if you need to trade');
            }
            
        // Set API reference for price poller
        optionPricePollerDebug.setAPI(api);
        
        // Set API reference for candles poller (after login with credentials)
        webullCandlesPoller.setAPI(api);
        
        // Set paper account ID
        appState.paperAccountId = api.paperAccountId || api.accountId;
        appState.isConnected = true;
            
            console.log(`✓ Logged into PAPER account: ${appState.paperAccountId || 'UNKNOWN'}`);
            
            // Set trading mode to paper
            api.setTradingMode('paper');
            localStorage.setItem('tradingMode', 'paper');
            updateTradingModeUI('paper');
            
            // Update UI
            ui.status.className = 'status-badge connected';
            ui.status.innerText = 'Connected';
            ui.loginModal.style.display = 'none';
            
            // Update user dropdown with account ID
            if (ui.displayAccountId) {
                ui.displayAccountId.textContent = appState.paperAccountId || 'N/A';
            }
            
            updateConnectionUI(true);
            
            // Save credentials to localStorage
            localStorage.setItem('webull_paper_token', accessToken);
            localStorage.setItem('webull_paper_did', deviceId);
            if (api.paperAccountId) {
                localStorage.setItem('webull_paper_account_id', api.paperAccountId);
            }
            
            log('✓ CONNECTED WITH EMBEDDED BROWSER - Paper Trading', 'success');
            
            // Show logout button
            if (ui.btnLogout) {
                ui.btnLogout.style.display = 'block';
            }
            
            startDataPolling();
            
            // Load initial ticker
            if (appState.selectedTicker) {
                selectTicker(appState.selectedTicker);
            } else if (appState.watchlist && appState.watchlist.length > 0) {
                selectTicker(appState.watchlist[0]);
            }
            
        } else {
            throw new Error(result.error || 'Embedded login failed');
        }
        
    } catch (error) {
        console.error('❌ Embedded login failed:', error);
        console.error('   Error stack:', error.stack);
        
        log(`❌ Embedded login error: ${error.message}`, 'error');
        
        // Re-enable button
        if (ui.btnLoginPuppeteer) {
            ui.btnLoginPuppeteer.disabled = false;
            ui.btnLoginPuppeteer.textContent = '🔐 Login with Webull';
        }
    }
}

// Token Login (Bypass Webull blocks)
async function handleTokenLogin() {
    const token = ui.token.value.trim();
    const tToken = ui.tToken ? ui.tToken.value.trim() : '';
    const did = ui.did.value.trim();
    const accountId = ui.accountId.value.trim();
    const isPaperMode = ui.modePaper && ui.modePaper.checked;
    const loginMode = isPaperMode ? 'paper' : 'real';
    
    if (!token) {
        document.getElementById('login-status').innerText = 'Enter access_token';
        return;
    }
    
    if (!accountId) {
        document.getElementById('login-status').innerText = 'Enter Account ID';
        return;
    }
    
    // t_token is required for real trading
    if (!isPaperMode && !tToken) {
        document.getElementById('login-status').innerText = 'Enter t_token for real trading';
        return;
    }
    
    ui.status.className = 'status-badge connecting';
    ui.status.innerText = 'Connecting...';
    document.getElementById('login-status').innerText = `Verifying ${loginMode} account...`;
    ui.btnLoginToken.disabled = true;
    
    const result = await api.loginWithToken(token, did, accountId, tToken);
    
    if (result.success) {
        appState.isConnected = true;
        
        // Set API reference for price poller (so it can get credentials)
        optionPricePollerDebug.setAPI(api);
        
        // Set account IDs based on login mode
        if (isPaperMode) {
            appState.paperAccountId = accountId;
            api.paperAccountId = accountId;
            console.log(`✓ Logged into PAPER account: ${accountId}`);
        } else {
            appState.realAccountId = accountId;
            api.realAccountId = accountId;
            console.log(`✓ Logged into REAL account: ${accountId}`);
        }
        
        ui.status.className = 'status-badge connected';
        ui.status.innerText = 'Connected';
        ui.loginModal.style.display = 'none';
        log(`✓ CONNECTED WITH TOKEN - ${loginMode.toUpperCase()} Account: ${accountId}`, 'success');
        
        // Set trading mode based on login type
        api.setTradingMode(loginMode);
        localStorage.setItem('tradingMode', loginMode);
        updateTradingModeUI(loginMode);
        
        // Update user dropdown with account ID
        if (ui.displayAccountId) {
            ui.displayAccountId.textContent = accountId;
        }
        
        // Toggle connect button visibility
        updateConnectionUI(true);
        
        // Save credentials to localStorage (separate for paper/real)
        const prefix = `webull_${loginMode}`;
        localStorage.setItem(`${prefix}_token`, token);
        localStorage.setItem(`${prefix}_did`, did);
        localStorage.setItem(`${prefix}_account_id`, accountId);
        if (tToken) {
            localStorage.setItem(`${prefix}_t_token`, tToken);
        }
        log(`✓ ${loginMode.toUpperCase()} credentials saved for auto-login`, 'success');
        
        // Show logout button (if it exists)
        if (ui.btnLogout) {
            ui.btnLogout.style.display = 'block';
        }
        
        startDataPolling();

            // Ensure initial ticker is fully loaded now that we're connected
            if (appState.selectedTicker) {
                selectTicker(appState.selectedTicker);
            } else if (appState.watchlist && appState.watchlist.length > 0) {
                selectTicker(appState.watchlist[0]);
            }
    } else {
        ui.status.className = 'status-badge disconnected';
        ui.status.innerText = 'Token Failed';
        
        // Make error message more user-friendly
        let errorMsg = result.error || 'Invalid credentials';
        if (errorMsg.includes('Token test failed') || errorMsg.includes('Invalid credentials')) {
            errorMsg = '❌ Invalid info - Token expired or incorrect';
        }
        
        document.getElementById('login-status').innerText = errorMsg;
        ui.btnLoginToken.disabled = false;
        log(`✗ TOKEN LOGIN FAILED: ${result.error}`, 'error');
    }
}


function renderWatchlist() {
    if (!ui.watchlist) return;
    ui.watchlist.innerHTML = '';

    const pinned = (appState.priorityWatchlist || []).filter(t => appState.watchlist.includes(t));
    const normal = appState.watchlist.filter(t => !pinned.includes(t));

    function renderGroup(list, isPinnedGroup) {
        list.forEach(ticker => {
            const div = document.createElement('div');
            const isActive = ticker === appState.selectedTicker;
            const isPinned = (appState.priorityWatchlist || []).includes(ticker);
            const isHighlighted = (appState.highlightWatchlist || []).includes(ticker);
            const isInvalid = appState.invalidTickers.has(ticker);
            
            // INSTANT red indicator: apply ticker-invalid class immediately if cached as invalid
            div.className = `ticker-item ${isActive ? 'active' : ''} ${isHighlighted ? 'highlighted' : ''} ${isInvalid ? 'ticker-invalid' : ''}`;
            div.id = `ticker-${ticker}`;
            div.dataset.ticker = ticker;
            
            // Set tooltip for invalid tickers
            if (isInvalid) {
                div.title = `⚠️ Invalid ticker: ${ticker.toUpperCase()} not found. Click X to remove.`;
            }
            
            // Show last known price OR "404" for invalid tickers
            const priceData = appState.watchlistPrices[ticker];
            let priceText = '';
            let priceColor = '';
            
            if (isInvalid) {
                priceText = '404';
                priceColor = '#ff4444';
            } else if (priceData) {
                priceText = `$${priceData.price.toFixed(2)}`;
                priceColor = priceData.change >= 0 ? '#00c853' : '#ff1744';
            }
            
            div.innerHTML = `
                <div class="ticker-main">
                    <span class="ticker-star ${isPinned ? 'pinned' : ''}" data-ticker="${ticker}" title="Toggle priority">★</span>
                    <span class="ticker-circle ${isHighlighted ? 'highlighted' : ''}" data-ticker="${ticker}" title="Toggle highlight">●</span>
                    <span class="ticker-symbol">${ticker}</span>
                </div>
                <span class="ticker-price" style="font-size:11px; ${priceColor ? `color:${priceColor};` : ''}">
                    ${priceText}
                </span>
                <span class="ticker-remove" data-ticker="${ticker}" title="Remove from watchlist">✕</span>
            `;
            ui.watchlist.appendChild(div);
        });
    }

    // Pinned group first
    if (pinned.length > 0) {
        renderGroup(pinned, true);
        if (normal.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'watchlist-divider';
            divider.textContent = 'Priority';
            ui.watchlist.appendChild(divider);
        }
    }
    renderGroup(normal, false);

    // Interactions: select / pin / remove
    ui.watchlist.querySelectorAll('.ticker-item').forEach(item => {
        const ticker = item.dataset.ticker;
        if (!ticker) return;

        // Click on row selects ticker (except when clicking star/circle/remove)
        item.addEventListener('click', (e) => {
            if (e.target.closest('.ticker-star') || e.target.closest('.ticker-circle') || e.target.closest('.ticker-remove')) return;
            selectTicker(ticker);
        });
    });

    ui.watchlist.querySelectorAll('.ticker-star').forEach(star => {
        star.addEventListener('click', (e) => {
            e.stopPropagation();
            const ticker = star.dataset.ticker;
            if (!ticker) return;
            toggleWatchlistPriority(ticker);
        });
    });

    ui.watchlist.querySelectorAll('.ticker-circle').forEach(circle => {
        circle.addEventListener('click', (e) => {
            e.stopPropagation();
            const ticker = circle.dataset.ticker;
            if (!ticker) return;
            toggleWatchlistHighlight(ticker);
        });
    });

    ui.watchlist.querySelectorAll('.ticker-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ticker = btn.dataset.ticker;
            if (!ticker) return;
            removeFromWatchlist(ticker);
        });
    });

    // Drag-and-drop reordering
    setupWatchlistDrag();
}

function addTickerFromInput() {
    if (!ui.addTickerInput) return;
    const raw = ui.addTickerInput.value.trim();
    if (!raw) return;
    const t = raw.toUpperCase();
    
    // Validate ticker format
    if (!isValidTickerSymbol(t)) {
        alert(`⚠️ Invalid ticker symbol: "${t}"\n\nTicker symbols should be 1-6 characters and contain only letters, numbers, dots, or hyphens.\n\nExamples: AAPL, TSLA, SPY, BRK.B`);
        return;
    }
    
    if (!appState.watchlist.includes(t)) {
        appState.watchlist.push(t);
        saveWatchlistState();
        renderWatchlist();
        log(`Added ${t} to watchlist`, 'info');
    }
    ui.addTickerRow.style.display = 'none';
}

function removeFromWatchlist(ticker) {
    appState.watchlist = appState.watchlist.filter(t => t !== ticker);
    appState.priorityWatchlist = (appState.priorityWatchlist || []).filter(t => t !== ticker);
    appState.invalidTickers.delete(ticker); // Clear invalid cache if ticker is removed
    saveWatchlistState();
    renderWatchlist();
    log(`Removed ${ticker} from watchlist`, 'info');
}

function toggleWatchlistPriority(ticker) {
    let list = appState.priorityWatchlist || [];
    if (list.includes(ticker)) {
        list = list.filter(t => t !== ticker);
        log(`Unpinned ${ticker}`, 'info');
    } else {
        list.push(ticker);
        log(`Pinned ${ticker} to priority`, 'info');
    }
    appState.priorityWatchlist = list;
    saveWatchlistState();
    renderWatchlist();
}

function saveWatchlistState() {
    try {
        localStorage.setItem('watchlist', JSON.stringify(appState.watchlist));
        localStorage.setItem('priorityWatchlist', JSON.stringify(appState.priorityWatchlist || []));
        localStorage.setItem('highlightWatchlist', JSON.stringify(appState.highlightWatchlist || []));
    } catch (e) {
        console.error('Failed to save watchlist state', e);
    }
}

function toggleWatchlistHighlight(ticker) {
    let list = appState.highlightWatchlist || [];
    if (list.includes(ticker)) {
        list = list.filter(t => t !== ticker);
        log(`Removed highlight from ${ticker}`, 'info');
    } else {
        list.push(ticker);
        log(`Highlighted ${ticker}`, 'info');
    }
    appState.highlightWatchlist = list;
    saveWatchlistState();
    renderWatchlist();
}

let watchlistDraggingItem = null;

function setupWatchlistDrag() {
    if (!ui.watchlist) return;

    ui.watchlist.querySelectorAll('.ticker-item').forEach(item => {
        item.draggable = true;
        
        item.addEventListener('dragstart', (e) => {
            if (e.target.closest('.ticker-star') || e.target.closest('.ticker-circle') || e.target.closest('.ticker-remove')) {
                e.preventDefault();
                return;
            }
            watchlistDraggingItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!watchlistDraggingItem || watchlistDraggingItem === item) return;
            
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            
            if (e.clientY < midY) {
                ui.watchlist.insertBefore(watchlistDraggingItem, item);
            } else {
                ui.watchlist.insertBefore(watchlistDraggingItem, item.nextSibling);
            }
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            
            // Rebuild watchlist order based on DOM
            const items = Array.from(ui.watchlist.querySelectorAll('.ticker-item'));
            const newOrder = items.map(i => i.dataset.ticker).filter(Boolean);
            appState.watchlist = newOrder;
            saveWatchlistState();
            
            watchlistDraggingItem = null;
        });
    });
}

// Clear all UI elements when invalid ticker is selected
function clearInvalidTickerUI() {
    // Clear live calculations
    if (ui.effectiveDelta) ui.effectiveDelta.textContent = '--';
    if (ui.profitPerDollar) ui.profitPerDollar.textContent = '$--';
    if (ui.strikePrice) ui.strikePrice.textContent = '$0.00';
    if (ui.contractPrice) ui.contractPrice.textContent = '$--';
    if (ui.contractsRequired) ui.contractsRequired.textContent = '--';
    if (ui.maxSlippage) ui.maxSlippage.textContent = '$--';
    if (ui.worstCaseExit) ui.worstCaseExit.textContent = '$--';
    
    // Reset manual override
    if (ui.manualContractsOverride) {
        ui.manualContractsOverride.checked = false;
        if (ui.manualContractsInputContainer) {
            ui.manualContractsInputContainer.style.display = 'none';
        }
        if (ui.manualContractsInput) {
            ui.manualContractsInput.value = '';
        }
    }
    
    // Clear strike buttons
    if (ui.strikeButtonsContainer) {
        ui.strikeButtonsContainer.innerHTML = '<div style="padding:20px;text-align:center;color:#ff4444;">⚠️ Invalid Ticker</div>';
    }
    
    // Clear stock info
    if (ui.stockPrice) ui.stockPrice.textContent = '$--';
    if (ui.todayOpenPrice) ui.todayOpenPrice.textContent = '$--';
    if (ui.todayHighPrice) ui.todayHighPrice.textContent = '$--';
    if (ui.todayLowPrice) ui.todayLowPrice.textContent = '$--';
    
    // Show error message on chart overlay
    const chartContainer = document.getElementById('chart-container');
    if (chartContainer) {
        const overlay = document.createElement('div');
        overlay.id = 'invalid-ticker-overlay';
        overlay.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(255, 68, 68, 0.1);
            border: 2px solid #ff4444;
            border-radius: 12px;
            padding: 30px;
            text-align: center;
            color: #ff4444;
            font-size: 18px;
            font-weight: 700;
            z-index: 1000;
            backdrop-filter: blur(5px);
        `;
        overlay.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 10px;">⚠️</div>
            <div>Invalid Ticker: ${appState.selectedTicker}</div>
            <div style="font-size: 14px; margin-top: 10px; opacity: 0.8;">This ticker is not available or doesn't exist</div>
        `;
        
        // Remove existing overlay if any
        const existingOverlay = document.getElementById('invalid-ticker-overlay');
        if (existingOverlay) existingOverlay.remove();
        
        chartContainer.appendChild(overlay);
    }
}

async function selectTicker(ticker) {
    // Stop old price polling when changing tickers
    optionPricePollerDebug.stopBatchPolling();
    
    // Stop Webull candles poller for previous ticker (if any)
    if (appState.selectedTicker) {
        webullCandlesPoller.stop('Changing ticker');
    }
    
    // Remove invalid overlay from previous ticker (if any)
    const existingOverlay = document.getElementById('invalid-ticker-overlay');
    if (existingOverlay) existingOverlay.remove();
    
    appState.selectedTicker = ticker;
    localStorage.setItem('selectedTicker', ticker);
    ui.tickerInput.value = ticker;
    renderWatchlist();
    
    log(`Selected ${ticker}. Fetching ID...`);
    
    // Reset delta engine and price tracking for new ticker
    deltaEngine.reset();
    appState.optionTickerId = null;
    appState.lastPrice = 0;
    appState.todayOpen = 0;
    appState.todayHigh = 0;
    appState.todayLow = 0;
    appState.todayCandleTimestamp = null;
    appState.currentMinuteCandle = null;
    appState.candleHistory = [];
    
    // Check if ticker is known to be invalid - if so, clear everything immediately
    if (appState.invalidTickers.has(ticker)) {
        log(`⚠️ ${ticker} is invalid - clearing all data`, 'warn');
        
        // Clear chart
        chartManager.updateData([]);
        
        // Clear all sidebar fields
        clearInvalidTickerUI();
        
        // Don't try to load data for invalid ticker
        return;
    }
    
    // Load saved candles from localStorage (if any)
    const savedCandles = loadCandles(ticker);
    const sanitizedSaved = sanitizeCandles(savedCandles);
    if (sanitizedSaved.length > 0) {
        appState.candleHistory = sanitizedSaved;
        chartManager.updateData(sanitizedSaved);
    }
    
    // Fetch Webull tickerId first (required for all Webull API calls)
    if (appState.isConnected) {
        const id = await api.getTickerID(ticker);
        if (id) {
            appState.tickerId = id;
            appState.stockTickerId = id; // Store underlying stock ID for options trading
            log(`ID for ${ticker}: ${id}`);
            
            // 🎯 Fetch options on-demand if not cached (now that we have tickerId)
            try {
                const fetchSuccess = await fetchOptionsOnDemand(ticker, id);
                if (fetchSuccess) {
                    populateExpiryDates(ticker);
                }
            } catch (e) {
                console.error('Options fetch failed', e);
            }
            
            // Don't hide strike buttons if expiry was auto-selected
            // (populateExpiryDates already shows them if an expiry was selected)
            
            // Load today's session data and initialize chart
            try {
                await loadHistoricalData(id);
                
                // Start Webull candles poller for real-time updates
                await webullCandlesPoller.start(id, ticker, true);
                log(`📡 Started Webull candles poller for ${ticker}`, 'info');
                
                // Initial data fetch
                updateMarketData();
            } catch (e) {
                log(`Failed to load market data for ${ticker}: ${e.message}`, 'error');
                
                // Check if error is 404 (invalid ticker) or 5xx (server issue)
                const is404 = e.message && (e.message.includes('404') || e.message.includes('Not Found'));
                const is5xx = e.message && /5\d{2}/.test(e.message); // 500-599 status codes
                
                // Only mark as invalid and clear UI for 404 errors (ticker doesn't exist)
                // Don't mark as invalid for 5xx errors (temporary API server issues)
                if (is404 && !is5xx) {
                    appState.invalidTickers.add(ticker);
                    clearInvalidTickerUI();
                    renderWatchlist(); // Re-render to show red indicator
                }
                // 5xx errors: silent retry (temporary server issues)
            }

            // Refresh account/position box for this ticker
            refreshPaperAccountView();
        } else {
            log(`Could not find ID for ${ticker}`, 'error');
            appState.invalidTickers.add(ticker);
            clearInvalidTickerUI();
            renderWatchlist();
        }
    } else {
        // Not connected to Webull - try to populate from cached options anyway
        try {
            populateExpiryDates(ticker);
            // Don't hide strike buttons if expiry was auto-selected
            // (populateExpiryDates already shows them if an expiry was selected)
        } catch (e) {
            console.error('populateExpiryDates failed', e);
        }
    }
}

// Load today's session data - try historical bars first, fallback to real-time building
async function loadHistoricalData(tickerId) {
    try {
        // Preserve any candles we might already have (e.g., from localStorage)
        const existingCandles = Array.isArray(appState.candleHistory)
            ? [...appState.candleHistory]
            : [];

        // Try to get recent intraday bars (1-minute). For Polygon, request enough
        // Load historical candles from Webull
        log('Fetching 1-minute historical bars from Webull...', 'info');
        const webullCount = 800; // ~800 minutes of historical data
        const bars = await api.getHistoricalBars(tickerId, 'm1', webullCount);
        
        if (bars) {
            const candles = [];
            
            // Handle format 1: {data: [{timestamp, open, high, low, close}]}
            if (bars.data && Array.isArray(bars.data) && bars.data.length > 0) {
                for (const bar of bars.data) {
                    if (!bar) continue;
                    
                    // New query-mini format already has parsed timestamps
                    let timestamp = bar.timestamp || bar.time || bar.tradeTime;
                    const open = parseFloat(bar.open);
                    const high = parseFloat(bar.high);
                    const low = parseFloat(bar.low);
                    const close = parseFloat(bar.close);
                    
                    if (timestamp && !isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
                        // If timestamp is in milliseconds, convert to seconds
                        if (timestamp > 10000000000) {
                            timestamp = Math.floor(timestamp / 1000);
                        }
                        // If timestamp is already in seconds (Unix timestamp), use as-is
                        
                        candles.push({
                            time: timestamp,
                            open: open,
                            high: high,
                            low: low,
                            close: close
                        });
                    }
                }
            }
            
            // Handle format 2: {dates: [...], data: [{open, high, low, close}]}
            if (bars.dates && bars.data && bars.dates.length === bars.data.length) {
                for (let i = 0; i < bars.dates.length; i++) {
                    const timestamp = bars.dates[i];
                    const bar = bars.data[i];
                    if (!bar) continue;
                    
                    const open = parseFloat(bar.open);
                    const high = parseFloat(bar.high);
                    const low = parseFloat(bar.low);
                    const close = parseFloat(bar.close);
                    
                    if (!isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
                        candles.push({
                            time: Math.floor(new Date(timestamp).getTime() / 1000),
                            open: open,
                            high: high,
                            low: low,
                            close: close
                        });
                    }
                }
            }
            
            // If we got candles, use them
            if (candles.length > 0) {
                // Sanitize + sort by time (strictly ascending)
                // Note: sanitizeCandles() now filters out pre-market & after-hours automatically
                const sanitized = sanitizeCandles(candles);
                
                // Store in history for real-time building
                appState.candleHistory = sanitized;
                
                // Derive today's session range from candles for the CURRENT EST trading day only.
                const { todayHigh, todayLow, todayOpen } = computeTodaySessionRange(sanitized);
                appState.todayOpen = todayOpen;
                appState.todayHigh = todayHigh;
                appState.todayLow = todayLow;

                // Compute pre-market high/low from candles (EST 4:00–9:30 for *today* only)
                computePremarketLevelsFromCandles(sanitized);

                // Load candles into chart
                chartManager.updateData(sanitized);

                // Draw PDH/PDL from the actual previous session we just loaded so
                // that the lines sit exactly on top of the visible prior-day candles.
                const prevSessionLevels = computePreviousSessionHighLow(sanitized);
                if (prevSessionLevels) {
                    chartManager.drawLevels(prevSessionLevels.high, prevSessionLevels.low);
                    // Apply initial visibility based on appState toggles.
                    if (typeof chartManager.setPDHVisible === 'function') {
                        chartManager.setPDHVisible(appState.showPDH);
                    }
                    if (typeof chartManager.setPDLVisible === 'function') {
                        chartManager.setPDLVisible(appState.showPDL);
                    }
                    log(`✓ PDH/PDL from previous session candles → High: $${prevSessionLevels.high.toFixed(2)}, Low: $${prevSessionLevels.low.toFixed(2)}`, 'info');
                } else {
                    // Fallback: if for some reason we can't derive a previous
                    // session from candles, skip PDH/PDL for now
                    log('Unable to derive PDH/PDL from candles - will try again when more data arrives', 'warn');
                }
                
                log(`✓ Loaded ${candles.length} intraday candles`, 'success');
                return;
            }
        }
        
        // No usable historical bars from API – fall back to whatever we already have
        log('❌ Historical bars unavailable. Chart will remain empty until real-time candles build.', 'error');
        log('⚠️ REAL DATA ONLY MODE - No mock/summary candles will be shown', 'warn');
        
        const quote = await api.getQuote(tickerId);
        if (quote && quote.close) {
            const high = parseFloat(quote.high || quote.close);
            const low = parseFloat(quote.low || quote.close);
            
            // Store today's indicative range
            appState.todayOpen = parseFloat(quote.open || quote.close);
            appState.todayHigh = high;
            appState.todayLow = low;
            
            // If we had locally saved candles from a previous session, keep showing them
            // instead of wiping the chart when the API lacks historical bars.
            if (existingCandles.length > 0) {
                const sanitizedExisting = sanitizeCandles(existingCandles);
                appState.candleHistory = sanitizedExisting;
                chartManager.updateData(sanitizedExisting);
                log(`Using ${sanitizedExisting.length} locally saved candles as fallback history.`, 'info');
            } else {
                // Otherwise start with an empty chart – real-time candles will build as market moves
                appState.candleHistory = [];
                chartManager.updateData([]);
            }
            
            // When we don't have intraday bars, we'll skip PDH/PDL for now
            // (Webull candles will provide this data when they arrive)
            {
                try {
                    // Skip PDH/PDL when no historical data available
                    const prev = null;
                    if (prev) {
                        chartManager.drawLevels(prev.high, prev.low);
                        log(`✓ PDH/PDL from Polygon prev session → High: $${prev.high.toFixed(2)}, Low: $${prev.low.toFixed(2)}`, 'info');
                    }
                } catch (e) {
                    log(`Failed to load previous-day OHLC from Polygon: ${e.message}`, 'warn');
                }
            }
            
            log(`✓ Ready to build REAL 1-minute candles as market updates`, 'info');
        } else {
            log('❌ No price data available', 'error');
        }
    } catch (e) {
        log(`Failed to load chart data: ${e.message}`, 'error');
    }
}

// Compute helper: split candles by EST date into sessions.
function groupCandlesByEstSession(candles) {
    const sessions = new Map(); // key: 'YYYY-MM-DD' (EST), value: { high, low, openTime, openPrice }
    if (!Array.isArray(candles)) return sessions;

    for (const c of candles) {
        if (!c || !c.time || c.high == null || c.low == null || c.open == null) continue;

        const tsMs = c.time * 1000;
        const estDate = new Date(new Date(tsMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const y = estDate.getFullYear();
        const m = estDate.getMonth() + 1;
        const d = estDate.getDate();
        const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        let sess = sessions.get(key);
        if (!sess) {
            sess = {
                high: Number(c.high),
                low: Number(c.low),
                openTime: c.time,
                openPrice: Number(c.open)
            };
            sessions.set(key, sess);
        } else {
            const high = Number(c.high);
            const low = Number(c.low);
            if (!isNaN(high)) sess.high = Math.max(sess.high, high);
            if (!isNaN(low)) sess.low = Math.min(sess.low, low);
            // Track earliest candle as "open"
            if (c.time < sess.openTime) {
                sess.openTime = c.time;
                sess.openPrice = Number(c.open);
            }
        }
    }

    return sessions;
}

// Compute today's regular-session range (approx; uses intraday candles for today's EST date).
function computeTodaySessionRange(candles) {
    const sessions = groupCandlesByEstSession(candles);
    if (sessions.size === 0) {
        return { todayHigh: 0, todayLow: 0, todayOpen: 0 };
    }

    const nowEst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const y = nowEst.getFullYear();
    const m = nowEst.getMonth() + 1;
    const d = nowEst.getDate();
    const todayKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const todaySession = sessions.get(todayKey);
    if (!todaySession) {
        return { todayHigh: 0, todayLow: 0, todayOpen: 0 };
    }

    return {
        todayHigh: todaySession.high || 0,
        todayLow: todaySession.low || 0,
        todayOpen: todaySession.openPrice || 0
    };
}

// Compute previous regular session high/low for PDH/PDL lines.
function computePreviousSessionHighLow(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return null;

    // Helper to get EST date string
    const dateKeyFor = (sec) => {
        const d = new Date(sec * 1000);
        const est = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const y = est.getFullYear();
        const m = est.getMonth() + 1;
        const day = est.getDate();
        return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };

    const nowEst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const y = nowEst.getFullYear();
    const m = nowEst.getMonth() + 1;
    const d = nowEst.getDate();
    const todayKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    const byDate = new Map();
    for (const c of candles) {
        if (!c || typeof c.time !== 'number') continue;
        const key = dateKeyFor(c.time);
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(c);
    }

    const allDates = Array.from(byDate.keys()).sort();
    const prevDates = allDates.filter(k => k < todayKey);
    if (prevDates.length === 0) return null;

    const prevKey = prevDates[prevDates.length - 1];
    const prevDayCandles = byDate.get(prevKey) || [];
    if (!prevDayCandles.length) return null;

    let high = null;
    let low = null;
    for (const candle of prevDayCandles) {
        const ch = Number(candle.high);
        const cl = Number(candle.low);
        if (!isNaN(ch)) high = high == null ? ch : Math.max(high, ch);
        if (!isNaN(cl)) low = low == null ? cl : Math.min(low, cl);
    }

    if (high == null || low == null) return null;
    return { high, low };
}

// Compute Opening Range High/Low from intraday candles.
// Definition: for the CURRENT EST trading day, look at candles between
// 09:30 and 09:35 (first 5 minutes of regular session) and take:
// - ORH = max(high)
// - ORL = min(low)
function computePremarketLevelsFromCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;

    let orHigh = null;
    let orLow = null;

    const orStartMinutes = 9 * 60 + 30;  // 09:30
    const orEndMinutes = 9 * 60 + 35;    // 09:35 (exclusive)

    for (const c of candles) {
        if (!c || !c.time || c.high == null || c.low == null) continue;

        const tsMs = c.time * 1000;
        const estDate = new Date(new Date(tsMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const minutes = estDate.getHours() * 60 + estDate.getMinutes();
        const dayOfWeek = estDate.getDay(); // 0=Sun,6=Sat

        // Skip weekends
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;

        if (minutes >= orStartMinutes && minutes < orEndMinutes) {
            const high = Number(c.high);
            const low = Number(c.low);
            if (!isNaN(high)) {
                orHigh = orHigh == null ? high : Math.max(orHigh, high);
            }
            if (!isNaN(low)) {
                orLow = orLow == null ? low : Math.min(orLow, low);
            }
        }
    }

    appState.premarketHigh = orHigh;
    appState.premarketLow = orLow;

    if (orHigh != null && orLow != null) {
        log(`✓ Opening Range computed (09:30–09:35 EST) → High: $${orHigh.toFixed(2)}, Low: $${orLow.toFixed(2)}`, 'info');
    } else {
        log('No opening range candles found for this session (ORH/ORL unavailable)', 'info');
    }
}

function updatePremarketLines() {
    if (!chartManager) return;

    // If user toggled on but we haven't computed levels yet, try from current candle history once
    if ((appState.showPremarketHigh || appState.showPremarketLow) &&
        appState.premarketHigh == null && appState.premarketLow == null &&
        Array.isArray(appState.candleHistory) && appState.candleHistory.length > 0) {
        computePremarketLevelsFromCandles(appState.candleHistory);
    }

    if (appState.showPremarketHigh && appState.premarketHigh != null) {
        chartManager.setPremarketHigh(appState.premarketHigh);
    } else {
        chartManager.setPremarketHigh(null);
    }

    if (appState.showPremarketLow && appState.premarketLow != null) {
        chartManager.setPremarketLow(appState.premarketLow);
    } else {
        chartManager.setPremarketLow(null);
    }
}

// Populate expiry dropdown with actual dates from cache
function populateExpiryDates(ticker) {
    if (!ui.expirySelect) return;
    
    // Clear existing options first
    ui.expirySelect.innerHTML = '';
    
    // Add placeholder option first
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = 'Select expiration date...';
    ui.expirySelect.appendChild(placeholderOption);
    
    if (!api || !api.optionCache || !api.optionCache.options || !api.optionCache.options[ticker]) {
        log(`No cached expiries for ${ticker}`, 'warn');
        return;
    }
    
    const tickerData = api.optionCache.options[ticker];
    const expiries = Object.keys(tickerData).sort(); // Sort chronologically
    
    if (expiries.length === 0) {
        log(`No expiries found for ${ticker}`, 'warn');
        return;
    }
    
    // Populate dropdown with available expiry dates
    expiries.forEach((date) => {
        const option = document.createElement('option');
        option.value = date;
        
        // Calculate days to expiry for display
        const expiryDate = new Date(date);
        const today = new Date();
        const daysToExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        // Count contracts for this expiry
        const contractCount = tickerData[date].length;
        
        option.textContent = `${date} (${daysToExpiry}d, ${contractCount} contracts)`;
        ui.expirySelect.appendChild(option);
    });
    
    // Ensure dropdown is enabled
    ui.expirySelect.disabled = false;
    ui.expirySelect.style.pointerEvents = 'auto';
    
    // Auto-select the first expiry (usually the weekly/closest expiration)
    if (expiries.length > 0) {
        const firstExpiry = expiries[0];
        ui.expirySelect.value = firstExpiry;
        appState.selectedExpiry = firstExpiry;
        
        // Show strike buttons section
        if (ui.strikeButtonsSection) {
            ui.strikeButtonsSection.style.display = 'block';
        }
        
        // Populate strikes for this expiry
        setupStrikeButtons();
        fetchOptionData();
        
        log(`✅ Auto-selected first expiry: ${firstExpiry}`, 'success');
    } else {
        appState.selectedExpiry = null;
    }
    
    log(`✅ Loaded ${expiries.length} expiry dates for ${ticker}`, 'success');
}

// Check if options are cached for a ticker
function isOptionsCached(ticker) {
    return !!(api?.optionCache?.options?.[ticker] && 
              Object.keys(api.optionCache.options[ticker]).length > 0);
}

// Fetch options on-demand for a ticker
async function fetchOptionsOnDemand(ticker, tickerId) {
    // If already cached, just update symbolMap to include this tickerId
    if (isOptionsCached(ticker)) {
        // ✅ Update symbolMap so this tickerId maps to the symbol
        if (!api.optionCache.symbolMap) {
            api.optionCache.symbolMap = {};
        }
        api.optionCache.symbolMap[tickerId.toString()] = ticker;
        
        // Save updated symbolMap to disk
        if (typeof window.electron !== 'undefined') {
            window.electron.send('save-option-cache', {
                ticker,
                tickerId,
                options: api.optionCache.options[ticker],
                lastUpdate: api.optionCache.lastUpdate
            });
        }
        
        return true;
    }
    
    // Show loading state in expiry dropdown
    if (ui.expirySelect) {
        ui.expirySelect.innerHTML = '<option value="">Loading options...</option>';
        ui.expirySelect.disabled = true;
    }
    
    // Hide strike buttons while loading
    if (ui.strikeButtonsSection) {
        ui.strikeButtonsSection.style.display = 'none';
    }
    
    try {
        // Use cached options (OptionFetcher is deprecated)
        let options = null;
        
        if (api && api.optionCache && api.optionCache.options && api.optionCache.options[ticker]) {
            options = api.optionCache.options[ticker];
            console.log(`✅ Using cached options for ${ticker}`);
        } else {
            throw new Error(`No cached options available for ${ticker}. Please refresh the option cache.`);
        }
        
        // Check if options were fetched successfully
        if (!options || typeof options !== 'object') {
            throw new Error('Failed to load options - no data available');
        }
        
        // Count total contracts
        const totalContracts = Object.values(options).reduce(
            (sum, arr) => sum + arr.length, 0
        );
        
        // Update symbolMap for this ticker
        if (!api.optionCache.symbolMap) {
            api.optionCache.symbolMap = {};
        }
        api.optionCache.symbolMap[tickerId.toString()] = ticker;
        
        log(`✅ Loaded ${totalContracts} option contracts for ${ticker} from cache`, 'success');
        return true;
        
    } catch (error) {
        console.error(`❌ Failed to fetch options for ${ticker}:`, error);
        log(`Failed to fetch options for ${ticker}: ${error.message}`, 'error');
        
        // Show error in expiry dropdown
        if (ui.expirySelect) {
            ui.expirySelect.innerHTML = '<option value="">Failed to load options</option>';
            ui.expirySelect.disabled = true;
        }
        
        return false;
    }
}

// Populate strike dropdown for selected expiry (cascading dropdown pattern)
function populateStrikeDropdown(expiry) {
    if (!ui.strikeSelect) return;
    
    const ticker = appState.selectedTicker;
    const optionType = appState.selectedOptionType || 'call';
    
    // Clear and enable dropdown
    ui.strikeSelect.innerHTML = '<option value="">Select strike price...</option>';
    ui.strikeSelect.disabled = false;
    ui.strikeSelect.style.cursor = 'pointer';
    ui.strikeSelect.style.color = 'var(--cyber-text)';
    
    // Get strikes from cache
    if (!api || !api.optionCache || !api.optionCache.options || !api.optionCache.options[ticker]) {
        ui.strikeSelect.innerHTML = '<option value="">No strikes available</option>';
        ui.strikeSelect.disabled = true;
        log(`No cached strikes for ${ticker}`, 'warn');
        return;
    }
    
    const tickerData = api.optionCache.options[ticker];
    if (!tickerData[expiry]) {
        ui.strikeSelect.innerHTML = '<option value="">No strikes for this expiry</option>';
        ui.strikeSelect.disabled = true;
        log(`No strikes found for ${ticker} on ${expiry}`, 'warn');
        return;
    }
    
    // Filter strikes by option type (call/put)
    const allStrikes = tickerData[expiry]
        .filter(opt => opt.type === optionType)
        .sort((a, b) => a.strike - b.strike);
    
    if (allStrikes.length === 0) {
        ui.strikeSelect.innerHTML = `<option value="">No ${optionType}s available</option>`;
        ui.strikeSelect.disabled = true;
        return;
    }
    
    // Filter by strike count setting if enabled
    const stockPrice = appState.currentPrice || 0;
    const filteredStrikes = appState.strikeCount && stockPrice > 0
        ? selectStrikesAroundPrice(allStrikes.map(s => s.strike), stockPrice).map(strike => 
            allStrikes.find(s => s.strike === strike)
          ).filter(Boolean)
        : allStrikes;
    
    // Populate dropdown
    filteredStrikes.forEach((opt) => {
        const option = document.createElement('option');
        option.value = `${opt.strike}|${opt.tickerId}`;
        option.textContent = `$${opt.strike.toFixed(2)} ${optionType.toUpperCase()}`;
        ui.strikeSelect.appendChild(option);
    });
    
    log(`✅ Loaded ${filteredStrikes.length} ${optionType} strikes for ${expiry}`, 'success');
}

// Fetch and setup strike buttons with REAL Webull strikes
async function setupStrikeButtons() {
    if (!ui.strikeButtonsContainer) return;
    
    const stockPrice = appState.currentPrice || 0;
    if (stockPrice === 0) {
        // Show placeholder buttons
        const buttons = ui.strikeButtonsContainer.querySelectorAll('.strike-btn');
        buttons.forEach(btn => {
            btn.innerHTML = '<div class="strike-price">--</div><div class="strike-label">--</div>';
        });
        return;
    }
    
    const ticker = appState.selectedTicker;
    const optionType = appState.selectedOptionType || 'call';
    const daysToExpiry = getDaysToExpiry(); // Calculate days to expiry from selected date
    
    if (!ticker) {
        log('No ticker selected, using fallback strikes', 'warn');
        generateFallbackStrikes(stockPrice);
        return;
    }
    
    // 🎯 PRIORITY 1: Check if we have CACHED strikes for this ticker
    if (api && api.optionCache && api.optionCache.options && api.optionCache.options[ticker]) {
        const tickerData = api.optionCache.options[ticker];
        const expiries = Object.keys(tickerData);
        
        if (expiries.length > 0) {
            // Use the selected expiry from dropdown, or first available
            let selectedExpiry = appState.selectedExpiry;
            if (!selectedExpiry || !tickerData[selectedExpiry]) {
                selectedExpiry = expiries[0];
                appState.selectedExpiry = selectedExpiry;
            }
            
            const expiryData = tickerData[selectedExpiry];
            
            // Extract strikes for the selected option type
            const cachedStrikes = expiryData
                .filter(opt => opt.type === optionType)
                .map(opt => opt.strike)
                .sort((a, b) => a - b);
            
            if (cachedStrikes.length > 0) {
                // 🎯 Use cached strikes (they have real contract IDs for trading)
                // Filter based on strike count setting (6, 10, 20, 30, 50, or 'all')
                const filteredStrikes = selectStrikesAroundPrice(cachedStrikes, stockPrice);
                appState.availableStrikes = filteredStrikes;
                appState.selectedExpiry = selectedExpiry; // Store for order placement
                
                log(`✓ Using ${appState.availableStrikes.length} CACHED ${optionType} strikes from ${selectedExpiry} (${cachedStrikes.length} available)`, 'success');
                log(`📅 Expiry date locked: ${selectedExpiry}`, 'success');
                populateStrikeButtons(appState.availableStrikes, stockPrice);
                
                // Auto-select middle strike if none selected
                if (!appState.selectedStrike) {
                    const middleIndex = Math.floor(appState.availableStrikes.length / 2);
                    selectStrike(middleIndex);
                }
                return;
            }
        }
    }
    
    // 🔄 PRIORITY 2: Use fallback strike generation (Webull provides strikes via option chains)
    try {
        log(`No cached strikes found, using fallback strike generation for ${ticker}...`, 'info');
        generateFallbackStrikes(stockPrice);
    } catch (e) {
        log(`Failed to generate strikes: ${e.message}`, 'error');
        generateFallbackStrikes(stockPrice);
    }
}

// Select strikes centered around current stock price from available strikes
function selectStrikesAroundPrice(allStrikes, stockPrice) {
    if (!allStrikes || allStrikes.length === 0) return [];
    
    // If 'all' is selected, return all strikes
    if (appState.strikeCount === 'all') {
        return allStrikes;
    }
    
    const count = parseInt(appState.strikeCount) || 6;
    
    // If we have fewer strikes than requested, return all
    if (allStrikes.length <= count) {
        return allStrikes;
    }
    
    // Find the strike closest to current price
    let closestIndex = 0;
    let smallestDiff = Math.abs(allStrikes[0] - stockPrice);
    
    for (let i = 1; i < allStrikes.length; i++) {
        const diff = Math.abs(allStrikes[i] - stockPrice);
        if (diff < smallestDiff) {
            smallestDiff = diff;
            closestIndex = i;
        }
    }
    
    // Select N strikes centered around current price
    const halfCount = Math.floor(count / 2);
    const startIndex = Math.max(0, closestIndex - halfCount + 1);
    const endIndex = Math.min(allStrikes.length, startIndex + count);
    
    // If we hit the end of the array, adjust startIndex
    const adjustedStartIndex = Math.max(0, endIndex - count);
    
    return allStrikes.slice(adjustedStartIndex, endIndex);
}

// Generate fallback strikes when API fails (matches real option chain spacing)
function generateFallbackStrikes(stockPrice) {
    // Standard option strike increments based on price
    let strikeIncrement;
    if (stockPrice < 10) {
        strikeIncrement = 0.5; // $0.50 for cheap stocks
    } else if (stockPrice < 50) {
        strikeIncrement = 1; // $1.00 for stocks under $50
    } else {
        strikeIncrement = 2.5; // $2.50 for major stocks (AAPL, TSLA, SPY, etc.)
    }
    
    // Find the closest strike BELOW current price (for symmetry)
    const baseStrike = Math.floor(stockPrice / strikeIncrement) * strikeIncrement;
    
    // Generate strikes based on selected count
    const count = appState.strikeCount === 'all' ? 50 : parseInt(appState.strikeCount) || 6;
    const halfCount = Math.floor(count / 2);
    
    const strikes = [];
    for (let i = -halfCount + 1; i <= halfCount; i++) {
        const strike = baseStrike + (i * strikeIncrement);
        if (strike > 0) { // Don't generate negative strikes
            strikes.push(strike);
        }
    }
    
    appState.availableStrikes = strikes;
    log(`Generated ${strikes.length} fallback strikes around $${stockPrice.toFixed(2)} (increment: $${strikeIncrement}): ${strikes.map(s => s.toFixed(2)).join(', ')}`, 'info');
    populateStrikeButtons(strikes, stockPrice);
    
    // Auto-select first OTM strike (index 3)
    if (!appState.selectedStrike) {
        selectStrike(3);
    }
}

// Populate strike buttons with given strikes
function populateStrikeButtons(strikes, stockPrice) {
    const container = ui.strikeButtonsContainer;
    if (!container) {
        log('Strike buttons container not found!', 'error');
        return;
    }
    
    if (!strikes || strikes.length === 0) {
        log('No strikes to populate!', 'error');
        return;
    }
    
    // Clear existing buttons
    container.innerHTML = '';
    
    log(`Populating ${strikes.length} strikes`, 'info');
    
    // Create a button for each strike
    strikes.forEach((strike, index) => {
        const button = document.createElement('button');
        button.className = 'strike-btn';
        button.dataset.index = index;
        
        const isITM = appState.selectedOptionType === 'call' 
            ? strike < stockPrice 
            : strike > stockPrice;
        
        const percent = ((strike - stockPrice) / stockPrice * 100).toFixed(1);
        const label = isITM ? 'ITM' : 'OTM';
        
        // Calculate theoretical delta for this strike
        const daysToExpiry = getDaysToExpiry();
        const delta = calculateBlackScholesDelta(stockPrice, strike, daysToExpiry, appState.selectedOptionType);
        
        // Format strike price without dollar sign
        button.innerHTML = `
            <div class="strike-price">${strike.toFixed(2)}</div>
            <div class="strike-label">${label} ${Math.abs(parseFloat(percent)).toFixed(1)}%</div>
            <div class="strike-delta">Δ ${Math.abs(delta).toFixed(3)}</div>
        `;
        
        // Add CSS classes
        button.classList.add(isITM ? 'itm' : 'otm');
        
        // Highlight the selected strike
        if (appState.selectedStrike && Math.abs(strike - appState.selectedStrike) < 0.01) {
            button.classList.add('selected');
        }
        
        container.appendChild(button);
    });
    
    // 🔍 Collect contract IDs and start polling prices
    const contractIds = [];
    const contractIdMap = {};
    
    strikes.forEach((strike, idx) => {
        // Check option cache for contract ID
        if (api.optionCache && api.optionCache.options && api.optionCache.options[appState.selectedTicker]) {
            const expiry = appState.selectedExpiry || getExpiryDate(7);
            const type = appState.selectedOptionType; // 'call' or 'put'
            
            // Search through expiries in cache
            for (const expiryDate in api.optionCache.options[appState.selectedTicker]) {
                const options = api.optionCache.options[appState.selectedTicker][expiryDate];
                
                if (!Array.isArray(options)) {
                    continue;
                }
                
                const match = options.find(opt => {
                    const strikeMatch = Math.abs(opt.strike - strike) < 0.01;
                    const typeMatch = opt.type === type;
                    return strikeMatch && typeMatch;
                });
                
                if (match) {
                    contractIds.push(match.tickerId);
                    contractIdMap[match.tickerId] = {
                        strike: strike,
                        type: type,
                        expiry: expiryDate,
                        buttonIndex: idx
                    };
                    break;
                }
            }
        }
    });
    
    // Start polling if we have contract IDs
    if (contractIds.length > 0) {
        optionPricePollerDebug.startBatchPolling(contractIds, 1000);
    }
}

// Helper function to calculate expiry date (legacy, kept for compatibility)
function getExpiryDate(daysToExpiry) {
    const date = new Date();
    date.setDate(date.getDate() + daysToExpiry);
    return date.toISOString().split('T')[0]; // Format: YYYY-MM-DD
}

// Helper function to get days to expiry from selected date
function getDaysToExpiry() {
    if (!appState.selectedExpiry) {
        return 7; // Default fallback
    }
    
    const expiryDate = new Date(appState.selectedExpiry);
    const today = new Date();
    const daysToExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    return Math.max(0, daysToExpiry); // Don't return negative days
}

// Fetch option data immediately (for instant updates when selecting strikes)
async function fetchOptionData() {
    const hasStrike = appState.selectedStrike != null;

    if (!hasStrike || !appState.selectedTicker || !appState.optionContractId) {
        appState.optionPriceIsReal = false;
        appState.optionDeltaIsReal = false;
        updateCalculations();
        return;
    }

    try {
        // Use Webull API to get real option quote (price, Greeks, etc.)
        const quote = await api.getOptionQuote(appState.optionContractId);
        
        if (!quote) {
            throw new Error('No quote data returned');
        }

        // Extract bid/ask/mark price
        const bid = quote.bidList?.[0]?.price ? parseFloat(quote.bidList[0].price) : 0;
        const ask = quote.askList?.[0]?.price ? parseFloat(quote.askList[0].price) : 0;
        const last = parseFloat(quote.close || 0);
        const mark = bid && ask ? (bid + ask) / 2 : last;

        if (mark > 0 && isFinite(mark)) {
            appState.currentOptionPrice = mark;
            appState.optionPriceIsReal = true;
            log(`✓ Option price set: $${mark.toFixed(2)} (Webull mark price)`, 'success');

            // Extract Greeks from Webull
            const delta = parseFloat(quote.delta || 0);
            
            if (delta !== 0 && isFinite(delta)) {
                appState.currentOptionDelta = delta;
                appState.optionDeltaIsReal = true;
                log(`✓ Delta set: ${delta.toFixed(4)}`, 'success');

                const deltaStatus = {
                    delta: delta,
                    isLive: true,
                    sampleCount: 0,
                    source: 'Webull Options (Real-time)',
                };
                updateDeltaDisplay(deltaStatus);
            } else {
                appState.currentOptionDelta = 0;
                appState.optionDeltaIsReal = false;
                clearDeltaDisplay();
                log(`⚠️ No delta from Webull`, 'warn');
            }

            // Re-run calculator with freshest real data.
            updateCalculations();
        } else {
            appState.optionPriceIsReal = false;
            appState.optionDeltaIsReal = false;
            clearDeltaDisplay();
            log(`⚠️ Invalid option price from Webull`, 'warn');
            updateCalculations();
        }
    } catch (optErr) {
        log(`Webull option snapshot failed: ${optErr.message}`, 'error');
        appState.optionPriceIsReal = false;
        appState.optionDeltaIsReal = false;
        clearDeltaDisplay();
        updateCalculations();
    }
}

// Select a strike by button index
async function selectStrike(index) {
    if (!appState.availableStrikes || !appState.availableStrikes[index]) return;
    
    const strike = appState.availableStrikes[index];
    const stockPrice = appState.currentPrice || 0;
    
    appState.selectedStrike = strike;
    
    // Skip option contract fetching when market is closed (Webull returns 417 errors)
    if (!appState.marketActuallyOpen) {
        console.log('🔒 Market is closed - skipping option contract ID fetch (will be fetched when market opens)');
        appState.optionContractId = null;
        appState.stockTickerId = appState.tickerId;
        // Continue to update UI below
    }
    // Fetch Webull option contract ID for trading (only if connected AND market is open)
    else if (appState.isConnected && appState.tickerId) {
        try {
            const direction = appState.selectedOptionType === 'call' ? 'call' : 'put';
            
            // 🎯 Use cached expiry date if available, otherwise calculate
            let expiryDate;
            if (appState.selectedExpiry) {
                expiryDate = appState.selectedExpiry;
                console.log(`📅 Using SELECTED expiry date: ${expiryDate}`);
            } else {
                const daysToExpiry = getDaysToExpiry();
                const targetDate = getExpiryDate(daysToExpiry); // Format: YYYY-MM-DD
                
                // Fetch available expiry dates from Webull
                console.log(`🔍 Fetching available expiry dates for ${appState.selectedTicker}...`);
                const expiryDatesResponse = await api.getOptionDates(appState.tickerId);
                
                expiryDate = targetDate;
                
                if (expiryDatesResponse && expiryDatesResponse.data && expiryDatesResponse.data.length > 0) {
                    const availableDates = expiryDatesResponse.data.map(d => d.date || d);
                    console.log(`📅 Available expiry dates: ${availableDates.slice(0, 5).join(', ')}...`);
                    
                    // Find the closest expiry date to our target
                    const targetTime = new Date(targetDate).getTime();
                    let closestDate = availableDates[0];
                    let smallestDiff = Math.abs(new Date(availableDates[0]).getTime() - targetTime);
                    
                    for (const date of availableDates) {
                        const diff = Math.abs(new Date(date).getTime() - targetTime);
                        if (diff < smallestDiff) {
                            smallestDiff = diff;
                            closestDate = date;
                        }
                    }
                    
                    expiryDate = closestDate;
                    console.log(`📅 Using closest available expiry: ${expiryDate} (target was ${targetDate})`);
                } else {
                    console.warn('⚠️ Could not fetch available expiry dates, using calculated date');
                }
            }
            
            console.log(`🔍 Looking up Webull option contract ID for ${appState.selectedTicker} $${strike} ${direction} exp ${expiryDate}`);
            
            const optionId = await api.getOptionTickerId(appState.tickerId, strike, expiryDate, direction);
            
            if (optionId) {
                appState.optionContractId = optionId;
                appState.stockTickerId = appState.tickerId; // Store underlying stock ID separately
                console.log(`✅ Option contract ID: ${optionId} (Stock ID: ${appState.tickerId})`);
            } else {
                console.warn(`⚠️ Could not fetch option contract ID for strike $${strike}`);
                appState.optionContractId = null;
            }
        } catch (e) {
            console.error(`❌ Error fetching option contract ID: ${e.message}`);
            appState.optionContractId = null;
        }
    }
    
    // Update selected strike display
    const isITM = appState.selectedOptionType === 'call' 
        ? strike < stockPrice 
        : strike > stockPrice;
    const percent = ((strike - stockPrice) / stockPrice * 100).toFixed(1);
    const label = isITM ? 'ITM' : 'OTM';
    
    if (ui.selectedStrikePrice) {
        ui.selectedStrikePrice.textContent = strike.toFixed(2);
    }
    if (ui.selectedStrikeLabel) {
        ui.selectedStrikeLabel.textContent = `${label} ${Math.abs(parseFloat(percent)).toFixed(1)}%`;
        ui.selectedStrikeLabel.style.color = isITM ? 'var(--cyber-green)' : '#ffab00';
    }
    
    // Update button selection visually
    const buttons = ui.strikeButtonsContainer?.querySelectorAll('.strike-btn');
    buttons?.forEach((btn, i) => {
        if (i === index) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });
    
    log(`Strike selected: $${strike.toFixed(2)} (${label})`, 'info');
    
    // Immediately fetch real option data from Webull for instant contract calculation
    fetchOptionData();
    
    // CRITICAL: Recalculate option metrics with new strike
    recalculateOptionMetrics();
    
    // Update preview TP/SL lines if enabled
    updatePreviewTPSL();
}

// Update preview TP/SL lines based on selected strike and expected move
function updatePreviewTPSL() {
    const stockPrice = appState.currentPrice;
    const strike = appState.selectedStrike;
    const optionType = appState.selectedOptionType;
    
    if (!stockPrice || !strike) return;
    
    // Get expected move from input
    const expectedMove = ui.move ? parseFloat(ui.move.value) || 0 : 0;
    if (expectedMove === 0) return;
    
    // Check if auto-stop or auto-tp are enabled
    const autoStopEnabled = ui.autoStopCheckbox && ui.autoStopCheckbox.checked;
    const autoTpEnabled = ui.autoTpCheckbox && ui.autoTpCheckbox.checked;
    
    // Calculate TP/SL stock prices based on option type and expected move
    let stopLossPrice = null;
    let takeProfitPrice = null;
    
    if (optionType === 'call') {
        // For calls:
        // - Take profit when stock moves UP by expected move
        // - Stop loss when stock moves DOWN by expected move
        takeProfitPrice = stockPrice + expectedMove;
        stopLossPrice = stockPrice - expectedMove;
    } else {
        // For puts:
        // - Take profit when stock moves DOWN by expected move
        // - Stop loss when stock moves UP by expected move
        takeProfitPrice = stockPrice - expectedMove;
        stopLossPrice = stockPrice + expectedMove;
    }
    
    // Draw preview lines if toggles are enabled
    if (autoStopEnabled && stopLossPrice) {
        chartManager.setStopLoss(stopLossPrice);
    }
    
    if (autoTpEnabled && takeProfitPrice) {
        chartManager.setTakeProfit(takeProfitPrice);
    }
}

// Recalculate option price, delta, and all trade metrics
function recalculateOptionMetrics() {
    if (!appState.currentPrice || appState.currentPrice === 0) return;
    
    // Calculate estimated option price for current strike (theoretical, driven
    // off real-time underlying price). This is ONLY used to preview premium
    // when we do NOT have real Polygon/Webull option quotes.
    const optionPrice = calculateMockOptionPrice(appState.currentPrice, appState.selectedOptionType);
    appState.currentOptionPrice = optionPrice;

    // IMPORTANT: Do NOT compute or display theoretical delta here, and do NOT
    // re-run contract sizing. This keeps the user from acting on non-real data.
}

// Use var so we can safely reference this before its declaration when wiring
// Polygon polling inside init() without hitting the temporal dead zone.
var marketDataInterval = null;
let watchlistInterval = null;
let isResizingConsole = false;
let consoleResizeStartY = 0;
let consoleResizeStartHeight = 0;
let currentConsoleFilter = 'all';

function applyConsoleFilter() {
    if (!ui.logsInner) return;
    const filter = currentConsoleFilter = (document.querySelector('.console-tab.active')?.dataset.filter || 'all');
    const entries = ui.logsInner.querySelectorAll('.log-entry');
    entries.forEach(entry => {
        const src = entry.dataset.source || 'app';
        const type = entry.dataset.type || 'info';
        let show = true;
        if (filter === 'app') {
            // Activity: hide API spam, but always show errors/warns
            show = (src !== 'api') || (type === 'error' || type === 'warn');
        } else if (filter === 'api') {
            show = (src === 'api');
        } else {
            show = true;
        }
        entry.style.display = show ? '' : 'none';
    });
}

async function startDataPolling() {
    // Clear existing intervals if any
    if (marketDataInterval) clearInterval(marketDataInterval);
    if (watchlistInterval) clearInterval(watchlistInterval);
    
    // Webull candles poller provides real-time updates automatically
    // No need for additional REST polling
    // marketDataInterval is not started (updates come from poller)
    
    // Watchlist polling (stays the same - updates watchlist sidebar)
    watchlistInterval = setInterval(updateWatchlistPrices, 10000);
    
    // Periodic candle save (every 5 minutes) to prevent data loss
    setInterval(() => {
        if (appState.candleHistory.length > 0) {
            saveCandles();
            // console.log(`💾 Auto-saved ${appState.candleHistory.length} candles`);
        }
    }, 5 * 60 * 1000); // 5 minutes

// Ensure we persist the latest candles when the window is closed or reloaded.
window.addEventListener('beforeunload', () => {
    try {
        saveCandles();
    } catch (e) {
        console.error('Failed to save candles on unload:', e);
    }
});
    
    // Initial update will come from Webull candles poller
    // No need for manual update here
    
    // Also refresh account/positions view once on connect
    refreshPaperAccountView();

    // Ensure a ticker is fully selected once we are polling
    if (appState.isConnected) {
        if (appState.selectedTicker) {
            selectTicker(appState.selectedTicker);
        } else if (appState.watchlist && appState.watchlist.length > 0) {
            selectTicker(appState.watchlist[0]);
        }
    }
}

// Adjust polling frequency based on market status
// NOTE: This is now a no-op when using Webull candles poller (real-time streaming)
function adjustPollingFrequency(isMarketOpen) {
    // Skip - Webull candles poller handles all updates
    log(`📡 Using Webull candles poller - no polling adjustment needed`, 'info');
    return;
    
    if (marketDataInterval) clearInterval(marketDataInterval);
    
    if (isMarketOpen) {
        // Market open: poll every 1 second for maximum responsiveness
        marketDataInterval = setInterval(updateMarketData, 1000);
    } else {
        // Market closed: poll every 10 seconds (no need to spam)
        marketDataInterval = setInterval(updateMarketData, 10000);
    }
}

function setupTradePanelEditor() {
    if (!ui.tradePanel) return;

    const sections = Array.from(ui.tradePanel.querySelectorAll('.trade-section'));
    if (sections.length === 0) return;

    // Restore saved layout (order + hidden + collapsed)
    try {
        const saved = JSON.parse(localStorage.getItem('tradePanelLayout') || '{}');
        const order = saved.order || [];
        const hiddenSections = saved.hiddenSections || {};
        const hiddenCells = saved.hiddenCells || {};
        const collapsedSections = saved.collapsedSections || {};

        if (order.length) {
            order.forEach(id => {
                const s = sections.find(sec => sec.dataset.sectionId === id);
                if (s) ui.tradePanel.appendChild(s);
            });
            // Append any sections that weren't in saved order
            sections.forEach(sec => {
                if (!order.includes(sec.dataset.sectionId)) {
                    ui.tradePanel.appendChild(sec);
                }
            });
        }

        sections.forEach(sec => {
            const id = sec.dataset.sectionId;
            if (hiddenSections[id]) {
                sec.style.display = 'none';
            }
            // Mark collapsed sections (body visibility will be applied in collapse handler below)
            if (collapsedSections[id]) {
                sec.classList.add('collapsed');
            }
        });

        // Restore hidden calc rows
        if (hiddenCells.live && ui.tradePanel) {
            const liveSection = ui.tradePanel.querySelector('.trade-section[data-section-id="live"]');
            if (liveSection) {
                liveSection.querySelectorAll('.calc-item').forEach(item => {
                    const cellId = item.dataset.cellId;
                    if (cellId && hiddenCells.live[cellId]) {
                        item.style.display = 'none';
                    }
                });
            }
        }

        // Restore hidden strike buttons
        if (hiddenCells.strike && ui.strikeButtonsContainer) {
            ui.strikeButtonsContainer.querySelectorAll('.strike-btn').forEach((btn, idx) => {
                if (hiddenCells.strike[idx]) {
                    btn.style.display = 'none';
                }
            });
        }
    } catch (e) {
        console.error('Failed to restore tradePanelLayout', e);
    }

    function saveTradePanelLayout() {
        const current = Array.from(ui.tradePanel.querySelectorAll('.trade-section'));
        const layout = {
            order: current.map(sec => sec.dataset.sectionId),
            hiddenSections: {},
            collapsedSections: {},
            hiddenCells: {
                live: {},
                strike: {}
            }
        };
        current.forEach(sec => {
            const id = sec.dataset.sectionId;
            if (sec.style.display === 'none') {
                layout.hiddenSections[id] = true;
            }
            if (sec.classList.contains('collapsed')) {
                layout.collapsedSections[id] = true;
            }
        });

        // Save hidden calc rows
        const liveSection = ui.tradePanel.querySelector('.trade-section[data-section-id="live"]');
        if (liveSection) {
            liveSection.querySelectorAll('.calc-item').forEach(item => {
                const cellId = item.dataset.cellId;
                if (cellId && item.style.display === 'none') {
                    layout.hiddenCells.live[cellId] = true;
                }
            });
        }

        // Save hidden strike buttons by index
        if (ui.strikeButtonsContainer) {
            ui.strikeButtonsContainer.querySelectorAll('.strike-btn').forEach((btn, idx) => {
                if (btn.style.display === 'none') {
                    layout.hiddenCells.strike[idx] = true;
                }
            });
        }
        try {
            localStorage.setItem('tradePanelLayout', JSON.stringify(layout));
        } catch (e) {
            console.error('Failed to persist tradePanelLayout', e);
        }
    }

    // Close (hide) sections
    sections.forEach(sec => {
        const closeBtn = sec.querySelector('.section-close');
        if (!closeBtn) return;
        closeBtn.addEventListener('click', () => {
            sec.style.display = 'none';
            saveTradePanelLayout();
        });
    });

    // Collapse / expand sections (e.g., Contract, Risk & Sizing, Trade Actions)
    sections.forEach(sec => {
        const collapseBtn = sec.querySelector('.section-collapse');
        if (!collapseBtn) return;

        // All direct children except header are considered the collapsible body
        const bodyChildren = Array.from(sec.children).filter(child => child.tagName !== 'H3');

        const setCollapsed = (collapsed) => {
            bodyChildren.forEach(el => {
                el.style.display = collapsed ? 'none' : '';
            });
            collapseBtn.textContent = collapsed ? '▸' : '▾';
            if (collapsed) {
                sec.classList.add('collapsed');
            } else {
                sec.classList.remove('collapsed');
            }
        };

        // Initial state: use restored collapsed flag if present, otherwise expanded
        const id = sec.dataset.sectionId;
        const startCollapsed = sec.classList.contains('collapsed');
        setCollapsed(startCollapsed);

        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentlyCollapsed = bodyChildren.length > 0 && bodyChildren[0].style.display === 'none';
            setCollapsed(!currentlyCollapsed);
            saveTradePanelLayout();
        });
    });

    // Hide individual calc rows
    if (ui.tradePanel) {
        ui.tradePanel.querySelectorAll('.trade-section[data-section-id="live"] .calc-item .cell-close')
            .forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const item = e.target.closest('.calc-item');
                    if (!item) return;
                    item.style.display = 'none';
                    saveTradePanelLayout();
                });
            });
    }

    // Hide individual strike buttons
    if (ui.strikeButtonsContainer) {
        ui.strikeButtonsContainer.addEventListener('click', (e) => {
            const close = e.target.closest('.cell-close');
            if (!close) return;
            e.stopPropagation();
            const btn = close.closest('.strike-btn');
            if (!btn) return;
            btn.style.display = 'none';
            saveTradePanelLayout();
        });
    }

    // Drag-and-drop reordering
    let draggingSection = null;

    sections.forEach(sec => {
        const handle = sec.querySelector('.section-handle');
        if (!handle) return;

        handle.addEventListener('mousedown', (e) => {
            if (!ui.tradePanel.classList.contains('editor-mode')) return;
            e.preventDefault();
            draggingSection = sec;
            sec.classList.add('dragging');

            const onMove = (ev) => {
                if (!draggingSection) return;
                const y = ev.clientY;
                const siblings = Array.from(ui.tradePanel.querySelectorAll('.trade-section'))
                    .filter(s => s !== draggingSection && s.style.display !== 'none');

                let insertBefore = null;
                for (const sib of siblings) {
                    const rect = sib.getBoundingClientRect();
                    if (y < rect.top + rect.height / 2) {
                        insertBefore = sib;
                        break;
                    }
                }

                if (insertBefore) {
                    ui.tradePanel.insertBefore(draggingSection, insertBefore);
                } else {
                    ui.tradePanel.appendChild(draggingSection);
                }
            };

            const onUp = () => {
                if (!draggingSection) return;
                draggingSection.classList.remove('dragging');
                draggingSection = null;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                saveTradePanelLayout();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });

    // Editor mode toggle
    if (ui.tradeEditorToggle) {
        ui.tradeEditorToggle.addEventListener('click', () => {
            const enabled = ui.tradePanel.classList.toggle('editor-mode');
            ui.tradeEditorToggle.textContent = enabled ? 'Done' : 'Editor Mode';
        });
    }

    // Reset layout to defaults
    if (ui.tradeEditorReset) {
        ui.tradeEditorReset.addEventListener('click', () => {
            try {
                localStorage.removeItem('tradePanelLayout');
            } catch (e) {
                console.error('Failed to clear tradePanelLayout', e);
            }
            // Simple reset: reload the window to re-render default layout
            window.location.reload();
        });
    }
}

// Update prices for all watchlist tickers
async function updateWatchlistPrices() {
    // Require Webull connection for watchlist data
    if (!appState.isConnected) return;
    
    // Performance: skip invalid tickers (cached) to avoid wasting API calls
    for (const ticker of appState.watchlist) {
        if (ticker === appState.selectedTicker) continue; // Skip active ticker (already updating)
        
        // PERFORMANCE: Skip tickers we already know are invalid (no wasted API calls!)
        if (appState.invalidTickers.has(ticker)) {
            continue;
        }
        
        try {
            let quote = null;
            const id = await api.getTickerID(ticker);
            if (id) {
                quote = await api.getQuote(id);
            }

            if (quote) {
                const price = parseFloat(quote.close || quote.price || quote.last);
                const change = parseFloat(quote.change || 0);
                
                if (price && !isNaN(price)) {
                    appState.watchlistPrices[ticker] = { price, change };
                    
                    // Clear invalid state if ticker was previously invalid but now works
                    appState.invalidTickers.delete(ticker);
                    
                    // Update display
                    const tickerItem = document.getElementById(`ticker-${ticker}`);
                    if (tickerItem) {
                        // Clear invalid state if ticker is now valid
                        tickerItem.classList.remove('ticker-invalid');
                        tickerItem.title = '';
                        
                        const priceSpan = tickerItem.querySelector('.ticker-price');
                        if (priceSpan) {
                            priceSpan.textContent = `$${price.toFixed(2)}`;
                            priceSpan.style.color = change >= 0 ? '#00c853' : '#ff1744';
                        }
                    }
                }
            }
        } catch (e) {
            // Check if error is 404 (invalid ticker) or 5xx (server issue)
            const is404 = e.message && (e.message.includes('404') || e.message.includes('Not Found'));
            const is5xx = e.message && /5\d{2}/.test(e.message); // 500-599 status codes
            
            // Only mark as invalid for 404 errors (ticker doesn't exist)
            // Don't mark as invalid for 5xx errors (temporary API server issues)
            if (is404 && !is5xx) {
                appState.invalidTickers.add(ticker);
                
                const tickerItem = document.getElementById(`ticker-${ticker}`);
                if (tickerItem) {
                    tickerItem.classList.add('ticker-invalid');
                    tickerItem.title = `⚠️ Invalid ticker: ${ticker.toUpperCase()} not found. Click X to remove.`;
                    
                    const priceSpan = tickerItem.querySelector('.ticker-price');
                    if (priceSpan) {
                        priceSpan.textContent = '404';
                        priceSpan.style.color = '#ff4444';
                    }
                }
            }
            // Silent fail: 404s cached as invalid, 5xx errors will retry (performance optimization)
        }
    }
}

// Save candles to localStorage (persist across app restarts)
function saveCandles() {
    if (!appState.selectedTicker) return;

    try {
        const storageKey = `${appState.candleStorageKey}${appState.selectedTicker}`;

        // Combine completed history with the current in-progress candle so we
        // don't lose the latest minute if the app is closed mid-bar.
        const base = Array.isArray(appState.candleHistory)
            ? [...appState.candleHistory]
            : [];
        if (appState.currentMinuteCandle) {
            base.push(appState.currentMinuteCandle);
        }
        if (base.length === 0) return;

        // Keep only last 390 candles (6.5 hours of 1-minute data)
        const maxCandles = 390;
        const candlesToSave = base.slice(-maxCandles);

        // Ensure we never persist corrupt/out-of-order candles
        const sanitized = sanitizeCandles(candlesToSave);

        const candleData = {
            ticker: appState.selectedTicker,
            candles: sanitized,
            savedAt: Date.now()
        };

        localStorage.setItem(storageKey, JSON.stringify(candleData));
        // console.log(`💾 Saved ${sanitized.length} candles for ${appState.selectedTicker}`);
    } catch (e) {
        console.error(`Failed to save candles: ${e.message}`);
    }
}

// Load candles from localStorage (restore on app restart or ticker change)
function loadCandles(ticker) {
    try {
        const storageKey = `${appState.candleStorageKey}${ticker}`;
        const savedData = localStorage.getItem(storageKey);
        
        if (!savedData) {
            log(`No saved candles found for ${ticker}`, 'info');
            return [];
        }
        
        const candleData = JSON.parse(savedData);
        
        // Check if data is too old (older than 1 day)
        const ageMs = Date.now() - candleData.savedAt;
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
        
        if (ageMs > maxAgeMs) {
            log(`Saved candles for ${ticker} are too old (${Math.floor(ageMs / 1000 / 60 / 60)} hours), discarding`, 'warn');
            localStorage.removeItem(storageKey);
            return [];
        }
        
        const rawCandles = candleData.candles || [];
        let sanitized = sanitizeCandles(rawCandles);

        // Drop any locally-saved candles older than ~2 days to avoid showing
        // very stale sessions (e.g. only Dec 2 plus today).
        const nowSec = Math.floor(Date.now() / 1000);
        const twoDaysAgo = nowSec - 2 * 24 * 60 * 60;
        const beforeFilterCount = sanitized.length;
        sanitized = sanitized.filter(c => c && typeof c.time === 'number' && c.time >= twoDaysAgo);

        if (beforeFilterCount !== sanitized.length) {
            log(`Discarded ${beforeFilterCount - sanitized.length} stale saved candles for ${ticker}`, 'warn');
        }
        
        log(`✓ Loaded ${sanitized.length} saved candles for ${ticker} (saved ${Math.floor(ageMs / 1000 / 60)} minutes ago)`, 'success');
        return sanitized;
        
    } catch (e) {
        console.error(`Failed to load candles: ${e.message}`);
        return [];
    }
}

// Update chart with pre-aggregated minute bar from Polygon (market-time aligned)
function updateChartWithMinuteBar(candle) {
    // ⚡ CRITICAL: Validate incoming candle data to prevent spike glitches
    // Reject invalid OHLC values
    if (!candle || 
        !isFinite(candle.open) || !isFinite(candle.high) || !isFinite(candle.low) || !isFinite(candle.close) ||
        candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
        console.warn(`⚠️ Rejected invalid AM bar:`, candle);
        return;
    }
    
    // Validate OHLC relationship (high must be highest, low must be lowest)
    if (candle.high < candle.open || candle.high < candle.close || 
        candle.low > candle.open || candle.low > candle.close ||
        candle.high < candle.low) {
        console.warn(`⚠️ Rejected malformed AM bar (invalid OHLC relationship):`, candle);
        return;
    }
    
    // Check for unrealistic range within a single minute (>10% is very suspicious)
    // Note: 5% was too strict and rejected valid volatile candles
    const range = candle.high - candle.low;
    const avgPrice = (candle.high + candle.low) / 2;
    const rangePercent = range / avgPrice;
    if (rangePercent > 0.10) {
        console.warn(`⚠️ Rejected AM bar with suspicious range: ${(rangePercent * 100).toFixed(2)}% (H:${candle.high} L:${candle.low})`);
        return;
    }
    
    // If we have a recent price, validate the candle is within reasonable distance
    if (appState.lastPrice && appState.lastPrice > 0) {
        const closeChange = Math.abs((candle.close - appState.lastPrice) / appState.lastPrice);
        const highChange = Math.abs((candle.high - appState.lastPrice) / appState.lastPrice);
        const lowChange = Math.abs((candle.low - appState.lastPrice) / appState.lastPrice);
        
        // Reject if any value is >10% away from last known price
        if (closeChange > 0.10 || highChange > 0.10 || lowChange > 0.10) {
            console.warn(`⚠️ Rejected AM bar too far from last price ($${appState.lastPrice.toFixed(2)}):`, candle);
            return;
        }
    }
    
    // Candle already has correct timestamp from Polygon (aligned to EST market time)
    const candleTimestamp = candle.time;
    
    // 🚫 FILTER: Don't display pre-market or after-hours candles
    if (!isMarketHours(candleTimestamp)) {
        // Silently skip - don't display pre-market or after-hours bars
        return;
    }
    
    // Get current minute timestamp in EST
    const nowUtc = new Date();
    const nowEst = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const currentMinute = new Date(
        nowEst.getFullYear(),
        nowEst.getMonth(),
        nowEst.getDate(),
        nowEst.getHours(),
        nowEst.getMinutes(),
        0,
        0
    );
    const currentMinuteTimestamp = Math.floor(currentMinute.getTime() / 1000);
    
    // Determine if this is a completed candle or current-minute update
    const isCurrentMinute = candleTimestamp === currentMinuteTimestamp;
    
    // Check if this candle already exists in history
    const existingIndex = appState.candleHistory.findIndex(c => c.time === candleTimestamp);
    
    if (existingIndex >= 0) {
        // Update existing candle
        appState.candleHistory[existingIndex] = {
            time: candleTimestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close
        };
        log(`📝 Updated existing candle at ${new Date(candleTimestamp * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} EST`, 'info');
    } else {
        // Add new completed candle to history
        const newCandle = {
            time: candleTimestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close
        };
        
        appState.candleHistory.push(newCandle);
        appState.candleHistory = sanitizeCandles(appState.candleHistory);
        
        const candleRange = candle.high - candle.low;
        const candleRangePercent = (candleRange / candle.close * 100).toFixed(2);
        log(`✅ Added new candle at ${new Date(candleTimestamp * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} EST: O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)} | Range: ${candleRangePercent}%`, 'success');
        
        // Save to localStorage
        saveCandles();
    }
    
    // 🔍 DEBUG: Log when AM bar replaces trade-built candle (detect visual spikes)
    const oldCandle = appState.currentMinuteCandle;
    if (oldCandle && oldCandle.time === candleTimestamp) {
        const highDiff = Math.abs(candle.high - oldCandle.high);
        const lowDiff = Math.abs(candle.low - oldCandle.low);
        const closeDiff = Math.abs(candle.close - oldCandle.close);
        
        // Calculate percentage changes
        const highChangePct = oldCandle.high > 0 ? (highDiff / oldCandle.high * 100) : 0;
        const lowChangePct = oldCandle.low > 0 ? (lowDiff / oldCandle.low * 100) : 0;
        
        // Calculate range changes
        const oldRange = oldCandle.high - oldCandle.low;
        const newRange = candle.high - candle.low;
        const rangeChange = newRange - oldRange;
        const rangeChangePct = oldRange > 0 ? (rangeChange / oldRange * 100) : 0;
        
        // 🚨 Detect visual spike from AM bar replacement
        // Only flag if absolute dollar change is significant (>$0.10)
        const isAMBarSpike = highDiff > 0.10 || lowDiff > 0.10 || (highDiff > 0.05 && lowDiff > 0.05);
        
        // Muted: AM bar update logging
        // if (isAMBarSpike) {
        //     console.error(`🚨 AM BAR SPIKE: H:${highDiff > 0.10 ? '+$' + highDiff.toFixed(2) : ''} L:${lowDiff > 0.10 ? '+$' + lowDiff.toFixed(2) : ''}`);
        // }
    }
    
    // Update the current minute candle state for intra-minute updates
    appState.currentMinuteCandle = {
        time: candleTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
    };
    
    // 🚨 CRITICAL: Mark that this candle was just updated by AM bar (historical correction)
    // This prevents retroactive SL triggers from historical low changes
    // Flag will be cleared on next live trade update
    appState.candleJustUpdatedByAMBar = true;
    appState.amBarUpdateTime = Date.now();
    
    // 🚀 OPTIMIZATION: Always use incremental update to avoid visual glitches
    // Using updateRealtime() prevents the entire chart from being replaced (no visual jump)
    // Wrap in try-catch because AM bars for current minute may have same timestamp as trade-built candle
    try {
        chartManager.updateRealtime(appState.currentMinuteCandle);
    } catch (error) {
        // Expected error when AM bar arrives for current minute (same timestamp as trade candle)
        // This is harmless - the candle data is already updated in appState
        if (!error.message.includes('Cannot update oldest data')) {
            console.error('❌ Error updating chart with AM bar:', error);
        }
    }
}

// Build real-time 1-minute candles from tick data (for intra-minute updates between Polygon bars)
function buildRealtimeCandle(price) {
    // ⚡ PRICE VALIDATION - Reject outlier trades that cause sky-high wicks
    if (!price || !isFinite(price) || price <= 0) {
        console.warn(`⚠️ Rejected invalid price: ${price}`);
        return;
    }
    
    // If we have a last known price, reject trades that jump more than 10%
    if (appState.lastPrice && appState.lastPrice > 0) {
        const percentChange = Math.abs((price - appState.lastPrice) / appState.lastPrice);
        if (percentChange > 0.10) { // 10% threshold
            console.warn(`⚠️ Rejected outlier trade: ${price} (${(percentChange * 100).toFixed(2)}% change from ${appState.lastPrice})`);
            return;
        }
    }
    
    // CRITICAL: Use EST timezone for market-aligned candles
    // Get current time in EST
    const nowUtc = new Date();
    const nowEst = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    
    // Get current minute timestamp (round down to start of minute) in EST
    const currentMinute = new Date(
        nowEst.getFullYear(),
        nowEst.getMonth(),
        nowEst.getDate(),
        nowEst.getHours(),
        nowEst.getMinutes(),
        0,
        0
    );
    const currentMinuteTimestamp = Math.floor(currentMinute.getTime() / 1000);
    
    // 🚫 FILTER: Don't build candles outside market hours
    if (!isMarketHours(currentMinuteTimestamp)) {
        // Silently skip - don't build pre-market or after-hours candles
        return;
    }
    
    // Check if we need to start a new candle
    if (!appState.currentMinuteCandle || 
        appState.currentMinuteCandle.time !== currentMinuteTimestamp) {
        
        // Save the previous candle if it exists
        if (appState.currentMinuteCandle) {
            appState.candleHistory.push(appState.currentMinuteCandle);
            // Clean any corrupt/out-of-order history before using it again
            appState.candleHistory = sanitizeCandles(appState.candleHistory);
            log(`Completed 1m candle at ${new Date(appState.currentMinuteCandle.time * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} EST: O:${appState.currentMinuteCandle.open.toFixed(2)} H:${appState.currentMinuteCandle.high.toFixed(2)} L:${appState.currentMinuteCandle.low.toFixed(2)} C:${appState.currentMinuteCandle.close.toFixed(2)}`, 'info');
            
            // Save candles to localStorage (persist across restarts)
            saveCandles();
        }
        
        // Start a new candle
        appState.currentMinuteCandle = {
            time: currentMinuteTimestamp,
            open: price,
            high: price,
            low: price,
            close: price
        };
        
        log(`🕯️ Started new 1m candle at ${new Date(currentMinuteTimestamp * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} EST: $${price.toFixed(2)}`, 'success');
        log(`📊 Total candles: ${appState.candleHistory.length + 1}`, 'info');
        
        // 🚀 Use incremental update to add new candle without visual glitch
        // updateRealtime() appends the new candle without replacing the entire chart
        chartManager.updateRealtime(appState.currentMinuteCandle);
        
    } else {
        // Update current candle with additional validation
        // Only update high if the new price is within reasonable range
        const currentOpen = appState.currentMinuteCandle.open;
        const percentFromOpen = Math.abs((price - currentOpen) / currentOpen);
        
        if (percentFromOpen <= 0.05) { // 5% max move within a single minute
            // ⚡ SMOOTHNESS: Only update if price changed meaningfully (at least 1 cent)
            // This prevents micro-jitter from tiny price fluctuations
            const lastClose = appState.currentMinuteCandle.close;
            const priceChanged = Math.abs(price - lastClose) >= 0.01;
            
            // Always update the internal state
            appState.currentMinuteCandle.high = Math.max(appState.currentMinuteCandle.high, price);
            appState.currentMinuteCandle.low = Math.min(appState.currentMinuteCandle.low, price);
            appState.currentMinuteCandle.close = price;
            
            // Only update chart if price changed meaningfully (reduces visual jitter)
            if (priceChanged) {
                // 🚀 Use incremental update for much smoother performance
                // (only updates the last candle instead of re-setting all data)
                chartManager.updateRealtime(appState.currentMinuteCandle);
            }
        } else {
            console.warn(`⚠️ Rejected intra-minute spike: ${price} (${(percentFromOpen * 100).toFixed(2)}% from candle open ${currentOpen})`);
        }
    }
    
    // Update session highs/lows for PDH/PDL lines
    if (price > appState.todayHigh || appState.todayHigh === 0) {
        // Track session high internally, but keep PDH line static intraday
        appState.todayHigh = price;
    }
    if (price < appState.todayLow || appState.todayLow === 0) {
        // Track session low internally, but keep PDL line static intraday
        appState.todayLow = price;
    }
}

async function updateMarketData() {
    // Require Webull connection and ticker ID
    if (!appState.isConnected || !appState.tickerId) return;
    
    try {
        // REAL DATA ONLY - NO MOCK FALLBACK
        const quote = await api.getQuote(appState.tickerId);
        
        if (!quote) {
            log('Quote fetch returned null', 'error');
            return;
        }
        
        // Log raw response for debugging (first time only)
        if (!appState.hasLoggedQuoteStructure) {
            log(`Quote structure: ${JSON.stringify(quote).substring(0, 300)}`, 'info');
            appState.hasLoggedQuoteStructure = true;
        }

        // Extract price from response (structure varies).
        // Prefer last (live) price, then close/other fallbacks.
        let price = null;
        if (quote.last) price = parseFloat(quote.last);
        else if (quote.close) price = parseFloat(quote.close);
        else if (quote.data?.close) price = parseFloat(quote.data.close);
        else if (quote.price) price = parseFloat(quote.price);

        if (!price || isNaN(price)) {
            log('Could not extract valid price from quote', 'error');
            return;
        }
        
        // Track successful update for network status
        appState.lastUpdateTimestamp = Date.now();

        // Update market status indicator
        const status = quote.status || quote.tradeStatus || 'D';
        
        // Debug: Log status code to understand what we're getting
        if (!appState.lastLoggedStatusCode || appState.lastLoggedStatusCode !== status) {
            console.log(`📡 Status Code: "${status}" | Time: ${new Date().toLocaleTimeString()}`);
            appState.lastLoggedStatusCode = status;
        }
        
        updateMarketStatus(status);

        // Update watchlist price display
        const change = parseFloat(quote.change || 0);
        appState.watchlistPrices[appState.selectedTicker] = {
            price: price,
            change: change
        };
        
        // Update watchlist item for current ticker (price only, keep symbol intact)
        const tickerItem = document.getElementById(`ticker-${appState.selectedTicker}`);
        if (tickerItem) {
            const priceSpan = tickerItem.querySelector('.ticker-price');
            if (priceSpan) {
                priceSpan.textContent = `$${price.toFixed(2)}`;
                priceSpan.style.color = change >= 0 ? '#00c853' : '#ff1744';
            }
        }
        
        // Update current price
        appState.currentPrice = price;
        
        // Update live stock price display with animation
        if (ui.liveStockPrice) {
            const priceChange = price - appState.lastPrice;
            ui.liveStockPrice.textContent = '$' + price.toFixed(2);
            
            // Color based on change
            if (priceChange > 0) {
                ui.liveStockPrice.style.color = 'var(--cyber-green)';
                ui.liveStockPrice.style.animation = 'pulse-green 0.5s ease';
            } else if (priceChange < 0) {
                ui.liveStockPrice.style.color = 'var(--cyber-pink)';
                ui.liveStockPrice.style.animation = 'pulse-red 0.5s ease';
            } else {
                ui.liveStockPrice.style.color = 'var(--cyber-blue)';
            }
            
            // Clear animation after it completes
            setTimeout(() => {
                if (ui.liveStockPrice) ui.liveStockPrice.style.animation = '';
            }, 500);
        }
        
        // Track if price is actually changing (to detect stale "Open" status)
        const priceChanged = appState.lastPrice > 0 && Math.abs(price - appState.lastPrice) > 0.001;
        
        if (priceChanged) {
            appState.lastPriceChangeTime = Date.now();
            // console.log(`💹 Price changed: ${appState.lastPrice.toFixed(2)} → ${price.toFixed(2)}`);
        }
        
        appState.lastPrice = price;

        // Open P&L now comes directly from Webull's unrealizedProfitLoss via refreshPaperAccountView
        
        // Update strike buttons (strike prices are relative to stock price)
        setupStrikeButtons();
        
        // 🚫 DO NOT BUILD CANDLES FROM POLLING DATA!
        // Candles are ONLY built from Polygon WebSocket:
        //   - Trade ticks (T) update close price only
        //   - Minute bars (AM) set official OHLC
        // This polling function is only for price display, not chart building
        const marketIsOpen = appState.marketActuallyOpen;

        // If "closed" by time-based rules, log that once for operator awareness.
        if (!marketIsOpen && !appState.hasLoggedMarketClosed) {
            const now = new Date();
            const estTime = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true });
            const localTime = now.toLocaleTimeString('en-US', { hour12: true });
            
            log(`⏸️ Market is CLOSED (Time-based detection)`, 'warn');
            log(`🕐 Current Time - Local: ${localTime} | EST: ${estTime}`, 'info');
            log(`📊 Current price: $${price.toFixed(2)} (Last trade from market session)`, 'info');
            log(`ℹ️ Candles now continue building outside regular hours for visualization only.`, 'info');
            
            appState.hasLoggedMarketClosed = true;
        }

        // Preview auto-exit bars (display-only) when no active auto order
        if ((!appState.activeAutoOrder || appState.activeAutoOrder.closed) && appState.currentPrice) {
            const expectedMove = parseFloat(ui.move?.value) || 1;
            const entry = appState.currentPrice;

            if (ui.autoStopCheckbox?.checked) {
                appState.autoStopPrice = entry - expectedMove;
                chartManager.setStopLoss(appState.autoStopPrice);
            }
            if (ui.autoTpCheckbox?.checked) {
                appState.autoTpPrice = entry + expectedMove;
                chartManager.setTakeProfit(appState.autoTpPrice);
                // ✅ Sync with activeAutoOrder so checkAutoExits() can detect hits
                if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
                    appState.activeAutoOrder.tpPrice = appState.autoTpPrice;
                }
            }
        }

        // Check auto stop-loss / take-profit triggers
        checkAutoExits();
        
        // Fetch REAL option price for the currently selected strike using Polygon
        // as the primary source. Webull option quotes are now a fallback only.
        let optionPrice = null;

        const hasStrike = appState.selectedStrike != null;
        const daysToExpiry = getDaysToExpiry();

        if (hasStrike) {
            // Option quotes are now fetched via optionPricePoller (Webull-based)
            // This section is disabled - the poller handles real-time option prices
            log(`[OPTIONS] Option quotes handled by optionPricePoller for ${appState.selectedTicker} strike $${appState.selectedStrike}`, 'info');
        }
        
        // If no real option data available, use theoretical preview
        if (!optionPrice) {
            // No real option data available – use theoretical preview only.
            appState.optionPriceIsReal = false;
            appState.optionDeltaIsReal = false;
            clearDeltaDisplay();
            recalculateOptionMetrics();
        }
        
    } catch (e) {
        log(`Market data update failed: ${e.message}`, 'error');
        // DO NOT fall back to mock data - show error state
    }
}

// Calculate delta directly using Black-Scholes formula (much more accurate!)
function calculateBlackScholesDelta(underlyingPrice, strikePrice, daysToExpiry, optionType, impliedVol = 0.30) {
    if (!underlyingPrice || !strikePrice || underlyingPrice === 0 || strikePrice === 0) {
        return 0.5; // Default to 0.5 (ATM) if invalid inputs
    }
    
    const timeToExpiry = daysToExpiry / 365; // Convert days to years
    const riskFreeRate = 0.045; // 4.5% risk-free rate
    
    // Avoid division by zero
    if (timeToExpiry <= 0 || impliedVol <= 0) {
        // If expired or no time value, delta is based purely on intrinsic value
        if (optionType === 'call') {
            return underlyingPrice > strikePrice ? 1.0 : 0.0;
        } else {
            return underlyingPrice < strikePrice ? -1.0 : 0.0;
        }
    }
    
    // Black-Scholes d1 calculation
    const d1 = (Math.log(underlyingPrice / strikePrice) + 
               (riskFreeRate + (impliedVol * impliedVol) / 2) * timeToExpiry) / 
               (impliedVol * Math.sqrt(timeToExpiry));
    
    // Standard normal CDF approximation (very accurate)
    function normalCDF(x) {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp(-x * x / 2);
        const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - prob : prob;
    }
    
    const N_d1 = normalCDF(d1);
    
    if (optionType === 'call') {
        return N_d1; // Delta for calls: 0 to 1
    } else {
        return N_d1 - 1; // Delta for puts: -1 to 0
    }
}

// Calculate estimated option price based on Black-Scholes approximation
function calculateMockOptionPrice(underlyingPrice, optionType) {
    if (!underlyingPrice || underlyingPrice === 0) return 0;
    
    const strikePrice = appState.selectedStrike || underlyingPrice;
    const daysToExpiry = getDaysToExpiry();
    
    // Calculate intrinsic value
    let intrinsicValue = 0;
    if (optionType === 'call') {
        intrinsicValue = Math.max(0, underlyingPrice - strikePrice);
    } else {
        intrinsicValue = Math.max(0, strikePrice - underlyingPrice);
    }
    
    // Calculate time value (rough approximation)
    // Time value is highest at ATM and decays with distance
    const moneyness = (underlyingPrice - strikePrice) / underlyingPrice; // Positive = OTM call
    const absMoneyness = Math.abs(moneyness);
    
    // Base time value scales with stock price and time
    const impliedVol = 0.30; // Assume 30% IV
    const timeValueBase = underlyingPrice * impliedVol * Math.sqrt(daysToExpiry / 365);
    
    // Time value peaks at ATM and decays exponentially
    const atmAdjustment = Math.exp(-Math.pow(absMoneyness * 10, 2)); // Gaussian decay
    const timeValue = timeValueBase * atmAdjustment;
    
    // Total option price = intrinsic + time value
    const optionPrice = intrinsicValue + timeValue;
    
    return Math.max(0.01, optionPrice); // Minimum $0.01
}

// Update delta display in UI (Polygon-only, no theoretical fallbacks)
function updateDeltaDisplay(deltaStatus) {
    if (!ui.outDelta) return;

    // Invalid or missing delta → show empty state
    if (!deltaStatus || typeof deltaStatus.delta !== 'number' || !isFinite(deltaStatus.delta)) {
        ui.outDelta.innerText = '--';
        ui.outDelta.title = 'No real delta data available';
        const deltaSourceEl = document.getElementById('delta-source');
        if (deltaSourceEl) {
            deltaSourceEl.textContent = '';
            deltaSourceEl.style.color = 'var(--cyber-text-dim)';
        }
        return;
    }

    const deltaValue = deltaStatus.delta;

    // Update delta display (always show absolute value for display)
    const displayDelta = Math.abs(deltaValue);
    ui.outDelta.innerText = displayDelta.toFixed(4);
    
    // Detailed tooltip with moneyness info
    const deltaType = appState.selectedOptionType === 'call' ? 'Call' : 'Put';
    const moneyness = appState.selectedStrike && appState.currentPrice 
        ? (appState.selectedStrike < appState.currentPrice ? 'ITM' : 
           appState.selectedStrike > appState.currentPrice ? 'OTM' : 'ATM')
        : '--';

    const sourceLabel = deltaStatus.source || 'Polygon Options (Real-time)';
    const isEffective = /polygon/i.test(sourceLabel) || /real-time/i.test(sourceLabel);
    const deltaLabelPrefix = isEffective ? 'Effective' : 'Theoretical';
    
    ui.outDelta.title =
        `${sourceLabel}\n` +
        `Type: ${deltaType}\n` +
        `Moneyness: ${moneyness}\n` +
        `${deltaLabelPrefix} Delta: ${deltaValue.toFixed(4)}`;
    
    // Update source indicator
    const deltaSource = document.getElementById('delta-source');
    if (deltaSource) {
        deltaSource.textContent = isEffective ? '(Effective)' : '(Theoretical)';
        deltaSource.style.color = isEffective ? 'var(--cyber-green)' : 'var(--cyber-blue)';
    }
    
    // Color based on delta magnitude (higher = better for sizing)
    if (displayDelta >= 0.5) {
        ui.outDelta.style.color = '#00c853'; // Green (strong delta, good for sizing)
    } else if (displayDelta >= 0.3) {
        ui.outDelta.style.color = '#ffab00'; // Amber (moderate delta)
    } else {
        ui.outDelta.style.color = '#ff6b6b'; // Orange-red (weak delta - warning!)
    }
}

// Clear delta display completely (no value, no source).
function clearDeltaDisplay() {
    if (ui.outDelta) {
        ui.outDelta.innerText = '--';
        ui.outDelta.title = 'No real delta data available';
        ui.outDelta.style.color = 'var(--cyber-text-dim)';
    }
    const deltaSource = document.getElementById('delta-source');
    if (deltaSource) {
        deltaSource.textContent = '';
        deltaSource.style.color = 'var(--cyber-text-dim)';
    }
}

function updateCalculations() {
    if (!ui.outProfitPer || !ui.outContracts || !ui.outCost) {
        return; // UI elements not ready
    }
    
    // Visual indicator that calculations are updating
    const indicator = document.getElementById('calc-indicator');
    if (indicator) {
        indicator.style.opacity = '1';
        setTimeout(() => { indicator.style.opacity = '0'; }, 200);
    }
    
    // --- Sizing logic (REAL option data + effective delta) ---
    // We size off REAL option contract pricing (from Polygon/Webull) and an
    // empirically measured price sensitivity (effective delta) derived from
    // recent ticks. If we only have theoretical pricing, we DO NOT size.
    const expectedMove = parseFloat(ui.move?.value) || 0;
    const targetProfit = parseFloat(ui.profit?.value) || 0;
    const optionType = appState.selectedOptionType || 'call';
    const underlyingNow = appState.currentPrice || 0;
    const optionPriceNow = appState.currentOptionPrice || 0;

    let profitPerContract = 0;
    let profitPerDollar = 0;

    // DEBUG: Log calculation requirements
    log(`[CALC] expectedMove=${expectedMove}, underlyingNow=${underlyingNow}, optionPrice=${optionPriceNow}, priceIsReal=${appState.optionPriceIsReal}, deltaIsReal=${appState.optionDeltaIsReal}, delta=${appState.currentOptionDelta}`, 'debug');

    // Primary (and only) sizing path: REAL Polygon option price + REAL Polygon delta.
    // If we don't have both, we do NOT size and show "--" so the user knows
    // something is wrong or incomplete.
    if (expectedMove > 0 &&
        underlyingNow > 0 &&
        optionPriceNow > 0 &&
        appState.optionPriceIsReal &&
        appState.optionDeltaIsReal &&
        typeof appState.currentOptionDelta === 'number' &&
        isFinite(appState.currentOptionDelta)) {

        const effectiveDeltaAbs = Math.abs(appState.currentOptionDelta);

        if (effectiveDeltaAbs > 0) {
            // Profit per $1 move in underlying, per contract:
            // Δoption ≈ delta * Δunderlying  →  profitPerDollar = |delta| * 100
            profitPerDollar = effectiveDeltaAbs * 100;
            profitPerContract = profitPerDollar * expectedMove;
        }
    }

    if (profitPerDollar > 0) {
        ui.outProfitPer.innerText = '$' + profitPerDollar.toFixed(2);
        ui.outProfitPer.title = `Estimated profit per $1 move in underlying, per contract (from Polygon options data)`;
    } else {
        ui.outProfitPer.innerText = '$--';
        ui.outProfitPer.title = appState.optionTickerId
            ? 'Waiting for enough real-time data to estimate sensitivity...'
            : 'Select an options contract to enable real-data sizing.';
    }

    // Update strike price display (current selected strike, or spot as fallback)
    if (ui.outStrike) {
        const strike = appState.selectedStrike || appState.currentPrice || 0;
        if (strike > 0) {
            ui.outStrike.innerText = `$${strike.toFixed(2)}`;
            ui.outStrike.title = 'Selected option strike price';
        } else {
            ui.outStrike.innerText = '--';
            ui.outStrike.title = 'Waiting for strike selection...';
        }
    }
    
    // Update contracts required (with sanity check!)
    let contractsRequired = 0;
    if (profitPerContract > 0 && targetProfit > 0) {
        contractsRequired = Math.ceil(targetProfit / profitPerContract);
    }
    
    // Sanity check: If contracts > 1000, show warning (likely bad delta)
    if (contractsRequired > 1000) {
        ui.outContracts.innerText = `${contractsRequired} ⚠️`;
        ui.outContracts.style.color = '#ff1744';
        ui.outContracts.title = `WARNING: Very high contract count to reach ~$${targetProfit.toFixed(2)} target. Delta may be too low; consider a closer strike.`;
    } else if (contractsRequired > 100) {
        ui.outContracts.innerText = contractsRequired;
        ui.outContracts.style.color = '#ffab00'; // Amber warning
        ui.outContracts.title = `High contract count (${contractsRequired}) to reach ~$${targetProfit.toFixed(2)} target. Consider adjusting strike or target profit.`;
    } else if (contractsRequired > 0) {
        ui.outContracts.innerText = contractsRequired;
        ui.outContracts.style.color = contractsRequired > 10 ? '#ffa726' : '#fff';
        ui.outContracts.title = `${contractsRequired} contracts needed for ~$${targetProfit.toFixed(2)} target profit`;
    } else {
        ui.outContracts.innerText = '--';
        ui.outContracts.style.color = '#666';
        ui.outContracts.title = 'Waiting for data...';
    }
    
    // Update cost metric – show per-contract premium only (total cost can be misleading)
    const optionPrice = appState.currentOptionPrice || 0;
    if (optionPrice > 0 && contractsRequired > 0) {
        const costPerContract = optionPrice * 100;
        ui.outCost.innerText = `$${costPerContract.toFixed(2)}`;
        ui.outCost.style.color = '#ffab00'; // Amber = estimated
        ui.outCost.title = `Estimated premium per contract: $${costPerContract.toFixed(2)}`;
    } else {
        ui.outCost.innerText = '$--';
        ui.outCost.style.color = '#666';
        ui.outCost.title = 'Waiting for price data...';
    }
    
    // Update total cost metric – show total cost for all contracts
    if (ui.outTotalCost) {
        // Check if manual override is active
        const isManualOverride = ui.manualContractsOverride && ui.manualContractsOverride.checked;
        const manualQty = isManualOverride ? parseInt(ui.manualContractsInput?.value) : 0;
        const actualQty = isManualOverride && manualQty > 0 ? manualQty : contractsRequired;
        
        if (optionPrice > 0 && actualQty > 0) {
            const costPerContract = optionPrice * 100;
            const totalCost = costPerContract * actualQty;
            ui.outTotalCost.innerText = `$${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            ui.outTotalCost.style.color = totalCost > 10000 ? '#ff1744' : (totalCost > 5000 ? '#ffab00' : '#06ffa5'); // Red if > $10k, amber if > $5k, green otherwise
            ui.outTotalCost.title = `Total cost for ${actualQty} contract${actualQty > 1 ? 's' : ''} at $${costPerContract.toFixed(2)} each${isManualOverride ? ' (MANUAL OVERRIDE)' : ''}`;
        } else {
            ui.outTotalCost.innerText = '$--';
            ui.outTotalCost.style.color = '#666';
            ui.outTotalCost.title = 'Waiting for price data...';
        }
    }
    
    // Show/update sizing warning
    if (ui.sizingWarning) {
        if (contractsRequired > 1000) {
            ui.sizingWarning.innerHTML = '⚠️ <strong>WARNING:</strong> Extremely high contract count suggests delta is too low. Move strike closer to current price (ATM).';
            ui.sizingWarning.style.color = '#ff1744';
        } else {
            ui.sizingWarning.innerHTML = 'ⓘ Sizing assumes delta remains constant during the expected move.';
            ui.sizingWarning.style.color = '#ffa726';
        }
        ui.sizingWarning.style.display = 'block';
    }

    // --- Slippage-aware metrics (read-only UI) ---
    if (ui.maxSlippageDisplay || ui.worstExitPnlDisplay) {
        const targetProfitUSD = targetProfit;
        // For now, assume symmetric max loss until a dedicated risk field exists
        const maxLossUSD = targetProfitUSD;
        // Effective delta derived from REAL price-based sizing:
        const effectiveDelta = profitPerDollar > 0 ? (profitPerDollar / 100) : 0;
        const tickSize = 0.01;
        const qty = contractsRequired;

        const pnlPerTick = Math.abs(effectiveDelta) * tickSize * 100 * Math.max(1, qty || 0);
        const slippageToleranceRatio = 0.05;

        const profitSlippageUSD = targetProfitUSD * slippageToleranceRatio;
        const lossSlippageUSD = Math.abs(maxLossUSD) * slippageToleranceRatio;

        const maxSlippageUSD = Math.max(profitSlippageUSD, lossSlippageUSD);
        const worstExitLossUSD = -(maxLossUSD + lossSlippageUSD);

        if (ui.maxSlippageDisplay) {
            if (pnlPerTick > 0 && maxSlippageUSD > 0) {
                ui.maxSlippageDisplay.innerText = '$' + maxSlippageUSD.toFixed(2);
            } else {
                ui.maxSlippageDisplay.innerText = '$--';
            }
        }

        if (ui.worstExitPnlDisplay) {
            if (pnlPerTick > 0 && maxLossUSD > 0) {
                ui.worstExitPnlDisplay.innerText = (worstExitLossUSD >= 0 ? '+' : '') + '$' + Math.abs(worstExitLossUSD).toFixed(2);
            } else {
                ui.worstExitPnlDisplay.innerText = '$--';
            }
        }
    }
}

async function executeTrade(direction) {
    if (!appState.isConnected) {
        log('NOT CONNECTED - Cannot place order', 'error');
        return;
    }
    
    if (!appState.tickerId) {
        log('No ticker selected', 'error');
        return;
    }
    
    // Block order placement when market is closed (prevents 417 errors from Webull)
    if (!appState.marketActuallyOpen) {
        log('❌ MARKET IS CLOSED - Cannot place orders during after-hours', 'error');
        log('Option orders can only be placed during regular market hours (9:30 AM - 4:00 PM EST)', 'error');
        return;
    }
    
    // Check if manual override is enabled
    let quantity = 0;
    let isManualOverride = false;
    
    if (ui.manualContractsOverride && ui.manualContractsOverride.checked) {
        // Use manual quantity
        const manualQty = parseInt(ui.manualContractsInput.value);
        if (manualQty > 0) {
            quantity = manualQty;
            isManualOverride = true;
            log(`🔧 Manual Override Enabled - Using ${quantity} contracts`, 'info');
        } else {
            log('Manual override enabled but invalid quantity entered', 'error');
            return;
        }
    } else {
        // Use calculated quantity
        const suggestedContracts = parseInt(ui.outContracts.innerText);
        quantity = suggestedContracts;
    }
    
    if (!quantity || quantity <= 0) {
        log('Invalid contract quantity', 'error');
        return;
    }

    log(`=== PLACING ${direction} ORDER ===`, 'info');
    log(`Stock Symbol: ${appState.selectedTicker}`, 'info');
    log(`Stock Ticker ID: ${appState.stockTickerId || appState.tickerId}`, 'info');
    log(`Option Contract ID: ${appState.optionContractId}`, 'info');
    log(`Strike Price: $${appState.selectedStrike}`, 'info');
    log(`Option Type: ${appState.selectedOptionType.toUpperCase()}`, 'info');
    log(`Quantity: ${quantity} OPTION CONTRACTS${isManualOverride ? ' (MANUAL)' : ' (AUTO)'}`, 'info');
    log(`⚠️ You are buying ${quantity} OPTIONS CONTRACTS, NOT stock shares`, 'info');
    
    // For real trading, we need BOTH the stock ticker ID and option contract ID
    const order = {
        action: direction === 'BUY' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', // 🎯 Use proper option actions
        tickerId: appState.tickerId, // Keep for paper trading compatibility
        stockTickerId: appState.stockTickerId || appState.tickerId, // Underlying stock ID
        optionTickerId: appState.optionContractId, // Option contract ID (for real trading)
        quantity: quantity,
        price: appState.currentPrice || 0, // Use current price for limit
        // Use LIMIT orders when market is closed / after-hours to avoid Webull 417 error
        orderType: appState.marketActuallyOpen ? 'MKT' : 'LMT',
        // For limit orders placed when market is NOT actually open, request extended-hours trading
        outsideRegularTradingHour: !appState.marketActuallyOpen
    };
    
    // CRITICAL: Check if option contract ID is available (for BOTH paper and real trading)
    if (!appState.optionContractId) {
        // Check which tickers are available in cache
        const availableTickers = api.optionCache && api.optionCache.options 
            ? Object.keys(api.optionCache.options)
            : [];
        
        const currentTicker = appState.selectedTicker || ui.tickerInput?.value || 'UNKNOWN';
        
        console.error('❌ ORDER BLOCKED: Option contract ID not available');
        console.error('⚠️ This app trades OPTIONS CONTRACTS only, not stock shares');
        console.error('');
        
        if (availableTickers.length > 0 && !availableTickers.includes(currentTicker)) {
            console.error(`⚠️ ${currentTicker} is not in the option cache!`);
            console.error('');
            console.error('✅ Available tickers:');
            availableTickers.forEach(ticker => {
                const expiries = Object.keys(api.optionCache.options[ticker] || {});
                const totalContracts = expiries.reduce((sum, exp) => {
                    return sum + (api.optionCache.options[ticker][exp]?.length || 0);
                }, 0);
                console.error(`   ${ticker}: ${expiries.length} expiries, ${totalContracts} contracts`);
            });
            console.error('');
            console.error('Solution:');
            console.error(`  ✓ Switch to one of these tickers: ${availableTickers.join(', ')}`);
            console.error('  ✓ OR wait until Friday (market open) for automatic cache update');
            
            alert(`⚠️ ORDER BLOCKED\n\n${currentTicker} options not available!\n\nAvailable tickers: ${availableTickers.join(', ')}\n\nPlease select one of these tickers to trade.`);
        } else {
            // Show available strikes for this ticker
            const selectedExpiry = appState.selectedExpiry || '2025-12-26';
            const selectedDirection = appState.optionDirection || 'call';
            
            if (api.optionCache && api.optionCache.options && api.optionCache.options[currentTicker]) {
                const tickerData = api.optionCache.options[currentTicker];
                const expiryData = tickerData[selectedExpiry] || [];
                
                const availableStrikes = expiryData
                    .filter(opt => opt.type === selectedDirection)
                    .map(opt => `$${opt.strike}`)
                    .sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)));
                
                if (availableStrikes.length > 0) {
                    console.error(`⚠️ Strike not available in cache!`);
                    console.error('');
                    console.error(`✅ Available ${selectedDirection.toUpperCase()} strikes for ${currentTicker} (${selectedExpiry}):`);
                    console.error(`   ${availableStrikes.join(', ')}`);
                    console.error('');
                    console.error('Solution:');
                    console.error(`  ✓ Click one of these strikes: ${availableStrikes.join(', ')}`);
                    console.error('  ✓ OR add more contract IDs to optionDatabase.json');
                    
                    alert(`⚠️ STRIKE NOT AVAILABLE\n\n${currentTicker} ${selectedDirection.toUpperCase()} options for ${selectedExpiry}\n\nAvailable strikes:\n${availableStrikes.join(', ')}\n\nPlease click one of these strikes.`);
                } else {
                    console.error(`⚠️ No ${selectedDirection.toUpperCase()} options available for ${currentTicker} (${selectedExpiry})`);
                    console.error('');
                    console.error('Solution:');
                    console.error('  ✓ Try a different expiry date');
                    console.error('  ✓ Try switching to PUTS instead of CALLS (or vice versa)');
                    console.error('  ✓ Add more contract IDs to optionDatabase.json');
                    
                    alert(`⚠️ NO ${selectedDirection.toUpperCase()}S AVAILABLE\n\n${currentTicker} has no ${selectedDirection.toUpperCase()} options in cache for ${selectedExpiry}.\n\nTry a different expiry or option type.`);
                }
            } else {
                console.error('Why this happened:');
                console.error('  - Market is closed (Webull blocks option data during after-hours)');
                console.error('  - Strike price not fully loaded yet');
                console.error('  - Webull API returned 417 error (see above)');
                console.error('');
                console.error('Solution:');
                console.error('  ✓ Wait until market opens (9:30 AM - 4:00 PM EST)');
                console.error('  ✓ Re-select your strike price');
                console.error('  ✓ Wait 1-2 seconds for option contract ID to load');
                
                alert('⚠️ ORDER BLOCKED\n\nOption contract ID not available.\n\nThe market might be closed, or the option contract failed to load.\n\nCheck the console (F12) for details.');
            }
        }
        
        console.error('');
        return; // Block order placement
    }
    
    // Additional validation: Verify option contract ID is different from stock ticker ID
    if (appState.optionContractId === appState.tickerId || appState.optionContractId === appState.stockTickerId) {
        console.error('❌ ORDER BLOCKED: Option contract ID matches stock ticker ID');
        console.error('⚠️ This would buy STOCK SHARES instead of OPTIONS CONTRACTS');
        console.error('');
        console.error('Solution:');
        console.error('  ✓ Re-select your strike price');
        console.error('  ✓ Wait for the correct option contract ID to load');
        console.error('');
        alert('⚠️ ORDER BLOCKED\n\nOption contract ID is invalid (matches stock ID).\n\nThis would buy stock shares instead of options.\n\nRe-select your strike price and try again.');
        return; // Block order placement
    }
    
    // Muted: Order validation details
    // console.log('✅ Order validation passed');
    
    try {
        const res = await api.placeOrder(order);
        
        if (res) {
            // Check for order ID or success indicator
            // Live trading: res.placeVo.orderId
            // Paper trading: res.orderId or res.data.orderId
            const orderId = res.placeVo?.orderId || res.orderId || res.data?.orderId || res.id || 'UNKNOWN';
            const symbol = appState.selectedTicker || ui.tickerInput?.value || 'UNKNOWN';
            const orderPrice = appState.currentPrice || 0;
            
            // 📊 Clean buy/sell log
            console.log(`✅ ${direction} ${quantity} ${symbol} @ $${orderPrice.toFixed(2)} | Order ID: ${orderId}`);

            // Store in local order history for Orders panel
            const orderRecord = {
                id: orderId,
                symbol,
                side: direction,
                qty: quantity,
                price: orderPrice,
                status: 'Accepted',
                time: Date.now()
            };
            
            appState.orderHistory.push(orderRecord);
            
            try {
                localStorage.setItem('orderHistory', JSON.stringify(appState.orderHistory));
            } catch (e) {
                console.error('❌ Failed to persist orderHistory', e);
            }
            
            renderOrderHistory();
            
            // Muted: Calling refreshPaperAccountView()
            // console.log(`🔄 Refreshing account view...`);
            // Refresh account/positions quickly after a new order
            refreshPaperAccountView();
            
            // Auto-manage stop/TP toggles based on direction
            if (direction === 'BUY') {
                // Enable auto stop / TP when opening a long via BUY
                if (ui.autoStopCheckbox) {
                    ui.autoStopCheckbox.checked = true;
                    appState.autoStopEnabled = true;
                }
                if (ui.autoTpCheckbox) {
                    ui.autoTpCheckbox.checked = true;
                    appState.autoTpEnabled = true;
                }
                
                // Setup auto-exit levels for this order
                setupAutoExitAfterOrder(direction, quantity, order.price || appState.currentPrice || 0, appState.optionContractId);
                
                // Add entry marker on chart
                if (chartManager) {
                    chartManager.addEntryMarker(order.price || appState.currentPrice || 0, quantity);
                }
            } else if (direction === 'SELL') {
                // On manual SELL, assume we are exiting and clear auto-exits
                clearAutoExitState();
                
                // Add exit marker on chart
                if (chartManager) {
                    chartManager.addExitMarker(order.price || appState.currentPrice || 0, quantity);
                }
            }
        } else {
            throw new Error('Order response was null or empty');
        }
    } catch (e) {
        log(`✗✗✗ ${direction} ORDER FAILED ✗✗✗`, 'error');
        log(`Error: ${e.message}`, 'error');

        // 🚨 DETECT INSUFFICIENT FUNDS ERROR
        const errorMsg = e.message || e.data?.msg || JSON.stringify(e).toLowerCase();
        const isInsufficientFunds = 
            errorMsg.includes('insufficient') || 
            errorMsg.includes('not enough') || 
            errorMsg.includes('buying power') ||
            errorMsg.includes('balance') ||
            errorMsg.includes('fund');
        
        if (isInsufficientFunds) {
            // Show user-friendly popup for insufficient funds
            showCustomAlert(
                '💰 Insufficient Funds',
                `You don't have enough buying power to place this order.\n\n` +
                `Order: ${direction} ${quantity} contracts @ ~$${(appState.currentPrice || 0).toFixed(2)}\n\n` +
                `Please check your account balance or reduce the order size.`
            );
        } else {
            // Show generic error popup for other errors
            showCustomAlert(
                '❌ Order Failed',
                `Your ${direction} order could not be placed.\n\n` +
                `Error: ${e.message || 'Unknown error'}\n\n` +
                `Please check the console for more details.`
            );
        }

        // Record failed order with Webull's error message in Orders panel
        const symbol = appState.selectedTicker || ui.tickerInput?.value || 'UNKNOWN';
        const statusMsg = (e && e.message) ? e.message : 'Error';
        const orderRecord = {
            id: 'N/A',
            symbol,
            side: direction,
            qty: quantity,
            price: appState.currentPrice || 0,
            status: `Rejected: ${statusMsg}`,
            time: Date.now()
        };
        appState.orderHistory.push(orderRecord);
        try {
            localStorage.setItem('orderHistory', JSON.stringify(appState.orderHistory));
        } catch (err) {
            console.error('Failed to persist orderHistory', err);
        }
        renderOrderHistory();
    }
}

function log(msg, type = 'info', source = 'app') {
    // Logging disabled for performance - prevents console lag
    return;

    applyConsoleFilter();
}

// Update market status display
function updateMarketStatus(status) {
    // DON'T TRUST WEBULL'S STATUS - It's often stale!
    // Use actual time-based detection instead
    
    const now = new Date();
    const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = estTime.getHours();
    const minutes = estTime.getMinutes();
    const dayOfWeek = estTime.getDay(); // 0 = Sunday, 6 = Saturday
    
    // Market hours (EST):
    // Pre-Market: 4:00 AM - 9:30 AM
    // Regular: 9:30 AM - 4:00 PM
    // After-Hours: 4:00 PM - 8:00 PM
    // Closed: 8:00 PM - 4:00 AM, weekends
    
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const timeInMinutes = hours * 60 + minutes;
    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60; // 4:00 PM
    const preMarketStart = 4 * 60; // 4:00 AM
    const afterHoursEnd = 20 * 60; // 8:00 PM
    
    let displayText = 'Unknown';
    let displayColor = '#666';
    let isActuallyOpen = false;
    
    if (isWeekend) {
        displayText = 'CLOSED (Weekend)';
        displayColor = '#f72585';
        isActuallyOpen = false;
    } else if (timeInMinutes >= marketOpen && timeInMinutes < marketClose) {
        displayText = 'OPEN';
        displayColor = '#06ffa5';
        isActuallyOpen = true;
    } else if (timeInMinutes >= preMarketStart && timeInMinutes < marketOpen) {
        displayText = 'CLOSED (Pre-Market)';
        displayColor = '#f72585';
        isActuallyOpen = false;
    } else if (timeInMinutes >= marketClose && timeInMinutes < afterHoursEnd) {
        displayText = 'CLOSED (After-Hours)';
        displayColor = '#f72585';
        isActuallyOpen = false;
    } else {
        displayText = 'CLOSED';
        displayColor = '#f72585';
        isActuallyOpen = false;
    }
    
    ui.marketState.textContent = displayText;
    ui.marketState.style.color = displayColor;
    
    // Log market state change with details
    const statusKey = `${displayText}_${isActuallyOpen}`;
    if (!appState.lastMarketStatus || appState.lastMarketStatus !== statusKey) {
        const timeStr = now.toLocaleTimeString('en-US', { hour12: true });
        const estTimeStr = estTime.toLocaleTimeString('en-US', { hour12: true });
        
        // If Webull's status disagrees with actual time, warn about it
        const webullSaysOpen = status === 'A' || status === 'T';
        if (webullSaysOpen && !isActuallyOpen) {
            log(`⚠️ Webull API says "Open" (Status: "${status}") but it's ${estTimeStr} EST - IGNORING STALE STATUS`, 'warn');
        }
        
        log(`📊 Market Status: ${displayText} (TIME-BASED) | Local: ${timeStr} | EST: ${estTimeStr}`, 
            isActuallyOpen ? 'success' : 'info');
        
        appState.lastMarketStatus = statusKey;
        appState.marketActuallyOpen = isActuallyOpen; // Store for use in other functions
        
        // Reset closed message flag when market opens
        if (isActuallyOpen) {
            appState.hasLoggedMarketClosed = false;
        }
        
        // Adjust polling frequency based on ACTUAL market status
        adjustPollingFrequency(isActuallyOpen);
    }
    
    // Always store current state
    appState.marketActuallyOpen = isActuallyOpen;
    
    // Disable trading buttons when market is closed to prevent 417 errors
    if (ui.btnBuy) {
        ui.btnBuy.disabled = !isActuallyOpen;
        ui.btnBuy.style.opacity = isActuallyOpen ? '1' : '0.5';
        ui.btnBuy.style.cursor = isActuallyOpen ? 'pointer' : 'not-allowed';
        ui.btnBuy.title = isActuallyOpen ? 'Place buy order' : 'Trading disabled - Market is closed';
    }
    if (ui.btnSell) {
        ui.btnSell.disabled = !isActuallyOpen;
        ui.btnSell.style.opacity = isActuallyOpen ? '1' : '0.5';
        ui.btnSell.style.cursor = isActuallyOpen ? 'pointer' : 'not-allowed';
        ui.btnSell.title = isActuallyOpen ? 'Emergency flatten position' : 'Trading disabled - Market is closed';
    }
}

// Setup Header Menu Dropdowns
function setupHeaderMenus() {
    // Network Status Dropdown
    ui.networkIndicator?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('network-dropdown');
    });
    
    // Settings Dropdown
    ui.settingsIcon?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('settings-dropdown');
    });
    
    // User Dropdown
    ui.userIcon?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('user-dropdown');
    });
    
    // Close all dropdowns when clicking outside
    document.addEventListener('click', () => {
        closeAllDropdowns();
    });
    
    // Prevent clicks inside dropdowns from closing them immediately
    document.querySelectorAll('.menu-dropdown').forEach(drop => {
        drop.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    });
    
    // Settings: Theme Toggle
    document.getElementById('toggle-theme')?.addEventListener('click', () => {
        const currentThemeLabel = document.getElementById('current-theme');
        const root = document.documentElement;

        // Read the last explicit selection; fall back to current DOM class
        let current = null;
        try {
            current = localStorage.getItem('theme');
        } catch (e) {
            current = null;
        }
        if (!current) {
            if (root.classList.contains('theme-light')) current = 'light';
            else if (root.classList.contains('theme-dark-red')) current = 'dark-red';
            else if (root.classList.contains('theme-classic')) current = 'classic';
            else current = 'dark';
        }

        // Cycle: Dark → Dark Red → Classic → Light → Dark
        let next;
        if (current === 'dark') next = 'dark-red';
        else if (current === 'dark-red') next = 'classic';
        else if (current === 'classic') next = 'light';
        else next = 'dark';

        root.classList.remove('theme-dark', 'theme-light', 'theme-dark-red', 'theme-classic');
        if (next === 'light') {
            root.classList.add('theme-light');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Light';
        } else if (next === 'dark-red') {
            root.classList.add('theme-dark-red');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Dark Red';
        } else if (next === 'classic') {
            root.classList.add('theme-classic');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Classic';
        } else {
            root.classList.add('theme-dark');
            if (currentThemeLabel) currentThemeLabel.textContent = 'Dark';
        }

        try { localStorage.setItem('theme', next); } catch (e) {}
        chartManager.applyTheme(next);
        // Apply custom candle colors if set
        applyCandleColors();
    });
    
    // Settings: Full Settings
    document.getElementById('open-full-settings')?.addEventListener('click', () => {
        openFullSettings();
        closeAllDropdowns();
    });

    // Settings: New Window (multi-screen)
    document.getElementById('open-new-window')?.addEventListener('click', () => {
        try {
            ipcRenderer.send('open-new-window');
            log('Requested new window (multi-screen)', 'info');
        } catch (e) {
            console.error('Failed to request new window', e);
        }
        closeAllDropdowns();
    });

    // Calendar: toggle in-app overlay (no separate window)
    if (ui.openCalendarBtn && ui.calendarOverlay) {
        ui.openCalendarBtn.addEventListener('click', () => {
            const isVisible = ui.calendarOverlay.style.display !== 'none';
            if (isVisible) {
                ui.calendarOverlay.style.display = 'none';
                ui.openCalendarBtn.textContent = '📅 Calendar';
                log('Closed calendar view', 'info');
            } else {
                ui.calendarOverlay.style.display = 'block';
                ui.openCalendarBtn.textContent = '↩ Back to Trading';
                log('Opened calendar view', 'info');
            }
        });
    }
    
    // Clear All Lines button in header
    document.getElementById('clear-lines-btn')?.addEventListener('click', () => {
        if (chartManager) {
            chartManager.clearAllMarkers();
            log('✅ All entry/exit lines cleared from chart', 'success');
        }
    });
    
    // User: Connect Webull
    document.getElementById('user-connect-webull')?.addEventListener('click', () => {
        if (ui.loginModal) {
            ui.loginModal.style.display = 'flex';
            ensureModalInteractive();
        }
        closeAllDropdowns();
    });
    
    // User: Logout
    document.getElementById('user-logout')?.addEventListener('click', async () => {
        await handleLogout();
        closeAllDropdowns();
    });
    
    // User: Clear Watchlist Cache
    document.getElementById('clear-watchlist-btn')?.addEventListener('click', () => {
        const confirmed = confirm('🧹 Clear Watchlist Cache?\n\nThis will remove all tickers from your watchlist and reset to defaults (AAPL, TSLA, SPY, QQQ, AMD).\n\nThis is useful if you have corrupted/ghost tickers causing errors.\n\nContinue?');
        if (confirmed) {
            try {
                // Clear all watchlist-related localStorage
                localStorage.removeItem('watchlist');
                localStorage.removeItem('priorityWatchlist');
                localStorage.removeItem('highlightWatchlist');
                
                // Reset to defaults
                appState.watchlist = ['AAPL', 'TSLA', 'SPY', 'QQQ', 'AMD'];
                appState.priorityWatchlist = [];
                appState.highlightWatchlist = [];
                appState.invalidTickers.clear();
                
                // Save clean defaults
                saveWatchlistState();
                
                // Re-render
                renderWatchlist();
                
                console.log('✅ Watchlist cache cleared and reset to defaults');
                alert('✅ Watchlist cleared!\n\nYour watchlist has been reset to:\nAAPL, TSLA, SPY, QQQ, AMD\n\nReload the page (Ctrl+R) for full cleanup.');
            } catch (e) {
                console.error('Failed to clear watchlist cache:', e);
                alert('❌ Failed to clear watchlist cache. Check console for details.');
            }
        }
        closeAllDropdowns();
    });
    
    
    // ✅ Restore active order state from previous session (if any)
    // This will redisplay SL/TP lines if user had an open position when they closed the app
    setTimeout(() => {
        if (chartManager) {
            loadActiveOrderState();
        }
    }, 1000); // Delay to ensure chart is fully ready
    
    // Update network status periodically
    setInterval(updateNetworkStatus, 5000);
    
    // ✅ Setup emergency exit on disconnect (if enabled)
    setupEmergencyExit();
}

// ✅ Emergency Exit: Auto-sell position if app crashes or loses connection
async function executeEmergencyExit(reason = 'Unknown') {
    console.log(`🚨 EMERGENCY EXIT TRIGGERED: ${reason}`);
    
    // Check if feature is enabled
    const emergencyExitEnabled = localStorage.getItem('emergencyExitOnDisconnect') === 'true';
    if (!emergencyExitEnabled) {
        console.log('⚠️ Emergency exit is disabled, skipping auto-sell');
        return;
    }
    
    // Check if there's an active position
    const order = appState.activeAutoOrder;
    if (!order || order.closed) {
        console.log('ℹ️ No active position to close');
        return;
    }
    
    console.log(`🚨 EMERGENCY: Closing position - ${order.symbol} ${order.side} ${order.qty}x @ entry $${order.entryPrice.toFixed(2)}`);
    
    try {
        // Get current option contract ID
        const optionContractId = appState.optionContractId || order.optionContractId;
        
        if (!optionContractId) {
            console.error('❌ Cannot execute emergency exit: No option contract ID');
            return;
        }
        
        // Execute emergency sell using the existing emergencySell function
        await emergencySell();
        
        console.log('✅ Emergency exit completed successfully');
    } catch (e) {
        console.error('❌ Emergency exit failed:', e);
        // Even if it fails, we tried. Log for debugging.
    }
}

function setupEmergencyExit() {
    // ✅ Detect app closing/crashing
    window.addEventListener('beforeunload', async (e) => {
        const emergencyExitEnabled = localStorage.getItem('emergencyExitOnDisconnect') === 'true';
        
        if (emergencyExitEnabled && appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
            // Mark a flag for emergency exit needed
            localStorage.setItem('emergencyExitNeeded', 'true');
            localStorage.setItem('emergencyExitTimestamp', Date.now().toString());
            
            console.log('🚨 App closing with active position - Emergency exit flagged');
            
            // Try to execute immediately (may not complete before app closes)
            try {
                await executeEmergencyExit('App closing/crash');
            } catch (err) {
                console.error('Failed to execute emergency exit on beforeunload:', err);
            }
        }
    });
    
    // ✅ Detect internet connection loss
    window.addEventListener('offline', async () => {
        console.log('🚨 INTERNET CONNECTION LOST');
        await executeEmergencyExit('Connection lost');
    });
    
    // ✅ Detect connection restore (clear emergency flag)
    window.addEventListener('online', () => {
        console.log('✅ INTERNET CONNECTION RESTORED');
        localStorage.removeItem('emergencyExitNeeded');
    });
    
    // ✅ Check for pending emergency exit on startup
    setTimeout(() => {
        const emergencyExitNeeded = localStorage.getItem('emergencyExitNeeded') === 'true';
        const emergencyTimestamp = parseInt(localStorage.getItem('emergencyExitTimestamp') || '0');
        const timeSinceEmergency = Date.now() - emergencyTimestamp;
        
        // If there was an emergency exit within the last 5 minutes and we still have a position
        if (emergencyExitNeeded && timeSinceEmergency < 5 * 60 * 1000) {
            console.log('🚨 Detected pending emergency exit from previous session');
            
            if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
                console.log('🚨 Executing delayed emergency exit...');
                executeEmergencyExit('Delayed from previous session');
            }
        }
        
        // Clear the flag
        localStorage.removeItem('emergencyExitNeeded');
        localStorage.removeItem('emergencyExitTimestamp');
    }, 3000); // Wait 3 seconds after app loads
}

// Initialize trading mode after successful login
async function initializeTradingMode() {
    console.log('🔍 Initializing trading mode...');
    
    try {
        // Try to fetch real account (optional - user might only have paper)
        // Skip if already manually provided
        if (!api.realAccountId) {
            try {
                console.log('🔍 Attempting auto-detection of real account...');
                await api.getRealAccount();
                
                if (api.realAccountId) {
                    console.log(`✅ Real Account auto-detected: ${api.realAccountId}`);
                } else {
                    console.log('ℹ️ No real account found via auto-detection (use manual entry in login form)');
                }
            } catch (e) {
                console.log(`ℹ️ Real account auto-detection failed: ${e.message}`);
                console.log('💡 TIP: Enter your real account ID manually in the login form');
            }
        } else {
            console.log(`✓ Using manually provided real account ID: ${api.realAccountId}`);
        }
        
        // Load saved trading mode preference
        const savedMode = localStorage.getItem('tradingMode') || 'paper';
        
        // Validate saved mode (ensure account exists)
        if (savedMode === 'real' && !api.realAccountId) {
            // Real mode requested but no real account - fallback to paper
            console.warn('⚠️ Real mode was saved but no real account ID found - falling back to paper mode');
            api.setTradingMode('paper');
            localStorage.setItem('tradingMode', 'paper');
        } else {
            api.setTradingMode(savedMode);
        }
        
        // Update UI
        updateTradingModeUI(api.tradingMode);
        
        const modeText = api.tradingMode.toUpperCase();
        const accountInfo = api.tradingMode === 'real' 
            ? `Real Account: ${api.realAccountId}` 
            : `Paper Account: ${api.paperAccountId}`;
        console.log(`✓ Trading mode initialized: ${modeText} (${accountInfo})`);
    } catch (e) {
        console.error(`❌ initializeTradingMode ERROR: ${e.message}`);
        // Default to paper mode
        api.setTradingMode('paper');
        updateTradingModeUI('paper');
    }
}

// Update UI to reflect current trading mode
function updateTradingModeUI(mode) {
    const badge = document.getElementById('trading-mode-badge');
    const accountType = document.getElementById('user-account-type');
    const accountIdDisplay = document.getElementById('display-account-id');
    
    if (mode === 'real') {
        // Real trading mode (RED)
        if (badge) {
            badge.className = 'trading-mode-badge real-mode';
            badge.querySelector('.mode-icon').textContent = '🔴';
            badge.querySelector('.mode-text').textContent = 'REAL';
        }
        if (accountType) accountType.textContent = 'Real Trading Account';
        if (accountIdDisplay) accountIdDisplay.textContent = api.realAccountId || '--';
    } else {
        // Paper trading mode (BLUE)
        if (badge) {
            badge.className = 'trading-mode-badge paper-mode';
            badge.querySelector('.mode-icon').textContent = '📄';
            badge.querySelector('.mode-text').textContent = 'PAPER';
        }
        if (accountType) accountType.textContent = 'Paper Trading Account';
        if (accountIdDisplay) accountIdDisplay.textContent = api.paperAccountId || '--';
    }
}

// --- Orders / Positions Panel ---

function setupOrdersPanel() {
    // Tabs
    ui.ordersTabs?.forEach(tab => {
        tab.addEventListener('click', () => {
            ui.ordersTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            if (tabName === 'positions') {
                ui.positionsList.style.display = 'block';
                ui.ordersList.style.display = 'none';
            } else {
                ui.positionsList.style.display = 'none';
                ui.ordersList.style.display = 'block';
            }
        });
    });

    // Load local order history
    try {
        const saved = localStorage.getItem('orderHistory');
        if (saved) {
            appState.orderHistory = JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load orderHistory from localStorage', e);
    }

    renderOrderHistory();

    // Periodically refresh paper summary/positions
    // 500ms = 2x per second for near-instant order updates (matches chart responsiveness)
    // Tradeoff: More API calls to Webull (but still within rate limits)
    setInterval(refreshPaperAccountView, 500);
}

async function refreshPaperAccountView() {
    const startTime = Date.now();
    // console.log(`🔄 refreshPaperAccountView() START at ${new Date().toISOString()}`);
    
    try {
        // Determine which account to refresh based on trading mode
        const isReal = api.tradingMode === 'real';
        const accountId = isReal ? api.realAccountId : api.paperAccountId;
        
        // If we don't have an account wired, skip quietly.
        // This allows using Polygon-only market data without log spam.
        if (!accountId) {
            return;
        }

        // Use getAccountDetailAndPosition for the current tickerId as a proxy
        // for ALL positions (Webull includes positionList in the response).
        // console.log(`   🔍 Fetching account data (4 API calls in parallel)...`);
        const fetchStart = Date.now();
        
        const detailPromise = appState.tickerId
            ? (isReal ? api.getRealAccountDetailAndPosition(appState.tickerId) : api.getPaperAccountDetailAndPosition(appState.tickerId))
            : Promise.resolve(null);

        const [summary, today, detail, orders] = await Promise.all([
            isReal ? api.getRealSummary() : api.getPaperSummary(),
            isReal ? api.getRealTodaySummary() : api.getPaperTodaySummary(),
            detailPromise,
            isReal ? api.getRealOrders() : api.getPaperOrders()
        ]);
        
        const fetchElapsed = Date.now() - fetchStart;
        // console.log(`   ✅ All 4 API calls completed in ${fetchElapsed}ms`);
        // console.log(`      - Summary:`, summary ? 'received' : 'null');
        // if (summary) {
        //     console.log(`         Summary keys:`, Object.keys(summary));
        //     console.log(`         Summary data:`, JSON.stringify(summary, null, 2));
        // }
        // console.log(`      - Today:`, today ? 'received' : 'null');
        // if (today) {
        //     console.log(`         Today keys:`, Object.keys(today));
        // }
        // console.log(`      - Detail:`, detail ? 'received' : 'null');
        // console.log(`      - Orders:`, orders ? `${orders.length || 0} orders` : 'null');

        // Summary numbers (best-effort; handle Webull's capital/account wrappers)
        if (summary) {
            const s = summary.capital || summary;
            const cash =
                s.cash ||
                s.availableCash ||
                s.accountCash ||
                s.totalCash ||
                s.totalCashValue ||
                s.buyingPower;
            const equity =
                s.equity ||
                s.totalMarketValue ||
                s.netLiquidationValue ||
                s.accountValue;

            const cashText = cash != null && cash !== ''
                ? `$${Number(cash).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '--';
            const equityText = equity != null && equity !== ''
                ? `$${Number(equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '--';

            if (ui.paperCash) ui.paperCash.textContent = cashText;
            if (ui.paperEquity) ui.paperEquity.textContent = equityText;
            if (ui.kpiCash) ui.kpiCash.textContent = cashText;

            // Official open P&L from Webull (unrealizedProfitLoss) → "Open P&L"
            const unreal = s.unrealizedProfitLoss || s.unrealizedPnl || s.unrealizedProfitLossValue;
            if (unreal != null && unreal !== '') {
                const val = Number(unreal);
                const sign = val >= 0 ? '+' : '-';
                const text = `${sign}$${Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

                if (ui.paperOpenPnl) {
                    ui.paperOpenPnl.textContent = text;
                    ui.paperOpenPnl.style.color = val >= 0 ? 'var(--cyber-green)' : 'var(--cyber-pink)';
                }
                if (ui.kpiOpenPnl) {
                    ui.kpiOpenPnl.textContent = text;
                    ui.kpiOpenPnl.classList.toggle('positive', val >= 0);
                    ui.kpiOpenPnl.classList.toggle('negative', val < 0);
                }
            } else {
                if (ui.paperOpenPnl) {
                    ui.paperOpenPnl.textContent = '--';
                    ui.paperOpenPnl.style.color = '#666';
                }
                if (ui.kpiOpenPnl) {
                    ui.kpiOpenPnl.textContent = '--';
                    ui.kpiOpenPnl.classList.remove('positive', 'negative');
                }
            }
        }

        if (today) {
            const t = today.account || today;
            const pl = t.todayProfitLoss || t.dayProfitLoss || t.dayPNL || t.pAndL;
            const plVal = Number(pl);
            const plText = pl != null && pl !== ''
                ? `${plVal >= 0 ? '+' : '-'}$${Math.abs(plVal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : '--';
            if (ui.paperPlToday) {
                ui.paperPlToday.textContent = plText;
                ui.paperPlToday.style.color = plVal >= 0 ? 'var(--cyber-green)' : 'var(--cyber-pink)';
            }
            if (ui.kpiPlToday) {
                ui.kpiPlToday.textContent = plText;
                ui.kpiPlToday.classList.toggle('positive', plVal >= 0);
                ui.kpiPlToday.classList.toggle('negative', plVal < 0);
            }
        }

        // Build a positions array - prioritize summary.positions (has actual position data)
        const positions = [];
        
        // console.log(`   🔍 Parsing positions from API responses...`);
        
        // PRIORITY 1: Check summary.positions (this has the actual position data with quantities!)
        if (summary && summary.positions && Array.isArray(summary.positions)) {
            // console.log(`      ✅ Found ${summary.positions.length} positions in summary.positions`);
            summary.positions.forEach((pos, idx) => {
                const qty = pos.quantity || pos.items?.[0]?.quantity || 0;
                // console.log(`      Position ${idx}:`, pos);
                // console.log(`         Symbol: ${pos.symbol || pos.items?.[0]?.symbol || 'unknown'}`);
                // console.log(`         Quantity: ${qty}`);
                // console.log(`         Market Value: ${pos.marketValue || 'unknown'}`);
                
                if (Number(qty) !== 0) {
                    positions.push(pos);
                    // console.log(`         ✅ Added to positions array`);
                } else {
                    // console.log(`         ❌ Skipped (zero quantity)`);
                }
            });
        } else {
            // console.log(`      ⚠️ summary.positions not found, checking detail.positionList...`);
            
            // FALLBACK: Check detail.positionList (this usually only has metadata, not quantities)
            if (detail) {
                const list =
                    (Array.isArray(detail.positionList) && detail.positionList) ||
                    (Array.isArray(detail.data?.positionList) && detail.data.positionList) ||
                    (Array.isArray(detail.positions) && detail.positions) ||
                    (Array.isArray(detail.data?.positions) && detail.data.positions) ||
                    (detail.position ? [detail.position] : []) ||
                    (detail.data?.position ? [detail.data.position] : []);

                if (Array.isArray(list)) {
                    list.forEach((p, idx) => {
                        if (!p) return;
                        
                        const qty = p.position || p.quantity || p.qty || 0;
                        console.log(`      Position ${idx}:`, p);
                        console.log(`         Quantity: ${qty}`);
                        
                        if (Number(qty) !== 0) {
                            positions.push(p);
                            // console.log(`         ✅ Added to positions array`);
                        }
                    });
                }
            }
        }

        // console.log(`   📊 Final positions array length: ${positions.length}`);
        // console.log(`   📊 Rendering ${positions.length} positions...`);
        renderPositions(positions);

        // NOTE: We keep Orders panel driven primarily by local orderHistory
        // (which is updated whenever we place an order). The Webull orders
        // snapshot is still fetched (orders) for future use, but we don't
        // overwrite local history with potentially stale/partial remote data.
        // console.log(`   📋 Rendering order history...`);
        renderOrderHistory();
        
        const elapsed = Date.now() - startTime;
        // console.log(`✅ refreshPaperAccountView() COMPLETE in ${elapsed}ms`);
    } catch (e) {
        const elapsed = Date.now() - startTime;
        console.error(`❌ refreshPaperAccountView() FAILED after ${elapsed}ms:`, e.message);
        log(`Paper account view refresh failed: ${e.message}`, 'error');
    }
}

function renderPositions(positions) {
    // console.log(`🎨 renderPositions() called with ${positions?.length || 0} positions`);
    
    if (!ui.positionsList) {
        console.error(`   ❌ ui.positionsList is null!`);
        return;
    }
    
    ui.positionsList.innerHTML = '';

    if (!positions || positions.length === 0) {
        // console.log(`   📭 No positions to display`);
        const empty = document.createElement('div');
        empty.className = 'orders-empty';
        empty.textContent = 'No positions yet.';
        ui.positionsList.appendChild(empty);
        return;
    }

    positions.forEach((pos, idx) => {
        // console.log(`   📦 Rendering position ${idx + 1}:`, pos);
        
        const row = document.createElement('div');
        row.className = 'order-row';

        // Extract fields from summary.positions structure OR fallback to detail structure
        const symbol = pos.symbol || pos.items?.[0]?.symbol || pos.optionSymbol || pos.tickerSymbol || pos.ticker?.symbol || '--';
        const qty = pos.quantity || pos.items?.[0]?.quantity || pos.position || pos.qty || 0;
        const avgPrice = pos.costPrice || pos.items?.[0]?.costPrice || pos.avgCostPrice || pos.averagePrice || 0;
        const marketValue = pos.marketValue || pos.items?.[0]?.marketValue || pos.marketVal || 0;
        const unrealizedPL = pos.unrealizedProfitLoss || pos.items?.[0]?.unrealizedProfitLoss || 0;
        
        // console.log(`      Symbol: ${symbol}, Qty: ${qty}, Avg: $${avgPrice}, Value: $${marketValue}, P/L: $${unrealizedPL}`);

        row.innerHTML = `
            <div class="order-symbol">${symbol}</div>
            <div>${qty} contracts</div>
            <div>$${Number(avgPrice || 0).toFixed(2)}</div>
            <div>$${Number(marketValue || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
            <button class="order-btn-sell">Sell</button>
        `;

        const sellBtn = row.querySelector('.order-btn-sell');
        sellBtn.addEventListener('click', () => {
            // Pre-fill trade panel for a quick SELL from this position
            if (ui.tickerInput) ui.tickerInput.value = symbol;
            appState.selectedTicker = symbol;
            // Use quantity from position
            const contracts = parseInt(qty, 10) || 0;
            if (contracts > 0 && ui.outContracts) {
                ui.outContracts.textContent = contracts.toString();
            }
            // console.log(`   🔘 Sell button clicked for ${symbol}, ${contracts} contracts`);
        });

        ui.positionsList.appendChild(row);
    });
    
    // console.log(`   ✅ Finished rendering ${positions.length} positions`);
}

function renderOrderHistory() {
    // console.log(`🎨 renderOrderHistory() called`);
    // console.log(`   ui.ordersList exists: ${!!ui.ordersList}`);
    
    if (!ui.ordersList) {
        console.error(`❌ ui.ordersList is null! Cannot render orders.`);
        return;
    }
    
    // Check if orders tab is visible
    const isVisible = ui.ordersList.style.display !== 'none';
    const computedDisplay = window.getComputedStyle(ui.ordersList).display;
    // console.log(`   📺 Orders list visible: ${isVisible} (display: ${ui.ordersList.style.display || 'default'}, computed: ${computedDisplay})`);
    
    // console.log(`   Current orderHistory length: ${appState.orderHistory?.length || 0}`);
    // console.log(`   orderHistory data:`, appState.orderHistory);
    
    ui.ordersList.innerHTML = '';

    if (!appState.orderHistory || appState.orderHistory.length === 0) {
        // console.log(`   📭 No orders to display`);
        const empty = document.createElement('div');
        empty.className = 'orders-empty';
        empty.textContent = 'No orders yet.';
        ui.ordersList.appendChild(empty);
        return;
    }

    // console.log(`   📦 Rendering ${appState.orderHistory.length} orders...`);
    appState.orderHistory.slice().reverse().forEach((o, idx) => {
        // console.log(`      Order ${idx + 1}:`, o);
        const row = document.createElement('div');
        row.className = 'order-row';
        row.innerHTML = `
            <div class="order-symbol">${o.symbol}</div>
            <div class="${o.side === 'BUY' ? 'order-side-buy' : 'order-side-sell'}">${o.side}</div>
            <div>${o.qty}</div>
            <div>$${Number(o.price || 0).toFixed(2)}</div>
            <div class="order-status">${o.status}</div>
        `;
        ui.ordersList.appendChild(row);
    });
    
    // console.log(`   ✅ Finished rendering orders`);
}

// --- Emergency Flatten (Big Red SELL Button) ---

async function partialSell(quantity) {
    if (!appState.isConnected) {
        log('NOT CONNECTED - Cannot place partial SELL', 'error');
        return;
    }
    if (!appState.tickerId) {
        log('No ticker selected', 'error');
        return;
    }
    
    // Block partial sell when market is closed
    if (!appState.marketActuallyOpen) {
        log('❌ MARKET IS CLOSED - Cannot place partial sell during after-hours', 'error');
        log('Option orders can only be placed during regular market hours (9:30 AM - 4:00 PM EST)', 'error');
        return;
    }

    if (!quantity || quantity <= 0) {
        log('Invalid quantity for partial sell', 'error');
        return;
    }

    log(`🔄 Executing partial SELL of ${quantity} contracts...`, 'info');

    try {
        const result = await api.placeOrder({
            tickerId: appState.tickerId,
            side: 'SELL',
            quantity: quantity,
            orderType: 'MKT'
        });

        if (result && result.success) {
            log(`✓ PARTIAL SELL ${quantity} contracts executed successfully`, 'success');
            // Refresh positions after sell
            setTimeout(() => {
                if (typeof refreshPositions === 'function') {
                    refreshPositions();
                }
            }, 1000);
        } else {
            log(`✗ PARTIAL SELL ${quantity} FAILED: ${result?.msg || 'Unknown error'}`, 'error');
        }
    } catch (e) {
        log(`✗ PARTIAL SELL ${quantity} FAILED: ${e.message}`, 'error');
    }
}

async function emergencySell() {
    console.log(`🚨 emergencySell() called`);
    console.log(`   isConnected: ${appState.isConnected}`);
    console.log(`   tickerId: ${appState.tickerId}`);
    console.log(`   optionContractId: ${appState.optionContractId}`);
    console.log(`   marketActuallyOpen: ${appState.marketActuallyOpen}`);
    
    if (!appState.isConnected) {
        console.error('❌ NOT CONNECTED');
        log('NOT CONNECTED - Cannot place emergency SELL', 'error');
        return;
    }
    if (!appState.tickerId) {
        console.error('❌ No ticker selected');
        log('No ticker selected', 'error');
        return;
    }
    
    // Block emergency sell when market is closed
    if (!appState.marketActuallyOpen) {
        console.error('❌ MARKET IS CLOSED');
        log('❌ MARKET IS CLOSED - Cannot place emergency sell during after-hours', 'error');
        log('Option orders can only be placed during regular market hours (9:30 AM - 4:00 PM EST)', 'error');
        return;
    }

    // 1) Get actual position from summary.positions (NOT detail.positionList!)
    console.log(`🔍 Looking up position quantity from summary.positions...`);
    let quantity = 0;
    let optionContractId = appState.optionContractId;
    
    // Determine which account to use based on trading mode
    const isReal = api.tradingMode === 'real';
    console.log(`   Trading mode: ${api.tradingMode} (isReal: ${isReal})`);
    
    try {
        const summary = isReal ? await api.getRealSummary() : await api.getPaperSummary();
        console.log(`   Summary response:`, summary);
        
        if (summary && summary.positions && Array.isArray(summary.positions)) {
            console.log(`   Found ${summary.positions.length} positions in summary`);
            
            // Find position matching current ticker
            const pos = summary.positions.find(p => {
                const posSymbol = p.symbol || p.items?.[0]?.symbol;
                return posSymbol === appState.selectedTicker;
            });
            
            if (pos) {
                quantity = parseInt(pos.quantity || pos.items?.[0]?.quantity || 0);
                optionContractId = pos.items?.[0]?.tickerId || appState.optionContractId;
                
                console.log(`   ✅ Found position for ${appState.selectedTicker}`);
                console.log(`      Quantity: ${quantity}`);
                console.log(`      Option Contract ID: ${optionContractId}`);
            } else {
                console.error(`   ❌ No position found for ${appState.selectedTicker}`);
            }
        } else {
            console.error(`   ❌ No positions in summary`);
        }
    } catch (e) {
        console.error(`   ❌ Position lookup failed:`, e);
        log(`Emergency SELL: position lookup failed: ${e.message}`, 'error');
    }

    if (!quantity || quantity <= 0) {
        console.error(`❌ No position to sell (quantity: ${quantity})`);
        log('No position to flatten for this ticker', 'error');
        return;
    }
    
    if (!optionContractId) {
        console.error(`❌ No option contract ID available`);
        log('No option contract ID available for SELL', 'error');
        return;
    }

    // 2) Get best bid/ask for aggressive slippage-aware limit price
    let bid = null;
    let ask = null;
    let lastPrice = appState.currentPrice || 0;

    try {
        const quote = await api.getQuote(appState.tickerId);
        if (quote) {
            if (quote.bid != null) bid = Number(quote.bid);
            if (quote.ask != null) ask = Number(quote.ask);
            if (quote.close != null) lastPrice = Number(quote.close);
            if (quote.last != null) lastPrice = Number(quote.last);
        }
    } catch (e) {
        log(`Emergency SELL: quote fetch failed, falling back to last known price: ${e.message}`, 'error');
    }

    const tick = 0.01;
    const refBid = bid || lastPrice || 0;
    const refAsk = ask || lastPrice || 0;

    let spread = 0;
    if (bid != null && ask != null && ask > bid) {
        spread = ask - bid;
    } else if (lastPrice) {
        spread = lastPrice * 0.02; // assume ~2% spread worst case if unknown
    } else {
        spread = tick * 10;
    }

    // Aggressive offset: at least 5 ticks, at most 5x spread
    const aggressiveOffset = Math.max(tick * 5, spread * 2);
    let limitPrice = refBid > 0 ? refBid - aggressiveOffset : (lastPrice > 0 ? lastPrice - aggressiveOffset : tick);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
        limitPrice = tick;
    }

    // Round price to 2 decimal places to avoid floating point artifacts
    limitPrice = Math.round(limitPrice * 100) / 100;
    
    // Use MARKET orders when market is open (like buying does), LIMIT when closed
    const useMarketOrder = appState.marketActuallyOpen;
    const orderType = useMarketOrder ? 'MKT' : 'LMT';
    
    console.log(`💰 Calculated limit price: $${limitPrice.toFixed(2)}`);
    console.log(`📊 Order type: ${orderType} (market ${appState.marketActuallyOpen ? 'OPEN' : 'CLOSED'})`);
    log(`🚨 EMERGENCY SELL: Flattening ${quantity} @ ${useMarketOrder ? 'MARKET' : `~${limitPrice.toFixed(2)}`} (DAY)`, 'warn');

    const order = {
        action: 'SELL_TO_CLOSE', // 🎯 Must use SELL_TO_CLOSE to close existing position (not naked short!)
        tickerId: appState.tickerId, // Stock ticker ID (for reference)
        optionTickerId: optionContractId, // 🎯 OPTION contract ID (tells API this is an option order!)
        stockTickerId: appState.tickerId, // Underlying stock ID
        quantity,
        orderType: orderType,
        timeInForce: 'DAY',
        // Allow extended-hours limit emergency exits only when market is actually closed
        outsideRegularTradingHour: !appState.marketActuallyOpen
    };
    
    // Only add price for limit orders
    if (!useMarketOrder) {
        order.price = limitPrice;
    }

    console.log(`📤 Placing SELL order:`, order);

    try {
        const res = await api.placeOrder(order);
        console.log(`📥 Order response:`, res);
        
        if (res) {
            // Live trading: res.placeVo.orderId | Paper trading: res.orderId or res.data.orderId
            const orderId = res.placeVo?.orderId || res.orderId || res.data?.orderId || res.id || 'UNKNOWN';
            console.log(`✅ SELL order successful! Order ID: ${orderId}`);
            log(`✓ EMERGENCY SELL ORDER SENT - Order ID: ${orderId}`, 'success');
            
            // Add exit marker on chart (emergency sell)
            if (chartManager) {
                chartManager.addExitMarker(limitPrice || appState.currentPrice || 0, quantity);
            }

            // After an emergency flatten, clear all auto-exit state & toggles
            clearAutoExitState();

            // Fast-refresh account/positions after emergency flatten
            refreshPaperAccountView();
        } else {
            throw new Error('Empty response from Webull for emergency SELL');
        }
    } catch (e) {
        console.error(`❌ SELL order failed:`, e);
        log(`✗ EMERGENCY SELL FAILED: ${e.message}`, 'error');
        
        // 🚨 DETECT INSUFFICIENT FUNDS / NAKED SHORT ERROR
        const errorMsg = e.message || e.data?.msg || JSON.stringify(e).toLowerCase();
        const isNakedShortError = errorMsg.includes('naked') || errorMsg.includes('not supported');
        const isInsufficientPosition = 
            errorMsg.includes('exceed your current pos') ||
            errorMsg.includes('insufficient position') ||
            errorMsg.includes('pending sell orders');
        
        if (isNakedShortError) {
            showCustomAlert(
                '⚠️ Naked Short Not Allowed',
                `You cannot place this sell order because you don't have an open position to close.\n\n` +
                `Naked option positions are not supported on Webull's platform.`
            );
        } else if (isInsufficientPosition) {
            showCustomAlert(
                '⚠️ Order Exceeds Position',
                `You cannot place this sell order because:\n\n` +
                `• You already have pending sell orders, OR\n` +
                `• This order would exceed your current position\n\n` +
                `Please check your open orders and positions.`
            );
        } else {
            showCustomAlert(
                '❌ Emergency Sell Failed',
                `Your emergency sell order could not be placed.\n\n` +
                `Error: ${e.message || 'Unknown error'}\n\n` +
                `Please check the console for more details.`
            );
        }
    }
}

// --- Full Settings / Hotkeys ---

const DEFAULT_TOOL_HOTKEYS = {
    cursor: 'Escape',
    line: 'L',
    horizontal: 'H',
    brush: 'B',
    rectangle: 'R',
    fib: 'F',
};

const DEFAULT_TRADE_HOTKEYS = {
    buy: 'KeyB',   // Ctrl+B or plain B, depending on browser keyCode
    sell: 'KeyS',
    live: 'KeyL',
};

const DEFAULT_PARTIAL_SELL_HOTKEYS = {
    sell5: null,
    sell10: null,
    sell15: null,
    sell20: null,
    sell30: null,
    sell40: null,
    sell50: null,
    sellCustom: null,
};

function loadToolHotkeys() {
    try {
        const saved = localStorage.getItem('toolHotkeys');
        if (saved) {
            const parsed = JSON.parse(saved);
            return { ...DEFAULT_TOOL_HOTKEYS, ...parsed };
        }
    } catch (e) {
        console.error('Failed to load toolHotkeys from localStorage', e);
    }
    return { ...DEFAULT_TOOL_HOTKEYS };
}

function saveToolHotkeys(hotkeys) {
    try {
        localStorage.setItem('toolHotkeys', JSON.stringify(hotkeys));
    } catch (e) {
        console.error('Failed to save toolHotkeys to localStorage', e);
    }
}

function loadTradeHotkeys() {
    try {
        const saved = localStorage.getItem('tradeHotkeys');
        if (saved) {
            const parsed = JSON.parse(saved);
            return { ...DEFAULT_TRADE_HOTKEYS, ...parsed };
        }
    } catch (e) {
        console.error('Failed to load tradeHotkeys from localStorage', e);
    }
    return { ...DEFAULT_TRADE_HOTKEYS };
}

function saveTradeHotkeys(hotkeys) {
    try {
        localStorage.setItem('tradeHotkeys', JSON.stringify(hotkeys));
    } catch (e) {
        console.error('Failed to save tradeHotkeys to localStorage', e);
    }
}

function loadPartialSellHotkeys() {
    try {
        const saved = localStorage.getItem('partialSellHotkeys');
        if (saved) {
            const parsed = JSON.parse(saved);
            return { ...DEFAULT_PARTIAL_SELL_HOTKEYS, ...parsed };
        }
    } catch (e) {
        console.error('Failed to load partialSellHotkeys from localStorage', e);
    }
    return { ...DEFAULT_PARTIAL_SELL_HOTKEYS };
}

function savePartialSellHotkeys(hotkeys) {
    try {
        localStorage.setItem('partialSellHotkeys', JSON.stringify(hotkeys));
    } catch (e) {
        console.error('Failed to save partialSellHotkeys to localStorage', e);
    }
}

// Candle Colors
function loadCandleColors() {
    try {
        const saved = localStorage.getItem('candleColors');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load candleColors from localStorage', e);
    }
    return null; // Return null to use theme defaults
}

function saveCandleColors(colors) {
    try {
        if (colors) {
            localStorage.setItem('candleColors', JSON.stringify(colors));
        } else {
            localStorage.removeItem('candleColors');
        }
    } catch (e) {
        console.error('Failed to save candleColors to localStorage', e);
    }
}

function applyCandleColors() {
    if (!chartManager) return;
    const colors = loadCandleColors();
    if (colors && colors.up && colors.down) {
        chartManager.candleSeries.applyOptions({
            upColor: colors.up,
            downColor: colors.down,
            wickUpColor: colors.wickUp || colors.up,
            wickDownColor: colors.wickDown || colors.down,
        });
    } else {
        // Use theme defaults
        const currentTheme = localStorage.getItem('theme') || 'dark';
        chartManager.applyTheme(currentTheme);
    }
}

// TP/SL Bar Settings
function loadSLTPSettings() {
    try {
        const saved = localStorage.getItem('slTpSettings');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Failed to load slTpSettings from localStorage', e);
    }
    return null;
}

function saveSLTPSettings(settings) {
    try {
        if (settings) {
            localStorage.setItem('slTpSettings', JSON.stringify(settings));
        } else {
            localStorage.removeItem('slTpSettings');
        }
    } catch (e) {
        console.error('Failed to save slTpSettings to localStorage', e);
    }
}

function applySLTPSettings() {
    if (!chartManager) return;
    const settings = loadSLTPSettings();
    if (settings) {
        // Update existing lines if they exist
        if (chartManager.stopLineObj && chartManager.stopPrice != null) {
            chartManager.setStopLoss(chartManager.stopPrice);
        }
        if (chartManager.takeProfitLineObj && chartManager.takeProfitPrice != null) {
            chartManager.setTakeProfit(chartManager.takeProfitPrice);
        }
        if (chartManager.secondaryStopLossLineObj && chartManager.secondaryStopPrice != null) {
            chartManager.setSecondaryStopLoss(chartManager.secondaryStopPrice);
        }
    }
}

// App Customization Functions
function applyCustomAppName(name) {
    const appTitleElement = document.querySelector('.app-title');
    if (appTitleElement) {
        appTitleElement.textContent = name || 'Robinhood';
    }
    // Also update document title
    const fullTitle = `${name || 'Robinhood'} Trading Desk`;
    document.title = fullTitle;
    
    // Update Electron window title
    if (typeof ipcRenderer !== 'undefined') {
        ipcRenderer.send('update-app-title', fullTitle);
    }
}

// ✅ Save active order state to localStorage for persistence across app restarts
function saveActiveOrderState() {
    try {
        if (appState.activeAutoOrder && !appState.activeAutoOrder.closed) {
            const orderState = {
                activeAutoOrder: appState.activeAutoOrder,
                autoStopEnabled: appState.autoStopEnabled,
                autoTpEnabled: appState.autoTpEnabled,
                autoStopPrice: appState.autoStopPrice,
                autoTpPrice: appState.autoTpPrice,
                manualStopActive: appState.manualStopActive,
                manualStopPrice: appState.manualStopPrice,
                autoStopBasePrice: appState.autoStopBasePrice,
                originalSymmetricStopPrice: appState.originalSymmetricStopPrice,
                stopPlacementPrice: appState.stopPlacementPrice,
                stopPlacementTime: appState.stopPlacementTime,
                tpOverrideMode: appState.tpOverrideMode,
                selectedTicker: appState.selectedTicker,
                selectedOptionType: appState.selectedOptionType,
                timestamp: Date.now()
            };
            localStorage.setItem('activeOrderState', JSON.stringify(orderState));
            console.log('💾 Active order state saved to localStorage');
        }
    } catch (e) {
        console.error('Failed to save active order state:', e);
    }
}

// ✅ Load active order state from localStorage on app startup
function loadActiveOrderState() {
    try {
        const saved = localStorage.getItem('activeOrderState');
        if (!saved) return false;
        
        const orderState = JSON.parse(saved);
        
        // Check if saved state is less than 24 hours old (optional safety check)
        const hoursSinceCreation = (Date.now() - orderState.timestamp) / (1000 * 60 * 60);
        if (hoursSinceCreation > 24) {
            console.log('⚠️ Saved order state is too old (>24h), skipping restore');
            localStorage.removeItem('activeOrderState');
            return false;
        }
        
        // Restore appState
        appState.activeAutoOrder = orderState.activeAutoOrder;
        appState.autoStopEnabled = orderState.autoStopEnabled;
        appState.autoTpEnabled = orderState.autoTpEnabled;
        appState.autoStopPrice = orderState.autoStopPrice;
        appState.autoTpPrice = orderState.autoTpPrice;
        appState.manualStopActive = orderState.manualStopActive || false;
        appState.manualStopPrice = orderState.manualStopPrice || null;
        appState.autoStopBasePrice = orderState.autoStopBasePrice;
        appState.originalSymmetricStopPrice = orderState.originalSymmetricStopPrice;
        appState.stopPlacementPrice = orderState.stopPlacementPrice;
        appState.stopPlacementTime = orderState.stopPlacementTime;
        
        // Restore UI checkboxes
        if (ui.autoStopCheckbox) ui.autoStopCheckbox.checked = orderState.autoStopEnabled;
        if (ui.autoTpCheckbox) ui.autoTpCheckbox.checked = orderState.autoTpEnabled;
        
        // Restore chart lines
        if (chartManager) {
            if (orderState.autoStopEnabled && orderState.autoStopPrice) {
                chartManager.setStopLoss(orderState.autoStopPrice);
            }
            if (orderState.autoTpEnabled && orderState.autoTpPrice) {
                chartManager.setTakeProfit(orderState.autoTpPrice);
            }
            if (orderState.originalSymmetricStopPrice && orderState.tpOverrideMode) {
                chartManager.setSecondaryStopLoss(orderState.originalSymmetricStopPrice);
            }
        }
        
        console.log(`✅ Active order state restored: ${orderState.activeAutoOrder.symbol} ${orderState.activeAutoOrder.side} ${orderState.activeAutoOrder.qty}x @ $${orderState.activeAutoOrder.entryPrice.toFixed(2)}`);
        log(`✅ Restored active position from previous session: ${orderState.activeAutoOrder.symbol}`, 'success');
        
        return true;
    } catch (e) {
        console.error('Failed to load active order state:', e);
        localStorage.removeItem('activeOrderState');
        return false;
    }
}

function clearAutoExitState() {
    appState.autoStopEnabled = false;
    appState.autoTpEnabled = false;
    appState.manualStopActive = false;
    appState.manualStopPrice = null;
    appState.autoStopPrice = null;
    appState.autoStopBasePrice = null;
    appState.autoTpPrice = null;
    appState.originalSymmetricStopPrice = null;

    if (ui.autoStopCheckbox) ui.autoStopCheckbox.checked = false;
    if (ui.autoTpCheckbox) ui.autoTpCheckbox.checked = false;

    if (chartManager) {
        chartManager.setStopLoss(null);
        chartManager.clearTakeProfit();
        chartManager.clearSecondaryStopLoss();
    }

    if (appState.activeAutoOrder) {
        appState.activeAutoOrder.closed = true;
    }
    
    // ✅ Clear saved order state from localStorage
    try {
        localStorage.removeItem('activeOrderState');
        console.log('🗑️ Active order state cleared from localStorage');
    } catch (e) {
        console.error('Failed to clear active order state:', e);
    }
}

// Configure auto stop-loss / take-profit after a successful order
function setupAutoExitAfterOrder(direction, quantity, entryPrice, optionContractId = null) {
    if (!ui.autoStopCheckbox && !ui.autoTpCheckbox) return;
    const expectedMove = parseFloat(ui.move?.value) || 1;
    const targetProfit = parseFloat(ui.profit?.value) || 1000;

    // Calculate gamma-adjusted TP/SL prices to account for delta decay
    let stopPrice, tpPrice;
    
    // Get current delta and contract info
    const currentDelta = Math.abs(appState.currentOptionDelta || 0);
    const strike = appState.selectedStrike || entryPrice;
    const daysToExpiry = getDaysToExpiry();
    const optionType = appState.selectedOptionType || 'call';
    
    if (currentDelta > 0 && quantity > 0 && daysToExpiry > 0) {
        // Calculate gamma-adjusted move needed to hit target profit
        // This accounts for delta changing as the stock moves
        
        // Helper function to find exact price for target profit using iteration
        function findPriceForTargetProfit(startPrice, targetProfit, quantity, direction) {
            let testPrice = startPrice;
            let increment = direction; // +1 for up, -1 for down
            let iterations = 0;
            const maxIterations = 100;
            
            // Start with initial guess based on expectedMove
            testPrice = startPrice + (expectedMove * increment);
            
            while (iterations < maxIterations) {
                const priceMove = Math.abs(testPrice - startPrice);
                
                // Calculate delta at test price
                const deltaAtTest = calculateBlackScholesDelta(testPrice, strike, daysToExpiry, optionType);
                const avgDelta = (currentDelta + Math.abs(deltaAtTest)) / 2;
                
                // Calculate profit at this price
                // profit = quantity * avgDelta * 100 * priceMove
                const projectedProfit = quantity * avgDelta * 100 * priceMove;
                
                // Check if we're close enough (within $1)
                const difference = projectedProfit - targetProfit;
                if (Math.abs(difference) < 1) {
                    return testPrice;
                }
                
                // Adjust price based on whether we're over or under
                if (difference > 0) {
                    // Projected profit too high, reduce move
                    testPrice -= increment * 0.01;
                } else {
                    // Projected profit too low, increase move
                    testPrice += increment * 0.01;
                }
                
                iterations++;
            }
            
            // Fallback if iteration doesn't converge
            return testPrice;
        }
        
        // Calculate TP and SL prices iteratively
        // ✅ AUTO-DETECT TROJAN PUTS MODE: Inverts SL/TP placement if trading put options with Trojan enabled
        const isTrojanPutsMode = appState.tpOverrideMode && appState.selectedOptionType === 'put';
        
        if (direction === 'BUY') {
            if (isTrojanPutsMode) {
                // 🔄 INVERTED for Puts: SL above (at top), TP below (at bottom)
                stopPrice = findPriceForTargetProfit(entryPrice, targetProfit, quantity, 1);  // SL above
                tpPrice = findPriceForTargetProfit(entryPrice, targetProfit, quantity, -1);   // TP below
            } else {
                // Normal for Calls: TP above, SL below
                tpPrice = findPriceForTargetProfit(entryPrice, targetProfit, quantity, 1);
                stopPrice = findPriceForTargetProfit(entryPrice, targetProfit, quantity, -1);
            }
        } else {
            // For shorts, inverted
            tpPrice = findPriceForTargetProfit(entryPrice, targetProfit, quantity, -1);
            stopPrice = findPriceForTargetProfit(entryPrice, targetProfit, quantity, 1);
        }
        
        // Calculate final deltas for logging
        const deltaAtTP = calculateBlackScholesDelta(tpPrice, strike, daysToExpiry, optionType);
        const deltaAtSL = calculateBlackScholesDelta(stopPrice, strike, daysToExpiry, optionType);
        const avgDeltaTP = (currentDelta + Math.abs(deltaAtTP)) / 2;
        const avgDeltaSL = (currentDelta + Math.abs(deltaAtSL)) / 2;
        
        log(`📊 Gamma-adjusted lines: TP at $${tpPrice.toFixed(2)} (move: $${Math.abs(tpPrice - entryPrice).toFixed(2)}), SL at $${stopPrice.toFixed(2)} (move: $${Math.abs(entryPrice - stopPrice).toFixed(2)})`, 'info');
        log(`   Entry delta: ${currentDelta.toFixed(4)}, Avg delta to TP: ${avgDeltaTP.toFixed(4)}, Avg delta to SL: ${avgDeltaSL.toFixed(4)}`, 'info');
    } else {
        // Fallback to simple expectedMove if we don't have delta data
        // ✅ AUTO-DETECT TROJAN PUTS MODE: Inverts SL/TP placement if trading put options with Trojan enabled
        const isTrojanPutsMode = appState.tpOverrideMode && appState.selectedOptionType === 'put';
        
        if (direction === 'BUY') {
            if (isTrojanPutsMode) {
                // 🔄 INVERTED for Puts: SL above (at top), TP below (at bottom)
                stopPrice = entryPrice + expectedMove;  // SL above
                tpPrice = entryPrice - expectedMove;     // TP below
            } else {
                // Normal for Calls: SL below, TP above
                stopPrice = entryPrice - expectedMove;
                tpPrice = entryPrice + expectedMove;
            }
        } else {
            stopPrice = entryPrice + expectedMove;
            tpPrice = entryPrice - expectedMove;
        }
        log(`⚠️ Using simple expectedMove for lines (no delta data available)`, 'warn');
    }

    appState.autoStopPrice = stopPrice;
    appState.autoStopBasePrice = stopPrice;
    appState.manualStopActive = false;
    appState.manualStopPrice = null;
    appState.autoTpPrice = tpPrice;
    appState.originalSymmetricStopPrice = stopPrice; // Store original symmetric stop for reference
    
    // 🚨 CRITICAL: Track placement price for crossover detection
    appState.stopPlacementPrice = entryPrice; // SL placed at entry
    appState.stopPlacementTime = Date.now();
    
    // ✅ CRITICAL: Enable the flags so checkAutoExits() can trigger!
    appState.autoStopEnabled = ui.autoStopCheckbox?.checked || false;
    appState.autoTpEnabled = ui.autoTpCheckbox?.checked || false;
    
    appState.activeAutoOrder = {
        symbol: appState.selectedTicker,
        tickerId: appState.tickerId,
        optionContractId: optionContractId, // ✅ Store option contract ID for auto-exit
        stockTickerId: appState.stockTickerId, // ✅ Store stock ticker ID separately
        side: direction,
        qty: quantity,
        entryPrice,
        stopPrice,
        tpPrice,
        closed: false
    };

    // Update chart lines if checkboxes are enabled
    if (ui.autoStopCheckbox?.checked && stopPrice != null) {
        chartManager.setStopLoss(stopPrice);
    }
    if (ui.autoTpCheckbox?.checked && tpPrice != null) {
        chartManager.setTakeProfit(tpPrice);
    }

    // If Trojan mode is ON (auto-detects Calls/Puts), show secondary stop loss at original symmetric stop
    if (appState.tpOverrideMode && stopPrice != null) {
        chartManager.setSecondaryStopLoss(stopPrice);
        const optionType = appState.selectedOptionType || 'call';
        const modeLabel = optionType === 'put' ? 'Trojan (Puts)' : 'Trojan (Calls)';
        log(`📍 Secondary stop loss set at $${stopPrice.toFixed(2)} (${modeLabel} mode - original symmetric risk: -$${targetProfit.toFixed(0)})`, 'info');
    }

    // Arm slippage-aware exit engine with current sizing + delta
    const calc = tradeLogic.calculate();
    const effectiveDelta = calc.delta || 0;
    const targetProfitUSD = parseFloat(ui.profit?.value) || 0;
    // For now, assume symmetric risk until a dedicated max-loss input is added
    const maxLossUSD = targetProfitUSD;

    try {
        slippageExitEngine.armExit({
            symbol: appState.selectedTicker,
            tickerId: appState.tickerId,
            side: direction === 'BUY' ? 'LONG' : 'SHORT',
            qty: quantity,
            targetProfitUSD,
            maxLossUSD,
            effectiveDelta,
            tickSize: 0.01
        });
    } catch (e) {
        log(`Slippage exit engine armExit failed: ${e.message}`, 'error');
    }
    
    // ✅ Save the active order state to localStorage for persistence
    saveActiveOrderState();
}

// Check auto stop-loss / take-profit triggers on each price update
async function checkAutoExits() {
    const order = appState.activeAutoOrder;
    if (!order || order.closed) return;
    if (!appState.isConnected || !appState.currentPrice || !appState.tickerId) return;

    // 🚨 CRITICAL: Skip SL check if candle was just updated by AM bar (retroactive change)
    // This prevents false triggers from historical corrections
    // AM bars can retroactively lower the candle LOW, causing immediate false triggers
    if (appState.candleJustUpdatedByAMBar) {
        // Silently skip - this is expected behavior
        return;
    }
    
    // 🚨 CRITICAL: Check if price has crossed the SL line from the correct direction
    // This prevents triggers when SL is placed "on the wrong side" of current price
    // User wants SL to trigger when price CROSSES the line, not because it's already past it
    // 
    // Examples:
    // 1. LONG with SL at $215.70, placed when price was $215.57
    //    - Price needs to RISE to $215.70 to trigger
    //    - Should NOT trigger at $215.59 (still below SL, hasn't crossed yet)
    // 2. LONG with SL at $215.50, placed when price was $215.70
    //    - Price needs to DROP to $215.50 to trigger  
    //    - Should trigger at $215.50 or below
    //
    // Logic: Only trigger if price has moved FROM placement price TOWARDS and PAST the SL

    const price = appState.currentPrice;
    const isLong = order.side === 'BUY';

    // 🔍 DEBUG: Get current chart candle for comparison
    const currentCandle = appState.currentMinuteCandle;
    const candleDisplay = currentCandle 
        ? `O:${currentCandle.open.toFixed(2)} H:${currentCandle.high.toFixed(2)} L:${currentCandle.low.toFixed(2)} C:${currentCandle.close.toFixed(2)}`
        : 'No candle';

    // ✅ CRITICAL FIX: Use CURRENT PRICE for SL checks (not historic candle low/high)
    // For trailing stops, we need to check if price COMES BACK to the SL level
    // NOT if the candle's historic low/high (from earlier) touched it
    // Example: User places SL at $215.54, current price is $215.68, candle low is $215.53
    //   - Old logic: Triggers immediately (candle low < SL) ❌ WRONG!
    //   - New logic: Waits for price to drop back to $215.54 ✅ CORRECT!
    const priceForSLCheck = price; // Always use current real-time price

    // 🔍 DEBUG: Log all price sources for comparison
    const debugInfo = {
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 }),
        currentPrice: price.toFixed(4),
        priceForSLCheck: priceForSLCheck.toFixed(4),
        lastPrice: appState.lastPrice ? appState.lastPrice.toFixed(4) : 'null',
        candleClose: currentCandle ? currentCandle.close.toFixed(4) : 'null',
        candleLow: currentCandle ? currentCandle.low.toFixed(4) : 'null',
        candleHigh: currentCandle ? currentCandle.high.toFixed(4) : 'null',
        primarySL: order.stopPrice != null ? order.stopPrice.toFixed(4) : 'null',
        secondarySL: chartManager.secondaryStopPrice != null ? chartManager.secondaryStopPrice.toFixed(4) : 'null',
        tpPrice: order.tpPrice != null ? order.tpPrice.toFixed(4) : 'null',
        entryPrice: order.entryPrice.toFixed(4),
        side: isLong ? 'LONG' : 'SHORT',
        trojanMode: appState.tpOverrideMode ? 'ON' : 'OFF'
    };

    // Stop-loss conditions (check both primary and secondary stop loss)
    // ✅ Supports both protective stops (below entry) and trailing stops (above entry)
    let stopHit = false;
    let secondaryStopHit = false;
    
    // 🔍 Get placement price for crossover detection (used by both primary and secondary SL)
    const placementPrice = appState.stopPlacementPrice || order.entryPrice;
    
    // 🔍 DEBUG: Log why SL might not be checking
    if (!appState.autoStopEnabled) {
        if (appState.autoExitCheckCount % 20 === 0) {
            console.warn(`⚠️ AUTO-STOP IS DISABLED! Enable the "Auto Stop" checkbox to arm stop-loss.`);
        }
    }
    if (order.stopPrice == null) {
        if (appState.autoExitCheckCount % 20 === 0) {
            console.warn(`⚠️ NO STOP PRICE SET! order.stopPrice is null.`);
        }
    }
    
    if (appState.autoStopEnabled && order.stopPrice != null) {
        // ✅ NEW LOGIC: SL triggers when price CROSSES the line from ANY direction
        const slPrice = order.stopPrice;
        const needsToRise = slPrice > placementPrice; // SL is above placement → price needs to rise
        const needsToDrop = slPrice < placementPrice; // SL is below placement → price needs to drop
        
        // Check if price has crossed the SL line
        let hasCrossed = false;
        if (needsToRise) {
            // SL is above placement → trigger when price rises to or above SL
            hasCrossed = priceForSLCheck >= slPrice;
        } else if (needsToDrop) {
            // SL is below placement → trigger when price drops to or below SL
            hasCrossed = priceForSLCheck <= slPrice;
        } else {
            // SL placed exactly at current price → trigger on any movement away then back
            hasCrossed = Math.abs(priceForSLCheck - slPrice) < 0.01; // Within 1 cent
        }
        
        if (hasCrossed) {
            stopHit = true;
            const candleLow = currentCandle ? currentCandle.low.toFixed(2) : 'N/A';
            const candleHigh = currentCandle ? currentCandle.high.toFixed(2) : 'N/A';
            const candleClose = currentCandle ? currentCandle.close.toFixed(2) : 'N/A';
            const direction = needsToRise ? '📈 ROSE' : needsToDrop ? '📉 DROPPED' : '→';
            console.log(`🚨 SL HIT → Price ${direction} to $${priceForSLCheck.toFixed(2)} (SL: $${slPrice.toFixed(2)})`);
            console.log(`   └─ Chart: LOW=$${candleLow} HIGH=$${candleHigh} CLOSE=$${candleClose}`);
            console.log(`   └─ Placed at $${placementPrice.toFixed(2)}, now at $${priceForSLCheck.toFixed(2)}`);
        }
    }
    
    // Check secondary stop loss (Trojan mode) - uses same crossover logic
    if (appState.autoStopEnabled && chartManager.secondaryStopPrice != null) {
        const secondarySL = chartManager.secondaryStopPrice;
        const secondaryNeedsToRise = secondarySL > placementPrice;
        const secondaryNeedsToDrop = secondarySL < placementPrice;
        
        let secondaryHasCrossed = false;
        if (secondaryNeedsToRise) {
            secondaryHasCrossed = priceForSLCheck >= secondarySL;
        } else if (secondaryNeedsToDrop) {
            secondaryHasCrossed = priceForSLCheck <= secondarySL;
        } else {
            secondaryHasCrossed = Math.abs(priceForSLCheck - secondarySL) < 0.01;
        }
        
        if (secondaryHasCrossed) {
            secondaryStopHit = true;
            const direction = secondaryNeedsToRise ? '📈 ROSE' : secondaryNeedsToDrop ? '📉 DROPPED' : '→';
            console.log(`🚨 PROTECTIVE SL HIT → Price ${direction} to $${priceForSLCheck.toFixed(2)} (SL: $${secondarySL.toFixed(2)})`);
        }
    }

    // Take-profit conditions (skip if Trojan override mode is enabled - auto-detects Calls/Puts)
    // ✅ Use REAL MARKET PRICE for TP checks (same as SL for consistency)
    let tpHit = false;
    
    // ✅ TP Check: Use opposite candle value (HIGH for longs, LOW for shorts)
    // For Trojan Puts mode: SL is inverted (above entry), TP is below entry
    const isTrojanPutsMode = appState.tpOverrideMode && appState.selectedOptionType === 'put';
    const priceForTPCheck = currentCandle 
        ? (isLong ? (isTrojanPutsMode ? currentCandle.low : currentCandle.high) : (isTrojanPutsMode ? currentCandle.high : currentCandle.low))
        : price;
        
    if (appState.autoTpEnabled && order.tpPrice != null && !appState.tpOverrideMode) {
        if (isLong && !isTrojanPutsMode && priceForTPCheck >= order.tpPrice) {
            // Normal calls: TP above
            tpHit = true;
            console.log(`🎯 TP HIT → Price $${priceForTPCheck.toFixed(2)} ≥ TP $${order.tpPrice.toFixed(2)}`);
        } else if (isLong && isTrojanPutsMode && priceForTPCheck <= order.tpPrice) {
            // Inverted puts: TP below
            tpHit = true;
            console.log(`🎯 TP HIT (Puts) → Price $${priceForTPCheck.toFixed(2)} ≤ TP $${order.tpPrice.toFixed(2)}`);
        }
        if (!isLong && priceForTPCheck <= order.tpPrice) {
            tpHit = true;
            console.log(`🎯 TP HIT → Price $${priceForTPCheck.toFixed(2)} ≤ TP $${order.tpPrice.toFixed(2)}`);
        }
    }

    // Muted: Periodic status check (too noisy)
    if (!stopHit && !secondaryStopHit && !tpHit) {
        return;
    }

    const reasonKey = (stopHit || secondaryStopHit) ? 'STOP_LOSS' : 'TAKE_PROFIT';
    const optionType = appState.selectedOptionType || 'call';
    const trojanLabel = optionType === 'put' ? 'TROJAN (PUTS)' : 'TROJAN (CALLS)';
    const humanReason = (stopHit || secondaryStopHit) ? (secondaryStopHit ? `SECONDARY STOP LOSS (${trojanLabel})` : 'AUTO STOP LOSS') : 'AUTO TAKE PROFIT';
    const exitSide = isLong ? 'SELL' : 'BUY';

    log(`⚡ ${humanReason} TRIGGERED at $${price.toFixed(2)} → ${exitSide} ${order.qty}`, 'warn');

    // 🚨 CRITICAL: Set closed flag IMMEDIATELY to prevent duplicate triggers
    // SL checks run every 50ms, so without this, multiple exit attempts fire before order completes!
    order.closed = true;

    // Clear local auto-exit visuals
    chartManager.setStopLoss(null);
    chartManager.clearTakeProfit();
    chartManager.clearSecondaryStopLoss();

    try {
        await slippageExitEngine.executeExit({
            symbol: order.symbol || appState.selectedTicker,
            tickerId: order.tickerId,
            optionContractId: order.optionContractId, // ✅ Pass option contract ID for auto-exit
            stockTickerId: order.stockTickerId, // ✅ Pass stock ticker ID separately
            exitSide,
            reason: reasonKey,
            quantity: order.qty,
            bestBid: price,
            bestAsk: price
        });
        
        // Add exit line on chart (auto-exit via TP/SL)
        if (chartManager) {
            chartManager.addExitMarker(price, order.qty);
        }
        
        // After any auto exit (stop or TP), clear auto-exit state & UI toggles
        clearAutoExitState();
    } catch (e) {
        log(`✗ AUTO EXIT FAILED (${humanReason}): ${e.message}`, 'error');
    }
}

function openFullSettings() {
    const modal = document.getElementById('full-settings-modal');
    if (!modal) return;

    const hotkeys = loadToolHotkeys();
    const tradeHotkeys = loadTradeHotkeys();

    // Populate inputs
    const map = {
        cursor: 'hotkey-cursor',
        line: 'hotkey-line',
        horizontal: 'hotkey-horizontal',
        brush: 'hotkey-brush',
        rectangle: 'hotkey-rectangle',
        fib: 'hotkey-fib',
    };

    Object.entries(map).forEach(([tool, inputId]) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        const key = hotkeys[tool] || DEFAULT_TOOL_HOTKEYS[tool];
        input.value = keyLabelFromCode(key);
    });

    // Populate trade hotkeys
    const tradeMap = {
        buy: 'hotkey-buy',
        sell: 'hotkey-sell',
        live: 'hotkey-live',
    };

    Object.entries(tradeMap).forEach(([kind, inputId]) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        const key = tradeHotkeys[kind] || DEFAULT_TRADE_HOTKEYS[kind];
        input.value = keyLabelFromCode(key);
    });

    // Populate partial sell hotkeys
    const partialSellHotkeys = loadPartialSellHotkeys();
    const partialSellMap = {
        sell5: 'hotkey-sell-5',
        sell10: 'hotkey-sell-10',
        sell15: 'hotkey-sell-15',
        sell20: 'hotkey-sell-20',
        sell30: 'hotkey-sell-30',
        sell40: 'hotkey-sell-40',
        sell50: 'hotkey-sell-50',
        sellCustom: 'hotkey-sell-custom',
    };

    Object.entries(partialSellMap).forEach(([kind, inputId]) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        const key = partialSellHotkeys[kind] || DEFAULT_PARTIAL_SELL_HOTKEYS[kind];
        input.value = key ? keyLabelFromCode(key) : '';
    });

    // Populate custom sell amount
    const customSellAmountInput = document.getElementById('custom-sell-amount');
    if (customSellAmountInput) {
        try {
            const saved = localStorage.getItem('customSellAmount');
            if (saved) {
                const amount = parseInt(saved);
                if (amount > 0) {
                    customSellAmountInput.value = amount;
                }
            }
        } catch (e) {
            console.error('Failed to load customSellAmount', e);
        }
    }

    // Populate TP/SL bar settings
    const slTpSettings = loadSLTPSettings();
    const slColorInput = document.getElementById('sl-bar-color');
    const secondarySlColorInput = document.getElementById('secondary-sl-bar-color');
    const tpColorInput = document.getElementById('tp-bar-color');
    const primarySlBarSizeInput = document.getElementById('primary-sl-bar-size');
    const secondarySlBarSizeInput = document.getElementById('secondary-sl-bar-size');
    const tpBarSizeInput = document.getElementById('tp-bar-size');
    const primarySlLabelInput = document.getElementById('primary-sl-label');
    const secondarySlLabelInput = document.getElementById('secondary-sl-label');
    if (slColorInput && tpColorInput) {
        if (slTpSettings) {
            slColorInput.value = slTpSettings.slColor || '#e11d48';
            if (secondarySlColorInput) secondarySlColorInput.value = slTpSettings.secondarySlColor || '#f97316';
            tpColorInput.value = slTpSettings.tpColor || '#22c55e';
            if (primarySlBarSizeInput) primarySlBarSizeInput.value = slTpSettings.primarySlBarSize || 2;
            if (secondarySlBarSizeInput) secondarySlBarSizeInput.value = slTpSettings.secondarySlBarSize || 3;
            if (tpBarSizeInput) tpBarSizeInput.value = slTpSettings.tpBarSize || 2;
            if (primarySlLabelInput) primarySlLabelInput.value = slTpSettings.primarySlLabel || 'STOP';
            if (secondarySlLabelInput) secondarySlLabelInput.value = slTpSettings.secondarySlLabel || 'STOP2';
        } else {
            slColorInput.value = '#e11d48';
            if (secondarySlColorInput) secondarySlColorInput.value = '#f97316';
            tpColorInput.value = '#22c55e';
            if (primarySlBarSizeInput) primarySlBarSizeInput.value = 2;
            if (secondarySlBarSizeInput) secondarySlBarSizeInput.value = 3;
            if (tpBarSizeInput) tpBarSizeInput.value = 2;
            if (primarySlLabelInput) primarySlLabelInput.value = 'STOP';
            if (secondarySlLabelInput) secondarySlLabelInput.value = 'STOP2';
        }
    }

    // Populate candle colors
    const candleColors = loadCandleColors();
    const upColorInput = document.getElementById('candle-up-color');
    const downColorInput = document.getElementById('candle-down-color');
    const upWickColorInput = document.getElementById('candle-up-wick-color');
    const downWickColorInput = document.getElementById('candle-down-wick-color');
    
    const getThemeDefaults = (theme) => {
        if (theme === 'light') {
            return { up: '#059669', down: '#dc2626', wickUp: '#059669', wickDown: '#dc2626' };
        } else if (theme === 'dark-red') {
            return { up: '#22c55e', down: '#ef4444', wickUp: '#22c55e', wickDown: '#ef4444' };
        } else if (theme === 'classic') {
            return { up: '#06ffa5', down: '#f72585', wickUp: '#06ffa5', wickDown: '#f72585' };
        } else {
            return { up: '#22c55e', down: '#e11d48', wickUp: '#22c55e', wickDown: '#e11d48' };
        }
    };
    
    if (upColorInput && downColorInput && upWickColorInput && downWickColorInput) {
        if (candleColors) {
            const currentTheme = localStorage.getItem('theme') || 'dark';
            const defaults = getThemeDefaults(currentTheme);
            upColorInput.value = candleColors.up || defaults.up;
            downColorInput.value = candleColors.down || defaults.down;
            upWickColorInput.value = candleColors.wickUp || candleColors.up || defaults.wickUp;
            downWickColorInput.value = candleColors.wickDown || candleColors.down || defaults.wickDown;
        } else {
            // Use current theme defaults
            const currentTheme = localStorage.getItem('theme') || 'dark';
            const defaults = getThemeDefaults(currentTheme);
            upColorInput.value = defaults.up;
            downColorInput.value = defaults.down;
            upWickColorInput.value = defaults.wickUp;
            downWickColorInput.value = defaults.wickDown;
        }
    }

    // Attach listeners once
    setupHotkeyInputs();

    modal.style.display = 'flex';
}

function closeFullSettings() {
    const modal = document.getElementById('full-settings-modal');
    if (!modal) return;
    modal.style.display = 'none';
}

function setupHotkeyInputs() {
    if (window.__hotkeyInputsInitialized) return;
    window.__hotkeyInputsInitialized = true;

    const modal = document.getElementById('full-settings-modal');
    const resetBtn = document.getElementById('reset-hotkeys');
    const resetTradeBtn = document.getElementById('reset-trade-hotkeys');
    const resetPartialSellBtn = document.getElementById('reset-partial-sell-hotkeys');
    const closeBtn = document.getElementById('close-full-settings');

    // Click on modal background closes it
    modal?.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeFullSettings();
        }
    });

    closeBtn?.addEventListener('click', () => {
        closeFullSettings();
    });

    resetBtn?.addEventListener('click', () => {
        const hotkeys = { ...DEFAULT_TOOL_HOTKEYS };
        saveToolHotkeys(hotkeys);
        // Refresh visible values
        const map = {
            cursor: 'hotkey-cursor',
            line: 'hotkey-line',
            horizontal: 'hotkey-horizontal',
            brush: 'hotkey-brush',
            rectangle: 'hotkey-rectangle',
            fib: 'hotkey-fib',
        };
        Object.entries(map).forEach(([tool, inputId]) => {
            const input = document.getElementById(inputId);
            if (!input) return;
            const key = hotkeys[tool];
            input.value = keyLabelFromCode(key);
        });
        log('Tool hotkeys reset to defaults', 'success');
        // Notify chart tools if needed
        document.dispatchEvent(new CustomEvent('tool-hotkeys-updated', { detail: { hotkeys } }));
    });

    // Candle color inputs
    const upColorInput = document.getElementById('candle-up-color');
    const downColorInput = document.getElementById('candle-down-color');
    const upWickColorInput = document.getElementById('candle-up-wick-color');
    const downWickColorInput = document.getElementById('candle-down-wick-color');
    const resetCandleColorsBtn = document.getElementById('reset-candle-colors');

    const getThemeDefaults = (theme) => {
        if (theme === 'light') {
            return { up: '#059669', down: '#dc2626', wickUp: '#059669', wickDown: '#dc2626' };
        } else if (theme === 'dark-red') {
            return { up: '#22c55e', down: '#ef4444', wickUp: '#22c55e', wickDown: '#ef4444' };
        } else if (theme === 'classic') {
            return { up: '#06ffa5', down: '#f72585', wickUp: '#06ffa5', wickDown: '#f72585' };
        } else {
            return { up: '#22c55e', down: '#e11d48', wickUp: '#22c55e', wickDown: '#e11d48' };
        }
    };

    upColorInput?.addEventListener('change', (e) => {
        const colors = loadCandleColors() || {};
        colors.up = e.target.value;
        saveCandleColors(colors);
        applyCandleColors();
    });

    downColorInput?.addEventListener('change', (e) => {
        const colors = loadCandleColors() || {};
        colors.down = e.target.value;
        saveCandleColors(colors);
        applyCandleColors();
    });

    upWickColorInput?.addEventListener('change', (e) => {
        const colors = loadCandleColors() || {};
        colors.wickUp = e.target.value;
        saveCandleColors(colors);
        applyCandleColors();
    });

    downWickColorInput?.addEventListener('change', (e) => {
        const colors = loadCandleColors() || {};
        colors.wickDown = e.target.value;
        saveCandleColors(colors);
        applyCandleColors();
    });

    resetCandleColorsBtn?.addEventListener('click', () => {
        saveCandleColors(null);
        localStorage.removeItem('candleColors');
        // Reload with theme defaults
        const currentTheme = localStorage.getItem('theme') || 'dark';
        chartManager.applyTheme(currentTheme);
        // Update inputs
        const defaults = getThemeDefaults(currentTheme);
        if (upColorInput) upColorInput.value = defaults.up;
        if (downColorInput) downColorInput.value = defaults.down;
        if (upWickColorInput) upWickColorInput.value = defaults.wickUp;
        if (downWickColorInput) downWickColorInput.value = defaults.wickDown;
        log('Candle colors reset to theme defaults', 'success');
    });

    // TP/SL bar settings
    const slColorInput = document.getElementById('sl-bar-color');
    const secondarySlColorInput = document.getElementById('secondary-sl-bar-color');
    const tpColorInput = document.getElementById('tp-bar-color');
    const primarySlBarSizeInput = document.getElementById('primary-sl-bar-size');
    const secondarySlBarSizeInput = document.getElementById('secondary-sl-bar-size');
    const tpBarSizeInput = document.getElementById('tp-bar-size');
    const primarySlLabelInput = document.getElementById('primary-sl-label');
    const secondarySlLabelInput = document.getElementById('secondary-sl-label');
    const resetSLTPBtn = document.getElementById('reset-sl-tp-bars');

    slColorInput?.addEventListener('change', (e) => {
        const settings = loadSLTPSettings() || {};
        settings.slColor = e.target.value;
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    secondarySlColorInput?.addEventListener('change', (e) => {
        const settings = loadSLTPSettings() || {};
        settings.secondarySlColor = e.target.value;
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    tpColorInput?.addEventListener('change', (e) => {
        const settings = loadSLTPSettings() || {};
        settings.tpColor = e.target.value;
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    // Primary SL Bar Size
    primarySlBarSizeInput?.addEventListener('input', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value) || value < 1) value = 1;
        if (value > 10) value = 10;
        e.target.value = value;
        
        const settings = loadSLTPSettings() || {};
        settings.primarySlBarSize = value;
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    // Secondary SL Bar Size
    secondarySlBarSizeInput?.addEventListener('input', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value) || value < 1) value = 1;
        if (value > 10) value = 10;
        e.target.value = value;
        
        const settings = loadSLTPSettings() || {};
        settings.secondarySlBarSize = value;
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    // TP Bar Size
    tpBarSizeInput?.addEventListener('input', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value) || value < 1) value = 1;
        if (value > 10) value = 10;
        e.target.value = value;
        
        const settings = loadSLTPSettings() || {};
        settings.tpBarSize = value;
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    primarySlLabelInput?.addEventListener('input', (e) => {
        const settings = loadSLTPSettings() || {};
        settings.primarySlLabel = e.target.value.trim() || 'STOP';
        saveSLTPSettings(settings);
        applySLTPSettings();
    });

    secondarySlLabelInput?.addEventListener('input', (e) => {
        const settings = loadSLTPSettings() || {};
        settings.secondarySlLabel = e.target.value.trim() || 'STOP2';
        saveSLTPSettings(settings);
        applySLTPSettings();
    });
    
    // ✅ NEW: Line drag mode checkbox
    const lineDragCheckbox = document.getElementById('line-drag-enabled');
    lineDragCheckbox?.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        localStorage.setItem('lineDragEnabled', enabled ? 'true' : 'false');
        
        if (enabled) {
            log('✅ Line drag mode ENABLED - Click and drag SL/TP lines to move them', 'success');
        } else {
            log('✅ Double-click mode ENABLED - Double left-click for SL, double right-click for TP', 'success');
        }
    });
    
    // Load saved line drag setting
    try {
        const savedLineDrag = localStorage.getItem('lineDragEnabled');
        if (lineDragCheckbox) {
            lineDragCheckbox.checked = savedLineDrag === 'true';
        }
    } catch (e) {
        console.error('Failed to load line drag setting', e);
    }

    // ✅ Default Trojan mode checkbox (auto-detects Calls/Puts)
    const defaultTrojanCheckbox = document.getElementById('default-trojan-enabled');
    defaultTrojanCheckbox?.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        localStorage.setItem('defaultTrojanEnabled', enabled ? 'true' : 'false');
        
        if (enabled) {
            log('✅ Trojan mode will be ENABLED by default on app startup (auto-detects Calls/Puts)', 'success');
        } else {
            log('⚠️ Trojan mode will be DISABLED by default on app startup', 'info');
        }
    });
    
    // Load saved default Trojan setting
    try {
        const savedDefaultTrojan = localStorage.getItem('defaultTrojanEnabled');
        if (defaultTrojanCheckbox) {
            defaultTrojanCheckbox.checked = savedDefaultTrojan === 'true';
        }
    } catch (e) {
        console.error('Failed to load default Trojan setting', e);
    }

    // ✅ Emergency Exit on Disconnect checkbox
    const emergencyExitCheckbox = document.getElementById('emergency-exit-on-disconnect');
    emergencyExitCheckbox?.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        localStorage.setItem('emergencyExitOnDisconnect', enabled ? 'true' : 'false');
        
        if (enabled) {
            log('🚨 Emergency Exit ENABLED - Position will auto-close if app crashes or connection drops', 'warn');
        } else {
            log('⚠️ Emergency Exit DISABLED - Position will NOT auto-close on disconnect', 'info');
        }
    });
    
    // Load saved emergency exit setting
    try {
        const savedEmergencyExit = localStorage.getItem('emergencyExitOnDisconnect');
        if (emergencyExitCheckbox) {
            emergencyExitCheckbox.checked = savedEmergencyExit === 'true';
        }
    } catch (e) {
        console.error('Failed to load emergency exit setting', e);
    }

    resetSLTPBtn?.addEventListener('click', () => {
        saveSLTPSettings(null);
        localStorage.removeItem('slTpSettings');
        // Reset to defaults
        if (slColorInput) slColorInput.value = '#e11d48';
        if (secondarySlColorInput) secondarySlColorInput.value = '#f97316';
        if (tpColorInput) tpColorInput.value = '#22c55e';
        if (primarySlBarSizeInput) primarySlBarSizeInput.value = 2;
        if (secondarySlBarSizeInput) secondarySlBarSizeInput.value = 3;
        if (tpBarSizeInput) tpBarSizeInput.value = 2;
        if (primarySlLabelInput) primarySlLabelInput.value = 'STOP';
        if (secondarySlLabelInput) secondarySlLabelInput.value = 'STOP2';
        applySLTPSettings();
        log('TP/SL bar settings reset to defaults', 'success');
    });

    // Entry/Exit Line Settings
    const showEntryMarkersCheckbox = document.getElementById('show-entry-markers-checkbox');
    const showExitMarkersCheckbox = document.getElementById('show-exit-markers-checkbox');
    const entryMarkerColorInput = document.getElementById('entry-marker-color');
    const entryMarkerSizeInput = document.getElementById('entry-marker-size');
    const exitMarkerColorInput = document.getElementById('exit-marker-color');
    const exitMarkerSizeInput = document.getElementById('exit-marker-size');
    const clearAllMarkersBtn = document.getElementById('clear-all-markers');
    const resetMarkerSettingsBtn = document.getElementById('reset-marker-settings');

    // Load line settings from localStorage
    function loadTradeLineSettings() {
        const defaults = {
            entryColor: '#22c55e',
            entryWidth: 1,
            exitColor: '#ef4444',
            exitWidth: 1
        };
        const saved = localStorage.getItem('tradeLineSettings');
        return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
    }

    // Save line settings to localStorage
    function saveTradeLineSettings(settings) {
        localStorage.setItem('tradeLineSettings', JSON.stringify(settings));
    }

    // Initialize line settings from localStorage
    const lineSettings = loadTradeLineSettings();
    if (entryMarkerColorInput) entryMarkerColorInput.value = lineSettings.entryColor;
    if (entryMarkerSizeInput) entryMarkerSizeInput.value = lineSettings.entryWidth;
    if (exitMarkerColorInput) exitMarkerColorInput.value = lineSettings.exitColor;
    if (exitMarkerSizeInput) exitMarkerSizeInput.value = lineSettings.exitWidth;

    // Initialize checkbox states from localStorage
    if (showEntryMarkersCheckbox) {
        showEntryMarkersCheckbox.checked = localStorage.getItem('showEntryLines') === 'true';
    }
    if (showExitMarkersCheckbox) {
        showExitMarkersCheckbox.checked = localStorage.getItem('showExitLines') === 'true';
    }

    showEntryMarkersCheckbox?.addEventListener('change', (e) => {
        localStorage.setItem('showEntryLines', e.target.checked ? 'true' : 'false');
        log(`Entry lines ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
    });

    showExitMarkersCheckbox?.addEventListener('change', (e) => {
        localStorage.setItem('showExitLines', e.target.checked ? 'true' : 'false');
        log(`Exit lines ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
    });

    entryMarkerColorInput?.addEventListener('change', (e) => {
        const settings = loadTradeLineSettings();
        settings.entryColor = e.target.value;
        saveTradeLineSettings(settings);
        log('Entry line color updated', 'info');
    });

    entryMarkerSizeInput?.addEventListener('change', (e) => {
        const settings = loadTradeLineSettings();
        settings.entryWidth = parseInt(e.target.value) || 1;
        saveTradeLineSettings(settings);
        log('Entry line width updated', 'info');
    });

    exitMarkerColorInput?.addEventListener('change', (e) => {
        const settings = loadTradeLineSettings();
        settings.exitColor = e.target.value;
        saveTradeLineSettings(settings);
        log('Exit line color updated', 'info');
    });

    exitMarkerSizeInput?.addEventListener('change', (e) => {
        const settings = loadTradeLineSettings();
        settings.exitWidth = parseInt(e.target.value) || 1;
        saveTradeLineSettings(settings);
        log('Exit line width updated', 'info');
    });

    clearAllMarkersBtn?.addEventListener('click', () => {
        if (chartManager) {
            chartManager.clearAllMarkers();
            log('All entry/exit lines cleared', 'success');
        }
    });

    resetMarkerSettingsBtn?.addEventListener('click', () => {
        localStorage.removeItem('tradeLineSettings');
        if (entryMarkerColorInput) entryMarkerColorInput.value = '#22c55e';
        if (entryMarkerSizeInput) entryMarkerSizeInput.value = 1;
        if (exitMarkerColorInput) exitMarkerColorInput.value = '#ef4444';
        if (exitMarkerSizeInput) exitMarkerSizeInput.value = 1;
        log('Line settings reset to defaults', 'success');
    });

    resetTradeBtn?.addEventListener('click', () => {
        const tradeHotkeys = { ...DEFAULT_TRADE_HOTKEYS };
        saveTradeHotkeys(tradeHotkeys);
        const tradeMap = {
            buy: 'hotkey-buy',
            sell: 'hotkey-sell',
            live: 'hotkey-live',
        };
        Object.entries(tradeMap).forEach(([kind, inputId]) => {
            const input = document.getElementById(inputId);
            if (!input) return;
            const key = tradeHotkeys[kind];
            input.value = keyLabelFromCode(key);
        });
        log('Trade hotkeys reset to defaults', 'success');
    });

    resetPartialSellBtn?.addEventListener('click', () => {
        const partialSellHotkeys = { ...DEFAULT_PARTIAL_SELL_HOTKEYS };
        savePartialSellHotkeys(partialSellHotkeys);
        const partialSellMap = {
            sell5: 'hotkey-sell-5',
            sell10: 'hotkey-sell-10',
            sell15: 'hotkey-sell-15',
            sell20: 'hotkey-sell-20',
            sell30: 'hotkey-sell-30',
            sell40: 'hotkey-sell-40',
            sell50: 'hotkey-sell-50',
            sellCustom: 'hotkey-sell-custom',
        };
        Object.entries(partialSellMap).forEach(([kind, inputId]) => {
            const input = document.getElementById(inputId);
            if (!input) return;
            const key = partialSellHotkeys[kind];
            input.value = key ? keyLabelFromCode(key) : '';
        });
        // Reset custom amount
        const customSellAmountInput = document.getElementById('custom-sell-amount');
        if (customSellAmountInput) {
            customSellAmountInput.value = 25;
            localStorage.removeItem('customSellAmount');
        }
        log('Partial sell hotkeys reset to defaults', 'success');
    });

    // Custom sell amount input
    const customSellAmountInput = document.getElementById('custom-sell-amount');
    customSellAmountInput?.addEventListener('change', (e) => {
        const amount = parseInt(e.target.value);
        if (amount > 0) {
            try {
                localStorage.setItem('customSellAmount', amount.toString());
            } catch (e) {
                console.error('Failed to save customSellAmount', e);
            }
        }
    });

    // Clear buttons for partial sell hotkeys
    document.querySelectorAll('.hotkey-clear-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const inputId = btn.dataset.hotkey;
            const input = document.getElementById(inputId);
            if (!input) return;

            // Find which hotkey this is
            const qty = input.dataset.qty;
            if (!qty) return;

            const qtyKey = qty === 'custom' ? 'sellCustom' : `sell${qty}`;
            const hotkeys = loadPartialSellHotkeys();
            delete hotkeys[qtyKey];
            savePartialSellHotkeys(hotkeys);
            
            input.value = '';
            log(`Cleared hotkey for Sell ${qty === 'custom' ? 'Custom' : qty}`, 'info');
        });
    });

    // App Customization - Name only
    const customAppNameInput = document.getElementById('custom-app-name');
    const resetAppCustomizationBtn = document.getElementById('reset-app-customization');

    // Load saved app name
    const savedAppName = localStorage.getItem('customAppName');
    if (savedAppName && customAppNameInput) {
        customAppNameInput.value = savedAppName;
    }

    // App name change handler
    customAppNameInput?.addEventListener('change', (e) => {
        const newName = e.target.value.trim();
        if (newName) {
            localStorage.setItem('customAppName', newName);
            applyCustomAppName(newName);
            log(`App name changed to: ${newName}`, 'success');
        } else {
            localStorage.removeItem('customAppName');
            applyCustomAppName('Robinhood');
            log('App name reset to default', 'info');
        }
    });

    // Reset app customization
    resetAppCustomizationBtn?.addEventListener('click', () => {
        localStorage.removeItem('customAppName');
        
        if (customAppNameInput) customAppNameInput.value = '';
        
        applyCustomAppName('Robinhood');
        log('App name reset to default', 'success');
    });

    // Polygon API Key Configuration (DISABLED - now using Webull for all market data)
    const polygonApiKeyInput = null; // document.getElementById('polygon-api-key-input');
    const savePolygonKeyBtn = null; // document.getElementById('save-polygon-key');
    const apiKeyStatusEl = null; // document.getElementById('api-key-status');

    // Load and display saved API key
    function updateApiKeyStatus() {
        const savedKey = localStorage.getItem('POLYGON_API_KEY');
        if (savedKey && savedKey.trim()) {
            if (apiKeyStatusEl) {
                apiKeyStatusEl.textContent = '✅ Key saved';
                apiKeyStatusEl.style.color = '#22c55e';
            }
            if (polygonApiKeyInput) {
                polygonApiKeyInput.value = savedKey;
            }
            // Hide warning banner if exists
            const warningBanner = document.getElementById('api-key-warning-banner');
            if (warningBanner) {
                warningBanner.style.display = 'none';
            }
            return true;
        } else {
            if (apiKeyStatusEl) {
                apiKeyStatusEl.textContent = '⚠️ No key set';
                apiKeyStatusEl.style.color = '#ef4444';
            }
            return false;
        }
    }

    // Custom alert function now defined globally - see top of file

    // Save API key handler (DISABLED - Webull authentication used instead)
    savePolygonKeyBtn?.addEventListener('click', () => {
        const key = null; // polygonApiKeyInput?.value?.trim();
        
        if (false && !key) { // Disabled code block
            showCustomAlert('Please enter a valid API key before saving.', 'Missing API Key', '⚠️');
            log('❌ Attempted to save empty API key', 'error');
            return;
        }

        try {
            // Webull doesn't need separate API key - using built-in authentication
            log('Webull authentication used instead of Polygon API key', 'info');
            
            // Disabled Polygon WebSocket code
            polygonWebSocket.apiKey = key;
            
            // Update UI status
            updateApiKeyStatus();
            
            // Show success message
            showCustomAlert(
                'Your Polygon API key has been saved successfully!\n\n' +
                'The key is now active. If you have a ticker selected, ' +
                'the app will automatically reconnect to Polygon.',
                'Success!',
                '✅'
            );
            
            log('✅ Polygon API key saved and activated', 'success');
            
            // Webull doesn't need separate API key setup - using built-in authentication
            log('✅ Settings saved', 'info');
        } catch (e) {
            showCustomAlert(`Error saving API key: ${e.message}`, 'Error', '❌');
            log(`❌ Error saving API key: ${e.message}`, 'error');
        }
    });

    // Show warning banner if no API key is set
    function showApiKeyWarning() {
        const hasKey = localStorage.getItem('POLYGON_API_KEY');
        if (!hasKey) {
            // Create warning banner if it doesn't exist
            let banner = document.getElementById('api-key-warning-banner');
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'api-key-warning-banner';
                banner.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                    color: white;
                    padding: 12px 20px;
                    text-align: center;
                    z-index: 99999;
                    font-weight: 600;
                    font-size: 13px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 10px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    user-select: none;
                `;
                banner.innerHTML = `
                    <span style="font-size: 16px; pointer-events: none;">⚠️</span>
                    <span style="pointer-events: none;">Polygon API Key Required!</span>
                    <span style="color: white; text-decoration: underline; font-weight: bold; margin-left: 10px; pointer-events: none;">
                        Click here to add your key in Settings
                    </span>
                    <span style="font-size: 16px; margin-left: 10px; pointer-events: none;">⚙️</span>
                    <button id="dismiss-banner" style="
                        position: absolute;
                        right: 10px;
                        background: rgba(255,255,255,0.2);
                        border: 1px solid rgba(255,255,255,0.3);
                        color: white;
                        padding: 4px 12px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 11px;
                        font-weight: bold;
                        z-index: 100000;
                    ">Dismiss</button>
                `;
                document.body.prepend(banner);

                // Add click handler for entire banner
                banner.onclick = function(e) {
                    // Don't trigger if clicking dismiss button
                    if (e.target && e.target.id === 'dismiss-banner') {
                        return;
                    }
                    
                    log('🖱️ Warning banner clicked - opening Settings', 'info');
                    
                    // Open settings modal
                    const settingsModal = document.getElementById('full-settings-modal');
                    if (settingsModal) {
                        settingsModal.style.display = 'flex';
                        log('📋 Settings opened from warning banner', 'info');
                        
                        // Scroll to API key section
                        setTimeout(() => {
                            const apiKeySection = document.querySelector('#polygon-api-key-input');
                            if (apiKeySection) {
                                apiKeySection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                apiKeySection.focus();
                                log('🎯 Scrolled to API key input field', 'info');
                            }
                        }, 200);
                    } else {
                        log('❌ Settings modal not found', 'error');
                    }
                };

                // Add hover effect
                banner.addEventListener('mouseenter', () => {
                    banner.style.background = 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)';
                });
                banner.addEventListener('mouseleave', () => {
                    banner.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
                });

                // Dismiss button handler
                setTimeout(() => {
                    const dismissBtn = document.getElementById('dismiss-banner');
                    if (dismissBtn) {
                        dismissBtn.onclick = function(e) {
                            e.stopPropagation();
                            e.preventDefault();
                            banner.style.display = 'none';
                            log('ℹ️ API key warning banner dismissed', 'info');
                        };
                    }
                }, 100);
            }
            banner.style.display = 'flex';
            log('⚠️ No Polygon API key found - showing warning banner', 'warn');
        }
    }

    // Show "Invalid API Key" banner when 401 errors occur
    function showInvalidApiKeyBanner() {
        // Remove "no key" banner if it exists
        const noKeyBanner = document.getElementById('api-key-warning-banner');
        if (noKeyBanner) {
            noKeyBanner.style.display = 'none';
        }

        // Check if banner already exists
        let banner = document.getElementById('invalid-api-key-banner');
        if (banner) {
            banner.style.display = 'flex';
            return;
        }

        // Create new invalid key banner
        banner = document.createElement('div');
        banner.id = 'invalid-api-key-banner';
        banner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
            color: white;
            padding: 12px 20px;
            text-align: center;
            z-index: 99999;
            font-weight: 600;
            font-size: 13px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            cursor: pointer;
            transition: all 0.2s ease;
            user-select: none;
            animation: shake 0.5s ease;
        `;
        
        banner.innerHTML = `
            <span style="font-size: 18px; pointer-events: none;">❌</span>
            <span style="pointer-events: none; font-size: 14px;"><strong>API Key Invalid or Expired!</strong></span>
            <span style="color: white; text-decoration: underline; font-weight: bold; margin-left: 10px; pointer-events: none;">
                Click here to update your Polygon API key
            </span>
            <span style="font-size: 16px; margin-left: 10px; pointer-events: none;">🔑</span>
            <button id="dismiss-invalid-banner" style="
                position: absolute;
                right: 10px;
                background: rgba(255,255,255,0.2);
                border: 1px solid rgba(255,255,255,0.3);
                color: white;
                padding: 4px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
                font-weight: bold;
                z-index: 100000;
            ">Dismiss</button>
        `;
        document.body.prepend(banner);

        // Add shake animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes shake {
                0%, 100% { transform: translateX(0); }
                10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
                20%, 40%, 60%, 80% { transform: translateX(5px); }
            }
        `;
        document.head.appendChild(style);

        // Click handler to open settings
        banner.onclick = function(e) {
            if (e.target && e.target.id === 'dismiss-invalid-banner') {
                return;
            }
            
            log('🖱️ Invalid API key banner clicked - opening Settings', 'warn');
            
            const settingsModal = document.getElementById('full-settings-modal');
            if (settingsModal) {
                settingsModal.style.display = 'flex';
                
                setTimeout(() => {
                    const apiKeySection = document.querySelector('#polygon-api-key-input');
                    if (apiKeySection) {
                        apiKeySection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        apiKeySection.select(); // Select all text for easy replacement
                        log('🎯 Scrolled to API key input field', 'info');
                    }
                }, 200);
            }
        };

        // Hover effect
        banner.addEventListener('mouseenter', () => {
            banner.style.background = 'linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%)';
        });
        banner.addEventListener('mouseleave', () => {
            banner.style.background = 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)';
        });

        // Dismiss button
        setTimeout(() => {
            const dismissBtn = document.getElementById('dismiss-invalid-banner');
            if (dismissBtn) {
                dismissBtn.onclick = function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    banner.style.display = 'none';
                    log('ℹ️ Invalid API key banner dismissed', 'info');
                };
            }
        }, 100);

        log('❌ Invalid API key detected - showing error banner', 'error');
    }

    // Listen for invalid API key events from Polygon
    document.addEventListener('polygon-api-key-invalid', (e) => {
        log(`❌ Polygon API Key Error: ${e.detail.message}`, 'error');
        showInvalidApiKeyBanner();
        
        // Also show custom alert
        showCustomAlert(
            'Your Polygon API key appears to be invalid or expired.\n\n' +
            'Please go to Settings and update your API key.\n\n' +
            'Get a new free key at: polygon.io',
            'Invalid API Key',
            '❌'
        );
    });

    // Listen for max_connections error from Polygon
    document.addEventListener('polygon-max-connections', (e) => {
        log(`❌ Max Connections Error: ${e.detail.message}`, 'error');
        
        // Show permanent error banner
        showMaxConnectionsBanner();
        
        // Show alert with detailed instructions
        showCustomAlert(
            'Another app instance is using your Polygon API key.\n\n' +
            'Polygon free tier only allows 1 WebSocket connection per key.\n\n' +
            '🔧 Solutions:\n' +
            '1. Close all other app windows\n' +
            '2. Check Task Manager for duplicate processes\n' +
            '3. Or generate a new API key at polygon.io\n\n' +
            'Then reload this app.',
            'Connection Limit Reached',
            '🚫'
        );
    });

    // Show max_connections error banner
    function showMaxConnectionsBanner() {
        // Remove other banners
        const noKeyBanner = document.getElementById('api-key-warning-banner');
        const invalidBanner = document.getElementById('invalid-api-key-banner');
        if (noKeyBanner) noKeyBanner.style.display = 'none';
        if (invalidBanner) invalidBanner.style.display = 'none';

        // Check if banner already exists
        let banner = document.getElementById('max-connections-banner');
        if (banner) {
            banner.style.display = 'flex';
            return;
        }

        // Create new max_connections banner
        banner = document.createElement('div');
        banner.id = 'max-connections-banner';
        banner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%);
            color: white;
            padding: 15px 20px;
            text-align: center;
            z-index: 99999;
            font-weight: 600;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            user-select: none;
        `;
        
        banner.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-size: 20px;">🚫</span>
                <span style="font-size: 16px;"><strong>Connection Limit Reached</strong></span>
            </div>
            <div style="font-size: 13px; font-weight: normal; max-width: 800px;">
                Another app instance is using your Polygon API key. Close other instances or generate a new key.
            </div>
            <button onclick="location.reload()" style="
                background: rgba(255,255,255,0.9);
                color: #7f1d1d;
                border: none;
                padding: 8px 20px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
                font-size: 13px;
                margin-top: 5px;
            ">🔄 Reload App</button>
        `;
        document.body.prepend(banner);

        log('🚫 Max connections error - showing permanent banner', 'error');
    }

    // Initialize API key status on load
    updateApiKeyStatus();
    
    // Show warning banner if needed
    setTimeout(() => showApiKeyWarning(), 1000);

    document.querySelectorAll('.hotkey-input').forEach(input => {
        // Skip number inputs - they have their own handlers
        if (input.type === 'number') {
            return;
        }
        
        // Skip inputs that aren't for hotkeys (no data attributes)
        if (!input.dataset.tool && !input.dataset.trade && !input.dataset.qty) {
            return;
        }
        
        input.addEventListener('focus', () => {
            input.value = 'Press key';
        });

        input.addEventListener('blur', () => {
            // Handle tool hotkeys
            if (input.dataset.tool) {
                const hotkeys = loadToolHotkeys();
                const tool = input.dataset.tool;
                const key = hotkeys[tool] || DEFAULT_TOOL_HOTKEYS[tool];
                input.value = keyLabelFromCode(key);
            }
            // Handle trade hotkeys
            else if (input.dataset.trade) {
                const hotkeys = loadTradeHotkeys();
                const trade = input.dataset.trade;
                const key = hotkeys[trade] || DEFAULT_TRADE_HOTKEYS[trade];
                input.value = keyLabelFromCode(key);
            }
            // Handle partial sell hotkeys
            else if (input.dataset.qty) {
                const hotkeys = loadPartialSellHotkeys();
                const qty = input.dataset.qty;
                const qtyKey = qty === 'custom' ? 'sellCustom' : `sell${qty}`;
                const key = hotkeys[qtyKey] || DEFAULT_PARTIAL_SELL_HOTKEYS[qtyKey];
                input.value = key ? keyLabelFromCode(key) : '';
            }
        });

        input.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const tool = input.dataset.tool;
            if (!tool) return;

            const code = e.code || e.key;
            const label = keyLabelFromCode(code);
            input.value = label;

            const hotkeys = loadToolHotkeys();
            hotkeys[tool] = code;
            saveToolHotkeys(hotkeys);
            log(`Hotkey set for ${tool} → ${label}`, 'success');

            // Notify chart tools of updated mapping
            document.dispatchEvent(new CustomEvent('tool-hotkeys-updated', { detail: { hotkeys } }));
        });

        // Support mouse buttons (e.g., side buttons) as tool hotkeys
        input.addEventListener('mousedown', (e) => {
            // Left click just focuses; ignore
            if (e.button === 0) return;

            e.preventDefault();
            e.stopPropagation();

            const tool = input.dataset.tool;
            if (!tool) return;

            const code = mouseCodeFromButton(e.button);
            if (!code) return;

            const label = keyLabelFromCode(code);
            input.value = label;

            const hotkeys = loadToolHotkeys();
            hotkeys[tool] = code;
            saveToolHotkeys(hotkeys);
            log(`Hotkey set for ${tool} → ${label}`, 'success');

            document.dispatchEvent(new CustomEvent('tool-hotkeys-updated', { detail: { hotkeys } }));
        });
    });

    // Trade hotkey inputs (BUY/SELL/LIVE)
    document.querySelectorAll('.trade-hotkey-input').forEach(input => {
        input.addEventListener('focus', () => {
            input.value = 'Press key';
        });

        input.addEventListener('blur', () => {
            const hotkeys = loadTradeHotkeys();
            const kind = input.dataset.trade;
            const key = hotkeys[kind] || DEFAULT_TRADE_HOTKEYS[kind];
            input.value = keyLabelFromCode(key);
        });

        input.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const kind = input.dataset.trade;
            if (!kind) return;

            const code = e.code || e.key;
            const label = keyLabelFromCode(code);
            input.value = label;

            const hotkeys = loadTradeHotkeys();
            hotkeys[kind] = code;
            saveTradeHotkeys(hotkeys);
            log(`Trade hotkey set for ${kind.toUpperCase()} → ${label}`, 'success');
        });

        // Allow mapping mouse buttons (Mouse4/Mouse5/etc.) to trade hotkeys.
        input.addEventListener('focus', () => {
            const kind = input.dataset.trade;
            if (!kind) return;

            const onMouse = (e) => {
                // Don't interfere with normal left-click usage while mapping
                const code = mouseCodeFromButton(e.button);
                if (!code) return;

                e.preventDefault();
                e.stopPropagation();

                const label = keyLabelFromCode(code);
                input.value = label;

                const hotkeys = loadTradeHotkeys();
                hotkeys[kind] = code;
                saveTradeHotkeys(hotkeys);
                log(`Trade hotkey set for ${kind.toUpperCase()} → ${label}`, 'success');

                document.removeEventListener('mousedown', onMouse, true);
                input.blur();
            };

            // Capture mouse buttons globally while this input is focused
            document.addEventListener('mousedown', onMouse, true);
        });
    });

    // Partial sell hotkey inputs (Sell 5/10/15/20/25/30)
    document.querySelectorAll('.partial-sell-hotkey-input').forEach(input => {
        const qty = input.dataset.qty;
        const qtyKey = `sell${qty}`;

        input.addEventListener('focus', () => {
            input.value = 'Press key';
        });

        input.addEventListener('blur', () => {
            const hotkeys = loadPartialSellHotkeys();
            const key = hotkeys[qtyKey] || DEFAULT_PARTIAL_SELL_HOTKEYS[qtyKey];
            input.value = key ? keyLabelFromCode(key) : '';
        });

        input.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const code = e.code || e.key;
            const label = keyLabelFromCode(code);
            input.value = label;

            const hotkeys = loadPartialSellHotkeys();
            hotkeys[qtyKey] = code;
            savePartialSellHotkeys(hotkeys);
            log(`Partial sell hotkey set for SELL ${qty} → ${label}`, 'success');
        });

        // Allow mouse button mapping for partial sells
        input.addEventListener('focus', () => {
            const onMouse = (e) => {
                const code = mouseCodeFromButton(e.button);
                if (!code) return;

                e.preventDefault();
                e.stopPropagation();

                const label = keyLabelFromCode(code);
                input.value = label;

                const hotkeys = loadPartialSellHotkeys();
                hotkeys[qtyKey] = code;
                savePartialSellHotkeys(hotkeys);
                log(`Partial sell hotkey set for SELL ${qty} → ${label}`, 'success');

                document.removeEventListener('mousedown', onMouse, true);
                input.blur();
            };

            document.addEventListener('mousedown', onMouse, true);
        });
    });
}

function setupTradeHotkeys() {
    const getHotkeys = () => loadTradeHotkeys();

    document.addEventListener('keydown', (e) => {
        // Ignore when typing in inputs / settings
        if (e.target && e.target.matches('input, textarea, select')) return;

        const hotkeys = getHotkeys();
        const code = e.code || e.key;
        if (!code) return;

        // BUY
        if (code === (hotkeys.buy || DEFAULT_TRADE_HOTKEYS.buy)) {
            e.preventDefault();
            e.stopPropagation();
            executeTrade('BUY');
            return;
        }

        // SELL → emergency flatten
        if (code === (hotkeys.sell || DEFAULT_TRADE_HOTKEYS.sell)) {
            e.preventDefault();
            e.stopPropagation();
            emergencySell();
            return;
        }

        // LIVE → center chart on latest candles
        if (code === (hotkeys.live || DEFAULT_TRADE_HOTKEYS.live)) {
            e.preventDefault();
            e.stopPropagation();
            const goToLiveBtn = document.getElementById('go-to-real-time');
            if (goToLiveBtn) {
                goToLiveBtn.click();
            } else if (chartManager) {
                // Fallback direct behavior if button is hidden
                try {
                    const tradePanel = document.querySelector('.trade-panel');
                    if (tradePanel) tradePanel.scrollTop = 0;
                    const chartEl = document.getElementById('chart-container');
                    if (chartEl && typeof chartEl.scrollIntoView === 'function') {
                        chartEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    }
                    chartManager.scrollToLatest();
                } catch (e) {
                    console.error('Failed to trigger Go To Live via hotkey', e);
                }
            }
            return;
        }

        // Partial sell hotkeys
        const partialSellHotkeys = loadPartialSellHotkeys();
        const quantities = [5, 10, 15, 20, 30, 40, 50];
        for (const qty of quantities) {
            const key = `sell${qty}`;
            const hotkey = partialSellHotkeys[key] || DEFAULT_PARTIAL_SELL_HOTKEYS[key];
            if (hotkey && code === hotkey) {
                e.preventDefault();
                e.stopPropagation();
                partialSell(qty);
                return;
            }
        }
        // Custom partial sell
        const customHotkey = partialSellHotkeys.sellCustom || DEFAULT_PARTIAL_SELL_HOTKEYS.sellCustom;
        if (customHotkey && code === customHotkey) {
            e.preventDefault();
            e.stopPropagation();
            try {
                const saved = localStorage.getItem('customSellAmount');
                const customQty = saved ? parseInt(saved) : 25;
                if (customQty > 0) {
                    partialSell(customQty);
                }
            } catch (e) {
                partialSell(25); // Fallback to 25
            }
            return;
        }
    });

    // Mouse-based trade hotkeys (e.g., side mouse buttons)
    document.addEventListener('mousedown', (e) => {
        // Ignore when clicking in inputs / settings
        if (e.target && e.target.matches('input, textarea, select')) return;

        const hotkeys = getHotkeys();
        const code = mouseCodeFromButton(e.button);
        if (!code) return;

        // BUY
        if (code === (hotkeys.buy || DEFAULT_TRADE_HOTKEYS.buy)) {
            e.preventDefault();
            e.stopPropagation();
            executeTrade('BUY');
            return;
        }

        // SELL → emergency flatten
        if (code === (hotkeys.sell || DEFAULT_TRADE_HOTKEYS.sell)) {
            e.preventDefault();
            e.stopPropagation();
            emergencySell();
            return;
        }

        // LIVE → center chart on latest candles
        if (code === (hotkeys.live || DEFAULT_TRADE_HOTKEYS.live)) {
            e.preventDefault();
            e.stopPropagation();
            const goToLiveBtn = document.getElementById('go-to-real-time');
            if (goToLiveBtn) {
                goToLiveBtn.click();
            } else if (chartManager) {
                try {
                    const tradePanel = document.querySelector('.trade-panel');
                    if (tradePanel) tradePanel.scrollTop = 0;
                    const chartEl = document.getElementById('chart-container');
                    if (chartEl && typeof chartEl.scrollIntoView === 'function') {
                        chartEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    }
                    chartManager.scrollToLatest();
                } catch (err) {
                    console.error('Failed to trigger Go To Live via mouse hotkey', err);
                }
            }
            return;
        }

        // Partial sell mouse hotkeys
        const partialSellHotkeys = loadPartialSellHotkeys();
        const quantities = [5, 10, 15, 20, 30, 40, 50];
        for (const qty of quantities) {
            const key = `sell${qty}`;
            const hotkey = partialSellHotkeys[key] || DEFAULT_PARTIAL_SELL_HOTKEYS[key];
            if (hotkey && code === hotkey) {
                e.preventDefault();
                e.stopPropagation();
                partialSell(qty);
                return;
            }
        }
        // Custom partial sell (mouse)
        const customHotkey = partialSellHotkeys.sellCustom || DEFAULT_PARTIAL_SELL_HOTKEYS.sellCustom;
        if (customHotkey && code === customHotkey) {
            e.preventDefault();
            e.stopPropagation();
            try {
                const saved = localStorage.getItem('customSellAmount');
                const customQty = saved ? parseInt(saved) : 25;
                if (customQty > 0) {
                    partialSell(customQty);
                }
            } catch (e) {
                partialSell(25); // Fallback to 25
            }
            return;
        }
    }, true);
}

function keyLabelFromCode(code) {
    if (!code) return '';
    // Normalize common codes for display
    if (code === 'Escape') return 'Esc';
    if (code.startsWith('Key')) return code.replace('Key', '');
    if (code.startsWith('Digit')) return code.replace('Digit', '');
    if (code === 'Mouse4') return 'Mouse4';
    if (code === 'Mouse5') return 'Mouse5';
    if (code === 'MouseMiddle') return 'M3';
    if (code === 'MouseRight') return 'RMB';
    return code;
}

function mouseCodeFromButton(button) {
    // 0 = left, 1 = middle, 2 = right, 3 = back, 4 = forward (browser convention)
    if (button === 3) return 'Mouse4';
    if (button === 4) return 'Mouse5';
    if (button === 1) return 'MouseMiddle';
    if (button === 2) return 'MouseRight';
    return null;
}
function toggleDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    
    // Close all other dropdowns first
    document.querySelectorAll('.menu-dropdown').forEach(d => {
        if (d.id !== dropdownId) {
            d.style.display = 'none';
        }
    });
    
    // Toggle current dropdown
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}

function closeAllDropdowns() {
    document.querySelectorAll('.menu-dropdown').forEach(d => {
        d.style.display = 'none';
    });
}

function updateNetworkStatus() {
    if (!ui.networkDot) return;
    
    const lastUpdateTime = appState.lastUpdateTimestamp || Date.now();
    const timeSinceUpdate = Date.now() - lastUpdateTime;
    const SLOW_THRESHOLD_MS = 7000; // consider "slow" only if >7s since last good update
    const MAX_STREAK = 10;

    if (!appState.isConnected) {
        // Hard disconnected: user not logged in or login failed
        ui.networkDot.className = 'status-dot disconnected';
        document.getElementById('network-connection-status').textContent = 'Webull API: Disconnected';
        appState.networkSlowStreak = 0;
        appState.networkOkStreak = 0;
    } else {
        const isSlowNow = timeSinceUpdate > SLOW_THRESHOLD_MS;

        if (isSlowNow) {
            appState.networkSlowStreak = Math.min((appState.networkSlowStreak || 0) + 1, MAX_STREAK);
            appState.networkOkStreak = 0;
        } else {
            appState.networkOkStreak = Math.min((appState.networkOkStreak || 0) + 1, MAX_STREAK);
            appState.networkSlowStreak = 0;
        }

        // Only flip to "Slow" after 2 consecutive slow checks (~10s),
        // and only flip back to "Connected" after at least 1 ok check.
        const showSlow = appState.networkSlowStreak >= 2;

        if (showSlow) {
            ui.networkDot.className = 'status-dot connecting';
            document.getElementById('network-connection-status').textContent = 'Webull API: Slow Response';
        } else {
            ui.networkDot.className = 'status-dot';
            document.getElementById('network-connection-status').textContent = 'Webull API: Connected';
        }
    }
    
    // Update last update time
    const seconds = Math.floor(timeSinceUpdate / 1000);
    document.getElementById('network-last-update').textContent = 
        `Last update: ${seconds < 2 ? 'Just now' : seconds + 's ago'}`;
    
    // Update latency (mock for now)
    document.getElementById('network-latency').textContent = 'Latency: ~100ms';
}

// Handle timeframe changes from chart toolbar
document.addEventListener('timeframe-change', async (e) => {
    const {timeframe} = e.detail;
    if (!appState.tickerId) return;
    
    log(`Switching to ${timeframe} candles...`, 'info');
    
    // Map timeframe to Webull API format
    const tfMap = {
        '1m': 'm1',
        '5m': 'm5',
        '15m': 'm15',
        '30m': 'm30',
        '1h': 'm60',
        '1d': 'd1'
    };
    
    const webullTf = tfMap[timeframe] || 'm5';
    const count = timeframe === '1d' ? 50 : 100;
    
    // Fetch new data
    await loadHistoricalDataWithTimeframe(appState.tickerId, webullTf, count, timeframe);
});

// Handle indicator additions from chart toolbar
document.addEventListener('indicator-add', (e) => {
    const {type} = e.detail;
    addOrToggleIndicator(type);
    updateIndicatorDropdown();
});

function updateIndicatorDropdown() {
    const selector = document.getElementById('indicator-selector');
    if (!selector) return;

    // Map of indicator keys to their display names
    const indicatorNames = {
        'sma': 'SMA',
        'ema': 'EMA',
        'rsi': 'RSI',
        'macd': 'MACD',
        'bollinger': 'Bollinger',
        'vwap': 'VWAP',
        'indices': 'Indices'
    };

    // Map of indicator keys to their option values
    const indicatorMap = {
        'sma': 'sma',
        'ema': 'ema',
        'rsi': 'rsi',
        'macd': 'macd',
        'bollinger': 'bollinger',
        'vwap': 'vwap',
        'indices': 'indices'
    };

    // Check which indicators are active
    const activeIndicators = new Set();
    Object.keys(appState.indicatorSeries).forEach(key => {
        if (appState.indicatorSeries[key]) {
            // Handle special cases
            if (key === 'indices_spy' || key === 'indices_qqq') {
                activeIndicators.add('indices');
            } else {
                activeIndicators.add(key);
            }
        }
    });

    // Update the default option text to show active indicators
    const defaultOption = selector.options[0];
    if (activeIndicators.size > 0) {
        const activeNames = Array.from(activeIndicators)
            .map(key => indicatorNames[key] || key.toUpperCase())
            .join(', ');
        defaultOption.text = activeNames;
    } else {
        defaultOption.text = 'Add Indicator...';
    }

    // Update each option with checkmarks
    Array.from(selector.options).forEach(option => {
        if (!option.value) return; // Skip "Add Indicator..." option
        
        // Store original text without checkmark
        const originalText = option.text.replace(/^✓\s*/, '');
        
        const indicatorKey = indicatorMap[option.value];
        if (indicatorKey && activeIndicators.has(indicatorKey)) {
            // Add checkmark if not already present
            if (!option.text.includes('✓')) {
                option.text = '✓ ' + originalText;
            }
        } else {
            // Remove checkmark if present
            option.text = originalText;
        }
    });
}

async function addOrToggleIndicator(type) {
    if (!chartManager || !appState.candleHistory || appState.candleHistory.length === 0) {
        log('No candle data available for indicators yet', 'warn');
        return;
    }

    const key = type.toLowerCase();
    const existing = appState.indicatorSeries[key];

    // Special handling for indices (SPY/QQQ overlay)
    if (key === 'indices') {
        // Toggle off: remove both SPY & QQQ if present
        if (appState.indicatorSeries.indices_spy || appState.indicatorSeries.indices_qqq) {
            ['indices_spy', 'indices_qqq'].forEach(k => {
                const ex = appState.indicatorSeries[k];
                if (ex && ex.series) {
                    try { ex.series.setData([]); } catch (e) {}
                    try { chartManager.chart.removeSeries(ex.series); } catch (e) {}
                }
                delete appState.indicatorSeries[k];
            });
            log('Removed SPY/QQQ indices overlay', 'info');
            return;
        }

        try {
            await addIndexOverlay('SPY', 'indices_spy', '#00bcd4');
            await addIndexOverlay('QQQ', 'indices_qqq', '#ff9800');
            log('Added SPY/QQQ indices overlay', 'success');
        } catch (e) {
            log(`Failed to add indices overlay: ${e.message}`, 'error');
        }
        return;
    }

    // Toggle / add Bollinger Bands (3 lines)
    if (key === 'bollinger') {
        const existingBoll = appState.indicatorSeries.bollinger;
        if (existingBoll && existingBoll.seriesList) {
            existingBoll.seriesList.forEach(s => {
                try { chartManager.chart.removeSeries(s); } catch (e) {}
            });
            delete appState.indicatorSeries.bollinger;
            log('Removed BOLLINGER indicator', 'info');
            updateIndicatorDropdown();
            return;
        }

        const bb = computeBollinger(appState.candleHistory, 20, 2);
        if (!bb || !bb.middle.length) {
            log('No data for BOLLINGER indicator', 'warn');
            return;
        }

        const midSeries = chartManager.chart.addLineSeries({
            color: '#9d4edd',
            lineWidth: 1,
            title: 'BB Mid',
            priceScaleId: 'right'
        });
        const upperSeries = chartManager.chart.addLineSeries({
            color: '#06ffa5',
            lineWidth: 1,
            title: 'BB Upper',
            priceScaleId: 'right'
        });
        const lowerSeries = chartManager.chart.addLineSeries({
            color: '#f72585',
            lineWidth: 1,
            title: 'BB Lower',
            priceScaleId: 'right'
        });

        midSeries.setData(bb.middle);
        upperSeries.setData(bb.upper);
        lowerSeries.setData(bb.lower);

        appState.indicatorSeries.bollinger = {
            seriesList: [midSeries, upperSeries, lowerSeries]
        };
        log('Added BOLLINGER indicator', 'success');
        updateIndicatorDropdown();
        return;
    }

    // Toggle / add RSI
    if (key === 'rsi') {
        const existingRsi = appState.indicatorSeries.rsi;
        if (existingRsi && existingRsi.series) {
            try { chartManager.chart.removeSeries(existingRsi.series); } catch (e) {}
            delete appState.indicatorSeries.rsi;
            log('Removed RSI indicator', 'info');
            updateIndicatorDropdown();
            return;
        }

        const rawRsi = computeRSI(appState.candleHistory, 14);
        if (!rawRsi.length) {
            log('No data for RSI indicator', 'warn');
            return;
        }

        const rsiData = normalizeIndicatorToPriceScale(rawRsi, appState.candleHistory, 0.12);

        const rsiSeries = chartManager.chart.addLineSeries({
            color: '#ff6b6b',
            lineWidth: 2,
            title: 'RSI 14',
            priceScaleId: 'right'
        });
        rsiSeries.setData(rsiData);
        appState.indicatorSeries.rsi = { series: rsiSeries };
        log('Added RSI indicator', 'success');
        updateIndicatorDropdown();
        return;
    }

    // Toggle / add MACD (MACD + Signal lines)
    if (key === 'macd') {
        const existingMacd = appState.indicatorSeries.macd;
        if (existingMacd && existingMacd.seriesList) {
            existingMacd.seriesList.forEach(s => {
                try { chartManager.chart.removeSeries(s); } catch (e) {}
            });
            delete appState.indicatorSeries.macd;
            log('Removed MACD indicator', 'info');
            updateIndicatorDropdown();
            return;
        }

        const macd = computeMACD(appState.candleHistory, 12, 26, 9);
        if (!macd || !macd.macdLine.length) {
            log('No data for MACD indicator', 'warn');
            return;
        }

        const macdLine = normalizeIndicatorToPriceScale(macd.macdLine, appState.candleHistory, 0.18);
        const signalLine = normalizeIndicatorToPriceScale(macd.signalLine, appState.candleHistory, 0.18);

        const macdSeries = chartManager.chart.addLineSeries({
            color: '#4cc9f0',
            lineWidth: 2,
            title: 'MACD',
            priceScaleId: 'right'
        });
        const signalSeries = chartManager.chart.addLineSeries({
            color: '#ff6b35',
            lineWidth: 1,
            title: 'Signal',
            priceScaleId: 'right'
        });

        macdSeries.setData(macdLine);
        signalSeries.setData(signalLine);

        appState.indicatorSeries.macd = {
            seriesList: [macdSeries, signalSeries]
        };
        log('Added MACD indicator', 'success');
        updateIndicatorDropdown();
        return;
    }

    // Toggle off if already added (for simple 1-line indicators)
    if (existing && existing.series) {
        try {
            existing.series.setData([]); // clear
            chartManager.chart.removeSeries(existing.series);
        } catch (e) {}
        delete appState.indicatorSeries[key];
        log(`Removed ${type.toUpperCase()} indicator`, 'info');
        updateIndicatorDropdown();
        return;
    }

    const candles = appState.candleHistory;
    let lineData = [];
    let seriesOptions = {};

    if (key === 'sma') {
        lineData = computeSMA(candles, 20);
        seriesOptions = { color: '#4cc9f0', lineWidth: 2, title: 'SMA 20', priceScaleId: 'right' };
    } else if (key === 'ema') {
        lineData = computeEMA(candles, 20);
        seriesOptions = { color: '#9d4edd', lineWidth: 2, title: 'EMA 20', priceScaleId: 'right' };
    } else if (key === 'vwap') {
        lineData = computeVWAP(candles);
        seriesOptions = { color: '#ffaa00', lineWidth: 2, title: 'VWAP', priceScaleId: 'right' };
    } else {
        log(`${type.toUpperCase()} indicator not implemented yet`, 'warn');
        return;
    }

    if (!lineData.length) {
        log(`No data for ${type.toUpperCase()} indicator`, 'warn');
        return;
    }

    const series = chartManager.chart.addLineSeries(seriesOptions);
    series.setData(lineData);
    appState.indicatorSeries[key] = { series, options: seriesOptions };
    log(`Added ${type.toUpperCase()} indicator`, 'success');
    updateIndicatorDropdown();
}

async function addIndexOverlay(symbol, key, color) {
    if (!appState.candleHistory || appState.candleHistory.length === 0) {
        throw new Error('No base candles for index overlay');
    }
    const mainCandles = appState.candleHistory;
    const count = mainCandles.length || 800;

    // Use Webull for index overlay data
    const tickerId = await api.getTickerID(symbol);
    const bars = await api.getHistoricalBars(tickerId, 'm1', count);
    if (!bars || !bars.data || !Array.isArray(bars.data) || bars.data.length === 0) {
        throw new Error(`No historical data for ${symbol}`);
    }

    // Polygon data is already time-sorted ascending
    const sorted = bars.data;

    // Normalize SPY/QQQ to roughly overlap the current ticker:
    // scale index % change onto the main symbol's starting price.
    const mainBase = mainCandles[0]?.close || 1;
    const indexBase = sorted[0]?.close || 1;
    const scale = indexBase !== 0 ? (mainBase / indexBase) : 1;

    const lineData = sorted.map(b => ({
        time: b.time,
        value: b.close * scale
    }));

    const series = chartManager.chart.addLineSeries({
        color,
        lineWidth: 2,
        title: symbol,
        priceScaleId: 'right'
    });
    series.setData(lineData);
    appState.indicatorSeries[key] = { series, symbol };
}

function computeSMA(candles, length) {
    const out = [];
    const closes = candles.map(c => c.close);
    for (let i = length - 1; i < candles.length; i++) {
        let sum = 0;
        for (let j = i - length + 1; j <= i; j++) {
            sum += closes[j];
        }
        out.push({ time: candles[i].time, value: sum / length });
    }
    return out;
}

function computeEMA(candles, length) {
    const out = [];
    const closes = candles.map(c => c.close);
    const k = 2 / (length + 1);
    let emaPrev = null;
    for (let i = 0; i < candles.length; i++) {
        const close = closes[i];
        if (emaPrev == null) {
            emaPrev = close;
        } else {
            emaPrev = close * k + emaPrev * (1 - k);
        }
        if (i >= length - 1) {
            out.push({ time: candles[i].time, value: emaPrev });
        }
    }
    return out;
}

function computeVWAP(candles) {
    const out = [];
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    for (const c of candles) {
        const typicalPrice = (c.high + c.low + c.close) / 3;
        const volume = c.volume || 1;
        cumulativePV += typicalPrice * volume;
        cumulativeVolume += volume;
        if (cumulativeVolume > 0) {
            out.push({ time: c.time, value: cumulativePV / cumulativeVolume });
        }
    }
    return out;
}

function computeBollinger(candles, length, mult) {
    const closes = candles.map(c => c.close);
    const middle = [];
    const upper = [];
    const lower = [];

    for (let i = length - 1; i < closes.length; i++) {
        let sum = 0;
        for (let j = i - length + 1; j <= i; j++) {
            sum += closes[j];
        }
        const mean = sum / length;

        let varianceSum = 0;
        for (let j = i - length + 1; j <= i; j++) {
            const diff = closes[j] - mean;
            varianceSum += diff * diff;
        }
        const stdDev = Math.sqrt(varianceSum / length);

        const time = candles[i].time;
        middle.push({ time, value: mean });
        upper.push({ time, value: mean + mult * stdDev });
        lower.push({ time, value: mean - mult * stdDev });
    }

    return { middle, upper, lower };
}

function computeRSI(candles, period) {
    const closes = candles.map(c => c.close);
    if (closes.length <= period) return [];

    const rsi = [];
    let gainSum = 0;
    let lossSum = 0;

    // Seed initial averages
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) gainSum += change;
        else lossSum -= change;
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;

    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        let gain = 0;
        let loss = 0;
        if (change >= 0) gain = change;
        else loss = -change;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        let value = 50;
        if (avgLoss === 0 && avgGain === 0) {
            value = 50;
        } else if (avgLoss === 0) {
            value = 100;
        } else {
            const rs = avgGain / avgLoss;
            value = 100 - 100 / (1 + rs);
        }

        rsi.push({
            time: candles[i].time,
            value
        });
    }

    return rsi;
}

function emaFull(values, length) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (length + 1);
    let emaPrev = null;

    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v == null || isNaN(v)) {
            out[i] = emaPrev;
            continue;
        }
        if (emaPrev == null) {
            emaPrev = v;
        } else {
            emaPrev = v * k + emaPrev * (1 - k);
        }
        out[i] = emaPrev;
    }

    return out;
}

function computeMACD(candles, fast = 12, slow = 26, signalLength = 9) {
    const closes = candles.map(c => c.close);
    if (closes.length <= slow) return { macdLine: [], signalLine: [] };

    const emaFast = emaFull(closes, fast);
    const emaSlow = emaFull(closes, slow);

    const macdValues = [];
    for (let i = 0; i < closes.length; i++) {
        if (emaFast[i] == null || emaSlow[i] == null) {
            macdValues[i] = null;
        } else {
            macdValues[i] = emaFast[i] - emaSlow[i];
        }
    }

    const signalValues = emaFull(macdValues, signalLength);

    const macdLine = [];
    const signalLine = [];
    for (let i = 0; i < closes.length; i++) {
        if (macdValues[i] == null || signalValues[i] == null) continue;
        const time = candles[i].time;
        macdLine.push({ time, value: macdValues[i] });
        signalLine.push({ time, value: signalValues[i] });
    }

    return { macdLine, signalLine };
}

// Map an oscillator-style series (e.g. RSI/MACD) into a visible band
// within the main price range so it overlays the candles instead of
// being squashed at the very bottom.
function normalizeIndicatorToPriceScale(lineData, candles, bandFraction = 0.15) {
    if (!lineData || !lineData.length || !candles || !candles.length) return [];

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const c of candles) {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    }
    if (!isFinite(minPrice) || !isFinite(maxPrice)) return lineData;

    const priceRange = maxPrice - minPrice || 1;
    const bandHeight = priceRange * bandFraction;
    const midPrice = (maxPrice + minPrice) / 2;

    let minVal = Infinity;
    let maxVal = -Infinity;
    for (const p of lineData) {
        if (p.value < minVal) minVal = p.value;
        if (p.value > maxVal) maxVal = p.value;
    }
    if (!isFinite(minVal) || !isFinite(maxVal) || maxVal === minVal) {
        return lineData.map(p => ({ time: p.time, value: midPrice }));
    }

    const centerVal = (minVal + maxVal) / 2;
    const halfBand = bandHeight / 2;
    const halfValRange = (maxVal - minVal) / 2 || 1;

    return lineData.map(p => {
        const normalized = ((p.value - centerVal) / halfValRange) * halfBand;
        return {
            time: p.time,
            value: midPrice + normalized
        };
    });
}

// Load historical data with specific timeframe
async function loadHistoricalDataWithTimeframe(tickerId, webullTf, count, displayTf) {
    try {
        // Use Webull for all historical data
        const bars = await api.getHistoricalBars(appState.tickerId, webullTf, count);
        
        if (bars) {
            const candles = [];
            
            if (bars.data && Array.isArray(bars.data)) {
                for (const bar of bars.data) {
                    if (!bar) continue;
                    const timestamp = bar.timestamp || bar.time || bar.tradeTime;
                    const open = parseFloat(bar.open);
                    const high = parseFloat(bar.high);
                    const low = parseFloat(bar.low);
                    const close = parseFloat(bar.close);
                    
                    if (timestamp && !isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
                        candles.push({
                            time: Math.floor(new Date(timestamp).getTime() / 1000),
                            open: open,
                            high: high,
                            low: low,
                            close: close
                        });
                    }
                }
            }
            
            if (bars.dates && bars.data && bars.dates.length === bars.data.length) {
                for (let i = 0; i < bars.dates.length; i++) {
                    const timestamp = bars.dates[i];
                    const bar = bars.data[i];
                    if (!bar) continue;
                    
                    const open = parseFloat(bar.open);
                    const high = parseFloat(bar.high);
                    const low = parseFloat(bar.low);
                    const close = parseFloat(bar.close);
                    
                    if (!isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
                        candles.push({
                            time: Math.floor(new Date(timestamp).getTime() / 1000),
                            open: open,
                            high: high,
                            low: low,
                            close: close
                        });
                    }
                }
            }
            
            if (candles.length > 0) {
                candles.sort((a, b) => a.time - b.time);
                chartManager.updateData(candles);
                log(`✓ Loaded ${candles.length} ${displayTf} candles`, 'success');
                
                // Update PDH/PDL
                const high = Math.max(...candles.map(c => c.high));
                const low = Math.min(...candles.map(c => c.low));
                chartManager.drawLevels(high, low);
            } else {
                log(`No ${displayTf} data available`, 'error');
            }
        }
    } catch (e) {
        log(`Failed to load ${displayTf} data: ${e.message}`, 'error');
    }
}

// ==================================================
// IPC LISTENERS FOR BACKGROUND OPTION CACHE UPDATES
// ==================================================

// Listen for option cache status updates from main process
ipcRenderer.on('option-cache-status', (event, data) => {
    console.log(`📊 Option cache status: ${data.status} - ${data.message}`);
    
    if (data.status === 'complete') {
        // Reload cache when background fetch completes
        api.reloadOptionCache();
        console.log('✅ Option cache updated and reloaded successfully');
    }
});

// Listen for option cache errors
ipcRenderer.on('option-cache-error', (event, error) => {
    console.error('❌ Option cache update failed:', error);
});

// ==================================================
// START APP
// ==================================================

// ==================================================
// 🚨 AUTO-LOGOUT ON TOKEN EXPIRATION
// ==================================================
window.addEventListener('webull-auth-expired', (e) => {
    console.error('🔴 ✅ EVENT RECEIVED: webull-auth-expired', e.detail);
    console.error('🔴 Event listener is working!');
    
    // Determine message based on error
    const errorMsg = e.detail?.error || '';
    let message = 'Your Webull session has expired or your token is invalid.\n\nYou will be logged out. Please log in again.';
    
    if (errorMsg.includes('account has been reset')) {
        console.error('🔴 Detected "account has been reset" error');
        message = 'Your Webull paper trading account has been reset.\n\n' +
                  'This happens when Webull resets all paper accounts (usually monthly).\n\n' +
                  'You will be logged out. Please log in again with fresh credentials.';
    }
    
    console.error('🔴 Showing logout alert to user...');
    
    // Show alert to user
    showCustomAlert(
        message,
        '⚠️ Session Expired',
        '🔴',
        async () => {
            // Logout callback
            console.error('🔴 User clicked OK - executing logout...');
            await handleLogout();
            console.error('🔴 Logout complete');
        }
    );
});

// ==================================================
// 🔔 MARKET OPEN AUTO-REFRESH (9:30 AM EST)
// ==================================================
let marketOpenCheckInterval = null;

function startMarketOpenMonitor() {
    // Check every 60 seconds if market just opened
    marketOpenCheckInterval = setInterval(() => {
        const now = new Date();
        const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const hours = estTime.getHours();
        const minutes = estTime.getMinutes();
        const dayOfWeek = estTime.getDay(); // 0 = Sunday, 6 = Saturday
        
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const timeInMinutes = hours * 60 + minutes;
        const marketOpen = 9 * 60 + 30; // 9:30 AM EST
        
        // Check if it's 9:30 AM EST (within 1-minute window) and not weekend
        const isMarketOpening = !isWeekend && timeInMinutes >= marketOpen && timeInMinutes < marketOpen + 1;
        
        // Also check if we just transitioned from closed to open
        const wasClosedLastCheck = !appState.marketActuallyOpen;
        const isOpenNow = !isWeekend && timeInMinutes >= marketOpen && timeInMinutes < (16 * 60);
        
        if (isMarketOpening && wasClosedLastCheck && appState.selectedTicker) {
            console.log('🔔 MARKET OPENED AT 9:30 AM EST - Refreshing data...');
            
            // Reload historical data for current ticker
            if (appState.tickerId) {
                loadHistoricalData(appState.tickerId);
            }
            
            // Show notification
            showCustomAlert(
                '🔔 Market Opened',
                'The market has opened at 9:30 AM EST.\n\nData has been automatically refreshed!'
            );
        }
    }, 60000); // Check every 60 seconds
}

// Start monitoring on app load
if (marketOpenCheckInterval) {
    clearInterval(marketOpenCheckInterval);
}
startMarketOpenMonitor();

// ==================================================
// Start when DOM is fully ready
// ==================================================
window.addEventListener('DOMContentLoaded', () => {
    init();
});

