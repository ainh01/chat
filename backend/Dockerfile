FROM node:18-alpine  

WORKDIR /app  

COPY package*.json package-lock.json ./  

RUN npm ci --omit=dev  

COPY . .  

EXPOSE 8081

CMD ["node", "app.js"]
