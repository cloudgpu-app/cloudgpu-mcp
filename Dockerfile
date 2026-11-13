FROM node:25-alpine
RUN npm install -g cloudgpu-mcp@0.15.0
ENTRYPOINT ["cloudgpu-mcp"]
