# 🎯 COMPLETE TESTING & RUNNING INSTRUCTIONS FOR EV2 CLANDESTINOZ

## 🚀 QUICKEST START (5 MINUTES)

### **Option 1: Test Web App Immediately (No Docker)**

**Step 1: Open Web App in Browser**
```
1. Open your web browser (Chrome, Firefox, Safari, Edge)
2. Go to: file:///path/to/index-ev2-branded.html
   
   OR if you cloned the project:
   Right-click → Open with → Your Browser
```

**Step 2: You'll See:**
- ✅ EV2 Clandestinoz loading screen
- ✅ Login page with Instagram & Email options
- ✅ Click "Enter the Club" button
- ✅ Main app interface with navigation

**Step 3: Navigate the Web App**
```
Bottom Navigation Bar:
- 🏠 Home: Main screen
- 🎫 Tables: View available tables
- 🎫 Reserve: Make reservations (NEW)
- 🍹 Drinks: Order drinks
- 📦 Orders: View your orders
- 👤 Profile: User settings
```

---

### **Option 2: Test Pricing & Dance Floor (5 Minutes)**

**Step 1: Open Pricing Dashboard**
```
1. Open: pricing-dance-floor-flirt.html
2. In your browser
```

**Step 2: View Pricing Tab**
```
Click Tab: 💰 Pricing
You'll see:
- ZONA ROJA: $5,000 (8 people)
- ZONA AZUL: $4,500 (10 people)
- CELEBRATION SUITE: $8,000
- Dance Floor Small: $2,500
- Dance Floor VIP: $6,000
- All extras and bottles listed
```

**Step 3: Test Dance Floor**
```
Click Tab: 🎉 Dance Floor
- Click "➕ Mesa Pequeña" to add small table
- Click "➕ Mesa Grande" to add large table
- Tables appear on the canvas
- Click table to select
- Click "❌ Remover Mesa" to delete
- Click "📤 Exportar POS" to export data
- Watch stats update in real-time
```

**Step 4: Test Flirt System**
```
Click Tab: 💕 Flirt System
Left Panel:
- Click any emoji/icon to "send flirt"
- 👋 Wave, 😉 Wink, 😘 Kiss, 🔥 Fire, etc.

Right Panel:
- See incoming flirts in feed
- Click reactions: ❤️ Like, 💕 Love, 😂 Haha, etc.
```

---

### **Option 3: Test Table Selector (5 Minutes)**

**Step 1: Open Table Selector**
```
1. Open: table-selector.html
2. In your browser
```

**Step 2: See Interactive Floor Plan**
```
You'll see:
- Floor buttons: "PLANTA BAJA" | "PLANTA ALTA"
- Stats showing: 53 total tables, 53 available, 7 VIP
- Legend showing color zones
- Interactive canvas with all 53 tables
```

**Step 3: Select Tables**
```
Actions:
1. Click "PLANTA BAJA" button
2. Click on any table number on the map
3. Selected table highlights in yellow
4. Details appear below:
   - Table # (e.g., 39)
   - Section (ZONA ROJA)
   - Capacity (6 guests)
   - Type (booth)
5. Click "RESERVE TABLE" to book
```

**Step 4: Switch Floors**
```
1. Click "PLANTA ALTA" button
2. Different tables appear
3. Same selection process
```

---

## 🐳 FULL SYSTEM WITH DOCKER (15 MINUTES)

### **Prerequisites**
```
✅ Docker Desktop installed
✅ Docker Compose installed
✅ Port 8080, 3000, 4000 available
```

### **Step 1: Configure Environment**

```bash
# Navigate to project folder
cd /path/to/easyflirt-nightclub

# Copy template
cp .env.example .env

# Edit .env file with your details
nano .env

# Important fields to fill:
SOFTRESTAURANT11_URL=http://localhost:8888
SOFTRESTAURANT11_API_KEY=your-api-key
JWT_SECRET=your-32-char-secret-key
DB_PASSWORD=your-secure-password
ENVIRONMENT=development
```

### **Step 2: Start All Services**

```bash
# Start everything
docker-compose up -d --build

# Watch it build (takes 2-3 minutes first time)
docker-compose logs -f

# You'll see:
# - PostgreSQL starting ✅
# - Redis starting ✅
# - API building and starting ✅
# - WebSocket starting ✅
# - Web frontend starting ✅
```

### **Step 3: Wait for Health Checks**

```bash
# Check service status
docker-compose ps

# You should see:
SERVICE                    STATUS
easy-flirt-nightclub-db    Up (healthy)
easy-flirt-nightclub-cache Up (healthy)
easy-flirt-nightclub-api   Up (healthy)
easy-flirt-nightclub-web   Up (healthy)
```

### **Step 4: Verify Services Are Running**

```bash
# Test API health
curl http://localhost:3000/health

# Should return:
# {"status":"ok","uptime":"1.234s"}

# Test WebSocket
curl http://localhost:4000/health

# Test Database connection
docker-compose exec postgres psql -U postgres -d easyflirt_nightclub -c "SELECT COUNT(*) FROM users;"

# Test Redis
docker-compose exec redis redis-cli ping
# Should return: PONG
```

### **Step 5: Access All Apps**

```
🌐 WEB APP
   URL: http://localhost:8080
   What to do:
   - See EV2 loading screen
   - Click "Enter the Club"
   - Select tables
   - Make reservations
   - Send flirts

📡 REST API
   URL: http://localhost:3000
   Test endpoint: http://localhost:3000/health
   
🔌 WEBSOCKET
   URL: ws://localhost:4000
   Handles real-time updates

🗄️ DATABASE
   Host: localhost:5432
   User: postgres
   Database: easyflirt_nightclub
   
⚡ CACHE
   Host: localhost:6379
```

---

## 🧪 TESTING EACH FEATURE

### **Test 1: User Login**

```
In Browser (http://localhost:8080):
1. See loading screen with EV2 logo
2. Click anywhere or wait 3 seconds
3. See login page
4. Click "Continue with Instagram" (demo)
5. Or enter email + name
6. Click "Enter the Club"
7. ✅ You should see main app interface
```

### **Test 2: Table Selection**

```
1. Click "🎫 Tables" in navigation
2. See available tables listed
3. Click on any table
4. See table details in card format
5. ✅ Table highlights and shows info
```

### **Test 3: Reservation System**

```
1. Click "🎫 Reserve" in navigation
2. See:
   - Floor selector (Planta Baja / Planta Alta)
   - Available tables displayed
   - Table details when clicked
3. Fill in:
   - Date (calendar picker)
   - Time (time picker)
   - Guests (2-20 slider)
   - Duration (1-6 hours)
4. See pricing calculate in real-time
5. Click "Reserve Table"
6. See success message
7. ✅ Reservation created
```

### **Test 4: Payment Methods**

```
In Reservation page:
1. Select table
2. Scroll to Payment Method section
3. See options:
   - 💳 Direct Deposit
   - 🏦 Zelle
   - 🍎 Apple Pay
   - 🔵 Google Pay
   - 💵 Cash App
   - 🅿️ PayPal
4. Click each to see details
5. ✅ All payment methods selectable
```

### **Test 5: Drink Ordering**

```
1. Click "🍹 Drinks" in navigation
2. See:
   - Drink categories
   - Drink menu items
   - Prices
3. Click on drink
4. See drink details
5. Click "Add to Order"
6. See order summary
7. Click "Send to Bar"
8. ✅ Order placed
```

### **Test 6: Flirt System**

```
1. Click "💕 Flirt" in navigation
2. Left Panel - Send Flirt:
   - Click any emoji button (👋😉😘🔥❤️💃🍹🍾⭐📸)
   - Flirt sends immediately
   - See confirmation
3. Right Panel - Flirt Feed:
   - See incoming flirts
   - Click reaction buttons
   - See reaction count update
   - Reactions: ❤️💕😂😮😢😠🔥👀😘👋
4. ✅ Flirt system working
```

### **Test 7: Analytics Dashboard**

```
1. Click "📊 Analytics" (if available)
2. See:
   - Total orders
   - Revenue today
   - Active customers
   - Popular drinks
   - Peak hours chart
3. Refresh page
4. ✅ Real-time data updates
```

---

## 📱 TESTING iOS APP

### **Step 1: Open in Xcode (Mac Only)**

```
1. Open Xcode
2. File → Open → Select EV2BrandedApp.swift
3. Select simulator or physical device
4. Click Play button to build & run
5. Wait 1-2 minutes for build
6. App launches in simulator
```

### **Step 2: Test iOS App**

```
On iOS Simulator:
1. See EV2 loading screen
2. See login with Instagram / Email
3. Tap "Enter the Club"
4. See table list
5. Tap table → See details
6. Test all features same as web app
7. ✅ Test Apple Pay in payment screen
```

### **Step 3: Test WebSocket on iOS**

```
1. Open app
2. Make reservation
3. On web app simultaneously, open another browser tab
4. See real-time updates sync
5. WebSocket connection working ✅
```

---

## 🤖 TESTING ANDROID APP

### **Step 1: Open in Android Studio**

```
1. Open Android Studio
2. File → Open → Select ReservationSystem.kt
3. Select emulator or physical device
4. Click Run (play button)
5. Wait 2-3 minutes for build
6. App launches
```

### **Step 2: Test Android App**

```
On Android Emulator:
1. See EV2 loading screen
2. See login options
3. Tap "Enter the Club"
4. See all features available
5. ✅ Test Google Pay in payments
```

---

## 🎯 COMPLETE TESTING CHECKLIST

### **Web App Testing** ✅
- [ ] Opens in browser
- [ ] Login works
- [ ] Tables display
- [ ] Can select table
- [ ] Pricing calculates
- [ ] Can make reservation
- [ ] All 6 payment methods show
- [ ] Can send flirts
- [ ] Reactions work
- [ ] Real-time updates visible

### **Dance Floor Testing** ✅
- [ ] Open pricing-dance-floor-flirt.html
- [ ] Add small table
- [ ] Add large table
- [ ] Add VIP table
- [ ] Drag tables to move
- [ ] Remove table
- [ ] Stats update
- [ ] Export to POS

### **Table Selector Testing** ✅
- [ ] Floor plan loads
- [ ] Both floors selectable
- [ ] All 53 tables visible
- [ ] Can click tables
- [ ] Selected table highlights
- [ ] Details display correctly
- [ ] Table count accurate

### **API Testing** ✅
- [ ] Health check responds
- [ ] Can get tables
- [ ] Can create reservation
- [ ] Can process payment
- [ ] Can send flirt
- [ ] Real-time updates work

### **Database Testing** ✅
- [ ] Can connect to PostgreSQL
- [ ] Can query tables
- [ ] Can insert reservations
- [ ] Can read user data
- [ ] Transactions work

### **WebSocket Testing** ✅
- [ ] Connection established
- [ ] Real-time messages send
- [ ] Notifications received
- [ ] Multi-client sync works

---

## 🔧 TROUBLESHOOTING

### **Web App Won't Load**

```
Problem: Blank page or error
Solution:
1. Open browser console (F12)
2. Check for errors
3. Make sure file path is correct
4. Try different browser
5. Clear cache (Ctrl+Shift+Delete)
```

### **Docker Won't Start**

```
Problem: docker-compose up fails
Solution:
1. Check Docker Desktop is running
2. Check ports are available:
   - lsof -i :8080  (Mac/Linux)
   - netstat -ano | findstr :8080  (Windows)
3. Kill process using port:
   - kill -9 <PID>  (Mac/Linux)
   - taskkill /PID <PID> /F  (Windows)
4. Rebuild: docker-compose up -d --build
```

### **Services Not Healthy**

```
Problem: docker-compose ps shows "unhealthy"
Solution:
1. Check logs: docker-compose logs -f service-name
2. Wait 30 seconds, service might be starting
3. Check .env file is configured
4. Rebuild: docker-compose down && docker-compose up -d
```

### **Can't Access localhost:8080**

```
Problem: Connection refused
Solution:
1. Verify Docker is running: docker ps
2. Check port mapping: docker-compose ps
3. Restart: docker-compose restart easy-flirt-web
4. Check logs: docker-compose logs easy-flirt-web
```

### **Tables Not Showing**

```
Problem: Table selector empty
Solution:
1. Check database is running
2. Verify tables.js is loaded
3. Check browser console for errors
4. Refresh page
5. Clear browser cache
```

---

## 📊 VERIFICATION COMMANDS

### **Check Everything is Working**

```bash
# All services running
docker-compose ps

# Check API responds
curl http://localhost:3000/health

# Check WebSocket responds
curl http://localhost:4000/health

# Check database connection
docker-compose exec postgres psql -U postgres -d easyflirt_nightclub -c "SELECT * FROM users LIMIT 1;"

# Check Redis
docker-compose exec redis redis-cli ping

# View logs
docker-compose logs -f

# Check resource usage
docker stats
```

---

## 🎮 DEMO WORKFLOWS

### **Workflow 1: Make a Reservation (5 min)**

```
1. Open http://localhost:8080
2. Click "Enter the Club"
3. Click "🎫 Reserve"
4. Select floor (Planta Baja)
5. Click table #39 (ZONA ROJA)
6. Select date (tomorrow)
7. Select time (22:00)
8. Select guests (6)
9. Select duration (3 hours)
10. See price: $5,000
11. Select payment method (Direct Deposit)
12. Click "Reserve Table"
13. ✅ Reservation confirmed
```

### **Workflow 2: Order a Drink (3 min)**

```
1. Open http://localhost:8080
2. Click "🍹 Drinks"
3. Browse drink menu
4. Click "Mojito"
5. Select quantity (2)
6. Add special request
7. Click "Send to Bar"
8. ✅ Order placed, wait for preparation
```

### **Workflow 3: Send a Flirt (2 min)**

```
1. Open pricing-dance-floor-flirt.html
2. Click "💕 Flirt System" tab
3. Left panel - Click "😘 Kiss" button
4. See confirmation
5. Right panel - See flirt in feed
6. Click reaction "❤️ Like"
7. ✅ Flirt sent and reacted to
```

### **Workflow 4: Manage Dance Floor (3 min)**

```
1. Open pricing-dance-floor-flirt.html
2. Click "🎉 Dance Floor" tab
3. Click "➕ Mesa Grande (8)"
4. Table appears on canvas
5. Click "➕ Mesa VIP (10)"
6. Another table appears
7. Click on first table
8. Click "❌ Remover Mesa"
9. Table disappears
10. See stats update
11. ✅ Dance floor managed
```

---

## ✅ SUCCESS CHECKLIST

After testing everything, you should have:

- [x] Web app loading correctly
- [x] All navigation working
- [x] Tables displaying
- [x] Pricing calculating
- [x] Reservations creating
- [x] Payment methods visible
- [x] Flirt system operational
- [x] Dance floor manager working
- [x] Real-time updates syncing
- [x] Database responding
- [x] API endpoints working
- [x] WebSocket connecting
- [x] All 6 payment options ready
- [x] iOS app buildable
- [x] Android app buildable

---

## 🎉 YOU'RE READY TO LAUNCH!

If all tests pass, your EV2 Clandestinoz app is ready for:

✅ Beta testing with staff
✅ Testing with customers
✅ Performance optimization
✅ Production deployment
✅ Going live! 🚀

---

**Questions?**

Refer back to:
- SYSTEM_INDEX.html - Overview
- README_START_HERE.md - Setup
- COMPLETE_SYSTEM_SUMMARY.md - Details

Happy testing! 🎊
