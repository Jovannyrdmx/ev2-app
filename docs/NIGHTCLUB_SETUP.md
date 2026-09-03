# Easy Flirt - Nightclub Edition with SoftRestaurant11 Integration

## Overview

Easy Flirt is a complete nightclub real-time system that integrates with **SoftRestaurant11 POS** to enable:

- **Customers** - Browse VIP tables, send drinks to other guests, flirt in real-time
- **Bartenders** - Receive drink orders, manage queue, confirm when drinks are ready
- **Servers** - Pick up ready drinks, deliver to tables, manage table status
- **Managers** - Dashboard with live analytics, inventory, revenue tracking

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│       Easy Flirt Nightclub + SoftRestaurant11 POS       │
└──────────┬──────────────┬──────────────┬────────────────┘
           │              │              │
      ┌────▼───┐    ┌─────▼──┐    ┌────▼────┐
      │  Web   │    │Nightclub│   │WebSocket│
      │  App   │    │  API    │   │ Server  │
      │(8080)  │    │ (3000)  │   │ (4000)  │
      └────┬───┘    └─────┬───┘   └────┬────┘
           │              │              │
      ┌────────────────┬──────────────────────────┐
      │                │                          │
   ┌──▼──┐        ┌────▼─────┐        ┌─────────▼────┐
   │PgSQL│        │  Redis   │        │SoftRestaurant│
   │(5432)        │ (6379)   │        │11 (8888)     │
   └──────┘        └──────────┘        └──────────────┘
```

## Quick Start

### 1. Prerequisites

- Docker & Docker Compose
- SoftRestaurant11 POS system running (local or remote)
- API key from SoftRestaurant11

### 2. Clone & Setup

```bash
git clone <repo>
cd easy-flirt
cp .env.example .env
```

### 3. Configure .env

```bash
# SoftRestaurant11 Connection
SOFTRESTAURANT11_URL=http://your-softrestaurant11-ip:8888
SOFTRESTAURANT11_API_KEY=your_api_key_from_softrestaurant11
SOFTRESTAURANT11_WEBHOOK_SECRET=your_webhook_secret

# Database
DB_PASSWORD=your-secure-password

# JWT
JWT_SECRET=$(openssl rand -base64 32)

# Nightclub Info
NIGHTCLUB_NAME=My Nightclub
NIGHTCLUB_CITY=Nogales
NIGHTCLUB_COUNTRY=Mexico
```

### 4. Start All Services

```bash
# Development
docker-compose up -d

# Check logs
docker-compose logs -f nightclub-api
```

### 5. Access

- **Web App**: http://localhost:8080
- **API**: http://localhost:3000/health
- **WebSocket**: ws://localhost:4000
- **Database**: psql localhost:5432

## SoftRestaurant11 Integration

### Setup Webhook

1. Log in to SoftRestaurant11 Admin
2. Settings → Integrations → Webhooks
3. Add webhook URL: `https://yourdomain.com/api/webhooks/softrestaurant11`
4. Events to enable:
   - Order created
   - Order completed
   - Table opened
   - Table closed
   - Payment processed

### Auto-Synced Data

```
SoftRestaurant11 → Easy Flirt
- Drink menu & prices
- Table status & occupancy
- Order queue
- Inventory levels
- Customer payments
```

### API Example: Create Drink Order

When a customer sends a drink via Easy Flirt:

```javascript
POST /api/nightclubs/{nightclubId}/drink-orders
{
  "senderId": "customer-123",
  "senderName": "María",
  "recipientId": "customer-456",
  "recipientName": "Sofia",
  "tableId": "table-7",
  "tableName": "VIP Table 7",
  "drink": {
    "name": "Margarita",
    "price": 11.00,
    "id": "item-123" // from SoftRestaurant11
  },
  "message": "From that handsome guy at table 7 😉"
}

// Order syncs to SoftRestaurant11 POS automatically
// Bartender sees it in their queue
// When marked "ready", server gets notification
// When delivered, payment added to customer's tab
```

## User Roles & Workflows

### Customer Journey

1. Sign up / Login to Easy Flirt
2. Select a VIP table to "sit at"
3. Browse drink menu (from SoftRestaurant11)
4. Send drink to another guest
5. Receive notifications if they accept flirt/send drink back
6. Pay tab via their room

### Bartender Workflow

1. Check in at shift start (auto-connects to WebSocket)
2. View drink order queue in real-time
3. Prepare drinks as they come in
4. Click "Ready" when drink is made
5. Server notified to pick up
6. Mark as "Delivered" once given to customer

### Server Workflow

1. Check in at shift
2. Get notifications for ready drinks
3. Pick up drinks from bar
4. Deliver to customer's table
5. Confirm delivery (updates POS)
6. Sync to customer's bill

### Manager Dashboard

Real-time metrics:
- Active guests & occupancy
- Drink orders per hour
- Revenue tracking
- Staff performance
- Inventory alerts
- Table turnaround time

## API Endpoints

### Authentication

```bash
# Register/Login
POST /api/auth/register
POST /api/auth/login

# Returns JWT token valid for 7 days
```

### Drink Orders

```bash
# Create drink order (auto-syncs to SoftRestaurant11)
POST /api/nightclubs/:id/drink-orders

# Get bartender's queue
GET /api/nightclubs/:id/bartenders/:id/drink-orders?status=pending

# Confirm drink is being made
POST /api/nightclubs/:id/drink-orders/:id/confirm

# Mark drink ready for pickup
POST /api/nightclubs/:id/drink-orders/:id/ready

# Confirm delivered to customer
POST /api/nightclubs/:id/drink-orders/:id/deliver
```

### Tables & Occupancy

```bash
# Get all VIP tables (synced from SoftRestaurant11)
GET /api/nightclubs/:id/tables

# Get guests at table
GET /api/nightclubs/:id/tables/:id/occupants

# Update table status
PATCH /api/nightclubs/:id/tables/:id
{
  "status": "occupied|cleaning|available"
}
```

### Menu & Inventory

```bash
# Get all drinks (from SoftRestaurant11)
GET /api/nightclubs/:id/drinks

# Get inventory levels
GET /api/nightclubs/:id/inventory

# Low stock alerts automatic
```

### Analytics

```bash
# Get dashboard metrics
GET /api/nightclubs/:id/dashboard

Returns:
{
  "pending_drink_orders": 5,
  "ready_drink_orders": 3,
  "occupied_tables": 12,
  "active_staff": 8
}
```

## WebSocket Events

### Customer Sends Drink

```json
{
  "type": "drink_order",
  "event_type": "new_order",
  "data": {
    "id": "order-123",
    "senderName": "María",
    "recipientName": "Sofia",
    "drinkName": "Margarita",
    "tableName": "VIP Table 7"
  }
}
```

### Bartender Marks Ready

```json
{
  "type": "drink_order",
  "event_type": "drink_ready",
  "data": {
    "id": "order-123",
    "recipientName": "Sofia",
    "tableName": "VIP Table 7"
  }
}
```

### Table Status Changes

```json
{
  "type": "table_event",
  "event_type": "table_opened",
  "data": {
    "tableNumber": "7",
    "section": "vip_lounge",
    "guests": 4
  }
}
```

## Deployment (Production)

### 1. SoftRestaurant11 Setup

```bash
# Create API user in SoftRestaurant11
1. Admin → Users → Create integration user
2. Grant permissions: read:menu, read:orders, write:orders
3. Generate API key
4. Copy webhook secret
```

### 2. SSL Certificate

```bash
# Get Let's Encrypt certificate
sudo certbot certonly --standalone -d yournightclub.com
```

### 3. Update .env

```bash
ENVIRONMENT=production
JWT_SECRET=$(openssl rand -base64 32)

# Your domain
API_HOST=yournightclub.com
WS_URL=wss://yournightclub.com
API_URL=https://yournightclub.com/api

# SoftRestaurant11 production
SOFTRESTAURANT11_URL=https://your-softrestaurant11-domain.com
```

### 4. Deploy

```bash
# Copy SSL certs
cp /etc/letsencrypt/live/yournightclub.com/fullchain.pem ./ssl/cert.pem
cp /etc/letsencrypt/live/yournightclub.com/privkey.pem ./ssl/key.pem

# Start services
docker-compose up -d

# Verify
curl https://yournightclub.com/health
```

## Monitoring

### Logs

```bash
# API logs
docker-compose logs -f nightclub-api

# WebSocket logs
docker-compose logs -f connect-server

# Database logs
docker-compose logs -f postgres
```

### Database Health

```bash
# Connect to database
psql -U postgres -h localhost -d easyflirt_nightclub

# Check pending orders
SELECT * FROM drink_orders WHERE status = 'pending' ORDER BY created_at;

# Check active tables
SELECT * FROM vip_tables WHERE status = 'occupied';

# Revenue today
SELECT SUM(amount) FROM transactions WHERE date(created_at) = current_date;
```

## Troubleshooting

### SoftRestaurant11 Connection Failed

```bash
# Test connection
curl -H "X-API-Key: $SOFTRESTAURANT11_API_KEY" \
  $SOFTRESTAURANT11_URL/api/tables

# Check firewall (SoftRestaurant11 typically runs on port 8888)
telnet your-softrestaurant11-ip 8888

# Verify API key in .env
```

### Orders Not Syncing

```bash
# Check webhook logs
docker-compose logs nightclub-api | grep webhook

# Verify webhook URL configured in SoftRestaurant11
# Test webhook manually:
curl -X POST https://yourdomain.com/api/webhooks/softrestaurant11 \
  -H "X-Signature: test" \
  -d '{"event":"order_created","nightclub_id":"...","data":{}}'
```

### WebSocket Connection Issues

```bash
# Check if WebSocket server is running
docker-compose logs -f connect-server

# Test connection
wscat -c ws://localhost:4000

# In production, verify WSS (secure WebSocket):
curl -I https://yourdomain.com/ws

# Should see Upgrade: websocket in response
```

## Performance Tips

1. **Enable Redis Caching**
   - Drink menu cached for 1 hour
   - Table status cached for 5 minutes
   - Inventory cached for 30 minutes

2. **Database Optimization**
   - Indexes on nightclub_id, status, created_at
   - Archive old transactions monthly
   - Vacuum database weekly

3. **CDN for Images**
   - Upload drink photos to CDN
   - Update image_url in drinks table
   - Reference in API responses

## Feature Flags

Control features per nightclub:

```bash
ENABLE_BOTTLE_SERVICE=true    # Premium bottle service
ENABLE_VIP_TABLES=true        # VIP lounge management
ENABLE_FLIRT=true             # Customer flirting
ENABLE_ANALYTICS=true         # Manager dashboard
```

## Security Checklist

- [ ] Change JWT_SECRET to random 32+ char string
- [ ] SoftRestaurant11 API key stored securely
- [ ] HTTPS/WSS enabled in production
- [ ] Database password strong
- [ ] Rate limiting configured
- [ ] CORS origins whitelisted
- [ ] Webhook signature verification enabled
- [ ] Regular database backups
- [ ] Staff passwords changed monthly
- [ ] API logs monitored

## Support

- Documentation: Check this file
- SoftRestaurant11 Docs: [Their docs]
- Issues/Help: GitHub Issues
- Email: support@easyflirt.local

---

**Version**: 2.0.0 - Nightclub Edition  
**Updated**: 2024  
**License**: MIT
