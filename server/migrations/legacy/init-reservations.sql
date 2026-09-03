-- server/init-reservations.sql - PostgreSQL Schema for Table Reservations

-- Add to existing nightclub schema

CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES vip_tables(id) ON DELETE CASCADE,
    reservation_date DATE NOT NULL,
    reservation_time TIME NOT NULL,
    guest_count INTEGER NOT NULL,
    duration_hours INTEGER DEFAULT 3,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'confirmed', 'active', 'completed', 'cancelled'
    deposit_amount DECIMAL(10, 2) NOT NULL,
    total_estimated DECIMAL(12, 2),
    special_requests TEXT,
    payment_status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'deposit_pending', 'deposit_received', 'completed'
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    cancelled_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservation_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    payment_method VARCHAR(50) NOT NULL, -- 'direct_deposit', 'zelle', 'apple_pay', 'google_pay', 'cash_app', 'paypal', 'cash'
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed', 'refunded'
    payment_reference_id TEXT,
    transaction_id TEXT,
    metadata JSONB, -- stores payment provider specific data
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method_type VARCHAR(50) NOT NULL, -- 'direct_deposit', 'zelle', 'apple_pay', 'google_pay', 'cash_app', 'paypal'
    is_primary BOOLEAN DEFAULT false,
    metadata JSONB, -- payment provider account info (tokenized)
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, method_type)
);

CREATE TABLE IF NOT EXISTS reservation_addons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    addon_type VARCHAR(50) NOT NULL, -- 'bottle_service', 'vip_upgrade', 'extra_hour', 'decorations'
    addon_name VARCHAR(255) NOT NULL,
    addon_price DECIMAL(10, 2) NOT NULL,
    quantity INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    min_party_size INTEGER DEFAULT 4,
    max_party_size INTEGER DEFAULT 20,
    min_deposit_percentage DECIMAL(5, 2) DEFAULT 30.00, -- 30% of total
    cancellation_policy_hours INTEGER DEFAULT 24, -- hours before reservation
    base_price_per_hour DECIMAL(10, 2) DEFAULT 100.00,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation_discounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    code VARCHAR(50) UNIQUE,
    description TEXT,
    discount_type VARCHAR(50), -- 'percentage', 'fixed_amount'
    discount_value DECIMAL(10, 2),
    valid_from DATE,
    valid_until DATE,
    max_uses INTEGER,
    uses_remaining INTEGER,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation_availability (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
    table_id UUID REFERENCES vip_tables(id),
    available_date DATE NOT NULL,
    available_time_start TIME NOT NULL,
    available_time_end TIME NOT NULL,
    availability_status VARCHAR(50) DEFAULT 'available', -- 'available', 'partially_available', 'unavailable'
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(table_id, available_date, available_time_start)
);

-- Indexes for performance
CREATE INDEX idx_reservations_nightclub ON reservations(nightclub_id);
CREATE INDEX idx_reservations_user ON reservations(user_id);
CREATE INDEX idx_reservations_table ON reservations(table_id);
CREATE INDEX idx_reservations_date ON reservations(reservation_date);
CREATE INDEX idx_reservations_status ON reservations(status);
CREATE INDEX idx_payments_reservation ON reservation_payments(reservation_id);
CREATE INDEX idx_payments_status ON reservation_payments(status);
CREATE INDEX idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX idx_addons_reservation ON reservation_addons(reservation_id);
CREATE INDEX idx_availability_table ON reservation_availability(table_id, available_date);
CREATE INDEX idx_discounts_active ON reservation_discounts(active, valid_from, valid_until);
