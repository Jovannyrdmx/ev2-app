-- server/init-nightclub.sql - PostgreSQL Schema for Easy Flirt Nightclub

CREATE TABLE IF NOT EXISTS nightclubs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone VARCHAR(20),
    city VARCHAR(100),
    country VARCHAR(100),
    softrestaurant11_url VARCHAR(255),
    softrestaurant11_api_key TEXT,
    capacity INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    username VARCHAR(255) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'customer', -- 'customer', 'server', 'bartender', 'manager'
    age_verified BOOLEAN DEFAULT false,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(nightclub_id, username)
);

CREATE TABLE IF NOT EXISTS drinks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100), -- 'beer', 'wine', 'shot', 'cocktail', 'premium'
    price DECIMAL(10, 2) NOT NULL,
    description TEXT,
    available BOOLEAN DEFAULT true,
    image_url TEXT,
    external_id TEXT, -- SoftRestaurant11 item ID
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    item_id VARCHAR(255),
    item_name VARCHAR(255),
    quantity INTEGER DEFAULT 0,
    unit VARCHAR(50),
    low_stock BOOLEAN DEFAULT false,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(nightclub_id, item_id)
);

CREATE TABLE IF NOT EXISTS vip_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    table_number VARCHAR(50),
    section VARCHAR(100), -- 'main_floor', 'vip_lounge', 'bar', 'balcony', 'patio'
    capacity INTEGER DEFAULT 4,
    status VARCHAR(50) DEFAULT 'available', -- 'available', 'reserved', 'occupied', 'cleaning'
    current_guests INTEGER DEFAULT 0,
    bottle_service BOOLEAN DEFAULT false,
    price_tier VARCHAR(50), -- 'standard', 'vip', 'premium'
    external_id TEXT, -- SoftRestaurant11 table ID
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(nightclub_id, external_id)
);

CREATE TABLE IF NOT EXISTS table_occupants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES vip_tables(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    arrived_at TIMESTAMP DEFAULT NOW(),
    left_at TIMESTAMP,
    UNIQUE(table_id, user_id)
);

CREATE TABLE IF NOT EXISTS drink_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    sender_id VARCHAR(255) NOT NULL,
    sender_name VARCHAR(255) NOT NULL,
    recipient_id VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(255) NOT NULL,
    table_id VARCHAR(50),
    table_name VARCHAR(100),
    drink_name VARCHAR(255) NOT NULL,
    drink_price DECIMAL(10, 2),
    message TEXT,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'
    softrestaurant11_order_id TEXT, -- Link to SoftRestaurant11
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    confirmed_at TIMESTAMP,
    ready_at TIMESTAMP,
    delivered_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS flirts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    sender_id VARCHAR(255) NOT NULL,
    sender_name VARCHAR(255) NOT NULL,
    recipient_id VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(255) NOT NULL,
    emoji VARCHAR(10),
    message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bottle_service_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES vip_tables(id) ON DELETE CASCADE,
    customer_id VARCHAR(255) NOT NULL,
    bottle_name VARCHAR(255) NOT NULL,
    bottle_price DECIMAL(10, 2),
    quantity INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    table_id UUID,
    amount DECIMAL(10, 2),
    type VARCHAR(50), -- 'drink', 'bottle_service', 'tip'
    payment_method VARCHAR(50), -- 'cash', 'card', 'app'
    softrestaurant11_transaction_id TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total_guests INTEGER DEFAULT 0,
    total_revenue DECIMAL(12, 2) DEFAULT 0,
    total_drink_orders INTEGER DEFAULT 0,
    average_spend DECIMAL(10, 2) DEFAULT 0,
    peak_hour INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(nightclub_id, date)
);

-- Indexes for performance
CREATE INDEX idx_nightclub_id ON users(nightclub_id);
CREATE INDEX idx_drinks_nightclub ON drinks(nightclub_id);
CREATE INDEX idx_tables_nightclub ON vip_tables(nightclub_id);
CREATE INDEX idx_tables_status ON vip_tables(status);
CREATE INDEX idx_drink_orders_nightclub ON drink_orders(nightclub_id);
CREATE INDEX idx_drink_orders_status ON drink_orders(status);
CREATE INDEX idx_drink_orders_created ON drink_orders(created_at);
CREATE INDEX idx_drink_orders_softrestaurant11 ON drink_orders(softrestaurant11_order_id);
CREATE INDEX idx_flirts_nightclub ON flirts(nightclub_id);
CREATE INDEX idx_bottle_service_nightclub ON bottle_service_orders(nightclub_id);
CREATE INDEX idx_bottle_service_status ON bottle_service_orders(status);
CREATE INDEX idx_transactions_nightclub ON transactions(nightclub_id);
CREATE INDEX idx_transactions_date ON transactions(created_at);
CREATE INDEX idx_analytics_nightclub ON analytics(nightclub_id, date);
