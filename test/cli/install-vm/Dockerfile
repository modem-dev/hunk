# The runner always overrides this parse-safe default with the digest from pins.json.
ARG CONTROLLER_IMAGE=scratch
FROM ${CONTROLLER_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates=20260601~24.04.1 \
      curl=8.5.0-2ubuntu10.13 \
      e2fsprogs=1.47.0-2.4~exp1ubuntu4.1 \
      iproute2=6.1.0-1ubuntu6.4 \
      iptables=1.8.10-3ubuntu2 \
      jq=1.7.1-3ubuntu0.24.04.2 \
      openssh-client=1:9.6p1-3ubuntu13.18 \
      procps=2:4.0.4-4ubuntu3.3 \
      python3=3.12.3-0ubuntu2.1 \
      squashfs-tools=1:4.6.1-1build1 \
      xz-utils=5.6.1+really5.4.5-1ubuntu0.3 \
 && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION
ARG NODE_URL
ARG NODE_SHA256
RUN curl --fail --show-error --location --connect-timeout 15 --max-time 300 --retry 3 \
      -o /tmp/node.tar.xz "${NODE_URL}" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /opt \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/npx" /usr/local/bin/npx \
 && rm -f /tmp/node.tar.xz

WORKDIR /opt/install-vm
COPY controller-deps ./controller-deps
RUN cd controller-deps \
 && npm ci --ignore-scripts \
 && ln -s /opt/install-vm/controller-deps/node_modules/.bin/verdaccio /usr/local/bin/verdaccio
COPY controller.sh pins.json scenarios.json ./
COPY guest ./guest
COPY scenarios ./scenarios
RUN chmod +x controller.sh guest/*.sh scenarios/*.sh

ENTRYPOINT ["/opt/install-vm/controller.sh"]
