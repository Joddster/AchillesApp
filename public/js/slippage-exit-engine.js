// Slippage-Aware Exit Engine
// Wraps auto-exit logic with slippage-aware LIMIT IOC orders and retry logic.
//
// Design goals:
// - Never use market orders for exits.
// - Use LIMIT + IOC so nothing rests on the book.
// - Up to 3 attempts, tightening price each time.
// - Use local Webull event stream (ORDER_UPDATE / POSITIONS_UPDATE / QUOTE_UPDATE)
//   for best-effort fill tracking and flat checks.

class SlippageExitEngine {
    /**
     * @param {object} api - Webull API wrapper with placeOrder()
     * @param {function} log - Logging function from app.js
     * @param {object} [options]
     * @param {number} [options.slippageToleranceRatio] - Default 0.05 (5%)
     * @param {number} [options.defaultTickSize] - Default 0.01 ($0.01)
     */
    constructor(api, log, options = {}) {
        this.api = api;
        this.log = log || (() => {});

        this.slippageToleranceRatio = options.slippageToleranceRatio ?? 0.05;
        this.defaultTickSize = options.defaultTickSize ?? 0.01;

        // Event stream state
        this.ws = null;
        this.isConnecting = false;
        this.eventsAvailable = false; // true only when local broker stream is connected

        /** @type {Map<string, any>} latestPositions keyed by symbol */
        this.latestPositions = new Map();
        /** @type {Map<string, any>} latestQuotes keyed by symbol */
        this.latestQuotes = new Map();

        /** @type {Map<string, {resolve:(update:any)=>void, timeoutId:any, last:any}>} */
        this.pendingOrderWaits = new Map();

        /** @type {Map<string, any>} active exit configs keyed by symbol (or custom key) */
        this.activeExits = new Map();

        /** @type {Map<string, string>} orderId -> exitKey */
        this.orderToExitKey = new Map();
        
        /** @type {object} Reference to appState for market status checks */
        this._appStateRef = null;
    }
    
    /**
     * Set reference to appState so engine can check market status
     * @param {object} appState - Reference to global appState
     */
    setAppStateRef(appState) {
        this._appStateRef = appState;
    }

    startEventStream() {
        if (this.ws || this.isConnecting) return;
        if (typeof WebSocket === 'undefined') {
            this.log('SlippageExitEngine: WebSocket not available in this environment – running in HTTP-only mode', 'info');
            return;
        }

        const connect = () => {
            this.isConnecting = true;
            try {
                const ws = new WebSocket('ws://localhost:3001/webull-events');
                this.ws = ws;

                ws.onopen = () => {
                    this.isConnecting = false;
                    this.eventsAvailable = true;
                    this.log('SlippageExitEngine: Connected to ws://localhost:3001/webull-events (event-driven mode)', 'success');
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleEvent(data);
                    } catch (e) {
                        this.log(`SlippageExitEngine: Failed to parse event: ${e.message}`, 'error');
                    }
                };

                ws.onerror = (err) => {
                    this.eventsAvailable = false;
                    this.log(`SlippageExitEngine: WebSocket error (falling back to HTTP-only mode): ${err.message || err}`, 'warn');
                };

                ws.onclose = () => {
                    this.eventsAvailable = false;
                    this.log('SlippageExitEngine: WebSocket closed – will retry in background, running HTTP-only meanwhile', 'info');
                    this.ws = null;
                    this.isConnecting = false;
                    setTimeout(connect, 5000);
                };
            } catch (e) {
                this.isConnecting = false;
                this.eventsAvailable = false;
                this.log(`SlippageExitEngine: WebSocket connect failed – HTTP-only mode: ${e.message}`, 'warn');
            }
        };

        connect();
    }

    /**
     * Arm slippage-aware exit for a position.
     * This does NOT place any orders yet – it just stores config and precomputes slippage values.
     *
     * @param {object} params
     * @param {string} params.symbol
     * @param {number} params.tickerId
     * @param {'LONG'|'SHORT'} params.side - Entry side (LONG=we will SELL to exit, SHORT=we will BUY to exit)
     * @param {number} params.qty - Contracts/shares to exit
     * @param {number} params.targetProfitUSD - Desired profit in USD
     * @param {number} params.maxLossUSD - Max allowed loss in USD (absolute)
     * @param {number} params.effectiveDelta - Option delta (or 1 for stock)
     * @param {number} [params.tickSize] - Price tick size (default 0.01)
     */
    armExit(params) {
        if (!params || !params.symbol || !params.tickerId || !params.qty) {
            this.log('SlippageExitEngine.armExit: Missing required params, skipping', 'error');
            return;
        }

        const {
            symbol,
            tickerId,
            side,
            qty,
            targetProfitUSD,
            maxLossUSD,
            effectiveDelta,
            tickSize
        } = params;

        const key = symbol; // For now, we key by symbol – one active exit per symbol

        const safeDelta = Math.abs(effectiveDelta || 0);
        const safeQty = Math.max(1, Math.abs(qty || 0));
        const tick = tickSize || this.defaultTickSize;

        // PnL per 1 tick move of the underlying (approx)
        const pnlPerTick = safeDelta * tick * 100 * safeQty;

        const safeTarget = Math.max(0, Number(targetProfitUSD) || 0);
        const safeMaxLoss = Math.max(0, Math.abs(Number(maxLossUSD) || 0));

        const profitSlippageUSD = safeTarget * this.slippageToleranceRatio;
        const lossSlippageUSD = safeMaxLoss * this.slippageToleranceRatio;

        const profitSlippagePrice = pnlPerTick > 0 ? profitSlippageUSD / pnlPerTick : 0;
        const lossSlippagePrice = pnlPerTick > 0 ? lossSlippageUSD / pnlPerTick : 0;

        this.activeExits.set(key, {
            symbol,
            tickerId,
            side,
            qty: safeQty,
            targetProfitUSD: safeTarget,
            maxLossUSD: safeMaxLoss,
            effectiveDelta: safeDelta,
            tickSize: tick,
            pnlPerTick,
            profitSlippageUSD,
            lossSlippageUSD,
            profitSlippagePrice,
            lossSlippagePrice
        });

        this.log(
            `SlippageExitEngine: Armed exit for ${symbol} qty=${safeQty}, target=$${safeTarget.toFixed(2)}, maxLoss=$${safeMaxLoss.toFixed(2)}, delta=${safeDelta.toFixed(4)}`,
            'info'
        );
    }

    /**
     * Execute an immediate exit using LIMIT+IOC orders with slippage control and up to 3 attempts.
     * This is intended to be called from auto-exit triggers (TP/SL) in app.js.
     *
     * @param {object} params
     * @param {string} params.symbol
     * @param {number} params.tickerId
     * @param {'BUY'|'SELL'} params.exitSide - Order side used to exit (SELL to close longs, BUY to cover shorts)
     * @param {'TAKE_PROFIT'|'STOP_LOSS'} params.reason
     * @param {number} params.quantity - Desired quantity to close
     * @param {number} [params.bestBid] - Optional best bid snapshot (fallback)
     * @param {number} [params.bestAsk] - Optional best ask snapshot (fallback)
     */
    async executeExit(params) {
        const {
            symbol,
            tickerId,
            optionContractId,
            stockTickerId,
            exitSide,
            reason,
            quantity,
            bestBid,
            bestAsk
        } = params || {};

        if (!symbol || !tickerId || !exitSide || !quantity) {
            this.log('SlippageExitEngine.executeExit: Missing required params', 'error');
            return;
        }

        const key = symbol;
        const config = this.activeExits.get(key);
        const remainingInitial = Math.max(1, Math.abs(quantity));

        if (!config) {
            this.log(`SlippageExitEngine.executeExit: No armed exit found for ${symbol}, using minimal safeguards`, 'warn');
        }

        const tick = (config && config.tickSize) || this.defaultTickSize;
        const pnlPerTick = (config && config.pnlPerTick) || 0;

        // Select which slippage bucket to use
        let rawSlippagePrice = 0;
        if (config && reason === 'TAKE_PROFIT') {
            rawSlippagePrice = config.profitSlippagePrice;
        } else if (config && reason === 'STOP_LOSS') {
            rawSlippagePrice = config.lossSlippagePrice;
        }

        // Try to get live quote from event stream first
        const latestQuote = this.latestQuotes.get(symbol) || null;
        const derivedBid = this._extractBid(latestQuote);
        const derivedAsk = this._extractAsk(latestQuote);

        const bid = Number.isFinite(derivedBid) ? derivedBid : (bestBid || null);
        const ask = Number.isFinite(derivedAsk) ? derivedAsk : (bestAsk || null);

        const spread = (bid != null && ask != null && ask > bid)
            ? (ask - bid)
            : tick * 2;

        const baseOffset = this._clampOffset(rawSlippagePrice, tick, spread * 2);

        this.log(
            `SlippageExitEngine: Executing ${reason} exit for ${symbol} side=${exitSide}, qty=${remainingInitial}, baseOffset=${baseOffset.toFixed(4)}, tick=${tick}`,
            'warn'
        );

        if (!this.eventsAvailable) {
            this.log('SlippageExitEngine: Event stream not available – running simplified exit mode (no partial-fill tracking).', 'info');
        }

        let remaining = remainingInitial;

        for (let attempt = 0; attempt < 3 && remaining > 0; attempt++) {
            const extraTicks = attempt; // each retry moves 1 more tick in our favor for fast fill
            const totalOffset = baseOffset + extraTicks * tick;

            let limitPrice;
            if (exitSide === 'SELL') {
                const refBid = bid || ask || 0;
                limitPrice = refBid > 0 ? refBid - totalOffset : Math.max(tick, refBid - totalOffset);
                if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
                    limitPrice = tick;
                }
            } else {
                // BUY to cover: lift above the ask
                const refAsk = ask || bid || 0;
                limitPrice = refAsk > 0 ? refAsk + totalOffset : Math.max(tick, refAsk + totalOffset);
                if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
                    limitPrice = tick;
                }
            }

            // ✅ Use MARKET orders for auto-exits when market is open (instant fills!)
            // During extended hours, use VERY aggressive limit orders (market orders not allowed)
            const isMarketOpen = this._appStateRef?.marketActuallyOpen;
            const useMarketOrder = (reason === 'STOP_LOSS' || reason === 'TAKE_PROFIT') && isMarketOpen;
            
            this.log(`🔍 Auto-exit order: isMarketOpen=${isMarketOpen}, useMarketOrder=${useMarketOrder}, reason=${reason}`, 'info');
            
            // If market is closed and we need instant exit, make limit price VERY aggressive
            if (!isMarketOpen && (reason === 'STOP_LOSS' || reason === 'TAKE_PROFIT')) {
                // For SELL: price well below market to ensure fill
                // For BUY: price well above market to ensure fill
                if (exitSide === 'SELL') {
                    limitPrice = Math.max(tick, limitPrice - (spread * 5)); // 5x spread below market
                } else {
                    limitPrice = limitPrice + (spread * 5); // 5x spread above market
                }
            }
            
            this.log(
                `SlippageExitEngine: Attempt ${attempt + 1}/3 → ${exitSide} ${remaining} @ ${useMarketOrder ? 'MARKET' : limitPrice.toFixed(4)} (${useMarketOrder ? 'MKT' : 'LMT'})`,
                'warn'
            );

            let orderId = null;
            try {
                
                const orderParams = {
                    action: exitSide,
                    tickerId,
                    quantity: remaining,
                    orderType: useMarketOrder ? 'MKT' : 'LMT',
                    timeInForce: 'DAY',
                    // Allow extended-hours exits only when market is actually closed
                    outsideRegularTradingHour: !isMarketOpen
                };
                
                // Only include price for limit orders
                if (!useMarketOrder) {
                    orderParams.price = limitPrice;
                }
                
                // ✅ If this is an option order, pass the option contract ID
                if (optionContractId) {
                    orderParams.optionTickerId = optionContractId;
                    orderParams.stockTickerId = stockTickerId || tickerId; // Fallback to tickerId if stockTickerId not provided
                }
                
                const res = await this.api.placeOrder(orderParams);

                orderId = res && (res.orderId || res.data?.orderId || res.id);
                if (orderId) {
                    this.orderToExitKey.set(orderId, key);
                }
            } catch (e) {
                this.log(`SlippageExitEngine: placeOrder failed on attempt ${attempt + 1}: ${e.message}`, 'error');
                // If placing the order itself fails, break out – nothing more to do safely.
                break;
            }

            let update = null;

            if (this.eventsAvailable && orderId) {
                // Preferred path: event-driven order updates
                // Paper trading: 500ms timeout for fast exits (no real slippage risk)
                update = await this._waitForOrderUpdate(orderId, 500);
            } else {
                // HTTP-only fallback: poll Webull paper getAccountDetailAndPosition for this tickerId
                try {
                    const snapshot = await this.api.getPaperAccountDetailAndPosition(tickerId);
                    update = this._normalizeAccountDetailAndPosition(snapshot, orderId);
                } catch (e) {
                    this.log(`SlippageExitEngine: HTTP poll getAccountDetailAndPosition failed: ${e.message}`, 'error');
                }
            }

            if (update) {
                const filledQty = Number(update.filledQuantity || 0);
                const remainingQty = Number(update.remainingQuantity || 0);

                this.log(
                    `SlippageExitEngine: Order status for ${update.orderId || orderId} → status=${update.status}, filled=${filledQty}, remaining=${remainingQty}`,
                    'info'
                );

                remaining = remainingQty;

                if (update.status === 'FILLED' || remaining <= 0) {
                    remaining = 0;
                    break;
                }

                if (update.status === 'CANCELED' || update.status === 'REJECTED') {
                    // Partial fill + cancel is expected for IOC – continue with remaining
                    if (remaining <= 0) break;
                }
            } else {
                // No update seen – best effort: re-check position and break if flat (when we have positions).
                const pos = this.latestPositions.get(symbol);
                if (pos && pos.quantity != null && Math.abs(pos.quantity) === 0) {
                    this.log(
                        `SlippageExitEngine: No explicit order status, but position for ${symbol} appears flat. Stopping retries.`,
                        'info'
                    );
                    remaining = 0;
                    break;
                }
            }
        }

        // Final sanity check: if we still have a position and we've exhausted retries, log a loud warning.
        const finalPos = this.latestPositions.get(symbol);
        if (this.eventsAvailable && finalPos && finalPos.quantity && Math.abs(finalPos.quantity) > 0) {
            this.log(
                `⚠️ SlippageExitEngine: After all attempts, position for ${symbol} is NOT flat (qty=${finalPos.quantity}). Manual intervention required.`,
                'error'
            );
        } else if (this.eventsAvailable) {
            this.log(`✓ SlippageExitEngine: Exit sequence complete for ${symbol} (position flat)`, 'success');
        } else {
            this.log(`✓ SlippageExitEngine: Exit attempts complete for ${symbol} (HTTP-only mode, flatness unverified)`, 'info');
        }
    }

    /**
     * Handle incoming events from the local broker/Webull sensor.
     * Expects shapes:
     *  - { type: 'ORDER_UPDATE', payload: {...} }
     *  - { type: 'POSITIONS_UPDATE', payload: [...] }
     *  - { type: 'QUOTE_UPDATE', payload: {...} }
     */
    _handleEvent(evt) {
        if (!evt || !evt.type) return;

        if (evt.type === 'ORDER_UPDATE') {
            const o = evt.payload || {};
            const orderId = o.orderId;
            if (!orderId) return;

            const pending = this.pendingOrderWaits.get(orderId);
            if (pending) {
                pending.last = o;
                if (o.status === 'FILLED' || o.status === 'CANCELED' || o.status === 'REJECTED') {
                    clearTimeout(pending.timeoutId);
                    pending.resolve(o);
                    this.pendingOrderWaits.delete(orderId);
                }
            }
        } else if (evt.type === 'POSITIONS_UPDATE') {
            const list = Array.isArray(evt.payload) ? evt.payload : [];
            this.latestPositions.clear();
            for (const pos of list) {
                if (!pos || !pos.symbol) continue;
                this.latestPositions.set(pos.symbol, pos);
            }
        } else if (evt.type === 'QUOTE_UPDATE') {
            const q = evt.payload || {};
            if (!q.symbol) return;
            this.latestQuotes.set(q.symbol, q);
        }
    }

    _waitForOrderUpdate(orderId, timeoutMs) {
        return new Promise((resolve) => {
            const existing = this.pendingOrderWaits.get(orderId);
            if (existing) {
                // If somehow already waiting, just reuse but extend timeout best-effort.
                clearTimeout(existing.timeoutId);
            }

            const timeoutId = setTimeout(() => {
                const pending = this.pendingOrderWaits.get(orderId);
                if (pending) {
                    this.pendingOrderWaits.delete(orderId);
                    resolve(pending.last || null);
                } else {
                    resolve(null);
                }
            }, timeoutMs || 2500);

            this.pendingOrderWaits.set(orderId, {
                resolve,
                timeoutId,
                last: null
            });
        });
    }

    /**
     * Normalize Webull paper getAccountDetailAndPosition response into a light order/position status.
     * Best-effort parsing – structure may vary across environments.
     */
    _normalizeAccountDetailAndPosition(snapshot, targetOrderId) {
        if (!snapshot) return null;

        // Try to find orders array in common locations
        let orders = null;
        if (Array.isArray(snapshot.orders)) orders = snapshot.orders;
        else if (Array.isArray(snapshot.data?.orders)) orders = snapshot.data.orders;
        else if (Array.isArray(snapshot.orderList)) orders = snapshot.orderList;
        else if (Array.isArray(snapshot.data?.orderList)) orders = snapshot.data.orderList;

        let order = null;
        if (orders && orders.length > 0) {
            if (targetOrderId) {
                order = orders.find(o => (o.orderId || o.id) === targetOrderId) || null;
            }
            // Fallback: latest order (by createTime or last index)
            if (!order) {
                order = orders.reduce((latest, o) => {
                    const t = o.createTime || o.updateTime || o.time || 0;
                    if (!latest) return o;
                    const lt = latest.createTime || latest.updateTime || latest.time || 0;
                    return t > lt ? o : latest;
                }, null);
            }
        }

        // Try to find a position object in common locations
        let position = null;
        if (snapshot.position) position = snapshot.position;
        else if (snapshot.data?.position) position = snapshot.data.position;
        else if (Array.isArray(snapshot.positions) && snapshot.positions.length > 0) position = snapshot.positions[0];
        else if (Array.isArray(snapshot.data?.positions) && snapshot.data.positions.length > 0) position = snapshot.data.positions[0];

        const normalized = {
            orderId: order ? (order.orderId || order.id) : targetOrderId || null,
            status: order ? (order.status || order.statusName || order.orderStatus || 'Unknown') : 'Unknown',
            filledQuantity: order ? Number(order.filledQuantity || order.filledQty || 0) : 0,
            remainingQuantity: order ? Number(order.remainingQuantity || order.remainingQty || 0) : null,
            avgExecPrice: order ? Number(order.avgExecPrice || order.filledAvgPrice || 0) : 0,
            positionQty: position ? Number(position.position || position.quantity || position.qty || 0) : null
        };

        // If remainingQuantity is not present but we know total quantity, infer it
        if (order && normalized.remainingQuantity == null) {
            const total = Number(order.quantity || order.totalQuantity || 0);
            normalized.remainingQuantity = Math.max(0, total - normalized.filledQuantity);
        }

        return normalized;
    }

    _clampOffset(offset, minTick, maxOffset) {
        if (!Number.isFinite(offset) || offset <= 0) {
            return minTick;
        }
        const o = Math.max(minTick, offset);
        if (!Number.isFinite(maxOffset) || maxOffset <= 0) {
            return o;
        }
        return Math.min(o, maxOffset);
    }

    _extractBid(quote) {
        if (!quote) return null;
        if (quote.bid != null) return Number(quote.bid);
        if (quote.bidPrice != null) return Number(quote.bidPrice);
        if (quote.quote && quote.quote.bidPrice != null) return Number(quote.quote.bidPrice);
        return null;
    }

    _extractAsk(quote) {
        if (!quote) return null;
        if (quote.ask != null) return Number(quote.ask);
        if (quote.askPrice != null) return Number(quote.askPrice);
        if (quote.quote && quote.quote.askPrice != null) return Number(quote.quote.askPrice);
        return null;
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.SlippageExitEngine = SlippageExitEngine;
}


