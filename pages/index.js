import Head from 'next/head';
import { useEffect } from 'react';

export default function Home() {
  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Robinhood Trading Desk</title>
        <link rel="icon" href="/icon.png" />
      </Head>
      
      <div id="app">
        {/* Login Modal (disabled by default in Polygon-only mode) */}
        <div id="login-modal" style={{display: 'none'}}>
          <div className="login-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Webull Connection</h2>
              <button id="close-login-modal" style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '24px', cursor: 'pointer', padding: 0, width: '30px', height: '30px' }}>&times;</button>
            </div>
            
            <div id="token-form">
              {/* Account Mode Selector */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                <label htmlFor="mode-paper" style={{ flex: 1, cursor: 'pointer' }}>
                  <input type="radio" name="account-mode" id="mode-paper" value="paper" defaultChecked style={{ display: 'none' }} />
                  <div className="mode-select-btn" id="paper-btn-label" style={{ padding: '15px', background: '#2196f3', border: '2px solid #1976d2', borderRadius: '8px', textAlign: 'center', fontSize: '15px', fontWeight: 700, color: '#fff', transition: 'all 0.2s', boxShadow: '0 2px 8px rgba(33, 150, 243, 0.4)' }}>
                    📄 Paper
                  </div>
                </label>
                <label htmlFor="mode-real" style={{ flex: 1, cursor: 'pointer' }}>
                  <input type="radio" name="account-mode" id="mode-real" value="real" style={{ display: 'none' }} />
                  <div className="mode-select-btn" id="real-btn-label" style={{ padding: '15px', background: '#444', border: '2px solid #666', borderRadius: '8px', textAlign: 'center', fontSize: '15px', fontWeight: 700, color: '#aaa', transition: 'all 0.2s' }}>
                    🔴 Real
                  </div>
                </label>
              </div>

              {/* Embedded Login (Primary Method) */}
              <div style={{ marginBottom: '20px' }}>
                <button id="btn-login-puppeteer" style={{ width: '100%', padding: '15px', fontSize: '16px', fontWeight: 700, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none', borderRadius: '8px', cursor: 'pointer', color: '#fff', transition: 'all 0.3s', boxShadow: '0 4px 15px rgba(102, 126, 234, 0.4)' }}>
                  🔐 Login with Webull
                </button>
                <p style={{ fontSize: '11px', color: '#888', textAlign: 'center', marginTop: '8px' }}>
                  Embedded browser - Login directly in the app (no popup!)
                </p>
              </div>

              <div style={{ margin: '20px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ flex: 1, height: '1px', background: '#444' }}></div>
                <span style={{ fontSize: '11px', color: '#666', textTransform: 'uppercase' }}>OR</span>
                <div style={{ flex: 1, height: '1px', background: '#444' }}></div>
              </div>

              {/* Manual Token Entry (Alternative Method) */}
              <details style={{ marginBottom: '15px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '12px', color: '#aaa', padding: '10px', background: '#2a2a2a', borderRadius: '6px', userSelect: 'none' }}>
                  ⚙️ Advanced: Manual Token Entry
                </summary>
                <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #333' }}>
                  <p style={{ fontSize: '11px', color: '#888', marginBottom: '10px' }}>
                    For advanced users who already have tokens from DevTools
                  </p>
                  <textarea id="wb-token" placeholder="access_token" style={{ width: '100%', height: '50px', padding: '8px', background: '#333', border: '1px solid #444', color: '#fff', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical', boxSizing: 'border-box' }}></textarea>
                  <input type="text" id="wb-t-token" placeholder="t_token" style={{ marginTop: '10px', fontFamily: 'monospace', fontSize: '11px', display: 'none' }} />
                  <input type="text" id="wb-did" placeholder="did (device ID)" style={{ marginTop: '10px' }} />
                  <input type="text" id="wb-account-id" placeholder="Account ID" style={{ marginTop: '10px' }} />
                  <button id="btn-login-token" style={{ background: '#2196f3', marginTop: '10px' }}>
                    <span id="login-btn-text">Connect to Paper</span>
                  </button>
                </div>
              </details>
            </div>

            <p id="login-status" style={{ marginTop: '10px', textAlign: 'center', color: '#ff1744' }}></p>
          </div>
        </div>

        {/* Cache Warning Modal */}
        <div id="cache-warning-modal" style={{ display: 'none', position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0, 0, 0, 0.7)', zIndex: 10000, backdropFilter: 'blur(4px)' }}>
          <div className="login-box" style={{ maxWidth: '500px', margin: '100px auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#ff9800' }}>⚠️ Option Cache Warning</h2>
              <button id="close-cache-warning" style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '24px', cursor: 'pointer', padding: 0, width: '30px', height: '30px' }}>&times;</button>
            </div>
            
            <div id="cache-warning-content" style={{ marginBottom: '20px', padding: '15px', background: 'rgba(255, 152, 0, 0.1)', borderLeft: '4px solid #ff9800', borderRadius: '4px' }}>
              <p id="cache-warning-message" style={{ margin: 0, color: 'var(--cyber-text)', fontSize: '14px', lineHeight: 1.6 }}>
                Your option cache is stale and may contain outdated strike prices.
              </p>
            </div>
            
            <div style={{ display: 'flex', gap: '10px' }}>
              <button id="refresh-cache-now-btn" style={{ flex: 1, padding: '12px', fontSize: '14px', fontWeight: 700, background: '#2196f3', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                🔄 Refresh Now
              </button>
              <button id="skip-cache-refresh-btn" style={{ flex: 1, padding: '12px', fontSize: '14px', fontWeight: 700, background: '#444', color: '#aaa', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                Skip for Now
              </button>
            </div>
            
            <p style={{ marginTop: '15px', fontSize: '11px', color: '#888', textAlign: 'center' }}>
              This will fetch fresh option data from Webull (takes ~30 seconds)
            </p>
          </div>
        </div>

        {/* Header */}
        <header>
          <div className="app-title">Robinhood</div>
        
          <div className="header-right">
            {/* Market Status (existing) */}
            <div id="market-status" className="header-item">
              Market: <span id="market-state">Checking...</span>
            </div>
            
            {/* Calendar Shortcut */}
            <div className="header-item">
              <button id="open-calendar-btn" className="header-calendar-btn">📅 Calendar</button>
            </div>
            
            {/* Network Status Indicator */}
            <div className="header-item menu-item" id="network-status-container">
              <div className="network-indicator" id="network-indicator" title="Click for details">
                <span className="status-dot" id="network-dot"></span>
                <span className="status-text">Network</span>
              </div>
              {/* Dropdown tooltip */}
              <div className="menu-dropdown" id="network-dropdown" style={{ display: 'none' }}>
                <div className="dropdown-header">Network Status</div>
                <div className="dropdown-item" id="network-connection-status">Webull API: Connected</div>
                <div className="dropdown-item" id="network-last-update">Last update: Just now</div>
                <div className="dropdown-item" id="network-latency">Latency: ~100ms</div>
              </div>
            </div>
            
            {/* Quick Settings Gear */}
            <div className="header-item menu-item" id="settings-container">
              <div className="menu-icon" id="settings-icon" title="Quick Settings">⚙️</div>
              {/* Settings dropdown */}
              <div className="menu-dropdown" id="settings-dropdown" style={{ display: 'none' }}>
                <div className="dropdown-header">Quick Settings</div>
                <div className="dropdown-item clickable" id="toggle-theme">
                  <span>🌙</span> Theme: <strong id="current-theme">Dark</strong>
                </div>
                <div className="dropdown-divider"></div>
                <div className="dropdown-item clickable" id="open-full-settings">
                  <span>⚙️</span> Full Settings Panel
                </div>
                <div className="dropdown-divider"></div>
                <div className="dropdown-item clickable" id="open-new-window">
                  <span>🪟</span> New Window (Multi-Screen)
                </div>
              </div>
            </div>
            
            {/* User Profile */}
            <div className="header-item menu-item" id="user-container">
              <div className="menu-icon" id="user-icon" title="Account">👤</div>
              {/* User dropdown */}
              <div className="menu-dropdown" id="user-dropdown" style={{ display: 'none' }}>
                {/* Trading Mode Switcher */}
                <div className="dropdown-item clickable" id="user-connect-webull" style={{ display: 'none' }}>
                  <span>🔌</span> Connect Webull
                </div>
                <div className="dropdown-item clickable" id="user-logout">
                  <span>🚪</span> Log Out
                </div>
                <div className="dropdown-item clickable" id="clear-watchlist-btn" style={{ color: '#ff6666' }}>
                  <span>🧹</span> Clear Watchlist Cache
                </div>
              </div>
            </div>
            
            {/* Connection Status Badge (hidden via CSS, kept for logic wiring) */}
            <div id="connection-status" className="status-badge disconnected">Disconnected</div>
            
            {/* Trading Mode Badge (always visible) */}
            <div id="trading-mode-badge" className="trading-mode-badge paper-mode">
              <span className="mode-icon">📄</span>
              <span className="mode-text">PAPER</span>
            </div>
          </div>
        </header>

        <div className="main-container">
          {/* Custom Alert Modal */}
          <div id="custom-alert-modal" className="modal" style={{ display: 'none', zIndex: 10001 }}>
            <div className="modal-content" style={{ maxWidth: '500px', textAlign: 'center' }}>
              <div className="modal-header" style={{ borderBottom: '2px solid var(--cyber-border)' }}>
                <h2 id="custom-alert-title" style={{ fontSize: '18px', margin: 0 }}>Notification</h2>
              </div>
              <div className="modal-body" style={{ padding: '30px 20px' }}>
                <div id="custom-alert-icon" style={{ fontSize: '48px', marginBottom: '20px' }}>ℹ️</div>
                <p id="custom-alert-message" style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--cyber-text)' }}></p>
              </div>
              <div style={{ padding: '0 20px 20px 20px' }}>
                <button id="custom-alert-ok" className="toolbar-btn" style={{ width: '100%', padding: '12px', fontWeight: 'bold', fontSize: '14px' }}>OK</button>
              </div>
            </div>
          </div>

          {/* Full Settings Modal */}
          <div id="full-settings-modal" className="modal" style={{ display: 'none' }}>
            <div className="modal-content">
              <div className="modal-header">
                <h2>Settings & Preferences</h2>
                <button id="close-full-settings" className="modal-close-btn">✕</button>
              </div>
              <div className="modal-body">
                {/* Settings content will be loaded by JavaScript */}
                <div id="settings-content-container"></div>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="sidebar">
            <div className="watchlist-header">
              <span>Watchlist</span>
              <button id="add-ticker-btn" className="watchlist-add-btn">
                + Add
              </button>
            </div>
            <div id="watchlist" className="watchlist-items">
              {/* Ticker items injected here */}
            </div>
            <div id="add-ticker-row" style={{ display: 'none', padding: '6px 10px', borderTop: '1px solid var(--cyber-border)' }}>
              <input type="text" id="add-ticker-input" placeholder="Enter symbol" 
                     style={{ width: '100%', padding: '6px 8px', background: 'var(--cyber-bg-card)', border: '1px solid var(--cyber-border)', color: 'var(--cyber-text)', borderRadius: '4px', fontSize: '12px' }} />
            </div>
          </div>

          {/* Center Chart */}
          <div className="center-panel">
            {/* Chart Toolbar */}
            <div id="chart-toolbar">
              {/* Toolbar content will be loaded by JavaScript */}
            </div>

            <div id="chart-container"></div>
          </div>

          {/* Right Trade Panel */}
          <div className="trade-panel">
            {/* Trade panel content will be loaded by JavaScript */}
          </div>
        </div>

        {/* In-app Calendar Overlay (loads mycalendar-main/dist) */}
        <div id="calendar-overlay" style={{ display: 'none' }}>
          <iframe id="calendar-frame" src="../mycalendar-main/dist/index.html"></iframe>
        </div>

        {/* Console removed for performance optimization */}

      </div>

      {/* Load scripts after DOM - order matters! */}
      <script src="https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"></script>
      <script src="/js/electron-shim.js"></script>
      <script src="/js/webull-rsa-browser.js"></script>
      <script src="/js/webull-api-browser.js"></script>
      <script src="/js/polygon-api-browser.js"></script>
      <script src="/js/effective-delta-engine.js"></script>
      <script src="/js/chart.js"></script>
      <script src="/js/chart-tools.js"></script>
      <script src="/js/trade-logic.js"></script>
      <script src="/js/slippage-exit-engine.js"></script>
      <script src="/js/option-fetcher-browser.js"></script>
      <script src="/js/webull-candles-poller-browser.js"></script>
      <script src="/js/app-browser.js"></script>
    </>
  );
}

