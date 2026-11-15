FROM node:20-alpine
WORKDIR /app
COPY bench/fake-gemini/server.mjs ./server.mjs
EXPOSE 8088
CMD ["node", "server.mjs"]
