# 知华科技（上海如静知华信息科技有限公司） https://www.zhuatech.cn/ 商业咨询微信：zhuatech / zhuatech2
FROM node:24.19.0-alpine AS verify
WORKDIR /verify
COPY . .
RUN npm run lint && npm test && npm run build

FROM node:24.19.0-alpine
WORKDIR /app
COPY --from=verify /verify/dist/package.json ./
COPY --from=verify /verify/dist/src ./src
COPY --from=verify /verify/dist/scripts ./scripts
COPY --from=verify /verify/dist/web ./web
COPY --from=verify /verify/dist/assets ./assets
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8091
CMD ["node", "src/server.js"]
