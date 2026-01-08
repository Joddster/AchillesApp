// Effective Delta Engine
// Computes option delta from real market price movement
// Broker-agnostic implementation

class EffectiveDeltaEngine {
    constructor(bufferDurationSeconds = 30, minMovement = 0.05) {
        this.bufferDuration = bufferDurationSeconds * 1000; // Convert to ms
        this.minMovement = minMovement;
        this.samples = [];
        this.currentDelta = null;
        this.lastValidDelta = 0.5; // Safe default
        this.recentDeltas = []; // For EWMA smoothing
        this.ewmaAlpha = 0.3; // Smoothing factor
        this.maxDeltaJump = 0.4; // Outlier rejection threshold
        this.debugMode = false;
        this.log = () => {}; // No-op logging for performance
    }

    /**
     * Add a new price sample
     * @param {number} underlyingPrice - Current stock price
     * @param {number} optionPrice - Current option price
     * @param {string} optionType - 'call' or 'put'
     */
    addSample(underlyingPrice, optionPrice, optionType = 'call') {
        const now = Date.now();
        
        // Validate inputs
        if (!underlyingPrice || !optionPrice || isNaN(underlyingPrice) || isNaN(optionPrice)) {
            this.log('Invalid sample rejected: NaN values');
            return;
        }

        // Add sample
        this.samples.push({
            timestamp: now,
            underlyingPrice: parseFloat(underlyingPrice),
            optionPrice: parseFloat(optionPrice),
            optionType: optionType
        });

        // Remove old samples (older than buffer duration)
        this.samples = this.samples.filter(s => now - s.timestamp < this.bufferDuration);

        // Try to compute delta
        this.computeDelta(optionType);
    }

    /**
     * Compute effective delta from price movement
     */
    computeDelta(optionType) {
        if (this.samples.length < 2) {
            this.log('Insufficient samples for delta calculation');
            return;
        }

        // Get oldest and newest samples
        const oldest = this.samples[0];
        const latest = this.samples[this.samples.length - 1];

        // Calculate price changes
        const underlyingChange = latest.underlyingPrice - oldest.underlyingPrice;
        const optionChange = latest.optionPrice - oldest.optionPrice;

        // Check if underlying moved enough to be meaningful
        if (Math.abs(underlyingChange) < this.minMovement) {
            this.log(`Insufficient movement: $${Math.abs(underlyingChange).toFixed(3)} < $${this.minMovement}`);
            // Keep last valid delta, don't update
            return;
        }

        // Calculate raw effective delta
        let rawDelta = optionChange / underlyingChange;

        // Clamp to realistic bounds
        if (optionType === 'call') {
            rawDelta = Math.max(0, Math.min(1, rawDelta));
        } else {
            rawDelta = Math.max(-1, Math.min(0, rawDelta));
        }

        // Outlier rejection
        if (this.lastValidDelta !== null) {
            const deltaJump = Math.abs(rawDelta - this.lastValidDelta);
            if (deltaJump > this.maxDeltaJump) {
                this.log(`Outlier rejected: jump of ${deltaJump.toFixed(3)} exceeds ${this.maxDeltaJump}`);
                return;
            }
        }

        // Apply EWMA smoothing
        let smoothedDelta;
        if (this.recentDeltas.length === 0) {
            smoothedDelta = rawDelta;
        } else {
            // Exponential weighted moving average
            const prevSmoothed = this.recentDeltas[this.recentDeltas.length - 1];
            smoothedDelta = this.ewmaAlpha * rawDelta + (1 - this.ewmaAlpha) * prevSmoothed;
        }

        // Store for smoothing history (keep last 10)
        this.recentDeltas.push(smoothedDelta);
        if (this.recentDeltas.length > 10) {
            this.recentDeltas.shift();
        }

        // Update current delta
        this.currentDelta = smoothedDelta;
        this.lastValidDelta = smoothedDelta;

        this.log(`Delta updated: ${smoothedDelta.toFixed(4)} (raw: ${rawDelta.toFixed(4)}, samples: ${this.samples.length})`);
    }

    /**
     * Get current effective delta
     * @returns {number} Current delta (never null, returns last valid)
     */
    getDelta() {
        return this.currentDelta !== null ? this.currentDelta : this.lastValidDelta;
    }

    /**
     * Check if delta is actively updating
     * @returns {boolean}
     */
    isLive() {
        if (this.samples.length < 2) return false;
        const latestTimestamp = this.samples[this.samples.length - 1].timestamp;
        return Date.now() - latestTimestamp < 5000; // Active if updated in last 5 seconds
    }

    /**
     * Get status for UI display
     */
    getStatus() {
        return {
            delta: this.getDelta(),
            isLive: this.isLive(),
            sampleCount: this.samples.length,
            source: 'Effective (Real-time)'
        };
    }

    /**
     * Reset engine (e.g., when switching tickers)
     */
    reset() {
        this.samples = [];
        this.currentDelta = null;
        this.recentDeltas = [];
        // Don't reset lastValidDelta - keep as fallback
        this.log('Engine reset');
    }

    /**
     * Internal logging
     */
    log(message) {
        if (this.debugMode) {
            console.log(`[EffectiveDelta] ${message}`);
        }
    }

    /**
     * Enable debug logging
     */
    enableDebug() {
        this.debugMode = true;
    }
}

// Export for use in renderer
// Export for browser
if (typeof window !== 'undefined') {
    window.EffectiveDeltaEngine = EffectiveDeltaEngine;
}

