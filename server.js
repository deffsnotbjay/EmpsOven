require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
// const xssClean = require("xss-clean"); // Commented out due to Node.js compatibility issues
const hpp = require("hpp");
const NodeCache = require("node-cache");
const fetch = require("node-fetch");

const app = express();

// ============ SECURITY MIDDLEWARE ============

// Helmet — secure HTTP headers (XSS protection, clickjack prevention, MIME sniffing, etc.)
app.use(helmet({
    contentSecurityPolicy: false, // Disabled so inline scripts in HTML pages still work
    crossOriginEmbedderPolicy: false
}));

// CORS — restrict to own origin in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:5000', 'http://localhost:3000'];
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        return callback(null, true); // Permissive for now; tighten in production
    },
    credentials: true
}));

// Body parsing with reduced limit (was 50mb, now 10mb to limit abuse)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// XSS Clean — sanitize all user input in req.body, req.query, req.params
// app.use(xssClean()); // Commented out due to Node.js compatibility issues

// HPP — prevent HTTP parameter pollution
app.use(hpp());

// ============ RATE LIMITING ============

// Global rate limiter — 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please try again later.' }
});
app.use('/api/', globalLimiter);

// Strict auth rate limiter — 5 attempts per 15 minutes (brute-force protection)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many login attempts. Please try again after 15 minutes.' }
});

// ============ RESPONSE CACHING ============

const responseCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

function cacheMiddleware(key, ttlSeconds) {
    return (req, res, next) => {
        const cached = responseCache.get(key);
        if (cached) {
            return res.json(cached);
        }
        // Override res.json to cache the response
        const originalJson = res.json.bind(res);
        res.json = (data) => {
            responseCache.set(key, data, ttlSeconds);
            return originalJson(data);
        };
        next();
    };
}

function invalidateCache(key) {
    responseCache.del(key);
}

// Static files
app.use(express.static("Public"));

// 🔴 BACKEND USES SECRET KEY
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);

// Admin Credentials & JWT Secret (fallback to defaults if missing in .env)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const JWT_SECRET = process.env.JWT_SECRET || "pastry-super-secret-key-123";

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];

    if (!token) {
        return res.status(403).json({ message: "No token provided, unauthorized." });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid or expired token." });
    }
};

/* ADMIN AUTHENTICATION */
app.get("/api/config", cacheMiddleware('config', 300), (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SECRET_KEY,
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        onesignalAppId: process.env.ONESIGNAL_APP_ID || ''
    });
});

app.post("/api/admin/login", authLimiter, (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Create token valid for 24 hours
        const token = jwt.sign({ username, role: "admin" }, JWT_SECRET, { expiresIn: "24h" });
        return res.json({ token, message: "Login successful!" });
    }

    return res.status(401).json({ message: "Invalid username or password" });
});

app.get("/api/admin/verify", verifyToken, (req, res) => {
    // If it reaches here, token is valid
    res.json({ valid: true, user: req.user });
});

/* VERIFY RIDER TOKEN */
app.get("/api/rider/verify", verifyToken, (req, res) => {
    // Check if user is a rider
    if (req.user.role !== 'rider') {
        return res.status(403).json({ valid: false, message: "Not a rider" });
    }
    res.json({ valid: true, user: req.user });
});

/* GET PRODUCTS */
app.get("/products", cacheMiddleware('products', 60), async (req, res) => {
    const { data, error } = await supabase
        .from("products")
        .select("*");

    if (error) return res.status(400).json(error);
    res.json(data);
});

/* ADD PRODUCT (ADMIN) */
app.post("/add-product", verifyToken, async (req, res) => {
    const { name, price, category, image, description } = req.body;
    let available = req.body.available;
    if (available === undefined) available = true; // Default to true if not provided

    console.log('Adding product:', name, 'Image size:', image ? image.length : 0);

    const { data, error } = await supabase
        .from("products")
        .insert([{ name, price, category, image, description, available }])
        .select();

    if (error) {
        console.error('Supabase error:', error);
        return res.status(400).json(error);
    }
    invalidateCache('products');
    res.json(data);
});

/* UPDATE PRODUCT (ADMIN) */
app.put("/update-product/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, price, category, image, description, available } = req.body;

    const { data, error } = await supabase
        .from("products")
        .update({ name, price, category, image, description, available })
        .eq("id", id)
        .select();

    if (error) return res.status(400).json(error);
    invalidateCache('products');
    res.json(data);
});

/* DELETE PRODUCT (ADMIN) */
app.delete("/delete-product/:id", verifyToken, async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from("products")
        .delete()
        .eq("id", id)
        .select();

    if (error) return res.status(400).json(error);
    invalidateCache('products');
    res.json(data);
});

/* TOGGLE PRODUCT STOCK (ADMIN) */
app.patch("/api/admin/products/:id/stock", verifyToken, async (req, res) => {
    const { id } = req.params;
    const { available } = req.body;

    const { data, error } = await supabase
        .from("products")
        .update({ available })
        .eq("id", id)
        .select();

    if (error) return res.status(400).json(error);
    invalidateCache('products');
    res.json(data);
});

/* LIVE SUPABASE ORDERS API */
app.get("/api/admin/orders", verifyToken, async (req, res) => {
    try {
        // Fetch orders with payment information
        const { data: ordersData, error: ordersError } = await supabase
            .from('orders')
            .select(`
                *,
                payments(payment_status, refunded)
            `)
            .order('created_at', { ascending: false });

        if (ordersError) {
            console.error("Supabase error fetching orders:", ordersError);
            return res.status(500).json(ordersError);
        }

        const mappedOrders = ordersData.map(o => {
            let items = [];
            try {
                items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
            } catch (e) { }
            const orderName = items.map(i => `${i.quantity}x ${i.name}`).join(', ');

            let status = 'Pending';
            let isRefunded = false;
            if (o.order_status === 'pending') status = 'Pending';
            else if (o.order_status === 'cancelled') status = 'Cancel';
            else if (o.order_status === 'refunded') {
                status = 'Cancel'; // Refunded orders show as Cancelled
                isRefunded = true;
            }
            else if (o.order_status === 'reassign') status = 'Re-assign';
            else if (o.order_status === 'assigned') status = 'Assigned';
            else if (o.order_status === 'on_delivery' || o.order_status === 'dispatched' || o.order_status === 'on_the_way' || o.order_status === 'rider_accepted') status = 'On the Way';
            else if (o.order_status === 'delivered') status = 'Delivered';
            else if (o.order_status === 'completed') status = 'Completed';
            else status = 'Received';

            const date = new Date(o.created_at);
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const dateTimeStr = `${dateStr} - ${timeStr}`;

            // Get payment info from joined data
            const payment = o.payments && o.payments.length > 0 ? o.payments[0] : null;

            return {
                id: o.id,
                orderName: orderName || "Unknown Order",
                customerName: o.customer_name || "Guest",
                customerPhone: o.customer_phone || "No Phone",
                status: status,
                deliveryTime: dateTimeStr,
                createdAt: o.created_at,
                price: parseFloat(o.total) || 0,
                declineReason: null,
                verificationCode: o.verification_code || null,
                deliveryAddress: o.delivery_address || 'No Address Provided',
                paymentStatus: payment ? payment.payment_status : o.payment_status,
                refunded: payment ? payment.refunded : isRefunded,
                isRefunded: isRefunded
            };
        });

        res.json(mappedOrders);
    } catch (err) {
        console.error("Internal Server Error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

app.patch("/api/admin/orders/:id/status", verifyToken, async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    let sbStatus = 'pending';
    let updateData = { order_status: null }; // will set below

    if (status === 'Received') {
        updateData.order_status = 'accepted';
        updateData.verification_code = Math.floor(1000 + Math.random() * 9000).toString();
    }
    else if (status === 'Cancel') {
        updateData.order_status = 'cancelled';

        // Auto-refund if payment was successful
        try {
            const { data: payment, error: paymentError } = await supabase
                .from('payments')
                .select('*')
                .eq('order_id', id)
                .single();

            if (payment && payment.payment_status === 'succeeded' && !payment.refunded) {
                // Process refund
                if (payment.payment_method === 'card' && payment.payment_intent_id) {
                    try {
                        const refund = await stripe.refunds.create({
                            payment_intent: payment.payment_intent_id,
                            reason: 'requested_by_customer',
                            metadata: {
                                order_id: id.toString(),
                                refund_reason: reason || 'Order declined by admin',
                                refunded_by: req.user.username || 'admin'
                            }
                        });

                        // Record refund
                        await supabase.from('refunds').insert([{
                            payment_id: payment.id,
                            order_id: id,
                            amount: payment.amount,
                            currency: payment.currency,
                            reason: reason || 'Order declined by admin',
                            status: refund.status,
                            stripe_refund_id: refund.id,
                            refunded_by: req.user.username || 'admin'
                        }]);

                        // Update payment record
                        await supabase.from('payments').update({
                            refunded: true,
                            refund_amount: payment.amount,
                            refund_reason: reason || 'Order declined by admin',
                            refund_status: refund.status,
                            refund_id: refund.id,
                            refunded_at: new Date().toISOString(),
                            refunded_by: req.user.username || 'admin'
                        }).eq('id', payment.id);

                        // Update order to refunded status
                        updateData.order_status = 'refunded';
                    } catch (refundError) {
                        console.error('Auto-refund error:', refundError);
                        // Continue with cancellation even if refund fails
                    }
                }
            }
        } catch (e) {
            console.error('Error checking payment for refund:', e);
        }
    }
    else if (status === 'Dispatched' || status === 'On the Way') {
        updateData.order_status = 'on_the_way';
    } else {
        updateData.order_status = 'pending';
    }

    try {
        const { data, error } = await supabase
            .from('orders')
            .update(updateData)
            .eq('id', id)
            .select();

        if (error) {
            console.error("Supabase error updating status:", error);
            return res.status(500).json(error);
        }

        const returnedCode = data && data[0] && data[0].verification_code ? data[0].verification_code : updateData.verification_code;

        // AUTO-ASSIGN: If order was just accepted, find a rider automatically
        if (status === 'Received' && data && data[0]) {
            findAndAssignRider(data[0].id).catch(err => console.error('Auto-assign failed:', err));
        }

        res.json({ id: id, status: status, declineReason: reason, verificationCode: returnedCode });
    } catch (err) {
        console.error("Server error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

/* CHECKOUT ORDER PLACEMENT */
app.post("/api/checkout", async (req, res) => {
    try {
        const orderData = req.body;

        // Use the backend Service Role key (which bypasses RLS policies) to insert the order
        const { data, error } = await supabase
            .from('orders')
            .insert([orderData])
            .select();

        if (error) {
            console.error("Supabase error during checkout:", error);
            return res.status(500).json({ error: error.message || "Failed to place order" });
        }

        res.json({ success: true, order: data[0] });
    } catch (err) {
        console.error("Checkout internal error:", err);
        res.status(500).json({ error: "Internal checkout error" });
    }
});

/* STRIPE PAYMENT INTENT CREATION */
app.post("/api/create-payment-intent", async (req, res) => {
    try {
        const { amount, customerName, customerEmail } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        // Create a PaymentIntent with the order amount and currency
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Stripe expects amount in cents
            currency: "usd",
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                customer_name: customerName || 'Guest',
                customer_email: customerEmail || 'guest@example.com'
            }
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
        });
    } catch (err) {
        console.error("Payment intent creation error:", err);
        res.status(500).json({ error: err.message || "Failed to create payment intent" });
    }
});

/* RECORD PAYMENT IN DATABASE */
app.post("/api/payments", async (req, res) => {
    try {
        const {
            order_id,
            customer_name,
            amount,
            payment_method,
            payment_status,
            payment_intent_id,
            stripe_customer_id,
            receipt_url,
            failure_reason,
            payment_method_details
        } = req.body;

        const paymentData = {
            order_id,
            customer_name,
            amount,
            currency: 'usd',
            payment_method,
            payment_status,
            payment_intent_id: payment_intent_id || null,
            stripe_customer_id: stripe_customer_id || null,
            receipt_url: receipt_url || null,
            failure_reason: failure_reason || null,
            payment_method_details: payment_method_details || {},
            metadata: {}
        };

        const { data, error } = await supabase
            .from('payments')
            .insert([paymentData])
            .select();

        if (error) {
            console.error("Payment recording error:", error);
            return res.status(500).json({ error: error.message || "Failed to record payment" });
        }

        res.json({ success: true, payment: data[0] });
    } catch (err) {
        console.error("Payment recording error:", err);
        res.status(500).json({ error: "Failed to record payment" });
    }
});

/* GET ALL PAYMENTS (ADMIN) */
app.get("/api/admin/payments", verifyToken, async (req, res) => {
    try {
        const { status, search } = req.query;

        let query = supabase
            .from('payments')
            .select(`
                *,
                orders!inner(
                    id,
                    customer_name,
                    customer_phone,
                    items,
                    order_status,
                    created_at
                )
            `)
            .order('created_at', { ascending: false });

        // Filter by payment status
        if (status && status !== 'all') {
            query = query.eq('payment_status', status);
        }

        // Search by customer name or order ID
        if (search) {
            query = query.or(`customer_name.ilike.%${search}%,order_id.eq.${parseInt(search) || 0}`);
        }

        const { data, error } = await query;

        if (error) {
            console.error("Fetch payments error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Payments retrieval error:", err);
        res.status(500).json({ error: "Failed to fetch payments" });
    }
});

/* GET PAYMENT BY ORDER ID */
app.get("/api/payments/order/:orderId", async (req, res) => {
    try {
        const { orderId } = req.params;

        const { data, error } = await supabase
            .from('payments')
            .select('*')
            .eq('order_id', orderId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: "Payment not found" });
            }
            console.error("Fetch payment error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Payment retrieval error:", err);
        res.status(500).json({ error: "Failed to fetch payment" });
    }
});

/* ==================== REFUND MANAGEMENT ==================== */

// Helper function to send refund notification email
async function sendRefundNotification(customerEmail, customerName, orderId, refundAmount, refundReason) {
    const notificationData = {
        to: customerEmail,
        subject: `Refund Processed for Order #${orderId}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
                <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h2 style="color: #4CAF50; margin-top: 0;">✅ Refund Processed</h2>
                    <p style="font-size: 16px; color: #333;">Hi ${customerName},</p>
                    <p style="font-size: 16px; color: #333;">
                        Your refund has been processed successfully for order <strong>#${orderId}</strong>.
                    </p>
                    <div style="background-color: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 5px 0; font-size: 16px;"><strong>Refund Amount:</strong> $${refundAmount.toFixed(2)}</p>
                        <p style="margin: 5px 0; font-size: 16px;"><strong>Reason:</strong> ${refundReason}</p>
                    </div>
                    <p style="font-size: 14px; color: #666;">
                        The refund will appear in your account within 5-10 business days, depending on your payment provider.
                    </p>
                    <p style="font-size: 14px; color: #666;">
                        If you have any questions, please don't hesitate to contact us.
                    </p>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                    <p style="font-size: 12px; color: #999; text-align: center;">
                        Thank you for your business!<br>
                        Pastry Business Team
                    </p>
                </div>
            </div>
        `
    };

    // Log the notification (in production, you would integrate with an email service like SendGrid, AWS SES, etc.)
    console.log('📧 Refund notification:', notificationData);

    // TODO: Integrate with email service provider
    // For now, we'll return success. In production:
    // return await sendGridClient.send(notificationData);
    // or: return await sesClient.sendEmail(notificationData);

    return { success: true, message: 'Notification logged (email service not configured)' };
}

/* PROCESS REFUND (ADMIN) */
app.post("/api/admin/refund", verifyToken, async (req, res) => {
    try {
        const { orderId, reason } = req.body;

        if (!orderId || !reason) {
            return res.status(400).json({ error: "Order ID and reason are required" });
        }

        // Get payment details
        const { data: payment, error: paymentError } = await supabase
            .from('payments')
            .select('*')
            .eq('order_id', orderId)
            .single();

        if (paymentError || !payment) {
            return res.status(404).json({ error: "Payment not found for this order" });
        }

        // Check if already refunded
        if (payment.refunded) {
            return res.status(400).json({ error: "This payment has already been refunded" });
        }

        // Check if payment was successful (only refund successful payments)
        if (payment.payment_status !== 'succeeded') {
            return res.status(400).json({
                error: `Cannot refund ${payment.payment_status} payment. Only succeeded payments can be refunded.`
            });
        }

        let stripeRefundId = null;
        let refundStatus = 'succeeded';
        let failureReason = null;

        // Process Stripe refund if payment was made via card
        if (payment.payment_method === 'card' && payment.payment_intent_id) {
            try {
                const refund = await stripe.refunds.create({
                    payment_intent: payment.payment_intent_id,
                    reason: 'requested_by_customer',
                    metadata: {
                        order_id: orderId.toString(),
                        refund_reason: reason,
                        refunded_by: req.user.username || 'admin'
                    }
                });

                stripeRefundId = refund.id;
                refundStatus = refund.status; // 'succeeded', 'pending', 'failed'
            } catch (stripeError) {
                console.error("Stripe refund error:", stripeError);
                refundStatus = 'failed';
                failureReason = stripeError.message;

                // Still record the refund attempt even if Stripe fails
                // Admin may need to manually process
            }
        }

        // Record refund in database
        const { data: refundRecord, error: refundError } = await supabase
            .from('refunds')
            .insert([{
                payment_id: payment.id,
                order_id: orderId,
                amount: payment.amount,
                currency: payment.currency,
                reason: reason,
                status: refundStatus,
                stripe_refund_id: stripeRefundId,
                refunded_by: req.user.username || 'admin',
                failure_reason: failureReason
            }])
            .select()
            .single();

        if (refundError) {
            console.error("Error recording refund:", refundError);
            return res.status(500).json({ error: "Failed to record refund" });
        }

        // Update payment record
        const { error: updatePaymentError } = await supabase
            .from('payments')
            .update({
                refunded: true,
                refund_amount: payment.amount,
                refund_reason: reason,
                refund_status: refundStatus,
                refund_id: stripeRefundId,
                refunded_at: new Date().toISOString(),
                refunded_by: req.user.username || 'admin'
            })
            .eq('id', payment.id);

        if (updatePaymentError) {
            console.error("Error updating payment:", updatePaymentError);
        }

        // Update order status
        const { error: updateOrderError } = await supabase
            .from('orders')
            .update({
                order_status: 'refunded',
                payment_status: 'refunded'
            })
            .eq('id', orderId);

        if (updateOrderError) {
            console.error("Error updating order:", updateOrderError);
        }

        // Get customer details for notification
        const { data: order } = await supabase
            .from('orders')
            .select('customer_email, customer_name')
            .eq('id', orderId)
            .single();

        // Send notification to customer
        if (order && order.customer_email) {
            try {
                await sendRefundNotification(
                    order.customer_email,
                    order.customer_name || 'Customer',
                    orderId,
                    payment.amount,
                    reason
                );
            } catch (notifError) {
                console.error('Failed to send refund notification:', notifError);
                // Don't fail the refund if notification fails
            }
        }

        res.json({
            success: true,
            refund: refundRecord,
            stripeRefund: stripeRefundId ? {
                id: stripeRefundId,
                status: refundStatus
            } : null,
            message: refundStatus === 'succeeded'
                ? 'Refund processed successfully and customer notified'
                : refundStatus === 'pending'
                    ? 'Refund is pending, customer will be notified when complete'
                    : 'Refund failed: ' + failureReason
        });

    } catch (err) {
        console.error("Refund processing error:", err);
        res.status(500).json({ error: "Failed to process refund: " + err.message });
    }
});

/* GET ALL REFUNDS (ADMIN) */
app.get("/api/admin/refunds", verifyToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('refunds')
            .select(`
                *,
                payments!inner(
                    payment_method,
                    payment_intent_id,
                    customer_name
                ),
                orders!inner(
                    customer_name,
                    customer_phone,
                    customer_email,
                    total
                )
            `)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Fetch refunds error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Refunds retrieval error:", err);
        res.status(500).json({ error: "Failed to fetch refunds" });
    }
});

/* GET REFUND BY ORDER ID */
app.get("/api/refund/:orderId", async (req, res) => {
    try {
        const { orderId } = req.params;

        const { data, error } = await supabase
            .from('refunds')
            .select('*')
            .eq('order_id', orderId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: "No refund found for this order" });
            }
            console.error("Fetch refund error:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Refund retrieval error:", err);
        res.status(500).json({ error: "Failed to fetch refund" });
    }
});

/* ADMIN GET RIDERS FOR TABLE */
app.get("/api/admin/riders", verifyToken, async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .select('id, name, username, is_available, rider_status, created_at')
        .eq('role', 'rider')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json(error);
    res.json(data);
});

/* ADMIN ADD NEW RIDER */
app.post("/api/admin/riders", verifyToken, async (req, res) => {
    const { name, username, password } = req.body;

    // Simple validation
    if (!name || !username || !password) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
        .from('users')
        .insert([{
            name,
            username,
            password,
            role: 'rider',
            is_available: true
        }])
        .select();

    if (error) {
        console.error("Error creating rider:", error);
        return res.status(500).json(error);
    }

    res.json(data[0]);
});

/* ADMIN DELETE RIDER */
app.delete("/api/admin/riders/:id", verifyToken, async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from("users")
        .delete()
        .eq("id", id)
        .eq("role", "rider")
        .select();

    if (error) return res.status(400).json(error);
    res.json(data);
});

/* CHECK FOR INACTIVE RIDERS WITH ASSIGNED ORDERS */
app.get("/api/admin/riders/inactive-with-orders", verifyToken, async (req, res) => {
    try {
        // Get all inactive riders
        const { data: inactiveRiders, error: ridersError } = await supabase
            .from('users')
            .select('id, name, username')
            .eq('role', 'rider')
            .eq('is_available', false);

        if (ridersError) return res.status(500).json(ridersError);

        if (!inactiveRiders || inactiveRiders.length === 0) {
            return res.json([]);
        }

        // Get orders assigned to inactive riders that are not yet completed
        const riderIds = inactiveRiders.map(r => r.id);
        const { data: orders, error: ordersError } = await supabase
            .from('orders')
            .select('id, assigned_rider_id, order_status, customer_name')
            .in('assigned_rider_id', riderIds)
            .in('order_status', ['accepted', 'assigned', 'rider_accepted', 'on_the_way']);

        if (ordersError) return res.status(500).json(ordersError);

        // Group orders by rider
        const result = inactiveRiders
            .map(rider => {
                const riderOrders = orders.filter(o => o.assigned_rider_id === rider.id);
                return {
                    riderId: rider.id,
                    riderName: rider.name,
                    riderUsername: rider.username,
                    orderCount: riderOrders.length,
                    orders: riderOrders
                };
            })
            .filter(r => r.orderCount > 0);

        res.json(result);
    } catch (err) {
        console.error("Error checking inactive riders:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

/* MARK ORDERS AS RE-ASSIGN */
app.post("/api/admin/orders/mark-reassign", verifyToken, async (req, res) => {
    try {
        const { orderIds } = req.body;

        if (!orderIds || orderIds.length === 0) {
            return res.json({ success: true, updated: 0 });
        }

        // Get the orders first to find the assigned riders
        const { data: orders, error: fetchError } = await supabase
            .from('orders')
            .select('id, assigned_rider_id')
            .in('id', orderIds);

        if (fetchError) {
            console.error("Error fetching orders:", fetchError);
            return res.status(500).json(fetchError);
        }

        // Collect unique rider IDs that need to be marked as available
        const riderIds = [...new Set(orders.map(o => o.assigned_rider_id).filter(Boolean))];

        // Update orders to re-assign status and clear assigned rider
        const { data, error } = await supabase
            .from('orders')
            .update({ order_status: 'reassign', assigned_rider_id: null })
            .in('id', orderIds)
            .select();

        if (error) {
            console.error("Error marking orders as re-assign:", error);
            return res.status(500).json(error);
        }

        // Mark previous riders as available again
        if (riderIds.length > 0) {
            await supabase.from('users').update({ is_available: true }).in('id', riderIds);
        }

        res.json({ success: true, updated: data.length, orders: data });
    } catch (err) {
        console.error("Server error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

app.post("/api/admin/orders/:id/assign", verifyToken, async (req, res) => {
    const { id } = req.params;
    const { rider_id } = req.body;

    try {
        // First, get the current order to check if it has a verification code
        const { data: currentOrder, error: fetchError } = await supabase
            .from('orders')
            .select('verification_code')
            .eq('id', id)
            .single();

        if (fetchError) return res.status(500).json(fetchError);

        // Prepare update data
        const updateData = {
            order_status: 'assigned',
            assigned_rider_id: rider_id
        };

        // If no verification code exists, generate one (for re-assign cases)
        if (!currentOrder.verification_code) {
            updateData.verification_code = Math.floor(1000 + Math.random() * 9000).toString();
        }

        // Update the order with new rider assignment
        const { data, error } = await supabase
            .from('orders')
            .update(updateData)
            .eq('id', id)
            .select();

        if (error) return res.status(500).json(error);

        // Mark rider as unavailable since they got assigned
        await supabase.from('users').update({ is_available: false }).eq('id', rider_id);

        res.json({ success: true, order: data[0] });
    } catch (err) {
        console.error("Error assigning rider:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

/* GET AVAILABLE RIDERS (For Assignment) */
app.get("/api/admin/riders/available", verifyToken, async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .select('id, name, username, is_available')
        .eq('role', 'rider')
        .eq('is_available', true);

    if (error) return res.status(500).json(error);
    res.json(data);
});

/* RIDER AUTHENTICATION */
app.post("/api/rider/login", authLimiter, async (req, res) => {
    const { username, password } = req.body;

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .eq('password', password)
        .eq('role', 'rider')
        .single();

    if (error || !data) {
        return res.status(401).json({ message: "Invalid username or password" });
    }

    const token = jwt.sign({ username, id: data.id, role: "rider", name: data.name }, JWT_SECRET, { expiresIn: "24h" });
    // Also return the current availability status
    res.json({ token, message: "Login successful!", rider: data });
});

/* RIDER SIGNUP */
app.post("/api/rider/signup", authLimiter, async (req, res) => {
    try {
        const { name, username, password } = req.body;

        if (!name || !username || !password) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // Check if username already exists
        const { data: existingUser, error: existError } = await supabase
            .from('users')
            .select('id')
            .eq('username', username)
            .maybeSingle();

        if (existError && existError.code !== 'PGRST116') {
            console.error("SignUp check error:", existError);
            return res.status(500).json({ message: "Database check failed" });
        }

        if (existingUser) {
            return res.status(400).json({ message: "Username already exists" });
        }

        const { data, error } = await supabase
            .from('users')
            .insert([{
                name,
                username,
                password,
                role: 'rider',
                is_available: true
            }])
            .select()
            .single();

        if (error || !data) {
            console.error("SignUp insert error:", error);
            return res.status(500).json({ message: "Failed to create account" });
        }

        const token = jwt.sign({ username, id: data.id, role: "rider", name: data.name }, JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, message: "Signup successful!", rider: data });
    } catch (err) {
        console.error("Unexpected signup error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
});

/* RIDER GOOGLE LOGIN/SIGNUP */
app.post("/api/rider/google-login", authLimiter, async (req, res) => {
    try {
        const { access_token } = req.body;
        if (!access_token) return res.status(400).json({ message: "No token provided" });

        // Verify with Supabase Google Auth
        const { data: { user }, error } = await supabase.auth.getUser(access_token);

        if (error || !user) {
            console.error("Google Auth error:", error);
            return res.status(401).json({ message: "Invalid Google token" });
        }

        const email = user.email;
        const name = user.user_metadata?.full_name || email;
        const username = email;

        // Check if user exists in custom users table
        let { data: existingRider } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .maybeSingle();

        if (!existingRider) {
            const { data: newUser, error: insertError } = await supabase.from('users').insert({
                name,
                username,
                password: 'google-oauth',
                role: 'rider',
                is_available: true
            }).select().single();

            if (insertError || !newUser) {
                return res.status(500).json({ message: "Failed to create rider account" });
            }
            existingRider = newUser;
        }

        const token = jwt.sign({ username: existingRider.username, id: existingRider.id, role: "rider", name: existingRider.name }, JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, message: "Login successful!", rider: existingRider });
    } catch (err) {
        console.error("Google sync error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
});

/* TOGGLE RIDER AVAILABILITY (legacy — kept for backward compat) */
app.patch("/api/rider/availability", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { is_available } = req.body;
    const rider_status = is_available ? 'online' : 'offline';

    const { data, error } = await supabase
        .from('users')
        .update({ is_available, rider_status })
        .eq('id', req.user.id)
        .select('id, is_available, rider_status');

    if (error) return res.status(500).json(error);
    res.json({ success: true, rider: data[0] });
});

/* DEBUG: Test route to verify registration */
app.get("/api/rider/status-test", (req, res) => {
    console.log('[DEBUG] status-test hit!');
    res.json({ ok: true, message: "Route area is working" });
});

/* GET RIDER'S OWN STATUS (for restoring toggle on page load) */
app.get("/api/rider/my-status", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { data, error } = await supabase
        .from('users')
        .select('id, is_available, rider_status')
        .eq('id', req.user.id)
        .single();

    if (error) return res.status(500).json(error);
    res.json(data);
});

/* TOGGLE RIDER ONLINE/OFFLINE STATUS */
app.patch("/api/rider/status", (req, res, next) => {
    console.log('[DEBUG] PATCH /api/rider/status hit! Headers:', req.headers['content-type']);
    next();
}, verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { rider_status } = req.body; // 'online' or 'offline'
    if (!['online', 'offline'].includes(rider_status)) {
        return res.status(400).json({ error: "Status must be 'online' or 'offline'" });
    }

    const is_available = rider_status === 'online';

    try {
        // First try updating both columns
        let { data, error } = await supabase
            .from('users')
            .update({ rider_status, is_available })
            .eq('id', req.user.id)
            .select();

        // If rider_status column doesn't exist, fall back to just is_available
        if (error) {
            console.error('[RiderStatus] Full update failed, trying is_available only:', error.message);
            const result = await supabase
                .from('users')
                .update({ is_available })
                .eq('id', req.user.id)
                .select();
            data = result.data;
            error = result.error;
        }

        if (error) {
            console.error('[RiderStatus] Update failed:', JSON.stringify(error));
            return res.status(500).json({ error: error.message || 'Database update failed' });
        }

        if (!data || data.length === 0) {
            console.error('[RiderStatus] No rows matched for user ID:', req.user.id, typeof req.user.id);
            return res.status(404).json({ error: 'Rider not found in database' });
        }

        console.log('[RiderStatus] Success:', req.user.id, '->', rider_status);
        res.json({ success: true, rider: data[0] });
    } catch (err) {
        console.error('[RiderStatus] Unexpected error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* STORE RIDER ONESIGNAL PLAYER ID */
app.post("/api/rider/onesignal-id", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const playerId = req.body.player_id || req.body.onesignal_player_id;
    if (!playerId) return res.status(400).json({ error: "No player_id provided" });

    const { error } = await supabase
        .from('users')
        .update({ onesignal_player_id: playerId })
        .eq('id', req.user.id);

    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

/* SEND TEST PUSH NOTIFICATION TO RIDER */
app.post("/api/rider/test-notification", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: rider, error } = await supabase
            .from('users')
            .select('onesignal_player_id, name')
            .eq('id', req.user.id)
            .single();

        if (error || !rider || !rider.onesignal_player_id) {
            return res.status(400).json({ error: 'No push subscription found' });
        }

        await sendPushNotification(
            rider.onesignal_player_id,
            '🔔 Test Notification',
            `Hey ${rider.name || 'Rider'}, your push notifications are working!`,
            { type: 'test' }
        );

        res.json({ success: true });
    } catch (e) {
        console.error('Test notification error:', e);
        res.status(500).json({ error: 'Failed to send test notification' });
    }
});

/* RIDER ACCEPT ASSIGNED ORDER */
app.post("/api/rider/accept-order/:id", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;

    // Auto-set to on_the_way when rider accepts (no separate dispatch step)
    const { data, error } = await supabase
        .from('orders')
        .update({ order_status: 'on_the_way', assignment_expires_at: null })
        .eq('id', id)
        .eq('assigned_rider_id', req.user.id)
        .select();

    if (error) return res.status(500).json(error);
    if (!data || data.length === 0) return res.status(404).json({ error: "Order not found or not assigned to you" });

    res.json({ success: true, order: data[0] });
});

/* RIDER REJECT ASSIGNED ORDER */
app.post("/api/rider/reject-order/:id", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;

    // Reset order for reassignment
    const { data, error } = await supabase
        .from('orders')
        .update({ order_status: 'reassigning', assigned_rider_id: null, assignment_expires_at: null })
        .eq('id', id)
        .eq('assigned_rider_id', req.user.id)
        .select();

    if (error) return res.status(500).json(error);
    if (!data || data.length === 0) return res.status(404).json({ error: "Order not found" });

    // Find next available rider
    findAndAssignRider(id).catch(err => console.error('Reassign after reject failed:', err));

    res.json({ success: true });
});

/* GET RIDER ASSIGNED ORDERS */
app.get("/api/rider/orders", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('assigned_rider_id', req.user.id)
        .not('order_status', 'eq', 'cancelled')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json(error);
    res.json(data);
});

/* RIDER UPDATE ORDER STATUS */
app.post("/api/rider/orders/:id/status", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;
    const { status } = req.body;

    const { data, error } = await supabase
        .from('orders')
        .update({ order_status: status })
        .eq('id', id)
        .eq('assigned_rider_id', req.user.id)
        .select();

    if (error) return res.status(500).json(error);
    res.json({ success: true, order: data[0] });
});

/* RIDER CANCEL ASSIGNMENT */
app.post("/api/rider/orders/:id/cancel", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;

    // Reset order back to "accepted" (which shows as Received in admin unassigned)
    const { data, error } = await supabase
        .from('orders')
        .update({ order_status: 'accepted', assigned_rider_id: null })
        .eq('id', id)
        .eq('assigned_rider_id', req.user.id)
        .select();

    if (error) return res.status(500).json(error);

    // Make rider available again
    await supabase.from('users').update({ is_available: true }).eq('id', req.user.id);

    res.json({ success: true });
});

/* RIDER VERIFY DELIVERY PIN */
app.post("/api/rider/orders/:id/verify", verifyToken, async (req, res) => {
    if (req.user.role !== 'rider') return res.status(403).json({ error: "Unauthorized" });

    const { id } = req.params;
    const { pin } = req.body;

    const { data: order, error: fetchError } = await supabase
        .from('orders')
        .select('verification_code')
        .eq('id', id)
        .eq('assigned_rider_id', req.user.id)
        .single();

    if (fetchError || !order) return res.status(500).json({ error: "Order not found" });

    if (order.verification_code === pin) {
        await supabase.from('orders').update({ order_status: 'completed' }).eq('id', id);
        await supabase.from('users').update({ is_available: true }).eq('id', req.user.id);
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: "Incorrect PIN" });
    }
});

/* ==================== USER AUTHENTICATION & PROFILE ==================== */

// Middleware to verify user token (for customer users, not admin/rider)
const verifyUserToken = async (req, res, next) => {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
        return res.status(403).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    try {
        // Verify Supabase JWT token
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({ message: "Invalid or expired token" });
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid token" });
    }
};

/* GET USER PROFILE */
app.get("/api/user/profile", verifyUserToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('id', req.user.id)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error("Error fetching profile:", error);
            return res.status(500).json({ error: error.message });
        }

        // If profile doesn't exist, create it
        if (!data) {
            const { data: newProfile, error: insertError } = await supabase
                .from('user_profiles')
                .insert([{
                    id: req.user.id,
                    email: req.user.email,
                    full_name: req.user.user_metadata?.name || req.user.email.split('@')[0]
                }])
                .select()
                .single();

            if (insertError) {
                console.error("Error creating profile:", insertError);
                return res.status(500).json({ error: insertError.message });
            }

            return res.json(newProfile);
        }

        res.json(data);
    } catch (err) {
        console.error("Profile fetch error:", err);
        res.status(500).json({ error: "Failed to fetch profile" });
    }
});

/* UPDATE USER PROFILE */
app.put("/api/user/profile", verifyUserToken, async (req, res) => {
    try {
        const { full_name, phone, address, profile_picture_url } = req.body;

        const updateData = {};
        if (full_name !== undefined) updateData.full_name = full_name;
        if (phone !== undefined) updateData.phone = phone;
        if (address !== undefined) updateData.address = address;
        if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;

        const { data, error } = await supabase
            .from('user_profiles')
            .update(updateData)
            .eq('id', req.user.id)
            .select()
            .single();

        if (error) {
            console.error("Error updating profile:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Profile update error:", err);
        res.status(500).json({ error: "Failed to update profile" });
    }
});

/* GET USER CART */
app.get("/api/user/cart", verifyUserToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_carts')
            .select(`
                *,
                products:product_id (
                    id,
                    name,
                    price,
                    image,
                    available
                )
            `)
            .eq('user_id', req.user.id);

        if (error) {
            console.error("Error fetching cart:", error);
            return res.status(500).json({ error: error.message });
        }

        // Transform the data to match frontend cart structure
        const cartItems = data.map(item => ({
            id: item.products.id,
            name: item.products.name,
            price: item.products.price,
            image: item.products.image,
            quantity: item.quantity,
            available: item.products.available
        }));

        res.json(cartItems);
    } catch (err) {
        console.error("Cart fetch error:", err);
        res.status(500).json({ error: "Failed to fetch cart" });
    }
});

/* ADD ITEM TO CART */
app.post("/api/user/cart", verifyUserToken, async (req, res) => {
    try {
        const { product_id, quantity = 1 } = req.body;

        if (!product_id) {
            return res.status(400).json({ error: "Product ID is required" });
        }

        // Get product details
        const { data: product, error: productError } = await supabase
            .from('products')
            .select('*')
            .eq('id', product_id)
            .single();

        if (productError || !product) {
            return res.status(404).json({ error: "Product not found" });
        }

        // Store product data snapshot
        const productData = {
            name: product.name,
            price: product.price,
            image: product.image
        };

        // Try to insert or update the cart item
        const { data: existingItem } = await supabase
            .from('user_carts')
            .select('*')
            .eq('user_id', req.user.id)
            .eq('product_id', product_id)
            .single();

        if (existingItem) {
            // Update quantity
            const { data, error } = await supabase
                .from('user_carts')
                .update({
                    quantity: existingItem.quantity + quantity,
                    product_data: productData
                })
                .eq('id', existingItem.id)
                .select()
                .single();

            if (error) {
                console.error("Error updating cart:", error);
                return res.status(500).json({ error: error.message });
            }

            return res.json({ success: true, item: data });
        } else {
            // Insert new item
            const { data, error } = await supabase
                .from('user_carts')
                .insert([{
                    user_id: req.user.id,
                    product_id,
                    quantity,
                    product_data: productData
                }])
                .select()
                .single();

            if (error) {
                console.error("Error adding to cart:", error);
                return res.status(500).json({ error: error.message });
            }

            return res.json({ success: true, item: data });
        }
    } catch (err) {
        console.error("Cart add error:", err);
        res.status(500).json({ error: "Failed to add to cart" });
    }
});

/* UPDATE CART ITEM QUANTITY */
app.put("/api/user/cart/:productId", verifyUserToken, async (req, res) => {
    try {
        const { productId } = req.params;
        const { quantity } = req.body;

        if (quantity <= 0) {
            // Delete the item if quantity is 0 or less
            const { error } = await supabase
                .from('user_carts')
                .delete()
                .eq('user_id', req.user.id)
                .eq('product_id', productId);

            if (error) {
                console.error("Error deleting cart item:", error);
                return res.status(500).json({ error: error.message });
            }

            return res.json({ success: true, deleted: true });
        }

        const { data, error } = await supabase
            .from('user_carts')
            .update({ quantity })
            .eq('user_id', req.user.id)
            .eq('product_id', productId)
            .select()
            .single();

        if (error) {
            console.error("Error updating cart item:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, item: data });
    } catch (err) {
        console.error("Cart update error:", err);
        res.status(500).json({ error: "Failed to update cart" });
    }
});

/* DELETE CART ITEM */
app.delete("/api/user/cart/:productId", verifyUserToken, async (req, res) => {
    try {
        const { productId } = req.params;

        const { error } = await supabase
            .from('user_carts')
            .delete()
            .eq('user_id', req.user.id)
            .eq('product_id', productId);

        if (error) {
            console.error("Error deleting cart item:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Cart delete error:", err);
        res.status(500).json({ error: "Failed to delete cart item" });
    }
});

/* SYNC CART (merge localStorage cart with database) */
app.post("/api/user/cart/sync", verifyUserToken, async (req, res) => {
    try {
        const { cartItems } = req.body;

        if (!Array.isArray(cartItems)) {
            return res.status(400).json({ error: "Invalid cart data" });
        }

        // Get current database cart
        const { data: dbCart } = await supabase
            .from('user_carts')
            .select('*')
            .eq('user_id', req.user.id);

        const dbCartMap = new Map(dbCart?.map(item => [item.product_id, item]) || []);

        // Process each item from localStorage
        for (const item of cartItems) {
            const existingItem = dbCartMap.get(item.id);

            // Get product data
            const { data: product } = await supabase
                .from('products')
                .select('name, price, image')
                .eq('id', item.id)
                .single();

            const productData = product ? {
                name: product.name,
                price: product.price,
                image: product.image
            } : {
                name: item.name,
                price: item.price,
                image: item.image
            };

            if (existingItem) {
                // Update quantity (keep the higher value)
                const newQuantity = Math.max(existingItem.quantity, item.quantity);
                await supabase
                    .from('user_carts')
                    .update({
                        quantity: newQuantity,
                        product_data: productData
                    })
                    .eq('id', existingItem.id);
            } else {
                // Insert new item
                await supabase
                    .from('user_carts')
                    .insert([{
                        user_id: req.user.id,
                        product_id: item.id,
                        quantity: item.quantity,
                        product_data: productData
                    }]);
            }
        }

        // Get updated cart
        const { data: updatedCart, error } = await supabase
            .from('user_carts')
            .select(`
                *,
                products:product_id (
                    id,
                    name,
                    price,
                    image,
                    available
                )
            `)
            .eq('user_id', req.user.id);

        if (error) {
            console.error("Error syncing cart:", error);
            return res.status(500).json({ error: error.message });
        }

        // Transform the data
        const syncedCart = updatedCart.map(item => ({
            id: item.products.id,
            name: item.products.name,
            price: item.products.price,
            image: item.products.image,
            quantity: item.quantity,
            available: item.products.available
        }));

        res.json({ success: true, cart: syncedCart });
    } catch (err) {
        console.error("Cart sync error:", err);
        res.status(500).json({ error: "Failed to sync cart" });
    }
});

/* CLEAR CART (after successful checkout) */
app.delete("/api/user/cart", verifyUserToken, async (req, res) => {
    try {
        const { error } = await supabase
            .from('user_carts')
            .delete()
            .eq('user_id', req.user.id);

        if (error) {
            console.error("Error clearing cart:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Cart clear error:", err);
        res.status(500).json({ error: "Failed to clear cart" });
    }
});

/* GET USER ORDER HISTORY */
app.get("/api/user/orders", verifyUserToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Error fetching orders:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Orders fetch error:", err);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

// ============ AUTO-ASSIGNMENT ENGINE ============

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const ASSIGNMENT_TIMEOUT_SECONDS = 90;

// Send push notification via OneSignal REST API
async function sendPushNotification(playerId, title, message, data = {}) {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
        console.log('[OneSignal] Not configured — skipping push notification');
        return;
    }
    try {
        const response = await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify({
                app_id: ONESIGNAL_APP_ID,
                include_player_ids: [playerId],
                headings: { en: title },
                contents: { en: message },
                data: data,
                web_url: '/rider.html'
            })
        });
        const result = await response.json();
        console.log('[OneSignal] Push sent:', result.id || result);
    } catch (err) {
        console.error('[OneSignal] Push failed:', err.message);
    }
}

// Find an available rider and assign the order
async function findAndAssignRider(orderId, excludeRiderIds = []) {
    try {
        // Get all online riders
        let query = supabase
            .from('users')
            .select('id, name, onesignal_player_id')
            .eq('role', 'rider')
            .eq('rider_status', 'online');

        const { data: onlineRiders, error: ridersError } = await query;
        if (ridersError || !onlineRiders || onlineRiders.length === 0) {
            console.log('[AutoAssign] No online riders found. Order', orderId, 'awaiting rider.');
            await supabase.from('orders').update({ order_status: 'awaiting_rider' }).eq('id', orderId);
            return null;
        }

        // Filter out excluded riders and find riders with < 3 active orders
        for (const rider of onlineRiders) {
            if (excludeRiderIds.includes(rider.id)) continue;

            // Count rider's active orders
            const { count, error: countError } = await supabase
                .from('orders')
                .select('*', { count: 'exact', head: true })
                .eq('assigned_rider_id', rider.id)
                .in('order_status', ['assigned', 'rider_accepted', 'on_the_way']);

            if (countError) continue;
            if (count >= 3) continue;

            // This rider is available — assign the order
            const expiresAt = new Date(Date.now() + ASSIGNMENT_TIMEOUT_SECONDS * 1000).toISOString();

            const { error: updateError } = await supabase
                .from('orders')
                .update({
                    order_status: 'assigned',
                    assigned_rider_id: rider.id,
                    assignment_expires_at: expiresAt
                })
                .eq('id', orderId);

            if (updateError) {
                console.error('[AutoAssign] Failed to assign order', orderId, 'to rider', rider.id);
                continue;
            }

            console.log(`[AutoAssign] Order ${orderId} assigned to rider ${rider.name} (${rider.id}). Expires at ${expiresAt}`);

            // Send push notification
            if (rider.onesignal_player_id) {
                sendPushNotification(
                    rider.onesignal_player_id,
                    'New Delivery Assignment',
                    'You have a new delivery order. Open your dashboard to accept.',
                    { order_id: orderId }
                );
            }

            return rider;
        }

        // No available rider found
        console.log('[AutoAssign] All online riders at capacity. Order', orderId, 'awaiting rider.');
        await supabase.from('orders').update({ order_status: 'awaiting_rider' }).eq('id', orderId);
        return null;
    } catch (err) {
        console.error('[AutoAssign] Error:', err);
        return null;
    }
}

// Check for expired assignments and reassign
async function checkExpiredAssignments() {
    try {
        const now = new Date().toISOString();

        const { data: expiredOrders, error } = await supabase
            .from('orders')
            .select('id, assigned_rider_id')
            .eq('order_status', 'assigned')
            .lt('assignment_expires_at', now);

        if (error || !expiredOrders || expiredOrders.length === 0) return;

        for (const order of expiredOrders) {
            console.log(`[AutoReassign] Order ${order.id} assignment expired. Reassigning...`);

            const previousRiderId = order.assigned_rider_id;

            // Reset order for reassignment
            await supabase
                .from('orders')
                .update({
                    order_status: 'reassigning',
                    assigned_rider_id: null,
                    assignment_expires_at: null
                })
                .eq('id', order.id);

            // Find next rider, excluding the previous one
            await findAndAssignRider(order.id, previousRiderId ? [previousRiderId] : []);
        }
    } catch (err) {
        console.error('[AutoReassign] Error:', err);
    }
}

// Run expired assignment check every 30 seconds
setInterval(checkExpiredAssignments, 30 * 1000);

// ============ CURFEW: AUTO-OFFLINE ALL RIDERS AT 10 PM ============

let curfewTriggeredToday = false;

async function checkRiderCurfew() {
    const now = new Date();
    const hour = now.getHours();

    // Reset flag at midnight
    if (hour < 22) {
        curfewTriggeredToday = false;
        return;
    }

    // At 10 PM (22:00), set all online riders to offline — only once per day
    if (hour >= 22 && !curfewTriggeredToday) {
        curfewTriggeredToday = true;
        console.log('[Curfew] 10:00 PM reached — setting all online riders to offline...');

        const { data, error } = await supabase
            .from('users')
            .update({ rider_status: 'offline', is_available: false })
            .eq('role', 'rider')
            .eq('rider_status', 'online')
            .select('id, name');

        if (error) {
            console.error('[Curfew] Error:', error);
        } else if (data && data.length > 0) {
            console.log(`[Curfew] Set ${data.length} rider(s) offline:`, data.map(r => r.name).join(', '));
        } else {
            console.log('[Curfew] No online riders to set offline.');
        }
    }
}

// Check curfew every 60 seconds
setInterval(checkRiderCurfew, 60 * 1000);

// ============ START SERVER ============

app.listen(5000, () => {
    console.log("Server running on http://localhost:5000");
    console.log("[AutoAssign] Expired assignment checker running (every 30s)");
});

module.exports = app;