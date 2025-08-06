#!/bin/bash

# GitLab Claude Webhook Service - Rocky Linux 一键部署脚本
# 适用于 Rocky Linux 8/9

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# 检查是否为root用户
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_error "请不要使用root用户运行此脚本，请使用普通用户"
        exit 1
    fi
}

# 检查系统版本
check_system() {
    if ! grep -q "Rocky Linux" /etc/os-release; then
        log_warn "此脚本专为Rocky Linux设计，其他系统可能需要调整"
    fi
    
    log_info "系统信息："
    cat /etc/os-release | grep -E "NAME|VERSION"
}

# 安装系统依赖
install_system_deps() {
    log_step "安装系统依赖包..."
    
    sudo dnf update -y
    sudo dnf install -y epel-release
    sudo dnf install -y \
        git \
        curl \
        wget \
        openssl \
        ca-certificates \
        gnupg \
        lsb-release \
        yum-utils
}

# 安装Docker
install_docker() {
    log_step "安装Docker..."
    
    # 移除旧版本
    sudo dnf remove -y docker \
        docker-client \
        docker-client-latest \
        docker-common \
        docker-latest \
        docker-latest-logrotate \
        docker-logrotate \
        docker-engine \
        podman \
        runc || true
    
    # 添加Docker官方仓库
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    
    # 安装Docker
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    # 启动Docker服务
    sudo systemctl start docker
    sudo systemctl enable docker
    
    # 添加用户到docker组
    sudo usermod -aG docker $USER
    
    log_info "Docker安装完成！"
    docker --version
}

# 安装Claude Code CLI
install_claude_cli() {
    log_step "安装Claude Code CLI..."
    
    # 检查是否已安装
    if command -v claude &> /dev/null; then
        log_info "Claude CLI 已安装: $(claude --version)"
        return 0
    fi
    
    # 下载并安装Claude CLI
    log_info "下载Claude Code CLI..."
    
    # 检测系统架构
    ARCH=$(uname -m)
    if [[ "$ARCH" == "x86_64" ]]; then
        CLAUDE_ARCH="x86_64"
    elif [[ "$ARCH" == "aarch64" ]]; then
        CLAUDE_ARCH="aarch64"
    else
        log_error "不支持的系统架构: $ARCH"
        exit 1
    fi
    
    # 获取最新版本信息
    LATEST_VERSION=$(curl -s https://api.github.com/repos/anthropics/claude-code/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
    if [[ -z "$LATEST_VERSION" ]]; then
        log_error "无法获取Claude CLI最新版本信息"
        exit 1
    fi
    
    log_info "下载Claude CLI ${LATEST_VERSION}..."
    
    # 下载并安装
    DOWNLOAD_URL="https://github.com/anthropics/claude-code/releases/download/${LATEST_VERSION}/claude-${LATEST_VERSION}-linux-${CLAUDE_ARCH}.tar.gz"
    
    cd /tmp
    wget -O claude.tar.gz "$DOWNLOAD_URL"
    tar -xzf claude.tar.gz
    sudo mv claude /usr/local/bin/
    sudo chmod +x /usr/local/bin/claude
    
    # 清理下载文件
    rm -f claude.tar.gz
    
    log_info "Claude CLI 安装完成: $(claude --version)"
}

# 创建项目目录和配置
setup_project() {
    log_step "设置项目环境..."
    
    # 创建项目目录
    PROJECT_DIR="$HOME/gitlab-claude-webhook"
    
    if [[ -d "$PROJECT_DIR" ]]; then
        log_warn "项目目录已存在，是否继续? (y/n)"
        read -r response
        if [[ "$response" != "y" && "$response" != "Y" ]]; then
            log_info "部署取消"
            exit 0
        fi
    fi
    
    mkdir -p "$PROJECT_DIR"
    cd "$PROJECT_DIR"
    
    # 如果当前目录没有项目文件，克隆项目
    if [[ ! -f "package.json" ]]; then
        log_info "请提供GitLab Claude Webhook项目的Git仓库URL:"
        read -r REPO_URL
        
        if [[ -n "$REPO_URL" ]]; then
            git clone "$REPO_URL" .
        else
            log_error "需要项目源代码才能继续部署"
            exit 1
        fi
    fi
    
    log_info "项目目录: $PROJECT_DIR"
}

# 配置环境变量
setup_environment() {
    log_step "配置环境变量..."
    
    ENV_FILE=".env"
    
    if [[ -f "$ENV_FILE" ]]; then
        log_info "环境配置文件已存在，是否重新配置? (y/n)"
        read -r response
        if [[ "$response" != "y" && "$response" != "Y" ]]; then
            return 0
        fi
    fi
    
    log_info "请输入以下配置信息："
    
    echo "# GitLab Claude Webhook Service 环境配置" > "$ENV_FILE"
    echo "# 生成时间: $(date)" >> "$ENV_FILE"
    echo "" >> "$ENV_FILE"
    
    # Anthropic API配置
    echo "# Claude API配置" >> "$ENV_FILE"
    read -p "Anthropic API Token (sk-...): " ANTHROPIC_TOKEN
    echo "ANTHROPIC_BASE_URL=https://api.anthropic.com" >> "$ENV_FILE"
    echo "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_TOKEN" >> "$ENV_FILE"
    echo "" >> "$ENV_FILE"
    
    # GitLab配置
    echo "# GitLab配置" >> "$ENV_FILE"
    read -p "GitLab Base URL (默认: https://gitlab.com): " GITLAB_URL
    GITLAB_URL=${GITLAB_URL:-"https://gitlab.com"}
    read -p "GitLab Token (glpat-...): " GITLAB_TOKEN
    echo "GITLAB_BASE_URL=$GITLAB_URL" >> "$ENV_FILE"
    echo "GITLAB_TOKEN=$GITLAB_TOKEN" >> "$ENV_FILE"
    echo "" >> "$ENV_FILE"
    
    # Webhook配置
    echo "# Webhook配置" >> "$ENV_FILE"
    read -p "Webhook Secret (用于验证GitLab webhook): " WEBHOOK_SECRET
    read -p "服务端口 (默认: 3000): " SERVICE_PORT
    SERVICE_PORT=${SERVICE_PORT:-"3000"}
    echo "WEBHOOK_SECRET=$WEBHOOK_SECRET" >> "$ENV_FILE"
    echo "PORT=$SERVICE_PORT" >> "$ENV_FILE"
    echo "" >> "$ENV_FILE"
    
    # 其他配置
    echo "# 其他配置" >> "$ENV_FILE"
    echo "WORK_DIR=/tmp/gitlab-claude-work" >> "$ENV_FILE"
    echo "LOG_LEVEL=info" >> "$ENV_FILE"
    
    log_info "环境配置完成: $ENV_FILE"
}

# 配置防火墙
setup_firewall() {
    log_step "配置防火墙..."
    
    # 检查firewalld状态
    if systemctl is-active --quiet firewalld; then
        log_info "配置firewalld规则..."
        
        # 获取端口号
        SERVICE_PORT=$(grep "^PORT=" .env | cut -d'=' -f2 | tr -d '"' || echo "3000")
        
        sudo firewall-cmd --permanent --add-port=${SERVICE_PORT}/tcp
        sudo firewall-cmd --reload
        
        log_info "防火墙配置完成，已开放端口: $SERVICE_PORT"
    else
        log_info "firewalld未运行，跳过防火墙配置"
    fi
}

# 创建systemd服务
setup_systemd() {
    log_step "创建systemd服务..."
    
    SERVICE_FILE="/etc/systemd/system/gitlab-claude-webhook.service"
    
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=GitLab Claude Webhook Service
After=network.target docker.service
Requires=docker.service

[Service]
Type=forking
User=$USER
Group=$USER
WorkingDirectory=$PWD
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down
ExecReload=/usr/bin/docker-compose restart
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    
    sudo systemctl daemon-reload
    sudo systemctl enable gitlab-claude-webhook
    
    log_info "systemd服务配置完成"
}

# 构建和启动服务
deploy_service() {
    log_step "构建和启动服务..."
    
    # 构建Docker镜像
    log_info "构建Docker镜像..."
    docker-compose build
    
    # 启动服务
    log_info "启动服务..."
    docker-compose up -d
    
    # 等待服务启动
    log_info "等待服务启动..."
    sleep 10
    
    # 检查服务状态
    if docker-compose ps | grep -q "Up"; then
        log_info "✅ 服务启动成功！"
        
        SERVICE_PORT=$(grep "^PORT=" .env | cut -d'=' -f2 | tr -d '"' || echo "3000")
        log_info "服务访问地址: http://$(hostname -I | awk '{print $1}'):$SERVICE_PORT"
        log_info "健康检查: http://$(hostname -I | awk '{print $1}'):$SERVICE_PORT/health"
        
        # 运行健康检查
        if [[ -f "scripts/health-check.sh" ]]; then
            log_info "运行健康检查..."
            bash scripts/health-check.sh
        fi
    else
        log_error "❌ 服务启动失败！"
        log_error "查看日志: docker-compose logs -f"
        exit 1
    fi
}

# 输出部署信息
show_deployment_info() {
    log_step "部署信息"
    
    SERVICE_PORT=$(grep "^PORT=" .env | cut -d'=' -f2 | tr -d '"' || echo "3000")
    SERVER_IP=$(hostname -I | awk '{print $1}')
    
    echo "=================================================="
    echo "🎉 GitLab Claude Webhook Service 部署完成！"
    echo "=================================================="
    echo ""
    echo "📍 服务信息："
    echo "  - 服务地址: http://$SERVER_IP:$SERVICE_PORT"
    echo "  - 健康检查: http://$SERVER_IP:$SERVICE_PORT/health"
    echo "  - Webhook URL: http://$SERVER_IP:$SERVICE_PORT/webhook"
    echo ""
    echo "📁 项目目录: $PWD"
    echo ""
    echo "🔧 管理命令："
    echo "  - 查看日志: docker-compose logs -f"
    echo "  - 重启服务: docker-compose restart"
    echo "  - 停止服务: docker-compose down"
    echo "  - 更新服务: git pull && docker-compose up -d --build"
    echo ""
    echo "⚙️  GitLab Webhook 配置："
    echo "  1. 进入GitLab项目 → Settings → Webhooks"
    echo "  2. URL: http://$SERVER_IP:$SERVICE_PORT/webhook"
    echo "  3. Secret Token: $(grep "^WEBHOOK_SECRET=" .env | cut -d'=' -f2)"
    echo "  4. 勾选: Issues events, Merge request events, Comments"
    echo ""
    echo "📖 使用说明："
    echo "  在GitLab Issue或MR中添加 '@claude <指令>' 即可触发AI处理"
    echo ""
}

# 主函数
main() {
    log_info "开始部署 GitLab Claude Webhook Service..."
    
    check_root
    check_system
    install_system_deps
    install_docker
    install_claude_cli
    setup_project
    setup_environment
    setup_firewall
    setup_systemd
    deploy_service
    show_deployment_info
    
    log_info "部署完成！"
}

# 执行主函数
main "$@"