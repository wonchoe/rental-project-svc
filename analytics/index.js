require('dotenv').config();
const mysql = require('mysql2/promise');

const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const CLOUDFLARE_API_KEY_2 = process.env.CLOUDFLARE_API_KEY_2;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const ZONE_ID = process.env.ZONE_ID;
const ACCOUNT_ID_2 = process.env.ACCOUNT_ID_2;
const ZONE_ID_2 = process.env.ZONE_ID_2;

const API_BASE = 'https://api.cloudflare.com/client/v4';

// MySQL конфігурація
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  multipleStatements: true
};

const DB_NAME = process.env.DB_DATABASE || 'cloudflare';

// Отримуємо масив дат (ISO yyyy-mm-dd), включно з сьогодні
function getRecentDates(days) {
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

// Заголовки для API запитів
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

// ==================== DATABASE FUNCTIONS ====================

// Ініціалізація бази даних
async function initDatabase() {
  let connection;
  
  try {
    // Підключаємось без вибору бази
    connection = await mysql.createConnection(DB_CONFIG);
    
    // Створюємо базу якщо не існує
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✅ База даних '${DB_NAME}' готова`);
    
    // Перепідключаємось до бази
    await connection.end();
    connection = await mysql.createConnection({ ...DB_CONFIG, database: DB_NAME });
    
    // Створюємо таблиці
    await createTables(connection);
    
    return connection;
  } catch (error) {
    console.error('❌ Помилка ініціалізації БД:', error.message);
    throw error;
  }
}

// Створення таблиць
async function createTables(connection) {
  const schema = `
    -- Таблиця акаунтів Cloudflare
    CREATE TABLE IF NOT EXISTS cf_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id VARCHAR(64) UNIQUE NOT NULL,
      account_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

    -- Таблиця доменів (зон)
    CREATE TABLE IF NOT EXISTS cf_zones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zone_id VARCHAR(64) UNIQUE NOT NULL,
      account_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      status ENUM('active', 'pending', 'initializing', 'moved', 'deleted', 'deactivated') DEFAULT 'active',
      paused BOOLEAN DEFAULT FALSE,
      type ENUM('full', 'partial', 'secondary') DEFAULT 'full',
      
      -- DNS налаштування
      original_registrar VARCHAR(255),
      original_dnshost VARCHAR(255),
      name_servers JSON,
      original_name_servers JSON,
      
      -- План
      plan_id VARCHAR(64),
      plan_name VARCHAR(100),
      plan_price DECIMAL(10,2) DEFAULT 0,
      plan_currency VARCHAR(10) DEFAULT 'USD',
      plan_is_subscribed BOOLEAN DEFAULT FALSE,
      plan_can_subscribe BOOLEAN DEFAULT TRUE,
      plan_legacy_id VARCHAR(64),
      plan_externally_managed BOOLEAN DEFAULT FALSE,
      
      -- Дати
      activated_on DATETIME,
      created_on DATETIME,
      modified_on DATETIME,
      
      -- Власник
      owner_id VARCHAR(64),
      owner_type VARCHAR(50),
      owner_email VARCHAR(255),
      
      -- Права та налаштування
      permissions JSON,
      development_mode INT DEFAULT 0,
      
      -- Мета інформація
      meta JSON,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_account (account_id),
      INDEX idx_name (name),
      INDEX idx_status (status)
    );

    -- Таблиця налаштувань зон
    CREATE TABLE IF NOT EXISTS cf_zone_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zone_id VARCHAR(64) NOT NULL,
      setting_id VARCHAR(100) NOT NULL,
      value JSON,
      editable BOOLEAN DEFAULT TRUE,
      modified_on DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_zone_setting (zone_id, setting_id),
      INDEX idx_zone (zone_id)
    );

    -- Таблиця щоденної аналітики
    CREATE TABLE IF NOT EXISTS cf_analytics_daily (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zone_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      
      -- Основні метрики
      unique_visitors INT DEFAULT 0,
      page_views INT DEFAULT 0,
      requests INT DEFAULT 0,
      
      -- Трафік
      bandwidth_bytes BIGINT DEFAULT 0,
      cached_bytes BIGINT DEFAULT 0,
      uncached_bytes BIGINT DEFAULT 0,
      
      -- Безпека
      threats INT DEFAULT 0,
      threats_blocked INT DEFAULT 0,
      
      -- SSL/HTTPS метрики
      encrypted_requests INT DEFAULT 0,
      unencrypted_requests INT DEFAULT 0,
      
      -- HTTP статуси
      status_1xx INT DEFAULT 0,
      status_2xx INT DEFAULT 0,
      status_3xx INT DEFAULT 0,
      status_4xx INT DEFAULT 0,
      status_5xx INT DEFAULT 0,
      
      -- Кеш
      cache_hits INT DEFAULT 0,
      cache_misses INT DEFAULT 0,
      
      -- Контент типи (JSON)
      content_type_breakdown JSON,
      
      -- Браузери (JSON)  
      browser_breakdown JSON,
      
      -- Пристрої (JSON)
      device_breakdown JSON,
      
      -- Операційні системи (JSON)
      os_breakdown JSON,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_zone_date (zone_id, date),
      INDEX idx_zone (zone_id),
      INDEX idx_date (date)
    );

    -- Таблиця географії відвідувачів
    CREATE TABLE IF NOT EXISTS cf_analytics_countries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zone_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      country_code VARCHAR(10) NOT NULL,
      country_name VARCHAR(100),
      requests INT DEFAULT 0,
      bandwidth_bytes BIGINT DEFAULT 0,
      threats INT DEFAULT 0,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_zone_date_country (zone_id, date, country_code),
      INDEX idx_zone_date (zone_id, date),
      INDEX idx_country (country_code)
    );

    -- Таблиця загроз
    CREATE TABLE IF NOT EXISTS cf_threats (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zone_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      threat_type VARCHAR(100),
      threat_country VARCHAR(10),
      count INT DEFAULT 0,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_zone_date (zone_id, date)
    );

    -- Таблиця DNS записів
    CREATE TABLE IF NOT EXISTS cf_dns_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      record_id VARCHAR(64) UNIQUE NOT NULL,
      zone_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(20) NOT NULL,
      content TEXT,
      ttl INT DEFAULT 1,
      proxied BOOLEAN DEFAULT FALSE,
      priority INT,
      locked BOOLEAN DEFAULT FALSE,
      
      created_on DATETIME,
      modified_on DATETIME,
      
      meta JSON,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_zone (zone_id),
      INDEX idx_type (type)
    );

    -- Таблиця firewall правил
    CREATE TABLE IF NOT EXISTS cf_firewall_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      rule_id VARCHAR(64) UNIQUE NOT NULL,
      zone_id VARCHAR(64) NOT NULL,
      description TEXT,
      action VARCHAR(50),
      priority INT,
      paused BOOLEAN DEFAULT FALSE,
      expression TEXT,
      
      created_on DATETIME,
      modified_on DATETIME,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_zone (zone_id)
    );

    -- Таблиця Page Rules
    CREATE TABLE IF NOT EXISTS cf_page_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      rule_id VARCHAR(64) UNIQUE NOT NULL,
      zone_id VARCHAR(64) NOT NULL,
      targets JSON,
      actions JSON,
      status VARCHAR(20) DEFAULT 'active',
      priority INT,
      
      created_on DATETIME,
      modified_on DATETIME,
      
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_zone (zone_id)
    );

    -- Лог запусків скрипта
    CREATE TABLE IF NOT EXISTS cf_sync_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sync_type ENUM('zones', 'analytics', 'dns', 'settings', 'full') NOT NULL,
      status ENUM('started', 'completed', 'failed') DEFAULT 'started',
      zones_processed INT DEFAULT 0,
      records_inserted INT DEFAULT 0,
      records_updated INT DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL
    );
  `;

  await connection.query(schema);
  console.log('✅ Схема БД створена/перевірена');
}

// Збереження акаунту
async function saveAccount(connection, accountId, accountName = null) {
  await connection.query(`
    INSERT INTO cf_accounts (account_id, account_name)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE account_name = COALESCE(VALUES(account_name), account_name), updated_at = NOW()
  `, [accountId, accountName]);
}

// Конвертація ISO дати до MySQL формату
function toMySQLDate(isoDate) {
  if (!isoDate) return null;
  try {
    const date = new Date(isoDate);
    return date.toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return null;
  }
}

// Збереження зони
async function saveZone(connection, zone, accountId) {
  const sql = `
    INSERT INTO cf_zones (
      zone_id, account_id, name, status, paused, type,
      original_registrar, original_dnshost, name_servers, original_name_servers,
      plan_id, plan_name, plan_price, plan_currency, plan_is_subscribed, plan_can_subscribe, plan_legacy_id, plan_externally_managed,
      activated_on, created_on, modified_on,
      owner_id, owner_type, owner_email,
      permissions, development_mode, meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      status = VALUES(status),
      paused = VALUES(paused),
      type = VALUES(type),
      original_registrar = VALUES(original_registrar),
      original_dnshost = VALUES(original_dnshost),
      name_servers = VALUES(name_servers),
      original_name_servers = VALUES(original_name_servers),
      plan_id = VALUES(plan_id),
      plan_name = VALUES(plan_name),
      plan_price = VALUES(plan_price),
      plan_currency = VALUES(plan_currency),
      plan_is_subscribed = VALUES(plan_is_subscribed),
      plan_can_subscribe = VALUES(plan_can_subscribe),
      plan_legacy_id = VALUES(plan_legacy_id),
      plan_externally_managed = VALUES(plan_externally_managed),
      modified_on = VALUES(modified_on),
      owner_id = VALUES(owner_id),
      owner_type = VALUES(owner_type),
      owner_email = VALUES(owner_email),
      permissions = VALUES(permissions),
      development_mode = VALUES(development_mode),
      meta = VALUES(meta),
      updated_at = NOW()
  `;
  
  const plan = zone.plan || {};
  const owner = zone.owner || {};
  const account = zone.account || {};
  
  await connection.query(sql, [
    zone.id,
    accountId || account.id,
    zone.name,
    zone.status,
    zone.paused || false,
    zone.type || 'full',
    zone.original_registrar,
    zone.original_dnshost,
    JSON.stringify(zone.name_servers || []),
    JSON.stringify(zone.original_name_servers || []),
    plan.id,
    plan.name,
    plan.price || 0,
    plan.currency || 'USD',
    plan.is_subscribed || false,
    plan.can_subscribe || true,
    plan.legacy_id,
    plan.externally_managed || false,
    toMySQLDate(zone.activated_on),
    toMySQLDate(zone.created_on),
    toMySQLDate(zone.modified_on),
    owner.id,
    owner.type,
    owner.email,
    JSON.stringify(zone.permissions || []),
    zone.development_mode || 0,
    JSON.stringify(zone.meta || {})
  ]);
}

// Збереження аналітики
async function saveAnalytics(connection, zoneId, date, stats) {
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
  
  await connection.query(sql, [
    zoneId,
    date,
    stats.uniqueVisitors || 0,
    stats.pageViews || 0,
    stats.requests || 0,
    stats.bandwidth || 0,
    stats.cachedBandwidth || 0,
    (stats.bandwidth || 0) - (stats.cachedBandwidth || 0),
    stats.threats || 0,
    stats.encryptedRequests || 0,
    stats.unencryptedRequests || 0,
    stats.responseStatus?.['1xx'] || 0,
    stats.responseStatus?.['2xx'] || 0,
    stats.responseStatus?.['3xx'] || 0,
    stats.responseStatus?.['4xx'] || 0,
    stats.responseStatus?.['5xx'] || 0,
    JSON.stringify(stats.contentTypes || []),
    JSON.stringify(stats.browsers || [])
  ]);
}

// Збереження географії
async function saveCountryStats(connection, zoneId, date, countries) {
  if (!countries || countries.length === 0) return;
  
  for (const country of countries) {
    await connection.query(`
      INSERT INTO cf_analytics_countries (zone_id, date, country_code, country_name, requests, threats)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        requests = VALUES(requests),
        threats = VALUES(threats),
        country_name = VALUES(country_name)
    `, [
      zoneId,
      date,
      country.clientCountryName?.substring(0, 10) || 'XX',
      country.clientCountryName || 'Unknown',
      country.requests || 0,
      country.threats || 0
    ]);
  }
}

// ==================== CLOUDFLARE API FUNCTIONS ====================

// Отримати всі зони (домени) для конкретного акаунта
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
        console.error(`Помилка отримання зон для ${accountId}:`, data.errors);
        break;
      }
      
      const batch = data.result || [];
      allZones = allZones.concat(batch);
      console.log(`   Сторінка ${page}: отримано ${batch.length} зон для ${accountId}`);
      if (batch.length < 50) break;
      page += 1;
    }
    return allZones;
  } catch (error) {
    console.error(`Помилка запиту зон для ${accountId}:`, error.message);
    return [];
  }
}

// Отримати всі зони з усіх акаунтів
async function getAllZones() {
  const accounts = [
    { id: ACCOUNT_ID, name: 'Account 1' },
    { id: ACCOUNT_ID_2, name: 'Account 2' }
  ].filter(acc => acc.id); // Фільтруємо тільки існуючі

  let allZones = [];
  
  for (const account of accounts) {
    console.log(`  📂 Завантаження зон для ${account.name} (${account.id})...`);
    const zones = await getZonesForAccount(account.id);
    zones.forEach(zone => zone._accountId = account.id);
    allZones = allZones.concat(zones);
    console.log(`     Знайдено ${zones.length} зон`);
  }
  
  return allZones;
}

// GraphQL запит для розширеної аналітики (безкоштовний тариф)
async function getZoneAnalytics(zoneId, zoneName, date, accountId) {
  const query = `
    query {
      viewer {
        zones(filter: { zoneTag: "${zoneId}" }) {
          httpRequests1dGroups(
            limit: 1
            filter: { date: "${date}" }
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
              clientHTTPVersionMap {
                clientHTTPProtocol
                requests
              }
              ipClassMap {
                ipType
                requests
              }
              threatPathingMap {
                threatPathingName
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
      console.error(`Помилка GraphQL для ${zoneName}:`, data.errors);
      return null;
    }

    const zones = data.data?.viewer?.zones;
    if (!zones || zones.length === 0) {
      return null;
    }

    const httpData = zones[0].httpRequests1dGroups;
    if (!httpData || httpData.length === 0) {
      return { zoneName, zoneId, noData: true };
    }

    const stats = httpData[0];
    
    // Групуємо статуси відповідей
    const responseStatus = {};
    (stats.sum.responseStatusMap || []).forEach(item => {
      const status = Math.floor(item.edgeResponseStatus / 100);
      const key = `${status}xx`;
      responseStatus[key] = (responseStatus[key] || 0) + item.requests;
    });

    return {
      zoneName,
      zoneId,
      date: stats.dimensions.date,
      requests: stats.sum.requests,
      pageViews: stats.sum.pageViews,
      uniqueVisitors: stats.uniq.uniques,
      bandwidth: stats.sum.bytes,
      cachedBandwidth: stats.sum.cachedBytes,
      threats: stats.sum.threats,
      encryptedRequests: stats.sum.encryptedRequests,
      unencryptedRequests: stats.sum.requests - stats.sum.encryptedRequests,
      countries: stats.sum.countryMap
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 20),
      responseStatus,
      contentTypes: stats.sum.contentTypeMap
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 10),
      browsers: stats.sum.browserMap
        .sort((a, b) => b.pageViews - a.pageViews)
        .slice(0, 10),
      httpVersions: stats.sum.clientHTTPVersionMap,
      ipClasses: stats.sum.ipClassMap,
      threatPaths: stats.sum.threatPathingMap
    };
  } catch (error) {
    console.error(`Помилка запиту аналітики для ${zoneName}:`, error.message);
    return null;
  }
}

// Отримати детальну інформацію про зону
async function getZoneDetails(zoneId) {
  try {
    const response = await fetch(`${API_BASE}/zones/${zoneId}`, {
      headers: getHeaders()
    });
    const data = await response.json();
    
    if (!data.success) {
      return null;
    }
    
    return data.result;
  } catch (error) {
    console.error(`Помилка отримання деталей зони:`, error.message);
    return null;
  }
}

// Отримати налаштування зони
async function getZoneSettings(zoneId) {
  try {
    const response = await fetch(`${API_BASE}/zones/${zoneId}/settings`, {
      headers: getHeaders()
    });
    const data = await response.json();
    
    if (!data.success) {
      return [];
    }
    
    return data.result;
  } catch (error) {
    console.error(`Помилка отримання налаштувань зони:`, error.message);
    return [];
  }
}

// Отримати DNS записи
async function getDnsRecords(zoneId) {
  try {
    const response = await fetch(`${API_BASE}/zones/${zoneId}/dns_records?per_page=100`, {
      headers: getHeaders()
    });
    const data = await response.json();
    
    if (!data.success) {
      return [];
    }
    
    return data.result;
  } catch (error) {
    console.error(`Помилка отримання DNS записів:`, error.message);
    return [];
  }
}

// Форматування байтів
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Форматування чисел
function formatNumber(num) {
  return num?.toLocaleString('uk-UA') || '0';
}

// Вивід статистики
function printStats(stats) {
  if (!stats) {
    console.log('  ❌ Немає даних\n');
    return;
  }

  if (stats.noData) {
    console.log(`  📊 Немає даних за цей день\n`);
    return;
  }

  console.log(`  📅 Дата: ${stats.date}`);
  console.log(`  👥 Унікальні відвідувачі: ${formatNumber(stats.uniqueVisitors)}`);
  console.log(`  👁️  Перегляди сторінок: ${formatNumber(stats.pageViews)}`);
  console.log(`  📨 Всього запитів: ${formatNumber(stats.requests)}`);
  console.log(`  📦 Трафік: ${formatBytes(stats.bandwidth)}`);
  console.log(`  💾 Кешований трафік: ${formatBytes(stats.cachedBandwidth)}`);
  console.log(`  � HTTPS запити: ${formatNumber(stats.encryptedRequests)} (${((stats.encryptedRequests/stats.requests)*100).toFixed(1)}%)`);
  console.log(`  🛡️  Заблоковані загрози: ${formatNumber(stats.threats)}`);
  
  if (stats.responseStatus) {
    console.log(`  📊 HTTP статуси:`);
    Object.entries(stats.responseStatus)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, count]) => {
        if (count > 0) {
          console.log(`     ${status}: ${formatNumber(count)}`);
        }
      });
  }
  
  if (stats.browsers && stats.browsers.length > 0) {
    console.log(`  🌐 Топ браузери:`);
    stats.browsers.slice(0, 5).forEach((browser, index) => {
      console.log(`     ${index + 1}. ${browser.uaBrowserFamily}: ${formatNumber(browser.pageViews)} переглядів`);
    });
  }
  
  if (stats.countries && stats.countries.length > 0) {
    console.log(`  🌍 Топ країни:`);
    stats.countries.slice(0, 10).forEach((country, index) => {
      console.log(`     ${index + 1}. ${country.clientCountryName}: ${formatNumber(country.requests)} запитів`);
    });
  }
  console.log('');
}

// Головна функція
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       CLOUDFLARE АНАЛІТИКА + СИНХРОНІЗАЦІЯ З БД           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const reportDates = getRecentDates(2); // сьогодні + вчора
  console.log(`📆 Дати звіту: ${reportDates.join(', ')}\n`);

  // Ініціалізація БД
  console.log('🔧 Ініціалізація бази даних...');
  let connection;
  try {
    connection = await initDatabase();
  } catch (error) {
    console.error('❌ Не вдалося підключитися до БД:', error.message);
    console.log('⚠️  Продовжуємо без збереження в БД...\n');
  }

  // Логування синхронізації
  let syncLogId = null;
  if (connection) {
    const [result] = await connection.query(
      'INSERT INTO cf_sync_log (sync_type, status) VALUES (?, ?)',
      ['full', 'started']
    );
    syncLogId = result.insertId;
  }

  // Отримуємо всі домени з обох акаунтів
  console.log('\n🔍 Отримуємо список доменів з усіх акаунтів...\n');
  const zones = await getAllZones();

  let zonesProcessed = 0;
  let recordsInserted = 0;

  if (zones.length === 0) {
    console.log('⚠️  Не вдалося отримати список доменів');
    if (ZONE_ID) {
      console.log('   Використовуємо ZONE_ID з .env\n');
    }
  } else {
    console.log(`\n✅ Всього знайдено ${zones.length} домен(ів):\n`);
    zones.forEach(zone => {
      console.log(`   • ${zone.name} (${zone.status}) - Plan: ${zone.plan?.name || 'N/A'}`);
    });
    console.log('');
  }

  // Зберігаємо акаунти
  if (connection) {
    if (ACCOUNT_ID) await saveAccount(connection, ACCOUNT_ID, 'Account 1');
    if (ACCOUNT_ID_2) await saveAccount(connection, ACCOUNT_ID_2, 'Account 2');
  }

  // Збираємо статистику
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    СТАТИСТИКА ПО ДОМЕНАХ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allStats = [];

  for (const zone of zones) {
    for (const date of reportDates) {
      console.log(`🌐 ${zone.name} | ${date}`);
      console.log('─'.repeat(50));
      
      // Зберігаємо інформацію про зону в БД
      if (connection) {
        await saveZone(connection, zone, zone._accountId);
        recordsInserted++;
      }
      
      // Отримуємо аналітику
      const stats = await getZoneAnalytics(zone.id, zone.name, date, zone._accountId);
      printStats(stats);
      
      if (stats && !stats.noData) {
        allStats.push(stats);
        
        // Зберігаємо аналітику в БД
        if (connection) {
          await saveAnalytics(connection, zone.id, date, stats);
          await saveCountryStats(connection, zone.id, date, stats.countries);
          recordsInserted += stats.countries?.length || 0;
        }
      }
      
      zonesProcessed++;
    }
  }

  // Загальна статистика
  if (allStats.length > 1) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    ЗАГАЛЬНА СТАТИСТИКА');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const totals = allStats.reduce((acc, stats) => {
      acc.uniqueVisitors += stats.uniqueVisitors || 0;
      acc.pageViews += stats.pageViews || 0;
      acc.requests += stats.requests || 0;
      acc.bandwidth += stats.bandwidth || 0;
      acc.cachedBandwidth += stats.cachedBandwidth || 0;
      acc.threats += stats.threats || 0;
      acc.encryptedRequests += stats.encryptedRequests || 0;
      return acc;
    }, { uniqueVisitors: 0, pageViews: 0, requests: 0, bandwidth: 0, cachedBandwidth: 0, threats: 0, encryptedRequests: 0 });

    console.log(`  👥 Всього унікальних відвідувачів: ${formatNumber(totals.uniqueVisitors)}`);
    console.log(`  👁️  Всього переглядів сторінок: ${formatNumber(totals.pageViews)}`);
    console.log(`  📨 Всього запитів: ${formatNumber(totals.requests)}`);
    console.log(`  📦 Загальний трафік: ${formatBytes(totals.bandwidth)}`);
    console.log(`  💾 Загальний кешований трафік: ${formatBytes(totals.cachedBandwidth)}`);
    console.log(`  🔒 HTTPS запитів: ${formatNumber(totals.encryptedRequests)} (${((totals.encryptedRequests/totals.requests)*100).toFixed(1)}%)`);
    console.log(`  🛡️  Всього заблокованих загроз: ${formatNumber(totals.threats)}`);
    console.log('');
  }

  // Оновлюємо лог синхронізації
  if (connection && syncLogId) {
    await connection.query(
      'UPDATE cf_sync_log SET status = ?, zones_processed = ?, records_inserted = ?, completed_at = NOW() WHERE id = ?',
      ['completed', zonesProcessed, recordsInserted, syncLogId]
    );
  }

  // Зберігаємо результат у JSON
  const outputFile = `analytics_${reportDates[0]}.json`;
  const fs = require('fs');
  fs.writeFileSync(outputFile, JSON.stringify({
    date: reportDates[0],
    generatedAt: new Date().toISOString(),
    totalZones: zones.length,
    zones: allStats
  }, null, 2));
  
  console.log(`💾 Результати збережено у файл: ${outputFile}`);
  
  if (connection) {
    console.log(`✅ Дані синхронізовано з MySQL базою '${DB_NAME}'`);
    await connection.end();
  }
}

main().catch(console.error);
