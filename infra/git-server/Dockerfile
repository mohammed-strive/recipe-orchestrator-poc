FROM alpine:3.20
RUN apk add --no-cache git git-daemon
COPY seed.sh create-repo.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
EXPOSE 9418
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
