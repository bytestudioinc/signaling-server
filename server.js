require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase Client for DB cross-reference
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Telegram Bot for queue alerts
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_COOLDOWN_MS = 45_000; // 45 seconds
let lastTelegramSent = 0;

let supabase = null;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log("✅ Supabase service client initialized on socket server.");
} else {
  console.warn("⚠️ Supabase URL or Service Role Key missing. Database validation skipped.");
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware for JWT Authentication & Device Ownership verification
io.use(async (socket, next) => {
  const deviceId = socket.handshake.query.deviceId || socket.handshake.auth.deviceId;
  const token = socket.handshake.auth.token;

  if (!deviceId) {
    return next(new Error("Authentication error: Device ID missing"));
  }

  // Admin/Bypass token check for testing and development
  if (token === "admin_bypass" || token === "bypass_admin_secret" || token === "bypass") {
    console.log(`🔑 Admin bypass connection allowed for device: ${deviceId}`);
    socket.authId = "admin_auth_id";
    return next();
  }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET;

  // Skip JWT verification if neither database client nor local secret is set (dev fallback)
  if (!supabase && !jwtSecret) {
    console.warn("⚠️ Neither Supabase URL/Service Key nor SUPABASE_JWT_SECRET is configured. JWT verification skipped.");
    return next();
  }

  if (jwtSecret && jwtSecret.trim().startsWith("eyJ")) {
    console.error("❌ CRITICAL CONFIG ERROR: Your SUPABASE_JWT_SECRET environment variable seems to be set to a JWT token (like the Anon Key or Service Role Key) instead of the actual raw JWT Secret from the Supabase Settings API tab.");
  }

  if (!token) {
    console.log(`❌ Auth rejection: Missing token for device ${deviceId}`);
    return next(new Error("Authentication error: JWT token missing"));
  }

  try {
    // Decode token for diagnostic logging
    const parsed = jwt.decode(token, { complete: true });
    if (parsed) {
      console.log(`ℹ️ [Auth Debug] Device ${deviceId} sent token. Alg: ${parsed.header?.alg}, Sub/User ID: ${parsed.payload?.sub}, Role: ${parsed.payload?.role}`);
    } else {
      console.warn(`⚠️ [Auth Debug] Device ${deviceId} sent a completely unparseable token string.`);
    }

    let authId = null;

    if (supabase) {
      // 1. Verify token securely using Supabase auth service (supports ES256, HS256, etc.)
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        console.log(`❌ Auth rejection: Supabase getUser validation failed for device ${deviceId}:`, authError?.message);
        return next(new Error("Authentication error: Invalid or expired token"));
      }
      authId = user.id;
    } else {
      // Fallback: Verify JWT signature & expiration locally (only supports HS256 symmetric signing)
      const decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
      authId = decoded.sub;
    }

    // 2. DB ownership check
    if (supabase) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", deviceId)
        .eq("auth_id", authId)
        .maybeSingle();

      if (error || !data) {
        console.log(`❌ Auth rejection: Device ownership mismatch for device: ${deviceId}, authId: ${authId}`);
        return next(new Error("Authentication error: Device ownership mismatch"));
      }
    }

    // Attach verified properties to socket
    socket.authId = authId;
    next();
  } catch (err) {
    console.log(`❌ JWT verification failed for device ${deviceId}:`, err.message);
    return next(new Error("Authentication error: Invalid or expired token"));
  }
});

// Health check for Render
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const PORT = parseInt(process.env.PORT, 10) || 10000;

console.log("🚀 Starting Optimized Bucket-Based Socket.IO Server...");

// ---------------- State Management ----------------
// Buckets: M_F, M_M, M_A, F_M, F_F, F_A
const buckets = {
  M_F: new Set(), // Males seeking Females
  M_M: new Set(), // Males seeking Males
  M_A: new Set(), // Males seeking Any
  F_M: new Set(), // Females seeking Males
  F_F: new Set(), // Females seeking Females
  F_A: new Set()  // Females seeking Any
};

const userRegistry = new Map();   // deviceId -> { userData, timeout, currentBucket, roomId, isOnline }
const rooms = new Map();          // roomId -> { members: [deviceId1, deviceId2], cleanupTimer }
const socketToDevice = new Map(); // socketId -> deviceId
const deviceToSocket = new Map(); // deviceId -> socketId

const DISCONNECT_GRACE_PERIOD = 60000; // 60 seconds (1 minute)

// ---------------- Helper Functions ----------------
const timeoutMessages = {
  paid: [
    "Oops, your match is busy. Try again!",
    "Someone's chatting, but you'll get your turn. Try again!",
    "Patience, young grasshopper, the match awaits. Try again!",
    "Love is in the air… just not for you yet. Try again!"
  ],
  free: [
    "Everyone's chatting. Hang tight, try again!",
    "No freebirds available. Retry shortly!",
    "All ears busy right now. Try again!",
    "The chatroom is packed! Try again!"
  ]
};

function getRandomMessage(type) {
  const messages = timeoutMessages[type];
  return messages[Math.floor(Math.random() * messages.length)];
}

function getBucketKey(gender, preference) {
  if (!gender || !preference) return "M_A";
  const g = gender.toUpperCase().charAt(0);
  const p = preference.toUpperCase().charAt(0);
  return `${g}_${p}`;
}

function removeFromAllBuckets(deviceId) {
  const user = userRegistry.get(deviceId);
  if (user && user.currentBucket) {
    buckets[user.currentBucket].delete(deviceId);
    user.currentBucket = null;
  }
}

/**
 * Sends a rate-limited Telegram alert with queue summary stats.
 * Fire-and-forget — never blocks the socket response.
 */
function sendTelegramQueueAlert() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const now = Date.now();
  if (now - lastTelegramSent < TELEGRAM_COOLDOWN_MS) return;
  lastTelegramSent = now;

  // Collect all waiting users from all buckets
  let totalWaiting = 0;
  let maleCount = 0;
  let femaleCount = 0;
  const prefCounts = { any: 0, male: 0, female: 0 };

  for (const [key, bucket] of Object.entries(buckets)) {
    const count = bucket.size;
    totalWaiting += count;
    if (key.startsWith("M")) maleCount += count;
    else if (key.startsWith("F")) femaleCount += count;

    const prefChar = key.split("_")[1];
    if (prefChar === "A") prefCounts.any += count;
    else if (prefChar === "M") prefCounts.male += count;
    else if (prefChar === "F") prefCounts.female += count;
  }

  if (totalWaiting === 0) return; // no point alerting for empty queue

  const pct = (n) => totalWaiting ? Math.round((n / totalWaiting) * 100) : 0;

  const lines = [
    `🔔 Matchmaking Queue Alert`,
    ``,
    `👥 Users waiting: ${totalWaiting}`,
    ``,
    `⚧ Gender:`,
    `  Male: ${maleCount} (${pct(maleCount)}%)`,
    `  Female: ${femaleCount} (${pct(femaleCount)}%)`,
    ``,
    `🎯 Preference:`,
    `  Any: ${prefCounts.any} (${pct(prefCounts.any)}%)`,
    `  Male: ${prefCounts.male} (${pct(prefCounts.male)}%)`,
    `  Female: ${prefCounts.female} (${pct(prefCounts.female)}%)`,
    ``,
    `⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ];

  const text = lines.join("\n");

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_notification: false }),
  }).catch((err) => {
    console.error("⚠️ Telegram alert failed:", err.message);
  });
}

function findMatch(socket, userData, deviceId) {
  const { gender, preference } = userData;
  const myBucket = getBucketKey(gender, preference);
  
  let compatibleBuckets = [];
  
  // Compatibility Matrix
  if (myBucket === "M_F") compatibleBuckets = ["F_M", "F_A"];
  else if (myBucket === "M_M") compatibleBuckets = ["M_M", "M_A"];
  else if (myBucket === "M_A") compatibleBuckets = ["F_M", "F_A", "M_M", "M_A"];
  else if (myBucket === "F_M") compatibleBuckets = ["M_F", "M_A"];
  else if (myBucket === "F_F") compatibleBuckets = ["F_F", "F_A"];
  else if (myBucket === "F_A") compatibleBuckets = ["M_F", "M_A", "F_F", "F_A"];

  for (const bucketKey of compatibleBuckets) {
    const bucket = buckets[bucketKey];
    if (bucket && bucket.size > 0) {
      // Get the first available partner
      const partnerDeviceId = bucket.values().next().value;
      if (partnerDeviceId === deviceId) continue;

      const partner = userRegistry.get(partnerDeviceId);
      const partnerSocketId = deviceToSocket.get(partnerDeviceId);
      const partnerSocket = io.sockets.sockets.get(partnerSocketId);

      if (partner && partnerSocket) {
        // --- MATCH FOUND ---
        // Atomic removal
        bucket.delete(partnerDeviceId);
        removeFromAllBuckets(deviceId);
        
        clearTimeout(partner.timeout);
        partner.timeout = null;
        
        const roomId = crypto.randomUUID();

        socket.join(roomId);
        partnerSocket.join(roomId);
        
        rooms.set(roomId, { members: [deviceId, partnerDeviceId], cleanupTimer: null });
        
        // Update registry
        const me = userRegistry.get(deviceId);
        if (me) me.roomId = roomId;
        partner.roomId = roomId;

        const matchDataForA = {
          status: "match_found",
          roomId,
          partner: { 
            name: partner.userData.name, 
            gender: partner.userData.gender, 
            deviceId: partnerDeviceId 
          }
        };

        const matchDataForB = {
          status: "match_found",
          roomId,
          partner: { 
            name: userData.name, 
            gender: userData.gender, 
            deviceId: deviceId 
          }
        };

        socket.emit("status", matchDataForA);
        partnerSocket.emit("status", matchDataForB);

        console.log(`✅ Match: ${userData.name} <-> ${partner.userData.name} [Room: ${roomId}]`);
        return true;
      }
    }
  }
  return false;
}

// ---------------- Socket Events ----------------
io.on("connection", (socket) => {
  const deviceId = socket.handshake.query.deviceId || socket.handshake.auth.deviceId;
  
  if (!deviceId) {
    console.log(`⚠️ Connection without Device ID: ${socket.id}`);
    socket.disconnect();
    return;
  }

  console.log(`🔌 Connected: ${socket.id} (Device: ${deviceId})`);
  
  // Cleanup old socket association if any
  const oldSocketId = deviceToSocket.get(deviceId);
  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) oldSocket.disconnect();
  }

  socketToDevice.set(socket.id, deviceId);
  deviceToSocket.set(deviceId, socket.id);

  // Re-join active room if exists
  const user = userRegistry.get(deviceId);
  if (user) {
    user.isOnline = true;
    if (user.roomId && rooms.has(user.roomId)) {
      const room = rooms.get(user.roomId);
      socket.join(user.roomId);
      
      // Clear cleanup timer as one member is back
      if (room.cleanupTimer) {
        console.log(`⏳ Cancelling room cleanup for ${user.roomId}`);
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      console.log(`🔗 Reconnected ${deviceId} to active room: ${user.roomId}`);
      
      const partnerId = room.members.find(id => id !== deviceId);
      const partner = userRegistry.get(partnerId);
      
      socket.emit("room_restored", { 
        roomId: user.roomId,
        partner: partner ? {
          name: partner.userData.name,
          gender: partner.userData.gender,
          deviceId: partnerId
        } : null
      });
      socket.to(user.roomId).emit("chat_response", { status: "partner_connected", message: "Partner is back online." });
    }
  }

  socket.on("join_room", (data) => {
    const { roomId } = data;
    if (roomId && rooms.has(roomId)) {
      socket.join(roomId);
      console.log(`👤 Socket ${socket.id} joined room ${roomId}`);
    }
  });

  socket.on("find", (data) => {
    const deviceId = socketToDevice.get(socket.id);
    if (!deviceId) return;

    console.log(`🔍 Search: ${deviceId} (${data.gender} -> ${data.preference})`);

    // Clean up existing search or room
    if (userRegistry.has(deviceId)) {
      const existing = userRegistry.get(deviceId);
      if (existing.timeout) clearTimeout(existing.timeout);
      removeFromAllBuckets(deviceId);
      
      // If they were in a room, they are choosing to leave it
      if (existing.roomId) {
        const roomId = existing.roomId;
        socket.to(roomId).emit("chat_response", { status: "partner_left", message: "Your partner started a new search." });
        rooms.delete(roomId);
        existing.roomId = null;
      }
    } else {
      userRegistry.set(deviceId, { userData: data, isOnline: true });
    }

    const matched = findMatch(socket, data, deviceId);

    if (!matched) {
      const bucketKey = getBucketKey(data.gender, data.preference);
      const timeout = setTimeout(() => {
        if (userRegistry.has(deviceId)) {
          removeFromAllBuckets(deviceId);
          const user = userRegistry.get(deviceId);
          if (user) {
            user.timeout = null;
            const msg = getRandomMessage(data.preference !== "any" ? "paid" : "free");
            socket.emit("status", { status: "timeout", message: msg });
          }
        }
      }, 30000);

      buckets[bucketKey].add(deviceId);
      const user = userRegistry.get(deviceId);
      user.userData = data;
      user.timeout = timeout;
      user.currentBucket = bucketKey;
      socket.emit("status", { status: "searching", message: "Searching for a partner..." });

      // 🔔 Send Telegram alert (rate-limited) when someone is waiting
      sendTelegramQueueAlert();
    }
  });

  socket.on("chat_message", (data) => {
    const { roomId } = data;
    if (roomId && rooms.has(roomId)) {
      io.to(roomId).emit("chat_response", {
        ...data,
        from: socket.id,
        fromDeviceId: socketToDevice.get(socket.id),
        timestamp: new Date().toISOString()
      });
    }
  });

  socket.on("typing", (data) => {
    if (data.roomId) {
      const deviceId = socketToDevice.get(socket.id);
      socket.to(data.roomId).emit("typing", { from: socket.id, deviceId });
    }
  });

  socket.on("stop_typing", (data) => {
    if (data.roomId) {
      const deviceId = socketToDevice.get(socket.id);
      socket.to(data.roomId).emit("stop_typing", { from: socket.id, deviceId });
    }
  });

  socket.on("leave_chat", (data) => {
    const deviceId = socketToDevice.get(socket.id);
    const roomId = data?.roomId;
    if (roomId && rooms.has(roomId)) {
      socket.to(roomId).emit("chat_response", { status: "partner_left", message: "Your partner left the chat." });
      io.in(roomId).socketsLeave(roomId);
      rooms.delete(roomId);
    }
    if (deviceId) {
      const user = userRegistry.get(deviceId);
      if (user) {
        removeFromAllBuckets(deviceId);
        if (user.timeout) {
          clearTimeout(user.timeout);
          user.timeout = null;
        }
        user.roomId = null;
      }
    }
  });

  socket.on("cancel_search", () => {
    const deviceId = socketToDevice.get(socket.id);
    if (!deviceId) return;

    console.log(`⏹️ Cancel Search: ${deviceId}`);
    const user = userRegistry.get(deviceId);
    if (user) {
      removeFromAllBuckets(deviceId);
      if (user.timeout) {
        clearTimeout(user.timeout);
        user.timeout = null;
      }
    }
  });

  socket.on("disconnect", () => {
    const deviceId = socketToDevice.get(socket.id);
    if (!deviceId) return;

    console.log(`❌ Disconnected: ${socket.id} (Device: ${deviceId})`);
    
    const user = userRegistry.get(deviceId);
    if (user) {
      user.isOnline = false;
      
      // If searching, stop it
      if (user.currentBucket) {
        removeFromAllBuckets(deviceId);
        if (user.timeout) clearTimeout(user.timeout);
        user.timeout = null;
      }

      // If in a room, start grace period
      if (user.roomId && rooms.has(user.roomId)) {
        const roomId = user.roomId;
        const room = rooms.get(roomId);
        
        console.log(`⏱️ Starting ${DISCONNECT_GRACE_PERIOD}ms grace period for room ${roomId}`);
        
        socket.to(roomId).emit("chat_response", { 
          status: "partner_away", 
          message: "Partner disconnected. Waiting for reconnection..." 
        });

        // Set a timer to cleanup the room
        room.cleanupTimer = setTimeout(() => {
          console.log(`🧹 Grace period expired. Cleaning up room ${roomId}`);
          io.to(roomId).emit("chat_response", { status: "partner_left", message: "Your partner left the chat." });
          rooms.delete(roomId);
          
          // Clear room ID for both members
          room.members.forEach(mId => {
            const u = userRegistry.get(mId);
            if (u) u.roomId = null;
          });
        }, DISCONNECT_GRACE_PERIOD);
      }
    }

    socketToDevice.delete(socket.id);
    deviceToSocket.delete(deviceId);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
