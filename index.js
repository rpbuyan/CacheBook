// axios.defaults.proxy = false;

const express = require('express');
const { createClient } = require('redis');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = process.env || 3600; // Cache TTL in seconds (used default value)

// Setup Redis client and connect to Redis server
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

(async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis');
    }

    catch (err) {
        console.error('Error connecting to Redis: ', err);
    }
})

// Middleware to parse JSON requests
const cacheMetrics = {
    hits: 0,
    misses: 0
};

app.use(express.json());

app.get('/api/books/:isbn', async (req, res) => {
  const { isbn } = req.params;
  const cacheKey = `book:${isbn}`;
  
  try {
    // Try to get data from cache
    const cachedData = await redisClient.get(cacheKey);
    
    if (cachedData) {
      // Cache hit
      cacheMetrics.hits++;
      console.log(`Cache HIT for ${cacheKey}`);
      return res.json({
        source: 'cache',
        data: JSON.parse(cachedData)
      });
    }
    
    // Cache miss, fetch from API
    cacheMetrics.misses++;
    console.log(`Cache MISS for ${cacheKey}`);
    
    // Timeout just in case the API is slow
    const apiUrl = 'https://openlibrary.org/isbn/' + isbn + '.json';
    console.log('Fetching from API: ', apiUrl);

    const response = await axios.get(apiUrl, {
        timeout: 10000,
        headers: {
            'User-Agent': 'CacheBook/1.0'
        }
    });

    const bookData = response.data;
    
    // Store in cache with TTL
    await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(bookData));
    
    return res.json({
      source: 'api',
      data: bookData
    });
  } catch (error) {
    console.error('Error fetching book data:', {
        message: error.message,
        code: error.code, 
        reponseStatus: error.response?.status, 
        responseData: error.response?.data
    });

    if (error.code === 'ECCONREFUSED') {
        return res.status(503).json({
            error: "Cannot connect to Open Library API. Please try again later.",
            details: "Connection refused"
        });
    }
    
    return res.status(error.response?.status || 500).json({
        error: "Failed to fetch book data",
        details: error.message
    });
  }
});

// Get book by title (using search)
app.get('/api/books', async (req, res) => {
  const { title } = req.query;
  
  if (!title) {
    return res.status(400).json({ error: 'Title query parameter is required' });
  }
  
  const cacheKey = `search:${title.toLowerCase()}`;
  
  try {
    // Try to get data from cache
    const cachedData = await redisClient.get(cacheKey);
    
    if (cachedData) {
      // Cache hit
      cacheMetrics.hits++;
      console.log(`Cache HIT for ${cacheKey}`);
      return res.json({
        source: 'cache',
        data: JSON.parse(cachedData)
      });
    }
    
    // Cache miss, fetch from API
    cacheMetrics.misses++;
    console.log(`Cache MISS for ${cacheKey}`);
    
    const response = await axios.get(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}`);
    const searchResults = response.data;
    
    // Store in cache with TTL
    await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(searchResults));
    
    return res.json({
      source: 'api',
      data: searchResults
    });
  } catch (error) {
    console.error('Error searching books:', error.message);
    res.status(500).json({ error: 'Failed to search books' });
  }
});

// Manually invalidate cache for a specific ISBN
app.delete('/api/cache/books/:isbn', async (req, res) => {
  const { isbn } = req.params;
  const cacheKey = `book:${isbn}`;
  
  try {
    await redisClient.del(cacheKey);
    res.json({ message: `Cache for ${cacheKey} has been invalidated` });
  } catch (error) {
    console.error('Error invalidating cache:', error.message);
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

// Get cache metrics
app.get('/api/metrics', (req, res) => {
  const total = cacheMetrics.hits + cacheMetrics.misses;
  const hitRate = total > 0 ? (cacheMetrics.hits / total) * 100 : 0;
  
  res.json({
    hits: cacheMetrics.hits,
    misses: cacheMetrics.misses,
    total,
    hitRate: `${hitRate.toFixed(2)}%`
  });
});

app.listen(PORT, () => {
    console.log('Server running on port %d', PORT);
    console.log('Cache TTL set to %d seconds', CACHE_TTL);
})