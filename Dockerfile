FROM node:20-alpine
RUN npm install -g cloudgpu-mcp@0.15.0
ENTRYPOINT ["cloudgpu-mcp"]
