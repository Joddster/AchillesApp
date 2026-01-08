// Browser environment - lightweight-charts loaded via CDN
const { createChart } = window.LightweightCharts || {};

class ChartManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.chart = createChart(this.container, {
            width: this.container.clientWidth,
            height: this.container.clientHeight,
            layout: {
                background: { color: '#0a0e27' },
                textColor: '#e0e7ff',
            },
            grid: {
                vertLines: { color: 'rgba(77, 201, 240, 0.1)' },
                horzLines: { color: 'rgba(77, 201, 240, 0.1)' },
            },
            crosshair: {
                // Free-moving crosshair (no magnet to candles)
                mode: 0,
                vertLine: {
                    color: '#4cc9f0',
                    width: 1,
                    style: 3,
                    labelBackgroundColor: '#9d4edd',
                },
                horzLine: {
                    color: '#4cc9f0',
                    width: 1,
                    style: 3,
                    labelBackgroundColor: '#9d4edd',
                },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: 'rgba(77, 201, 240, 0.2)',
            },
            rightPriceScale: {
                borderColor: 'rgba(77, 201, 240, 0.2)',
                autoScale: true,
                mode: 0, // Normal price scale mode
                // Larger margins = more compact candles, easier SL placement
                scaleMargins: {
                    top: 0.3,    // 30% margin at top (more space, easier to place lines accurately)
                    bottom: 0.3  // 30% margin at bottom (prevents candles from looking "too long")
                },
            },
            localization: {
                // Force all time labels to display in US/Eastern (New York) time,
                // regardless of the user's local machine timezone.
                timeFormatter: (time) => {
                    // `time` can be a UTCTimestamp number or an object; normalize to seconds.
                    let ts = null;
                    if (typeof time === 'number') {
                        ts = time;
                    } else if (time && typeof time === 'object') {
                        // Lightweight-charts often passes { timestamp: number }
                        ts = time.timestamp || time.time || null;
                    }
                    if (ts == null) return '';

                    const utc = new Date(ts * 1000);
                    const est = new Date(utc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
                    const hours = est.getHours().toString().padStart(2, '0');
                    const minutes = est.getMinutes().toString().padStart(2, '0');
                    return `${hours}:${minutes}`;
                },
            },
        });

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#06ffa5',
            downColor: '#f72585',
            borderVisible: false,
            wickUpColor: '#06ffa5',
            wickDownColor: '#f72585',
        });

        // PDH/PDL overlays (stored as PriceLines so we can toggle visibility)
        this.pdhPriceLine = null;
        this.pdlPriceLine = null;
        this.pdhPrice = null;
        this.pdlPrice = null;
        this.pdhVisible = true;
        this.pdlVisible = true;

        // Pre-market levels (optional overlays)
        this.premarketHighLineObj = null;
        this.premarketLowLineObj = null;

        this.stopLossLine = null; // Will be a PriceLine
        this.stopPrice = null;
        this.takeProfitLine = null;
        this.takeProfitPrice = null;
        this.secondaryStopLossLine = null; // Secondary stop loss for Trojan mode
        this.secondaryStopPrice = null;

        // Entry/Exit lines - stored as price line objects
        this.entryLines = []; // Array of entry price line objects
        this.exitLines = [];  // Array of exit price line objects

        // Resize handler
        window.addEventListener('resize', () => {
            this.chart.resize(this.container.clientWidth, this.container.clientHeight);
        });

        // Note: stop-loss is controlled via UI / double-click events from ChartTools.
    }

    applyTheme(theme) {
        const isLight = theme === 'light';
        const isRedDark = theme === 'dark-red';
        const isClassic = theme === 'classic';
        this.chart.applyOptions({
            layout: {
                background: {
                    color: isLight
                        ? '#f3f4f6'
                        : (isRedDark
                            ? '#06040b'
                            : (isClassic ? '#0a0e27' : '#05070b'))
                },
                textColor: isLight ? '#111827' : '#e5e7eb',
            },
            grid: {
                vertLines: {
                    color: isLight
                        ? 'rgba(148, 163, 184, 0.3)'
                        : (isRedDark
                            ? 'rgba(248, 113, 113, 0.15)'
                            : (isClassic ? 'rgba(77, 201, 240, 0.1)' : 'rgba(148, 163, 184, 0.18)'))
                },
                horzLines: {
                    color: isLight
                        ? 'rgba(148, 163, 184, 0.3)'
                        : (isRedDark
                            ? 'rgba(248, 113, 113, 0.15)'
                            : (isClassic ? 'rgba(77, 201, 240, 0.1)' : 'rgba(148, 163, 184, 0.18)'))
                },
            },
            timeScale: {
                borderColor: isLight
                    ? 'rgba(148,163,184,0.6)'
                    : (isRedDark
                        ? 'rgba(248,113,113,0.55)'
                        : (isClassic ? 'rgba(77, 201, 240, 0.2)' : 'rgba(148,163,184,0.35)')),
            },
            rightPriceScale: {
                borderColor: isLight
                    ? 'rgba(148,163,184,0.6)'
                    : (isRedDark
                        ? 'rgba(248,113,113,0.55)'
                        : (isClassic ? 'rgba(77, 201, 240, 0.2)' : 'rgba(148,163,184,0.35)')),
                // Keep stable scaling - larger margins = more compact candles, easier line placement
                autoScale: true,
                mode: 0,
                scaleMargins: {
                    top: 0.3,    // 30% margin = compact candles + easy SL placement
                    bottom: 0.3
                },
            },
            crosshair: {
                mode: 0,
                vertLine: {
                    color: isLight
                        ? '#2563eb'
                        : (isRedDark
                            ? '#f97373'
                            : (isClassic ? '#4cc9f0' : '#38bdf8')),
                    width: 1,
                    style: 3,
                    labelBackgroundColor: isLight
                        ? '#7c3aed'
                        : (isRedDark
                            ? '#b91c1c'
                            : (isClassic ? '#9d4edd' : '#0f172a')),
                },
                horzLine: {
                    color: isLight
                        ? '#2563eb'
                        : (isRedDark
                            ? '#f97373'
                            : (isClassic ? '#4cc9f0' : '#38bdf8')),
                    width: 1,
                    style: 3,
                    labelBackgroundColor: isLight
                        ? '#7c3aed'
                        : (isRedDark
                            ? '#b91c1c'
                            : (isClassic ? '#9d4edd' : '#0f172a')),
                },
            },
        });

        // Check for custom candle colors first
        let upColor, downColor, wickUpColor, wickDownColor;
        try {
            const savedColors = localStorage.getItem('candleColors');
            if (savedColors) {
                const colors = JSON.parse(savedColors);
                if (colors.up && colors.down) {
                    upColor = colors.up;
                    downColor = colors.down;
                    wickUpColor = colors.wickUp || colors.up;
                    wickDownColor = colors.wickDown || colors.down;
                }
            }
        } catch (e) {
            // Fall through to theme defaults
        }

        // Use custom colors if available, otherwise use theme defaults
        if (!upColor || !downColor) {
            upColor = isLight
                ? '#059669'
                : (isClassic ? '#06ffa5' : '#22c55e');
            downColor = isLight
                ? '#dc2626'
                : (isRedDark ? '#ef4444' : (isClassic ? '#f72585' : '#e11d48'));
            wickUpColor = upColor;
            wickDownColor = downColor;
        }

        this.candleSeries.applyOptions({
            upColor: upColor,
            downColor: downColor,
            borderVisible: false,
            wickUpColor: wickUpColor,
            wickDownColor: wickDownColor,
        });
    }

    updateData(candles) {
        // candles format: { time: '2018-12-22', open: 75.16, high: 82.84, low: 36.16, close: 45.72 }
        this.candleSeries.setData(candles);
    }

    updateRealtime(candle) {
        if (!candle || typeof candle.time !== 'number') {
            return;
        }
        
        // 🔍 DEBUG: Track update frequency to detect rapid updates causing jumps
        if (!this._lastUpdateTime) this._lastUpdateTime = 0;
        if (!this._lastUpdateCandle) this._lastUpdateCandle = null;
        
        const now = Date.now();
        const timeSinceLastUpdate = now - this._lastUpdateTime;
        
        // Log if updates are happening too rapidly (< 100ms apart = could cause visual flicker)
        // Rapid updates are normal when AM bars and A bars arrive close together
        // This is expected behavior in the hybrid approach, no need to log
        
        this._lastUpdateTime = now;
        this._lastUpdateCandle = { ...candle };
        
        this.candleSeries.update(candle);
    }

    scrollToLatest() {
        try {
            // Get all the candle data to find the latest candle
            const allData = this.candleSeries.data();
            
            if (allData && allData.length > 0) {
                // Get the index of the last candle
                const lastIndex = allData.length - 1;
                
                // Show approximately the last 50-80 candles (adjustable)
                const visibleBars = 60;
                const fromIndex = Math.max(0, lastIndex - visibleBars + 1);
                
                // Set visible logical range to zoom into the latest candles
                this.chart.timeScale().setVisibleLogicalRange({
                    from: fromIndex,
                    to: lastIndex + 5 // Add a bit of padding on the right
                });
                
                // Scroll to the absolute latest position
                this.chart.timeScale().scrollToRealTime();
            } else {
                // Fallback if no data
                this.chart.timeScale().scrollToRealTime();
                this.chart.timeScale().fitContent();
            }
            
            // Force vertical centering on current price
            this.chart.priceScale('right').applyOptions({
                autoScale: true,
            });
        } catch (e) {
            console.error('Failed to scroll chart to real time', e);
        }
    }

    setPDH(price) {
        // Create a flat line data for the visible range or just one point if extended
        // Lightweight charts requires data series. 
        // We might just use a PriceLine instead of a Series for a constant level.
        
        // Remove series if we change approach to PriceLine, but Series allows historical view.
        // Let's use PriceLine for single day levels on the candle series.
    }

    // Internal helper to apply PDH/PDL visibility based on stored state.
    _updatePDLines() {
        // Clear existing
        if (this.pdhPriceLine) {
            this.candleSeries.removePriceLine(this.pdhPriceLine);
            this.pdhPriceLine = null;
        }
        if (this.pdlPriceLine) {
            this.candleSeries.removePriceLine(this.pdlPriceLine);
            this.pdlPriceLine = null;
        }

        // Recreate if visible and we have prices
        if (this.pdhVisible && this.pdhPrice != null) {
            this.pdhPriceLine = this.candleSeries.createPriceLine({
                price: this.pdhPrice,
                color: '#06ffa5',
                lineWidth: 2,
                lineStyle: 2,
                axisLabelVisible: true,
                title: 'PDH',
            });
        }
        if (this.pdlVisible && this.pdlPrice != null) {
            this.pdlPriceLine = this.candleSeries.createPriceLine({
                price: this.pdlPrice,
                color: '#f72585',
                lineWidth: 2,
                lineStyle: 2,
                axisLabelVisible: true,
                title: 'PDL',
            });
        }
    }

    drawLevels(pdh, pdl) {
        this.pdhPrice = pdh;
        this.pdlPrice = pdl;
        this._updatePDLines();
    }

    setPDHVisible(visible) {
        this.pdhVisible = !!visible;
        this._updatePDLines();
    }

    setPDLVisible(visible) {
        this.pdlVisible = !!visible;
        this._updatePDLines();
    }

    setPremarketHigh(price) {
        if (this.premarketHighLineObj) {
            this.candleSeries.removePriceLine(this.premarketHighLineObj);
            this.premarketHighLineObj = null;
        }

        if (price == null) return;

        this.premarketHighLineObj = this.candleSeries.createPriceLine({
            price: price,
            color: '#4cc9f0',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'ORH',
        });
    }

    setPremarketLow(price) {
        if (this.premarketLowLineObj) {
            this.candleSeries.removePriceLine(this.premarketLowLineObj);
            this.premarketLowLineObj = null;
        }

        if (price == null) return;

        this.premarketLowLineObj = this.candleSeries.createPriceLine({
            price: price,
            color: '#ffab00',
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'ORL',
        });
    }

    setStopLoss(price) {
        if (this.stopLineObj) {
            this.candleSeries.removePriceLine(this.stopLineObj);
            this.stopLineObj = null;
        }
        
        this.stopPrice = price;
        if (price == null) return;

        // Get custom settings or use defaults
        let slColor = '#e11d48';
        let slWidth = 2;
        let slLabel = 'STOP';
        try {
            const saved = localStorage.getItem('slTpSettings');
            if (saved) {
                const settings = JSON.parse(saved);
                if (settings.slColor) slColor = settings.slColor;
                if (settings.primarySlBarSize) slWidth = parseInt(settings.primarySlBarSize) || 2;
                if (settings.primarySlLabel) slLabel = settings.primarySlLabel;
            }
        } catch (e) {
            // Use defaults
        }

        // Visual only: semantics (armed vs visual-only) are controlled by appState in app.js.
        // Here we just render a premium, high-contrast marker.
        this.stopLineObj = this.candleSeries.createPriceLine({
            price: price,
            color: slColor,
            lineWidth: slWidth,
            lineStyle: 0,
            axisLabelVisible: true,
            title: slLabel,
        });
        
        // Dispatch event to update UI input
        const event = new CustomEvent('chart-stop-update', { detail: { price } });
        document.dispatchEvent(event);
    }

    setTakeProfit(price) {
        if (this.takeProfitLineObj) this.candleSeries.removePriceLine(this.takeProfitLineObj);
        
        this.takeProfitPrice = price;
        this.tpPrice = price; // ✅ Track for drag detection
        if (price == null) return;

        // Get custom settings or use defaults
        let tpColor = '#22c55e';
        let tpWidth = 2;
        try {
            const saved = localStorage.getItem('slTpSettings');
            if (saved) {
                const settings = JSON.parse(saved);
                if (settings.tpColor) tpColor = settings.tpColor;
                if (settings.tpBarSize) tpWidth = parseInt(settings.tpBarSize) || 2;
            }
        } catch (e) {
            // Use defaults
        }

        this.takeProfitLineObj = this.candleSeries.createPriceLine({
            price: price,
            color: tpColor,
            lineWidth: tpWidth,
            lineStyle: 0,
            axisLabelVisible: true,
            title: 'TARGET',
        });
        
        // Dispatch event to sync with app state
        const event = new CustomEvent('chart-tp-update', { detail: { price } });
        document.dispatchEvent(event);
    }

    clearTakeProfit() {
        if (this.takeProfitLineObj) {
            this.candleSeries.removePriceLine(this.takeProfitLineObj);
            this.takeProfitLineObj = null;
            this.takeProfitPrice = null;
        }
    }
    
    clearStopLoss() {
        if (this.stopLineObj) {
            this.candleSeries.removePriceLine(this.stopLineObj);
            this.stopLineObj = null;
            this.stopPrice = null;
        }
    }

    setSecondaryStopLoss(price) {
        if (this.secondaryStopLossLineObj) {
            this.candleSeries.removePriceLine(this.secondaryStopLossLineObj);
            this.secondaryStopLossLineObj = null;
        }
        
        this.secondaryStopPrice = price;
        if (price == null) return;

        // Get custom settings or use defaults
        let secondarySlColor = '#f97316'; // Orange default for secondary SL
        let slWidth = 3; // Default to 3 for secondary SL (thicker than primary)
        let slLabel = 'STOP2';
        try {
            const saved = localStorage.getItem('slTpSettings');
            if (saved) {
                const settings = JSON.parse(saved);
                if (settings.secondarySlColor) secondarySlColor = settings.secondarySlColor;
                if (settings.secondarySlBarSize) slWidth = parseInt(settings.secondarySlBarSize) || 3;
                if (settings.secondarySlLabel) slLabel = settings.secondarySlLabel;
            }
        } catch (e) {
            // Use defaults
        }

        // Secondary stop loss line (functional, not just visual)
        this.secondaryStopLossLineObj = this.candleSeries.createPriceLine({
            price: price,
            color: secondarySlColor,
            lineWidth: slWidth,
            lineStyle: 0, // Solid line
            axisLabelVisible: true,
            title: slLabel,
        });
    }

    clearSecondaryStopLoss() {
        if (this.secondaryStopLossLineObj) {
            this.candleSeries.removePriceLine(this.secondaryStopLossLineObj);
            this.secondaryStopLossLineObj = null;
            this.secondaryStopPrice = null;
        }
    }
    /**
     * Load line settings from localStorage
     */
    getTradeLineSettings() {
        const defaults = {
            entryColor: '#22c55e',
            entryWidth: 1,
            exitColor: '#ef4444',
            exitWidth: 1
        };
        const saved = localStorage.getItem('tradeLineSettings');
        return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
    }

    /**
     * Add entry line at entry price - HORIZONTAL LINE
     * @param {number} price - Entry price
     * @param {number} quantity - Number of contracts
     */
    addEntryMarker(price, quantity) {
        const showLines = localStorage.getItem('showEntryLines') === 'true';
        if (!showLines || !price || price <= 0) return;

        // Get user settings
        const settings = this.getTradeLineSettings();

        // Create horizontal price line
        const priceLine = this.candleSeries.createPriceLine({
            price: price,
            color: settings.entryColor,
            lineWidth: settings.entryWidth,
            lineStyle: 0, // Solid line
            axisLabelVisible: true,
            title: 'ENTRY',
        });

        // Store line reference
        this.entryLines.push({ priceLine, price });
    }

    /**
     * Add exit line at exit price - HORIZONTAL LINE
     * @param {number} price - Exit price
     * @param {number} quantity - Number of contracts
     */
    addExitMarker(price, quantity) {
        const showLines = localStorage.getItem('showExitLines') === 'true';
        if (!showLines || !price || price <= 0) return;

        // Get user settings
        const settings = this.getTradeLineSettings();

        // Create horizontal price line
        const priceLine = this.candleSeries.createPriceLine({
            price: price,
            color: settings.exitColor,
            lineWidth: settings.exitWidth,
            lineStyle: 0, // Solid line
            axisLabelVisible: true,
            title: 'EXIT',
        });

        // Store line reference
        this.exitLines.push({ priceLine, price });
    }

    /**
     * Clear all entry/exit lines
     */
    clearAllMarkers() {
        // Remove all entry lines
        this.entryLines.forEach(lineObj => {
            if (lineObj.priceLine) {
                this.candleSeries.removePriceLine(lineObj.priceLine);
            }
        });
        this.entryLines = [];

        // Remove all exit lines
        this.exitLines.forEach(lineObj => {
            if (lineObj.priceLine) {
                this.candleSeries.removePriceLine(lineObj.priceLine);
            }
        });
        this.exitLines = [];
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.ChartManager = ChartManager;
}

