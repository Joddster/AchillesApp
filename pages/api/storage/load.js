// Simple key-value storage API for server-side persistence
const storage = new Map();

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { key } = req.query;

    if (!key) {
      return res.status(400).json({ error: 'Missing key' });
    }

    const value = storage.get(key);

    if (value === undefined) {
      return res.status(404).json({ error: 'Key not found' });
    }

    return res.status(200).json({ value });

  } catch (error) {
    console.error('Storage Load Error:', error);
    return res.status(500).json({ 
      error: 'Storage failed', 
      message: error.message 
    });
  }
}

