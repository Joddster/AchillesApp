# Neuralink Trading Web App

A fully-functional web-based trading application for Webull paper and real trading, optimized for Vercel deployment.

## Features

✅ **Full Trading Functionality**
- Real-time market data via Polygon.io API
- Webull paper & real account trading
- Options trading with live Greeks
- Advanced charting with TradingView-like interface
- Auto stop-loss and take-profit
- Real-time P&L tracking

✅ **Advanced Chart Tools**
- Multiple timeframes (1m, 5m, 15m, 30m, 1h, 1D)
- Drawing tools (trend lines, horizontal lines, rectangles, Fibonacci)
- Technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands, VWAP)
- Opening range levels (ORH/ORL) and previous day levels (PDH/PDL)

✅ **Risk Management**
- Effective delta calculation engine
- Slippage exit protection
- Trojan mode (trailing stop loss)
- Manual contract quantity override
- Partial position closing

## Deployment to Vercel

### Prerequisites

1. **Polygon.io API Key** (Free tier available)
   - Sign up at [polygon.io](https://polygon.io)
   - Get your API key from the dashboard

2. **Webull Account** (Optional - for trading)
   - Paper trading account (free)
   - Real trading account (optional)

### Quick Deploy

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin YOUR_GITHUB_REPO_URL
   git push -u origin main
   ```

2. **Deploy to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your GitHub repository
   - Vercel will auto-detect Next.js and deploy

3. **Configure API Key**
   - Once deployed, open your app
   - Click the ⚙️ Settings icon
   - Scroll to "Market Data Configuration"
   - Paste your Polygon API key
   - Click "Save API Key"

### Manual Deployment

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Configuration

### Polygon API Key

The app requires a Polygon.io API key for real-time market data. You can configure it in two ways:

1. **Via Settings UI** (Recommended)
   - Open the app
   - Click ⚙️ → Full Settings Panel
   - Enter your API key under "Market Data Configuration"

2. **Via localStorage** (Advanced)
   ```javascript
   localStorage.setItem('POLYGON_API_KEY', 'your_key_here');
   ```

### Webull Login

For trading functionality, you need to connect your Webull account:

1. Click the 👤 icon → "Connect Webull"
2. Choose Paper or Real trading mode
3. Enter your credentials using manual token entry

**Note:** Automated login (Puppeteer) is not available in browser mode. You must use manual token entry with tokens from DevTools.

## Architecture

### Frontend (Browser)
- **Next.js** - React framework with SSR
- **Lightweight Charts** - TradingView-quality charting
- **Polygon.io** - Real-time market data
- **localStorage** - Client-side persistence

### Backend (Serverless)
- **Vercel Functions** - API routes for server-side operations
- **RSA Encryption** - Secure Webull authentication
- **Signature Generation** - Webull API request signing

### Key Files

```
├── pages/
│   ├── index.js              # Main app page
│   ├── _app.js               # Next.js app wrapper
│   └── api/
│       ├── webull/
│       │   ├── signature.js  # Webull API proxy
│       │   └── rsa-encrypt.js # RSA encryption endpoint
│       └── storage/
│           ├── save.js       # Server-side storage
│           └── load.js       # Server-side retrieval
├── public/
│   ├── js/
│   │   ├── app-browser.js    # Main application logic
│   │   ├── webull-api-browser.js # Webull API client
│   │   ├── polygon-api-browser.js # Polygon API client
│   │   ├── chart.js          # Chart management
│   │   ├── trade-logic.js    # Trading calculations
│   │   └── ...               # Other modules
│   └── css/
│       └── styles.css        # Application styles
├── package.json              # Dependencies
├── next.config.js            # Next.js configuration
└── vercel.json               # Vercel deployment config
```

## Browser Compatibility

- ✅ Chrome/Edge (Recommended)
- ✅ Firefox
- ✅ Safari
- ⚠️ Mobile browsers (limited support)

## Security Notes

- API keys are stored in localStorage (client-side only)
- Webull tokens are stored in localStorage
- RSA encryption is handled server-side
- No sensitive data is sent to Vercel servers
- All trading operations go directly to Webull APIs

## Limitations vs Desktop Version

| Feature | Desktop (Electron) | Web (Vercel) |
|---------|-------------------|--------------|
| Real-time data | ✅ | ✅ |
| Trading | ✅ | ✅ |
| Automated login | ✅ | ❌ (Manual tokens only) |
| Multi-window | ✅ | ⚠️ (Browser tabs) |
| Global hotkeys | ✅ | ⚠️ (Page focus required) |
| File persistence | ✅ | ⚠️ (localStorage only) |

## Troubleshooting

### "No Polygon API key" error
- Go to Settings → Market Data Configuration
- Enter your Polygon.io API key
- Refresh the page

### Charts not loading
- Check browser console for errors
- Verify Polygon API key is valid
- Try a different ticker symbol

### Trading not working
- Verify Webull tokens are valid
- Check if market is open (9:30 AM - 4:00 PM EST)
- Try refreshing the page

### Data not persisting
- Check browser localStorage is enabled
- Clear cache and reload
- Verify you're not in incognito/private mode

## Support

For issues or questions:
1. Check browser console for error messages
2. Verify all API keys are configured
3. Test with paper trading first

## License

ISC

## Disclaimer

This software is for educational purposes only. Trading involves risk. Always test with paper trading before using real money. The developers are not responsible for any financial losses.

