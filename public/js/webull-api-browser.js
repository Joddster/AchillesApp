// Browser-compatible Webull API client
// Proxies requests through serverless API endpoints to handle crypto/signatures

class WebullAPI {
    constructor() {
        this.accessToken = null;
        this.deviceId = null;
        this.accountId = null;
        this.paperAccountId = null;
        this.paperId = null;
        this.realAccountId = null;
        this.tradeToken = null;
        this.tradeTokenExpireIn = null;
        this.userId = null;
        this.tradingMode = 'PAPER';
        this.hasRealAccount = false;
        this.hasPaperAccount = false;
        this.rsa = new WebullRSA();
        this.optionCache = this.loadOptionCache();
    }

    loadOptionCache() {
        try {
            const cached = localStorage.getItem('optionCache');
            if (cached) {
                const data = JSON.parse(cached);
                console.log(`✅ Loaded option cache from localStorage: ${Object.keys(data.options || {}).length} tickers`);
                return data;
            }
            return { options: {}, lastUpdated: null };
        } catch (error) {
            console.error('❌ Failed to load option cache:', error.message);
            return { options: {}, lastUpdated: null };
        }
    }

    saveOptionCache() {
        try {
            localStorage.setItem('optionCache', JSON.stringify(this.optionCache));
        } catch (error) {
            console.error('❌ Failed to save option cache:', error.message);
        }
    }

    setTradingMode(mode) {
        this.tradingMode = mode.toUpperCase();
        console.log(`Trading mode set to: ${this.tradingMode}`);
    }

    async loginWithToken(accessToken, deviceId, accountId = null, tradeToken = null) {
        console.log('Logging in with tokens...');
        console.log(`  Access Token: ${accessToken.substring(0, 20)}...`);
        console.log(`  Device ID: ${deviceId.substring(0, 30)}...`);
        console.log(`  Account ID: ${accountId || 'WILL AUTO-DETECT'}`);
        console.log(`  Trade Token: ${tradeToken ? tradeToken.substring(0, 20) + '...' : 'NONE'}`);

        this.accessToken = accessToken;
        this.deviceId = deviceId;
        this.tradeToken = tradeToken;

        // Save to localStorage for persistence
        localStorage.setItem('wb_access_token', accessToken);
        localStorage.setItem('wb_device_id', deviceId);
        if (tradeToken) localStorage.setItem('wb_trade_token', tradeToken);
        if (accountId) localStorage.setItem('wb_account_id', accountId);

        // Always try to fetch account info to get both paper and real IDs
        try {
            await this.getAccountInfo();
        } catch (error) {
            console.warn('⚠️  Could not fetch full account info:', error.message);
        }

        console.log('Login successful!');
        return {
            success: true,
            accountId: this.accountId,
            paperAccountId: this.paperAccountId,
            realAccountId: this.realAccountId,
            hasRealAccount: this.hasRealAccount,
            hasPaperAccount: this.hasPaperAccount
        };
    }

    async request(method, path, options = {}) {
        // Proxy through server-side API to handle signatures
        const response = await fetch('/api/webull/signature', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                method,
                path,
                headers: {
                    'access_token': this.accessToken,
                    'did': this.deviceId,
                    't_token': this.tradeToken || '',
                    ...options.headers
                },
                queryParams: options.params || {},
                body: options.data || null
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `Request failed: ${response.status}`);
        }

        return data;
    }

    async getAccountInfo() {
        try {
            // 1. Try to get paper account
            try {
                const paperInfo = await this.getPaperAccount();
                if (paperInfo && paperInfo.id) {
                    this.hasPaperAccount = true;
                    this.paperAccountId = paperInfo.accountId || paperInfo.id;
                    this.paperId = paperInfo.paperId || 1;
                    console.log(`✅ Found paper account: ${this.paperAccountId} (paperId: ${this.paperId})`);
                }
            } catch (error) {
                console.warn('⚠️  Could not fetch paper account:', error.message);
            }

            // 2. Try to get real account
            try {
                const accounts = await this.getAccounts();
                if (accounts && accounts.length > 0) {
                    const realAccount = accounts.find(acc => acc.accountType !== 7);
                    if (realAccount) {
                        this.hasRealAccount = true;
                        this.realAccountId = realAccount.secAccountId;
                        this.userId = realAccount.userId;
                        console.log(`✅ Found real account: ${this.realAccountId}`);
                    }
                }
            } catch (error) {
                console.warn('⚠️  Could not fetch real account:', error.message);
            }

            // Set current account ID based on trading mode
            if (this.tradingMode === 'PAPER' && this.hasPaperAccount) {
                this.accountId = this.paperAccountId;
            } else if (this.tradingMode === 'REAL' && this.hasRealAccount) {
                this.accountId = this.realAccountId;
            }

            console.log(`✅ Account detection complete:`);
            console.log(`   Paper: ${this.hasPaperAccount ? '✓' : '✗'}`);
            console.log(`   Real: ${this.hasRealAccount ? '✓' : '✗'}`);
            console.log(`   Current mode: ${this.tradingMode}`);
            console.log(`   Active account ID: ${this.accountId}`);

        } catch (error) {
            console.error('❌ Failed to get account info:', error);
            throw error;
        }
    }

    async getPaperAccount() {
        return await this.request('GET', '/api/paper/v1/webull/account');
    }

    async getAccounts() {
        return await this.request('GET', '/api/trading/v1/webull/accounts');
    }

    async getAccountBalance() {
        if (this.tradingMode === 'PAPER') {
            return await this.request('GET', `/api/paper/v1/webull/${this.paperAccountId}/portfolio`);
        } else {
            return await this.request('GET', `/api/trading/v1/webull/${this.accountId}/balance`);
        }
    }

    async getPositions() {
        if (this.tradingMode === 'PAPER') {
            return await this.request('GET', `/api/paper/v1/webull/${this.paperAccountId}/positions`);
        } else {
            return await this.request('GET', `/api/trading/v1/webull/${this.accountId}/positions`);
        }
    }

    async placeOrder(order) {
        if (this.tradingMode === 'PAPER') {
            return await this.request('POST', `/api/paper/v1/webull/${this.paperAccountId}/orders`, {
                data: order
            });
        } else {
            // Real account orders require trade token
            if (!this.tradeToken) {
                throw new Error('Trade token required for real account trading');
            }
            return await this.request('POST', `/api/trading/v1/webull/${this.accountId}/orders`, {
                data: order,
                headers: {
                    't_token': this.tradeToken
                }
            });
        }
    }

    async getQuote(symbol) {
        return await this.request('GET', `/api/quote/v1/quote/ticker/${symbol}`);
    }

    async getOptionQuote(optionId) {
        return await this.request('GET', `/api/quote/v1/quote/option/${optionId}`);
    }

    async searchTicker(query) {
        return await this.request('GET', '/api/securities/v1/securities/search', {
            params: {
                keyword: query,
                regionId: 6
            }
        });
    }
}

// Make available globally
if (typeof window !== 'undefined') {
    window.WebullAPI = WebullAPI;
}

