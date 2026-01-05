FROM node:20

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
RUN pip3 install --no-cache-dir rembg[gpu] pillow --break-system-packages

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Make Python script executable
RUN chmod +x remove-bg.py

EXPOSE 3001

ENV NODE_ENV=production

CMD ["node", "index.js"]
