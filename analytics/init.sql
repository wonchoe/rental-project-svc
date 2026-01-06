-- Ініціалізація бази даних Cloudflare Analytics
-- Надаємо всі права користувачу

GRANT ALL PRIVILEGES ON cloudflare.* TO 'cloudflare_admin'@'%';
GRANT ALL PRIVILEGES ON cloudflare.* TO 'cloudflare_admin'@'localhost';
FLUSH PRIVILEGES;
