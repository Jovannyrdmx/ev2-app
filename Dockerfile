FROM node:18-alpine AS builder

WORKDIR /app

# Copy HTML file
COPY index.html .

# Create imagine_images directory
RUN mkdir -p imagine_images

# Use lightweight http-server
RUN npm install -g http-server

FROM alpine:3.18

WORKDIR /app

# Install node and http-server in final image
RUN apk add --no-cache nodejs npm && \
    npm install -g http-server

# Copy from builder
COPY --from=builder /app/index.html .
COPY --from=builder /app/imagine_images ./imagine_images

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8080/ || exit 1

CMD ["http-server", "-p", "8080", "-c-1"]
