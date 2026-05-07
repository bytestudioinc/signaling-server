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

const userRegistry = new Map(); // socketId -> { userData, timeout, currentBucket }
const rooms = new Map();         // roomId -> [socketIds]

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
  const g = gender.toUpperCase().charAt(0);
  const p = preference.toUpperCase().charAt(0);
  return `${g}_${p}`;
}

function removeFromAllBuckets(socketId) {
  const user = userRegistry.get(socketId);
  if (user && user.currentBucket) {
    buckets[user.currentBucket].delete(socketId);
  }
}

function findMatch(socket, userData) {
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
      const partnerId = bucket.values().next().value;
      if (partnerId === socket.id) continue;

      const partner = userRegistry.get(partnerId);
      if (partner) {
        // --- MATCH FOUND ---
        // Atomic removal
        bucket.delete(partnerId);
        removeFromAllBuckets(socket.id);
        
        clearTimeout(partner.timeout);
        
        const roomId = crypto.randomUUID();
        const partnerSocket = io.sockets.sockets.get(partnerId);

        if (partnerSocket) {
          socket.join(roomId);
          partnerSocket.join(roomId);
          rooms.set(roomId, [socket.id, partnerId]);

          const matchDataForA = {
            status: "match_found",
            roomId,
            partner: { name: partner.userData.name, gender: partner.userData.gender, userId: partnerId }
          };

          const matchDataForB = {
            status: "match_found",
            roomId,
            partner: { name: userData.name, gender: userData.gender, userId: socket.id }
          };

          socket.emit("status", matchDataForA);
          partnerSocket.emit("status", matchDataForB);

          console.log(`✅ Match: ${userData.name} <-> ${partner.userData.name} [Room: ${roomId}]`);
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------- Socket Events ----------------
io.on("connection", (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on("join_room", (data) => {
    const { roomId } = data;
    if (roomId && rooms.has(roomId)) {
      socket.join(roomId);
      console.log(`🔗 ${socket.id} joined/rejoined room: ${roomId}`);
    }
  });

  socket.on("find", (data) => {
    console.log(`🔍 Search: ${socket.id} (${data.gender} -> ${data.preference})`);

    // Clean up existing search
    if (userRegistry.has(socket.id)) {
      clearTimeout(userRegistry.get(socket.id).timeout);
      removeFromAllBuckets(socket.id);
    }

    const matched = findMatch(socket, data);

    if (!matched) {
      const bucketKey = getBucketKey(data.gender, data.preference);
      const timeout = setTimeout(() => {
        if (userRegistry.has(socket.id)) {
          removeFromAllBuckets(socket.id);
          userRegistry.delete(socket.id);
          const msg = getRandomMessage(data.preference !== "any" ? "paid" : "free");
          socket.emit("status", { status: "timeout", message: msg });
        }
      }, 30000);

      buckets[bucketKey].add(socket.id);
      userRegistry.set(socket.id, { userData: data, timeout, currentBucket: bucketKey });
      socket.emit("status", { status: "searching", message: "Searching for a partner..." });
    }
  });

  socket.on("chat_message", (data) => {
    const { roomId } = data;
    if (roomId && rooms.has(roomId)) {
      io.to(roomId).emit("chat_response", {
        ...data,
        from: socket.id,
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

  socket.on("mark_read", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("receipt_read", { from: socket.id });
  });

  socket.on("leave_chat", (data) => {
    const roomId = data?.roomId;
    if (roomId && rooms.has(roomId)) {
      socket.to(roomId).emit("chat_response", { status: "partner_left", message: "Your partner left the chat." });
      io.in(roomId).socketsLeave(roomId);
      rooms.delete(roomId);
    }
    removeFromAllBuckets(socket.id);
    userRegistry.delete(socket.id);
  });

  socket.on("disconnect", () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    
    // Notify partners in active rooms
    for (const [roomId, members] of rooms) {
      if (members.includes(socket.id)) {
        socket.to(roomId).emit("chat_response", { status: "partner_left", message: "Your partner disconnected." });
        io.in(roomId).socketsLeave(roomId);
        rooms.delete(roomId);
      }
    }

    if (userRegistry.has(socket.id)) {
      clearTimeout(userRegistry.get(socket.id).timeout);
      removeFromAllBuckets(socket.id);
      userRegistry.delete(socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
