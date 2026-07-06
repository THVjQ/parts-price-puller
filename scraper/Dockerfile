FROM mcr.microsoft.com/playwright:v1.45.0-jammy
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY scraper.js .
CMD ["node", "scraper.js"]
