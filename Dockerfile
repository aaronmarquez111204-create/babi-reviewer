FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package.json ./
COPY package-lock.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expose port (default Express port)
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
