# One worker run per container start: Railway runs it on a cron schedule, and
# it exits when the run is done. Claude posts comments with `gh` and, for code
# tasks, ships branches with `git`, so the image carries both; GH_TOKEN makes
# them act as the agent. A code task runs its repository's checks
# (repos.mjs): npm for near-agencies, and cargo for legion-social, whose
# crates build native code (ring, aws-lc-sys, openssl-sys), hence the C
# toolchain, cmake and OpenSSL headers.
FROM node:22-slim
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git build-essential cmake pkg-config libssl-dev \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --component clippy \
 && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
USER node
CMD ["node", "worker.mjs"]
