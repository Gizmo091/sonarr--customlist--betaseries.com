require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BETASERIES_API_KEY = process.env.BETASERIES_API_KEY;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in milliseconds

// Helper function to get the correct protocol (handling reverse proxy)
function getProtocol(req) {
    // Check for X-Forwarded-Proto header first (common reverse proxy header)
    const forwardedProto = req.get('X-Forwarded-Proto');
    if (forwardedProto) {
        return forwardedProto.toLowerCase();
    }
    
    // Check for X-Forwarded-SSL header
    const forwardedSsl = req.get('X-Forwarded-SSL');
    if (forwardedSsl && forwardedSsl.toLowerCase() === 'on') {
        return 'https';
    }
    
    // Check for X-Forwarded-Port header (if 443, likely HTTPS)
    const forwardedPort = req.get('X-Forwarded-Port');
    if (forwardedPort === '443') {
        return 'https';
    }
    
    // Fall back to req.protocol
    return req.protocol;
}

function getUserConfigFile(userId) {
    return path.join(DATA_DIR, 'configs', `${userId}.json`);
}

function getUserCacheFile(userId, configId) {
    return path.join(DATA_DIR, 'cache', `${userId}_${configId}.json`);
}

// Trust reverse proxy for correct protocol detection
app.set('trust proxy', true);

app.use(express.json());

// Configure JSON pretty printing
app.set('json spaces', 2);

app.use(session({
    secret: process.env.SESSION_SECRET || 'betaseries-sonarr-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));
app.use(express.static('public'));

async function ensureDataDirectories() {
    try {
        await fs.mkdir(path.join(DATA_DIR, 'configs'), { recursive: true });
        await fs.mkdir(path.join(DATA_DIR, 'cache'), { recursive: true });
    } catch (error) {
        console.error('Failed to create data directories:', error);
    }
}

async function loadUserConfigurations(userId) {
    try {
        const configFile = getUserConfigFile(userId);
        const data = await fs.readFile(configFile, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function saveUserConfigurations(userId, configs) {
    const configFile = getUserConfigFile(userId);
    await fs.writeFile(configFile, JSON.stringify(configs, null, 2));
}

async function loadConfigCache(userId, configId) {
    try {
        const cacheFile = getUserCacheFile(userId, configId);
        const data = await fs.readFile(cacheFile, 'utf8');
        return JSON.parse(data);
    } catch {
        return null;
    }
}

async function saveConfigCache(userId, configId, data) {
    const cacheFile = getUserCacheFile(userId, configId);
    await fs.writeFile(cacheFile, JSON.stringify(data, null, 2));
}

async function getCachedData(userId, configId) {
    try {
        const cacheFile = getUserCacheFile(userId, configId);
        const stats = await fs.stat(cacheFile);
        const fileModTime = stats.mtime.getTime();
        
        // Check if cache is still valid based on file modification time
        if (fileModTime + CACHE_DURATION > Date.now()) {
            return await loadConfigCache(userId, configId);
        }
    } catch {
        // File doesn't exist or can't be accessed
    }
    
    return null;
}

async function setCachedData(userId, configId, data) {
    await saveConfigCache(userId, configId, data);
}

async function findConfigurationById(configId) {
    try {
        // Extract userId from configId format: userId_uuid
        const parts = configId.split('_');
        if (parts.length < 2) {
            return null; // Invalid format
        }
        
        const userId = parts[0];
        const configs = await loadUserConfigurations(userId);
        
        if (configs[configId]) {
            return {
                config: configs[configId],
                userId: userId
            };
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

async function fetchBetaSeriesShowsRaw(userId, status, locale = 'en') {
    const allShows = [];
    let offset = 0;
    const limit = 100; // Maximum allowed by BetaSeries API
    
    while (true) {
        const response = await axios.get('https://api.betaseries.com/shows/member', {
            params: {
                id: userId,
                status: status,
                offset: offset,
                limit: limit,
                locale: locale
            },
            headers: {
                'X-BetaSeries-Key': BETASERIES_API_KEY,
                'X-BetaSeries-Version': '3.0'
            }
        });
        
        const shows = response.data.shows || [];
        
        // If no shows returned, we've reached the end
        if (shows.length === 0) {
            break;
        }
        
        allShows.push(...shows);
        offset += limit;
        console.log(`Fetched ${shows.length} shows for ${userId}/${status} (offset: ${offset - limit}, total: ${allShows.length})`);
        // console.log('allShows',allShows);
    }
    
    console.log(`Total shows fetched for ${userId}/${status}: ${allShows.length}`);
    return allShows;
}

async function fetchBetaSeriesFavoritesRaw(userId, locale = 'en') {
    const allShows = [];
    let offset = 0;
    const limit = 100; // Maximum allowed by BetaSeries API
    
    while (true) {
        const response = await axios.get('https://api.betaseries.com/shows/favorites', {
            params: {
                id: userId,
                offset: offset,
                limit: limit,
                locale: locale
            },
            headers: {
                'X-BetaSeries-Key': BETASERIES_API_KEY,
                'X-BetaSeries-Version': '3.0'
            }
        });
        
        const shows = response.data.shows || [];
        
        // If no shows returned, we've reached the end
        if (shows.length === 0) {
            break;
        }
        
        allShows.push(...shows);
        offset += limit;
        console.log(`Fetched ${shows.length} favorite shows for ${userId} (offset: ${offset - limit}, total: ${allShows.length})`);
    }
    
    console.log(`Total favorite shows fetched for ${userId}: ${allShows.length}`);
    return allShows;
}

async function fetchBetaSeriesShows(userId, status, configId, favoritesOnly = false, locale = 'en', useCache = true) {
    try {

        // Check cache first
        if (useCache && configId) {
            const cachedData = await getCachedData(userId, configId);
            if (cachedData) {
                console.log(`Using cached data for ${userId}/${configId}`);
                return cachedData;
            }
        }
        
        // Fetch raw data from API
        const rawShows = favoritesOnly ? 
            await fetchBetaSeriesFavoritesRaw(userId, locale) : 
            await fetchBetaSeriesShowsRaw(userId, status, locale);
        
        // Transform to Sonarr format
        const sonarrList = transformToSonarrFormat(rawShows);
        
        // Save transformed data to cache
        if (configId) {
            await setCachedData(userId, configId, sonarrList);
        }
        
        return sonarrList;
    } catch (error) {
        console.error('Error fetching from BetaSeries:', error.message);
        throw error;
    }
}

function transformToSonarrFormat(shows) {
    return shows.map(show => ({
        title: show.title,
        imdb_id: show.imdb_id || null,
        poster_url: show.images?.poster || null
    })).filter(show => show.imdb_id);
}

app.get('/api/list/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await findConfigurationById(id);
        
        if (!result) {
            return res.status(404).json({ error: 'Configuration not found' });
        }
        
        const { config } = result;
        const sonarrList = await fetchBetaSeriesShows(config.userId, config.status, id, config.favoritesOnly, config.locale || 'en');
        
        res.json(sonarrList);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch shows' });
    }
});

app.post('/api/configurations', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const { status, favoritesOnly } = req.body;
        const userId = req.session.userId;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }
        
        const validStatuses = [
            'current', 'active', 'archived', 'archived_and_completed',
            'archived_and_not_started', 'completed', 'active_and_completed',
            'not_started', 'stopped'
        ];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        const configs = await loadUserConfigurations(userId);
        const id = `${userId}_${uuidv4()}`;
        
        configs[id] = {
            userId,
            status,
            favoritesOnly: Boolean(favoritesOnly),
            locale: req.session.locale || 'en',
            createdAt: new Date().toISOString()
        };
        
        await saveUserConfigurations(userId, configs);
        
        // Pre-fetch and cache the data
        try {
            await fetchBetaSeriesShows(userId, status, id, Boolean(favoritesOnly), req.session.locale || 'en');
            console.log(`Pre-fetched and cached data for ${userId}/${id}`);
        } catch (error) {
            console.error('Failed to pre-fetch data:', error);
            // Don't fail the request if pre-fetching fails
        }
        
        res.json({
            id,
            url: `${getProtocol(req)}://${req.get('host')}/api/list/${id}`
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create configuration' });
    }
});

app.get('/api/configurations', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const configs = await loadUserConfigurations(req.session.userId);
        
        const list = Object.entries(configs).map(([id, config]) => ({
            id,
            ...config,
            url: `${getProtocol(req)}://${req.get('host')}/api/list/${id}`
        }));
        
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load configurations' });
    }
});

app.delete('/api/configurations/:id', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const { id } = req.params;
        const configs = await loadUserConfigurations(req.session.userId);
        
        if (!configs[id]) {
            return res.status(404).json({ error: 'Configuration not found' });
        }
        
        delete configs[id];
        await saveUserConfigurations(req.session.userId, configs);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete configuration' });
    }
});

app.post('/api/auth', async (req, res) => {
    try {
        const { login, password } = req.body;
        
        if (!login || !password) {
            return res.status(400).json({ error: 'Login and password are required' });
        }
        
        // Hash password with MD5
        const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
        
        const response = await axios.post('https://api.betaseries.com/members/auth', {
            login,
            password: hashedPassword
        }, {
            headers: {
                'X-BetaSeries-Key': BETASERIES_API_KEY,
                'X-BetaSeries-Version': '3.0'
            }
        });
        
        if (response.data.user) {
            req.session.userId = response.data.user.id;
            req.session.login = response.data.user.login;
            
            // Get user locale
            try {
                const infoResponse = await axios.get('https://api.betaseries.com/members/infos', {
                    params: {
                        id: response.data.user.id
                    },
                    headers: {
                        'X-BetaSeries-Key': BETASERIES_API_KEY,
                        'X-BetaSeries-Version': '3.0'
                    }
                });
                
                if (infoResponse.data.member) {
                    req.session.locale = infoResponse.data.member.locale || 'en';
                }
            } catch (error) {
                console.error('Failed to get user locale:', error);
                req.session.locale = 'en'; // Default to English
            }
            
            res.json({
                userId: response.data.user.id,
                login: response.data.user.login,
                locale: req.session.locale
            });
        } else {
            res.status(401).json({ error: 'Authentication failed' });
        }
    } catch (error) {
        console.error('Auth error:', error.response?.data || error.message);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.get('/api/session', (req, res) => {
    if (req.session.userId) {
        res.json({
            authenticated: true,
            userId: req.session.userId,
            login: req.session.login,
            locale: req.session.locale || 'en'
        });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to logout' });
        }
        res.json({ success: true });
    });
});

async function getCacheStatusForUser(userId) {
    try {
        const configs = await loadUserConfigurations(userId);
        const userCache = {};
        
        for (const [configId, config] of Object.entries(configs)) {
            const cacheFile = getUserCacheFile(userId, configId);
            
            try {
                const stats = await fs.stat(cacheFile);
                const fileModTime = stats.mtime.getTime();
                const isExpired = fileModTime + CACHE_DURATION <= Date.now();
                const timeLeft = Math.max(0, (fileModTime + CACHE_DURATION - Date.now()) / 1000);
                
                userCache[configId] = {
                    status: config.status,
                    cached_at: new Date(fileModTime).toISOString(),
                    expires_in: Math.floor(timeLeft),
                    expired: isExpired
                };
            } catch (statError) {
                // File doesn't exist, no cache for this configuration
            }
        }
        
        return userCache;
    } catch (error) {
        return {};
    }
}

app.get('/api/cache', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const userCache = await getCacheStatusForUser(req.session.userId);
        res.json(userCache);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load cache' });
    }
});

app.delete('/api/cache/:configId', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const { configId } = req.params;
        const userId = req.session.userId;
        const cacheFile = getUserCacheFile(userId, configId);
        
        try {
            await fs.unlink(cacheFile);
            res.json({ success: true });
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'Cache entry not found' });
            } else {
                throw error;
            }
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear cache' });
    }
});

app.delete('/api/cache', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const userId = req.session.userId;
        const configs = await loadUserConfigurations(userId);
        
        // Delete all cache files for this user
        for (const configId of Object.keys(configs)) {
            const cacheFile = getUserCacheFile(userId, configId);
            try {
                await fs.unlink(cacheFile);
            } catch (error) {
                // Ignore if file doesn't exist
                if (error.code !== 'ENOENT') {
                    console.error(`Failed to delete cache file ${cacheFile}:`, error);
                }
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear cache' });
    }
});

app.listen(PORT, async () => {
    await ensureDataDirectories();
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
});