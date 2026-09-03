// Easy Flirt — Real-time Connect Server
// Broadcasts table occupancy, drinks, and flirts to all connected clients.
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 4000;

// ---- In-memory shared state (single club instance) ----
let state = {
    tables: {
        t7: { id: "t7", name: "Table 7", section: "main", capacity: 4, occupants: [] },
        t12: { id: "t12", name: "Table 12", section: "main", capacity: 4, occupants: [] },
        "vip-a": { id: "vip-a", name: "VIP Booth A", section: "vip", capacity: 6, occupants: [] },
        "vip-b": { id: "vip-b", name: "VIP Booth B", section: "vip", capacity: 5, occupants: [] },
        "bar-2": { id: "bar-2", name: "Bar High Top 2", section: "bar", capacity: 3, occupants: [] }
    },
    activity: []
};

// clientId -> { ws, user }
const clients = new Map();

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', clients: clients.size }));
        return;
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({ server });

function broadcast(message, exceptId = null) {
    const payload = JSON.stringify(message);
    for (const [id, client] of clients) {
        if (id !== exceptId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(payload);
        }
    }
}

function sendTo(id, message) {
    const client = clients.get(id);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}

function presenceList() {
    return Array.from(clients.values())
        .filter(c => c.user)
        .map(c => ({ id: c.user.id, name: c.user.name, seat: c.user.seat || null }));
}

wss.on('connection', (ws) => {
    const clientId = 'c-' + Math.random().toString(36).slice(2, 10);
    clients.set(clientId, { ws, user: null });

    // Send current snapshot to the newly connected client
    sendTo(clientId, { type: 'snapshot', state, presence: presenceList() });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }

        const client = clients.get(clientId);

        switch (msg.type) {
            case 'identify': {
                client.user = { id: msg.userId, name: msg.userName, seat: msg.seat || null };
                broadcast({ type: 'presence', presence: presenceList() });
                break;
            }

            case 'take_seat': {
                const table = state.tables[msg.tableId];
                if (!table || !client.user) break;

                // Remove user from any other table first
                Object.values(state.tables).forEach(t => {
                    t.occupants = t.occupants.filter(o => o.id !== client.user.id);
                });

                if (!table.occupants.find(o => o.id === client.user.id)) {
                    table.occupants.push({ id: client.user.id, name: client.user.name });
                }
                client.user.seat = msg.tableId;

                broadcast({ type: 'state', state });
                break;
            }

            case 'send_drink': {
                const item = {
                    id: Date.now(),
                    type: 'drink',
                    from: client.user ? client.user.id : msg.fromId,
                    fromName: client.user ? client.user.name : msg.fromName,
                    to: msg.toId,
                    toName: msg.toName,
                    item: msg.drinkName,
                    price: msg.price,
                    table: msg.tableName,
                    timestamp: new Date().toISOString()
                };
                state.activity.unshift(item);
                state.activity = state.activity.slice(0, 100);

                broadcast({ type: 'activity', item });
                break;
            }

            case 'send_flirt': {
                const item = {
                    id: Date.now(),
                    type: 'flirt',
                    from: client.user ? client.user.id : msg.fromId,
                    fromName: client.user ? client.user.name : msg.fromName,
                    to: msg.toId,
                    toName: msg.toName,
                    item: msg.emoji,
                    message: msg.message,
                    timestamp: new Date().toISOString()
                };
                state.activity.unshift(item);
                state.activity = state.activity.slice(0, 100);

                broadcast({ type: 'activity', item });
                break;
            }

            case 'ping': {
                sendTo(clientId, { type: 'pong' });
                break;
            }

            default:
                break;
        }
    });

    ws.on('close', () => {
        clients.delete(clientId);
        broadcast({ type: 'presence', presence: presenceList() });
    });
});

server.listen(PORT, () => {
    console.log(`Easy Flirt Connect server listening on port ${PORT}`);
});
