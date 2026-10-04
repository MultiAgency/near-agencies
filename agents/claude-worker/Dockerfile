# One worker run per container start: Railway runs it on a cron schedule, and
# it exits when the run is done. Claude posts comments with `gh` and, for code
# tasks, ships branches with `git`, so the image carries both; GH_TOKEN makes
# them act as the agent.
#
# TOOLCHAIN picks the variant: node (the default) or rust. Tasks on a Rust
# repository need the Rust toolchain, so that build adds it, with clippy; a
# worker without it stays small. Either way the image sets WORKER_TOOLCHAIN to
# the toolchain it carries, which tells the worker what it may take on.
FROM node:22-slim
ARG TOOLCHAIN=node
ENV WORKER_TOOLCHAIN=${TOOLCHAIN} RUSTUP_HOME=/usr/local/rustup
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
# The rust build only: rustup's minimal profile plus clippy, and the C
# toolchain, cmake, pkg-config and OpenSSL headers that the crates a Rust
# repository brings (ring, aws-lc-sys, openssl-sys) build against. Installed
# under /usr/local and linked into /usr/local/bin, so the unprivileged node
# user runs cargo too; its crate caches go to its own home directory. The
# toolchain is pinned: bump it in a deliberate change, and re-run the checks
# of the repositories this image serves when you do. A repository that pins
# another version in rust-toolchain.toml installs it into the shared
# RUSTUP_HOME on first use, so the directories there belong to node.
RUN if [ "$TOOLCHAIN" = "rust" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential cmake pkg-config libssl-dev \
      && curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
      && env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh /tmp/rustup-init.sh -y --profile minimal --component clippy --default-toolchain 1.99.0 --no-modify-path \
      && rm /tmp/rustup-init.sh \
      && ln -s /usr/local/cargo/bin/* /usr/local/bin/ \
      && chown -R node:node /usr/local/rustup \
      && rm -rf /var/lib/apt/lists/*; \
    elif [ "$TOOLCHAIN" != "node" ]; then \
      echo "TOOLCHAIN is node or rust, not '$TOOLCHAIN'" >&2; \
      exit 1; \
    fi
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
USER node
CMD ["node", "worker.mjs"]
