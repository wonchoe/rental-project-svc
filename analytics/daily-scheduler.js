/**
 * Cloudflare Daily Analytics Scheduler
 * Збір щоденної аналітики раз на годину
 * 
 * - Оновлює дані за сьогодні та вчора (UTC)
 * - Cloudflare використовує UTC timezone
 * - День змінюється о 00:00 UTC
 * 
 * Використання:
 *   node daily-scheduler.js              # Кожну годину
 *   node daily-scheduler.js --once       # Один раз
 *   node daily-scheduler.js --backfill=7 # Заповнити останні 7 днів
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

// ==================== КОНФІГУРАЦІЯ ====================

const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const CLOUDFLARE_API_KEY_2 = process.env.CLOUDFLARE_API_KEY_2;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const ACCOUNT_ID_2 = process.env.ACCOUNT_ID_2;

const API_BASE = 'https://api.cloudflare.com/client/v4';

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
    'start': '🚀',
    'update': '🔄'
  }[type] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function getHeaders(apiKey = CLOUDFLARE_API_KEY) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(num) {
  return (num || 0).toLocaleString('uk-UA');
}

// Отримати дату в форматі YYYY-MM-DD (UTC)
function getDateUTC(daysOffset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysOffset);
  return date.toISOString().split('T')[0];
}

// ==================== CLOUDFLARE API ====================

async function getZonesForAccount(accountId, apiKey) {
  try {
    const response = await fetch(`${API_BASE}/zones?account.id=${accountId}&per_page=50`, {
      headers: getHeaders(apiKey)
    });
    const data = await response.json();
    
    if (!data.success) {
      log(`Помилка отримання зон для ${accountId}: ${JSON.stringify(data.errors)}`, 'error');
      return [];
    }
    
    return data.result;
  } catch (error) {
    log(`Помилка запиту зон: ${error.message}`, 'error');
    return [];
  }
}

async function getAllZones() {
  // Отримуємо зони з бази даних (обидва аккаунти)
  try {
    const pool = await getPool();
    const [zones] = await pool.execute(
      'SELECT zone_id, name, status FROM cf_zones WHERE status = ? ORDER BY name',
      ['active']
    );
    
    log(`Знайдено ${zones.length} активних зон в БД`, 'info');
    
    return zones.map(zone => ({
      id: zone.zone_id,  // Реальний Cloudflare zone ID
      name: zone.name,
      status: zone.status
    }));
  } catch (error) {
    log(`Помилка отримання зон з БД: ${error.message}`, 'error');
    return [];
  }
}

async function getAllZonesFromAPI() {
  // Отримуємо зони з обох акаунтів використовуючи відповідні токени
  const accounts = [
    { id: ACCOUNT_ID, apiKey: CLOUDFLARE_API_KEY, name: 'Account 1' },
    { id: ACCOUNT_ID_2, apiKey: CLOUDFLARE_API_KEY_2, name: 'Account 2' }
  ].filter(acc => acc.id && acc.apiKey);

  let allZones = [];
  
  for (const account of accounts) {
    const zones = await getZonesForAccount(account.id, account.apiKey);
    log(`${account.name} (${account.id.substring(0, 8)}...): ${zones.length} зон`, 'info');
    zones.forEach(zone => zone._accountId = account.id);
    allZones = allZones.concat(zones);
  }
  
  return allZones;
}

// Отримати щоденну аналітику для зони за кілька днів
async function getZoneDailyAnalytics(zoneId, days = 2) {
  const today = getDateUTC(0);
  const startDate = getDateUTC(-days + 1);
  
  const query = `
    query {
      viewer {
        zones(filter: { zoneTag: "${zoneId}" }) {
          httpRequests1dGroups(
            limit: ${days}
            filter: { 
              date_geq: "${startDate}"
              date_leq: "${today}"
            }
            orderBy: [date_DESC]
          ) {
            dimensions {
              date
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
              contentTypeMap {
                edgeResponseContentTypeName
                requests
                bytes
              }
              browserMap {
                uaBrowserFamily
                pageViews
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
      headers: getHeaders(),
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (data.errors) {
      log(`GraphQL помилка: ${JSON.stringify(data.errors)}`, 'error');
      return [];
    }

    const zones = data.data?.viewer?.zones;
    if (!zones || zones.length === 0 || !zones[0].httpRequests1dGroups) {
      return [];
    }

    return zones[0].httpRequests1dGroups.map(day => {
      const responseStatus = {};
      for (const status of (day.sum.responseStatusMap || [])) {
        const statusGroup = Math.floor(status.edgeResponseStatus / 100) + 'xx';
        responseStatus[statusGroup] = (responseStatus[statusGroup] || 0) + status.requests;
      }

      const countries = (day.sum.countryMap || [])
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 20);

      const browsers = (day.sum.browserMap || [])
        .sort((a, b) => b.pageViews - a.pageViews)
        .slice(0, 10);

      const contentTypes = (day.sum.contentTypeMap || [])
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 10);

      return {
        date: day.dimensions.date,
        requests: day.sum.requests || 0,
        pageViews: day.sum.pageViews || 0,
        uniqueVisitors: day.uniq.uniques || 0,
        bandwidth: day.sum.bytes || 0,
        cachedBandwidth: day.sum.cachedBytes || 0,
        threats: day.sum.threats || 0,
        encryptedRequests: day.sum.encryptedRequests || 0,
        responseStatus,
        countries,
        browsers,
        contentTypes
      };
    });
  } catch (error) {
    log(`Помилка запиту: ${error.message}`, 'error');
    return [];
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

// Синхронізація зон з Cloudflare API в базу даних
async function syncZonesWithDatabase() {
  try {
    const pool = await getPool();
    const connection = await pool.getConnection();
    
    try {
      // Отримуємо зони з API
      const apiZones = await getAllZonesFromAPI();
      
      if (apiZones.length === 0) {
        log('Не вдалося отримати зони з Cloudflare API', 'warn');
        return;
      }
      
      log(`Отримано ${apiZones.length} зон з Cloudflare API`, 'info');
      
      // Отримуємо існуючі зони з БД
      const [existingZones] = await connection.execute(
        'SELECT zone_id FROM cf_zones'
      );
      const existingZoneIds = new Set(existingZones.map(z => z.zone_id));
      
      // Додаємо нові зони
      let addedCount = 0;
      for (const zone of apiZones) {
        if (!existingZoneIds.has(zone.id)) {
          await connection.execute(
            `INSERT INTO cf_zones (zone_id, name, status, account_id, created_at, updated_at) 
             VALUES (?, ?, ?, ?, NOW(), NOW())`,
            [zone.id, zone.name, zone.status, zone._accountId || '']
          );
          log(`➕ Додано нову зону: ${zone.name}`, 'success');
          addedCount++;
        }
      }
      
      if (addedCount > 0) {
        log(`Додано ${addedCount} нових зон`, 'success');
      } else {
        log('Нових зон не знайдено', 'info');
      }
      
    } finally {
      connection.release();
    }
  } catch (error) {
    log(`Помилка синхронізації зон: ${error.message}`, 'error');
  }
}

async function saveDailyAnalytics(connection, zoneId, zoneName, stats) {
  if (!stats) return 'skipped';

  const sql = `
    INSERT INTO cf_analytics_daily (
      zone_id, date, unique_visitors, page_views, requests,
      bandwidth_bytes, cached_bytes, uncached_bytes,
      threats, encrypted_requests, unencrypted_requests,
      status_1xx, status_2xx, status_3xx, status_4xx, status_5xx,
      content_type_breakdown, browser_breakdown
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      unique_visitors = VALUES(unique_visitors),
      page_views = VALUES(page_views),
      requests = VALUES(requests),
      bandwidth_bytes = VALUES(bandwidth_bytes),
      cached_bytes = VALUES(cached_bytes),
      uncached_bytes = VALUES(uncached_bytes),
      threats = VALUES(threats),
      encrypted_requests = VALUES(encrypted_requests),
      unencrypted_requests = VALUES(unencrypted_requests),
      status_1xx = VALUES(status_1xx),
      status_2xx = VALUES(status_2xx),
      status_3xx = VALUES(status_3xx),
      status_4xx = VALUES(status_4xx),
      status_5xx = VALUES(status_5xx),
      content_type_breakdown = VALUES(content_type_breakdown),
      browser_breakdown = VALUES(browser_breakdown),
      updated_at = NOW()
  `;

  const [result] = await connection.query(sql, [
    zoneId,
    stats.date,
    stats.uniqueVisitors || 0,
    stats.pageViews || 0,
    stats.requests || 0,
    stats.bandwidth || 0,
    stats.cachedBandwidth || 0,
    (stats.bandwidth || 0) - (stats.cachedBandwidth || 0),
    stats.threats || 0,
    stats.encryptedRequests || 0,
    (stats.requests || 0) - (stats.encryptedRequests || 0),
    stats.responseStatus?.['1xx'] || 0,
    stats.responseStatus?.['2xx'] || 0,
    stats.responseStatus?.['3xx'] || 0,
    stats.responseStatus?.['4xx'] || 0,
    stats.responseStatus?.['5xx'] || 0,
    JSON.stringify(stats.contentTypes || []),
    JSON.stringify(stats.browsers || [])
  ]);

  return result.affectedRows > 1 ? 'updated' : 'inserted';
}

async function saveCountryStats(connection, zoneId, date, countries) {
  if (!countries || countries.length === 0) return;
  
  // Видаляємо старі записи за цей день
  await connection.query(
    'DELETE FROM cf_analytics_countries WHERE zone_id = ? AND date = ?',
    [zoneId, date]
  );
  
  // Вставляємо нові
  for (const country of countries) {
    await connection.query(`
      INSERT INTO cf_analytics_countries (zone_id, date, country_code, country_name, requests, bandwidth_bytes, threats)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      zoneId,
      date,
      country.clientCountryName?.substring(0, 10) || 'XX',
      country.clientCountryName || 'Unknown',
      country.requests || 0,
      country.bytes || 0,
      country.threats || 0
    ]);
  }
}

// ==================== ГОЛОВНА ЛОГІКА ====================

async function collectDailyAnalytics(days = 2) {
  const startTime = Date.now();
  let zonesProcessed = 0;
  let daysProcessed = 0;
  
  try {
    const pool = await getPool();
    const connection = await pool.getConnection();
    
    try {
      const zones = await getAllZones();
      
      if (zones.length === 0) {
        log('Немає зон для обробки', 'warn');
        return;
      }

      const today = getDateUTC(0);
      const yesterday = getDateUTC(-1);
      
      log(`Збір щоденної аналітики для ${zones.length} зон (${days} днів)`, 'start');
      log(`Сьогодні (UTC): ${today}, Вчора: ${yesterday}`, 'info');

      for (const zone of zones) {
        try {
          const dailyStats = await getZoneDailyAnalytics(zone.id, days);
          
          if (dailyStats.length === 0) {
            continue;
          }

          for (const dayStats of dailyStats) {
            const result = await saveDailyAnalytics(connection, zone.id, zone.name, dayStats);
            await saveCountryStats(connection, zone.id, dayStats.date, dayStats.countries);
            
            const isToday = dayStats.date === today;
            const label = isToday ? '📅 сьогодні' : '📆 вчора';
            
            log(`${zone.name} [${dayStats.date}] ${label}: ${formatNumber(dayStats.requests)} req, ${formatNumber(dayStats.uniqueVisitors)} visitors, ${formatBytes(dayStats.bandwidth)} (${result})`, 'update');
            
            daysProcessed++;
          }
          
          zonesProcessed++;
        } catch (error) {
          log(`Помилка для ${zone.name}: ${error.message}`, 'error');
        }
        
        // Затримка між запитами (уникнення rate limit)
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      const duration = Date.now() - startTime;
      
      log(`Завершено: ${zonesProcessed} зон, ${daysProcessed} записів днів (${duration}ms)`, 'success');
      
    } finally {
      connection.release();
    }
  } catch (error) {
    log(`Критична помилка: ${error.message}`, 'error');
  }
}

// ==================== SCHEDULER ====================

function parseArgs() {
  const args = process.argv.slice(2);
  let once = false;
  let backfill = 0;

  for (const arg of args) {
    if (arg === '--once') {
      once = true;
    }
    if (arg.startsWith('--backfill=')) {
      backfill = parseInt(arg.split('=')[1], 10) || 7;
    }
  }

  return { once, backfill };
}

async function startScheduler() {
  const { once, backfill } = parseArgs();
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       CLOUDFLARE DAILY ANALYTICS SCHEDULER                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`🕐 Поточний час UTC: ${new Date().toISOString()}`);
  console.log(`📅 Сьогодні (UTC): ${getDateUTC(0)}`);
  console.log(`📆 Вчора (UTC): ${getDateUTC(-1)}`);
  console.log(`🔄 Режим: ${once ? 'Один раз' : 'Кожну годину'}`);
  if (backfill > 0) {
    console.log(`📚 Backfill: останні ${backfill} днів`);
  }
  console.log('');

  // Синхронізація зон з Cloudflare API
  log('Синхронізація зон з Cloudflare API...', 'start');
  await syncZonesWithDatabase();

  // Backfill якщо потрібно
  if (backfill > 0) {
    log(`Заповнення даних за останні ${backfill} днів...`, 'start');
    await collectDailyAnalytics(backfill);
  } else {
    // Звичайний збір (сьогодні + вчора)
    await collectDailyAnalytics(2);
  }

  if (once) {
    log('Режим --once: завершення роботи', 'info');
    if (pool) await pool.end();
    process.exit(0);
  }

  // Запускаємо кожну годину
  const HOUR = 60 * 60 * 1000;
  
  // Обчислюємо час до наступної повної години
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(5, 0, 0); // Запускаємо о :05 хв кожної години
  if (nextHour <= now) {
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  }
  const msToNextHour = nextHour - now;
  
  log(`Наступний запуск: ${nextHour.toISOString()} (через ${Math.round(msToNextHour / 60000)} хв)`, 'info');
  
  // Перший запуск о наступній повній годині
  setTimeout(async () => {
    await syncZonesWithDatabase();
    await collectDailyAnalytics(2);
    
    // Потім кожну годину
    setInterval(async () => {
      await syncZonesWithDatabase();
      await collectDailyAnalytics(2);
      
      const next = new Date();
      next.setUTCHours(next.getUTCHours() + 1);
      next.setUTCMinutes(5, 0, 0);
      log(`Наступний запуск: ${next.toISOString()}`, 'info');
    }, HOUR);
    
  }, msToNextHour);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    log('Отримано SIGINT, завершення...', 'warn');
    if (pool) await pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('Отримано SIGTERM, завершення...', 'warn');
    if (pool) await pool.end();
    process.exit(0);
  });
}

// Запуск
startScheduler().catch(error => {
  log(`Фатальна помилка: ${error.message}`, 'error');
  process.exit(1);
});
