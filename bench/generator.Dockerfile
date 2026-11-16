FROM node:22-alpine
COPY bench/load.mjs /bench/load.mjs
COPY bench/cold-start.mjs /bench/cold-start.mjs
COPY bench/w4-harness.mjs /bench/w4-harness.mjs
COPY bench/result-schema.schema.json /bench/result-schema.schema.json
ENTRYPOINT ["node"]
CMD ["-e", "setInterval(() => {}, 2147483647)"]
