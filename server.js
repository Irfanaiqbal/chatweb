const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);

const app = express();
const server = http.createServer(app);

// Configure Socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000
  }),
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin credentials - UPDATED PASSWORD
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'ghost@5555'; // Your actual password

// Data storage
let waitingUser = null;
let onlineUsers = new Map();
let activeRooms = new Map();
let adminConnections = new Set();
let messageCount = 0;

// Utility functions
function updateOnlineCount() {
  const count = onlineUsers.size;
  io.emit('updateOnlineCount', count);
}

function sendAdminUpdate() {
  const adminData = {
    onlineUsers: Array.from(onlineUsers.values()),
    waitingUser: waitingUser,
    activeRooms: Array.from(activeRooms.values()),
    stats: {
      totalOnline: onlineUsers.size,
      totalRooms: activeRooms.size,
      waitingUsers: waitingUser ? 1 : 0,
      totalMessages: messageCount
    },
    timestamp: new Date().toISOString()
  };
  
  console.log('🔄 Sending admin update to', adminConnections.size, 'admins');
  
  adminConnections.forEach(adminId => {
    io.to(adminId).emit('adminData', adminData);
  });
}

// Auto-send admin updates every 3 seconds
setInterval(() => {
  if (adminConnections.size > 0) {
    sendAdminUpdate();
  }
}, 3000);

// Debug endpoint to see all current data
app.get('/debug-data', (req, res) => {
  res.json({
    onlineUsers: Array.from(onlineUsers.values()),
    waitingUser: waitingUser,
    activeRooms: Array.from(activeRooms.values()),
    adminConnections: Array.from(adminConnections),
    stats: {
      totalOnline: onlineUsers.size,
      totalRooms: activeRooms.size,
      waitingUsers: waitingUser ? 1 : 0,
      totalMessages: messageCount
    },
    timestamp: new Date().toISOString()
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin', (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect('/admin-login.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  console.log('Login attempt for user:', username);
  
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    console.log('Admin login successful');
    return res.redirect('/admin');
  } else {
    console.log('Admin login failed');
    return res.redirect('/admin-login.html?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    res.redirect('/admin-login.html');
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  // Get user IP
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  const realIP = socket.handshake.headers['x-real-ip'];
  const socketIP = socket.handshake.address;
  
  let userIP;
  if (forwardedFor) {
    userIP = forwardedFor.split(',')[0].trim();
  } else if (realIP) {
    userIP = realIP;
  } else {
    userIP = socketIP;
  }
  
  // Handle IPv6 format
  if (userIP && userIP.includes('::ffff:')) {
    userIP = userIP.replace('::ffff:', '');
  }

  const userInfo = {
    id: socket.id,
    ip: userIP || 'Unknown IP',
    connectedAt: new Date(),
    room: null,
    status: 'waiting'
  };
  
  onlineUsers.set(socket.id, userInfo);
  console.log(`👤 User ${socket.id} connected from IP: ${userIP}`);
  
  // Send immediate update
  updateOnlineCount();
  sendAdminUpdate();

  // Handle user matching
  if (waitingUser && waitingUser !== socket.id) {
    const partnerSocket = io.sockets.sockets.get(waitingUser);
    if (partnerSocket && onlineUsers.has(waitingUser)) {
      // Create room
      const roomId = `room-${socket.id}-${waitingUser}`;
      socket.join(roomId);
      partnerSocket.join(roomId);
      
      userInfo.room = roomId;
      userInfo.status = 'chatting';
      onlineUsers.get(waitingUser).room = roomId;
      onlineUsers.get(waitingUser).status = 'chatting';
      
      activeRooms.set(roomId, {
        id: roomId,
        users: [socket.id, waitingUser],
        createdAt: new Date()
      });
      
      socket.emit('status', { 
        message: 'You are connected to a stranger!', 
        clear: true,
        connected: true 
      });
      partnerSocket.emit('status', { 
        message: 'You are connected to a stranger!', 
        clear: true,
        connected: true 
      });
      
      waitingUser = null;
      console.log(`💬 Room created: ${roomId}`);
    }
  }
  
  if (!userInfo.room) {
    socket.emit('status', { 
      message: 'Searching for a stranger...', 
      clear: true,
      connected: false 
    });
    waitingUser = socket.id;
  }

  sendAdminUpdate();

  // Handle messages
  socket.on('sendMessage', (message) => {
    if (userInfo.room && message.trim()) {
      messageCount++;
      socket.to(userInfo.room).emit('receiveMessage', message);
      sendAdminUpdate();
    }
  });

  // Handle typing indicators
  socket.on('typing', (isTyping) => {
    if (userInfo.room) {
      socket.to(userInfo.room).emit('typing', isTyping);
    }
  });

  // Handle skip chat
  socket.on('skipChat', () => {
    console.log(`⏭️ Skip requested by: ${socket.id}`);
    
    if (userInfo.room) {
      socket.leave(userInfo.room);
      const room = activeRooms.get(userInfo.room);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        if (room.users.length === 0) {
          activeRooms.delete(userInfo.room);
        }
      }
    }
    
    userInfo.room = null;
    userInfo.status = 'waiting';
    
    if (waitingUser === socket.id) {
      waitingUser = null;
    }
    
    if (!waitingUser) {
      waitingUser = socket.id;
    }
    
    socket.emit('status', {
      message: 'Searching for a stranger...',
      clear: true,
      connected: false
    });
    
    sendAdminUpdate();
  });

  // Admin authentication - FIXED PASSWORD
  socket.on('adminAuth', (password) => {
    console.log(`🔐 Admin auth attempt from: ${socket.id}`);
    
    if (password === ADMIN_PASSWORD) {
      adminConnections.add(socket.id);
      socket.emit('adminAuthSuccess');
      console.log(`✅ Admin authenticated: ${socket.id}. Total admins: ${adminConnections.size}`);
      
      // Send immediate data to this admin
      sendAdminUpdate();
    } else {
      console.log(`❌ Admin authentication FAILED: Wrong password`);
    }
  });

  // Handle manual refresh request
  socket.on('adminRefresh', () => {
    if (adminConnections.has(socket.id)) {
      console.log(`🔄 Manual refresh requested by admin: ${socket.id}`);
      sendAdminUpdate();
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`🔴 User disconnected: ${socket.id}`);
    
    onlineUsers.delete(socket.id);
    adminConnections.delete(socket.id);
    
    // Clean up rooms
    activeRooms.forEach((room, roomId) => {
      room.users = room.users.filter(id => id !== socket.id);
      if (room.users.length === 0) {
        activeRooms.delete(roomId);
      }
    });
    
    if (waitingUser === socket.id) {
      waitingUser = null;
    }
    
    updateOnlineCount();
    sendAdminUpdate();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🔑 Admin credentials: admin / ghost@5555`);
  console.log(`🐛 Debug data: http://localhost:${PORT}/debug-data`);
});
