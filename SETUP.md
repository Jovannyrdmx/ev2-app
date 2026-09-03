# Easy Flirt - Full Restaurant & Waiter Integration Setup

## Overview

Easy Flirt is a complete real-time system connecting:
- **Web App** (customers send drinks, flirt with people in club)
- **iOS/Android Apps** (mobile clients)
- **Waiter Tablets** (iPad/Android for drink delivery & table management)
- **Restaurant POS** (Square, Toast, TouchBistro integration)
- **Kitchen/Bar Display** (order queue management)
- **Manager Dashboard** (inventory, staff, sales)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Nginx Reverse Proxy (SSL/WSS)              │
└──────────────┬──────────────┬──────────────┬────────────────────┘
               │              │              │
      ┌────────▼──┐    ┌──────▼───┐    ┌────▼────────┐
      │  Web App  │    │ REST API │    │ WebSocket   │
      │ (8080)    │    │ (3000)   │    │ (4000)      │
      └────────┬──┘    └──────┬───┘    └────┬────────┘
               │              │              │
               └──────────────┼──────────────┘
                              │
                    ┌─────────┴────────┐
                    │                  │
              ┌─────▼────┐      ┌──────▼──┐
              │PostgreSQL│      │  Redis  │
              │(5432)    │      │(6379)   │
              └──────────┘      └─────────┘
```

## Quick Start

### 1. Clone & Setup

```bash
git clone <repo>
cd easy-flirt
cp .env.example .env
```

### 2. Configure .env

Edit `.env` with your settings:

```bash
# Database
DB_USER=postgres
DB_PASSWORD=your-secure-password
DB_NAME=easyflirt

# JWT
JWT_SECRET=your-super-secret-key-min-32-chars

# URLs (for development)
WS_URL=ws://localhost:4000
API_URL=http://localhost:3000
```

### 3. Start All Services

```bash
# Development (with Docker)
docker-compose up -d

# Or run locally
npm install
npm start
```

### 4. Access Points

- **Web App**: http://localhost:8080
- **API Docs**: http://localhost:3000/api
- **WebSocket**: ws://localhost:4000
- **DB Admin**: pgAdmin on http://localhost:5050

## Authentication

### User Roles

1. **Customer** - Send drinks, flirt, manage profile
2. **Waiter** - Manage tables, confirm drink delivery
3. **Bartender** - Prepare drinks from queue
4. **Kitchen** - Prepare food orders
5. **Manager** - Dashboard, inventory, staff management

### Login Flow

```
1. Customer/Staff signs up or logs in
2. System creates JWT token (7-day expiry)
3. Token stored in browser/keychain
4. WebSocket connection authenticated with JWT
5. Real-time events sync across all tabs/devices
```

## POS Integration

### Square Integration

```bash
# Set in .env
POS_SYSTEM=square
SQUARE_API_KEY=your_square_api_key
SQUARE_LOCATION_ID=your_location_id
```

**Features:**
- Auto-sync inventory
- Webhook for order updates
- Payment processing

**Setup:**
1. Create Square Developer account
2. Generate API key
3. Add webhook URL: `https://yourdomain.com/api/pos/webhook`
4. Easy Flirt auto-syncs orders

### Toast POS Integration

```bash
POS_SYSTEM=toast
TOAST_API_KEY=your_toast_api_key
```

### Custom POS

```bash
POST /api/pos/webhook
Authorization: Bearer YOUR_API_KEY

{
  "event": "order_created|order_updated|inventory_sync",
  "data": { /* order/inventory data */ }
}
```

## Waiter Tablet Setup

### iOS (iPad)

```swift
// In your app
let waiterView = WaiterView(
    waiterId: "waiter-001",
    restaurantId: "rest-001"
)

// Environment setup
ProcessInfo.processInfo.environment["WS_URL"] = "wss://yourdomain.com"
ProcessInfo.processInfo.environment["API_URL"] = "https://yourdomain.com/api"
ProcessInfo.processInfo.environment["USER_ROLE"] = "waiter"
```

### Android

```kotlin
// Similar setup in Kotlin
val waiterService = WaiterService.create(
    wsUrl = "wss://yourdomain.com",
    apiUrl = "https://yourdomain.com/api",
    role = UserRole.WAITER
)
```

## Real-Time Events

### WebSocket Message Types

**Customer → System**
```json
{
  "type": "send_drink",
  "toUserId": "user-123",
  "drinkName": "Margarita",
  "price": 11.00,
  "message": "From the handsome guy at table 7"
}
```

**System → Waiter**
```json
{
  "type": "restaurant_event",
  "event_type": "drink_ready",
  "drinkOrderId": "drink-456",
  "recipientName": "María",
  "tableName": "Table 7"
}
```

**System → Kitchen**
```json
{
  "type": "restaurant_event",
  "event_type": "new_order",
  "orderId": "order-789",
  "items": [{"name": "Margarita", "qty": 2}],
  "notes": "No salt on rim"
}
```

## API Endpoints

### Authentication

```bash
POST /api/auth/register
POST /api/auth/login
POST /api/auth/api-key
```

### Menu & Inventory

```bash
GET /api/restaurants/:id/menu
GET /api/restaurants/:id/inventory
PATCH /api/restaurants/:id/inventory/:itemId
```

### Orders

```bash
POST /api/restaurants/:id/orders
GET /api/restaurants/:id/orders
PATCH /api/restaurants/:id/orders/:orderId
```

### Drink Orders

```bash
POST /api/restaurants/:id/drinks
GET /api/restaurants/:id/waiters/:waiterId/drinks
POST /api/restaurants/:id/drinks/:drinkId/deliver
```

### Waiter Management

```bash
GET /api/restaurants/:id/waiters/:waiterId/tables
PATCH /api/restaurants/:id/tables/:tableId/status
POST /api/restaurants/:id/waiters/:waiterId/checkin
POST /api/restaurants/:id/waiters/:waiterId/checkout
```

## Database

### Connection

```bash
# Connect to PostgreSQL
PGPASSWORD=postgres psql -U postgres -h localhost -d easyflirt
```

### Common Queries

```sql
-- Active orders
SELECT * FROM orders WHERE status != 'delivered' ORDER BY created_at DESC;

-- Pending drinks
SELECT * FROM drink_orders WHERE status = 'ready' ORDER BY created_at;

-- Waiters on shift
SELECT u.username, w.checked_in_at 
FROM waiter_shifts w
JOIN users u ON w.waiter_id = u.id
WHERE w.checked_out_at IS NULL;
```

## Deployment (Production)

### 1. Get SSL Certificate

```bash
# Using Let's Encrypt with Certbot
docker run -it --rm -v /letsencrypt:/etc/letsencrypt -v /www/certbot:/var/www/certbot certbot/certbot certonly --standalone -d yourdomain.com
```

### 2. Configure SSL in Docker

```bash
cp /letsencrypt/live/yourdomain.com/fullchain.pem ./ssl/cert.pem
cp /letsencrypt/live/yourdomain.com/privkey.pem ./ssl/key.pem
chmod 600 ./ssl/*.pem
```

### 3. Update .env for Production

```bash
ENVIRONMENT=production
JWT_SECRET=$(openssl rand -base64 32)
API_KEY_SECRET=$(openssl rand -base64 32)
ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
WS_URL=wss://yourdomain.com
API_URL=https://yourdomain.com/api
API_HOST=yourdomain.com
```

### 4. Deploy

```bash
docker-compose -f docker-compose.yml up -d

# View logs
docker-compose logs -f restaurant-api
docker-compose logs -f easy-flirt-web
```

### 5. Monitor

```bash
# Container health
docker ps

# Database backups
docker exec easy-flirt-db pg_dump -U postgres easyflirt > backup_$(date +%Y%m%d).sql

# Log aggregation (ELK Stack optional)
```

## Troubleshooting

### WebSocket Connection Fails

```bash
# Check if server is running
curl http://localhost:4000/health

# Check firewall
sudo ufw allow 4000
sudo ufw allow 443
```

### Database Connection Error

```bash
# Verify credentials
docker exec easy-flirt-db psql -U postgres -c "SELECT 1;"

# Check logs
docker logs easy-flirt-db
```

### Orders Not Syncing

```bash
# Verify POS webhook is configured
# Check API logs
docker logs restaurant-api | grep "webhook\|order"

# Test webhook manually
curl -X POST http://localhost:3000/api/pos/webhook \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "order_created",
    "data": {"id": "test-123", "items": []}
  }'
```

## Scaling

### Horizontal Scaling

```yaml
# docker-compose.yml
version: '3.9'
services:
  restaurant-api:
    deploy:
      replicas: 3
    
  connect-server:
    deploy:
      replicas: 2
```

### Load Balancing

```nginx
upstream restaurant_api {
    least_conn;
    server api1:3000;
    server api2:3000;
    server api3:3000;
}
```

## Security Checklist

- [ ] Change `JWT_SECRET` and `API_KEY_SECRET` in production
- [ ] Enable HTTPS/WSS in production
- [ ] Set strong database password
- [ ] Configure firewall rules
- [ ] Enable rate limiting on API
- [ ] Regular database backups
- [ ] Monitor logs for suspicious activity
- [ ] Keep dependencies updated: `npm audit fix`

## Support

- Documentation: `/docs`
- API Docs: `/api/docs` (Swagger)
- Issues: GitHub Issues
- Email: support@easyflirt.local

---

**Version**: 2.0.0  
**Last Updated**: 2024  
**License**: MIT
