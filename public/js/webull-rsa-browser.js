// Browser-compatible RSA encryption for Webull
// Uses API endpoint for actual encryption since Web Crypto API doesn't support RSA PKCS1 padding

class WebullRSA {
    constructor() {
        this.publicKey = null; // Not needed in browser - we use API endpoint
    }

    async encrypt(plaintext) {
        try {
            // Call server-side API for RSA encryption
            const response = await fetch('/api/webull/rsa-encrypt', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plaintext })
            });

            if (!response.ok) {
                throw new Error(`RSA encryption failed: ${response.status}`);
            }

            const data = await response.json();
            return data.encrypted;

        } catch (error) {
            console.error('RSA Encryption Error:', error);
            throw error;
        }
    }
}

// Make available globally
if (typeof window !== 'undefined') {
    window.WebullRSA = WebullRSA;
}

