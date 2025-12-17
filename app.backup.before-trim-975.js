const express = require('express');
const Database = require('sqlite3').Database;
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');
const nodemailer = require('nodemailer');
const engine = require('ejs-mate');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

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
    // 使用已知服务提供商（如gmail、qq�?63等）
    transporterOptions = {
        service: EMAIL_SERVICE,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS,
        },
    };
}
const emailTransporter = nodemailer.createTransport(transporterOptions);

// Database setup
const db = new Database('./database.db');

// Initialize database
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
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
        purpose TEXT NOT NULL,
        temperature_range TEXT,
        sample_count INTEGER,
        special_requirements TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (chamber_id) REFERENCES chambers (id)
    )`);

    // Insert default admin user if not exists and set as active
    const adminPassword = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, email, password, role, status) VALUES (?, ?, ?, ?, ?)`,
      ['admin', 'admin@example.com', adminPassword, 'admin', 'active']);

    // Update existing admin user to active if exists
    db.run(`UPDATE users SET status = 'active' WHERE username = 'admin' AND role = 'admin'`);

    // Insert default chambers if not exists
    const defaultChambers = [
        { name: '温箱A', description: '标准温箱，温度范�?40℃~85�?, temperature_range: '-40℃~85�?, capacity: '100L' },
        { name: '温箱B', description: '高精度温箱，温度范围-70℃~150�?, temperature_range: '-70℃~150�?, capacity: '150L' },
        { name: '温箱C', description: '大容量温箱，温度范围-40℃~100�?, temperature_range: '-40℃~100�?, capacity: '300L' },
        { name: '温箱D', description: '快速温变箱，温度范�?60℃~120�?, temperature_range: '-60℃~120�?, capacity: '200L' },
        { name: '温箱E', description: '小型温箱，温度范�?20℃~85�?, temperature_range: '-20℃~85�?, capacity: '50L' },
        { name: '温箱F', description: '防爆温箱，温度范�?40℃~80�?, temperature_range: '-40℃~80�?, capacity: '120L' },
        { name: '温箱G', description: '真空温箱，温度范�?60℃~100�?, temperature_range: '-60℃~100�?, capacity: '180L' },
        { name: '温箱H', description: '步入式温箱，温度范围-40℃~85�?, temperature_range: '-40℃~85�?, capacity: '500L' }
    ];

    for (const chamber of defaultChambers) {
        db.run('INSERT OR IGNORE INTO chambers (name, description, temperature_range, capacity) VALUES (?, ?, ?, ?)',
          [chamber.name, chamber.description, chamber.temperature_range, chamber.capacity]);
    }
});

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
}

function requireAdmin(req, res, next) {
    if (req.session.userId && req.session.userRole === 'admin') {
        next();
    } else {
        res.redirect('/');
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

app.get('/api/chambers/:id/availability', async (req, res) => {
  try {
    const chamberId = req.params.id;
    const { start_date, end_date } = req.query;
    const query = `
            SELECT * FROM reservations 
            WHERE chamber_id = ? AND status != 'cancelled'
            AND ((start_date <= ? AND end_date >= ?) OR (start_date <= ? AND end_date >= ?))
        `;
    const conflicts = await dbAll(query, [chamberId, start_date, start_date, end_date, end_date]);
    res.json({ available: conflicts.length === 0, conflicts });
  } catch (error) {
    res.status(500).json({ error: '服务器错�? });
  }
});

app.get('/api/chambers/:id/schedule', async (req, res) => {
  try {
    const chamberId = req.params.id;
    const { month } = req.query;
    const query = `
            SELECT * FROM reservations 
            WHERE chamber_id = ? AND status != 'cancelled'
            AND strftime('%Y-%m', start_date) = ?
            ORDER BY start_date
        `;
    const reservations = await dbAll(query, [chamberId, month]);
    res.json(reservations);
  } catch (error) {
    res.status(500).json({ error: '服务器错�? });
  }
});

// Dashboard API endpoints
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const totalChambers = await dbGet('SELECT COUNT(*) as count FROM chambers');
        const totalReservations = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE user_id = ?', [req.session.userId]);
        const pendingReservations = await dbGet('SELECT COUNT(*) as count FROM reservations WHERE user_id = ? AND status = "pending"', [req.session.userId]);
        const availableChambers = await dbGet('SELECT COUNT(*) as count FROM chambers WHERE status = "available"');
        
        res.json({
            totalChambers: totalChambers.count,
            totalReservations: totalReservations.count,
            pendingReservations: pendingReservations.count,
            availableChambers: availableChambers.count
        });
    } catch (error) {
        res.status(500).json({ error: '服务器错�? });
    }
});

app.get('/api/reservations/recent', requireAuth, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.name as chamber_name 
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            WHERE r.user_id = ?
            ORDER BY r.start_date DESC
            LIMIT 5
        `;
        
        const reservations = await dbAll(query, [req.session.userId]);
        res.json(reservations);
    } catch (error) {
        res.status(500).json({ error: '服务器错�? });
    }
});

app.get('/register', (req, res) => {
    res.render('register', { title: '注册' });
});

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        // Validation
        if (!username || username.length < 3) {
            return res.status(400).json({ error: '用户名至少需�?个字�? });
        }
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: '请输入有效的邮箱地址' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ error: '密码至少需�?个字�? });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // 新注册用户默认为待审核状�?pending
        await dbRun('INSERT INTO users (username, email, password, role, status) VALUES (?, ?, ?, ?, ?)', [username, email, hashedPassword, 'user', 'pending']);
        res.json({ success: true, message: '注册成功，已提交管理员审核。审核通过后方可登录�? });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: '用户名或邮箱已存�? });
        } else {
            res.status(500).json({ error: '注册失败，请稍后重试' });
        }
    }
});

app.get('/login', (req, res) => {
    res.render('login-enhanced', { title: '登录' });
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: '请输入用户名和密�? });
        }

        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);

        if (!user) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        // 检查审核状�?        if (user.status === 'pending') {
            return res.status(403).json({ error: '账号正在等待管理员审核，审核通过后方可登录�? });
        }
        if (user.status === 'rejected') {
            return res.status(403).json({ error: '账号审核未通过，请联系管理员�? });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (isValid) {
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.userRole = user.role;
            res.json({ success: true, message: '登录成功', redirect: '/dashboard' });
        } else {
            res.status(401).json({ error: '用户名或密码错误' });
        }
    } catch (error) {
        res.status(500).json({ error: '服务器错�? });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard-enhanced', { title: '控制面板', user: req.session.username, role: req.session.userRole });
});

app.get('/chambers', requireAuth, async (req, res) => {
    try {
        const chambers = await dbAll('SELECT * FROM chambers');
        res.render('chambers', { title: '温箱设备列表', chambers, user: req.session.username, role: req.session.userRole });
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

app.get('/reserve', requireAuth, async (req, res) => {
    try {
        const chambers = await dbAll('SELECT * FROM chambers WHERE status = "available"');
        res.render('reserve-enhanced', { title: '预约温箱', chambers, user: req.session.username, role: req.session.userRole });
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

app.post('/reserve', requireAuth, async (req, res) => {
    try {
        const { chamber_id, project_name, project_leader, department, start_date, end_date, 
                purpose, temperature_range, sample_count, special_requirements } = req.body;

        // Validation
        if (!chamber_id || !project_name || !project_leader || !department || 
            !start_date || !end_date || !purpose) {
            return res.status(400).json({ error: '请填写所有必填字�? });
        }

        if (new Date(start_date) >= new Date(end_date)) {
            return res.status(400).json({ error: '结束日期必须晚于开始日�? });
        }

        if (new Date(start_date) < new Date()) {
            return res.status(400).json({ error: '开始日期不能早于今�? });
        }

        // Check for date conflicts
        const checkQuery = `
            SELECT COUNT(*) as count FROM reservations 
            WHERE chamber_id = ? AND status != 'cancelled' 
            AND ((start_date <= ? AND end_date >= ?) OR (start_date <= ? AND end_date >= ?))
        `;

        const result = await dbGet(checkQuery, [chamber_id, start_date, start_date, end_date, end_date]);

        if (result.count > 0) {
            return res.status(409).json({ error: '该时间段已被预约，请选择其他时间' });
        }

        // 对管理员预约自动通过；普通用户保留为待审�?        const isAdmin = req.session.userRole === 'admin';
        const status = isAdmin ? 'approved' : 'pending';

        const insertQuery = `
            INSERT INTO reservations (user_id, chamber_id, project_name, project_leader, 
            department, start_date, end_date, purpose, temperature_range, sample_count, special_requirements, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const insertResult = await dbRun(insertQuery, [req.session.userId, chamber_id, project_name, project_leader, department, 
                start_date, end_date, purpose, temperature_range, sample_count, special_requirements, status]);
        const newReservationId = insertResult.lastID;
        
        // Send notification email（给申请人）
        try {
            await sendReservationNotification(req.session.userId, chamber_id, {
                project_name, project_leader, department, start_date, end_date, purpose
            });
        } catch (emailError) {
            console.error('Email notification failed:', emailError);
        }

        // 新增：若为普通用户提交预约，则通知管理员有新的待审核申�?        if (!isAdmin) {
            try {
                await sendAdminNewReservationEmail(req.session.userId, chamber_id, {
                    reservation_id: newReservationId,
                    project_name, project_leader, department, start_date, end_date, purpose
                });
            } catch (emailError) {
                console.error('Admin new reservation email failed:', emailError);
            }
        }
        
        const message = isAdmin ? '预约已创建并自动通过' : '预约申请已提交，请等待审�?;
        res.json({ success: true, message });
    } catch (error) {
        res.status(500).json({ error: '预约失败，请稍后重试' });
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
            subject: '温箱预约申请已提�?- 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">温箱预约申请已提�?/h2>
                    <p>尊敬�?${user.username}�?/p>
                    <p>您的温箱预约申请已成功提交，请等待管理员审核�?/p>
                    
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">预约详情</h3>
                        <p><strong>温箱名称�?/strong>${chamber.name}</p>
                        <p><strong>项目名称�?/strong>${reservationData.project_name}</p>
                        <p><strong>项目使用人：</strong>${reservationData.project_leader}</p>
                        <p><strong>所属部门：</strong>${reservationData.department}</p>
                        <p><strong>预约时间�?/strong>${reservationData.start_date} �?${reservationData.end_date}</p>
                        <p><strong>测试目的�?/strong>${reservationData.purpose}</p>
                    </div>
                    
                    <p>审核结果将通过邮件通知您，请耐心等待�?/p>
                    <p>如有疑问，请联系系统管理员�?/p>
                    
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">
                        此邮件由温箱预约系统自动发送，请勿直接回复�?                    </p>
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
            'approved': '已批�?,
            'rejected': '已拒�?,
            'cancelled': '已取�?
        };

        const mailOptions = {
            from: EMAIL_USER,
            to: user.email,
            subject: `预约状态更新：${reservation.project_name} - 温箱预约系统`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">预约状态更�?/h2>
                    <p>尊敬�?${user.username}�?/p>
                    <p>您的温箱预约状态已更新�?/p>
                    
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">预约信息</h3>
                        <p><strong>项目名称�?/strong>${reservation.project_name}</p>
                        <p><strong>温箱名称�?/strong>${reservation.chamber_name}</p>
                        <p><strong>预约时间�?/strong>${reservation.start_date} �?${reservation.end_date}</p>
                        <p><strong>新状态：</strong><span style="color: ${status === 'approved' ? '#28a745' : '#dc3545'}; font-weight: bold;">${statusMap[status]}</span></p>
                        ${reason ? `<p><strong>原因�?/strong>${reason}</p>` : ''}
                    </div>
                    
                    <p>感谢您的使用�?/p>
                    
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">
                        此邮件由温箱预约系统自动发送，请勿直接回复�?                    </p>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Status update email failed:', error);
        // Don't re-throw error to avoid breaking main flow
    }
}

app.get('/my-reservations', requireAuth, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.name as chamber_name, c.description as chamber_description
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            WHERE r.user_id = ?
            ORDER BY r.start_date DESC
        `;

        const reservations = await dbAll(query, [req.session.userId]);
        res.render('my-reservations', { title: '我的预约', reservations, user: req.session.username, role: req.session.userRole, moment });
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

app.post('/cancel-reservation/:id', requireAuth, async (req, res) => {
    try {
        const reservationId = req.params.id;
        const result = await dbRun('UPDATE reservations SET status = "cancelled" WHERE id = ? AND user_id = ?', [reservationId, req.session.userId]);
        
        if (result.changes > 0) {
            res.redirect('/my-reservations');
        } else {
            res.status(404).send('预约未找到或无权取消');
        }
    } catch (error) {
        res.status(500).send('取消失败');
    }
});

// Admin routes
app.get('/admin/chambers', requireAdmin, async (req, res) => {
    try {
        const chambers = await dbAll('SELECT * FROM chambers');
        res.render('admin/chambers', { title: '温箱管理', chambers, user: req.session.username, role: req.session.userRole });
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

app.post('/admin/chambers', requireAdmin, async (req, res) => {
    try {
        const { name, description, temperature_range, capacity, status } = req.body;
        
        if (!name || !description || !temperature_range || !capacity) {
            return res.status(400).json({ error: '请填写所有必填字�? });
        }
        
        await dbRun('INSERT INTO chambers (name, description, temperature_range, capacity, status) VALUES (?, ?, ?, ?, ?)', [name, description, temperature_range, capacity, status || 'available']);
        res.json({ success: true, message: '温箱添加成功' });
    } catch (error) {
        res.status(500).json({ error: '添加失败' });
    }
});

app.put('/admin/chambers/:id', requireAdmin, async (req, res) => {
    try {
        const { name, description, temperature_range, capacity, status } = req.body;
        const chamberId = req.params.id;
        
        await dbRun(`
            UPDATE chambers 
            SET name = ?, description = ?, temperature_range = ?, capacity = ?, status = ?
            WHERE id = ?
        `, [name, description, temperature_range, capacity, status, chamberId]);
        res.json({ success: true, message: '温箱更新成功' });
    } catch (error) {
        res.status(500).json({ error: '更新失败' });
    }
});

app.delete('/admin/chambers/:id', requireAdmin, async (req, res) => {
    try {
        const chamberId = req.params.id;
        
        // Check if chamber has active reservations
        const checkQuery = 'SELECT COUNT(*) as count FROM reservations WHERE chamber_id = ? AND status != "cancelled"';
        const result = await dbGet(checkQuery, [chamberId]);
        
        if (result.count > 0) {
            return res.status(409).json({ error: '该温箱有活跃预约，无法删�? });
        }
        
        await dbRun('DELETE FROM chambers WHERE id = ?', [chamberId]);
        res.json({ success: true, message: '温箱删除成功' });
    } catch (error) {
        res.status(500).json({ error: '删除失败' });
    }
});

app.get('/admin/reservations', requireAdmin, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.name as chamber_name, u.username
            FROM reservations r
            JOIN chambers c ON r.chamber_id = c.id
            JOIN users u ON r.user_id = u.id
            ORDER BY r.start_date DESC
        `;

        const reservations = await dbAll(query);
        res.render('admin/reservations', { title: '预约管理', reservations, user: req.session.username, role: req.session.userRole, moment });
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

app.post('/admin/reservations/:id/status', requireAdmin, async (req, res) => {
    try {
        const reservationId = req.params.id;
        const { status, reason } = req.body;
        
        await dbRun('UPDATE reservations SET status = ? WHERE id = ?', [status, reservationId]);
        
        // Send status update email
        try {
            const reservation = await dbGet('SELECT user_id FROM reservations WHERE id = ?', [reservationId]);
            if (reservation) {
                await sendStatusUpdateEmail(reservation.user_id, reservationId, status, reason);
            }
        } catch (emailError) {
            console.error('Email notification failed:', emailError);
        }
        
        res.json({ success: true, message: '状态更新成�? });
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
        res.status(500).json({ error: '服务器错�? });
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
            return res.status(404).json({ error: '预约未找�? });
        }
        
        res.json(reservation);
    } catch (error) {
        res.status(500).json({ error: '服务器错�? });
    }
});

app.get('/admin/reservations-enhanced', requireAdmin, async (req, res) => {
    try {
        const query = `
            SELECT r.*, c.name as chamber_name, u.username
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
        res.status(500).send('服务器错�?);
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    const acceptsJson = (req.headers.accept || '').includes('application/json') || req.xhr;
    if (acceptsJson) {
        res.status(500).json({ error: '服务器内部错�? });
    } else {
        res.status(500).send('服务器内部错误！');
    }
});

// Admin: User management - list pending users
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
        res.render('admin/users', { title: '用户管理', users, user: req.session.username, role: req.session.userRole, moment, message, error, resetPassword, resetUser });
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

// Admin: approve user
app.post('/admin/users/:id/approve', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('UPDATE users SET status = ? WHERE id = ?', ['active', id]);
        res.redirect('/admin/users');
    } catch (error) {
        res.status(500).send('服务器错�?);
    }
});

// Admin: reject user
app.post('/admin/users/:id/reject', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('UPDATE users SET status = ? WHERE id = ?', ['rejected', id]);
        req.session.message = '用户已拒�?;
        res.redirect('/admin/users');
    } catch (error) {
        req.session.error = '操作失败';
        res.redirect('/admin/users');
    }
});

// Admin: reset user password (POST with returned password)
app.post('/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const user = await dbGet('SELECT username, role FROM users WHERE id = ?', [userId]);
        if (!user) {
            req.session.error = '用户不存�?;
            return res.redirect('/admin/users');
        }
        if (user.role === 'admin') {
            req.session.error = '不能为管理员账户重置密码';
            return res.redirect('/admin/users');
        }

        const newPassword = Math.random().toString(36).slice(-10);
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

        req.session.resetPassword = newPassword;
        req.session.resetUser = user.username;
        req.session.message = `已重置用�?${user.username} 的密码。`;
        res.redirect('/admin/users');
    } catch (error) {
        console.error('Reset password error:', error);
        req.session.error = '重置密码失败';
        res.redirect('/admin/users');
    }
});

// 新增：删除普通用户（会在删除前取消其所有未完成预约�?app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
    const targetUserId = req.params.id;
    try {
        const user = await dbGet('SELECT id, username, role FROM users WHERE id = ?', [targetUserId]);
        if (!user) {
            req.session.error = '用户不存�?;
            return res.redirect('/admin/users');
        }
        if (user.role === 'admin') {
            req.session.error = '不能删除管理员账�?;
            return res.redirect('/admin/users');
        }

        // 开启事务，保证一致�?        await dbRun('BEGIN TRANSACTION');

        // 找到所有未完成预约并取�?        const activeReservations = await dbAll('SELECT id FROM reservations WHERE user_id = ? AND status IN ("pending", "approved")', [targetUserId]);
        let cancelledCount = 0;
        for (const r of activeReservations) {
            await dbRun('UPDATE reservations SET status = "cancelled" WHERE id = ?', [r.id]);
            cancelledCount++;
            // 发送取消通知（如果配置了邮件�?            try {
                await sendStatusUpdateEmail(targetUserId, r.id, 'cancelled', '因用户账号被管理员删除，预约已自动取�?);
            } catch (emailError) {
                console.error('Send cancel email failed:', emailError);
            }
        }

        // 删除用户
        await dbRun('DELETE FROM users WHERE id = ?', [targetUserId]);

        await dbRun('COMMIT');

        req.session.message = `已删除用�?${user.username}，并取消�?${cancelledCount} 个预约（如有）。`;
        return res.redirect('/admin/users');
    } catch (error) {
        console.error('Delete user error:', error);
        try { await dbRun('ROLLBACK'); } catch (_) {}
        req.session.error = '删除用户失败';
        return res.redirect('/admin/users');
    }
});

app.get('/admin/change-password', requireAdmin, (req, res) => {
    const { message, error } = req.session;
    // 清理一次性消�?    req.session.message = null;
    req.session.error = null;
    res.render('admin/change-password', { title: '修改管理员密�?, user: req.session.username, role: req.session.userRole, message, error });
});

// Admin: change own password POST
app.post('/admin/change-password', requireAdmin, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        // Validate input
        if (!currentPassword || !newPassword || !confirmPassword) {
            req.session.error = '所有字段都必须填写';
            return res.redirect('/admin/change-password');
        }
        
        if (newPassword !== confirmPassword) {
            req.session.error = '新密码两次输入不一�?;
            return res.redirect('/admin/change-password');
        }
        
        if (newPassword.length < 6) {
            req.session.error = '新密码至�?�?;
            return res.redirect('/admin/change-password');
        }
        
        // Get current user
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        if (!user) {
            req.session.error = '用户不存�?;
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

// 404 handler
app.use((req, res) => {
    const acceptsJson = (req.headers.accept || '').includes('application/json') || req.xhr;
    if (acceptsJson) {
        res.status(404).json({ error: '页面未找�? });
    } else {
        res.status(404).send('页面未找到！');
    }
});

// 新增：管理员新预约申请提醒邮�?async function sendAdminNewReservationEmail(userId, chamberId, reservationData) {
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
            subject: '新的温箱预约申请待审�?- 温箱预约系统',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #e07a5f;">新的预约申请待审�?/h2>
                    <p>管理员您好，系统收到一条新的预约申请：</p>
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">申请详情</h3>
                        <p><strong>申请人：</strong>${user.username}�?{user.email}�?/p>
                        <p><strong>温箱名称�?/strong>${chamber.name}</p>
                        <p><strong>项目名称�?/strong>${reservationData.project_name}</p>
                        <p><strong>使用人：</strong>${reservationData.project_leader}</p>
                        <p><strong>部门�?/strong>${reservationData.department}</p>
                        <p><strong>时间�?/strong>${reservationData.start_date} �?${reservationData.end_date}</p>
                        <p><strong>测试目的�?/strong>${reservationData.purpose}</p>
                        ${reservationData.reservation_id ? `<p><strong>预约ID�?/strong>${reservationData.reservation_id}</p>` : ''}
                    </div>
                    <p>请前往管理后台审核�?a href="http://localhost:${PORT}/admin/reservations-enhanced">预约管理</a></p>
                    <p style="color: #6c757d; font-size: 12px; margin-top: 30px;">此邮件由系统自动发送�?/p>
                </div>
            `
        };
        await emailTransporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Admin new reservation email failed:', error);
    }
}

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
        console.log('默认管理员账�? admin 密码: admin123');
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
        
