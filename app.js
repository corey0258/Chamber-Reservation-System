const express = require('express');
const Database = require('sqlite3').Database;
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const moment = require('moment');
const nodemailer = require('nodemailer');
const engine = require('ejs-mate');
require('dotenv').config();

// 简单的内存缓存实现，用于减少数据库查询
class SimpleCache {
    constructor(maxSize = 100) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    
    get(key) {
        return this.cache.get(key);
    }
    
    set(key, value) {
        // 如果缓存已满，删除最早添加的项
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
    
    clear() {
        this.cache.clear();
    }
}

// 创建通知缓存实例
const notificationCache = new SimpleCache(50);

const app = express();
const PORT = process.env.PORT || 3002;

// Configure multer for form data parsing (no file uploads needed)
const upload = multer();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.engine('ejs', engine);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'temperature-chamber-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Email config helpers (must be defined before creating transporter)
const EMAIL_USER = process.env.EMAIL_USER || 'your-email@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'your-app-password';
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'gmail';
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : undefined;
const EMAIL_SECURE = process.env.EMAIL_SECURE === 'true';
const emailConfigured = Boolean(
    process.env.EMAIL_USER && process.env.EMAIL_PASS &&
    !EMAIL_USER.includes('your-email') && !EMAIL_PASS.includes('your-app-password')
);
// 新增：管理员接收通知邮箱，未配置则回退到系统发件人
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || EMAIL_USER;

let transporterOptions;
if (EMAIL_HOST) {
    // 自定义SMTP
    transporterOptions = {
        host: EMAIL_HOST,
        port: EMAIL_PORT || 587,
        secure: EMAIL_SECURE || false,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS,
        },
    };
} else {
    // 使用已知服务提供商（如gmail、qq、163等）
    transporterOptions = {
        service: EMAIL_SERVICE,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS,
        },
    };
}
const emailTransporter = nodemailer.createTransport(transporterOptions);

// SMTP 连接自检（应用启动时执行一次，仅用于快速判断配置是否可用）
if (emailConfigured) {
    // 使用 setTimeout 来异步执行 SMTP 检查，避免阻塞应用启动
    setTimeout(() => {
        emailTransporter.verify()
          .then(() => {
            console.log('SMTP 连接正常: transporter.verify() 通过');
          })
          .catch((err) => {
            console.error('SMTP 连接失败:', err && err.message ? err.message : String(err));
            console.log('注意: SMTP连接失败不会影响应用运行，邮件功能将被禁用');
          });
    }, 1000); // 延迟1秒执行，确保应用已完全启动
} else {
    console.log('邮件未配置，跳过SMTP连接检查');
}

// Database setup
const db = new Database('./database.db');

// Initialize database
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Add status column to existing users table if it doesn't exist
    db.run(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding status column:', err);
        }
    });

    // Fix email column constraint - recreate users table to allow NULL email
    db.run(`PRAGMA table_info(users)`, [], (err, rows) => {
        if (err) {
            console.error('Error checking users table structure:', err);
            return;
        }
        
        // Check if we need to recreate the table to fix email constraint
        db.all(`PRAGMA table_info(users)`, [], (err, columns) => {
            if (err) {
                console.error('Error getting table info:', err);
                return;
            }
            
            const emailColumn = columns.find(col => col.name === 'email');
            if (emailColumn && emailColumn.notnull === 1) {
                console.log('Fixing email column constraint to allow NULL values...');
                
                // Create backup table
                db.run(`CREATE TABLE users_backup AS SELECT * FROM users`, [], (err) => {
                    if (err) {
                        console.error('Error creating backup table:', err);
                        return;
                    }
                    
                    // Drop original table
                    db.run(`DROP TABLE users`, [], (err) => {
                        if (err) {
                            console.error('Error dropping original table:', err);
                            return;
                        }
                        
                        // Recreate table with correct schema
                        db.run(`CREATE TABLE users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT UNIQUE NOT NULL,
                            email TEXT UNIQUE,
                            password TEXT NOT NULL,
                            role TEXT DEFAULT 'user',
                            status TEXT DEFAULT 'pending',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )`, [], (err) => {
                            if (err) {
                                console.error('Error recreating users table:', err);
                                return;
                            }
                            
                            // Restore data with explicit column mapping
                            db.run(`INSERT INTO users (id, username, email, password, role, status, created_at) 
                                    SELECT id, username, email, password, role, status, created_at FROM users_backup`, [], (err) => {
                                if (err) {
                                    console.error('Error restoring data:', err);
                                    return;
                                }
                                
                                // Drop backup table
                                db.run(`DROP TABLE users_backup`, [], (err) => {
                                    if (err) {
                                        console.error('Error dropping backup table:', err);
                                    } else {
                                        console.log('Successfully fixed email column constraint');
                                    }
                                });
                            });
                        });
                    });
                });
            }
        });
    });
    
    // Add fw_version column to existing reservations table if it doesn't exist
    db.run(`ALTER TABLE reservations ADD COLUMN fw_version TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding fw_version column:', err);
        }
    });
    
    // Add location column to existing chambers table if it doesn't exist
    db.run(`ALTER TABLE chambers ADD COLUMN location TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding location column:', err);
        }
    });
    
    // Add test_item column to existing chambers table if it doesn't exist
    db.run(`ALTER TABLE chambers ADD COLUMN test_item TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding test_item column:', err);
        }
    });
    
    // Add project column to existing chambers table if it doesn't exist
    db.run(`ALTER TABLE chambers ADD COLUMN project TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding project column:', err);
        }
    });
    
    // User notifications table
    db.run(`CREATE TABLE IF NOT EXISTS user_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        related_id INTEGER,
        related_type TEXT,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    // Add indexes for faster queries - 优化版本
    // 用户通知索引
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id ON user_notifications (user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_notifications_is_read ON user_notifications (is_read)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_notifications_created_at ON user_notifications (created_at)`);
    
    // 用户状态索引
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_status_created ON users (status, created_at)`);
    
    // 预约状态索引
    db.run(`CREATE INDEX IF NOT EXISTS idx_reservations_status_created ON reservations (status, created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reservations_user_updated ON reservations (user_id, updated_at)`);
    
    // 系统通知索引
    db.run(`CREATE INDEX IF NOT EXISTS idx_system_notifications_created_target ON system_notifications (created_at, target_role)`);


    // Temperature chambers table
    db.run(`CREATE TABLE IF NOT EXISTS chambers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        temperature_range TEXT,
        capacity TEXT,
        status TEXT DEFAULT 'available',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Platforms table
    db.run(`CREATE TABLE IF NOT EXISTS platforms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chamber_id INTEGER NOT NULL,
        client_uuid TEXT NOT NULL,
        mb TEXT NOT NULL,
        cpu TEXT NOT NULL,
        os TEXT NOT NULL,
        max_link_speed TEXT NOT NULL,
        project TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '闲置',
        test_item TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chamber_id) REFERENCES chambers (id) ON DELETE CASCADE
    )`);

    // Reservations table
    db.run(`CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chamber_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        project_leader TEXT NOT NULL,
        department TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        test_item TEXT NOT NULL,
        temperature_range TEXT,
        sample_count INTEGER,
        special_requirements TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (chamber_id) REFERENCES chambers (id)
    )`);

    // System announcements table
    db.run(`CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`); 
    
    // System notifications table
    db.run(`CREATE TABLE IF NOT EXISTS system_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        target_role TEXT DEFAULT 'all',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Queue requests table
    db.run(`CREATE TABLE IF NOT EXISTS queue_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chamber_id INTEGER,
        applicant_name TEXT NOT NULL,
        project_name TEXT NOT NULL,
        temperature_range TEXT NOT NULL,
        plate_count INTEGER NOT NULL,
        urgency_level TEXT NOT NULL,
        description TEXT,
        queue_date DATE,
        status TEXT DEFAULT 'pending',
        processed_at DATETIME,
        processed_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (chamber_id) REFERENCES chambers (id),
        FOREIGN KEY (processed_by) REFERENCES users (id)
    )`);

    // Schema migration: ensure legacy databases have required columns
    db.all(`PRAGMA table_info(queue_requests)`, (err, columns) => {
        if (err) {
            console.error('Error checking queue_requests schema', err);
        } else {
            const columnNames = columns.map(col => col.name);
            
            // 检查并添加chamber_id列
            if (!columnNames.includes('chamber_id')) {
                db.run(`ALTER TABLE queue_requests ADD COLUMN chamber_id INTEGER REFERENCES chambers(id)`, (err) => {
                    if (err) {
                        console.error('Error adding chamber_id column to queue_requests', err);
                    } else {
                        console.log('Added chamber_id column to queue_requests table');
                    }
                });
            }
            
            // 检查并添加queue_date列
            if (!columnNames.includes('queue_date')) {
                db.run(`ALTER TABLE queue_requests ADD COLUMN queue_date DATE`, (err) => {
                    if (err) {
                        console.error('Error adding queue_date column to queue_requests', err);
                    } else {
                        console.log('Added queue_date column to queue_requests table');
                    }
                });
            }
            
            // 检查并添加expected_chamber列
            if (!columnNames.includes('expected_chamber')) {
                db.run(`ALTER TABLE queue_requests ADD COLUMN expected_chamber TEXT`, (err) => {
                    if (err) {
                        console.error('Error adding expected_chamber column to queue_requests', err);
                    } else {
                        console.log('Added expected_chamber column to queue_requests table');
                    }
                });
            }
            
            // 检查并添加test_item列
            if (!columnNames.includes('test_item')) {
                db.run(`ALTER TABLE queue_requests ADD COLUMN test_item TEXT`, (err) => {
                    if (err) {
                        console.error('Error adding test_item column to queue_requests', err);
                    } else {
                        console.log('Added test_item column to queue_requests table');
                    }
                });
            }
            
            // 检查并添加fw_version列
            if (!columnNames.includes('fw_version')) {
                db.run(`ALTER TABLE queue_requests ADD COLUMN fw_version TEXT`, (err) => {
                    if (err) {
                        console.error('Error adding fw_version column to queue_requests', err);
                    } else {
                        console.log('Added fw_version column to queue_requests table');
                    }
                });
            }
        }
    });
    
    db.all(`PRAGMA table_info(announcements)`, (err, columns) => {
        if (err) {
            console.error('Error checking announcements schema', err);
        } else {
            const names = Array.isArray(columns) ? columns.map(c => c.name) : [];
            const ensureColumn = (name, ddl) => {
                if (!names.includes(name)) {
                    db.run(ddl, [], (e) => e && console.error(`Error adding column ${name} to announcements`, e));
                }
            };
            ensureColumn('type', `ALTER TABLE announcements ADD COLUMN type TEXT DEFAULT 'info'`);
            ensureColumn('is_active', `ALTER TABLE announcements ADD COLUMN is_active INTEGER DEFAULT 1`);
            ensureColumn('created_at', `ALTER TABLE announcements ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
            ensureColumn('updated_at', `ALTER TABLE announcements ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
            // backfill
            db.run(`UPDATE announcements SET is_active = 1 WHERE is_active IS NULL`, [], (e) => e && console.error('Error backfilling is_active', e));
        }
    });

    // Insert default admin user if not exists and set as active
    const adminPassword = bcrypt.hashSync('admin123', 10);
    // 使用环境变量中的管理员邮箱，如果未设置则使用EMAIL_USER
    const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || EMAIL_USER || '9559818@qq.com';
    db.run(`INSERT OR IGNORE INTO users (username, email, password, role, status) VALUES (?, ?, ?, ?, ?)`,
      ['admin', DEFAULT_ADMIN_EMAIL, adminPassword, 'admin', 'active']);

    // Update existing admin user to active if exists and update email if needed
    db.run(`UPDATE users SET status = 'active', email = ? WHERE username = 'admin' AND role = 'admin'`, [DEFAULT_ADMIN_EMAIL]);

    // 只在数据库中没有温箱记录时才插入默认温箱
    db.get('SELECT COUNT(*) as count FROM chambers', [], (err, row) => {
        if (err) {
            console.error('检查温箱数量失败:', err);
            return;
        }
        
        // 只有当数据库中没有温箱记录时才插入默认温箱
        if (row.count === 0) {
            console.log('数据库中没有温箱记录，插入默认温箱数据');
            const defaultChambers = [
                { name: '温箱A', description: '标准温箱，温度范围-40℃~85℃', temperature_range: '-40℃~85℃', capacity: '100L', location: 'A区-1号位' },
                { name: '温箱B', description: '高精度温箱，温度范围-70℃~150℃', temperature_range: '-70℃~150℃', capacity: '150L', location: 'A区-2号位' },
                { name: '温箱C', description: '大容量温箱，温度范围-40℃~100℃', temperature_range: '-40℃~100℃', capacity: '300L', location: 'B区-1号位' },
                { name: '温箱D', description: '快速温变箱，温度范围-60℃~120℃', temperature_range: '-60℃~120℃', capacity: '200L', location: 'B区-2号位' },
                { name: '温箱E', description: '小型温箱，温度范围-20℃~85℃', temperature_range: '-20℃~85℃', capacity: '50L', location: 'C区-1号位' },
                { name: '温箱F', description: '防爆温箱，温度范围-40℃~80℃', temperature_range: '-40℃~80℃', capacity: '120L', location: 'C区-2号位' },
                { name: '温箱G', description: '真空温箱，温度范围-60℃~100℃', temperature_range: '-60℃~100℃', capacity: '180L', location: 'D区-1号位' },
                { name: '温箱H', description: '步入式温箱，温度范围-40℃~85℃', temperature_range: '-40℃~85℃', capacity: '500L', location: 'D区-2号位' }
            ];

            for (const chamber of defaultChambers) {
                db.run('INSERT INTO chambers (name, description, temperature_range, capacity, location) VALUES (?, ?, ?, ?, ?)',
                  [chamber.name, chamber.description, chamber.temperature_range, chamber.capacity, chamber.location]);
            }
        } else {
            console.log(`数据库中已有 ${row.count} 个温箱记录，跳过默认温箱插入`);
        }
    });
    
    // 检查并插入默认平台数据
    db.get('SELECT COUNT(*) as count FROM platforms', async (err, row) => {
        if (err) {
            console.error('检查平台数量失败:', err);
            return;
        }
        
        if (row.count === 0) {
            console.log('数据库中没有平台记录，插入默认平台数据');
            const defaultPlatforms = [
                { chamber_id: 1, client_uuid: 'PLATFORM-001', mb: 'ASUS ROG STRIX B550-F', cpu: 'AMD Ryzen 7 5800X', os: 'Windows 11 Pro', max_link_speed: '1000Mbps', project: '高温测试项目A', status: 'testing', test_item: 'CPU压力测试' },
                { chamber_id: 1, client_uuid: 'PLATFORM-002', mb: 'MSI MAG B550 TOMAHAWK', cpu: 'AMD Ryzen 5 5600X', os: 'Windows 10 Pro', max_link_speed: '1000Mbps', project: '稳定性测试项目B', status: 'idle', test_item: '内存稳定性测试' },
                { chamber_id: 2, client_uuid: 'PLATFORM-003', mb: 'GIGABYTE B450 AORUS PRO', cpu: 'AMD Ryzen 9 5900X', os: 'Ubuntu 20.04 LTS', max_link_speed: '1000Mbps', project: '低温环境测试C', status: 'testing', test_item: 'GPU性能测试' },
                { chamber_id: 3, client_uuid: 'PLATFORM-004', mb: 'ASRock X570 Steel Legend', cpu: 'AMD Ryzen 7 5700G', os: 'Windows 11 Pro', max_link_speed: '1000Mbps', project: '温度循环测试D', status: 'maintenance', test_item: '系统稳定性测试' },
                { chamber_id: 4, client_uuid: 'PLATFORM-005', mb: 'ASUS TUF GAMING X570-PLUS', cpu: 'AMD Ryzen 9 5950X', os: 'CentOS 8', max_link_speed: '1000Mbps', project: '极限温度测试E', status: 'idle', test_item: '散热系统测试' }
            ];
            
            for (const platform of defaultPlatforms) {
                db.run(`INSERT INTO platforms (chamber_id, client_uuid, mb, cpu, os, max_link_speed, project, status, test_item, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [platform.chamber_id, platform.client_uuid, platform.mb, platform.cpu, platform.os, platform.max_link_speed, platform.project, platform.status, platform.test_item]);
            }
            console.log('默认平台数据插入完成');
        } else {
            console.log(`数据库中已有 ${row.count} 个平台记录，跳过默认平台插入`);
        }
    });

    // Insert default announcements if not exists
    const defaultAnnouncements = [
        {
            title: '系统更新',
            content: '新增实时可用性检查功能，预约更便捷！',
            type: 'info'
        },
        {
            title: '使用须知',
            content: '请提前1天预约，使用后及时清理设备。如需取消预约，请提前24小时操作。设备使用过程中如有问题，请联系管理员。',
            type: 'warning'
        }
    ];

    for (const announcement of defaultAnnouncements) {
        db.run('INSERT OR IGNORE INTO announcements (title, content, type) VALUES (?, ?, ?)',
          [announcement.title, announcement.content, announcement.type]);
    }
});

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        // For API routes, return JSON error
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ error: '请先登录' });
        } else {
            res.redirect('/login');
        }
    }
}

function requireAdmin(req, res, next) {
    if (req.session.userId && req.session.userRole === 'admin') {
        next();
    } else {
        // For API routes, return JSON error
        if (req.path.startsWith('/api/')) {
            res.status(403).json({ error: '需要管理员权限' });
        } else {
            res.redirect('/');
        }
    }
}

// Routes
app.get('/', (req, res) => {
    res.render('index', { title: '首页', user: req.session.username, role: req.session.userRole });
});

// Database helpers to promisify sqlite3 callbacks
function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// 重新排列温箱ID，使其连续
async function reorderChamberIds() {
    try {
        // 获取所有温箱，按ID排序
        const chambers = await dbAll('SELECT * FROM chambers ORDER BY id');
        
        // 如果没有温箱，直接返回
        if (chambers.length === 0) return;
        
        // 创建临时表
        await dbRun('CREATE TEMPORARY TABLE chambers_temp AS SELECT * FROM chambers');
        
        // 清空原表
        await dbRun('DELETE FROM chambers');
        
        // 重新插入数据，ID从1开始连续
        for (let i = 0; i < chambers.length; i++) {
            const chamber = chambers[i];
            await dbRun(`
                INSERT INTO chambers (id, name, description, temperature_range, capacity, location, status, fw_version, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [i + 1, chamber.name, chamber.description, chamber.temperature_range, chamber.capacity, chamber.location, chamber.status, chamber.fw_version, chamber.created_at]);
        }
        
        // 更新相关表中的chamber_id引用
        for (let i = 0; i < chambers.length; i++) {
            const oldId = chambers[i].id;
            const newId = i + 1;
            
            if (oldId !== newId) {
                // 更新reservations表
                await dbRun('UPDATE reservations SET chamber_id = ? WHERE chamber_id = ?', [newId, oldId]);
                // 更新queue_requests表
                await dbRun('UPDATE queue_requests SET chamber_id = ? WHERE chamber_id = ?', [newId, oldId]);
            }
        }
        
        // 删除临时表
        await dbRun('DROP TABLE chambers_temp');
        
        console.log('温箱ID重新排列完成');
    } catch (error) {
        console.error('重新排列温箱ID失败:', error);
        throw error;
    }
}

app.get('/api/chambers/:id/availability', async (req, res) => {
  try {
    const chamberId = req.params.id;
    const { start_date, end_date } = req.query;
    const query = `
            SELECT * FROM reservations 
            WHERE chamber_id = ? AND status = 'approved'
            AND ((start_date <= ? AND end_date >= ?) OR (start_date <= ? AND end_date >= ?))
        `;
    const conflicts = await dbAll(query, [chamberId, start_date, start_date, end_date, end_date]);
    res.json({ available: conflicts.length === 0, conflicts });
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/chambers/:id/schedule', async (req, res) => {
  try {
    const chamberId = req.params.id;
    const { month } = req.query;
    const query = `
            SELECT * FROM reservations 
            WHERE chamber_id = ? AND status = 'approved'
            AND strftime('%Y-%m', start_date) = ?
            ORDER BY start_date
        `;
    const reservations = await dbAll(query, [chamberId, month]);
    res.json(reservations);
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// API 路由 - 获取正在使用中的温箱
app.get('/api/chambers/active', requireAuth, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // 获取当前有预约的温箱
        const activeChambers = await dbAll(`
            SELECT DISTINCT c.* 
            FROM chambers c
            JOIN reservations r ON c.id = r.chamber_id
            WHERE r.status = 'approved'
              AND DATE(?) >= DATE(r.start_date)
              AND DATE(?) <= DATE(r.end_date)
            ORDER BY c.name
        `, [today, today]);
        
        res.json({ success: true, chambers: activeChambers });
    } catch (error) {
        console.error('Error fetching active chambers:', error);
        res.status(500).json({ success: false, message: '获取正在使用中的温箱时发生错误' });
    }
});

// API 路由 - 获取温箱的预约日期
app.get('/api/chambers/:id/reservations', requireAuth, async (req, res) => {
    try {
        const chamberId = req.params.id;
        
        // 获取温箱的所有预约
        const reservations = await dbAll(`
            SELECT id, chamber_id, user_id, project_name, start_date, end_date
            FROM reservations
            WHERE chamber_id = ? AND status = 'approved'
            ORDER BY start_date
        `, [chamberId]);
        
        res.json({ success: true, reservations });
    } catch (error) {
        console.error('Error fetching chamber reservations:', error);
        res.status(500).json({ success: false, message: '获取温箱预约日期时发生错误' });
    }
});

// Dashboard API endpoints
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const totalChambers = await dbGet('SELECT COUNT(*) as count FROM chambers');
        const totalReservations = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE user_id = ?', [req.session.userId]);
        const pendingReservations = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE user_id = ? AND status = "pending"', [req.session.userId]);
        const availableChambers = await dbGet('SELECT COUNT(*) as count FROM chambers WHERE status = "available"');

        const statusStats = await dbGet(`
            SELECT 
                SUM(CASE WHEN c.status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_count,
                SUM(CASE WHEN ((c.status = 'available' AND EXISTS (
                    SELECT 1 FROM reservations r 
                    WHERE r.chamber_id = c.id 
                      AND r.status = 'approved'
                      AND DATE('now','localtime') >= DATE(r.start_date)
                      AND DATE('now','localtime') <= DATE(r.end_date)
                )) OR c.status = 'in_use') THEN 1 ELSE 0 END) AS in_use_count,
                SUM(CASE WHEN c.status = 'available' AND NOT EXISTS (
                    SELECT 1 FROM reservations r 
                    WHERE r.chamber_id = c.id 
                      AND r.status = 'approved'
                      AND DATE('now','localtime') >= DATE(r.start_date)
                      AND DATE('now','localtime') <= DATE(r.end_date)
                ) THEN 1 ELSE 0 END) AS available_count,
                SUM(CASE WHEN c.status <> 'maintenance' AND EXISTS (
                    SELECT 1 FROM reservations r 
                    WHERE r.chamber_id = c.id 
                      AND r.status = 'approved'
                      AND DATE('now','localtime') >= DATE(r.start_date)
                      AND DATE('now','localtime') <= DATE(r.end_date)
                      AND DATE(r.end_date) <= DATE('now','localtime','+3 day')
                ) THEN 1 ELSE 0 END) AS near_expiry_count
            FROM chambers c
        `);
        
        res.json({
            totalChambers: totalChambers.count,
            totalReservations: totalReservations.count,
            pendingReservations: pendingReservations.count,
            availableChambers: availableChambers.count,
            statusStats: {
                available: statusStats?.available_count || 0,
                in_use: statusStats?.in_use_count || 0,
                near_expiry: statusStats?.near_expiry_count || 0,
                maintenance: statusStats?.maintenance_count || 0
            }
        });
    } catch (error) {
        res.status(500).json({ error: '服务器错误' });
    }
});

app.get('/api/reservations/recent', requireAuth, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.id as chamber_id, c.name as chamber_name, c.description as chamber_description
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            WHERE r.user_id = ?
            ORDER BY r.start_date DESC
            LIMIT 5
        `;
        
        const reservations = await dbAll(query, [req.session.userId]);
        res.json(reservations);
    } catch (error) {
        res.status(500).json({ error: '服务器错误' });
    }
});

app.get('/register', (req, res) => {
    res.render('register', { title: '注册', user: req.session.user || null, role: req.session.role || null });
});

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        // Validation
        if (!username || username.length < 3) {
            return res.status(400).json({ error: '用户名至少需要3个字符' });
        }
        // 邮箱为可选字段，如果提供则验证格式
        if (email && email.trim() && !email.includes('@')) {
            return res.status(400).json({ error: '请输入有效的邮箱地址' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ error: '密码至少需要6个字符' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        // 如果邮箱为空，使用null值
        const emailValue = email && email.trim() ? email.trim() : null;

        // 新注册用户默认为待审核状态 pending
        const insertResult = await dbRun('INSERT INTO users (username, email, password, role, status) VALUES (?, ?, ?, ?, ?)', [username, emailValue, hashedPassword, 'user', 'pending']);

        // 发送注册申请提交通知（用户）与 新注册待审核通知（管理员） - 异步后台执行，不阻塞响应
        // 先立即响应客户端，提升表单提交的交互速度
        res.json({ success: true, message: '注册成功，已提交管理员审核。审核通过后方可登录。' });

        // 使用 setImmediate + 自执行异步函数，后台发送邮件与写入通知
        setImmediate(() => {
            (async () => {
                try {
                    const newUser = await dbGet('SELECT id, username, email, created_at FROM users WHERE id = ?', [insertResult.lastID]);
                    if (newUser) {
                        await sendUserRegistrationSubmittedEmail(newUser);
                        await sendAdminNewUserRegistrationEmail(newUser);
                    }
                } catch (emailErr) {
                    console.error('Send registration emails failed:', emailErr);
                }
            })();
        });
    } catch (error) {
        console.error('Registration error:', error); // 添加详细错误日志
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: '用户名或邮箱已存在' });
        } else {
            res.status(500).json({ error: '注册失败，请稍后重试' });
        }
    }
});

app.get('/login', (req, res) => {
    res.render('login-enhanced', { title: '登录', user: req.session.user || null, role: req.session.role || null });
});

app.post('/login', async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;
         
         if (!username || !password) {
             return res.status(400).json({ error: '请输入用户名和密码' });
         }

         const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);

         if (!user) {
             return res.status(401).json({ error: '用户名或密码错误' });
         }

         // 检查审核状态
         if (user.status === 'pending') {
             return res.status(403).json({ error: '账号正在等待管理员审核，审核通过后方可登录。' });
         }
         if (user.status === 'rejected') {
             return res.status(403).json({ error: '账号审核未通过，请联系管理员。' });
         }

         const isValid = await bcrypt.compare(password, user.password);
         if (isValid) {
             req.session.userId = user.id;
             req.session.username = user.username;
             req.session.userRole = user.role;
            // 记住登录：将 session cookie 持久化 30 天；未勾选则为会话期
            if (rememberMe) {
                req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 天
            } else {
                // 会话期 cookie：浏览器关闭时过期
                req.session.cookie.maxAge = null;
                req.session.cookie.expires = null;
            }
             res.json({ success: true, message: '登录成功', redirect: '/dashboard' });
         } else {
             res.status(401).json({ error: '用户名或密码错误' });
         }
     } catch (error) {
         res.status(500).json({ error: '服务器错误' });
     }
 });

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        // 清除客户端 session cookie
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard-enhanced', { title: '控制面板', user: req.session.username, role: req.session.userRole });
});

app.get('/chambers', requireAuth, async (req, res) => {
    try {
        // 获取筛选参数
        const { status, min_temp, max_temp, min_capacity, search, location } = req.query;
        
        // 构建基础查询
        let query = `
            SELECT c.*, 
                   CASE 
                       WHEN c.status = 'maintenance' THEN 'maintenance'
                       WHEN EXISTS (
                           SELECT 1 FROM reservations r 
                           WHERE r.chamber_id = c.id 
                           AND r.status = 'approved' 
                           AND DATE('now','localtime') >= DATE(r.start_date) 
                           AND DATE('now','localtime') <= DATE(r.end_date)
                       ) OR c.status = 'in_use' THEN 'in_use'
                       ELSE 'available'
                   END as real_status,
                   (
                       SELECT r.test_item
                       FROM reservations r
                       WHERE r.chamber_id = c.id
                       AND r.status = 'approved'
                       AND DATE('now','localtime') >= DATE(r.start_date)
                       AND DATE('now','localtime') <= DATE(r.end_date)
                       LIMIT 1
                   ) as current_test_item,
                   (
                       SELECT r.end_date
                       FROM reservations r
                       WHERE r.chamber_id = c.id
                       AND r.status = 'approved'
                       AND DATE('now','localtime') >= DATE(r.start_date)
                       AND DATE('now','localtime') <= DATE(r.end_date)
                       LIMIT 1
                   ) as test_end_date
            FROM chambers c
            WHERE 1=1
        `;
        
        const params = [];
        
        // 添加状态筛选
        if (status && status !== 'all') {
            if (status === 'in_use') {
                query += ` AND c.status = 'available' AND EXISTS (
                    SELECT 1 FROM reservations r 
                    WHERE r.chamber_id = c.id 
                    AND r.status = 'approved' 
                    AND DATE('now','localtime') >= DATE(r.start_date) 
                    AND DATE('now','localtime') <= DATE(r.end_date)
                )`;
            } else if (status === 'available') {
                query += ` AND c.status = 'available' AND NOT EXISTS (
                    SELECT 1 FROM reservations r 
                    WHERE r.chamber_id = c.id 
                    AND r.status = 'approved' 
                    AND DATE('now','localtime') >= DATE(r.start_date) 
                    AND DATE('now','localtime') <= DATE(r.end_date)
                )`;
            } else {
                query += ` AND c.status = ?`;
                params.push(status);
            }
        }
        
        // 添加温度范围筛选（简单的文本匹配）
        if (min_temp || max_temp) {
            if (min_temp) {
                query += ` AND c.temperature_range LIKE ?`;
                params.push(`%${min_temp}%`);
            }
            if (max_temp) {
                query += ` AND c.temperature_range LIKE ?`;
                params.push(`%${max_temp}%`);
            }
        }
        
        // 添加容量筛选（简单的数字提取和比较）
        if (min_capacity) {
            const capStr = String(min_capacity);
            const numMatch = capStr.match(/\d+/);
            if (numMatch) {
                const minCap = parseInt(numMatch[0], 10);
                query += ` AND CAST(REPLACE(REPLACE(c.capacity, 'L', ''), 'l', '') AS INTEGER) >= ?`;
                params.push(minCap);
            } else {
                query += ` AND c.capacity LIKE ?`;
                params.push(`%${capStr}%`);
            }
        }
        
        // 按温箱ID精确筛选
        const chamberIdParam = req.query.chamber_id;
        if (chamberIdParam) {
            const cid = parseInt(chamberIdParam, 10);
            if (!Number.isNaN(cid)) {
                query += ` AND c.id = ?`;
                params.push(cid);
            }
        }
        
        // 添加搜索功能
        if (search) {
            query += ` AND (c.name LIKE ? OR c.description LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }
        
        // 添加位置筛选
        if (location && location !== 'all') {
            query += ` AND c.location = ?`;
            params.push(location);
        }
        
        query += ` ORDER BY c.id`;
        
        const chambers = await dbAll(query, params);
        
        // 查询数据库中实际存在的筛选选项数据
        const temperatureRangesQuery = `SELECT DISTINCT temperature_range FROM chambers WHERE temperature_range IS NOT NULL AND temperature_range != '' ORDER BY temperature_range`;
        const capacitiesQuery = `SELECT DISTINCT capacity FROM chambers WHERE capacity IS NOT NULL AND capacity != '' ORDER BY capacity`;
        const locationsQuery = `SELECT DISTINCT location FROM chambers WHERE location IS NOT NULL AND location != '' ORDER BY location`;
        
        const [temperatureRanges, capacities, locations] = await Promise.all([
            dbAll(temperatureRangesQuery),
            dbAll(capacitiesQuery),
            dbAll(locationsQuery)
        ]);
        
        // 检查是否所有温箱都在使用
        const allInUse = chambers.length > 0 && chambers.every(chamber => {
            const realStatus = chamber.real_status || chamber.status;
            return realStatus === 'in_use' || realStatus === 'maintenance';
        });
        
        res.render('chambers', { 
            title: '温箱设备列表', 
            chambers,
            allInUse,
            user: req.session.username, 
            role: req.session.userRole,
            filters: { status, min_temp, max_temp, min_capacity, search, location },
            filterOptions: {
                temperatureRanges: temperatureRanges.map(row => row.temperature_range),
                capacities: capacities.map(row => row.capacity),
                locations: locations.map(row => row.location)
            }
        });
    } catch (error) {
        console.error('Chambers list error:', error);
        res.status(500).send('服务器错误');
    }
});

app.get('/reserve', requireAuth, async (req, res) => {
    try {
        const chambers = await dbAll(`
            SELECT c.*
            FROM chambers c
            WHERE c.status != 'maintenance'
              AND NOT EXISTS (
                SELECT 1 FROM reservations r
                WHERE r.chamber_id = c.id
                  AND r.status = 'approved'
                  AND DATE('now','localtime') >= DATE(r.start_date)
                  AND DATE('now','localtime') <= DATE(r.end_date)
              )
            ORDER BY c.id
        `);
        res.render('reserve-enhanced', { title: '预约温箱', chambers, user: req.session.username, role: req.session.userRole });
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

app.get('/reserve-wizard', requireAuth, async (req, res) => {
    try {
        // 重定向到排队申请页面
        res.redirect('/queue-request');
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

app.post('/reserve', requireAuth, upload.none(), async (req, res) => {
    console.log('=== 收到预约请求 ===');
    console.log('请求头：', req.headers);
    console.log('请求体：', req.body);
    console.log('用户信息：', { user: req.session.user, role: req.session.role });
    
    try {
        const { chamber_id, project_name, project_leader, department, start_date, end_date, 
                test_item, temperature_range, sample_count, special_requirements, fw_version } = req.body;

        console.log('解构后的字段：', {
            chamber_id, project_name, project_leader, department, 
            start_date, end_date, test_item, temperature_range, 
            sample_count, special_requirements, fw_version
        });

        // Validation
        if (!chamber_id || !project_name || !project_leader || !department || 
            !start_date || !end_date || !test_item) {
            console.log('❌ 验证失败：缺少必填字段');
            console.log('缺少的字段：', {
                chamber_id: !chamber_id ? '缺少' : '存在',
                project_name: !project_name ? '缺少' : '存在',
                project_leader: !project_leader ? '缺少' : '存在',
                department: !department ? '缺少' : '存在',
                start_date: !start_date ? '缺少' : '存在',
                end_date: !end_date ? '缺少' : '存在',
                test_item: !test_item ? '缺少' : '存在'
            });
            return res.status(400).json({ error: '请填写所有必填字段' });
        }

        console.log('✅ 基本字段验证通过');

        // 使用按天比较，允许开始日期等于今天，允许同一天预约
        const start = moment(start_date, 'YYYY-MM-DD').startOf('day');
        const end = moment(end_date, 'YYYY-MM-DD').startOf('day');
        const today = moment().startOf('day');

        console.log('日期验证：', {
            start_date: start_date,
            end_date: end_date,
            start_moment: start.format(),
            end_moment: end.format(),
            today_moment: today.format(),
            end_before_start: end.isBefore(start),
            start_before_today: start.isBefore(today)
        });

        if (end.isBefore(start)) {
            console.log('❌ 日期验证失败：结束日期早于开始日期');
            return res.status(400).json({ error: '结束日期不能早于开始日期（可同一天）' });
        }

        if (start.isBefore(today)) {
            console.log('❌ 日期验证失败：开始日期早于今天');
            return res.status(400).json({ error: '开始日期不能早于今天' });
        }

        console.log('✅ 日期验证通过');

        // Check for date conflicts
        const checkQuery = `
            SELECT COUNT(*) as count FROM reservations 
            WHERE chamber_id = ? AND status != 'cancelled' 
            AND ((start_date <= ? AND end_date >= ?) OR (start_date <= ? AND end_date >= ?))
        `;

        console.log('执行冲突检查查询：', checkQuery);
        console.log('查询参数：', [chamber_id, end_date, start_date, start_date, end_date]);

        const result = await dbGet(checkQuery, [chamber_id, start_date, start_date, end_date, end_date]);

        if (result.count > 0) {
            return res.status(409).json({ error: '该时间段已被预约，请选择其他时间' });
        }

        // 对管理员预约自动通过；普通用户保留为待审核
        const isAdmin = req.session.userRole === 'admin';
        const status = isAdmin ? 'approved' : 'pending';

        const insertQuery = `
            INSERT INTO reservations (user_id, chamber_id, project_name, project_leader, 
            department, start_date, end_date, test_item, temperature_range, sample_count, special_requirements, fw_version, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const insertResult = await dbRun(insertQuery, [req.session.userId, chamber_id, project_name, project_leader, department, 
                start_date, end_date, test_item, temperature_range, sample_count, special_requirements, fw_version, status]);
        const newReservationId = insertResult.lastID;
        
        // Send notification email（给申请人）
        try {
            await sendReservationNotification(req.session.userId, chamber_id, {
                project_name, project_leader, department, start_date, end_date, test_item
            });
        } catch (emailError) {
            console.error('Email notification failed:', emailError);
        }

        // 新增：若为普通用户提交预约，则通知管理员有新的待审核申请
        if (!isAdmin) {
            try {
                await sendAdminNewReservationEmail(req.session.userId, chamber_id, {
                    reservation_id: newReservationId,
                    project_name, project_leader, department, start_date, end_date, test_item
                });
            } catch (emailError) {
                console.error('Admin new reservation email failed:', emailError);
            }
        }
        
        const message = isAdmin ? '预约已创建并自动通过' : '预约申请已提交，请等待审核';
        res.json({ success: true, message });
    } catch (error) {
        res.status(500).json({ error: '预约失败，请稍后重试' });
    }
});

// 排队申请相关路由
app.get('/queue-request', requireAuth, async (req, res) => {
    try {
        res.render('queue-request', { 
            title: '排队申请', 
            user: req.session.username, 
            role: req.session.userRole
        });
    } catch (error) {
        console.error('Error loading queue request page:', error);
        res.status(500).send('加载排队申请页面时发生错误');
    }
});

app.post('/queue-request', requireAuth, async (req, res) => {
    try {
        const { applicant_name, project_name, test_item, fw_version, temperature_range, plate_count, urgency_level, description, queue_date } = req.body;
        
        // Validation - 验证必填字段
        if (!applicant_name || !project_name || !test_item || !fw_version || !temperature_range || !plate_count || !urgency_level || !queue_date) {
            return res.status(400).json({ error: '请填写所有必填字段' });
        }
        
        // 验证排队日期不能是过去的日期
        const queueDate = new Date(queue_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (queueDate < today) {
            return res.status(400).json({ error: '期望开始日期不能是过去的日期' });
        }
        
        const insertQuery = `
            INSERT INTO queue_requests (user_id, applicant_name, project_name, test_item, fw_version, temperature_range, plate_count, urgency_level, description, queue_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await dbRun(insertQuery, [req.session.userId, applicant_name, project_name, test_item, fw_version, temperature_range, parseInt(plate_count), urgency_level, description, queue_date]);
        
        // 先立即返回成功响应，剩余耗时操作放到后台执行，避免阻塞接口
        res.json({ success: true, message: '排队申请已提交，管理员将尽快处理' });

        // 后台异步执行：发送邮件与创建系统通知
        setImmediate(async () => {
            try {
                // 发送邮件通知（仅在配置了邮箱的情况下执行）
                if (emailConfigured) {
                    await sendAdminNewQueueRequestEmail(req.session.userId, {
                        applicant_name, project_name, test_item, fw_version, temperature_range, plate_count, urgency_level, description,
                        queue_date
                    });
                }

                // 创建系统通知
                const user = await dbGet('SELECT username FROM users WHERE id = ?', [req.session.userId]);
                if (user) {
                    await dbRun(`
                        INSERT INTO system_notifications (title, message, type, target_role, created_at)
                        VALUES (?, ?, ?, ?, DATETIME('now','localtime'))
                    `, ['新的排队申请', `${user.username} 提交了一个新的排队申请`, 'queue_request', 'admin']);
                }
            } catch (bgErr) {
                console.error('Queue request background task failed:', bgErr);
            }
        });
    } catch (error) {
        console.error('Queue request submission error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: '提交失败，请稍后重试' });
        }
    }
});

// 管理员管理排队申请
app.get('/admin/queue-requests', requireAdmin, async (req, res) => {
    try {
        const requests = await dbAll(`
            SELECT q.*, u.username, u.email
            FROM queue_requests q
            JOIN users u ON q.user_id = u.id
            ORDER BY 
                CASE q.urgency_level 
                    WHEN 'urgent' THEN 1
                    WHEN 'high' THEN 2  
                    WHEN 'normal' THEN 3
                    WHEN 'low' THEN 4
                END,
                q.created_at ASC
        `);
        res.render('admin/queue-requests', { 
            title: '排队申请管理', 
            requests, 
            user: req.session.username, 
            role: req.session.userRole,
            moment 
        });
    } catch (error) {
        console.error('Queue requests error:', error);
        res.status(500).send('服务器错误');
    }
});



app.post('/admin/queue-requests/:id/status', requireAdmin, async (req, res) => {
    try {
        const requestId = req.params.id;
        const { status, response_message, queue_date } = req.body;

        const allowedStatuses = ['approved', 'rejected', 'cancelled'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ error: '非法状态参数' });
        }
        
        // 验证排队日期不能是过去的日期（仅在通过时校验）
        if (queue_date && status === 'approved') {
            const queueDateObj = new Date(queue_date);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (queueDateObj < today) {
                return res.status(400).json({ error: '期望开始日期不能是过去的日期' });
            }
        }
        
        // 更新状态和排队日期（如果有）
        if (queue_date && status === 'approved') {
            await dbRun('UPDATE queue_requests SET status = ?, processed_at = DATETIME("now"), processed_by = ?, queue_date = ? WHERE id = ?', 
                       [status, req.session.userId, queue_date, requestId]);
        } else {
            await dbRun('UPDATE queue_requests SET status = ?, processed_at = DATETIME("now"), processed_by = ? WHERE id = ?', 
                       [status, req.session.userId, requestId]);
        }
        
        // 获取申请详情（用于异步通知）
        const request = await dbGet(`
            SELECT q.*, u.username, u.email
            FROM queue_requests q
            JOIN users u ON q.user_id = u.id
            WHERE q.id = ?
        `, [requestId]);
        
        // 立即返回成功，避免前端等待邮件/通知发送完成
        res.json({ success: true, message: '状态更新成功' });

        // 将耗时操作放到后台异步执行
        if (request) {
            setImmediate(async () => {
                try {
                    await sendQueueRequestStatusEmail(request.user_id, requestId, status, response_message, '温箱', request.queue_date);
                    
                    const statusLabels = {
                        'approved': '已通过',
                        'rejected': '已拒绝',
                        'cancelled': '已取消'
                    };
                    
                    await dbRun(`
                        INSERT INTO system_notifications (title, message, type, target_role, created_at)
                        VALUES (?, ?, ?, ?, DATETIME('now','localtime'))
                    `, [
                        `排队申请${statusLabels[status] || status}`,
                        `您的温箱排队申请${statusLabels[status] || status}${response_message ? '：' + response_message : ''}`,
                        status === 'approved' ? 'success' : (status === 'rejected' ? 'warning' : 'info'),
                        'user'
                    ]);
                } catch (emailError) {
                    console.error('Queue request status async tasks failed:', emailError);
                }
            });
        }
    } catch (error) {
        console.error('Queue request status update error:', error);
        res.status(500).json({ error: '更新失败' });
    }
});

app.delete('/admin/queue-requests/:id', requireAdmin, async (req, res) => {
    try {
        const requestId = req.params.id;
        await dbRun('DELETE FROM queue_requests WHERE id = ?', [requestId]);
        res.json({ success: true, message: '申请已删除' });
    } catch (error) {
        console.error('Queue request deletion error:', error);
        res.status(500).json({ error: '删除失败' });
    }
});

// Email notification functions
async function sendReservationNotification(userId, chamberId, reservationData) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping reservation notification email.');
            return;
        }
        const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
        const chamber = await dbGet('SELECT name FROM chambers WHERE id = ?', [chamberId]);
        
        if (!user || !chamber) return;

        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: '温箱预约申请已提交 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">温箱预约申请已提交</h2>
                    <p>尊敬的 ${user.username}，</p>
                    <p>您的温箱预约申请已成功提交，请等待管理员审核。</p>
                    
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">预约详情</h3>
                        <p><strong>温箱名称：</strong>${chamber.name}</p>
                        <p><strong>项目名称：</strong>${reservationData.project_name}</p>
                        <p><strong>项目使用人：</strong>${reservationData.project_leader}</p>
                        <p><strong>所属部门：</strong>${reservationData.department}</p>
                        <p><strong>预约时间：</strong>${reservationData.start_date} 至 ${reservationData.end_date}</p>
                        <p><strong>测试项：</strong>${reservationData.test_item}</p>
                    </div>
                    
                    <p>审核结果将通过邮件通知您，请耐心等待。</p>
                    <p>如有疑问，请联系系统管理员。</p>
                    
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">
                        此邮件由温箱预约系统自动发送，请勿直接回复。
                    </p>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Email notification failed:', error);
        // Don't re-throw error to avoid breaking main flow
    }
}

async function sendStatusUpdateEmail(userId, reservationId, status, reason = '') {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping status update email.');
            return;
        }
        const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
        const reservation = await dbGet(`
            SELECT r.*, c.name as chamber_name 
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            WHERE r.id = ?
        `, [reservationId]);
        
        if (!user || !reservation) return;

        const statusMap = {
            'approved': '已批准',
            'rejected': '已拒绝',
            'cancelled': '已取消'
        };

        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: `预约状态更新：${reservation.project_name} - 温箱预约系统`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">预约状态更新</h2>
                    <p>尊敬的 ${user.username}，</p>
                    <p>您的温箱预约状态已更新。</p>
                    
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">预约信息</h3>
                        <p><strong>项目名称：</strong>${reservation.project_name}</p>
                        <p><strong>温箱名称：</strong>${reservation.chamber_name}</p>
                        <p><strong>预约时间：</strong>${reservation.start_date} 至 ${reservation.end_date}</p>
                        <p><strong>新状态：</strong><span style="color: ${status === 'approved' ? '#28a745' : '#dc3545'}; font-weight: bold;">${statusMap[status]}</span></p>
                        ${reason ? `<p><strong>原因：</strong>${reason}</p>` : ''}
                    </div>
                    
                    <p>感谢您的使用！</p>
                    
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">
                        此邮件由温箱预约系统自动发送，请勿直接回复。
                    </p>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Status update email failed:', error);
        // Don't re-throw error to avoid breaking main flow
    }
}

// ============== 注册相关邮件通知 ==============
async function sendUserRegistrationSubmittedEmail(user) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping user registration submitted email.');
            return;
        }
        // 如果用户没有邮箱，跳过发送
        if (!user.email) {
            console.info('User has no email address. Skipping user registration submitted email.');
            return;
        }
        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: '注册申请已提交 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">注册申请已提交</h2>
                    <p>尊敬的用户，</p>
                    <p>您的注册申请已提交成功，管理员将尽快审核。</p>
                    <p>审核通过后您将收到通知邮件，届时即可登录系统。</p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送，请勿直接回复。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('User registration submitted email failed:', error);
    }
}

async function sendAdminNewUserRegistrationEmail(user) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping admin new user registration email.');
            return;
        }
        const mailOptions = {
            from: EMAIL_USER,
            to: ADMIN_EMAIL,
            subject: '新的用户注册申请待审核 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #e07a5f;">新的注册申请待审核</h2>
                    <p>管理员您好，系统收到一条新的用户注册申请：</p>
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p><strong>用户名：</strong>${user.username}</p>
                        <p><strong>邮箱：</strong>${user.email || '未提供'}</p>
                        <p><strong>注册时间：</strong>${user.created_at || ''}</p>
                    </div>
                    <p>请前往管理后台审核：<a href="http://localhost:${PORT}/admin/users">用户管理</a></p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
        
        // 创建系统通知给管理员
        await dbRun(`
            INSERT INTO system_notifications (title, message, type, target_role, created_at)
            VALUES (?, ?, ?, ?, DATETIME('now','localtime'))
        `, [
            '新用户注册',
            `${user.username} 申请注册账号`,
            'user_registration',
            'admin'
        ]);
    } catch (error) {
        console.error('Admin new user registration email failed:', error);
    }
}

async function sendUserApprovalEmail(user) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping user approval email.');
            return;
        }
        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: '注册审核已通过 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #28a745;">注册审核已通过</h2>
                    <p>尊敬的用户，</p>
                    <p>您的注册申请已通过审核，现已可以登录系统。</p>
                    <p>为保障安全，本邮件不包含账号或密码等敏感信息。如您忘记密码，请联系管理员协助重置。</p>
                    <p>
                        立即登录：<a href="http://localhost:${PORT}/login">http://localhost:${PORT}/login</a>
                    </p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送，请勿直接回复。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('User approval email failed:', error);
    }
}

async function sendUserRejectionEmail(user) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping user rejection email.');
            return;
        }
        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: '注册审核未通过 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #dc3545;">注册审核未通过</h2>
                    <p>尊敬的用户，</p>
                    <p>很抱歉，您的注册申请未通过审核。如需协助或了解详情，请联系管理员。</p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送，请勿直接回复。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('User rejection email failed:', error);
    }
}

app.get('/my-reservations', requireAuth, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.id as chamber_id, c.name as chamber_name, c.description as chamber_description
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            WHERE r.user_id = ?
            ORDER BY r.start_date DESC
        `;

        const reservations = await dbAll(query, [req.session.userId]);
        const queueRequests = await dbAll(`
            SELECT q.*
            FROM queue_requests q
            WHERE q.user_id = ?
            ORDER BY q.created_at DESC
        `, [req.session.userId]);
        res.render('my-reservations', { title: '我的预约', reservations, queueRequests, user: req.session.username, role: req.session.userRole, moment });
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

app.post('/cancel-reservation/:id', requireAuth, async (req, res) => {
    try {
        const reservationId = req.params.id;
        
        // 获取预约信息，用于通知管理员
        const reservation = await dbGet(`
            SELECT r.*, c.name as chamber_name 
            FROM reservations r 
            JOIN chambers c ON r.chamber_id = c.id 
            WHERE r.id = ? AND r.user_id = ?
        `, [reservationId, req.session.userId]);
        
        if (!reservation) {
            return res.status(404).send('预约未找到或无权取消');
        }
        
        // 更新预约状态
        const result = await dbRun('UPDATE reservations SET status = "cancelled", updated_at = DATETIME("now","localtime") WHERE id = ? AND user_id = ?', [reservationId, req.session.userId]);
        
        if (result.changes > 0) {
            // 向管理员添加通知
            const adminUsers = await dbAll('SELECT id FROM users WHERE role = "admin"');
            for (const admin of adminUsers) {
                await dbRun(`
                    INSERT INTO user_notifications (user_id, title, message, type, related_id, related_type, is_read, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `, [
                    admin.id,
                    '用户取消预约',
                    `用户 ${req.session.username} 取消了温箱 ${reservation.chamber_name} 的预约，项目名称：${reservation.project_name}`,
                    'warning',
                    reservationId,
                    'reservation',
                    0
                ]);
            }
            
            res.redirect('/my-reservations');
        } else {
            res.status(404).send('预约未找到或无权取消');
        }
    } catch (error) {
        console.error('取消预约失败:', error);
        res.status(500).send('取消失败');
    }
});

// Admin routes
app.get('/admin/chambers', requireAdmin, async (req, res) => {
    try {
        const chambers = await dbAll(`
            SELECT c.*, 
                   CASE 
                       WHEN c.status = 'maintenance' THEN 'maintenance'
                       WHEN EXISTS (
                           SELECT 1 FROM reservations r 
                           WHERE r.chamber_id = c.id 
                           AND r.status = 'approved' 
                           AND DATE('now','localtime') >= DATE(r.start_date) 
                           AND DATE('now','localtime') <= DATE(r.end_date)
                       ) OR c.status = 'in_use' THEN 'in_use'
                       ELSE 'available'
                   END as real_status,
                   (
                       SELECT r.test_item FROM reservations r
                       WHERE r.chamber_id = c.id
                       AND r.status = 'approved'
                       AND DATE('now','localtime') >= DATE(r.start_date)
                       AND DATE('now','localtime') <= DATE(r.end_date)
                       LIMIT 1
                   ) as current_test_item
            FROM chambers c
            ORDER BY c.id
        `);
        res.render('admin/chambers', { title: '温箱管理', chambers, user: req.session.username, role: req.session.userRole });
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

app.post('/admin/chambers', requireAdmin, async (req, res) => {
    try {
        const { name, description, temperature_range, capacity, test_item, location, project, status } = req.body;
        
        if (!name || !description || !temperature_range || !capacity) {
            return res.status(400).json({ error: '请填写所有必填字段' });
        }
        
        await dbRun('INSERT INTO chambers (name, description, temperature_range, capacity, test_item, location, project, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [name, description, temperature_range, capacity, test_item || null, location || null, project || null, status || 'available']);
        res.json({ success: true, message: '温箱添加成功' });
    } catch (error) {
        res.status(500).json({ error: '添加失败' });
    }
});

app.put('/admin/chambers/:id', requireAdmin, async (req, res) => {
    try {
        const { name, description, temperature_range, capacity, test_item, location, project, status } = req.body;
        const chamberId = req.params.id;
        
        await dbRun(`
            UPDATE chambers 
            SET name = ?, description = ?, temperature_range = ?, capacity = ?, test_item = ?, location = ?, project = ?, status = ?
            WHERE id = ?
        `, [name, description, temperature_range, capacity, test_item || null, location || null, project || null, status, chamberId]);
        // 直接返回最新记录，减少前端额外查询
        const chamber = await dbGet('SELECT id, name, description, temperature_range, capacity, test_item, location, project, status FROM chambers WHERE id = ?', [chamberId]);
        res.json({ success: true, message: '温箱更新成功', chamber });
    } catch (error) {
        res.status(500).json({ error: '更新失败' });
    }
});

app.delete('/admin/chambers/:id', requireAdmin, async (req, res) => {
    try {
        const chamberId = req.params.id;
        
        // Check if chamber has active reservations
        const checkQuery = 'SELECT COUNT(*) as count FROM reservations WHERE chamber_id = ? AND status = "approved" AND DATE(\'now\',\'localtime\') >= DATE(start_date) AND DATE(\'now\',\'localtime\') <= DATE(end_date)';
        const result = await dbGet(checkQuery, [chamberId]);
        
        if (result.count > 0) {
            return res.status(409).json({ error: '该温箱有活跃预约，无法删除' });
        }
        
        await dbRun('DELETE FROM chambers WHERE id = ?', [chamberId]);
        
        // 重新排列ID，使其连续
        await reorderChamberIds();
        
        res.json({ success: true, message: '温箱删除成功' });
    } catch (error) {
        res.status(500).json({ error: '删除失败' });
    }
});

// 批量删除温箱
app.post('/admin/chambers/batch-delete', requireAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        
        console.log('接收到的ID列表:', ids); // 调试日志
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: '请提供有效的温箱ID列表' });
        }
        
        // 确保所有ID都是整数
        const validIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));
        
        console.log('处理后的ID列表:', validIds); // 调试日志
        
        if (validIds.length === 0) {
            return res.status(400).json({ error: '没有有效的温箱ID' });
        }
        
        // 检查是否有活跃预约（当前日期范围内的预约）
        const placeholders = validIds.map(() => '?').join(',');
        const checkQuery = `SELECT chamber_id FROM reservations 
                           WHERE chamber_id IN (${placeholders}) 
                           AND status = "approved" 
                           AND DATE('now','localtime') >= DATE(start_date) 
                           AND DATE('now','localtime') <= DATE(end_date) 
                           GROUP BY chamber_id`;
        const activeReservations = await dbAll(checkQuery, validIds);
        
        console.log('活跃预约检查结果:', activeReservations); // 调试日志
        
        // 筛选出没有活跃预约的温箱ID
        const activeIds = activeReservations.map(row => row.chamber_id);
        const idsToDelete = validIds.filter(id => !activeIds.includes(id));
        
        console.log('将要删除的温箱ID:', idsToDelete); // 调试日志
        console.log('有活跃预约无法删除的温箱ID:', activeIds); // 调试日志
        
        if (idsToDelete.length === 0) {
            return res.status(409).json({ 
                error: '所有选中的温箱都有活跃预约，无法删除', 
                activeIds: activeIds 
            });
        }
        
        // 执行批量删除（仅删除没有活跃预约的温箱）
        const deletePlaceholders = idsToDelete.map(() => '?').join(',');
        const deleteQuery = `DELETE FROM chambers WHERE id IN (${deletePlaceholders})`;
        const result = await dbRun(deleteQuery, idsToDelete);
        
        // 重新排列ID，使其连续
        await reorderChamberIds();
        
        // 如果有部分温箱无法删除，返回部分成功的信息
        if (activeIds.length > 0) {
            return res.status(200).json({
                message: `成功删除了 ${idsToDelete.length} 个温箱，${activeIds.length} 个温箱因有活跃预约无法删除`,
                deletedCount: idsToDelete.length,
                activeIds: activeIds
            });
        }
        
        console.log('删除操作结果:', result); // 调试日志
        
        res.json({ 
            success: true, 
            message: `成功删除${validIds.length}个温箱` 
        });
    } catch (error) {
        console.error('批量删除温箱失败:', error);
        res.status(500).json({ error: '批量删除失败' });
    }
});

// 管理员回收使用中的温箱
app.post('/admin/chambers/:id/reclaim', requireAdmin, async (req, res) => {
    try {
        const chamberId = req.params.id;
        const { reason } = req.body;
        
        // 检查温箱是否存在
        const chamber = await dbGet('SELECT * FROM chambers WHERE id = ?', [chamberId]);
        if (!chamber) {
            return res.status(404).json({ error: '温箱不存在' });
        }
        
        // 查找该温箱的活跃预约
        const activeReservations = await dbAll(`
            SELECT r.*, u.id as user_id, u.email, u.username
            FROM reservations r
            JOIN users u ON r.user_id = u.id
            WHERE r.chamber_id = ? AND r.status = 'approved'
            AND DATE('now','localtime') >= DATE(r.start_date)
            AND DATE('now','localtime') <= DATE(r.end_date)
        `, [chamberId]);
        
        // 如果有活跃预约，取消预约并通知用户
        if (activeReservations.length > 0) {
            for (const reservation of activeReservations) {
                // 更新预约状态为已取消
                await dbRun('UPDATE reservations SET status = ?, updated_at = DATETIME("now","localtime") WHERE id = ?', ['cancelled', reservation.id]);
                
                // 发送邮件通知
                try {
                    await sendStatusUpdateEmail(reservation.user_id, reservation.id, 'cancelled', 
                        `管理员回收温箱。${reason ? '原因：' + reason : ''}`);
                } catch (emailError) {
                    console.error('Email notification failed:', emailError);
                }
                
                // 添加用户通知
                try {
                    const title = '预约已被管理员取消';
                    const message = `您使用的温箱 #${chamberId} ${chamber.name} 已被管理员回收。${reason ? '原因：' + reason : ''}`;
                    const type = 'warning';
                    
                    await dbRun(`
                        INSERT INTO user_notifications (user_id, title, message, type, related_id, related_type)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [reservation.user_id, title, message, type, reservation.id, 'reservation']);
                } catch (notifError) {
                    console.error('User notification creation failed:', notifError);
                }
            }
        }
        
        // 更新温箱状态为闲置
        await dbRun('UPDATE chambers SET status = ? WHERE id = ?', ['available', chamberId]);
        
        res.json({ 
            success: true, 
            message: `温箱已成功回收${activeReservations.length > 0 ? '并通知了使用者' : ''}`,
            affectedReservations: activeReservations.length
        });
    } catch (error) {
        console.error('回收温箱失败:', error);
        res.status(500).json({ error: '回收温箱失败' });
    }
});

// 维保结束后更改温箱状态为闲置
app.post('/admin/chambers/:id/maintenance-complete', requireAdmin, async (req, res) => {
    try {
        const chamberId = req.params.id;
        
        // 检查温箱是否存在
        const chamber = await dbGet('SELECT * FROM chambers WHERE id = ?', [chamberId]);
        if (!chamber) {
            return res.status(404).json({ error: '温箱不存在' });
        }
        
        // 检查温箱是否处于维保状态
        if (chamber.status !== 'maintenance') {
            return res.status(400).json({ error: '该温箱当前不处于维保状态' });
        }
        
        // 更新温箱状态为闲置
        await dbRun('UPDATE chambers SET status = ? WHERE id = ?', ['available', chamberId]);
        
        res.json({ 
            success: true, 
            message: '温箱维保已完成，状态已更改为闲置'
        });
    } catch (error) {
        console.error('更新温箱状态失败:', error);
        res.status(500).json({ error: '更新温箱状态失败' });
    }
});

// Platform management API routes
// Get platforms for a specific chamber
app.get('/admin/chambers/:id/platforms', requireAuth, async (req, res) => {
    try {
        const chamberId = req.params.id;
        const platforms = await dbAll('SELECT * FROM platforms WHERE chamber_id = ? ORDER BY created_at DESC', [chamberId]);
        res.json(platforms);
    } catch (error) {
        console.error('获取平台列表失败:', error);
        res.status(500).json({ error: '获取平台列表失败' });
    }
});

// Add new platform
app.post('/admin/platforms', requireAdmin, async (req, res) => {
    try {
        const { chamber_id, client_uuid, mb, cpu, os, max_link_speed, project, status, test_item } = req.body;
        
        // Validate required fields
        if (!chamber_id || !client_uuid || !mb || !cpu || !os || !max_link_speed || !project || !status) {
            return res.status(400).json({ error: '请填写所有必填字段' });
        }
        
        const result = await dbRun(`
            INSERT INTO platforms (chamber_id, client_uuid, mb, cpu, os, max_link_speed, project, status, test_item, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [chamber_id, client_uuid, mb, cpu, os, max_link_speed, project, status, test_item || null]);
        
        res.json({ success: true, message: '平台添加成功', platform_id: result.lastID });
    } catch (error) {
        console.error('添加平台失败:', error);
        res.status(500).json({ error: '添加平台失败，请稍后重试' });
    }
});

// Update platform
app.put('/admin/platforms/:id', requireAdmin, async (req, res) => {
    try {
        const platformId = req.params.id;
        const { client_uuid, mb, cpu, os, max_link_speed, project, status, test_item } = req.body;
        
        // Validate required fields
        if (!client_uuid || !mb || !cpu || !os || !max_link_speed || !project || !status) {
            return res.status(400).json({ error: '请填写所有必填字段' });
        }
        
        await dbRun(`
            UPDATE platforms 
            SET client_uuid = ?, mb = ?, cpu = ?, os = ?, max_link_speed = ?, project = ?, status = ?, test_item = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [client_uuid, mb, cpu, os, max_link_speed, project, status, test_item || null, platformId]);
        
        res.json({ success: true, message: '平台更新成功' });
    } catch (error) {
        console.error('更新平台失败:', error);
        res.status(500).json({ error: '更新平台失败，请稍后重试' });
    }
});

// Delete platform
app.delete('/admin/platforms/:id', requireAdmin, async (req, res) => {
    try {
        const platformId = req.params.id;
        await dbRun('DELETE FROM platforms WHERE id = ?', [platformId]);
        res.json({ success: true, message: '平台删除成功' });
    } catch (error) {
        console.error('删除平台失败:', error);
        res.status(500).json({ error: '删除平台失败，请稍后重试' });
    }
});

// Update current test item for a chamber
app.put('/admin/chambers/:id/test-item', requireAdmin, async (req, res) => {
    try {
        const chamberId = req.params.id;
        const { test_item } = req.body;
        
        // 验证温箱是否存在
        const chamber = await dbGet('SELECT * FROM chambers WHERE id = ?', [chamberId]);
        if (!chamber) {
            return res.status(404).json({ error: '温箱不存在' });
        }
        
        // 查找当前正在进行的预约
        const currentReservation = await dbGet(`
            SELECT id FROM reservations 
            WHERE chamber_id = ? 
            AND status = 'approved' 
            AND DATE('now','localtime') >= DATE(start_date) 
            AND DATE('now','localtime') <= DATE(end_date)
            LIMIT 1
        `, [chamberId]);
        
        if (!currentReservation) {
            return res.status(400).json({ error: '该温箱当前没有正在进行的预约' });
        }
        
        // 更新预约的测试项
        await dbRun(
            'UPDATE reservations SET test_item = ? WHERE id = ?',
            [test_item || null, currentReservation.id]
        );
        
        res.json({ 
            success: true, 
            message: '测试项更新成功'
        });
    } catch (error) {
        console.error('更新测试项失败:', error);
        res.status(500).json({ error: '更新测试项失败，请稍后重试' });
    }
});

app.get('/admin/reservations', requireAdmin, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.id as chamber_id, c.name as chamber_name, u.username
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            JOIN users u ON r.user_id = u.id
            ORDER BY r.start_date DESC
        `;

        const reservations = await dbAll(query);
        res.render('admin/reservations', { title: '预约管理', reservations, user: req.session.username, role: req.session.userRole, moment });
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

app.post('/admin/reservations/:id/status', requireAdmin, async (req, res) => {
    try {
        const reservationId = req.params.id;
        const { status, reason } = req.body;
        
        await dbRun('UPDATE reservations SET status = ?, updated_at = DATETIME("now","localtime") WHERE id = ?', [status, reservationId]);
        
        // 获取预约详情
        const reservation = await dbGet(`
            SELECT r.*, c.name as chamber_name, u.id as user_id 
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            JOIN users u ON r.user_id = u.id
            WHERE r.id = ?
        `, [reservationId]);
        
        if (reservation) {
            // 发送邮件通知
            try {
                await sendStatusUpdateEmail(reservation.user_id, reservationId, status, reason);
            } catch (emailError) {
                console.error('Email notification failed:', emailError);
            }
            
            // 添加用户通知
            try {
                let title = '';
                let message = '';
                let type = 'info';
                
                if (status === 'approved') {
                    title = '预约申请已通过';
                    message = `您申请的温箱 #${reservation.chamber_id} ${reservation.chamber_name} 预约已通过审核。${reason ? '备注：' + reason : ''}`;
                    type = 'success';
                } else if (status === 'rejected') {
                    title = '预约申请已拒绝';
                    message = `您申请的温箱 #${reservation.chamber_id} ${reservation.chamber_name} 预约未通过审核。${reason ? '原因：' + reason : ''}`;
                    type = 'danger';
                } else if (status === 'cancelled') {
                    title = '预约已取消';
                    message = `您的温箱 #${reservation.chamber_id} ${reservation.chamber_name} 预约已被取消。${reason ? '原因：' + reason : ''}`;
                    type = 'warning';
                }
                
                if (title) {
                    await dbRun(`
                        INSERT INTO user_notifications (user_id, title, message, type, related_id, related_type)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [reservation.user_id, title, message, type, reservationId, 'reservation']);
                }
            } catch (notifError) {
                console.error('User notification creation failed:', notifError);
            }
        }
        
        res.json({ success: true, message: '状态更新成功' });
    } catch (error) {
        res.status(500).json({ error: '更新失败' });
    }
});

// Admin API endpoints
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const total = await dbGet('SELECT COUNT(*) as count FROM reservations');
        const pending = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE status = "pending"');
        const approved = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE status = "approved"');
        const rejected = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE status = "rejected"');
        
        res.json({ 
            total: total.count, 
            pending: pending.count, 
            approved: approved.count, 
            rejected: rejected.count 
        });
    } catch (error) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// 用户通知API接口
app.get('/api/user/notifications', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        // 获取未读通知数量
        const unreadCount = await dbGet('SELECT COUNT(*) as count FROM user_notifications WHERE user_id = ? AND is_read = 0', [userId]);
        
        // 获取最近的通知列表
        const notifications = await dbAll(`
            SELECT id, title, message, type, related_id, related_type, is_read, created_at
            FROM user_notifications
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 10
        `, [userId]);
        
        res.json({
            success: true,
            counts: {
                unread: unreadCount.count
            },
            notifications: notifications
        });
    } catch (error) {
        console.error('获取用户通知失败:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 标记通知为已读
app.post('/api/user/notifications/:id/read', requireAuth, async (req, res) => {
    try {
        const notificationId = req.params.id;
        const userId = req.session.userId;
        
        // 确保只能标记自己的通知为已读
        await dbRun('UPDATE user_notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [notificationId, userId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('标记通知已读失败:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 标记所有通知为已读
app.post('/api/user/notifications/read-all', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        await dbRun('UPDATE user_notifications SET is_read = 1 WHERE user_id = ?', [userId]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('标记所有通知已读失败:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 管理员通知API
app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
    try {
        // 获取待审核用户数量
        const pendingUserCount = await dbGet('SELECT COUNT(*) as count FROM users WHERE status = "pending"');
        
        // 获取待审核预约数量
        const pendingReservationCount = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE status = "pending"');
        
        // 获取待审核用户列表
        const pendingUsers = await dbAll('SELECT id, username, email, created_at FROM users WHERE status = "pending" ORDER BY created_at DESC LIMIT 5');
        
        // 获取待审核预约列表
        const pendingReservations = await dbAll(`
            SELECT r.id, r.chamber_id, r.project_name, u.username, c.name as chamber_name, r.created_at 
            FROM reservations r 
            JOIN users u ON r.user_id = u.id 
            JOIN chambers c ON r.chamber_id = c.id 
            WHERE r.status = "pending" 
            ORDER BY r.created_at DESC LIMIT 5
        `);
        
        res.json({
            counts: { users: pendingUserCount.count, reservations: pendingReservationCount.count },
            pendingUsers,
            pendingReservations
        });
    } catch (error) {
        console.error('Admin notifications error:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

app.get('/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const to = req.query.to || process.env.ADMIN_EMAIL || EMAIL_USER;
    if (!to) {
      return res.status(400).json({ ok: false, error: '缺少目标邮箱（to）且未配置 ADMIN_EMAIL/EMAIL_USER' });
    }

    const info = await emailTransporter.sendMail({
      from: EMAIL_USER,
      to,
      subject: `SMTP 测试邮件 - ${new Date().toLocaleString()}`,
      text: '这是一封用于验证 SMTP 配置是否可用的测试邮件。',
      html: `<p>这是一封用于验证 SMTP 配置是否可用的测试邮件。</p><p>时间：${new Date().toLocaleString()}</p>`
    });

    return res.json({ ok: true, to, messageId: info && info.messageId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
app.get('/admin/reservations-enhanced', requireAdmin, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.id as chamber_id, c.name as chamber_name, u.username
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            JOIN users u ON r.user_id = u.id
            ORDER BY r.start_date DESC
        `;
        
        const reservations = await dbAll(query);
        const chambers = await dbAll('SELECT * FROM chambers');
        
        res.render('admin/reservations-enhanced', { 
            title: '预约管理（增强）',
            reservations, 
            chambers,
            user: req.session.username,
            role: req.session.userRole,
            moment 
        });
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

// 删除预约（管理员功能）
app.delete('/admin/reservations/:id', requireAdmin, async (req, res) => {
    try {
        const reservationId = req.params.id;
        
        // 检查预约是否存在
        const reservation = await dbGet('SELECT * FROM reservations WHERE id = ?', [reservationId]);
        if (!reservation) {
            return res.status(404).json({ error: '预约不存在' });
        }
        
        // 执行删除操作
        await dbRun('DELETE FROM reservations WHERE id = ?', [reservationId]);
        
        res.json({ success: true, message: '预约删除成功' });
    } catch (error) {
        console.error('Delete reservation error:', error);
        res.status(500).json({ error: '删除预约失败' });
    }
});

app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const showAll = req.query.all === '1' && req.session.userRole === 'admin';
    let sql;
    if (showAll) {
      // 管理员查看所有公告
      sql = `SELECT * FROM announcements ORDER BY created_at DESC`;
    } else {
      // 普通用户只看最新的2条活跃公告
      sql = `SELECT * FROM announcements WHERE is_active = 1 ORDER BY created_at DESC LIMIT 2`;
    }
    const rows = await dbAll(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: '获取公告失败' });
  }
});

app.post('/api/announcements', requireAdmin, async (req, res) => {
  try {
    const { title, content, type = 'info', is_active = 1 } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题与内容不能为空' });
    const result = await dbRun(
      `INSERT INTO announcements (title, content, type, is_active) VALUES (?, ?, ?, ?)`,
      [title, content, type, is_active ? 1 : 0]
    );
    const row = await dbGet(`SELECT * FROM announcements WHERE id = ?`, [result.lastID]);
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ error: '创建公告失败' });
  }
});

app.put('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, type, is_active } = req.body;
    const existing = await dbGet(`SELECT * FROM announcements WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: '公告不存在' });
    const newTitle = title ?? existing.title;
    const newContent = content ?? existing.content;
    const newType = type ?? existing.type;
    const newActive = typeof is_active === 'undefined' ? existing.is_active : (is_active ? 1 : 0);
    await dbRun(
      `UPDATE announcements SET title = ?, content = ?, type = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [newTitle, newContent, newType, newActive, id]
    );
    const row = await dbGet(`SELECT * FROM announcements WHERE id = ?`, [id]);
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ error: '更新公告失败' });
  }
});

app.delete('/api/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun(`DELETE FROM announcements WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除公告失败' });
  }
});

app.get('/api/reservations/:id', requireAdmin, async (req, res) => {
    try {
        const reservationId = req.params.id;
        const reservation = await dbGet(`
            SELECT r.*, c.name as chamber_name, u.username 
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            JOIN users u ON r.user_id = u.id
            WHERE r.id = ?
        `, [reservationId]);
        
        if (!reservation) {
            return res.status(404).json({ error: '预约未找到' });
        }
        
        res.json(reservation);
    } catch (error) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// 批量操作路由
app.post('/admin/reservations/batch/approve', requireAdmin, async (req, res) => {
    try {
        const { reservationIds } = req.body;
        
        if (!reservationIds || !Array.isArray(reservationIds) || reservationIds.length === 0) {
            return res.status(400).json({ error: '请提供有效的预约ID列表' });
        }

        const placeholders = reservationIds.map(() => '?').join(',');
        
        // 更新预约状态
        await dbRun(`UPDATE reservations SET status = 'approved', updated_at = DATETIME("now","localtime") WHERE id IN (${placeholders})`, reservationIds);
        
        // 发送通知邮件给每个用户
        for (const reservationId of reservationIds) {
            try {
                const reservation = await dbGet(`
                    SELECT r.*, u.id as user_id 
                    FROM reservations r
                    JOIN users u ON r.user_id = u.id
                    WHERE r.id = ?
                `, [reservationId]);
                
                if (reservation) {
                    await sendStatusUpdateEmail(reservation.user_id, reservationId, 'approved', '批量审核通过');
                }
            } catch (emailError) {
                console.error('Batch approve email notification failed:', emailError);
            }
        }
        
        res.json({ success: true, message: `成功批准 ${reservationIds.length} 个预约` });
    } catch (error) {
        console.error('Batch approve error:', error);
        res.status(500).json({ error: '批量操作失败' });
    }
});

app.post('/admin/reservations/batch/reject', requireAdmin, async (req, res) => {
    try {
        const { reservationIds, reason } = req.body;
        
        if (!reservationIds || !Array.isArray(reservationIds) || reservationIds.length === 0) {
            return res.status(400).json({ error: '请提供有效的预约ID列表' });
        }

        const placeholders = reservationIds.map(() => '?').join(',');
        
        // 更新预约状态
        await dbRun(`UPDATE reservations SET status = 'rejected', updated_at = DATETIME("now","localtime") WHERE id IN (${placeholders})`, reservationIds);
        
        // 发送通知邮件给每个用户
        for (const reservationId of reservationIds) {
            try {
                const reservation = await dbGet(`
                    SELECT r.*, u.id as user_id 
                    FROM reservations r
                    JOIN users u ON r.user_id = u.id
                    WHERE r.id = ?
                `, [reservationId]);
                
                if (reservation) {
                    await sendStatusUpdateEmail(reservation.user_id, reservationId, 'rejected', reason || '批量审核拒绝');
                }
            } catch (emailError) {
                console.error('Batch reject email notification failed:', emailError);
            }
        }
        
        res.json({ success: true, message: `成功拒绝 ${reservationIds.length} 个预约` });
    } catch (error) {
        console.error('Batch reject error:', error);
        res.status(500).json({ error: '批量操作失败' });
    }
});

// Admin: User management - list users
app.get('/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await dbAll('SELECT id, username, email, role, status, created_at FROM users ORDER BY created_at DESC');
        const message = req.session.message;
        const error = req.session.error;
        const resetPassword = req.session.resetPassword;
        const resetUser = req.session.resetUser;
        delete req.session.message;
        delete req.session.error;
        delete req.session.resetPassword;
        delete req.session.resetUser;
        res.render('admin/users', { 
            title: '用户管理', 
            users, 
            user: req.session.username, 
            role: req.session.userRole, 
            moment, 
            message, 
            error, 
            resetPassword, 
            resetUser 
        });
    } catch (error) {
        res.status(500).send('服务器错误');
    }
});

// Admin: approve user
app.post('/admin/users/:id/approve', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('UPDATE users SET status = ? WHERE id = ?', ['active', id]);
        req.session.message = '用户已启用';
        res.redirect('/admin/users');
    } catch (error) {
        req.session.error = '操作失败';
        res.redirect('/admin/users');
    }
});

// Admin: reject user
app.post('/admin/users/:id/reject', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('UPDATE users SET status = ? WHERE id = ?', ['rejected', id]);
        req.session.message = '用户已拒绝';
        res.redirect('/admin/users');
    } catch (error) {
        req.session.error = '操作失败';
        res.redirect('/admin/users');
    }
});

// Admin: reset user password
app.post('/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const user = await dbGet('SELECT username, role FROM users WHERE id = ?', [userId]);
        if (!user) {
            req.session.error = '用户不存在';
            return res.redirect('/admin/users');
        }
        if (user.role === 'admin') {
            req.session.error = '不能为管理员账户重置密码';
            return res.redirect('/admin/users');
        }

        const newPassword = 'test123';
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

        req.session.resetPassword = newPassword;
        req.session.resetUser = user.username;
        req.session.message = `已重置用户 ${user.username} 的密码。`;
        res.redirect('/admin/users');
    } catch (error) {
        console.error('Reset password error:', error);
        req.session.error = '重置密码失败';
        res.redirect('/admin/users');
    }
});

// Admin: delete user
app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
    const targetUserId = req.params.id;
    try {
        const user = await dbGet('SELECT id, username, role FROM users WHERE id = ?', [targetUserId]);
        if (!user) {
            req.session.error = '用户不存在';
            return res.redirect('/admin/users');
        }
        if (user.role === 'admin') {
            req.session.error = '不能删除管理员账号';
            return res.redirect('/admin/users');
        }

        // 开启事务，保证一致性
        await dbRun('BEGIN TRANSACTION');

        // 找到所有未完成预约并取消
        const activeReservations = await dbAll('SELECT id FROM reservations WHERE user_id = ? AND status IN ("pending", "approved")', [targetUserId]);
        let cancelledCount = 0;
        for (const r of activeReservations) {
            await dbRun('UPDATE reservations SET status = "cancelled" WHERE id = ?', [r.id]);
            cancelledCount++;
            // 发送取消通知（如果配置了邮件）
            try {
                await sendStatusUpdateEmail(targetUserId, r.id, 'cancelled', '因用户账号被管理员删除，预约已自动取消');
            } catch (emailError) {
                console.error('Send cancel email failed:', emailError);
            }
        }

        // 删除用户
        await dbRun('DELETE FROM users WHERE id = ?', [targetUserId]);

        await dbRun('COMMIT');

        req.session.message = `已删除用户 ${user.username}，并取消其 ${cancelledCount} 个预约（如有）。`;
        return res.redirect('/admin/users');
    } catch (error) {
        console.error('Delete user error:', error);
        try { await dbRun('ROLLBACK'); } catch (_) {}
        req.session.error = '删除用户失败';
        return res.redirect('/admin/users');
    }
});

// Admin: change password page
app.get('/admin/change-password', requireAdmin, (req, res) => {
    const { message, error } = req.session;
    // 清理一次性消息
    req.session.message = null;
    req.session.error = null;
    res.render('admin/change-password', { 
        title: '修改管理员密码', 
        user: req.session.username, 
        role: req.session.userRole, 
        message, 
        error 
    });
});

// Admin: change password POST
app.post('/admin/change-password', requireAdmin, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        // Validate input
        if (!currentPassword || !newPassword || !confirmPassword) {
            req.session.error = '所有字段都必须填写';
            return res.redirect('/admin/change-password');
        }
        
        if (newPassword !== confirmPassword) {
            req.session.error = '新密码两次输入不一致';
            return res.redirect('/admin/change-password');
        }
        
        if (newPassword.length < 6) {
            req.session.error = '新密码至少6位';
            return res.redirect('/admin/change-password');
        }
        
        // Get current user
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        if (!user) {
            req.session.error = '用户不存在';
            return res.redirect('/admin/change-password');
        }
        
        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) {
            req.session.error = '当前密码错误';
            return res.redirect('/admin/change-password');
        }
        
        // Hash and update new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.session.userId]);
        
        req.session.message = '密码修改成功';
        res.redirect('/admin/change-password');
    } catch (error) {
        req.session.error = '修改密码失败';
        res.redirect('/admin/change-password');
    }
});

// 通知管理页面路由
app.get('/admin/notifications', requireAdmin, (req, res) => {
    res.render('admin/notifications', { 
        title: '系统通知管理', 
        user: req.session.username, 
        role: req.session.userRole 
    });
});

// 统计页面路由
app.get('/admin/statistics', requireAdmin, (req, res) => {
    res.render('admin/statistics', { 
        title: '数据统计', 
        user: req.session.username, 
        role: req.session.userRole 
    });
});

// 综合统计数据API
app.get('/api/admin/comprehensive-stats', requireAdmin, async (req, res) => {
    try {
        // 基础统计数据
        const totalChambers = await dbGet('SELECT COUNT(*) as count FROM chambers');
        const totalUsers = await dbGet('SELECT COUNT(*) as count FROM users');
        const totalReservations = await dbGet('SELECT COUNT(*) as count FROM reservations');
        const pendingReservations = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE status = "pending"');
        
        // 预约状态分布
        const reservationsByStatus = await dbAll(`
            SELECT status, COUNT(*) as count 
            FROM reservations 
            GROUP BY status
        `);
        
        // 过去7天的预约趋势
        const reservationTrend = await dbAll(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as count
            FROM reservations 
            WHERE created_at >= DATE('now', '-7 days')
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);
        
        // 温箱利用率统计
        const chamberUtilization = await dbAll(`
            SELECT 
                c.id,
                c.name,
                COUNT(r.id) as total_reservations,
                COUNT(CASE WHEN r.status = 'approved' THEN 1 END) as approved_reservations,
                COUNT(CASE WHEN r.status = 'approved' AND r.start_date <= DATE('now','localtime') AND r.end_date >= DATE('now','localtime') THEN 1 END) as current_active
            FROM chambers c
            LEFT JOIN reservations r ON c.id = r.chamber_id
            GROUP BY c.id, c.name
            ORDER BY total_reservations DESC
        `);
        
        // 月度预约统计（过去6个月）
        const monthlyReservations = await dbAll(`
            SELECT 
                strftime('%Y-%m', created_at) as month,
                COUNT(*) as count
            FROM reservations 
            WHERE created_at >= DATE('now', '-6 months')
            GROUP BY strftime('%Y-%m', created_at)
            ORDER BY month DESC
        `);
        
        // 用户活跃度统计
        const userActivity = await dbAll(`
            SELECT 
                u.username,
                COUNT(r.id) as reservation_count,
                MAX(r.created_at) as last_reservation
            FROM users u
            LEFT JOIN reservations r ON u.id = r.user_id
            WHERE u.status = 'approved'
            GROUP BY u.id, u.username
            ORDER BY reservation_count DESC
            LIMIT 10
        `);
        
        // 当前系统状态
        const currentStatus = await dbGet(`
            SELECT 
                COUNT(CASE WHEN c.status = 'available' THEN 1 END) as available_chambers,
                COUNT(CASE WHEN c.status = 'maintenance' THEN 1 END) as maintenance_chambers,
                COUNT(CASE WHEN r.status = 'approved' AND r.start_date <= DATE('now','localtime') AND r.end_date >= DATE('now','localtime') THEN 1 END) as active_reservations
            FROM chambers c
            LEFT JOIN reservations r ON c.id = r.chamber_id
        `);
        
        res.json({
            success: true,
            data: {
                basic: {
                    totalChambers: totalChambers.count,
                    totalUsers: totalUsers.count,
                    totalReservations: totalReservations.count,
                    pendingReservations: pendingReservations.count
                },
                reservationsByStatus,
                reservationTrend,
                chamberUtilization,
                monthlyReservations,
                userActivity,
                currentStatus
            }
        });
    } catch (error) {
        console.error('Statistics API error:', error);
        res.status(500).json({ error: '获取统计数据失败' });
    }
});

// 404 处理器
app.use((req, res) => {
  res.status(404).render('error', { 
    title: '页面未找到',
    message: '抱歉，您访问的页面不存在。',
    user: req.session ? req.session.username : null,
    role: req.session ? req.session.userRole : undefined
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { 
    title: '服务器错误',
    message: '服务器内部错误，请稍后再试。',
    user: req.session ? req.session.username : null,
    role: req.session ? req.session.userRole : undefined
  });
});

// 发送新预约通知给管理员
async function sendAdminNewReservationEmail(userId, chamberId, reservationData) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping admin new reservation email.');
            return;
        }
        const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
        const chamber = await dbGet('SELECT name FROM chambers WHERE id = ?', [chamberId]);
        if (!user || !chamber) return;

        const mailOptions = {
            from: EMAIL_USER,
            to: ADMIN_EMAIL,
            subject: '新的温箱预约申请待审核 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #e07a5f;">新的预约申请待审核</h2>
                    <p>管理员您好，系统收到一条新的预约申请：</p>
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">申请详情</h3>
                        <p><strong>申请人：</strong>${user.username}（${user.email}）</p>
                        <p><strong>温箱名称：</strong>${chamber.name}</p>
                        <p><strong>项目名称：</strong>${reservationData.project_name}</p>
                        <p><strong>使用人：</strong>${reservationData.project_leader}</p>
                        <p><strong>部门：</strong>${reservationData.department}</p>
                        <p><strong>时间：</strong>${reservationData.start_date} 至 ${reservationData.end_date}</p>
                        <p><strong>测试项：</strong>${reservationData.test_item}</p>
                        ${reservationData.reservation_id ? `<p><strong>预约ID：</strong>${reservationData.reservation_id}</p>` : ''}
                    </div>
                    <p>请前往管理后台审核：<a href="http://localhost:${PORT}/admin/reservations-enhanced">预约管理</a></p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
        
        // 创建系统通知给管理员
        await dbRun(`
            INSERT INTO system_notifications (title, message, type, target_role, created_at)
            VALUES (?, ?, ?, ?, DATETIME('now','localtime'))
        `, [
            '新预约申请',
            `${user.username} 申请预约 ${chamber.name}：${reservationData.project_name}`,
            'reservation_pending',
            'admin'
        ]);
    } catch (error) {
        console.error('Admin new reservation email failed:', error);
    }
}

// 发送新排队申请通知给管理员
async function sendAdminNewQueueRequestEmail(userId, requestData) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping admin new queue request email.');
            return;
        }
        const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
        if (!user) return;

        const urgencyColors = {
            'low': '#6c757d',
            'normal': '#0d6efd', 
            'high': '#fd7e14',
            'urgent': '#dc3545'
        };

        const urgencyLabels = {
            'low': '低',
            'normal': '普通',
            'high': '高',
            'urgent': '紧急'
        };

        const mailOptions = {
            from: EMAIL_USER,
            to: ADMIN_EMAIL,
            subject: '新的温箱排队申请待处理 - 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #e07a5f;">新的排队申请待处理</h2>
                    <p>管理员您好，系统收到一条新的排队申请：</p>
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">申请详情</h3>
                        <p><strong>提交人：</strong>${user.username}（${user.email}）</p>
                        <p><strong>申请人：</strong>${requestData.applicant_name}</p>
                        <p><strong>项目：</strong>${requestData.project_name}</p>
                        <p><strong>申请温箱：</strong>${requestData.chamber_name}</p>
                        <p><strong>期望排队日期：</strong>${requestData.queue_date}</p>
                        <p><strong>温度范围：</strong>${requestData.temperature_range}</p>
                        <p><strong>盘片数量：</strong>${requestData.plate_count}</p>
                        <p><strong>紧急程度：</strong><span style="color: ${urgencyColors[requestData.urgency_level]}; font-weight: bold;">${urgencyLabels[requestData.urgency_level]}</span></p>
                        ${requestData.description ? `<p><strong>描述：</strong>${requestData.description}</p>` : ''}
                    </div>
                    <p>请前往管理后台处理：<a href="http://localhost:${PORT}/admin/queue-requests">排队申请管理</a></p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Admin new queue request email failed:', error);
    }
}

// 发送排队申请状态变更通知
async function sendQueueRequestStatusEmail(userId, requestId, status, responseMessage, chamberName, queueDate) {
    try {
        if (!emailConfigured) {
            console.info('Email not configured. Skipping queue request status email.');
            return;
        }
        const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
        if (!user) return;
        
        // 使用传入的温箱名称和排队日期参数

        const statusLabels = {
            'approved': '已通过',
            'rejected': '已拒绝',
            'cancelled': '已取消'
        };

        const statusColors = {
            'approved': '#28a745',
            'rejected': '#dc3545',
            'cancelled': '#6c757d'
        };
        
        // 格式化排队日期
        const queueDateFormatted = queueDate ? new Date(queueDate).toLocaleDateString('zh-CN') : '未指定';
        const chamberNameDisplay = chamberName || '未指定';

        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: `排队申请${statusLabels[status]} - 温箱预约系统`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: ${statusColors[status]};">排队申请${statusLabels[status]}</h2>
                    <p>${user.username}，您好！</p>
                    <p>您的排队申请（申请ID：${requestId}）已经<strong style="color: ${statusColors[status]};">${statusLabels[status]}</strong>。</p>
                    
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">申请详情</h3>
                        <p><strong>温箱名称：</strong>${chamberNameDisplay}</p>
                        ${status === 'approved' ? `<p><strong>排队日期：</strong>${queueDateFormatted}</p>` : ''}
                    </div>
                    
                    ${responseMessage ? `
                        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                            <h3 style="margin-top: 0;">管理员回复</h3>
                            <p>${responseMessage}</p>
                        </div>
                    ` : ''}
                    <p>如有疑问，请联系系统管理员。</p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送。</p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Queue request status email failed:', error);
    }
}

// 高级实时通知系统API - 性能优化版本3.0
app.get('/api/notifications/stream', requireAuth, async (req, res) => {
    // 使用响应缓存控制，减少不必要的重复请求
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    
    try {
        const lastCheck = req.query.lastCheck || '1970-01-01T00:00:00.000Z';
        const isAdmin = req.session.userRole === 'admin';
        const userId = req.session.userId;
        
        // 使用内存缓存减少频繁请求的数据库负担
        const cacheKey = `notifications_${userId}_${lastCheck}`;
        const cachedData = notificationCache.get(cacheKey);
        
        // 如果缓存存在且未过期（30秒内），直接返回缓存数据
        if (cachedData && (Date.now() - cachedData.timestamp < 30000)) {
            return res.json(cachedData.data);
        }
        
        // 如果是相同用户的频繁请求（5秒内），返回空结果以减轻服务器负担
        const userRequestKey = `user_request_${userId}`;
        const lastUserRequest = notificationCache.get(userRequestKey);
        if (lastUserRequest && (Date.now() - lastUserRequest < 5000)) {
            return res.json({
                hasNew: false,
                notifications: [],
                timestamp: new Date().toISOString()
            });
        }
        notificationCache.set(userRequestKey, Date.now());
        
        // 使用Promise.all并行执行查询以提高性能
        let notificationPromises = [];
        
        if (isAdmin) {
            // 管理员通知：优化查询
            // 1. 待审核用户查询 - 添加索引提示和限制返回字段
            notificationPromises.push(
                dbAll(`
                    SELECT id, username, email, created_at, 'user_registration' as type
                    FROM users INDEXED BY idx_users_status_created
                    WHERE status = 'pending' AND created_at > ?
                    ORDER BY created_at DESC
                    LIMIT 3
                `, [lastCheck])
            );
            
            // 2. 待审核预约查询 - 优化JOIN顺序和添加索引提示
            notificationPromises.push(
                dbAll(`
                    SELECT r.id, r.created_at, r.start_date, r.end_date, 
                           u.username, c.name as chamber_name, 'reservation_pending' as type
                    FROM reservations r INDEXED BY idx_reservations_status_created
                    JOIN users u ON u.id = r.user_id
                    JOIN chambers c ON c.id = r.chamber_id
                    WHERE r.status = 'pending' AND r.created_at > ?
                    ORDER BY r.created_at DESC
                    LIMIT 3
                `, [lastCheck])
            );
        } else {
            // 普通用户通知：预约状态变更 - 优化查询
            notificationPromises.push(
                dbAll(`
                    SELECT r.id, r.updated_at as created_at, r.status, 
                           c.name as chamber_name, 'reservation_status_change' as type
                    FROM reservations r INDEXED BY idx_reservations_user_updated
                    JOIN chambers c ON c.id = r.chamber_id
                    WHERE r.user_id = ? AND r.updated_at > ? AND r.status != 'pending'
                    ORDER BY r.updated_at DESC
                    LIMIT 3
                `, [userId, lastCheck])
            );
        }
        
        // 系统重要通知 - 优化查询
        notificationPromises.push(
            dbAll(`
                SELECT id, title, message, type, created_at
                FROM system_notifications INDEXED BY idx_system_notifications_created_target
                WHERE created_at > ? AND (target_role = 'all' OR target_role = ?)
                ORDER BY created_at DESC
                LIMIT 3
            `, [lastCheck, isAdmin ? 'admin' : 'user'])
        );
        
        // 并行执行所有查询
        const results = await Promise.all(notificationPromises);
        
        // 合并结果 - 使用更高效的数组操作
        let notifications = [];
        for (const result of results) {
            if (result && result.length) {
                notifications.push(...result);
            }
        }
        
        // 按时间排序 - 限制排序操作的数据量
        if (notifications.length > 1) {
            notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
        
        // 准备响应数据
        const responseData = {
            success: true,
            notifications: notifications.slice(0, 5), // 减少到最多返回5条
            hasNew: notifications.length > 0,
            timestamp: new Date().toISOString()
        };
        
        // 缓存结果
        notificationCache.set(cacheKey, {
            data: responseData,
            timestamp: Date.now()
        });
        
        res.json(responseData);
    } catch (error) {
        console.error('Notification stream error:', error);
        res.status(500).json({ error: '获取通知失败' });
    }
});

// 创建系统通知API
app.post('/api/admin/system-notification', requireAdmin, async (req, res) => {
    try {
        const { title, message, type = 'info', targetRole = 'all' } = req.body;
        
        if (!title || !message) {
            return res.status(400).json({ error: '标题和消息不能为空' });
        }
        
        await dbRun(`
            INSERT INTO system_notifications (title, message, type, target_role, created_at)
            VALUES (?, ?, ?, ?, DATETIME('now','localtime'))
        `, [title, message, type, targetRole]);
        
        res.json({ success: true, message: '系统通知发送成功' });
    } catch (error) {
        console.error('Create system notification error:', error);
        res.status(500).json({ error: '发送通知失败' });
    }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`访问地址: http://localhost:${PORT}`);
  console.log(`邮件配置状态: ${emailConfigured ? '已配置' : '未配置'}`);
});
