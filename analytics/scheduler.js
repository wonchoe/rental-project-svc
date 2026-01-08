/**
 * Cloudflare Analytics Scheduler
 * Автоматичний збір аналітики кожні N хвилин
 * 
 * Використання:
 *   node scheduler.js              # За замовчуванням кожні 5 хвилин
 *   node scheduler.js --interval=10  # Кожні 10 хвилин
 *   node scheduler.js --once        # Виконати один раз і вийти
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

// ==================== КОНФІГУРАЦІЯ ====================

const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const CLOUDFLARE_API_KEY_2 = process.env.CLOUDFLARE_API_KEY_2;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const ACCOUNT_ID_2 = process.env.ACCOUNT_ID_2;

const API_BASE = 'https://api.cloudflare.com/client/v4';

// Інтервал за замовчуванням (хвилини)
const DEFAULT_INTERVAL = 5;

// MySQL конфігурація
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE || 'cloudflare',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// ==================== УТИЛІТИ ====================

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'info': '📊',
    'success': '✅',
    'error': '❌',
    'warn': '⚠️',
    'start': '🚀'
  }[type] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function getApiKeyForAccount(accountId) {
  if (accountId === ACCOUNT_ID_2 && CLOUDFLARE_API_KEY_2) return CLOUDFLARE_API_KEY_2;
  return CLOUDFLARE_API_KEY;
}

function getHeaders(accountId) {
  const apiKey = getApiKeyForAccount(accountId);
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

function toMySQLDate(isoDate) {
  if (!isoDate) return null;
  try {
    const date = new Date(isoDate);
    return date.toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== CLOUDFLARE API ====================

async function getZonesForAccount(accountId) {
  try {
    let page = 1;
    let allZones = [];
    while (true) {
      const response = await fetch(`${API_BASE}/zones?account.id=${accountId}&per_page=50&page=${page}`, {
        headers: getHeaders(accountId)
      });
      const data = await response.json();
      
      if (!data.success) {
        log(`Помилка отримання зон для ${accountId}: ${JSON.stringify(data.errors)}`, 'error');
        break;
      }
      
      const batch = data.result || [];
      allZones = allZones.concat(batch);
      log(`Отримано ${batch.length} зон (сторінка ${page}) для ${accountId}`);
      if (batch.length < 50) break;
      page += 1;
    }
    return allZones;
  } catch (error) {
    log(`Помилка запиту зон: ${error.message}`, 'error');
    return [];
  }
}

async function getAllZones() {
  const accounts = [
    { id: ACCOUNT_ID, name: 'Account 1' },
    { id: ACCOUNT_ID_2, name: 'Account 2' }
  ].filter(acc => acc.id);

  let allZones = [];
  
  for (const account of accounts) {
    const zones = await getZonesForAccount(account.id);
    zones.forEach(zone => zone._accountId = account.id);
    allZones = allZones.concat(zones);
  }
  
  return allZones;
}

// GraphQL запит для аналітики по годинах (для Free плану)
async function getZoneAnalyticsHourly(zoneId, accountId, hours = 1) {
  const now = new Date();
  // Округлюємо до початку поточної години
  now.setMinutes(0, 0, 0);
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  
  const query = `
    query {
      viewer {
        zones(filter: { zoneTag: "${zoneId}" }) {
          httpRequests1hGroups(
            limit: ${hours}
            filter: { 
              datetime_geq: "${start.toISOString()}"
              datetime_lt: "${now.toISOString()}"
            }
            orderBy: [datetime_DESC]
          ) {
            dimensions {
              datetime
            }
            sum {
              requests
              pageViews
              bytes
              cachedBytes
              threats
              encryptedRequests
              countryMap {
                clientCountryName
                requests
                threats
                bytes
              }
              responseStatusMap {
                edgeResponseStatus
                requests
              }
            }
            uniq {
              uniques
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: getHeaders(accountId),
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (data.errors) {
      return null;
    }

    const zones = data.data?.viewer?.zones;
    if (!zones || zones.length === 0 || !zones[0].httpRequests1hGroups) {
      return null;
    }

    const hourlyData = zones[0].httpRequests1hGroups;
    
    if (hourlyData.length === 0) {
      return null;
    }

    // Беремо останню годину
    const latestHour = hourlyData[0];
    
    const countries = {};
    for (const country of (latestHour.sum.countryMap || [])) {
      countries[country.clientCountryName] = {
        requests: country.requests || 0,
        threats: country.threats || 0,
        bytes: country.bytes || 0
      };
    }

    const responseStatus = {};
    for (const status of (latestHour.sum.responseStatusMap || [])) {
      const statusGroup = Math.floor(status.edgeResponseStatus / 100) + 'xx';
      responseStatus[statusGroup] = (responseStatus[statusGroup] || 0) + status.requests;
    }

    return {
      datetime: latestHour.dimensions.datetime,
      requests: latestHour.sum.requests || 0,
      pageViews: latestHour.sum.pageViews || 0,
      bytes: latestHour.sum.bytes || 0,
      cachedBytes: latestHour.sum.cachedBytes || 0,
      threats: latestHour.sum.threats || 0,
      encryptedRequests: latestHour.sum.encryptedRequests || 0,
      uniqueVisitors: latestHour.uniq.uniques || 0,
      countries,
      responseStatus
    };
  } catch (error) {
    log(`Помилка GraphQL: ${error.message}`, 'error');
    return null;
  }
}

// ==================== DATABASE ====================

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

async function initSchema(connection) {
  // Таблиця для погодинної аналітики
  await connection.query(`
    CREATE TABLE IF NOT EXISTS cf_analytics_hourly (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zone_id VARCHAR(64) NOT NULL,
      zone_name VARCHAR(255),
      hour_datetime DATETIME NOT NULL,
      
      unique_visitors INT DEFAULT 0,
      page_views INT DEFAULT 0,
      requests INT DEFAULT 0,
      
      bandwidth_bytes BIGINT DEFAULT 0,
      cached_bytes BIGINT DEFAULT 0,
      
      threats INT DEFAULT 0,
      encrypted_requests INT DEFAULT 0,
      
      status_1xx INT DEFAULT 0,
      status_2xx INT DEFAULT 0,
      status_3xx INT DEFAULT 0,
      status_4xx INT DEFAULT 0,
      status_5xx INT DEFAULT 0,
      
      top_countries JSON,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_zone_hour (zone_id, hour_datetime),
      INDEX idx_zone_time (zone_id, hour_datetime),
      INDEX idx_hour (hour_datetime)
    );
  `);

  // Таблиця для логування запусків scheduler
  await connection.query(`
    CREATE TABLE IF NOT EXISTS cf_scheduler_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      zones_processed INT DEFAULT 0,
      total_requests INT DEFAULT 0,
      total_visitors INT DEFAULT 0,
      duration_ms INT DEFAULT 0,
      status ENUM('success', 'partial', 'failed') DEFAULT 'success',
      error_message TEXT
    );
  `);
}

async function saveRealtimeAnalytics(connection, zoneId, zoneName, stats) {
  if (!stats) return;

  const topCountries = Object.entries(stats.countries)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 10);

  // Перевіряємо чи вже є запис за цю годину
  const hourDatetime = toMySQLDate(stats.datetime);
  
  const [existing] = await connection.query(
    'SELECT id FROM cf_analytics_hourly WHERE zone_id = ? AND hour_datetime = ?',
    [zoneId, hourDatetime]
  );

  if (existing.length > 0) {
    // Оновлюємо існуючий запис
    await connection.query(`
      UPDATE cf_analytics_hourly SET
        unique_visitors = ?,
        page_views = ?,
        requests = ?,
        bandwidth_bytes = ?,
        cached_bytes = ?,
        threats = ?,
        encrypted_requests = ?,
        status_1xx = ?,
        status_2xx = ?,
        status_3xx = ?,
        status_4xx = ?,
        status_5xx = ?,
        top_countries = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [
      stats.uniqueVisitors || 0,
      stats.pageViews || 0,
      stats.requests || 0,
      stats.bytes || 0,
      stats.cachedBytes || 0,
      stats.threats || 0,
      stats.encryptedRequests || 0,
      stats.responseStatus?.['1xx'] || 0,
      stats.responseStatus?.['2xx'] || 0,
      stats.responseStatus?.['3xx'] || 0,
      stats.responseStatus?.['4xx'] || 0,
      stats.responseStatus?.['5xx'] || 0,
      JSON.stringify(topCountries),
      existing[0].id
    ]);
    return 'updated';
  }

  // Вставляємо новий запис
  await connection.query(`
    INSERT INTO cf_analytics_hourly (
      zone_id, zone_name, hour_datetime,
      unique_visitors, page_views, requests,
      bandwidth_bytes, cached_bytes,
      threats, encrypted_requests,
      status_1xx, status_2xx, status_3xx, status_4xx, status_5xx,
      top_countries
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    zoneId,
    zoneName,
    hourDatetime,
    stats.uniqueVisitors || 0,
    stats.pageViews || 0,
    stats.requests || 0,
    stats.bytes || 0,
    stats.cachedBytes || 0,
    stats.threats || 0,
    stats.encryptedRequests || 0,
    stats.responseStatus?.['1xx'] || 0,
    stats.responseStatus?.['2xx'] || 0,
    stats.responseStatus?.['3xx'] || 0,
    stats.responseStatus?.['4xx'] || 0,
    stats.responseStatus?.['5xx'] || 0,
    JSON.stringify(topCountries)
  ]);
  return 'inserted';
}

// ==================== ГОЛОВНА ЛОГІКА ====================

async function collectAnalytics(intervalMinutes) {
  const startTime = Date.now();
  let zonesProcessed = 0;
  let totalRequests = 0;
  let totalVisitors = 0;
  
  try {
    const pool = await getPool();
    const connection = await pool.getConnection();
    
    try {
      // Ініціалізуємо схему при першому запуску
      await initSchema(connection);
      
      // Отримуємо зони
      const zones = await getAllZones();
      
      if (zones.length === 0) {
        log('Немає зон для обробки', 'warn');
        return;
      }

      log(`Збір погодинної аналітики для ${zones.length} зон`, 'start');

      for (const zone of zones) {
        try {
          const stats = await getZoneAnalyticsHourly(zone.id, zone._accountId, 1);
          
          if (stats && stats.requests > 0) {
            const result = await saveRealtimeAnalytics(connection, zone.id, zone.name, stats);
            totalRequests += stats.requests;
            totalVisitors += stats.uniqueVisitors;
            zonesProcessed++;
            
            const hour = new Date(stats.datetime).toISOString().slice(11, 16);
            log(`${zone.name} [${hour}]: ${stats.requests.toLocaleString()} req, ${stats.uniqueVisitors.toLocaleString()} visitors, ${formatBytes(stats.bytes)} (${result})`);
          } else {
            log(`${zone.name}: немає даних за цю годину (пропущено)`, 'warn');
          }
        } catch (error) {
          log(`Помилка для ${zone.name}: ${error.message}`, 'error');
        }
        
        // Невелика затримка між запитами
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const duration = Date.now() - startTime;
      
      // Логуємо запуск
      await connection.query(`
        INSERT INTO cf_scheduler_log (zones_processed, total_requests, total_visitors, duration_ms, status)
        VALUES (?, ?, ?, ?, 'success')
      `, [zonesProcessed, totalRequests, totalVisitors, duration]);

      log(`Завершено: ${zonesProcessed} зон, ${totalRequests.toLocaleString()} запитів, ${totalVisitors.toLocaleString()} відвідувачів (${duration}ms)`, 'success');
      
    } finally {
      connection.release();
    }
  } catch (error) {
    log(`Критична помилка: ${error.message}`, 'error');
    
    try {
      const pool = await getPool();
      await pool.query(`
        INSERT INTO cf_scheduler_log (zones_processed, total_requests, total_visitors, duration_ms, status, error_message)
        VALUES (?, ?, ?, ?, 'failed', ?)
      `, [zonesProcessed, totalRequests, totalVisitors, Date.now() - startTime, error.message]);
    } catch {}
  }
}

// ==================== SCHEDULER ====================

function parseArgs() {
  const args = process.argv.slice(2);
  let interval = DEFAULT_INTERVAL;
  let once = false;

  for (const arg of args) {
    if (arg.startsWith('--interval=')) {
      interval = parseInt(arg.split('=')[1], 10) || DEFAULT_INTERVAL;
    }
    if (arg === '--once') {
      once = true;
    }
  }

  return { interval, once };
}

async function startScheduler() {
  const { interval, once } = parseArgs();
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        CLOUDFLARE ANALYTICS SCHEDULER                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`📅 Інтервал: ${interval} хвилин`);
  console.log(`🔄 Режим: ${once ? 'Один раз' : 'Безперервний'}`);
  console.log('');

  // Перший запуск одразу
  await collectAnalytics(interval);

  if (once) {
    log('Режим --once: завершення роботи', 'info');
    process.exit(0);
  }

  // Запускаємо по інтервалу
  const intervalMs = interval * 60 * 1000;
  
  log(`Наступний запуск через ${interval} хвилин...`, 'info');
  
  setInterval(async () => {
    await collectAnalytics(interval);
    log(`Наступний запуск через ${interval} хвилин...`, 'info');
  }, intervalMs);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    log('Отримано SIGINT, завершення...', 'warn');
    if (pool) {
      await pool.end();
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('Отримано SIGTERM, завершення...', 'warn');
    if (pool) {
      await pool.end();
    }
    process.exit(0);
  });
}

// Запуск
startScheduler().catch(error => {
  log(`Фатальна помилка: ${error.message}`, 'error');
  process.exit(1);
});
