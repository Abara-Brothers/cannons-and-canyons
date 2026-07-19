FROM node:22-alpine
WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Hosts inject PORT; server.js reads process.env.PORT (defaults to 3000)
EXPOSE 3000
CMD ["node", "server.js"]
