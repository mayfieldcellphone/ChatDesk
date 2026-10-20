FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
EXPOSE 3000
# node:sqlite is stable in practice but still prints an "experimental" warning on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/index.js"]
