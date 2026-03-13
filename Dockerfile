# Use the official Node.js image as base
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies (ignoring scripts & using clean install for reliability)
RUN npm install

# Copy the rest of the application code
COPY src/ ./src/
COPY public/ ./public/

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
