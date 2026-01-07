FROM node:20-alpine

# Встановлюємо crond та supervisor
RUN apk add --no-cache supervisor dcron

WORKDIR /app

# Копіюємо root package.json
COPY package*.json ./

# Встановлюємо залежності для scheduler
RUN npm ci --only=production

# Копіюємо код scheduler (включно з wait-for-env.js та daily-scheduler.js)
COPY *.js ./
COPY *.sql ./

# Копіюємо dashboard папку
COPY dashboard ./dashboard

# Встановлюємо залежності для dashboard (включно з dev dependencies для Tailwind)
WORKDIR /app/dashboard
RUN npm install

# Buildуємо Tailwind CSS
RUN npm run build:css

# На production встановлюємо тільки production dependencies
RUN npm prune --production

# Повертаємось до root
WORKDIR /app

# Створюємо crontab файл - кожну годину о XX:05
RUN echo "5 * * * * cd /app && node daily-scheduler.js >> /var/log/cron.log 2>&1" > /etc/crontabs/root

# Створюємо лог файл
RUN touch /var/log/cron.log

# Копіюємо supervisor конфіг
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Копіюємо entrypoint скрипт
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('OK')" || exit 1

# Запуск через entrypoint
ENTRYPOINT ["/entrypoint.sh"]
