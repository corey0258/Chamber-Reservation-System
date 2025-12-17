# 手动备份操作指南

## 问题分析

您遇到的问题是现有的 `backup.js` 脚本只备份了数据库文件，没有进行完整的系统备份。这是因为原脚本设计时只考虑了数据库备份，而没有包含其他重要的系统文件。

## 解决方案

### 方案一：使用新的完整备份脚本（推荐）

我已经为您创建了一个新的完整备份脚本 `scripts/complete-backup.js`，它会备份所有重要文件：

```bash
# 创建完整备份
node scripts/complete-backup.js create

# 查看所有备份
node scripts/complete-backup.js list

# 验证备份完整性
node scripts/complete-backup.js verify <备份路径>
```

### 方案二：手动PowerShell备份命令

如果您需要手动执行备份，可以使用以下PowerShell命令：

#### 1. 创建备份目录

```powershell
# 创建带时间戳的备份目录
$timestamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss-fffZ"
$backupDir = "backups\manual_backup_$timestamp"
New-Item -ItemType Directory -Path $backupDir -Force
Write-Host "📁 创建备份目录: $backupDir" -ForegroundColor Green
```

#### 2. 备份重要文件

```powershell
# 备份数据库文件
if (Test-Path "database.db") {
    Copy-Item "database.db" "$backupDir\database.db"
    Write-Host "✅ 已备份: database.db" -ForegroundColor Green
}

if (Test-Path "database.sqlite") {
    Copy-Item "database.sqlite" "$backupDir\database.sqlite"
    Write-Host "✅ 已备份: database.sqlite" -ForegroundColor Green
}

if (Test-Path "temperature_chamber.db") {
    Copy-Item "temperature_chamber.db" "$backupDir\temperature_chamber.db"
    Write-Host "✅ 已备份: temperature_chamber.db" -ForegroundColor Green
}

# 备份配置文件
if (Test-Path ".env") {
    Copy-Item ".env" "$backupDir\.env"
    Write-Host "✅ 已备份: .env" -ForegroundColor Green
}

if (Test-Path "deployment-config.json") {
    Copy-Item "deployment-config.json" "$backupDir\deployment-config.json"
    Write-Host "✅ 已备份: deployment-config.json" -ForegroundColor Green
}

if (Test-Path "package.json") {
    Copy-Item "package.json" "$backupDir\package.json"
    Write-Host "✅ 已备份: package.json" -ForegroundColor Green
}

if (Test-Path "package-lock.json") {
    Copy-Item "package-lock.json" "$backupDir\package-lock.json"
    Write-Host "✅ 已备份: package-lock.json" -ForegroundColor Green
}
```

#### 3. 备份重要目录

```powershell
# 备份配置目录
if (Test-Path "config") {
    Copy-Item "config" "$backupDir\config" -Recurse
    Write-Host "✅ 已备份: config/" -ForegroundColor Green
}

# 备份上传文件目录
if (Test-Path "uploads") {
    Copy-Item "uploads" "$backupDir\uploads" -Recurse
    Write-Host "✅ 已备份: uploads/" -ForegroundColor Green
}

# 备份现有备份文件
if (Test-Path "backups") {
    Copy-Item "backups" "$backupDir\previous_backups" -Recurse
    Write-Host "✅ 已备份: backups/" -ForegroundColor Green
}
```

#### 4. 创建备份信息文件

```powershell
# 创建备份信息
$backupInfo = @{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    backupType = "manual"
    backupPath = $backupDir
    creator = $env:USERNAME
    computerName = $env:COMPUTERNAME
} | ConvertTo-Json -Depth 3

$backupInfo | Out-File "$backupDir\backup_info.json" -Encoding UTF8
Write-Host "📋 已创建备份信息文件" -ForegroundColor Green
```

### 方案三：一键手动备份脚本

创建一个PowerShell脚本文件 `manual-backup.ps1`：

```powershell
# 完整的一键备份脚本
param(
    [string]$BackupNote = "手动备份"
)

Write-Host "🚀 开始手动备份..." -ForegroundColor Cyan

# 创建备份目录
$timestamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss-fffZ"
$backupDir = "backups\manual_backup_$timestamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

# 要备份的文件列表
$filesToBackup = @(
    "database.db",
    "database.sqlite", 
    "temperature_chamber.db",
    ".env",
    "deployment-config.json",
    "package.json",
    "package-lock.json"
)

# 要备份的目录列表
$dirsToBackup = @(
    "config",
    "uploads"
)

$backupCount = 0
$totalSize = 0

# 备份文件
foreach ($file in $filesToBackup) {
    if (Test-Path $file) {
        Copy-Item $file "$backupDir\$file"
        $size = (Get-Item $file).Length
        $totalSize += $size
        $backupCount++
        Write-Host "✅ 已备份文件: $file ($([math]::Round($size/1KB, 2)) KB)" -ForegroundColor Green
    } else {
        Write-Host "⚠️  文件不存在: $file" -ForegroundColor Yellow
    }
}

# 备份目录
foreach ($dir in $dirsToBackup) {
    if (Test-Path $dir) {
        Copy-Item $dir "$backupDir\$dir" -Recurse
        $dirSize = (Get-ChildItem $dir -Recurse | Measure-Object -Property Length -Sum).Sum
        $totalSize += $dirSize
        $fileCount = (Get-ChildItem $dir -Recurse -File).Count
        $backupCount += $fileCount
        Write-Host "✅ 已备份目录: $dir ($fileCount 个文件, $([math]::Round($dirSize/1KB, 2)) KB)" -ForegroundColor Green
    } else {
        Write-Host "⚠️  目录不存在: $dir" -ForegroundColor Yellow
    }
}

# 创建备份清单
$manifest = @"
# 手动备份清单

## 备份信息
- **备份时间**: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
- **备份类型**: 手动备份
- **备份说明**: $BackupNote
- **操作用户**: $env:USERNAME
- **计算机名**: $env:COMPUTERNAME
- **备份文件数**: $backupCount
- **总大小**: $([math]::Round($totalSize/1MB, 2)) MB

## 备份内容

### 数据库文件
$(if (Test-Path "database.db") { "✅ database.db" } else { "❌ database.db (不存在)" })
$(if (Test-Path "database.sqlite") { "✅ database.sqlite" } else { "❌ database.sqlite (不存在)" })
$(if (Test-Path "temperature_chamber.db") { "✅ temperature_chamber.db" } else { "❌ temperature_chamber.db (不存在)" })

### 配置文件
$(if (Test-Path ".env") { "✅ .env" } else { "❌ .env (不存在)" })
$(if (Test-Path "deployment-config.json") { "✅ deployment-config.json" } else { "❌ deployment-config.json (不存在)" })
$(if (Test-Path "package.json") { "✅ package.json" } else { "❌ package.json (不存在)" })
$(if (Test-Path "package-lock.json") { "✅ package-lock.json" } else { "❌ package-lock.json (不存在)" })

### 目录
$(if (Test-Path "config") { "✅ config/" } else { "❌ config/ (不存在)" })
$(if (Test-Path "uploads") { "✅ uploads/" } else { "❌ uploads/ (不存在)" })

## 恢复说明

### 恢复单个文件
```powershell
# 恢复数据库
Copy-Item "$backupDir\database.db" ".\database.db"

# 恢复配置
Copy-Item "$backupDir\.env" ".\.env"
```

### 恢复整个系统
```powershell
# 停止服务后执行
robocopy "$backupDir" "." /E /XF backup_info.json BACKUP_MANIFEST.md
```

---
*备份路径: $backupDir*
"@

$manifest | Out-File "$backupDir\BACKUP_MANIFEST.md" -Encoding UTF8

# 创建JSON格式的备份信息
$backupInfo = @{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    backupType = "manual"
    backupPath = $backupDir
    note = $BackupNote
    creator = $env:USERNAME
    computerName = $env:COMPUTERNAME
    fileCount = $backupCount
    totalSize = $totalSize
    success = $true
} | ConvertTo-Json -Depth 3

$backupInfo | Out-File "$backupDir\backup_info.json" -Encoding UTF8

Write-Host ""
Write-Host "✅ 手动备份完成!" -ForegroundColor Green
Write-Host "📊 备份统计:" -ForegroundColor Cyan
Write-Host "   - 文件数量: $backupCount" -ForegroundColor White
Write-Host "   - 总大小: $([math]::Round($totalSize/1MB, 2)) MB" -ForegroundColor White
Write-Host "   - 备份路径: $backupDir" -ForegroundColor White
Write-Host "   - 清单文件: $backupDir\BACKUP_MANIFEST.md" -ForegroundColor White
```

## 使用方法

### 使用新的完整备份脚本（推荐）

```bash
# 直接运行完整备份
node scripts/complete-backup.js create
```

### 使用PowerShell手动备份

```powershell
# 方法1：逐步执行上面的命令

# 方法2：保存为脚本文件并执行
# 将上面的一键备份脚本保存为 manual-backup.ps1
# 然后执行：
.\manual-backup.ps1 -BackupNote "开发环境完整备份"
```

## 验证备份完整性

```powershell
# 检查备份目录
$backupDir = "backups\manual_backup_2025-09-28T11-34-43-804Z"  # 替换为实际路径
Get-ChildItem $backupDir -Recurse | Format-Table Name, Length, LastWriteTime

# 验证数据库文件
if (Test-Path "$backupDir\database.db") {
    $originalSize = (Get-Item "database.db").Length
    $backupSize = (Get-Item "$backupDir\database.db").Length
    if ($originalSize -eq $backupSize) {
        Write-Host "✅ 数据库备份完整" -ForegroundColor Green
    } else {
        Write-Host "❌ 数据库备份大小不匹配" -ForegroundColor Red
    }
}
```

## 快速恢复

```powershell
# 从备份恢复（请先停止服务）
$backupDir = "backups\manual_backup_2025-09-28T11-34-43-804Z"  # 替换为实际路径

# 恢复数据库
Copy-Item "$backupDir\database.db" ".\database.db" -Force

# 恢复配置
Copy-Item "$backupDir\.env" ".\.env" -Force
Copy-Item "$backupDir\config" ".\config" -Recurse -Force

# 恢复上传文件
Copy-Item "$backupDir\uploads" ".\uploads" -Recurse -Force
```

## 最佳实践

1. **定期备份**：建议每天或每次重要更改前进行备份
2. **备份验证**：每次备份后验证文件完整性
3. **多地备份**：将重要备份复制到其他位置
4. **清理旧备份**：定期清理过期的备份文件
5. **文档记录**：为每次备份添加说明注释

## 故障排除

### 权限问题
```powershell
# 以管理员身份运行PowerShell
Start-Process PowerShell -Verb RunAs
```

### 磁盘空间不足
```powershell
# 检查磁盘空间
Get-WmiObject -Class Win32_LogicalDisk | Select-Object DeviceID, @{Name="Size(GB)";Expression={[math]::Round($_.Size/1GB,2)}}, @{Name="FreeSpace(GB)";Expression={[math]::Round($_.FreeSpace/1GB,2)}}
```

### 文件被占用
```powershell
# 停止相关服务后再备份
# 或使用卷影复制服务（VSS）
```

---

**总结**：现在您有三种备份方案可选择，推荐使用新创建的 `complete-backup.js` 脚本，它会自动备份所有重要文件并生成详细的备份报告。