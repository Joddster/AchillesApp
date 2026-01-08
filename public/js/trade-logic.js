class TradeLogic {
    constructor() {
        this.currentDelta = 0;
        this.expectedMove = 1.0;
        this.targetProfit = 1000;
        this.strike = 0;
    }

    updateInputs(delta, expectedMove, targetProfit) {
        this.currentDelta = parseFloat(delta) || 0;
        this.expectedMove = parseFloat(expectedMove) || 0;
        this.targetProfit = parseFloat(targetProfit) || 0;
    }

    calculate() {
        // Profit per contract per $1 move = delta * 100
        const profitPerContractPerDollar = this.currentDelta * 100;
        
        // Contracts required = ceil(targetProfit / (delta * 100 * expectedMove))
        let contractsRequired = 0;
        if (profitPerContractPerDollar > 0 && this.expectedMove > 0) {
            const totalProfitPerContract = profitPerContractPerDollar * this.expectedMove;
            contractsRequired = Math.ceil(this.targetProfit / totalProfitPerContract);
        }

        return {
            profitPerOne: profitPerContractPerDollar,
            contracts: contractsRequired,
            delta: this.currentDelta
        };
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.tradeLogic = new TradeLogic();
}

