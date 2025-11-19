FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN apt-get update && apt-get install -y ghostscript && rm -rf /var/lib/apt/lists/*
RUN npm install --production

COPY . .

CMD [ "npm", "start" ]
