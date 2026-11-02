FROM node:20-alpine
RUN npm install -g cloudgpu-mcp@0.1.2
ENTRYPOINT ["cloudgpu-mcp"]
