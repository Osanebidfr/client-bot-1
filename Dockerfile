# Dockerfile - supports node-canvas and ffmpeg
FROM node:22-bullseye-slim

# Install system packages needed to build node-canvas + ffmpeg
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    python3 \
    python3-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Set working dir
WORKDIR /usr/src/app

# Copy package files first (cache layer)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev

# Copy rest of project files
COPY . .

# Ensure data folders exist
RUN mkdir -p /usr/src/app/data/auth && mkdir -p /usr/src/app/data/saved

ENV NODE_ENV=production

CMD ["node", "bot.js"]
