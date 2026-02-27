require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
app.post("/api/admin/login", (req, res) => {
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

/* GET PRODUCTS */
app.get("/products", async (req, res) => {
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
    res.json(data);
});

/* LIVE SUPABASE ORDERS API */
app.get("/api/admin/orders", verifyToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Supabase error fetching orders:", error);
            return res.status(500).json(error);
        }

        const mappedOrders = data.map(o => {
            let items = [];
            try {
                items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
            } catch (e) { }
            const orderName = items.map(i => `${i.quantity}x ${i.name}`).join(', ');

            let status = 'Pending';
            if (o.order_status === 'pending') status = 'Pending';
            else if (o.order_status === 'cancelled') status = 'Cancel';
            else if (o.order_status === 'dispatched' || o.order_status === 'on_delivery') status = 'Dispatched';
            else status = 'Received';

            const date = new Date(o.created_at);
            const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

            return {
                id: o.id,
                orderName: orderName || "Unknown Order",
                customerName: o.customer_name || "Guest",
                status: status,
                deliveryTime: timeStr,
                price: parseFloat(o.total) || 0,
                declineReason: null,
                verificationCode: o.verification_code || null,
                deliveryAddress: o.delivery_address || 'No Address Provided'
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

    if (status === 'Received') updateData.order_status = 'accepted';
    else if (status === 'Cancel') updateData.order_status = 'cancelled';
    else if (status === 'Dispatched') {
        updateData.order_status = 'on_delivery';
        updateData.verification_code = id.toString();
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

        res.json({ id: id, status: status, declineReason: reason, verificationCode: updateData.verification_code });
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

app.listen(5000, () => {
    console.log("Server running on http://localhost:5000");
});