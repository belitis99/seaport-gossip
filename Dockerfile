FROM node:16-alpine as build
WORKDIR /usr/app
RUN apk update && apk add --no-cache bash git yarn && rm -rf /var/cache/apk/*

RUN git clone --depth 1 --branch main https://github.com/ProjectOpenSea/seaport-gossip.git

WORKDIR /usr/app/seaport-gossip
RUN yarn

FROM node:16-alpine
WORKDIR /usr/app
COPY --from=build /usr/app .

# Sanity check
RUN node /usr/app/seaport-gossip/dist/bin/start.js --help

# NodeJS applications have a default memory limit of 2.5GB.
# This limit is bit tight, it is recommended to raise the limit
# since memory may spike during certain network conditions.
ENV NODE_OPTIONS=--max_old_space_size=6144

ENTRYPOINT ["node", "/usr/app/seaport-gossip/dist/bin/start.js"]