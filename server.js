// server.js
const { PeerServer } = require("peer");

const peerServer = PeerServer({
  port: process.env.PORT || 3000,  // Render gives PORT env variable
  path: "/bhadwa",
  allow_discovery: true
});

console.log("PeerJS signaling server is running...");
