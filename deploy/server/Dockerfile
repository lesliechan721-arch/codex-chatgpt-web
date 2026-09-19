# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim

ARG APPIMAGE_FILE
ARG CODEX_UID=10001
ARG CODEX_GID=10001

ENV DEBIAN_FRONTEND=noninteractive

RUN test "$(dpkg --print-architecture)" = "amd64"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dbus-x11 \
    file \
    fonts-dejavu-core \
    gnome-keyring \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libsecret-1-0 \
    libsecret-tools \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    novnc \
    openbox \
    supervisor \
    tigervnc-tools \
    tini \
    websockify \
    x11-utils \
    x11vnc \
    xdg-utils \
    xterm \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN test -f /usr/share/novnc/vnc.html

COPY deploy/server/novnc-index.html /usr/share/novnc/index.html

RUN groupadd --gid "$CODEX_GID" codex \
  && useradd --create-home --uid "$CODEX_UID" --gid "$CODEX_GID" --shell /bin/bash codex \
  && mkdir -p /opt/codex /opt/codex-server/bin /opt/codex-server/build /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

COPY deploy/server/bin/ /opt/codex-server/bin/
COPY deploy/server/supervisord.conf /etc/supervisor/conf.d/codex-server.conf
COPY launcher/artifacts/${APPIMAGE_FILE} /opt/codex/Codex-Web-GPT.AppImage

RUN chmod 0755 /opt/codex/Codex-Web-GPT.AppImage /opt/codex-server/bin/*.sh \
  && file /opt/codex/Codex-Web-GPT.AppImage | grep -q 'x86-64' \
  && sha256sum /opt/codex/Codex-Web-GPT.AppImage > /opt/codex-server/build/appimage.sha256

ENV HOME=/home/codex \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/codex-runtime \
    CODEX_CHATGPT_WEB_HOME=/home/codex/.codex-chatgpt-web \
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR="/home/codex/.config/Codex Web GPT" \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    APPIMAGE_PATH=/opt/codex/Codex-Web-GPT.AppImage \
    VNC_PASSWORD_FILE=/run/secrets/vnc_password \
    KEYRING_PASSWORD_FILE=/run/secrets/keyring_password

USER codex
WORKDIR /home/codex

EXPOSE 6080 17841

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/codex-server/bin/entrypoint.sh"]
