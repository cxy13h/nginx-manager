# Nginx 可视化配置管理器

一款基于 Web 的远程 Nginx 可视化配置管理工具。通过 SSH 连接目标 Linux 服务器，在远端临时镜像目录中完成编辑、语法校验（`nginx -t`）与备份，确认无误后再原子同步到线上并平滑重载，避免错误配置直接破坏线上服务。

## 核心特性

- **SSH 远程管理与连接复用**：支持密码直连目标服务器，自动复用 SSH / SFTP 长连接并检测用户 `sudo` 组权限与 Nginx 环境。
- **镜像隔离与安全校验**：所有新增、编辑、删除操作默认仅作用于远端临时镜像目录；保存或生效前强制执行 `sudo nginx -t` 全树语法校验，点击「生效」后才同步线上并重载。
- **贴合 Nginx 真实目录结构**：自动解析 `/etc/nginx/nginx.conf` 中的 `include` 规则，支持在「状态」页自定义额外加载目录（默认包含 `/etc/nginx/sites-available/*`），并将**实体配置**与**软链接**分列展示。
- **灵活的混合配置编排**：按 `location` 维度分别管理「静态站点」（`root` / `index` / `try_files`）与「反向代理」（`proxy_pass` / 代理请求头 / WebSocket），并支持多组 `upstream` 集群与未知指令无损保留。
- **备份与证书管理**：每次保存自动生成时间戳备份，支持一键加载回滚；支持扫描、上传和关联 SSL 公私钥证书，并自动检测引用关系。

## 技术栈

- **前端**：React 19、TypeScript、Vite、Tailwind CSS、Lucide Icons
- **后端**：Express、ssh2、Node.js（`tsx`）

## 快速开始

### 环境要求

- Node.js >= 20（建议 22+）
- 目标服务器已安装 Nginx，且 SSH 登录用户为 `root` 或属于 `sudo` 组

### 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 配置端口（默认 1111，可在环境变量中指定）
echo "PORT=3000" > .env

# 3. 启动服务
npm run dev
```

启动后访问 `http://localhost:3000`（若未设置 `PORT` 则默认 `http://localhost:1111`）。

### 运行测试与类型检查

```bash
# 类型检查
npm run lint

# 单元测试
npx tsx --test src/utils/pathHelpers.test.ts src/utils/nginxParser.test.ts src/server/sshManager.test.ts
```

## 生产部署（Ubuntu 示例）

### 1. 构建前端产物

```bash
npm install
npm run build
```

### 2. 启动方式

**前台启动**（用于临时调试）：

```bash
NODE_ENV=production PORT=1111 npx tsx server.ts
```

**后台启动**（`nohup`）：

```bash
nohup env NODE_ENV=production PORT=1111 npx tsx server.ts > app.log 2>&1 &
```

**开机自启（推荐 `systemd`）**：

创建 `/etc/systemd/system/nginx-visual-manager.service`：

```ini
[Unit]
Description=Nginx Visual Config Manager
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/path/to/your-repo
Environment=NODE_ENV=production
Environment=PORT=1111
ExecStart=/usr/bin/npx tsx server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nginx-visual-manager
sudo systemctl status nginx-visual-manager
```

### 3. 通过 Nginx 托管前端与转发 API（可选）

若希望由宿主机 Nginx 托管 `dist` 静态文件并将 `/api/` 转发到后端服务：

```nginx
server {
    listen 80;
    server_name nginx-mgr.example.com;

    root /path/to/your-repo/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:1111;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 安全建议

- 建议仅在内网环境或配合 HTTPS + 反向代理基础鉴权部署，避免直接将管理端口暴露至公网。
- 请勿将包含敏感配置的 `.env` 文件提交至 Git 仓库。
