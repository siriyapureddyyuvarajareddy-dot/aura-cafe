FROM node:18-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy the rest of the application files
COPY . .

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_PATH=/data/aura_cafe.db

# Create the data directory for the SQLite volume
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "backend/server.js"]
