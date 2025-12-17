const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'temperature-chamber-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// 加载环境变量
require('dotenv').config();

// 获取管理员邮箱配置
const EMAIL_USER = process.env.EMAIL_USER || '9559818@qq.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || EMAIL_USER;

// 内存存储用户数据（简化版）
let users = [
    { id: 1, username: 'admin', email: ADMIN_EMAIL, password: bcrypt.hashSync('admin123', 10), role: 'admin' }
];

let chambers = [
    { id: 1, name: '温箱A', description: '标准温箱，温度范围-40℃~85℃', temperature_range: '-40℃~85℃', capacity: '100L', status: 'available' },
    { id: 2, name: '温箱B', description: '高精度温箱，温度范围-70℃~150℃', temperature_range: '-70℃~150℃', capacity: '150L', status: 'available' },
    { id: 3, name: '温箱C', description: '大容量温箱，温度范围-40℃~100℃', temperature_range: '-40℃~100℃', capacity: '300L', status: 'available' },
    { id: 4, name: '温箱D', description: '快速温变箱，温度范围-60℃~120℃', temperature_range: '-60℃~120℃', capacity: '200L', status: 'available' },
    { id: 5, name: '温箱E', description: '小型温箱，温度范围-20℃~85℃', temperature_range: '-20℃~85℃', capacity: '50L', status: 'available' },
    { id: 6, name: '温箱F', description: '防爆温箱，温度范围-40℃~80℃', temperature_range: '-40℃~80℃', capacity: '120L', status: 'available' },
    { id: 7, name: '温箱G', description: '真空温箱，温度范围-60℃~100℃', temperature_range: '-60℃~100℃', capacity: '180L', status: 'available' },
    { id: 8, name: '温箱H', description: '步入式温箱，温度范围-40℃~85℃', temperature_range: '-40℃~85℃', capacity: '500L', status: 'available' }
];

let reservations = [
    { id: 1, user_id: 1, chamber_id: 1, project_name: '示例项目', project_leader: '张三', department: '研发部', 
      start_date: '2024-12-25', end_date: '2024-12-26', purpose: '温度测试', temperature_range: '-20~80℃', 
      sample_count: 5, special_requirements: '无', status: 'approved' }
];

// 认证中间件
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

// 路由
app.get('/', (req, res) => {
    res.render('index', { user: req.session.username, role: req.session.userRole });
});

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const existingUser = users.find(u => u.username === username || u.email === email);
        
        if (existingUser) {
            return res.send('<script>alert("用户名或邮箱已存在"); window.location.href="/register";</script>');
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: users.length + 1,
            username,
            email,
            password: hashedPassword,
            role: 'user'
        };
        users.push(newUser);
        res.redirect('/login');
    } catch (error) {
        res.send('<script>alert("注册失败"); window.location.href="/register";</script>');
    }
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = users.find(u => u.username === username);

        if (!user) {
            return res.send('<script>alert("用户名或密码错误"); window.location.href="/login";</script>');
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (isValid) {
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.userRole = user.role;
            res.redirect('/dashboard');
        } else {
            res.send('<script>alert("用户名或密码错误"); window.location.href="/login";</script>');
        }
    } catch (error) {
        res.send('<script>alert("登录失败"); window.location.href="/login";</script>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard', { user: req.session.username, role: req.session.userRole });
});

app.get('/chambers', requireAuth, (req, res) => {
    res.render('chambers', { chambers, user: req.session.username, role: req.session.userRole });
});

app.get('/reserve', requireAuth, (req, res) => {
    const availableChambers = chambers.filter(c => c.status === 'available');
    res.render('reserve', { chambers: availableChambers, user: req.session.username, role: req.session.userRole });
});

app.post('/reserve', requireAuth, (req, res) => {
    try {
        const { chamber_id, project_name, project_leader, department, start_date, end_date, 
                purpose, temperature_range, sample_count, special_requirements } = req.body;

        // Check for date conflicts
        const conflicts = reservations.filter(r => 
            r.chamber_id == chamber_id && 
            r.status !== 'cancelled' &&
            ((r.start_date <= start_date && r.end_date >= start_date) || 
             (r.start_date <= end_date && r.end_date >= end_date))
        );

        if (conflicts.length > 0) {
            return res.send('<script>alert("该时间段已被预约，请选择其他时间"); window.location.href="/reserve";</script>');
        }

        const newReservation = {
            id: reservations.length + 1,
            user_id: req.session.userId,
            chamber_id: parseInt(chamber_id),
            project_name,
            project_leader,
            department,
            start_date,
            end_date,
            purpose,
            temperature_range,
            sample_count: parseInt(sample_count),
            special_requirements,
            status: 'pending'
        };

        reservations.push(newReservation);
        res.redirect('/my-reservations');
    } catch (error) {
        res.send('<script>alert("预约失败"); window.location.href="/reserve";</script>');
    }
});

app.get('/my-reservations', requireAuth, (req, res) => {
    const userReservations = reservations.filter(r => r.user_id === req.session.userId);
    const userReservationsWithDetails = userReservations.map(r => ({
        ...r,
        chamber_name: chambers.find(c => c.id === r.chamber_id)?.name || '未知'
    }));
    res.render('my-reservations', { 
        reservations: userReservationsWithDetails, 
        user: req.session.username, 
        role: req.session.userRole, 
        moment 
    });
});

app.post('/cancel-reservation/:id', requireAuth, (req, res) => {
    const reservationId = parseInt(req.params.id);
    const reservation = reservations.find(r => r.id === reservationId && r.user_id === req.session.userId);
    
    if (reservation) {
        reservation.status = 'cancelled';
        res.redirect('/my-reservations');
    } else {
        res.status(404).send('预约未找到或无权取消');
    }
});

// Admin routes
app.get('/admin/chambers', requireAdmin, (req, res) => {
    res.render('admin/chambers', { chambers, user: req.session.username });
});

app.post('/admin/chambers', requireAdmin, (req, res) => {
    const { name, description, temperature_range, capacity, status } = req.body;
    const newChamber = {
        id: chambers.length + 1,
        name,
        description,
        temperature_range,
        capacity,
        status
    };
    chambers.push(newChamber);
    res.redirect('/admin/chambers');
});

app.get('/admin/reservations', requireAdmin, (req, res) => {
    const reservationsWithDetails = reservations.map(r => ({
        ...r,
        chamber_name: chambers.find(c => c.id === r.chamber_id)?.name || '未知',
        username: users.find(u => u.id === r.user_id)?.username || '未知'
    }));
    res.render('admin/reservations', { 
        reservations: reservationsWithDetails, 
        user: req.session.username, 
        moment 
    });
});

app.post('/admin/reservations/:id/status', requireAdmin, (req, res) => {
    const reservationId = parseInt(req.params.id);
    const status = req.body.status;
    const reservation = reservations.find(r => r.id === reservationId);
    
    if (reservation) {
        reservation.status = status;
        res.redirect('/admin/reservations');
    } else {
        res.status(404).send('预约未找到');
    }
});

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
        console.log('默认管理员账号: admin 密码: admin123');
    }
});