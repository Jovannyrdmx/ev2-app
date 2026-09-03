// server/reservations-api.js - Complete Table Reservation System

const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
const router = express.Router();

// ==================== PAYMENT PROCESSORS ====================

class PaymentProcessor {
    async processDirectDeposit(reservation, paymentDetails) {
        // Store bank transfer details
        return {
            status: 'pending_transfer',
            bankAccount: {
                accountHolder: paymentDetails.accountHolder,
                accountNumber: '****' + paymentDetails.accountNumber.slice(-4),
                routingNumber: '****' + paymentDetails.routingNumber.slice(-4),
                bankName: paymentDetails.bankName
            },
            reference: `EV2-${reservation.id.substring(0, 8)}-${Date.now()}`,
            instructions: 'Please transfer the deposit amount to the provided bank account within 24 hours'
        };
    }

    async processZelle(reservation, paymentDetails) {
        // Zelle integration (through Stripe)
        const zelleTransfer = await stripe.transfers.create({
            amount: Math.round(reservation.deposit_amount * 100),
            currency: 'usd',
            destination: paymentDetails.bankAccountId,
            metadata: {
                reservationId: reservation.id,
                zelleHandle: paymentDetails.zelleHandle
            }
        });

        return {
            status: 'processing',
            transactionId: zelleTransfer.id,
            zelleHandle: paymentDetails.zelleHandle,
            amount: reservation.deposit_amount,
            reference: `ZELLE-${zelleTransfer.id}`
        };
    }

    async processApplePay(reservation, paymentDetails) {
        // Apple Pay through Stripe
        const charge = await stripe.charges.create({
            amount: Math.round(reservation.deposit_amount * 100),
            currency: 'usd',
            source: paymentDetails.tokenId, // Apple Pay token from client
            metadata: {
                reservationId: reservation.id,
                paymentMethod: 'apple_pay'
            }
        });

        return {
            status: 'completed',
            transactionId: charge.id,
            last4: charge.payment_method_details.card.last4,
            brand: charge.payment_method_details.card.brand
        };
    }

    async processGooglePay(reservation, paymentDetails) {
        // Google Pay through Stripe
        const charge = await stripe.charges.create({
            amount: Math.round(reservation.deposit_amount * 100),
            currency: 'usd',
            source: paymentDetails.tokenId, // Google Pay token from client
            metadata: {
                reservationId: reservation.id,
                paymentMethod: 'google_pay'
            }
        });

        return {
            status: 'completed',
            transactionId: charge.id,
            last4: charge.payment_method_details.card.last4,
            brand: charge.payment_method_details.card.brand
        };
    }

    async processCashApp(reservation, paymentDetails) {
        // Cash App integration
        const cashAppPayment = {
            status: 'pending_confirmation',
            cashTag: paymentDetails.cashTag,
            amount: reservation.deposit_amount,
            reference: `CA-${reservation.id.substring(0, 8)}-${Date.now()}`,
            instructions: `Send $${reservation.deposit_amount} to ${paymentDetails.cashTag} with memo: ${reservation.id.substring(0, 8)}`
        };

        return cashAppPayment;
    }

    async processPayPal(reservation, paymentDetails) {
        // PayPal integration
        const paypalResponse = await axios.post(
            'https://api-m.sandbox.paypal.com/v2/checkout/orders',
            {
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: {
                        currency_code: 'USD',
                        value: reservation.deposit_amount.toString()
                    },
                    description: `Table Reservation - ${reservation.guest_count} guests`
                }],
                payer: {
                    email_address: paymentDetails.email
                }
            },
            {
                auth: {
                    username: process.env.PAYPAL_CLIENT_ID,
                    password: process.env.PAYPAL_CLIENT_SECRET
                }
            }
        );

        return {
            status: 'pending_redirect',
            orderId: paypalResponse.data.id,
            approvalUrl: paypalResponse.data.links.find(l => l.rel === 'approve').href
        };
    }

    async processCash(reservation) {
        // Cash payment - requires in-person
        return {
            status: 'pending_cash_payment',
            amount: reservation.deposit_amount,
            reference: `CASH-${reservation.id.substring(0, 8)}`,
            instructions: 'Please bring cash to the club on the day of reservation'
        };
    }
}

const paymentProcessor = new PaymentProcessor();

// ==================== RESERVATION ENDPOINTS ====================

// Get available tables for a specific date/time
router.get('/nightclubs/:nightclubId/reservations/availability', async (req, res) => {
    try {
        const { nightclubId } = req.params;
        const { date, startTime, endTime, guestCount } = req.query;

        // Get all tables
        const tables = await pool.query(
            'SELECT * FROM vip_tables WHERE nightclub_id = $1',
            [nightclubId]
        );

        // Get availability for this date/time
        const availableSlots = await pool.query(
            `SELECT DISTINCT t.id, t.table_number, t.section, t.capacity, t.price_tier
             FROM vip_tables t
             LEFT JOIN reservations r ON t.id = r.table_id 
                AND r.reservation_date = $1
                AND r.status != 'cancelled'
                AND NOT (r.reservation_time + (r.duration_hours || ' hours')::interval <= $2::time
                    OR r.reservation_time >= $3::time)
             WHERE t.nightclub_id = $4
             AND t.capacity >= $5
             AND r.id IS NULL
             ORDER BY t.capacity ASC`,
            [date, startTime, endTime, nightclubId, guestCount]
        );

        res.json(availableSlots.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get reservation rules for nightclub
router.get('/nightclubs/:nightclubId/reservations/rules', async (req, res) => {
    try {
        const { nightclubId } = req.params;

        const rules = await pool.query(
            'SELECT * FROM reservation_rules WHERE nightclub_id = $1',
            [nightclubId]
        );

        res.json(rules.rows[0] || {
            minPartySize: 4,
            maxPartySize: 20,
            minDepositPercentage: 30,
            cancellationPolicyHours: 24,
            basePricePerHour: 100
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new reservation
router.post('/nightclubs/:nightclubId/reservations', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        const {
            tableId,
            reservationDate,
            reservationTime,
            guestCount,
            durationHours,
            specialRequests,
            addons,
            discountCode
        } = req.body;

        const userId = req.user.id;

        // Get table details
        const tableResult = await pool.query(
            'SELECT * FROM vip_tables WHERE id = $1 AND nightclub_id = $2',
            [tableId, nightclubId]
        );

        if (!tableResult.rows[0]) {
            return res.status(404).json({ error: 'Table not found' });
        }

        const table = tableResult.rows[0];

        // Get pricing rules
        const rulesResult = await pool.query(
            'SELECT * FROM reservation_rules WHERE nightclub_id = $1',
            [nightclubId]
        );

        const rules = rulesResult.rows[0] || {
            base_price_per_hour: 100,
            min_deposit_percentage: 30
        };

        // Calculate total
        let totalEstimated = rules.base_price_per_hour * durationHours;

        // Add-ons
        if (addons && addons.length > 0) {
            for (const addon of addons) {
                totalEstimated += addon.price * (addon.quantity || 1);
            }
        }

        // Apply discount
        let depositAmount = totalEstimated * (rules.min_deposit_percentage / 100);

        if (discountCode) {
            const discountResult = await pool.query(
                'SELECT * FROM reservation_discounts WHERE code = $1 AND active = true AND valid_from <= NOW()::date AND valid_until >= NOW()::date AND uses_remaining > 0',
                [discountCode]
            );

            if (discountResult.rows[0]) {
                const discount = discountResult.rows[0];
                if (discount.discount_type === 'percentage') {
                    totalEstimated *= (1 - discount.discount_value / 100);
                    depositAmount = totalEstimated * (rules.min_deposit_percentage / 100);
                } else {
                    totalEstimated -= discount.discount_value;
                    depositAmount = totalEstimated * (rules.min_deposit_percentage / 100);
                }

                // Update uses
                await pool.query(
                    'UPDATE reservation_discounts SET uses_remaining = uses_remaining - 1 WHERE id = $1',
                    [discount.id]
                );
            }
        }

        // Create reservation
        const reservationResult = await pool.query(
            `INSERT INTO reservations 
             (nightclub_id, user_id, table_id, reservation_date, reservation_time, guest_count, duration_hours, special_requests, total_estimated, deposit_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [nightclubId, userId, tableId, reservationDate, reservationTime, guestCount, durationHours, specialRequests, totalEstimated, depositAmount]
        );

        const reservation = reservationResult.rows[0];

        // Add add-ons
        if (addons && addons.length > 0) {
            for (const addon of addons) {
                await pool.query(
                    'INSERT INTO reservation_addons (reservation_id, addon_type, addon_name, addon_price, quantity) VALUES ($1, $2, $3, $4, $5)',
                    [reservation.id, addon.type, addon.name, addon.price, addon.quantity || 1]
                );
            }
        }

        res.status(201).json({
            reservation,
            pricing: {
                basePrice: rules.base_price_per_hour * durationHours,
                addonsTotal: addons ? addons.reduce((sum, a) => sum + (a.price * (a.quantity || 1)), 0) : 0,
                total: totalEstimated,
                depositRequired: depositAmount,
                depositPercentage: rules.min_deposit_percentage
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get user's reservations
router.get('/nightclubs/:nightclubId/reservations/user', authenticateToken, async (req, res) => {
    try {
        const { nightclubId } = req.params;
        const userId = req.user.id;

        const reservations = await pool.query(
            `SELECT r.*, t.table_number, t.section, u.name 
             FROM reservations r
             JOIN vip_tables t ON r.table_id = t.id
             JOIN users u ON r.user_id = u.id
             WHERE r.nightclub_id = $1 AND r.user_id = $2
             ORDER BY r.reservation_date DESC`,
            [nightclubId, userId]
        );

        res.json(reservations.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get payment methods for user
router.get('/users/:userId/payment-methods', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;

        if (req.user.id !== userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const methods = await pool.query(
            'SELECT id, method_type, is_primary, created_at FROM payment_methods WHERE user_id = $1',
            [userId]
        );

        res.json(methods.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add payment method
router.post('/users/:userId/payment-methods', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { methodType, paymentDetails } = req.body;

        if (req.user.id !== userId) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Check if this is the first method (make it primary)
        const existingMethods = await pool.query(
            'SELECT COUNT(*) FROM payment_methods WHERE user_id = $1',
            [userId]
        );

        const isPrimary = parseInt(existingMethods.rows[0].count) === 0;

        const result = await pool.query(
            `INSERT INTO payment_methods (user_id, method_type, is_primary, metadata)
             VALUES ($1, $2, $3, $4)
             RETURNING id, method_type, is_primary`,
            [userId, methodType, isPrimary, JSON.stringify(paymentDetails)]
        );

        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Process reservation payment
router.post('/reservations/:reservationId/pay', authenticateToken, async (req, res) => {
    try {
        const { reservationId } = req.params;
        const { paymentMethod, paymentDetails } = req.body;

        // Get reservation
        const reservationResult = await pool.query(
            'SELECT * FROM reservations WHERE id = $1',
            [reservationId]
        );

        if (!reservationResult.rows[0]) {
            return res.status(404).json({ error: 'Reservation not found' });
        }

        const reservation = reservationResult.rows[0];

        let paymentResult;

        // Process based on payment method
        switch (paymentMethod) {
            case 'direct_deposit':
                paymentResult = await paymentProcessor.processDirectDeposit(reservation, paymentDetails);
                break;
            case 'zelle':
                paymentResult = await paymentProcessor.processZelle(reservation, paymentDetails);
                break;
            case 'apple_pay':
                paymentResult = await paymentProcessor.processApplePay(reservation, paymentDetails);
                break;
            case 'google_pay':
                paymentResult = await paymentProcessor.processGooglePay(reservation, paymentDetails);
                break;
            case 'cash_app':
                paymentResult = await paymentProcessor.processCashApp(reservation, paymentDetails);
                break;
            case 'paypal':
                paymentResult = await paymentProcessor.processPayPal(reservation, paymentDetails);
                break;
            case 'cash':
                paymentResult = await paymentProcessor.processCash(reservation);
                break;
            default:
                return res.status(400).json({ error: 'Invalid payment method' });
        }

        // Store payment record
        const paymentStatus = paymentResult.status === 'completed' ? 'completed' : 'pending';

        const paymentRecord = await pool.query(
            `INSERT INTO reservation_payments 
             (reservation_id, payment_method, amount, status, transaction_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [reservationId, paymentMethod, reservation.deposit_amount, paymentStatus, paymentResult.transactionId, JSON.stringify(paymentResult)]
        );

        // Update reservation payment status
        await pool.query(
            'UPDATE reservations SET payment_status = $1 WHERE id = $2',
            [paymentStatus === 'completed' ? 'deposit_received' : 'deposit_pending', reservationId]
        );

        res.json({
            payment: paymentRecord.rows[0],
            paymentDetails: paymentResult
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cancel reservation
router.post('/reservations/:reservationId/cancel', authenticateToken, async (req, res) => {
    try {
        const { reservationId } = req.params;
        const { reason } = req.body;

        const result = await pool.query(
            `UPDATE reservations 
             SET status = 'cancelled', cancelled_at = NOW()
             WHERE id = $1 AND user_id = $2
             RETURNING *`,
            [reservationId, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Reservation not found or unauthorized' });
        }

        const reservation = result.rows[0];

        // Process refund if applicable
        if (reservation.payment_status === 'deposit_received') {
            // Calculate refund based on cancellation policy
            const rulesResult = await pool.query(
                'SELECT cancellation_policy_hours FROM reservation_rules WHERE nightclub_id = $1',
                [reservation.nightclub_id]
            );

            const rules = rulesResult.rows[0];
            const hoursUntilReservation = (new Date(reservation.reservation_date) - new Date()) / (1000 * 60 * 60);

            let refundPercentage = 0;
            if (hoursUntilReservation > rules.cancellation_policy_hours) {
                refundPercentage = 100; // Full refund
            } else if (hoursUntilReservation > 0) {
                refundPercentage = 50; // 50% refund
            }
            // else: no refund

            if (refundPercentage > 0) {
                const refundAmount = (reservation.deposit_amount * refundPercentage) / 100;
                
                await pool.query(
                    `INSERT INTO reservation_payments 
                     (reservation_id, payment_method, amount, status, metadata)
                     VALUES ($1, 'refund', $2, 'completed', $3)`,
                    [reservationId, refundAmount, JSON.stringify({ refundPercentage, reason })]
                );
            }
        }

        // Broadcast cancellation via WebSocket
        broadcastToNightclub(reservation.nightclub_id, {
            type: 'reservation_event',
            event_type: 'reservation_cancelled',
            data: reservation
        });

        res.json({ reservation, cancelled: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
