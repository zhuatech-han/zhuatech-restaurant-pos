# 知华科技（上海如静知华信息科技有限公司） https://www.zhuatech.cn/ 商业咨询微信：zhuatech / zhuatech2
FROM node:24.19.0-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY assets ./assets
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8091
CMD ["node", "src/server.js"]
