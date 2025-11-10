// server.js — cleaned and consolidated
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const axios = require("axios");
const bcrypt = require("bcryptjs");

dotenv.config();

const db = require("./db");
// Small helper error type for clearer runtime errors when parsing paths/params
class PathError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PathError';
    if (cause) this.cause = cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, PathError);
  }
}

// Helper to throw a PathError with interpolated index message
function throwPathError(index, cause) {
  throw new PathError(`missing parameter name at index ${index}`, cause);
}
// ===== Mappls Token Cache =====
let mapplsToken = null;
let tokenExpiry = 0;

async function getMapplsToken() {
  const now = Date.now();

  // Return cached token if still valid
  if (mapplsToken && now < tokenExpiry) {
    return mapplsToken;
  }

  console.log("🔄 Fetching new Mappls token...");

  // Use environment variables or safe placeholders
  const clientId = process.env.MAPPLS_CLIENT_ID || "YOUR_MAPPLS_CLIENT_ID";
  const clientSecret = process.env.MAPPLS_CLIENT_SECRET || "YOUR_MAPPLS_CLIENT_SECRET";

  if (!clientId || !clientSecret || clientId.includes("YOUR_")) {
    console.warn("⚠️ Warning: Using placeholder Mappls credentials — please set real keys in .env before going live.");
  }

  const resp = await axios.post(
    "https://outpost.mappls.com/api/security/oauth/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  mapplsToken = resp.data.access_token;
  tokenExpiry = now + (resp.data.expires_in - 300) * 1000; // refresh 5 min early

  console.log("✅ Mappls token refreshed successfully!");
  return mapplsToken;
}



// Optional modular routes (if present in repo)
let authRoutes, authMiddleware, orderRoutes, paymentRoutes, trackingRoutes, userAddressesRoutes, deliveryRoutes;
try {
  ({ router: authRoutes, authMiddleware } = require("./routes/auth"));
} catch (_) {}
try {
  const orderRoutesFactory = require("./routes/orders");
  orderRoutes = orderRoutesFactory ? orderRoutesFactory : null;
} catch (_) {}
try { paymentRoutes = require("./routes/payments"); } catch (_) {}
try { trackingRoutes = require("./routes/tracking"); } catch (_) {}
try { userAddressesRoutes = require("./routes/user-addresses"); } catch (_) {}
try { deliveryRoutes = require("./routes/delivery"); } catch (_) {}

// Ensure authMiddleware is always defined to avoid "not recognised" errors
if (typeof authMiddleware !== "function") {
  authMiddleware = (req, _res, next) => next();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Body parsing
app.use(bodyParser.json());
app.use(express.json());

// ✅ CORS Setup


const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000",   // React/Vite/Next.js dev servers
  "http://127.0.0.1:3000"
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (e.g., mobile apps or curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Block others (explicitly deny without throwing an error)
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // allow cookies/auth headers if needed
  })
);

// ✅ Automatically handle preflight requests for any route
app.options(/.*/, cors());


// Multer (uploads)
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });


// Static files (uploads + frontend)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
// Avoid favicon 404 log noise
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Helper: fallback restaurant cards when curated tables are missing
fetch('http://localhost:5000/api/orders')
  .then(response => response.json())
  .then(data => {
    console.log('Fetched orders:', data);
  })
  .catch(error => {
    console.error('Error fetching orders:', error);
  });

function fallbackRestaurantCards(limit = 10) {
  return fetch(`http://localhost:5000/api/restaurants?limit=${limit}`)
    .then(response => response.json())
    .then(data => {
      console.log('Fetched fallback restaurant cards:', data);
      return data;
    })
    .catch(error => {
      console.error('Error fetching fallback restaurant cards:', error);
      return [];
    });
}

// ===== Featured Restaurants (public) =====
app.get("/api/featured-restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT fr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status,
             (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating,
             (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count
      FROM featured_restaurants fr
      JOIN restaurants r ON fr.restaurant_id = r.id
      ORDER BY fr.position ASC
    `);
    return res.json(results);
  } catch (err) {
    console.error("Error fetching featured restaurants:", err?.message || err);
    try {
      const fallback = await fetchFallbackRestaurantCards(10);
      return res.json(fallback);
    } catch (e) {
      console.error("Featured restaurants fallback failed:", e?.message || e);
    }
    return res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

// Alias for some older clients
app.get("/api/restaurants/featured", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT fr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status
      FROM featured_restaurants fr
      JOIN restaurants r ON fr.restaurant_id = r.id
      ORDER BY fr.position ASC
    `);
    return res.json(results);
  } catch (err) {
    try { return res.json(await fetchFallbackRestaurantCards(10)); } catch (_) {}
    return res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

// ===== Top Restaurants (public) =====
app.get("/api/top-restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT tr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status,
             (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating,
             (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count
      FROM top_restaurants tr
      JOIN restaurants r ON tr.restaurant_id = r.id
      ORDER BY tr.position ASC
    `);
    return res.json(results);
  } catch (err) {
    console.error("Error fetching top restaurants:", err?.message || err);
    try {
      const fallback = await fetchFallbackRestaurantCards(10);
      return res.json(fallback);
    } catch (e) {
      console.error("Top restaurants fallback failed:", e?.message || e);
    }
    return res.status(500).json({ error: "Failed to fetch top restaurants" });
  }
});

// Alias for some older clients
app.get("/api/restaurants/top", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT tr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status
      FROM top_restaurants tr
      JOIN restaurants r ON tr.restaurant_id = r.id
      ORDER BY tr.position ASC
    `);
    return res.json(results);
  } catch (_) {
    try { return res.json(await fetchFallbackRestaurantCards(10)); } catch (e) {}
    return res.status(500).json({ error: "Failed to fetch top restaurants" });
  }
});

// ===== Restaurants List =====
app.get("/api/restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT r.*,
             (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating,
             (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count
      FROM restaurants r
      WHERE r.status='approved'
    `);
    return res.json(results);
  } catch (err) {
    console.error("Error fetching restaurants:", err?.message || err);
    try {
      const fb = await fetchFallbackRestaurantCards(20);
      return res.json(fb);
    } catch (e) {
      console.error("Restaurants fallback failed:", e?.message || e);
    }
    return res.status(500).json({ error: "DB error" });
  }
});

// ===== Banners (optional) =====
app.get("/api/banners", async (req, res) => {
  try {
    const wantAll = String(req.query.all || "").toLowerCase() === "true";
    if (wantAll) {
      const [rows] = await db.execute("SELECT * FROM banners ORDER BY created_at DESC");
      return res.json(rows);
    }
    const [rows] = await db.execute(
      "SELECT * FROM banners WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"
    );
    return res.json(rows[0] || null);
  } catch (err) {
    console.error("Error fetching banners:", err?.message || err);
    return res.status(500).json({ error: "Failed to fetch banners" });
  }
});
app.post("/api/admin/banners", upload.single("banner"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const imageUrl = file.filename;
    const [result] = await db.execute(
      "INSERT INTO banners (image_url, is_active, created_at) VALUES (?, 1, NOW())",
      [imageUrl]
    );
    return res.json({ id: result.insertId, image_url: imageUrl });
  } catch (err) {
    console.error("Error uploading banner:", err?.message || err);
    return res.status(500).json({ error: "Failed to upload banner" });
  }
});
app.get("/api/admin/banners", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM banners ORDER BY created_at DESC");
    return res.json(rows);
  } catch (err) {
    console.error("Error listing banners:", err?.message || err);
    return res.status(500).json({ error: "Failed to list banners" });
  }
});
app.delete("/api/admin/banners/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM banners WHERE id = ?", [id]);
    return res.json({ message: "Banner removed" });
  } catch (err) {
    console.error("Error deleting banner:", err?.message || err);
    return res.status(500).json({ error: "Failed to delete banner" });
  }
});

// ===== Mappls Token Route =====
app.get("/api/mappls/token", async (req, res) => {
  try {
    const clientId = "MAPPLS_CLIENT_ID";
    const clientSecret = "MAPPLS_CLIENT_SECRET";

    const tokenResponse = await axios.post(
      "https://outpost.mappls.com/api/security/oauth/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const token = tokenResponse.data.access_token;
    console.log("✅ Mappls token generated successfully");
    res.json({ access_token: token });
  } catch (err) {
    console.error("❌ Failed to fetch Mappls token:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch Mappls token" });
  }
});


// ===== Reverse Geocode (Mappls) =====
app.get("/api/mappls/reverse-geocode", async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng)
      return res.status(400).json({ error: "lat and lng are required" });

    // ✅ Get token from cache or fetch new
    const token = await getMapplsToken();

    // ✅ Use correct REST KEY here
    const REST_KEY = "MAPPLS_API_KEY"; // from your HTML Mappls SDK
    const mapplsURL = `https://apis.mappls.com/advancedmaps/v1/${REST_KEY}/rev_geocode?lat=${lat}&lng=${lng}`;

    // ✅ Include access token in headers
    const { data } = await axios.get(mapplsURL, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log("✅ Mappls reverse-geocode raw:", data);

    const r = data.results?.[0] || data.result || data.address || {};
    const address = {
      formatted: r.formattedAddress || r.formatted || null,
      street: [r.poi, r.locality, r.subLocality, r.road].filter(Boolean).join(", "),
      city: r.city || r.district || r.village || "",
      state: r.state || "",
      pincode: r.pincode || "",
      country: r.country || "India",
      latitude: lat,
      longitude: lng,
    };

    res.json({ success: true, source: "Mappls", address });
  } catch (err) {
    console.error("❌ Reverse geocode failed:", err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to reverse geocode",
      details: err.response?.data || err.message
    });
  }
});


// ===== Reviews =====
app.post("/api/orders/:orderId/review", async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const { rating, comment } = req.body || {};
    if (!orderId || !Number.isFinite(Number(rating)) || rating < 1 || rating > 5)
      return res.status(400).json({ error: "Invalid orderId or rating" });
    const [orders] = await db.execute(
      "SELECT id, user_id, restaurant_id, status FROM orders WHERE id = ? LIMIT 1",
      [orderId]
    );
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    const ord = orders[0];
  const [exists] = await db.execute("SELECT id FROM restaurant_reviews WHERE order_id = ? LIMIT 1", [orderId]);
    if (exists.length) return res.status(409).json({ error: "Review already submitted for this order" });
    await db.execute(
  "INSERT INTO restaurant_reviews (order_id, user_id, restaurant_id, rating, comment) VALUES (?,?,?,?,?)",
      [orderId, ord.user_id || null, ord.restaurant_id, Math.round(rating), comment || null]
    );
    return res.json({ message: "Thanks for your review!" });
  } catch (err) {
    console.error("Review submit error:", err?.message || err);
    return res.status(500).json({ error: "Failed to submit review" });
  }
});
app.get("/api/restaurants/:id/reviews/summary", async (req, res) => {
  try {
    const rid = Number(req.params.id);
    const [[row]] = await db.execute(
  "SELECT ROUND(AVG(rating),1) AS avg, COUNT(*) AS count FROM restaurant_reviews WHERE restaurant_id = ?",
      [rid]
    );
    return res.json({ avg: row?.avg || null, count: row?.count || 0 });
  } catch (err) {
    console.error("Review summary error:", err?.message || err);
    return res.status(500).json({ error: "Failed to fetch review summary" });
  }
});

// ===== Menu (admin + restaurant) =====
app.get("/api/admin/menu", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT m.*, r.name AS restaurant_name
       FROM menu m
       JOIN restaurants r ON m.restaurant_id = r.id
       ORDER BY m.created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching admin menu:", err?.message || err);
    return res.status(500).json({ error: "Failed to fetch admin menu" });
  }
});
app.get("/api/restaurant/:id/menu", async (req, res) => {
  try {
    const restaurantId = req.params.id;
    const [rows] = await db.execute("SELECT * FROM menu WHERE restaurant_id = ?", [restaurantId]);
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching menus:", err?.message || err);
    return res.status(500).json({ message: "Error fetching menu items" });
  }
});
app.get("/api/menu/by-restaurant/:id", async (req, res) => {
  try {
    const restaurantId = req.params.id;
    const [rows] = await db.execute("SELECT * FROM menu WHERE restaurant_id = ?", [restaurantId]);
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching menu by restaurant:", err?.message || err);
    return res.status(500).json({ message: "Error fetching menu items" });
  }
});
app.post("/api/menu", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const user = req.user || {};
    if (user.role && user.role !== "restaurant")
      return res.status(403).json({ error: "Only restaurants can add menu items" });
    const restaurantId = user.restaurant_id || 1; // fallback for local dev
    const { item_name, price, description, category } = req.body;
    const imageUrl = req.file ? req.file.filename : null;
    if (!item_name || !price) return res.status(400).json({ error: "Missing item_name or price" });
    const [result] = await db.execute(
      "INSERT INTO menu (restaurant_id, item_name, description, price, category, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [restaurantId, item_name, description || "", Number(price) || 0, category || null, imageUrl]
    );
    return res.json({ message: "Dish added", id: result.insertId });
  } catch (err) {
    console.error("Error adding menu item:", err?.message || err);
    return res.status(500).json({ error: "Failed to add menu item", details: err.message });
  }
});
app.post("/api/menu/test-add", upload.single("image"), async (req, res) => {
  try {
    const { item_name, price, description, category } = req.body || {};
    const imageUrl = req.file ? req.file.filename : null;
    if (!item_name || !price) return res.status(400).json({ error: "Missing item_name or price" });
    const restaurantId = 1;
    const [result] = await db.execute(
      "INSERT INTO menu (restaurant_id, item_name, description, price, category, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [restaurantId, item_name, description || "", Number(price) || 0, category || null, imageUrl]
    );
    return res.json({ message: "Test dish added", id: result.insertId });
  } catch (err) {
    console.error("TEST_ADD error:", err?.message || err);
    return res.status(500).json({ error: "Test add failed", details: err.message });
  }
});
app.get("/api/menu/my", authMiddleware, async (req, res) => {
  try {
    const user = req.user || {};
    const restaurantId = user.restaurant_id || 1;
    const [rows] = await db.execute("SELECT * FROM menu WHERE restaurant_id = ? ORDER BY created_at DESC", [restaurantId]);
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching my menu:", err?.message || err);
    return res.status(500).json({ error: "Failed to fetch menu" });
  }
});
app.delete("/api/menu/:id", authMiddleware, async (req, res) => {
  try {
    const user = req.user || {};
    const menuId = req.params.id;
    const [rows] = await db.execute("SELECT restaurant_id, image_url FROM menu WHERE id = ?", [menuId]);
    if (!rows.length) return res.status(404).json({ error: "Menu item not found" });
    const ownerId = rows[0].restaurant_id;
    if (user.role && user.role !== "admin" && user.restaurant_id !== ownerId)
      return res.status(403).json({ error: "Not authorized" });
    await db.execute("DELETE FROM menu WHERE id = ?", [menuId]);
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error("Error deleting menu item:", err?.message || err);
    return res.status(500).json({ error: "Failed to delete menu item" });
  }
});

// ===== Users (auth basics) =====
if (authRoutes) app.use("/api/auth", authRoutes);
if (orderRoutes) {
  const or = orderRoutes(io);
  app.use("/api/orders", or);
}
if (paymentRoutes) app.use("/api/payments", paymentRoutes);
if (trackingRoutes) app.use("/api/tracking", trackingRoutes);
if (userAddressesRoutes) app.use("/api/user-addresses", userAddressesRoutes);
if (deliveryRoutes) {
  try {
    const dr = deliveryRoutes(io);
    app.use("/api/delivery", dr);
  } catch (e) {
    console.warn("Skipping deliveryRoutes — factory did not return a router:", e?.message || e);
  }
}

app.post("/api/users", async (req, res) => {
  try {
    const { name, email, password, role, restaurant_id } = req.body || {};
    const hashedPassword = await bcrypt.hash(password, 10);
    const status = role === "restaurant" ? "pending" : "active";
    const [result] = await db.execute(
      "INSERT INTO users (name, email, password, role, status, restaurant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [name, email, hashedPassword, role, status, restaurant_id || null]
    );
    if (role === "restaurant") {
      await db.execute(
        "INSERT INTO restaurants (name, status, created_at) VALUES (?, 'pending', NOW())",
        [name]
      );
    }
    return res.json({ message: "User registered", id: result.insertId });
  } catch (err) {
    console.error("Error registering user:", err?.message || err);
    return res.status(500).json({ error: "Failed to register user" });
  }
});
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const [users] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
    if (!users.length) return res.status(401).json({ error: "Invalid email or password" });
    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ error: "Invalid email or password" });
    const { password: _pw, ...userInfo } = user;
    return res.json(userInfo);
  } catch (err) {
    console.error("Error logging in:", err?.message || err);
    return res.status(500).json({ error: "Failed to log in" });
  }
});
if (authMiddleware) {
  app.get("/api/users/profile", authMiddleware, async (req, res) => {
    try {
      const [users] = await db.execute(
        "SELECT id, name, email, role, status FROM users WHERE id = ?",
        [req.user?.id || 0]
      );
      if (!users.length) return res.status(404).json({ error: "User not found" });
      return res.json(users[0]);
    } catch (err) {
      console.error("Error fetching user profile:", err?.message || err);
      return res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });
  app.put("/api/users/profile", authMiddleware, async (req, res) => {
    try {
      const { name, email, password } = req.body || {};
      let hashedPassword = null;
      if (password) hashedPassword = await bcrypt.hash(password, 10);
      await db.execute(
        "UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?",
        [name, email, hashedPassword, req.user?.id || 0]
      );
      return res.json({ message: "Profile updated" });
    } catch (err) {
      console.error("Error updating profile:", err?.message || err);
      return res.status(500).json({ error: "Failed to update profile" });
    }
  });
}

// (listen moved to bottom; ensure only one listen call exists)

app.get('/api/featured-restaurants', async (req, res) => {
  try {
  const [results] = await db.execute(`SELECT fr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status, (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating, (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count FROM featured_restaurants fr JOIN restaurants r ON fr.restaurant_id = r.id ORDER BY fr.position ASC`);
    return res.json(results);
  } catch (err) {
    console.error('Error fetching featured restaurants:', err?.message || err);
    try { const fallback = await fetchFallbackRestaurantCards(10); return res.json(fallback); } catch (e) { console.error('Featured fallback failed:', e?.message || e); }
    return res.status(500).json({ error: 'Failed to fetch featured restaurants' });
  }
});

// Top
app.get('/api/top-restaurants', async (req, res) => {
  try {
  const [results] = await db.execute(`SELECT tr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status, (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating, (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count FROM top_restaurants tr JOIN restaurants r ON tr.restaurant_id = r.id ORDER BY tr.position ASC`);
    return res.json(results);
  } catch (err) {
    console.error('Error fetching top restaurants:', err?.message || err);
    try { const fallback = await fetchFallbackRestaurantCards(10); return res.json(fallback); } catch (e) { console.error('Top fallback failed:', e?.message || e); }
    return res.status(500).json({ error: 'Failed to fetch top restaurants' });
  }
});

// Restaurants list
app.get('/api/restaurants', async (req, res) => {
  try {
  const [results] = await db.execute(`SELECT r.*, (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating, (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count FROM restaurants r WHERE r.status='approved'`);
    return res.json(results);
  } catch (err) {
    console.error('Error fetching restaurants:', err?.message || err);
    try { const fallback = await fetchFallbackRestaurantCards(20); return res.json(fallback); } catch (e) { console.error('Restaurants fallback failed:', e?.message || e); }
    return res.status(500).json({ error: 'DB error' });
  }
});

// Reverse geocode fallback
app.get('/api/geocode/reverse', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&addressdetails=1`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'tindo-app/1.0' } });
    return res.json({ address: data.display_name, address_details: data.address || null });
  } catch (err) {
    console.error('Reverse geocode error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to reverse geocode' });
  }
});

// Reviews
app.post('/api/orders/:orderId/review', async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const { rating, comment } = req.body || {};
    if (!orderId || !Number.isFinite(Number(rating)) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Invalid orderId or rating' });
    const [orders] = await db.execute('SELECT id, user_id, restaurant_id, status FROM orders WHERE id = ? LIMIT 1', [orderId]);
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });
    const ord = orders[0];
  const [exists] = await db.execute('SELECT id FROM restaurant_reviews WHERE order_id = ? LIMIT 1', [orderId]);
    if (exists.length) return res.status(409).json({ error: 'Review already submitted for this order' });
  await db.execute('INSERT INTO restaurant_reviews (order_id, user_id, restaurant_id, rating, comment) VALUES (?,?,?,?,?)', [orderId, ord.user_id || null, ord.restaurant_id, Math.round(rating), comment || null]);
    return res.json({ message: 'Thanks for your review!' });
  } catch (err) {
    console.error('Review submit error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to submit review' });
  }
});

app.get('/api/restaurants/:id/reviews/summary', async (req, res) => {
  try {
    const rid = Number(req.params.id);
  const [[row]] = await db.execute('SELECT ROUND(AVG(rating),1) AS avg, COUNT(*) AS count FROM restaurant_reviews WHERE restaurant_id = ?', [rid]);
    return res.json({ avg: row?.avg || null, count: row?.count || 0 });
  } catch (err) {
    console.error('Review summary error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch review summary' });
  }
});

// ✅ Correct SPA fallback (Express v5 compatible)
app.get('/favicon.ico', (req, res) => res.status(204).end());


// ✅ Delivery agent assignment route (fixed async + clean logic)
app.put('/api/orders/:orderId/assign', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const { rlat, rlng, agents, loadMap, ASSIGN_MAX_KM = 10 } = req.body;

    // If required data missing
    if (!orderId || !Array.isArray(agents) || !rlat || !rlng) {
      return res.status(400).json({ error: 'Missing data for assignment' });
    }

    // Helper functions
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371; // Earth's radius in km
    const dist = (aLat, aLng, bLat, bLng) => {
      const dLat = toRad(bLat - aLat);
      const dLng = toRad(bLng - aLng);
      const sa =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) *
          Math.cos(toRad(bLat)) *
          Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
      return R * c;
    };

    // Prepare candidates list
    let candidates = agents.map((a) => ({
      id: a.id,
      d: dist(rlat, rlng, Number(a.lat), Number(a.lng)),
      load: loadMap?.[a.id] ?? 0,
    }));

    // Filter by distance threshold
    candidates = candidates.filter((c) => c.d <= ASSIGN_MAX_KM);
    if (!candidates.length) {
      return res
        .status(400)
        .json({ error: `No active agents within ${ASSIGN_MAX_KM} km` });
    }

    // Sort by current load, then distance
    candidates.sort((a, b) => a.load - b.load || a.d - b.d);
    const best = candidates[0];

    // ✅ Fix: await only works inside async (this route is async)
    await db.execute(
      'UPDATE orders SET agent_id = ?, status = "Confirmed" WHERE id = ?',
      [best.id, orderId]
    );

    res.json({
      message: 'Agent assigned (nearest)',
      agent_id: best.id,
      distance_km: Number(best.d.toFixed(2)),
    });
  } catch (err) {
    console.error('Assign agent failed:', err);
    res.status(500).json({
      error: 'Failed to assign agent',
      details: err.message,
    });
  }
});

app.get('/api/admin/delivery', async (req, res) => {
  try {
    const showAll = String(req.query.all || '').toLowerCase() === 'true';
    const where = showAll ? '' : "WHERE a.status = 'Active'";
    const [rows] = await db.execute(`SELECT a.id, a.name, a.phone, a.status, a.lat, a.lng, u.email FROM agents a LEFT JOIN users u ON u.id = a.user_id ${where}`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch delivery agents' });
  }
});

// Admin: Approve a delivery agent (sets status = 'Active')
app.post('/api/admin/delivery/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid agent id' });
    await db.execute('UPDATE agents SET status = ? WHERE id = ?', ['Active', id]);
    // notify via socket
    try { io.emit('agentStatusChanged', { agent_id: id, status: 'Active' }); } catch(_) {}
    res.json({ message: 'Agent approved', agent_id: id });
  } catch (err) {
    console.error('Approve agent failed:', err);
    res.status(500).json({ error: 'Failed to approve agent' });
  }
});

// Admin: Reject a delivery agent (sets status = 'Rejected')
app.post('/api/admin/delivery/:id/reject', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid agent id' });
    await db.execute('UPDATE agents SET status = ? WHERE id = ?', ['Rejected', id]);
    try { io.emit('agentStatusChanged', { agent_id: id, status: 'Rejected' }); } catch(_) {}
    res.json({ message: 'Agent rejected', agent_id: id });
  } catch (err) {
    console.error('Reject agent failed:', err);
    res.status(500).json({ error: 'Failed to reject agent' });
  }
});

// ===== USERS =====
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password, role, restaurant_id } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const status = role === 'restaurant' ? 'pending' : 'active';
    const [result] = await db.execute('INSERT INTO users (name, email, password, role, status, restaurant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())', [name, email, hashedPassword, role, status, restaurant_id || null]);
    if (role === 'restaurant') await db.execute('INSERT INTO restaurants (name, status, created_at) VALUES (?, "pending", NOW())', [name]);
    res.json({ message: 'User registered', id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register user' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!users.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ error: 'Invalid email or password' });
    const { password: _pw, ...userInfo } = user;
    res.json(userInfo);
  } catch (err) {
    res.status(500).json({ error: 'Failed to log in' });
  }
});

app.get('/api/users/profile', authMiddleware, async (req, res) => {
  try {
    const [users] = await db.execute('SELECT id, name, email, role, status FROM users WHERE id = ?', [req.user.id]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    res.json(users[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.put('/api/users/profile', authMiddleware, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    let hashedPassword = null;
    if (password) hashedPassword = await bcrypt.hash(password, 10);
    await db.execute('UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?', [name, email, hashedPassword, req.user.id]);
    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// [Removed duplicate Socket.IO realtime block]



// ✅ 7. Route registration (now io is available)
if (authRoutes) app.use("/api/auth", authRoutes);

if (orderRoutes) {
  const or = orderRoutes(io); // pass io safely
  app.use("/api/orders", or);
}

if (paymentRoutes) app.use("/api/payments", paymentRoutes);
if (trackingRoutes) app.use("/api/tracking", trackingRoutes);
if (userAddressesRoutes)
  app.use("/api/user-addresses", userAddressesRoutes);
// SPA: serve index for unmatched routes (client-side routing)

// ✅ Import routes safely
let orderRoutesFactory;
try {
  orderRoutesFactory = require("./routes/orders");
} catch (e) {
  console.warn("Orders route not found, skipping:", e.message);
}

// ✅ Proper CORS middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow REST clients without origin (e.g., Postman) and allowed frontend origins
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ✅ (OPTIONAL) Attach routes if defined
if (orderRoutesFactory) {
  const orderRoutes = orderRoutesFactory();
  app.use("/api/orders", orderRoutes);
}

// ✅ Featured restaurants endpoint
app.get("/api/restaurants/featured", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT fr.*, r.name, r.cuisine, r.image_url, r.status AS restaurant_status
      FROM featured_restaurants fr
      JOIN restaurants r ON fr.restaurant_id = r.id
      ORDER BY fr.position ASC
    `);
    return res.json(results);
  } catch (err) {
    console.error("Error fetching featured restaurants:", err.message);
    return res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

// ===== Featured Restaurants (public) =====
app.get("/api/restaurants/featured", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT fr.*, r.name, r.cuisine, r.image_url, r.status AS restaurant_status
      FROM featured_restaurants fr
      JOIN restaurants r ON fr.restaurant_id = r.id
      ORDER BY fr.position ASC
    `);
    return res.json(results);
  } catch (err) {
    console.error("Error fetching featured restaurants:", err.message);
    return res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

// Simulate periodic movement every 30 seconds
setInterval(() => {
  try {
    deliveryAgentLocation.lat += 0.0005;
    deliveryAgentLocation.lng += 0.0004;
  } catch (_) { /* no-op */ }
}, 30000);
// ====== RESTAURANTS ======
app.post("/api/restaurants", async (req, res) => {
  try {
    const { name, description, image_url, eta } = req.body;
    const [result] = await db.execute(
      "INSERT INTO restaurants (name, description, image_url, eta, status, created_at) VALUES (?, ?, ?, ?, 'pending', NOW())",
      [name, description, image_url, eta]
    );
    res.json({
      message: "Restaurant submitted, pending admin approval",
      id: result.insertId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/restaurants/approve/:id", async (req, res) => {
  try {
    await db.execute("UPDATE restaurants SET status='approved' WHERE id=?", [
      req.params.id,
    ]);
    await db.execute(
      "UPDATE users SET status='approved' WHERE restaurant_id=?",
      [req.params.id]
    );
    res.json({ message: "Restaurant approved ✅" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Reject a restaurant (Admin only)
app.put("/api/restaurants/reject/:id", async (req, res) => {
  try {
    // Reject the restaurant
    await db.execute("UPDATE restaurants SET status='rejected' WHERE id=?", [
      req.params.id,
    ]);

    // Also update the corresponding user (if linked by restaurant_id)
    await db.execute("UPDATE users SET status='rejected' WHERE restaurant_id=?", [
      req.params.id,
    ]);

    res.json({ message: "Restaurant rejected ❌" });
  } catch (err) {
    console.error("Error rejecting restaurant:", err.message);
    res.status(500).json({ error: "Database error while rejecting restaurant" });
  }
});


// ✅ Admin: View all restaurants (approved, pending, rejected)
app.get("/api/admin/restaurants", async (req, res) => {
  try {
    const [results] = await db.execute("SELECT * FROM restaurants");
    res.json(results);
  } catch (err) {
    console.error("Error fetching all restaurants:", err.message);
    res.status(500).json({ error: "Failed to fetch restaurants" });
  }
});


// ✅ Public: List only approved restaurants with ratings
app.get("/api/restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT 
        r.*,
        (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating,
          (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count
      FROM restaurants r
      WHERE r.status='approved'
    `);
    return res.json(results);
  } catch (err) {
    console.error("Error fetching restaurants:", err.message);
    // Graceful fallback (no SQL fragments)
    try {
      const fallback = await fetchFallbackRestaurantCards(20);

      // Server-side search endpoint: search menu items and include restaurant metadata
      app.get('/api/search', async (req, res) => {
        try {
          const q = (req.query.q || '').trim();
          if (!q) return res.json({ results: [], total: 0 });

          // pagination support
          const limit = Math.min(100, parseInt(req.query.limit) || 50);
          const offset = Math.max(0, parseInt(req.query.offset) || 0);

          // Use case-insensitive search by lowering input and comparing with LOWER(...) in query
          const like = `%${q.toLowerCase()}%`;

          const sql = `
            SELECT m.id as menu_id, m.item_name, m.description, m.price, m.image_url as item_image,
                   r.id as restaurant_id, r.name as restaurant_name, r.address as restaurant_address,
                   COALESCE(r.latitude, r.lat) as latitude, COALESCE(r.longitude, r.lng) as longitude,
                   r.image_url as restaurant_image, r.eta as restaurant_eta
            FROM menu m
            JOIN restaurants r ON m.restaurant_id = r.id
            WHERE LOWER(m.item_name) LIKE ?
               OR LOWER(m.category) LIKE ?
               OR LOWER(r.name) LIKE ?
            ORDER BY m.item_name ASC
            LIMIT ? OFFSET ?
          `;

          const [rows] = await db.execute(sql, [like, like, like, limit, offset]);

          // count total (simple count query)
          const countSql = `
            SELECT COUNT(*) as total
            FROM menu m
            JOIN restaurants r ON m.restaurant_id = r.id
            WHERE LOWER(m.item_name) LIKE ?
               OR LOWER(m.category) LIKE ?
               OR LOWER(r.name) LIKE ?
          `;
          const [countRows] = await db.execute(countSql, [like, like, like]);
          const total = (countRows && countRows[0] && countRows[0].total) || 0;

          res.json({ results: rows, total });
        } catch (err) {
          console.error('Search error:', err);
          res.status(500).json({ error: 'Search failed' });
        }
      });
      return res.json(fallback);
    } catch (fallbackErr) {
      console.error("Restaurants fallback failed:", fallbackErr.message);
    }
    return res.status(500).json({ error: "DB error" });
  }
});


// For admin to manage menu
app.get("/api/admin/menu", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT m.*, r.name AS restaurant_name
       FROM menu m
       JOIN restaurants r ON m.restaurant_id = r.id
       ORDER BY m.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching admin menu:", err);
    res.status(500).json({ error: "Failed to fetch admin menu" });
  }
});


// ✅ FIXED: Orders fetching now requires authMiddleware and handles roles correctly
app.get("/api/orders", authMiddleware, async (req, res) => {
  const { role, id, restaurant_id } = req.user || {};

  try {
    let query = "";
    let params = [];

    if (role === "delivery_agent") {
      query = "SELECT * FROM orders WHERE agent_id = ?";
      params = [id];
    } else if (role === "admin") {
      query = "SELECT * FROM orders";
    } else if (role === "restaurant") {
      // ✅ FIXED: use restaurant_id instead of user id
      query = "SELECT * FROM orders WHERE restaurant_id = ?";
      params = [restaurant_id];
    } else {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const [orders] = await db.execute(query, params);
    res.json(orders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});


// Fetch orders for a specific restaurant
app.get("/api/orders/restaurant/:restaurantId", async (req, res) => {
  const { restaurantId } = req.params;

  try {
    const query = "SELECT * FROM orders WHERE restaurant_id = ?";
    const [orders] = await db.execute(query, [restaurantId]);

    res.json(orders);
  } catch (error) {
    console.error("Error fetching restaurant orders:", error);
    res.status(500).json({ error: "Failed to fetch restaurant orders" });
  }
});
// ---- Fetch all menus for a restaurant ----
app.get("/api/restaurant/:id/menu", async (req, res) => {
  const restaurantId = req.params.id;

  try {
    const [rows] = await db.execute(
      "SELECT * FROM menu WHERE restaurant_id = ?",
      [restaurantId]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching menus:", err);
    res.status(500).json({ message: "Error fetching menu items" });
  }
});
// ✅ NEW ROUTE — Fetch menu by restaurant (matches restaurant.html frontend)
app.get("/api/menu/by-restaurant/:id", async (req, res) => {
  const restaurantId = req.params.id;

  try {
    const [rows] = await db.execute(
      "SELECT * FROM menu WHERE restaurant_id = ?",
      [restaurantId]
    );

    if (rows.length === 0) {
      return res.status(200).json([]); // return empty array if no dishes
    }

    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching menu by restaurant:", err);
    res.status(500).json({ message: "Error fetching menu items" });
  }
});

// ===== Menu management for restaurants (create, list own, delete) =====
app.post('/api/menu', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const user = req.user || {};
    if (user.role !== 'restaurant') return res.status(403).json({ error: 'Only restaurants can add menu items' });

    const restaurantId = user.restaurant_id;
    const { item_name, price, description, category } = req.body;
    const imageUrl = req.file ? req.file.filename : null;

    if (!item_name || !price) return res.status(400).json({ error: 'Missing item_name or price' });

    const [result] = await db.execute(
      'INSERT INTO menu (restaurant_id, item_name, description, price, category, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [restaurantId, item_name, description || '', Number(price) || 0, category || null, imageUrl]
    );

    res.json({ message: 'Dish added', id: result.insertId });
  } catch (err) {
    console.error('Error adding menu item:', err);
    res.status(500).json({ error: 'Failed to add menu item', details: err.message });
  }
});

// TEMP: Test endpoint (no auth) to debug menu inserts locally. Remove when done.
app.post('/api/menu/test-add', upload.single('image'), async (req, res) => {
  try {
    console.log('TEST_ADD request body keys:', Object.keys(req.body));
    console.log('TEST_ADD file:', req.file);
    const { item_name, price, description, category } = req.body;
    const imageUrl = req.file ? req.file.filename : null;
    if (!item_name || !price) return res.status(400).json({ error: 'Missing item_name or price' });
    // Use restaurant_id = 1 for local tests
    const restaurantId = 1;
    const [result] = await db.execute(
      'INSERT INTO menu (restaurant_id, item_name, description, price, category, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [restaurantId, item_name, description || '', Number(price) || 0, category || null, imageUrl]
    );
    console.log('TEST_ADD DB result:', result);
    res.json({ message: 'Test dish added', id: result.insertId });
  } catch (err) {
    console.error('TEST_ADD error:', err);
    res.status(500).json({ error: 'Test add failed', details: err.message });
  }
});

app.get('/api/menu/my', authMiddleware, async (req, res) => {
  try {
    const user = req.user || {};
    if (user.role !== 'restaurant') return res.status(403).json({ error: 'Only restaurants can view this' });
    const restaurantId = user.restaurant_id;
    const [rows] = await db.execute('SELECT * FROM menu WHERE restaurant_id = ? ORDER BY created_at DESC', [restaurantId]);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching my menu:', err);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

app.delete('/api/menu/:id', authMiddleware, async (req, res) => {
  try {
    const user = req.user || {};
    const menuId = req.params.id;
    // Only restaurant that owns the menu or admin can delete
    const [rows] = await db.execute('SELECT restaurant_id, image_url FROM menu WHERE id = ?', [menuId]);
    if (!rows.length) return res.status(404).json({ error: 'Menu item not found' });
    const ownerId = rows[0].restaurant_id;
    if (user.role !== 'admin' && user.restaurant_id !== ownerId) return res.status(403).json({ error: 'Not authorized' });

    await db.execute('DELETE FROM menu WHERE id = ?', [menuId]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Error deleting menu item:', err);
    res.status(500).json({ error: 'Failed to delete menu item' });
  }
});
// Root should serve the app homepage from 'frontend

// ====== Featured Restaurants ======
// ====== Homepage Popup Banners ======
// Public: get latest active banner (or all if ?all=true)
app.get("/api/banners", async (req, res) => {
  try {
    const wantAll = String(req.query.all || '').toLowerCase() === 'true';
    if (wantAll) {
      const [rows] = await db.execute("SELECT * FROM banners ORDER BY created_at DESC");
      return res.json(rows);
    }
    const [rows] = await db.execute("SELECT * FROM banners WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1");
    res.json(rows[0] || null);
  } catch (err) {
    console.error("Error fetching banners:", err);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});



// Admin: list all banners
app.get("/api/admin/banners", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM banners ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    console.error("Error listing banners:", err);
    res.status(500).json({ error: "Failed to list banners" });
  }
});

// Admin: delete a banner by id
app.delete("/api/admin/banners/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM banners WHERE id = ?", [id]);
    res.json({ message: "Banner removed" });
  } catch (err) {
    console.error("Error deleting banner:", err);
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

app.get("/api/featured-restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT fr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status,
             (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating,
             (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count
      FROM featured_restaurants fr 
      JOIN restaurants r ON fr.restaurant_id = r.id 
      ORDER BY fr.position ASC
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching featured restaurants:", err);
    try {
      const fallback = await fetchFallbackRestaurantCards();
      return res.json(fallback);
    } catch (fallbackErr) {
      console.error('Featured restaurants fallback failed:', fallbackErr.message);
    }
    res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

app.post("/api/featured-restaurants", async (req, res) => {
  try {
    const { restaurant_id, position } = req.body;
    
    // Check if restaurant exists
    const [restaurant] = await db.execute("SELECT id FROM restaurants WHERE id = ?", [restaurant_id]);
    if (!restaurant.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    
    // Check if restaurant is already in featured list
    const [existing] = await db.execute("SELECT id FROM featured_restaurants WHERE restaurant_id = ?", [restaurant_id]);
    if (existing.length) {
      return res.status(400).json({ error: "Restaurant already in featured list" });
    }
    
    await db.execute(
      "INSERT INTO featured_restaurants (restaurant_id, position, is_active) VALUES (?, ?, 1)",
      [restaurant_id, position]
    );
    res.json({ message: "Featured restaurant added" });
  } catch (err) {
    console.error("Error adding featured restaurant:", err);
    res.status(500).json({ error: "Failed to add featured restaurant" });
  }
});

// For testing: remove a restaurant from featured
app.delete("/api/featured-restaurants/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM featured_restaurants WHERE id = ?", [id]);
    res.json({ message: "Removed from featured restaurants" });
  } catch (err) {
    console.error("Error removing featured restaurant:", err);
    res.status(500).json({ error: "Failed to remove featured restaurant" });
  }
});

// For testing: clear all featured restaurants
app.delete("/api/featured-restaurants", async (req, res) => {
  try {
    await db.execute("DELETE FROM featured_restaurants");
    res.json({ message: "All featured restaurants removed" });
  } catch (err) {
    console.error("Error clearing featured restaurants:", err);
    res.status(500).json({ error: "Failed to clear featured restaurants" });
  }
});

app.put("/api/featured-restaurants/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const [current] = await db.execute("SELECT is_active FROM featured_restaurants WHERE id = ?", [id]);
    if (!current.length) {
      return res.status(404).json({ error: "Featured restaurant not found" });
    }
    
    const newStatus = !current[0].is_active;
    await db.execute("UPDATE featured_restaurants SET is_active = ? WHERE id = ?", [newStatus, id]);
    res.json({ message: `Featured restaurant ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (err) {
    console.error("Error toggling featured restaurant:", err);
    res.status(500).json({ error: "Failed to toggle featured restaurant" });
  }
});

// --- Admin aliases for Featured Restaurants ---
app.get("/api/admin/featured-restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT fr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status
      FROM featured_restaurants fr 
      JOIN restaurants r ON fr.restaurant_id = r.id 
      ORDER BY fr.position ASC
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching featured restaurants (admin):", err);
    res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});
app.post("/api/admin/featured-restaurants", async (req, res) => {
  try {
    const { restaurant_id, position } = req.body;
    const [restaurant] = await db.execute("SELECT id FROM restaurants WHERE id = ?", [restaurant_id]);
    if (!restaurant.length) return res.status(404).json({ error: "Restaurant not found" });
    const [existing] = await db.execute("SELECT id FROM featured_restaurants WHERE restaurant_id = ?", [restaurant_id]);
    if (existing.length) return res.status(400).json({ error: "Restaurant already in featured list" });
    await db.execute("INSERT INTO featured_restaurants (restaurant_id, position, is_active) VALUES (?, ?, 1)", [restaurant_id, position]);
    res.json({ message: "Featured restaurant added" });
  } catch (err) {
    console.error("Error adding featured restaurant (admin):", err);
    res.status(500).json({ error: "Failed to add featured restaurant" });
  }
});
app.put("/api/admin/featured-restaurants/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const [current] = await db.execute("SELECT is_active FROM featured_restaurants WHERE id = ?", [id]);
    if (!current.length) return res.status(404).json({ error: "Featured restaurant not found" });
    const newStatus = !current[0].is_active;
    await db.execute("UPDATE featured_restaurants SET is_active = ? WHERE id = ?", [newStatus, id]);
    res.json({ message: `Featured restaurant ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (err) {
    console.error("Error toggling featured restaurant (admin):", err);
    res.status(500).json({ error: "Failed to toggle featured restaurant" });
  
  }
});

app.delete("/api/admin/featured-restaurants/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM featured_restaurants WHERE id = ?", [id]);
    res.json({ message: "Removed from featured restaurants" });
  } catch (err) {
    console.error("Error removing featured restaurant (admin):", err);
    res.status(500).json({ error: "Failed to remove featured restaurant" });
  }
});

// ====== Top Restaurants ======
app.get("/api/top-restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT tr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status,
             (SELECT ROUND(AVG(rv.rating),1) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS avg_rating,
             (SELECT COUNT(*) FROM restaurant_reviews rv WHERE rv.restaurant_id = r.id) AS rating_count
      FROM top_restaurants tr 
      JOIN restaurants r ON tr.restaurant_id = r.id 
      ORDER BY tr.position ASC
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching top restaurants:", err);
    try {
      const fallback = await fetchFallbackRestaurantCards();
      return res.json(fallback);
    } catch (fallbackErr) {
      console.error('Top restaurants fallback failed:', fallbackErr.message);
    }
    res.status(500).json({ error: "Failed to fetch top restaurants" });
  }
});

// --- Admin aliases for Top Restaurants ---
app.get("/api/admin/top-restaurants", async (req, res) => {
  try {
    const [results] = await db.execute(`
      SELECT tr.*, r.name, r.cuisine, r.image_url AS image_url, r.status as restaurant_status
      FROM top_restaurants tr 
      JOIN restaurants r ON tr.restaurant_id = r.id 
      ORDER BY tr.position ASC
    `);
    res.json(results);
  } catch (err) {
    console.error("Error fetching top restaurants (admin):", err);
    res.status(500).json({ error: "Failed to fetch top restaurants" });
  }
});
app.post("/api/admin/top-restaurants", async (req, res) => {
  try {
    const { restaurant_id, position } = req.body;
    const [restaurant] = await db.execute("SELECT id FROM restaurants WHERE id = ?", [restaurant_id]);
    if (!restaurant.length) return res.status(404).json({ error: "Restaurant not found" });
    const [existing] = await db.execute("SELECT id FROM top_restaurants WHERE restaurant_id = ?", [restaurant_id]);
    if (existing.length) return res.status(400).json({ error: "Restaurant already in top list" });
    await db.execute("INSERT INTO top_restaurants (restaurant_id, position, is_active) VALUES (?, ?, 1)", [restaurant_id, position]);
    res.json({ message: "Top restaurant added" });
  } catch (err) {
    console.error("Error adding top restaurant (admin):", err);
    res.status(500).json({ error: "Failed to add top restaurant" });
  }
});
app.put("/api/admin/top-restaurants/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const [current] = await db.execute("SELECT is_active FROM top_restaurants WHERE id = ?", [id]);
    if (!current.length) return res.status(404).json({ error: "Top restaurant not found" });
    const newStatus = !current[0].is_active;
    await db.execute("UPDATE top_restaurants SET is_active = ? WHERE id = ?", [newStatus, id]);
    res.json({ message: `Top restaurant ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (err) {
    console.error("Error toggling top restaurant (admin):", err);
    res.status(500).json({ error: "Failed to toggle top restaurant" });
  }
});
app.delete("/api/admin/top-restaurants/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM top_restaurants WHERE id = ?", [id]);
    res.json({ message: "Removed from top restaurants" });
  } catch (err) {
    console.error("Error removing top restaurant (admin):", err);
    res.status(500).json({ error: "Failed to remove top restaurant" });
  }
});

app.post("/api/top-restaurants", async (req, res) => {
  try {
    const { restaurant_id, position } = req.body;
    
    // Check if restaurant exists
    const [restaurant] = await db.execute("SELECT id FROM restaurants WHERE id = ?", [restaurant_id]);
    if (!restaurant.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    
    // Check if restaurant is already in top list
    const [existing] = await db.execute("SELECT id FROM top_restaurants WHERE restaurant_id = ?", [restaurant_id]);
    if (existing.length) {
      return res.status(400).json({ error: "Restaurant already in top list" });
    }
    
    await db.execute(
      "INSERT INTO top_restaurants (restaurant_id, position, is_active) VALUES (?, ?, 1)",
      [restaurant_id, position]
    );
    res.json({ message: "Top restaurant added" });
  } catch (err) {
    console.error("Error adding top restaurant:", err);
    res.status(500).json({ error: "Failed to add top restaurant" });
  }
});

app.put("/api/top-restaurants/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const [current] = await db.execute("SELECT is_active FROM top_restaurants WHERE id = ?", [id]);
    if (!current.length) {
      return res.status(404).json({ error: "Top restaurant not found" });
    }
    
    const newStatus = !current[0].is_active;
    await db.execute("UPDATE top_restaurants SET is_active = ? WHERE id = ?", [newStatus, id]);
    res.json({ message: `Top restaurant ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (err) {
    console.error("Error toggling top restaurant:", err);
    res.status(500).json({ error: "Failed to toggle top restaurant" });
  }
});

app.delete("/api/top-restaurants/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM top_restaurants WHERE id = ?", [id]);
    res.json({ message: "Removed from top restaurants" });
  } catch (err) {
    console.error("Error removing top restaurant:", err);
    res.status(500).json({ error: "Failed to remove top restaurant" });
  }
});

// ====== Reviews APIs ======
// Submit a review for an order
app.post('/api/orders/:orderId/review', async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const { rating, comment } = req.body || {};
    if (!orderId || !Number.isFinite(Number(rating)) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Invalid orderId or rating' });
    }
    // Get order to infer restaurant_id and user_id
    const [orders] = await db.execute('SELECT id, user_id, restaurant_id, status FROM orders WHERE id = ? LIMIT 1', [orderId]);
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });
    const ord = orders[0];
    // Enforce one review per order
  const [exists] = await db.execute('SELECT id FROM restaurant_reviews WHERE order_id = ? LIMIT 1', [orderId]);
    if (exists.length) return res.status(409).json({ error: 'Review already submitted for this order' });
    await db.execute(
  'INSERT INTO restaurant_reviews (order_id, user_id, restaurant_id, rating, comment) VALUES (?,?,?,?,?)',
      [orderId, ord.user_id || null, ord.restaurant_id, Math.round(rating), comment || null]
    );
    res.json({ message: 'Thanks for your review!' });
  } catch (err) {
    console.error('Review submit error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// Get rating summary for a restaurant
app.get('/api/restaurants/:id/reviews/summary', async (req, res) => {
  try {
    const rid = Number(req.params.id);
    const [[row]] = await db.execute(
  'SELECT ROUND(AVG(rating),1) AS avg, COUNT(*) AS count FROM restaurant_reviews WHERE restaurant_id = ?',
      [rid]
    );
    res.json({ avg: row?.avg || null, count: row?.count || 0 });
  } catch (err) {
    console.error('Review summary error:', err);
    res.status(500).json({ error: 'Failed to fetch review summary' });
  }
});

// ===== Admin: Orders and Delivery =====
// Get all orders (admin overview)
app.get("/api/admin/orders", async (req, res) => {
  try {
    const [orders] = await db.execute("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(orders);
  } catch (err) {
    console.error("Error fetching all orders:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Alias used by stats widget on admin dashboard
app.get("/api/orders/all", async (req, res) => {
  try {
    const [orders] = await db.execute("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(orders);
  } catch (err) {
    console.error("Error fetching all orders (alias):", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Assign an agent (placeholder)
app.post("/api/admin/orders/:orderId/assign", async (req, res) => {
  const { orderId } = req.params;
  try {
    const ASSIGN_MAX_KM = Number(process.env.ASSIGN_MAX_KM) || 10;
    const ASSIGN_LOAD_STATUSES = (process.env.ASSIGN_LOAD_STATUSES || 'Pending,Confirmed,Picked')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    // Fetch order including restaurant_id
    const [orderRows] = await db.execute("SELECT id, restaurant_id FROM orders WHERE id = ?", [orderId]);
    if (!orderRows.length) {
      return res.status(404).json({ error: "Order not found" });
    }
    const { restaurant_id } = orderRows[0];
    if (!restaurant_id) {
      return res.status(400).json({ error: "Order missing restaurant reference" });
    }

    // Fetch restaurant coordinates
    const [restRows] = await db.execute("SELECT latitude, longitude FROM restaurants WHERE id = ?", [restaurant_id]);
    if (!restRows.length || restRows[0].latitude == null || restRows[0].longitude == null) {
      return res.status(400).json({ error: "Restaurant location unavailable" });
    }
    const rlat = Number(restRows[0].latitude);
    const rlng = Number(restRows[0].longitude);

    // Fetch active agents with coordinates
    const [agents] = await db.execute(
      "SELECT id, lat, lng FROM agents WHERE status = 'Active' AND lat IS NOT NULL AND lng IS NOT NULL"
    );
    if (!agents.length) {
      return res.status(400).json({ error: "No active agents with location available" });
    }

    // Load workload
    let loadMap = new Map();
    try {
      const placeholders = ASSIGN_LOAD_STATUSES.map(() => '?').join(',');
      const [loads] = await db.execute(
        `SELECT agent_id, COUNT(*) AS cnt FROM orders WHERE status IN (${placeholders}) AND agent_id IS NOT NULL GROUP BY agent_id`,
        ASSIGN_LOAD_STATUSES
      );
      loads.forEach(r => loadMap.set(r.agent_id, Number(r.cnt)));
    } catch (_) {}

    // Haversine distance calculation
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371; // km
    const dist = (aLat, aLng, bLat, bLng) => {
      const dLat = toRad(bLat - aLat);
      const dLng = toRad(bLng - aLng);
      const sa =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
      return R * c;
    };

    // Build candidates with distance and load, filter within configured radius
    let candidates = agents.map(a => ({
      id: a.id,
      d: dist(rlat, rlng, Number(a.lat), Number(a.lng)),
      load: loadMap.get(a.id) ?? 0
    }));
    candidates = candidates.filter(c => c.d <= ASSIGN_MAX_KM);
    if (!candidates.length) {
      return res.status(400).json({ error: `No active agents within ${ASSIGN_MAX_KM} km` });
    }
  candidates.sort((a,b)=> a.load - b.load || a.d - b.d);
  const best = candidates[0];
  const agentId = best.id;
    await db.execute(
      "UPDATE orders SET agent_id = ?, status = 'Confirmed' WHERE id = ?",
      [agentId, orderId]
    );

  res.json({ message: "Agent assigned (nearest)", agent_id: agentId, distance_km: Number(best.d.toFixed(2)) });
  } catch (err) {
    console.error("Error assigning agent:", err);
    res.status(500).json({ error: "Failed to assign agent", details: err.message });
  }
});

// List delivery agents
app.get("/api/admin/delivery", async (req, res) => {
  try {
    const showAll = String(req.query.all || '').toLowerCase() === 'true';
    const where = showAll ? '' : "WHERE a.status = 'Active'";
    const [rows] = await db.execute(
      `SELECT a.id, a.name, a.phone, a.status, a.lat, a.lng, u.email
       FROM agents a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching delivery agents:", err);
    res.status(500).json({ error: "Failed to fetch delivery agents" });
  }
});

// ====== USERS ======
// Register new user (customer or restaurant)
app.post("/api/users", async (req, res) => {
  try {
    const { name, email, password, role, restaurant_id } = req.body;
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const status = role === "restaurant" ? "pending" : "active";

    const [result] = await db.execute(
      "INSERT INTO users (name, email, password, role, status, restaurant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [name, email, hashedPassword, role, status, restaurant_id || null]
    );

    // For restaurant owners, also insert into restaurants table (status: pending)
    if (role === "restaurant") {
      await db.execute(
        "INSERT INTO restaurants (name, status, created_at) VALUES (?, 'pending', NOW())",
        [name]
      );
    }

    res.json({ message: "User registered", id: result.insertId });
  } catch (err) {
    console.error("Error registering user:", err);
    res.status(500).json({ error: "Failed to register user" });
  }
});

// Login user
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.execute("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = users[0];
    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Exclude password from response
    const { password: _, ...userInfo } = user;
    res.json(userInfo);
  } catch (err) {
    console.error("Error logging in:", err);
    res.status(500).json({ error: "Failed to log in" });
  }
});

// Get user profile (public)
app.get("/api/users/profile", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    const [users] = await db.execute("SELECT id, name, email, role, status FROM users WHERE id = ?", [userId]);
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(users[0]);
  } catch (err) {
    console.error('Error fetching user profile:', err);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Update user profile
app.put("/api/users/profile", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { name, email, password } = req.body;

  try {
    // Hash password if provided
    let hashedPassword;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    await db.execute(
      "UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?",
      [name, email, hashedPassword, userId]
    );

    res.json({ message: "Profile updated" });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// For admin: get all users (with pagination)
app.get("/api/admin/users", authMiddleware, async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  try {
    const [results] = await db.execute("SELECT * FROM users LIMIT ?, ?", [
      offset,
      limit,
    ]);
    res.json(results);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Get total users count (for admin stats)
app.get("/api/admin/users/count", authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT COUNT(*) AS count FROM users");
    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    console.error("Error fetching users count:", err);
    res.status(500).json({ error: "Failed to fetch users count" });
  }
});

// Get total restaurants count (for admin stats)
app.get("/api/admin/restaurants/count", authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT COUNT(*) AS count FROM restaurants");
    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    console.error("Error fetching restaurants count:", err);
    res.status(500).json({ error: "Failed to fetch restaurants count" });
  }
});

// Get total orders count (for admin stats)
app.get("/api/admin/orders/count", authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT COUNT(*) AS count FROM orders");
    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    console.error("Error fetching orders count:", err);
    res.status(500).json({ error: "Failed to fetch orders count" });
  }
});

// For admin: update user role or status
app.put("/api/admin/users/:id", authMiddleware, async (req, res) => {
  const userId = req.params.id;
  const { role, status } = req.body;

  try {
    await db.execute(
      "UPDATE users SET role = ?, status = ? WHERE id = ?",
      [role, status, userId]
    );
    res.json({ message: "User updated" });
  } catch (err) {
    console.error("Error updating user:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// For admin: delete a user
app.delete("/api/admin/users/:id", authMiddleware, async (req, res) => {
  const userId = req.params.id;

  try {
    await db.execute("DELETE FROM users WHERE id = ?", [userId]);
    res.json({ message: "User deleted" });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ====== Realtime: Delivery agent live locations via Socket.IO ======
// Track latest agent locations in-memory
// Alias for compatibility with some client snippets referring to `agents`

io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);

  // Agent sends live location
  socket.on("agentLocation", (data) => {
    try {
      const { agentId, lat, lng } = data || {};
      if (!agentId || typeof lat !== "number" || typeof lng !== "number") return;
      // Defensive: ensure in-memory caches exist even if globals were cleared/reloaded
      if (!global.deliveryAgents) global.deliveryAgents = {};
      if (!global.agents) global.agents = {};
      global.deliveryAgents[agentId] = { lat, lng };
      global.agents[agentId] = { lat, lng };
      // Mirror local references if they were defined at top-level
      try { deliveryAgents[agentId] = { lat, lng }; } catch(_) {}
      try { agents[agentId] = { lat, lng }; } catch(_) {}
      // Broadcast to all clients (users + admins + other agents)
      const payload = { agentId, lat, lng };
      io.emit("locationUpdate", payload);
      // Backward-compatible event echo
      io.emit("agentLocation", payload);
    } catch (e) {
      console.error("agentLocation handler error:", e.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Socket disconnected:", socket.id);
  });
});

// ✅ Catch-all route (Express 5 safe): serve SPA index for any unmatched request
// Static middleware above will handle real files first; this ensures client-side routing works.
// ========== ADMIN DASHBOARD ROUTES ==========
// ✅ Featured restaurants (admin view)
app.get("/api/admin/featured-restaurants", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        r.id,
        r.name,
        r.cuisine,
        r.image_url,
        (SELECT ROUND(AVG(rr.rating),1) FROM restaurant_reviews rr WHERE rr.restaurant_id = r.id) AS rating,
        EXISTS(SELECT 1 FROM featured_restaurants fr WHERE fr.restaurant_id = r.id) AS is_featured
      FROM restaurants r
      WHERE r.status = 'approved'
      ORDER BY r.created_at DESC
      LIMIT 8
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching featured restaurants:", err.message);
    res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

// ✅ Top restaurants (highest rated)
app.get("/api/admin/top-restaurants", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        r.id,
        r.name,
        r.cuisine,
        r.image_url,
        (SELECT ROUND(AVG(rr.rating),1) FROM restaurant_reviews rr WHERE rr.restaurant_id = r.id) AS avg_rating
      FROM restaurants r
      WHERE r.status = 'approved'
      ORDER BY avg_rating DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching top restaurants:", err.message);
    res.status(500).json({ error: "Failed to fetch top restaurants" });
  }
});

// ✅ Dashboard stats
app.get("/api/admin/stats", async (req, res) => {
  try {
    const [[users]] = await db.execute(`SELECT COUNT(*) AS total_users FROM users`);
    const [[restaurants]] = await db.execute(`SELECT COUNT(*) AS total_restaurants FROM restaurants`);
    const [[orders]] = await db.execute(`SELECT COUNT(*) AS total_orders FROM orders`);

    res.json({
      users: users.total_users,
      restaurants: restaurants.total_restaurants,
      orders: orders.total_orders,
    });
  } catch (err) {
    console.error("Error loading admin stats:", err.message);
    res.status(500).json({ error: "Failed to load dashboard stats" });
  }
});
// ===================== ADMIN DASHBOARD ROUTES =====================

// Featured Restaurants
app.get("/api/admin/featured-restaurants", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT id, name, cuisine, image_url, rating
      FROM restaurants
      WHERE status = 'approved'
      ORDER BY created_at DESC
      LIMIT 6
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching featured restaurants:", err.message);
    res.status(500).json({ error: "Failed to fetch featured restaurants" });
  }
});

// Top Restaurants
app.get("/api/admin/top-restaurants", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT r.id, r.name, r.cuisine, r.image_url,
             ROUND(AVG(rv.rating),1) AS avg_rating,
             COUNT(rv.id) AS rating_count
      FROM restaurants r
      LEFT JOIN reviews rv ON rv.restaurant_id = r.id
      WHERE r.status = 'approved'
      GROUP BY r.id
      ORDER BY avg_rating DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching top restaurants:", err.message);
    res.status(500).json({ error: "Failed to fetch top restaurants" });
  }
});

// Dashboard Stats
app.get("/api/admin/stats", async (req, res) => {
  try {
    const [[userCount]] = await db.execute("SELECT COUNT(*) AS total_users FROM users");
    const [[restCount]] = await db.execute("SELECT COUNT(*) AS total_restaurants FROM restaurants");
    const [[orderCount]] = await db.execute("SELECT COUNT(*) AS total_orders FROM orders");

    res.json({
      users: userCount.total_users,
      restaurants: restCount.total_restaurants,
      orders: orderCount.total_orders
    });
  } catch (err) {
    console.error("Error fetching dashboard stats:", err.message);
    res.status(500).json({ error: "Failed to load admin stats" });
  }
});


// Global error handler: catch PathError and other unexpected errors
app.use((err, req, res, next) => {
  try {
    if (!err) return next();
    // Known path/parameter errors -> 400 Bad Request
    if (err.name === 'PathError' || err instanceof Error && err.name === 'PathError') {
      console.warn('PathError handled:', err.message);
      return res.status(400).json({ error: err.message });
    }
    // For other errors, log and return generic 500 (include message in dev)
    console.error('Unhandled error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error' });
  } catch (handlerErr) {
    console.error('Error in error-handler:', handlerErr);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ Serve frontend build (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '../frontend')));

// ✅ SPA fallback route (handles all unknown frontend routes safely)
// Use a RegExp path to avoid the path-to-regexp '*' parsing error in newer versions

// ===== Convenience endpoint: get restaurants with coordinates =====
// Returns id, name, latitude, longitude (aliases for lat/lng) for admin map loaders
app.get('/api/get-restaurants', authMiddleware, async (req, res) => {
  try {
    // Only admins may fetch all restaurants for the admin map
    const user = req.user || {};
    if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    // Use COALESCE to support both lat/lng or latitude/longitude column names
    const [rows] = await db.execute(`
      SELECT 
        id, 
        name, 
        COALESCE(lat, latitude) AS latitude, 
        COALESCE(lng, longitude) AS longitude
      FROM restaurants
      ORDER BY id ASC
    `);

    return res.json(
      rows.map(r => ({
        id: r.id,
        name: r.name,
        latitude: r.latitude == null ? null : Number(r.latitude),
        longitude: r.longitude == null ? null : Number(r.longitude)
      }))
    );
  } catch (err) {
    console.error('Error fetching restaurants for map:', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});



// ===== Update restaurant location =====
app.post('/api/update-restaurant-location', authMiddleware, async (req, res) => {
  try {
    const { restaurant_id, latitude, longitude } = req.body || {};
    if (!restaurant_id || typeof latitude === 'undefined' || typeof longitude === 'undefined') {
      return res.status(400).json({ message: 'Missing data' });
    }

    // Authorization: admins can update any restaurant; restaurant users can only update their own
    const user = req.user || {};
    if (user.role !== 'admin') {
      if (user.role !== 'restaurant' || Number(user.restaurant_id) !== Number(restaurant_id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    // Use latitude/longitude column names in DB
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: 'Invalid latitude or longitude' });
    }

    await db.execute(
      `UPDATE restaurants SET latitude = ?, longitude = ? WHERE id = ?`,
      [lat, lng, restaurant_id]
    );

    return res.json({ message: 'Restaurant location updated successfully' });
  } catch (err) {
    console.error('Error updating location:', err?.message || err);
    return res.status(500).json({ message: 'Database error', details: err?.message || String(err) });
  }
});

app.all(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});
app.get('/api/agent-route/:agentId', authMiddleware, async (req, res) => {
  try {
    const { agentId } = req.params;

    // Fetch agent info
    const [agentRows] = await db.query(
      'SELECT latitude AS agent_lat, longitude AS agent_lng, current_order_id FROM delivery_agents WHERE id = ?',
      [agentId]
    );
    if (!agentRows.length) return res.status(404).json({ error: 'Agent not found' });
    const { agent_lat, agent_lng, current_order_id } = agentRows[0];

    if (!current_order_id)
      return res.status(404).json({ error: 'No active order assigned' });

    // Fetch order info
    const [orderRows] = await db.query(
      'SELECT restaurant_id, delivery_lat, delivery_lng FROM orders WHERE id = ?',
      [current_order_id]
    );
    if (!orderRows.length) return res.status(404).json({ error: 'Order not found' });
    const { restaurant_id, delivery_lat, delivery_lng } = orderRows[0];

    // Fetch restaurant info
    const [restRows] = await db.query(
      'SELECT latitude AS rest_lat, longitude AS rest_lng FROM restaurants WHERE id = ?',
      [restaurant_id]
    );
    if (!restRows.length) return res.status(404).json({ error: 'Restaurant not found' });
    const { rest_lat, rest_lng } = restRows[0];

    // Return full route info
    return res.json({
      agent: { lat: Number(agent_lat), lng: Number(agent_lng) },
      restaurant: { lat: Number(rest_lat), lng: Number(rest_lng) },
      user: { lat: Number(delivery_lat), lng: Number(delivery_lng) },
      order_id: current_order_id
    });
  } catch (err) {
    console.error('Agent route error:', err);
    res.status(500).json({ error: 'Failed to fetch route details' });
  }
});
app.get('/api/delivery/:agentId/orders', async (req, res) => {
  try {
    const { agentId } = req.params;
    const [orders] = await db.query(`
      SELECT o.id, o.restaurant_id, o.delivery_lat, o.delivery_lng, o.status,
             u.phone AS customer_phone, u.name AS customer_name
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.agent_id = ?
      ORDER BY o.id DESC
    `, [agentId]);
    res.json(orders);
  } catch (err) {
    console.error('Fetch delivery orders failed:', err);
    res.status(500).json({ error: 'Failed to fetch delivery orders' });
  }
});
// NOTE: Removed stray frontend/browser code that referenced `socket`, `window`, and
// functions like `updateMap`/`drawDeliveryRoute`. Those are client-side and
// must not be present in the server bundle. If you need server-side socket
// handlers, wire them using the `io` object created around the HTTP server.
app.get('/api/restaurants', async (req, res) => {
  const [rows] = await db.execute(`
    SELECT id, name, 
           COALESCE(latitude, lat) AS lat, 
           COALESCE(longitude, lng) AS lng
    FROM restaurants
  `);
  res.json(rows);
});

// ====== DELIVERY AGENT LIVE LOCATION ======

let deliveryAgents = {}; // Temporary store { agentId: { lat, lng, updatedAt } }

// REST API: Save agent location from delivery-dashboard
app.post("/api/delivery/location", (req, res) => {
  const { agent_id, lat, lng } = req.body;
  if (!agent_id || !lat || !lng)
    return res.status(400).json({ error: "Missing agent_id, lat or lng" });

  deliveryAgents[agent_id] = { lat, lng, updatedAt: Date.now() };

  // Broadcast live location via Socket.IO
  io.emit("agentLocation", { agentId: agent_id, lat, lng });
  console.log(`📍 Live location updated for Agent ${agent_id}: ${lat}, ${lng}`);

  res.json({ success: true });
});

// REST API: Get all active agents (for dashboard tracking)
app.get("/api/delivery/active", (req, res) => {
  const active = Object.entries(deliveryAgents).map(([id, v]) => ({
    agent_id: id,
    lat: v.lat,
    lng: v.lng,
    updatedAt: v.updatedAt,
  }));
  res.json(active);
});

// SOCKET.IO: Listen for agent location and re-broadcast
io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  socket.on("agentLocation", (data) => {
    const { agentId, lat, lng } = data;
    deliveryAgents[agentId] = { lat, lng, updatedAt: Date.now() };
    io.emit("locationUpdate", { agentId, lat, lng });
    console.log(`📡 Agent ${agentId} broadcast => ${lat}, ${lng}`);
  });

  socket.on("disconnect", () =>
    console.log("🔴 Client disconnected:", socket.id)
  );
});

// ✅ Live location socket bridge
io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);

  socket.on("agentLocation", (data) => {
    const { agentId, lat, lng } = data;
    if (!agentId || !lat || !lng) return;
    console.log(`📍 Agent ${agentId}: ${lat}, ${lng}`);

    // Re-broadcast to all connected clients (for live tracking)
    io.emit("locationUpdate", { agentId, lat, lng });
  });

  socket.on("disconnect", () =>
    console.log("🔴 Socket disconnected:", socket.id)
  );
});
let agentLocations = {};

app.post("/api/delivery/location", (req, res) => {
  const { agent_id, lat, lng } = req.body;
  agentLocations[agent_id] = { lat, lng, updatedAt: Date.now() };
  io.emit("locationUpdate", { agentId: agent_id, lat, lng });
  res.json({ success: true });
});

// Note: PathError-aware handler is registered earlier; no additional generic handler needed here.

// ✅ Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Tindo backend running successfully on port ${PORT}`);
  console.log(`📦 Serving frontend from ../frontend`);
  console.log(`🖼️  Uploads available at /uploads`);
});
