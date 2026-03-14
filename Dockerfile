# Use the official Node.js image as base
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy the rest of the application
COPY . .

# Create data directory for persistent SQLite storage
RUN mkdir -p /app/data

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["node", "src/server.js"]
