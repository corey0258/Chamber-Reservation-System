# 内网环境完整部署操作指南

## 📋 概述

本指南详细说明如何使用 `deploy-to-intranet-fixed.bat` 脚本在内网环境中完成：
- 现有数据库的安全备份
- 外网新代码的重新部署
- 数据完整性保护和恢复

## 🎯 部署脚本功能特点

### ✅ 自动数据保护机制
- **智能检测**：自动检测现有数据库和配置文件
- **多重备份**：创建时间戳备份文件，确保数据安全
- **无缝恢复**：部署完成后自动恢复原有数据

### ✅ 完整部署流程
- **环境检查**：验证部署目录和权限
- **文件部署**：智能复制新代码，排除不必要文件
- **依赖安装**：自动安装生产环境依赖包
- **配置验证**：检查配置文件完整性

## 🚀 完整操作步骤

### 第一步：部署前准备

#### 1.1 检查内网服务器环境
```bash
# 确认Node.js版本（推荐14.x或更高）
node --version

# 确认npm可用
npm --version

# 检查磁盘空间（至少500MB可用空间）
dir C:\ | findstr "可用"
```

#### 1.2 停止现有服务（如果正在运行）
```bash
# 如果使用PM2管理
pm2 stop chamber-system

# 或者直接关闭Node.js进程
taskkill /f /im node.exe
```

#### 1.3 准备部署包
- 将便携包复制到内网服务器
- 解压到临时目录（如：`D:\temp\chamber-deploy\`）

### 第二步：执行自动部署

#### 2.1 以管理员身份运行部署脚本
```bash
# 进入部署包目录
cd D:\temp\chamber-deploy\chamber-system-portable-2025-09-26T03-22-04-993Z\

# 右键点击 deploy-to-intranet-fixed.bat
# 选择"以管理员身份运行"
```

#### 2.2 观察部署过程输出
```
========================================
Chamber Reservation System - Deployment
Version: 1.0.0
Build: 56924988
========================================

[INFO] Checking deployment environment...
[INFO] Creating deployment directory: C:\chamber-system-production
[OK] Found existing database, will protect it
[INFO] Creating pre-deployment backup...
[INFO] Backing up database to: backup-before-deploy-20250926-1430
[OK] Backup completed
[INFO] Starting deployment of new version...
[INFO] Preserving important data files...
[OK] Important files preserved
[INFO] Deploying new files...
[INFO] Restoring important data files...
[OK] Database restored
[OK] Environment config restored
[OK] System config restored
[INFO] Installing dependencies...
[INFO] Configuration check...
[INFO] Deployment validation...
[SUCCESS] Deployment completed!
```

### 第三步：部署后验证

#### 3.1 检查部署结果
```bash
# 进入生产目录
cd C:\chamber-system-production

# 检查关键文件
dir database.db
dir .env
dir package.json
dir app.js
```

#### 3.2 验证数据完整性
```bash
# 启动系统进行测试
npm start

# 或使用PM2启动
pm2 start app.js --name chamber-system
```

#### 3.3 访问系统验证
- 打开浏览器访问：`http://localhost:3000`
- 登录系统检查数据是否完整
- 测试主要功能模块

## 🔒 数据备份详细说明

### 自动备份内容
脚本会自动备份以下重要文件：

#### 数据库文件
- **源文件**：`C:\chamber-system-production\database.db`
- **备份位置**：`C:\chamber-system-production\backups\backup-before-deploy-[时间戳].db`

#### 环境配置
- **源文件**：`C:\chamber-system-production\.env`
- **备份位置**：`C:\chamber-system-production\backups\backup-before-deploy-[时间戳].env`

#### 系统配置
- **源文件**：`C:\chamber-system-production\config\system-config.json`
- **备份位置**：`C:\chamber-system-production\backups\backup-before-deploy-[时间戳]-config.json`

#### 上传文件
- **源目录**：`C:\chamber-system-production\uploads\`
- **临时保护**：部署过程中临时保存，部署完成后恢复

### 备份文件命名规则
```
backup-before-deploy-[年月日]-[时分].扩展名
示例：backup-before-deploy-20250926-1430.db
```

## 🛠️ 手动备份操作（可选）

如需额外的手动备份保障：

### 创建完整备份
```bash
# 创建备份目录
mkdir D:\chamber-backup-%date:~0,4%%date:~5,2%%date:~8,2%

# 备份整个生产目录
xcopy C:\chamber-system-production D:\chamber-backup-%date:~0,4%%date:~5,2%%date:~8,2%\ /E /I /Y

# 压缩备份（可选）
powershell Compress-Archive -Path "D:\chamber-backup-*" -DestinationPath "D:\chamber-full-backup.zip"
```

## ⚠️ 重要注意事项

### 部署前检查清单
- [ ] 确认有管理员权限
- [ ] 检查磁盘空间充足（>500MB）
- [ ] 确认Node.js和npm环境正常
- [ ] 停止现有服务进程
- [ ] 确认网络连接正常（用于npm安装）

### 数据安全保障
- [ ] 脚本自动创建时间戳备份
- [ ] 部署过程中数据文件受到保护
- [ ] 失败时可以从备份快速恢复
- [ ] 支持多次部署，每次都有独立备份

### 故障恢复
如果部署失败，可以手动恢复：
```bash
# 进入备份目录
cd C:\chamber-system-production\backups

# 查看可用备份
dir backup-before-deploy-*

# 恢复数据库
copy backup-before-deploy-[最新时间戳].db ..\database.db

# 恢复配置
copy backup-before-deploy-[最新时间戳].env ..\.env
```

## 📞 技术支持

如遇到问题，请提供以下信息：
1. 部署脚本的完整输出日志
2. 错误信息截图
3. 系统环境信息（Windows版本、Node.js版本）
4. 网络环境描述（是否能访问npm仓库）

---

**✅ 使用此指南，您可以安全、可靠地在内网环境中完成系统部署，确保数据完整性和业务连续性。**