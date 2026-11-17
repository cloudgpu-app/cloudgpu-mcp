FROM node:20-alpine
RUN npm install -g cloudgpu-mcp@0.16.6
ENTRYPOINT ["cloudgpu-mcp"]
