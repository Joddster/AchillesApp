const crypto = require('crypto');

// Webull's RSA public key (from their API)
const WEBULL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCnAXCdvzPjg7fiUFvQxhVHkqL
aKfZqmgSgAUpEe4VY5FzBjyZUgpKGrXcZ7u+xLPfCdXU8XXIYI9ELqjH7qHe5h1z
Mzq7YBvYKW5CXW0KqHQVwgPLBmN3N3RYD9dFqvE+RRMKmVZNVL0VZAF8WLLTwMkU
BwIDAQAB
-----END PUBLIC KEY-----`;

function rsaEncrypt(plaintext) {
  const buffer = Buffer.from(plaintext, 'utf8');
  const encrypted = crypto.publicEncrypt(
    {
      key: WEBULL_PUBLIC_KEY,
      padding: crypto.constants.RSA_PKCS1_PADDING
    },
    buffer
  );
  return encrypted.toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plaintext } = req.body;

    if (!plaintext) {
      return res.status(400).json({ error: 'Missing plaintext' });
    }

    const encrypted = rsaEncrypt(plaintext);
    return res.status(200).json({ encrypted });

  } catch (error) {
    console.error('RSA Encryption Error:', error);
    return res.status(500).json({ 
      error: 'Encryption failed', 
      message: error.message 
    });
  }
}

