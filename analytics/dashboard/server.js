/**
 * Cloudflare Analytics Dashboard - API Server
 * Professional analytics visualization
 */

const fs = require('fs');
const path = require('path');

// .env is in parent directory (/app/.env), not in dashboard directory
// Try multiple paths: /app/.env, parent dir, or current dir
const possiblePaths = [
  '/app/.env',                              // Kubernetes mount path
  path.join(__dirname, '../.env'),          // Parent directory
  path.join(__dirname, '.env')              // Current directory (fallback)
];

let envPath = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    envPath = p;
    console.log(`[Config] Found .env at: ${envPath}`);
    break;
  }
}

if (!envPath) {
  console.warn(`[Config] ⚠️ .env not found in any of: ${possiblePaths.join(', ')}`);
} else {
  console.log(`[Config] Loading .env from: ${envPath}`);
  require('dotenv').config({ path: envPath });
}

const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3030;

// Use DB_HOST from .env (should contain the actual production MySQL address)
const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT || 3306;
const DB_USER = process.env.DB_USERNAME;
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_DATABASE;

if (!DB_HOST || !DB_USER || !DB_PASS || !DB_NAME) {
  console.error('[Database] ❌ Missing required environment variables:');
  console.error(`   DB_HOST: ${DB_HOST ? '✓' : '✗'}`);
  console.error(`   DB_USERNAME: ${DB_USER ? '✓' : '✗'}`);
  console.error(`   DB_PASSWORD: ${DB_PASS ? '✓' : '✗'}`);
  console.error(`   DB_DATABASE: ${DB_NAME ? '✓' : '✗'}`);
  console.error('[Config] All environment variables:');
  Object.keys(process.env).sort().forEach(key => {
    const value = key.includes('PASSWORD') || key.includes('KEY') ? '***' : process.env[key];
    if (key.startsWith('DB_') || key.includes('CLOUDFLARE') || key.includes('ACCOUNT') || key.includes('ZONE')) {
      console.error(`   ${key}: ${value}`);
    }
  });
}

console.log(`[Server] Starting on port ${PORT}`);
console.log(`[Database] Connecting to ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
console.log(`[Database] User: ${DB_USER}`);

// Database connection pool
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test database connection
pool.getConnection().then(conn => {
  console.log('[Database] ✅ Connection successful');
  conn.release();
}).catch(err => {
  console.error('[Database] ❌ Connection failed:', err.message);
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    port: PORT,
    env: {
      DB_HOST,
      DB_PORT,
      DB_USER,
      DB_NAME,
      hasPassword: !!DB_PASS,
      envFileExists: fs.existsSync(envPath)
    }
  });
});

// CORS

// ============================================
// API ENDPOINTS
// ============================================

// Get all zones
app.get('/api/zones', async (req, res) => {
  try {
    const [zones] = await pool.query(`
      SELECT 
        z.zone_id,
        z.name,
        z.status,
        z.plan_name,
        z.created_on,
        (SELECT SUM(requests) FROM cf_analytics_daily WHERE zone_id = z.zone_id) as total_requests,
        (SELECT SUM(unique_visitors) FROM cf_analytics_daily WHERE zone_id = z.zone_id) as total_visitors,
        (SELECT SUM(page_views) FROM cf_analytics_daily WHERE zone_id = z.zone_id) as total_page_views,
        (SELECT SUM(bandwidth_bytes) FROM cf_analytics_daily WHERE zone_id = z.zone_id) as total_bandwidth,
        (SELECT SUM(threats) FROM cf_analytics_daily WHERE zone_id = z.zone_id) as total_threats
      FROM cf_zones z
      ORDER BY total_requests DESC
    `);
    res.json(zones);
  } catch (err) {
    console.error('[API] /zones error:', err.message);
    console.error('[API] /zones error code:', err.code);
    console.error('[API] /zones full error:', err);
    res.status(500).json({ 
      error: err.message, 
      code: err.code,
      endpoint: '/api/zones',
      hint: err.code === 'PROTOCOL_CONNECTION_LOST' ? 'DB connection lost' : 'DB query failed'
    });
  }
});

// Dashboard overview - aggregated stats
app.get('/api/dashboard/overview', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    
    // Total stats for period
    const [totals] = await pool.query(`
      SELECT 
        COUNT(DISTINCT zone_id) as total_zones,
        SUM(unique_visitors) as total_visitors,
        SUM(page_views) as total_page_views,
        SUM(requests) as total_requests,
        SUM(bandwidth_bytes) as total_bandwidth,
        SUM(cached_bytes) as total_cached,
        SUM(threats) as total_threats,
        SUM(encrypted_requests) as total_encrypted,
        SUM(status_2xx) as total_2xx,
        SUM(status_3xx) as total_3xx,
        SUM(status_4xx) as total_4xx,
        SUM(status_5xx) as total_5xx
      FROM cf_analytics_daily
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `, [days]);

    // Today vs Yesterday comparison
    const [comparison] = await pool.query(`
      SELECT 
        date,
        SUM(unique_visitors) as visitors,
        SUM(requests) as requests,
        SUM(bandwidth_bytes) as bandwidth,
        SUM(page_views) as page_views
      FROM cf_analytics_daily
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
      GROUP BY date
      ORDER BY date DESC
      LIMIT 2
    `);

    // Top zones by traffic
    const [topZones] = await pool.query(`
      SELECT 
        z.name,
        SUM(a.requests) as requests,
        SUM(a.unique_visitors) as visitors,
        SUM(a.bandwidth_bytes) as bandwidth
      FROM cf_analytics_daily a
      JOIN cf_zones z ON z.zone_id = a.zone_id
      WHERE a.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY z.zone_id, z.name
      ORDER BY requests DESC
      LIMIT 5
    `, [days]);

    res.json({
      totals: totals[0],
      comparison,
      topZones,
      period: days
    });
  } catch (err) {
    console.error('Error fetching overview:', err);
    res.status(500).json({ error: err.message });
  }
});

// Daily trends for all zones or specific zone
app.get('/api/analytics/daily', async (req, res) => {
  try {
    const { zone_id, days = 30 } = req.query;
    
    let query = `
      SELECT 
        date,
        SUM(unique_visitors) as visitors,
        SUM(page_views) as page_views,
        SUM(requests) as requests,
        SUM(bandwidth_bytes) as bandwidth,
        SUM(cached_bytes) as cached,
        SUM(threats) as threats,
        SUM(status_2xx) as status_2xx,
        SUM(status_3xx) as status_3xx,
        SUM(status_4xx) as status_4xx,
        SUM(status_5xx) as status_5xx
      FROM cf_analytics_daily
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;
    
    const params = [days];
    
    if (zone_id) {
      query += ' AND zone_id = ?';
      params.push(zone_id);
    }
    
    query += ' GROUP BY date ORDER BY date ASC';
    
    const [data] = await pool.query(query, params);
    res.json(data);
  } catch (err) {
    console.error('Error fetching daily analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

// Hourly trends (last 24-48 hours)
app.get('/api/analytics/hourly', async (req, res) => {
  try {
    const { zone_id, hours = 48 } = req.query;
    
    let query = `
      SELECT 
        hour_datetime as datetime,
        zone_name as zone,
        unique_visitors as visitors,
        page_views,
        requests,
        bandwidth_bytes as bandwidth,
        threats
      FROM cf_analytics_hourly
      WHERE hour_datetime >= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `;
    
    const params = [hours];
    
    if (zone_id) {
      query += ' AND zone_id = ?';
      params.push(zone_id);
    }
    
    query += ' ORDER BY hour_datetime ASC';
    
    const [data] = await pool.query(query, params);
    res.json(data);
  } catch (err) {
    console.error('Error fetching hourly analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get daily trends for all zones (for trends page)
app.get('/api/trends/daily', async (req, res) => {
  try {
    let { zones, days = 7 } = req.query; // comma-separated zone IDs
    
    // Convert "all time" to a large number
    if (days === 'all' || days > 10000) {
      days = 10000; // ~27 years, should cover most data
    }
    days = parseInt(days);
    
    // Build WHERE clause for zones if provided
    let whereClause = '';
    // The first placeholder in query is the INTERVAL ? DAY, so push days first
    const params = [days];

    if (zones) {
      const zoneIds = zones.split(',');
      whereClause = `WHERE z.zone_id IN (${zoneIds.map(() => '?').join(',')})`;
      params.push(...zoneIds);
    }
    
    const query = `
      SELECT 
        z.id as zone_db_id,
        z.zone_id,
        z.name as zone_name,
        z.created_at as zone_created_at,
        d.date,
        COALESCE(d.requests, 0) as requests,
        COALESCE(d.bandwidth_bytes, 0) as bandwidth_bytes,
        COALESCE(d.unique_visitors, 0) as unique_visitors,
        COALESCE(d.page_views, 0) as page_views,
        COALESCE(d.threats, 0) as threats,
        COALESCE(d.cache_hits, 0) as cached_requests,
        COALESCE(d.cache_misses, 0) as uncached_requests,
        COALESCE(d.encrypted_requests, 0) as encrypted_requests,
        COALESCE(d.requests, 0) - COALESCE(d.encrypted_requests, 0) as unencrypted_requests
      FROM cf_zones z
      LEFT JOIN cf_analytics_daily d ON z.zone_id = d.zone_id AND d.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ${whereClause}
      ORDER BY z.name, d.date ASC
    `;
    
    const [data] = await pool.query(query, params);
    
    res.json(data);
  } catch (err) {
    console.error('Error fetching daily trends:', err);
    res.status(500).json({ error: err.message });
  }
});

// Zone details with full analytics
app.get('/api/zone/:zoneId', async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { days = 30 } = req.query;
    
    // Zone info
    const [zoneInfo] = await pool.query(
      'SELECT * FROM cf_zones WHERE zone_id = ?',
      [zoneId]
    );
    
    if (!zoneInfo.length) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Daily analytics
    const [daily] = await pool.query(`
      SELECT * FROM cf_analytics_daily 
      WHERE zone_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY date ASC
    `, [zoneId, days]);

    // Top countries
    const [countries] = await pool.query(`
      SELECT 
        country_code,
        SUM(requests) as requests,
        SUM(bandwidth_bytes) as bandwidth,
        SUM(threats) as threats
      FROM cf_analytics_countries
      WHERE zone_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY country_code
      ORDER BY requests DESC
      LIMIT 20
    `, [zoneId, days]);

    // Aggregate browser data from JSON
    const [browserData] = await pool.query(`
      SELECT browser_breakdown FROM cf_analytics_daily 
      WHERE zone_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      AND browser_breakdown IS NOT NULL
    `, [zoneId, days]);

    // Process browser data
    const browserMap = {};
    browserData.forEach(row => {
      if (row.browser_breakdown) {
        const browsers = typeof row.browser_breakdown === 'string' 
          ? JSON.parse(row.browser_breakdown) 
          : row.browser_breakdown;
        browsers.forEach(b => {
          browserMap[b.uaBrowserFamily] = (browserMap[b.uaBrowserFamily] || 0) + b.pageViews;
        });
      }
    });
    
    const browsers = Object.entries(browserMap)
      .map(([name, views]) => ({ name, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);

    // Content types aggregate
    const [contentData] = await pool.query(`
      SELECT content_type_breakdown FROM cf_analytics_daily 
      WHERE zone_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      AND content_type_breakdown IS NOT NULL
    `, [zoneId, days]);

    const contentMap = {};
    contentData.forEach(row => {
      if (row.content_type_breakdown) {
        const types = typeof row.content_type_breakdown === 'string'
          ? JSON.parse(row.content_type_breakdown)
          : row.content_type_breakdown;
        types.forEach(t => {
          if (!contentMap[t.edgeResponseContentTypeName]) {
            contentMap[t.edgeResponseContentTypeName] = { requests: 0, bytes: 0 };
          }
          contentMap[t.edgeResponseContentTypeName].requests += t.requests;
          contentMap[t.edgeResponseContentTypeName].bytes += t.bytes;
        });
      }
    });
    
    const contentTypes = Object.entries(contentMap)
      .map(([type, data]) => ({ type, ...data }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);

    res.json({
      zone: zoneInfo[0],
      daily,
      countries,
      browsers,
      contentTypes
    });
  } catch (err) {
    console.error('Error fetching zone details:', err);
    res.status(500).json({ error: err.message });
  }
});

// Country breakdown for map
app.get('/api/analytics/countries', async (req, res) => {
  try {
    const { zone_id, days = 7 } = req.query;
    
    let query = `
      SELECT 
        country_code,
        SUM(requests) as requests,
        SUM(bandwidth_bytes) as bandwidth,
        SUM(threats) as threats
      FROM cf_analytics_countries
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;
    
    const params = [days];
    
    if (zone_id) {
      query += ' AND zone_id = ?';
      params.push(zone_id);
    }
    
    query += ' GROUP BY country_code ORDER BY requests DESC';
    
    const [data] = await pool.query(query, params);
    res.json(data);
  } catch (err) {
    console.error('Error fetching countries:', err);
    res.status(500).json({ error: err.message });
  }
});

// Real-time stats (last hour comparison)
app.get('/api/analytics/realtime', async (req, res) => {
  try {
    const [current] = await pool.query(`
      SELECT 
        SUM(unique_visitors) as visitors,
        SUM(requests) as requests,
        SUM(bandwidth_bytes) as bandwidth
      FROM cf_analytics_daily
      WHERE date = CURDATE()
    `);

    const [zones] = await pool.query(`
      SELECT 
        z.name,
        a.unique_visitors as visitors,
        a.requests,
        a.bandwidth_bytes as bandwidth,
        a.threats
      FROM cf_analytics_daily a
      JOIN cf_zones z ON z.zone_id = a.zone_id
      WHERE a.date = CURDATE()
      ORDER BY a.requests DESC
    `);

    res.json({
      summary: current[0],
      zones,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error fetching realtime:', err);
    res.status(500).json({ error: err.message });
  }
});

// HTTP Status codes breakdown
app.get('/api/analytics/status-codes', async (req, res) => {
  try {
    const { zone_id, days = 7 } = req.query;
    
    let query = `
      SELECT 
        date,
        SUM(status_1xx) as s1xx,
        SUM(status_2xx) as s2xx,
        SUM(status_3xx) as s3xx,
        SUM(status_4xx) as s4xx,
        SUM(status_5xx) as s5xx
      FROM cf_analytics_daily
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;
    
    const params = [days];
    
    if (zone_id) {
      query += ' AND zone_id = ?';
      params.push(zone_id);
    }
    
    query += ' GROUP BY date ORDER BY date ASC';
    
    const [data] = await pool.query(query, params);
    res.json(data);
  } catch (err) {
    console.error('Error fetching status codes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Security/Threats overview
app.get('/api/analytics/security', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    // Threats by zone
    const [byZone] = await pool.query(`
      SELECT 
        z.name,
        SUM(a.threats) as threats,
        SUM(a.requests) as requests
      FROM cf_analytics_daily a
      JOIN cf_zones z ON z.zone_id = a.zone_id
      WHERE a.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY z.zone_id, z.name
      ORDER BY threats DESC
    `, [days]);

    // Threats by country
    const [byCountry] = await pool.query(`
      SELECT 
        country_code,
        SUM(threats) as threats,
        SUM(requests) as requests
      FROM cf_analytics_countries
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND threats > 0
      GROUP BY country_code
      ORDER BY threats DESC
      LIMIT 20
    `, [days]);

    // Threats trend
    const [trend] = await pool.query(`
      SELECT 
        date,
        SUM(threats) as threats
      FROM cf_analytics_daily
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY date
      ORDER BY date ASC
    `, [days]);

    res.json({ byZone, byCountry, trend });
  } catch (err) {
    console.error('Error fetching security:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bandwidth analysis
app.get('/api/analytics/bandwidth', async (req, res) => {
  try {
    const { zone_id, days = 7 } = req.query;
    
    let query = `
      SELECT 
        date,
        SUM(bandwidth_bytes) as total,
        SUM(cached_bytes) as cached,
        SUM(uncached_bytes) as uncached
      FROM cf_analytics_daily
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;
    
    const params = [days];
    
    if (zone_id) {
      query += ' AND zone_id = ?';
      params.push(zone_id);
    }
    
    query += ' GROUP BY date ORDER BY date ASC';
    
    const [data] = await pool.query(query, params);
    res.json(data);
  } catch (err) {
    console.error('Error fetching bandwidth:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync logs
app.get('/api/logs', async (req, res) => {
  try {
    const [logs] = await pool.query(`
      SELECT * FROM cf_scheduler_log 
      ORDER BY id DESC 
      LIMIT 50
    `);
    res.json(logs);
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     🚀 CLOUDFLARE ANALYTICS DASHBOARD                      ║
║     Running on http://localhost:${PORT}                       ║
╚════════════════════════════════════════════════════════════╝
  `);
});
