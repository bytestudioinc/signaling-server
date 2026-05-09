require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true
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

const DISCONNECT_GRACE_PERIOD = 30000; // 30 seconds

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
    if (data.roomId) socket.to(data.roomId).emit("typing", { from: socket.id });
  });

  socket.on("stop_typing", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("stop_typing", { from: socket.id });
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
