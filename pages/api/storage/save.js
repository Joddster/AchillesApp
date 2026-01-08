// Simple key-value storage API for server-side persistence
// In production, you'd want to use a database like Vercel KV or Upstash
// For now, we'll use environment variables or in-memory storage

const storage = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { key, value } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'Missing key' });
    }

    // Store in memory (ephemeral - resets on function restart)
    // For production, use Vercel KV, Upstash, or another persistence layer
    storage.set(key, value);

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Storage Save Error:', error);
    return res.status(500).json({ 
      error: 'Storage failed', 
      message: error.message 
    });
  }
}

