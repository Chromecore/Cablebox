# Stage 1: Frontend build
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
RUN apk add --no-cache imagemagick
COPY frontend/package*.json ./
RUN npm install --legacy-peer-deps
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend build
FROM golang:1.22-alpine AS backend-build
WORKDIR /app
RUN apk add --no-cache gcc musl-dev
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -o /cablebox ./cmd/server

# Stage 3: Production
FROM alpine:3.19
RUN apk add --no-cache ca-certificates wget

RUN addgroup -g 1000 cablebox && \
    adduser -u 1000 -G cablebox -s /bin/sh -D cablebox

WORKDIR /app
COPY --from=backend-build /cablebox ./cablebox
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data && chown -R cablebox:cablebox /app
USER cablebox

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    FRONTEND_DIR=/app/frontend/dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/api/health || exit 1

CMD ["/app/cablebox"]
