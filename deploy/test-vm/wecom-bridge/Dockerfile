FROM 127.0.0.1:5000/inpulse/api:0.1.0-20261015-d7407c7

USER root
RUN set -eu; \
    for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do \
      if [ -f "$file" ]; then sed -i s#http://deb.debian.org#http://mirrors.aliyun.com#g "$file"; fi; \
    done; \
    apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

COPY app /opt/wecom-bridge
WORKDIR /opt/wecom-bridge

USER 10001:10001

ENTRYPOINT ["node"]
CMD ["/opt/wecom-bridge/runner.mjs"]
