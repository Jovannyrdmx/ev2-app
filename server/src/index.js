// server/src/index.js - Express API for nightclub/bartender sync with SoftRestaurant11

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const redis = require('redis');
const { WebSocketServer } = require('ws');
const http = require('http');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:8080'],
    credentials: true
}));

// Database
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'easyflirt_nightclub'
});

// Redis cache (node-redis v4: socket options + explicit connect())
const redisClient = redis.createClient({
    socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
    }
});

redisClient.on('error', (err) => console.error('Redis error:', err.message));
redisClient.on('reconnecting', () => console.warn('Redis reconnecting...'));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

// SoftRestaurant11 API
class SoftRestaurant11Client {
    constructor(apiUrl, apiKey) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
    }

    async getTableStatus() {
        try {
            const response = await axios.get(`${this.apiUrl}/api/tables`, {
                headers: { 'X-API-Key': this.apiKey }
            });
            return response.data;
        } catch (error) {
            console.error('SoftRestaurant11 error:', error.message);
            throw error;
        }
    }

    async getDrinkMenu() {
        try {
            const response = await axios.get(`${this.apiUrl}/api/menu/drinks`, {
                headers: { 'X-API-Key': this.apiKey }
            });
            return response.data;
        } catch (error) {
            console.error('SoftRestaurant11 error:', error.message);
            throw error;
        }
    }

    async createOrder(tableId, items) {
        try {
            const response = await axios.post(`${this.apiUrl}/api/orders`, {
                table_id: tableId,
                items: items,
                type: 'drink'
            }, {
                headers: { 'X-API-Key': this.apiKey }
            });
            return response.data;
        } catch (error) {
            console.error('SoftRestaurant11 error:', error.message);
            throw error;
        }
    }

    async updateOrderStatus(orderId, status) {
        try {
            const response = await axios.patch(`${this.apiUrl}/api/orders/${orderId}`, {
                status: status
            }, {
                headers: { 'X-API-Key': this.apiKey }
            });
            return response.data;
        } catch (error) {
            console.error('SoftRestaurant11 error:', error.message);
            throw error;
        }
    }

    async getInventory() {
        try {
            const response = await axios.get(`${this.apiUrl}/api/inventory`, {
                headers: { 'X-API-Key': this.apiKey }
            });
            return response.data;
        } catch (error) {
            console.error('SoftRestaurant11 error:', error.message);
            throw error;
        }
    }
}

// Initialize SoftRestaurant11 client
const softRestaurant11 = new SoftRestaurant11Client(
    process.env.SOFTRESTAURANT11_URL || 'http://localhost:8888',
    process.env.SOFTRESTAURANT11_API_KEY || 'test-api-key'
);

// Auth Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
}

// ==================== AUTH ENDPOINTS ====================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email, nightclubId, role } = req.body;
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO users (username, password, email, nightclub_id, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, email, role',
            [username, hashedPassword, email, nightclubId, role || 'bartender']
        );
        
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username, nightclubId }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ token, user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password, nightclubId } = req.body;
        
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1 AND nightclub_id = $2',
            [username, nightclubId]
        );
        
        if (!result.rows[0]) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);
        
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ id: user.id, username: user.username, nightclubId }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                nightclubId
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== NIGHTCLUB ENDPOINTS ====================

app.get('/api/nightclubs/:nightclubId', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM nightclubs WHERE id = $1',
            [nightclubId]
        );
        
        res.json(result.rows[0] || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== DRINK MENU & INVENTORY ====================

app.get('/api/nightclubs/:nightclubId/drinks', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        
        // Try to get from Easy Flirt DB first
        const result = await pool.query(
            'SELECT * FROM drinks WHERE nightclub_id = $1 AND available = true ORDER BY price DESC',
            [nightclubId]
        );
        
        if (result.rows.length > 0) {
            return res.json(result.rows);
        }
        
        // Fallback: sync from SoftRestaurant11
        try {
            const drinks = await softRestaurant11.getDrinkMenu();
            
            // Cache in Easy Flirt DB
            for (const drink of drinks) {
                await pool.query(
                    'INSERT INTO drinks (nightclub_id, name, category, price, external_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (nightclub_id, external_id) DO UPDATE SET price = $4',
                    [nightclubId, drink.name, drink.category, drink.price, drink.id]
                );
            }
            
            res.json(drinks);
        } catch (error) {
            res.json(result.rows);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/nightclubs/:nightclubId/inventory', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        
        try {
            const inventory = await softRestaurant11.getInventory();
            
            // Sync to Easy Flirt DB
            for (const item of inventory) {
                await pool.query(
                    'INSERT INTO inventory (nightclub_id, item_id, quantity, low_stock) VALUES ($1, $2, $3, $4) ON CONFLICT (nightclub_id, item_id) DO UPDATE SET quantity = $3, updated_at = NOW()',
                    [nightclubId, item.id, item.quantity, item.low_stock_threshold]
                );
            }
            
            res.json(inventory);
        } catch (error) {
            // Fallback to local DB
            const result = await pool.query(
                'SELECT * FROM inventory WHERE nightclub_id = $1',
                [nightclubId]
            );
            res.json(result.rows);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== DRINK ORDERS ====================

app.post('/api/nightclubs/:nightclubId/drink-orders', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        const { senderId, senderName, recipientId, recipientName, tableId, tableName, drink, message } = req.body;
        
        // Create order in Easy Flirt
        const result = await pool.query(
            'INSERT INTO drink_orders (nightclub_id, sender_id, sender_name, recipient_id, recipient_name, table_id, table_name, drink_name, drink_price, message, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
            [nightclubId, senderId, senderName, recipientId, recipientName, tableId, tableName, drink.name, drink.price, message, 'pending']
        );
        
        const drinkOrder = result.rows[0];
        
        // Sync to SoftRestaurant11 POS
        try {
            await softRestaurant11.createOrder(tableId, [{
                item_id: drink.id || drink.name,
                quantity: 1,
                notes: `From ${senderName}: ${message || ''}`
            }]);
            
            // Update status
            await pool.query(
                'UPDATE drink_orders SET softrestaurant11_order_id = $1, status = $2 WHERE id = $3',
                [drinkOrder.external_order_id, 'confirmed', drinkOrder.id]
            );
        } catch (error) {
            console.error('SoftRestaurant11 sync failed:', error.message);
            // Continue anyway - order is saved locally
        }
        
        // Notify bartender via WebSocket
        broadcastToNightclub(nightclubId, {
            type: 'drink_order',
            event_type: 'new_order',
            data: drinkOrder
        }, 'bartender');
        
        res.status(201).json(drinkOrder);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/nightclubs/:nightclubId/bartenders/:bartenderId/drink-orders', authenticateToken, async (req, res) => {
    try {
        const { nightclubId, bartenderId } = req.params;
        const { status } = req.query;
        
        let query = 'SELECT * FROM drink_orders WHERE nightclub_id = $1';
        const params = [nightclubId];
        
        if (status) {
            query += ' AND status = $' + (params.length + 1);
            params.push(status);
        }
        
        query += ' ORDER BY created_at DESC';
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/nightclubs/:nightclubId/drink-orders/:orderId/confirm', authenticateToken, async (req, res) => {
    try {
        const { nightclubId, orderId } = req.params;
        
        const result = await pool.query(
            'UPDATE drink_orders SET status = $1, confirmed_at = NOW() WHERE nightclub_id = $2 AND id = $3 RETURNING *',
            ['confirmed', nightclubId, orderId]
        );
        
        broadcastToNightclub(nightclubId, {
            type: 'drink_order',
            event_type: 'order_confirmed',
            data: result.rows[0]
        });
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/nightclubs/:nightclubId/drink-orders/:orderId/ready', authenticateToken, async (req, res) => {
    try {
        const { nightclubId, orderId } = req.params;
        
        const result = await pool.query(
            'UPDATE drink_orders SET status = $1, ready_at = NOW() WHERE nightclub_id = $2 AND id = $3 RETURNING *',
            ['ready', nightclubId, orderId]
        );
        
        // Notify server/bartender
        broadcastToNightclub(nightclubId, {
            type: 'drink_order',
            event_type: 'drink_ready',
            data: result.rows[0]
        }, 'server');
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/nightclubs/:nightclubId/drink-orders/:orderId/deliver', authenticateToken, async (req, res) => {
    try {
        const { nightclubId, orderId } = req.params;
        
        const result = await pool.query(
            'UPDATE drink_orders SET status = $1, delivered_at = NOW() WHERE nightclub_id = $2 AND id = $3 RETURNING *',
            ['delivered', nightclubId, orderId]
        );
        
        broadcastToNightclub(nightclubId, {
            type: 'drink_order',
            event_type: 'drink_delivered',
            data: result.rows[0]
        });
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== TABLE MANAGEMENT ====================

app.get('/api/nightclubs/:nightclubId/tables', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        
        // Try SoftRestaurant11 first
        try {
            const tables = await softRestaurant11.getTableStatus();
            
            // Sync to Easy Flirt
            for (const table of tables) {
                await pool.query(
                    'INSERT INTO vip_tables (nightclub_id, table_number, section, capacity, status, external_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (nightclub_id, external_id) DO UPDATE SET status = $5',
                    [nightclubId, table.number, table.section, table.capacity, table.status, table.id]
                );
            }
            
            return res.json(tables);
        } catch (error) {
            // Fallback to local DB
            const result = await pool.query(
                'SELECT * FROM vip_tables WHERE nightclub_id = $1 ORDER BY table_number',
                [nightclubId]
            );
            res.json(result.rows);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/nightclubs/:nightclubId/tables/:tableId/occupants', authenticateToken, async (req, res) => {
    try {
        const { nightclubId, tableId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM table_occupants WHERE nightclub_id = $1 AND table_id = $2',
            [nightclubId, tableId]
        );
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SERVER/BARTENDER DASHBOARD ====================

app.get('/api/nightclubs/:nightclubId/dashboard', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        
        const [pendingOrders, readyOrders, tables, staff] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM drink_orders WHERE nightclub_id = $1 AND status = $2', [nightclubId, 'pending']),
            pool.query('SELECT COUNT(*) FROM drink_orders WHERE nightclub_id = $1 AND status = $2', [nightclubId, 'ready']),
            pool.query('SELECT COUNT(*) FROM vip_tables WHERE nightclub_id = $1 AND status = $2', [nightclubId, 'occupied']),
            pool.query('SELECT COUNT(*) FROM users WHERE nightclub_id = $1 AND active = true', [nightclubId])
        ]);
        
        res.json({
            pending_drink_orders: parseInt(pendingOrders.rows[0].count),
            ready_drink_orders: parseInt(readyOrders.rows[0].count),
            occupied_tables: parseInt(tables.rows[0].count),
            active_staff: parseInt(staff.rows[0].count)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== WEBSOCKET ====================

const wss = new WebSocketServer({ server });
const nightclubs = new Map(); // nightclubId -> Set of connections

wss.on('connection', (ws) => {
    ws.id = require('crypto').randomBytes(8).toString('hex');
    ws.nightclubId = null;
    ws.userId = null;
    ws.role = null;
    
    console.log(`WebSocket client connected: ${ws.id}`);
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'identify') {
                ws.nightclubId = msg.nightclubId;
                ws.userId = msg.userId;
                ws.role = msg.role;
                
                if (!nightclubs.has(ws.nightclubId)) {
                    nightclubs.set(ws.nightclubId, new Set());
                }
                nightclubs.get(ws.nightclubId).add(ws);
                
                console.log(`User identified: ${ws.userId} (${ws.role}) in ${ws.nightclubId}`);
                ws.send(JSON.stringify({ type: 'connected', id: ws.id }));
            } else if (msg.type === 'drink_order' || msg.type === 'flirt') {
                broadcastToNightclub(ws.nightclubId, msg);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.nightclubId && nightclubs.has(ws.nightclubId)) {
            nightclubs.get(ws.nightclubId).delete(ws);
        }
        console.log(`WebSocket client disconnected: ${ws.id}`);
    });
});

function broadcastToNightclub(nightclubId, message, roleFilter = null) {
    if (!nightclubs.has(nightclubId)) return;
    
    const payload = JSON.stringify(message);
    nightclubs.get(nightclubId).forEach(client => {
        if ((!roleFilter || client.role === roleFilter) && client.readyState === 1) {
            client.send(payload);
        }
    });
}

// ==================== SOFTRESTAURANT11 WEBHOOK ====================

app.post('/api/webhooks/softrestaurant11', express.raw({type: 'application/json'}), async (req, res) => {
    try {
        const signature = req.headers['x-signature'];
        const payload = req.body;
        
        // Verify signature (implement based on SoftRestaurant11 docs)
        
        const data = JSON.parse(payload);
        const { event, nightclub_id, data: eventData } = data;
        
        switch (event) {
            case 'order_created':
                // Order created in SoftRestaurant11 - sync to Easy Flirt if needed
                await pool.query(
                    'INSERT INTO drink_orders (nightclub_id, softrestaurant11_order_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    [nightclub_id, eventData.id, 'confirmed']
                );
                break;
                
            case 'order_completed':
                await pool.query(
                    'UPDATE drink_orders SET status = $1, delivered_at = NOW() WHERE softrestaurant11_order_id = $2',
                    ['delivered', eventData.id]
                );
                break;
                
            case 'table_opened':
                broadcastToNightclub(nightclub_id, {
                    type: 'table_event',
                    event_type: 'table_opened',
                    data: eventData
                });
                break;
                
            case 'table_closed':
                broadcastToNightclub(nightclub_id, {
                    type: 'table_event',
                    event_type: 'table_closed',
                    data: eventData
                });
                break;
        }
        
        res.json({ status: 'processed' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'Easy Flirt Nightclub' });
});

const PORT = Number(process.env.PORT || 3000);

async function start() {
    try {
        await redisClient.connect();
        console.log(`Redis connected at ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);

        await pool.query('SELECT 1');
        console.log(`PostgreSQL connected at ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
    } catch (err) {
        console.error('Startup failed (Redis/PostgreSQL unavailable):', err.message);
        process.exit(1);
    }

    server.listen(PORT, () => {
        console.log(`EV2 Nightclub API + WebSocket listening on port ${PORT}`);
        console.log(`SoftRestaurant11 Integration: ${process.env.SOFTRESTAURANT11_URL || 'http://localhost:8888'}`);
    });
}

async function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);
    server.close();
    try { await redisClient.quit(); } catch (_e) { /* already closed */ }
    try { await pool.end(); } catch (_e) { /* already closed */ }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
    start();
}

module.exports = { app, server, pool, redisClient, start };
