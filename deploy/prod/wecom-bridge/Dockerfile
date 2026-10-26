ARG API_IMAGE_REF
FROM ${API_IMAGE_REF}
COPY app /opt/wecom-bridge
WORKDIR /opt/wecom-bridge

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
USER 10001:10001

ENTRYPOINT ["node"]
CMD ["/opt/wecom-bridge/runner.mjs"]
