
# Dockerfile - canvas + ffmpeg + Node 20 (recommended)

FROM node:20-bullseye-slim

# Install required system libraries for node-canvas + ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /usr/src/app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (canvas will compile successfully)
RUN npm install --omit=dev

# Copy all bot files
COPY . .

# Ensure data directories exist
RUN mkdir -p /usr/src/app/data/auth && \
    mkdir -p /usr/src/app/data/saved

ENV NODE_ENV=production

# Start bot
CMD ["node", "bot.js"]
