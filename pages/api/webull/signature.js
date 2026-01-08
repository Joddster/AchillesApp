const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

// ⭐ CORRECT SECRET KEY from webullcore.txt
const SECRET_KEY = 'IxndllhUtGX5c1wC8xXp6YsqgNHLbaUz';

function generateSignature(method, path, queryParams = {}, body = null) {
  const sortedParams = Object.keys(queryParams)
    .sort()
    .map(k => `${k}=${queryParams[k]}`)
    .join('&');

  const pathWithParams = sortedParams ? `${path}?${sortedParams}` : path;
  const bodyStr = body ? JSON.stringify(body) : '';
  
  const signatureString = `${method}\n${pathWithParams}\n${bodyStr}`;
  
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(signatureString);
  return hmac.digest('hex');
}

function makeWebullRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      
      res.on('data', chunk => chunks.push(chunk));
      
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        
        // Handle gzip encoding
        if (res.headers['content-encoding'] === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) {
              reject(new Error(`Gzip decode error: ${err.message}`));
            } else {
              try {
                const json = JSON.parse(decoded.toString());
                resolve({ status: res.statusCode, data: json, headers: res.headers });
              } catch (e) {
                resolve({ status: res.statusCode, data: decoded.toString(), headers: res.headers });
              }
            }
          });
        } else {
          try {
            const json = JSON.parse(buffer.toString());
            resolve({ status: res.statusCode, data: json, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, data: buffer.toString(), headers: res.headers });
          }
        }
      });
    });
    
    req.on('error', reject);
    
    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      method, 
      path, 
      headers, 
      queryParams, 
      body 
    } = req.body;

    // Generate signature
    const signature = generateSignature(method, path, queryParams || {}, body);

    // Build request headers
    const requestHeaders = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...headers,
      'x-signature': signature
    };

    // Build full path with query params
    let fullPath = path;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = Object.keys(queryParams)
        .map(k => `${k}=${encodeURIComponent(queryParams[k])}`)
        .join('&');
      fullPath = `${path}?${qs}`;
    }

    // Make request to Webull
    const options = {
      hostname: 'tradeapi.webullfintech.com',
      port: 443,
      path: fullPath,
      method: method,
      headers: requestHeaders
    };

    const postData = body ? JSON.stringify(body) : null;
    const response = await makeWebullRequest(options, postData);

    return res.status(response.status).json(response.data);

  } catch (error) {
    console.error('Webull API Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
}

