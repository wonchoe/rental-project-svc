# Cloudflare Analytics - Cron Setup

## 📅 Cronjob для збору щоденної аналітики

### Налаштування

Система використовує **dcron** в Alpine Linux контейнері для автоматичного збору даних кожну годину.

#### Розклад
```cron
5 * * * * cd /app && node daily-scheduler.js >> /var/log/cron.log 2>&1
```

Scheduler запускається **кожну годину о XX:05** (наприклад: 00:05, 01:05, 02:05, ..., 23:05 UTC).

### Архітектура

```
┌─────────────────────────────────────┐
│   Docker Container                  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  entrypoint.sh               │  │
│  │  ├─ Initial data collection  │  │
│  │  ├─ Start crond daemon       │  │
│  │  └─ Start supervisord        │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  crond (PID 9)               │  │
│  │  └─ 5 * * * * daily-scheduler │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  supervisord (PID 1)         │  │
│  │  ├─ dashboard (port 3030)    │  │
│  │  └─ scheduler (hourly)       │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

### Перевірка роботи

#### 1. Перевірити що crond запущено
```bash
docker exec cf-daily-analytics ps aux | grep crond
```

Очікуваний результат:
```
9 root      0:00 crond -f -l 2
```

#### 2. Переглянути crontab
```bash
docker exec cf-daily-analytics crontab -l
```

Очікуваний результат:
```
5 * * * * cd /app && node daily-scheduler.js >> /var/log/cron.log 2>&1
```

#### 3. Переглянути логи cron завдань
```bash
docker exec cf-daily-analytics cat /var/log/cron.log
```

або в реальному часі:
```bash
docker exec cf-daily-analytics tail -f /var/log/cron.log
```

#### 4. Переглянути логи контейнера
```bash
docker logs cf-daily-analytics --tail 50 -f
```

### Ручний запуск

Якщо потрібно запустити збір даних вручну:

```bash
docker exec cf-daily-analytics node /app/daily-scheduler.js
```

### Локальна розробка

```bash
cd /mnt/laravel/rental-project-svc/analytics

# Зупинити контейнер
docker-compose down daily-scheduler

# Перебудувати та запустити
docker-compose up -d --build daily-scheduler

# Переглянути логи
docker logs cf-daily-analytics -f
```

### Production Deployment

Образ готовий до деплою в production:

```bash
# Pull образ
docker pull wonchoe/analytics:latest

# Kubernetes
kubectl set image deployment/analytics analytics=wonchoe/analytics:latest
kubectl rollout status deployment/analytics
```

### Особливості

1. **Початковий запуск**: При старті контейнера scheduler запускається одразу для збору актуальних даних
2. **Cron daemon**: crond працює в foreground режимі (`-f`) з рівнем логування 2 (`-l 2`)
3. **Логування**: Всі виходи cron завдань пишуться в `/var/log/cron.log`
4. **Dashboard**: Працює паралельно на порті 3030 через supervisord
5. **Timezone**: Всі часи в UTC

### Troubleshooting

#### Cron не запускається

```bash
# Перевірити що crond процес існує
docker exec cf-daily-analytics ps aux | grep crond

# Перезапустити контейнер
docker restart cf-daily-analytics
```

#### Немає логів

```bash
# Перевірити що лог файл існує
docker exec cf-daily-analytics ls -la /var/log/cron.log

# Ручний запуск для тестування
docker exec cf-daily-analytics sh -c "cd /app && node daily-scheduler.js"
```

#### Перевірити часовий пояс

```bash
docker exec cf-daily-analytics date -u
```

### Моніторинг

Рекомендується налаштувати моніторинг для:

1. Перевірки що crond процес працює
2. Моніторингу розміру `/var/log/cron.log` (rotation)
3. Alert якщо scheduler не запускався 2+ години
4. Перевірки успішності виконання (parse логів)

### Планування майбутніх покращень

- [ ] Logrotate для `/var/log/cron.log`
- [ ] Healthcheck на основі останнього запуску
- [ ] Metrics для Prometheus (кількість запусків, тривалість)
- [ ] Slack/Telegram нотифікації при помилках
