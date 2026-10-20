FROM 127.0.0.1:5000/inpulse/api:0.1.0-20261015-d7407c7
COPY app /opt/wecom-bridge
WORKDIR /opt/wecom-bridge

# 项目封箱海报字体已随 app/assets/fonts 分发；这里保留 fonts-noto-cjk
# 作为系统兜底，避免字体资产缺失或未来替换时中文渲染成方框。
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
USER 10001:10001

ENTRYPOINT ["node"]
CMD ["/opt/wecom-bridge/runner.mjs"]
