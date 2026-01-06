FROM node:20-alpine

RUN apk add --no-cache supervisor

WORKDIR /app

# Копіюємо root package.json
COPY package*.json ./

# Встановлюємо залежності для scheduler
RUN npm ci --only=production

# Копіюємо код scheduler (включно з wait-for-env.js)
COPY *.js ./

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

# Копіюємо supervisor конфіг
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('OK')" || exit 1

# Запуск supervisor (який запустить scheduler і dashboard)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
