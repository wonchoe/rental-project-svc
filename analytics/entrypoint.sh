#!/bin/sh

echo "🚀 Starting Analytics Services"
echo "📅 Current time: $(date)"
echo ""

# Запускаємо scheduler один раз при старті
echo "🔄 Running initial data collection..."
node /app/daily-scheduler.js &

echo ""

# Запускаємо crond
echo "⏰ Starting cron daemon..."
crond -f -l 2 &

echo ""

# Виводимо cron таблицю
echo "📋 Cron schedule:"
crontab -l

echo ""

# Моніторимо логи
tail -f /var/log/cron.log &

echo ""

# Запускаємо supervisor для dashboard
echo "🌐 Starting dashboard..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
