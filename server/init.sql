-- server/init.sql - PostgreSQL Schema

CREATE TABLE IF NOT EXISTS restaurants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone VARCHAR(20),
    pos_system VARCHAR(50), -- 'square', 'toast', 'touchbistro', etc.
    pos_api_key TEXT,
    pos_location_id TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    username VARCHAR(255) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'waiter', -- 'waiter', 'bartender', 'kitchen', 'manager', 'customer'
    assigned_tables TEXT[], -- array of table IDs
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    key TEXT UNIQUE NOT NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    price DECIMAL(10, 2),
    description TEXT,
    available BOOLEAN DEFAULT true,
    image_url TEXT,
    external_id TEXT, -- for POS sync
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    item_id UUID NOT NULL REFERENCES menu_items(id),
    quantity INTEGER DEFAULT 0,
    unit VARCHAR(50),
    low_stock_threshold INTEGER DEFAULT 5,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(restaurant_id, item_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    table_id VARCHAR(50),
    customer_id UUID,
    items JSONB NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'
    total DECIMAL(10, 2),
    notes TEXT,
    external_id TEXT, -- for POS sync
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drink_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    sender_id VARCHAR(255) NOT NULL,
    sender_name VARCHAR(255) NOT NULL,
    recipient_id VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(255) NOT NULL,
    table_id VARCHAR(50),
    table_name VARCHAR(100),
    drink JSONB NOT NULL,
    message TEXT,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS table_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    waiter_id UUID NOT NULL REFERENCES users(id),
    table_id VARCHAR(50) NOT NULL,
    table_name VARCHAR(100),
    status VARCHAR(50) DEFAULT 'assigned', -- 'assigned', 'occupied', 'cleaning', 'available'
    assigned_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waiter_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    waiter_id UUID NOT NULL REFERENCES users(id),
    checked_in_at TIMESTAMP DEFAULT NOW(),
    checked_out_at TIMESTAMP,
    UNIQUE(restaurant_id, waiter_id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    waiter_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(50), -- 'order_ready', 'new_order', 'drink_ready', etc.
    title VARCHAR(255),
    message TEXT,
    related_order_id UUID REFERENCES orders(id),
    priority VARCHAR(20) DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_restaurants_id ON restaurants(id);
CREATE INDEX idx_users_restaurant ON users(restaurant_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_table ON orders(table_id);
CREATE INDEX idx_drinks_restaurant ON drink_orders(restaurant_id);
CREATE INDEX idx_drinks_recipient ON drink_orders(recipient_id);
CREATE INDEX idx_drinks_status ON drink_orders(status);
CREATE INDEX idx_table_assignments_waiter ON table_assignments(waiter_id);
CREATE INDEX idx_notifications_waiter ON notifications(waiter_id, read);
CREATE INDEX idx_inventory_restaurant ON inventory(restaurant_id);
