# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS kimi-code
ARG KIMI_CODE_VERSION=2.3.0
RUN npm install --prefix /opt/kimi-code --omit=optional --ignore-scripts @moonshot-ai/kimi-code@${KIMI_CODE_VERSION}

FROM --platform=$TARGETPLATFORM node:20-bookworm-slim AS runtime

ARG TARGETARCH
ARG SOPS_VERSION=3.13.3
ARG AGE_VERSION=1.3.2
ARG EXTRA_NPM_GLOBAL_PACKAGES="@google/gemini-cli@0.46.0 @openai/codex@0.144.1 opencode-ai@1.17.7 @xai-official/grok@0.2.93"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/var/lib/gateway-home
ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium
ENV ARTIFACT_BROWSER_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    fonts-liberation \
    fonts-noto-color-emoji \
    gnupg \
    openssh-client \
    tini \
    util-linux \
  && chromium --version \
  && ! ldd /usr/lib/chromium/chromium | grep -q "not found" \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/google-cloud-cli.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/google-cloud-cli.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) sops_sha=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b; age_sha=cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 ;; \
    arm64) sops_sha=53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77; age_sha=6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4 ;; \
    *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${TARGETARCH}" -o /tmp/sops; \
  echo "$sops_sha  /tmp/sops" | sha256sum -c -; \
  curl -fsSL "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/age.tar.gz; \
  echo "$age_sha  /tmp/age.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/age.tar.gz -C /tmp age/age age/age-keygen; \
  install -m 0755 /tmp/sops /usr/local/bin/sops; \
  install -m 0755 /tmp/age/age /tmp/age/age-keygen /usr/local/bin/; \
  rm -rf /tmp/sops /tmp/age.tar.gz /tmp/age

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && if [ -n "$EXTRA_NPM_GLOBAL_PACKAGES" ]; then npm install -g $EXTRA_NPM_GLOBAL_PACKAGES; fi \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=kimi-code /usr/local/bin/node /opt/node22/bin/node
COPY --from=kimi-code /opt/kimi-code /opt/kimi-code
RUN printf '%s\n' '#!/bin/sh' 'exec /opt/node22/bin/node /opt/kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs "$@"' > /usr/local/bin/kimi-code \
  && chmod 0755 /usr/local/bin/kimi-code
COPY config/providers.example.yaml ./config/providers.example.yaml
COPY config/provider-profiles ./config/provider-profiles

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin gateway \
  && mkdir -p /var/lib/gateway-home /tmp \
  && chown -R gateway:gateway /app /var/lib/gateway-home /tmp

USER gateway

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
