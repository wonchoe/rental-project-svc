FROM node:20

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3002

ENV NODE_ENV=production

CMD ["node", "index.js"]
