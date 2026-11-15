FROM node:20-alpine
COPY bench/load.mjs /bench/load.mjs
ENTRYPOINT ["node"]
CMD ["-e", "setInterval(() => {}, 2147483647)"]
