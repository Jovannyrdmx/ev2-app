// server/restaurant-api.js - Express API for restaurant/waiter sync

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const redis = require('redis');
const { WebSocketServer } = require('ws');
const http = require('http');

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
    database: process.env.DB_NAME || 'easyflirt'
});

// Redis cache
const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redisClient.on('error', (err) => console.log('Redis error:', err));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const API_KEY_SECRET = process.env.API_KEY_SECRET || 'dev-api-key-secret';

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

function authenticateAPIKey(req, res, next) {
    const apiKey = req.headers['authorization']?.split(' ')[1];
    
    if (!apiKey) {
        return res.status(401).json({ error: 'No API key provided' });
    }
    
    // Verify API key against database
    pool.query('SELECT * FROM api_keys WHERE key = $1 AND active = true', [apiKey], (err, result) => {
        if (err || !result.rows[0]) {
            return res.status(403).json({ error: 'Invalid API key' });
        }
        
        req.restaurantId = result.rows[0].restaurant_id;
        next();
    });
}

// ==================== AUTH ENDPOINTS ====================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email, restaurantId, role } = req.body;
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO users (username, password, email, restaurant_id, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, email, role',
            [username, hashedPassword, email, restaurantId, role || 'waiter']
        );
        
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username, restaurantId }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ token, user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password, restaurantId } = req.body;
        
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1 AND restaurant_id = $2',
            [username, restaurantId]
        );
        
        if (!result.rows[0]) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);
        
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ id: user.id, username: user.username, restaurantId }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                restaurantId
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/api-key', async (req, res) => {
    try {
        const { restaurant_id } = req.body;
        const apiKey = require('crypto').randomBytes(32).toString('hex');
        
        await pool.query(
            'INSERT INTO api_keys (key, restaurant_id, active) VALUES ($1, $2, true)',
            [apiKey, restaurant_id]
        );
        
        res.json({ apiKey });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== RESTAURANT ENDPOINTS ====================

app.get('/api/restaurants/:restaurantId', authenticateToken, async (req, res) => {
    try {
        const { restaurantId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM restaurants WHERE id = $1',
            [restaurantId]
        );
        
        res.json(result.rows[0] || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== MENU & INVENTORY ====================

app.get('/api/restaurants/:restaurantId/menu', authenticateToken, async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { category } = req.query;
        
        let query = 'SELECT * FROM menu_items WHERE restaurant_id = $1';
        const params = [restaurantId];
        
        if (category) {
            query += ' AND category = $2';
            params.push(category);
        }
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/restaurants/:restaurantId/inventory', authenticateToken, async (req, res) => {
    try {
        const { restaurantId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM inventory WHERE restaurant_id = $1',
            [restaurantId]
        );
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/restaurants/:restaurantId/inventory/:itemId', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, itemId } = req.params;
        const { quantity } = req.body;
        
        const result = await pool.query(
            'UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE restaurant_id = $2 AND item_id = $3 RETURNING *',
            [quantity, restaurantId, itemId]
        );
        
        // Broadcast inventory update via WebSocket
        broadcastToRestaurant(restaurantId, {
            type: 'restaurant_event',
            event_type: 'inventory_update',
            data: result.rows[0]
        });
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ORDERS ====================

app.post('/api/restaurants/:restaurantId/orders', authenticateToken, async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { tableId, customerId, items, notes } = req.body;
        
        const result = await pool.query(
            'INSERT INTO orders (restaurant_id, table_id, customer_id, items, notes, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [restaurantId, tableId, customerId, JSON.stringify(items), notes, 'pending']
        );
        
        const order = result.rows[0];
        
        // Broadcast order to kitchen/bartender
        broadcastToRestaurant(restaurantId, {
            type: 'restaurant_event',
            event_type: 'new_order',
            data: order
        });
        
        res.status(201).json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/restaurants/:restaurantId/orders', authenticateToken, async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { tableId, status } = req.query;
        
        let query = 'SELECT * FROM orders WHERE restaurant_id = $1';
        const params = [restaurantId];
        
        if (tableId) {
            query += ' AND table_id = $' + (params.length + 1);
            params.push(tableId);
        }
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

app.patch('/api/restaurants/:restaurantId/orders/:orderId', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, orderId } = req.params;
        const { status } = req.body;
        
        const result = await pool.query(
            'UPDATE orders SET status = $1, updated_at = NOW() WHERE restaurant_id = $2 AND id = $3 RETURNING *',
            [status, restaurantId, orderId]
        );
        
        const order = result.rows[0];
        
        // Notify waiter if ready
        if (status === 'ready') {
            const waiterResult = await pool.query(
                'SELECT waiter_id FROM table_assignments WHERE table_id = $1',
                [order.table_id]
            );
            
            if (waiterResult.rows[0]) {
                broadcastToWaiter(waiterResult.rows[0].waiter_id, {
                    type: 'restaurant_event',
                    event_type: 'order_ready',
                    data: { orderId, tableId: order.table_id }
                });
            }
        }
        
        res.json(order);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== DRINK ORDERS ====================

app.post('/api/restaurants/:restaurantId/drinks', authenticateToken, async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { senderId, senderName, recipientId, recipientName, tableId, tableName, drink, message } = req.body;
        
        const result = await pool.query(
            'INSERT INTO drink_orders (restaurant_id, sender_id, sender_name, recipient_id, recipient_name, table_id, table_name, drink, message, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [restaurantId, senderId, senderName, recipientId, recipientName, tableId, tableName, JSON.stringify(drink), message, 'pending']
        );
        
        const drinkOrder = result.rows[0];
        
        // Notify bartender
        broadcastToRole(restaurantId, 'bartender', {
            type: 'restaurant_event',
            event_type: 'new_drink_order',
            data: drinkOrder
        });
        
        res.status(201).json(drinkOrder);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/restaurants/:restaurantId/waiters/:waiterId/drinks', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, waiterId } = req.params;
        const { status } = req.query;
        
        let query = 'SELECT * FROM drink_orders WHERE restaurant_id = $1 AND recipient_id = $2';
        const params = [restaurantId, waiterId];
        
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

app.post('/api/restaurants/:restaurantId/drinks/:drinkId/deliver', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, drinkId } = req.params;
        
        const result = await pool.query(
            'UPDATE drink_orders SET status = $1, delivered_at = NOW() WHERE restaurant_id = $2 AND id = $3 RETURNING *',
            ['delivered', restaurantId, drinkId]
        );
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== WAITER MANAGEMENT ====================

app.get('/api/restaurants/:restaurantId/waiters/:waiterId/tables', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, waiterId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM table_assignments WHERE restaurant_id = $1 AND waiter_id = $2',
            [restaurantId, waiterId]
        );
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/restaurants/:restaurantId/tables/:tableId/status', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, tableId } = req.params;
        const { status } = req.body;
        
        const result = await pool.query(
            'UPDATE table_assignments SET status = $1, updated_at = NOW() WHERE restaurant_id = $2 AND table_id = $3 RETURNING *',
            [status, restaurantId, tableId]
        );
        
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/restaurants/:restaurantId/waiters/:waiterId/checkin', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, waiterId } = req.params;
        
        await pool.query(
            'INSERT INTO waiter_shifts (restaurant_id, waiter_id, checked_in_at) VALUES ($1, $2, NOW()) ON CONFLICT (waiter_id) DO UPDATE SET checked_in_at = NOW()',
            [restaurantId, waiterId]
        );
        
        broadcastToRestaurant(restaurantId, {
            type: 'restaurant_event',
            event_type: 'waiter_checkin',
            data: { waiterId }
        });
        
        res.json({ status: 'checked_in' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/restaurants/:restaurantId/waiters/:waiterId/checkout', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, waiterId } = req.params;
        
        await pool.query(
            'UPDATE waiter_shifts SET checked_out_at = NOW() WHERE restaurant_id = $1 AND waiter_id = $2 AND checked_out_at IS NULL',
            [restaurantId, waiterId]
        );
        
        broadcastToRestaurant(restaurantId, {
            type: 'restaurant_event',
            event_type: 'waiter_checkout',
            data: { waiterId }
        });
        
        res.json({ status: 'checked_out' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== NOTIFICATIONS ====================

app.get('/api/restaurants/:restaurantId/waiters/:waiterId/notifications', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, waiterId } = req.params;
        const { unread } = req.query;
        
        let query = 'SELECT * FROM notifications WHERE restaurant_id = $1 AND waiter_id = $2';
        const params = [restaurantId, waiterId];
        
        if (unread === 'true') {
            query += ' AND read = false';
        }
        
        query += ' ORDER BY created_at DESC LIMIT 50';
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/restaurants/:restaurantId/notifications/:notificationId/read', authenticateToken, async (req, res) => {
    try {
        const { restaurantId, notificationId } = req.params;
        
        await pool.query(
            'UPDATE notifications SET read = true WHERE restaurant_id = $1 AND id = $2',
            [restaurantId, notificationId]
        );
        
        res.json({ status: 'marked_read' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== POS INTEGRATION ====================

app.post('/api/pos/webhook', authenticateAPIKey, async (req, res) => {
    try {
        const { event, data } = req.body;
        const restaurantId = req.restaurantId;
        
        switch (event) {
            case 'order_created':
                // Sync order from POS
                await pool.query(
                    'INSERT INTO orders (restaurant_id, external_id, items, status) VALUES ($1, $2, $3, $4)',
                    [restaurantId, data.id, JSON.stringify(data.items), 'confirmed']
                );
                break;
                
            case 'order_updated':
                await pool.query(
                    'UPDATE orders SET status = $1 WHERE restaurant_id = $2 AND external_id = $3',
                    [data.status, restaurantId, data.id]
                );
                break;
                
            case 'inventory_sync':
                for (const item of data.items) {
                    await pool.query(
                        'INSERT INTO inventory (restaurant_id, item_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (restaurant_id, item_id) DO UPDATE SET quantity = $3',
                        [restaurantId, item.id, item.quantity]
                    );
                }
                break;
        }
        
        res.json({ status: 'processed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== WEBSOCKET ====================

const wss = new WebSocketServer({ server });
const restaurants = new Map(); // restaurantId -> Set of connections

wss.on('connection', (ws) => {
    ws.id = require('crypto').randomBytes(8).toString('hex');
    ws.restaurantId = null;
    ws.userId = null;
    ws.role = null;
    
    console.log(`WebSocket client connected: ${ws.id}`);
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'identify') {
                ws.restaurantId = msg.restaurantId;
                ws.userId = msg.userId;
                ws.role = msg.role;
                
                if (!restaurants.has(ws.restaurantId)) {
                    restaurants.set(ws.restaurantId, new Set());
                }
                restaurants.get(ws.restaurantId).add(ws);
                
                console.log(`User identified: ${ws.userId} (${ws.role}) in ${ws.restaurantId}`);
                ws.send(JSON.stringify({ type: 'connected', id: ws.id }));
            } else if (msg.type === 'restaurant_event') {
                broadcastToRestaurant(ws.restaurantId, msg);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.restaurantId && restaurants.has(ws.restaurantId)) {
            restaurants.get(ws.restaurantId).delete(ws);
        }
        console.log(`WebSocket client disconnected: ${ws.id}`);
    });
});

function broadcastToRestaurant(restaurantId, message) {
    if (!restaurants.has(restaurantId)) return;
    
    const payload = JSON.stringify(message);
    restaurants.get(restaurantId).forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(payload);
        }
    });
}

function broadcastToRole(restaurantId, role, message) {
    if (!restaurants.has(restaurantId)) return;
    
    const payload = JSON.stringify(message);
    restaurants.get(restaurantId).forEach(client => {
        if (client.role === role && client.readyState === 1) {
            client.send(payload);
        }
    });
}

function broadcastToWaiter(waiterId, message) {
    for (const [, conns] of restaurants) {
        const payload = JSON.stringify(message);
        conns.forEach(client => {
            if (client.userId === waiterId && client.readyState === 1) {
                client.send(payload);
            }
        });
    }
}

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Restaurant API + WebSocket server listening on port ${PORT}`);
});
